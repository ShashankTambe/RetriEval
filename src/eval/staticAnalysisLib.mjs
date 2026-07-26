/**
 * Independent static analysis (library form), the MECHANICAL answer key.
 *
 * Plain-JS/ESM port of tools/staticAnalysis.ts so the pipeline can call it
 * IN-PROCESS (no `npx tsx` child process), which is required for the packaged
 * .exe and is faster. ts-morph is pure JS at runtime; only the TS type
 * annotations are dropped. Logic is identical, including nested-method capture.
 *
 * Anti-overfit: never imports or reuses LessTokenify. Derives every fact from
 * source directly. Returns the dump object (no file writes).
 */
import { Project, Node, SyntaxKind } from "ts-morph";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export function analyze(repoRootArg, commitSha = "unknown") {
  const repoRoot = resolve(repoRootArg);

  const inScope = (absPath) => {
    const p = resolve(absPath);
    if (!p.startsWith(repoRoot + sep) && p !== repoRoot) return false;
    return !p.split(sep).includes("node_modules");
  };
  const rel = (absPath) => relative(repoRoot, resolve(absPath)).split(sep).join("/");

  const tsConfigFilePath = existsSync(join(repoRoot, "tsconfig.json"))
    ? join(repoRoot, "tsconfig.json")
    : undefined;

  const project = new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, jsx: 4 /* react-jsx */ },
  });
  project.addSourceFilesAtPaths([
    join(repoRoot, "src/**/*.ts"),
    join(repoRoot, "src/**/*.tsx"),
    join(repoRoot, "src/**/*.js"),
    join(repoRoot, "src/**/*.jsx"),
    join(repoRoot, "App.tsx"),
    join(repoRoot, "App.ts"),
    join(repoRoot, "index.ts"),
    join(repoRoot, "index.tsx"),
  ]);

  const sourceFiles = project.getSourceFiles().filter((sf) => inScope(sf.getFilePath()));

  const symbols = [];
  const imports = [];
  const callEdges = [];
  const usedBy = new Map();
  const exportedDecls = [];

  const pushSymbol = (rec, declNode) => {
    symbols.push(rec);
    if (rec.exported && declNode) exportedDecls.push({ node: declNode, key: `${rec.file}::${rec.name}` });
  };

  // ── symbol extraction ──────────────────────────────────────────────────────
  for (const sf of sourceFiles) {
    const file = rel(sf.getFilePath());

    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      pushSymbol(
        { name, kind: "function", file, lineStart: fn.getStartLineNumber(), lineEnd: fn.getEndLineNumber(), exported: fn.isExported() },
        fn.getNameNode(),
      );
    }

    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      pushSymbol(
        { name, kind: "class", file, lineStart: cls.getStartLineNumber(), lineEnd: cls.getEndLineNumber(), exported: cls.isExported() },
        cls.getNameNode(),
      );
      for (const m of cls.getMethods()) {
        const mn = m.getName();
        if (!mn) continue;
        symbols.push({ name: `${name}.${mn}`, kind: "method", file, lineStart: m.getStartLineNumber(), lineEnd: m.getEndLineNumber(), exported: cls.isExported() });
      }
    }

    for (const it of sf.getInterfaces())
      pushSymbol({ name: it.getName(), kind: "interface", file, lineStart: it.getStartLineNumber(), lineEnd: it.getEndLineNumber(), exported: it.isExported() }, it.getNameNode());
    for (const ta of sf.getTypeAliases())
      pushSymbol({ name: ta.getName(), kind: "typeAlias", file, lineStart: ta.getStartLineNumber(), lineEnd: ta.getEndLineNumber(), exported: ta.isExported() }, ta.getNameNode());
    for (const en of sf.getEnums())
      pushSymbol({ name: en.getName(), kind: "enum", file, lineStart: en.getStartLineNumber(), lineEnd: en.getEndLineNumber(), exported: en.isExported() }, en.getNameNode());

    for (const stmt of sf.getVariableStatements()) {
      const exported = stmt.isExported();
      for (const decl of stmt.getDeclarations()) {
        const init = decl.getInitializer();
        const isFnLike = !!init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
        pushSymbol(
          { name: decl.getName(), kind: isFnLike ? "arrowFunction" : "variable", file, lineStart: stmt.getStartLineNumber(), lineEnd: stmt.getEndLineNumber(), exported },
          decl.getNameNode(),
        );
      }
    }
  }

  // ── import edges ───────────────────────────────────────────────────────────
  for (const sf of sourceFiles) {
    const fromFile = rel(sf.getFilePath());
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target || !inScope(target.getFilePath())) continue;
      imports.push({
        fromFile,
        toFile: rel(target.getFilePath()),
        named: imp.getNamedImports().map((n) => n.getName()),
        default: imp.getDefaultImport()?.getText(),
        namespace: imp.getNamespaceImport()?.getText(),
      });
    }
  }

  // ── call edges ─────────────────────────────────────────────────────────────
  let callsSeen = 0, callsResolvedInRepo = 0, callsExternal = 0, callsUnresolved = 0;

  const enclosingSymbolName = (node) => {
    let cur = node.getParent();
    while (cur) {
      if (Node.isFunctionDeclaration(cur)) {
        const n = cur.getName();
        if (n) return n;
      } else if (Node.isMethodDeclaration(cur)) {
        const cls = cur.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        return `${cls?.getName() ?? "<class>"}.${cur.getName()}`;
      } else if (Node.isArrowFunction(cur) || Node.isFunctionExpression(cur)) {
        const parent = cur.getParent();
        if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
      }
      cur = cur.getParent();
    }
    return "<module>";
  };

  const calleeNameNode = (expr) => {
    if (Node.isIdentifier(expr)) return expr;
    if (Node.isPropertyAccessExpression(expr)) return expr.getNameNode();
    if (Node.isParenthesizedExpression(expr)) return calleeNameNode(expr.getExpression());
    return undefined;
  };
  const firstInScopeDecl = (sym) => {
    const decls = sym.getDeclarations();
    return decls.find((d) => inScope(d.getSourceFile().getFilePath())) ?? decls[0];
  };

  const callEdgeSeen = new Set();
  for (const sf of sourceFiles) {
    const callerFile = rel(sf.getFilePath());
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      callsSeen++;
      const nameNode = calleeNameNode(call.getExpression());
      if (!nameNode) { callsUnresolved++; continue; }
      let sym = nameNode.getSymbol();
      if (!sym) { callsUnresolved++; continue; }
      const aliased = sym.getAliasedSymbol();
      if (aliased) sym = aliased;
      const decl = firstInScopeDecl(sym);
      if (!decl) { callsUnresolved++; continue; }
      const declFile = decl.getSourceFile().getFilePath();
      if (!inScope(declFile)) { callsExternal++; continue; }
      callsResolvedInRepo++;
      const callee = sym.getName();
      const calleeFile = rel(declFile);
      const caller = enclosingSymbolName(call);
      const key = `${callerFile}::${caller}=>${calleeFile}::${callee}`;
      if (callEdgeSeen.has(key)) continue;
      callEdgeSeen.add(key);
      callEdges.push({ caller, callee, callerFile, calleeFile, line: call.getStartLineNumber() });
    }
  }

  // ── nested provider/hook methods (depth-1 named functions) ──────────────────
  const fnLikeKind = (init) => {
    if (!init) return null;
    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return "arrowFunction";
    if (Node.isCallExpression(init)) {
      const hasFnArg = init.getArguments().some((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
      if (hasFnArg) return "arrowFunction";
    }
    return null;
  };
  const functionScopeDepth = (node) => {
    let depth = 0;
    let cur = node.getParent();
    while (cur) {
      if (Node.isArrowFunction(cur) || Node.isFunctionExpression(cur) || Node.isFunctionDeclaration(cur) || Node.isMethodDeclaration(cur)) depth++;
      cur = cur.getParent();
    }
    return depth;
  };
  for (const sf of sourceFiles) {
    const file = rel(sf.getFilePath());
    for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const kind = fnLikeKind(decl.getInitializer());
      if (!kind) continue;
      if (functionScopeDepth(decl) !== 1) continue;
      const container = enclosingSymbolName(decl.getNameNode());
      if (container === "<module>") continue;
      const stmt = decl.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? decl;
      symbols.push({ name: decl.getName(), kind, file, lineStart: stmt.getStartLineNumber(), lineEnd: stmt.getEndLineNumber(), exported: false, container });
    }
    for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
      const name = fn.getName();
      if (!name) continue;
      if (functionScopeDepth(fn) !== 1) continue;
      const container = enclosingSymbolName(fn);
      if (container === "<module>") continue;
      symbols.push({ name, kind: "function", file, lineStart: fn.getStartLineNumber(), lineEnd: fn.getEndLineNumber(), exported: false, container });
    }
  }

  // ── usedBy (cross-file references of exported symbols) ──────────────────────
  for (const { node, key } of exportedDecls) {
    if (!Node.isReferenceFindable(node)) continue;
    const declFile = rel(node.getSourceFile().getFilePath());
    const set = usedBy.get(key) ?? new Set();
    for (const ref of node.findReferencesAsNodes()) {
      const refFile = rel(ref.getSourceFile().getFilePath());
      if (!inScope(ref.getSourceFile().getFilePath())) continue;
      if (refFile === declFile) continue;
      set.add(refFile);
    }
    if (set.size) usedBy.set(key, set);
  }

  // ── emit (deterministic) ────────────────────────────────────────────────────
  const byFileThenName = (a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file));
  symbols.sort(byFileThenName);
  imports.sort((a, b) => a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile));
  callEdges.sort((a, b) => a.callerFile.localeCompare(b.callerFile) || a.caller.localeCompare(b.caller) || a.calleeFile.localeCompare(b.calleeFile) || a.callee.localeCompare(b.callee));

  const usedByObj = {};
  for (const k of [...usedBy.keys()].sort()) usedByObj[k] = [...usedBy.get(k)].sort();

  const totalLoc = sourceFiles.reduce((n, sf) => n + sf.getEndLineNumber(), 0);

  return {
    answer_key_version: "0.1",
    layer: "mechanical",
    generated_by: "ts-morph static analysis (independent of LessTokenify)",
    categories_covered: ["Relationship", "Flow"],
    repo: {
      name: repoRoot.split(sep).pop(),
      root: repoRoot.split(sep).join("/"),
      commit_sha: commitSha,
      language: "typescript",
      fileCount: sourceFiles.length,
      loc: totalLoc,
    },
    files: sourceFiles.map((sf) => rel(sf.getFilePath())).sort(),
    symbols,
    imports,
    callEdges,
    usedBy: usedByObj,
    stats: {
      files: sourceFiles.length,
      symbols: symbols.length,
      exportedSymbols: symbols.filter((s) => s.exported).length,
      nestedMethods: symbols.filter((s) => s.container).length,
      importEdges: imports.length,
      callEdges: callEdges.length,
      callsSeen,
      callsResolvedInRepo,
      callsExternal,
      callsUnresolved,
      usedByEntries: Object.keys(usedByObj).length,
    },
  };
}
