/**
 * Independent static-analysis tool for the RetriEval benchmark.
 *
 * Purpose: build the MECHANICAL half of the answer key (symbols, import edges,
 * call edges, usedBy) for a fixture repo, using ts-morph, a DIFFERENT
 * implementation from LessTokenify's own AST graph builder.
 *
 * Anti-overfit guarantee: this file must never import or reuse LessTokenify.
 * It derives every fact from the source directly so that, later, LT can be
 * graded against a key it had no hand in producing. When LT disagrees with
 * this dump, the disagreement points to an LT gap (or a bug here that human
 * spot-check catches), never the reverse.
 *
 * Scope of truth produced here: Relationship + Flow (mechanical, no judgment).
 * Location + Architecture (semantic) are produced separately by whole-file
 * model reading + human verification.
 *
 * Usage: tsx tools/staticAnalysis.ts <repoRoot> <commitSha> [outFile]
 */
import {
  Project,
  Node,
  SyntaxKind,
  type SourceFile,
  type Symbol as MorphSymbol,
} from "ts-morph";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const repoRootArg = process.argv[2];
const commitSha = process.argv[3] ?? "unknown";
const outFile = process.argv[4];
if (!repoRootArg) {
  console.error("usage: tsx tools/staticAnalysis.ts <repoRoot> <commitSha> [outFile]");
  process.exit(1);
}
const repoRoot = resolve(repoRootArg);

// A file is "in scope" if it lives inside the repo and is not a dependency.
const inScope = (absPath: string): boolean => {
  const p = resolve(absPath);
  if (!p.startsWith(repoRoot + sep) && p !== repoRoot) return false;
  return !p.split(sep).includes("node_modules");
};
const rel = (absPath: string): string =>
  relative(repoRoot, resolve(absPath)).split(sep).join("/");

// ---------------------------------------------------------------------------
// Project, only add repo source; let ts-morph resolve imports on demand.
// ---------------------------------------------------------------------------
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

const sourceFiles = project
  .getSourceFiles()
  .filter((sf) => inScope(sf.getFilePath()));

// ---------------------------------------------------------------------------
// Types of the dump
// ---------------------------------------------------------------------------
type SymbolKind =
  | "function"
  | "arrowFunction"
  | "class"
  | "interface"
  | "typeAlias"
  | "enum"
  | "variable"
  | "method";

interface SymbolRec {
  name: string;
  kind: SymbolKind;
  file: string;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  container?: string; // set for nested provider/hook methods (e.g. DataProvider)
}
interface ImportEdge {
  fromFile: string;
  toFile: string;
  named: string[];
  default?: string;
  namespace?: string;
}
interface CallEdge {
  caller: string;
  callee: string;
  callerFile: string;
  calleeFile: string;
  line: number;
}

const symbols: SymbolRec[] = [];
const imports: ImportEdge[] = [];
const callEdges: CallEdge[] = [];
// key: "<file>::<symbol>"  ->  set of files that reference it (cross-file)
const usedBy = new Map<string, Set<string>>();

// A quick lookup of declaration-node -> its symbol key, for usedBy.
const exportedDecls: { node: Node; key: string }[] = [];

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------
const pushSymbol = (rec: SymbolRec, declNode?: Node) => {
  symbols.push(rec);
  if (rec.exported && declNode) {
    exportedDecls.push({ node: declNode, key: `${rec.file}::${rec.name}` });
  }
};

for (const sf of sourceFiles) {
  const file = rel(sf.getFilePath());

  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    pushSymbol(
      {
        name,
        kind: "function",
        file,
        lineStart: fn.getStartLineNumber(),
        lineEnd: fn.getEndLineNumber(),
        exported: fn.isExported(),
      },
      fn.getNameNode(),
    );
  }

  for (const cls of sf.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    pushSymbol(
      {
        name,
        kind: "class",
        file,
        lineStart: cls.getStartLineNumber(),
        lineEnd: cls.getEndLineNumber(),
        exported: cls.isExported(),
      },
      cls.getNameNode(),
    );
    // methods (captured as ClassName.method), useful for call-edge callers
    for (const m of cls.getMethods()) {
      const mn = m.getName();
      if (!mn) continue;
      pushSymbol({
        name: `${name}.${mn}`,
        kind: "method",
        file,
        lineStart: m.getStartLineNumber(),
        lineEnd: m.getEndLineNumber(),
        exported: cls.isExported(),
      });
    }
  }

  for (const it of sf.getInterfaces()) {
    pushSymbol(
      {
        name: it.getName(),
        kind: "interface",
        file,
        lineStart: it.getStartLineNumber(),
        lineEnd: it.getEndLineNumber(),
        exported: it.isExported(),
      },
      it.getNameNode(),
    );
  }
  for (const ta of sf.getTypeAliases()) {
    pushSymbol(
      {
        name: ta.getName(),
        kind: "typeAlias",
        file,
        lineStart: ta.getStartLineNumber(),
        lineEnd: ta.getEndLineNumber(),
        exported: ta.isExported(),
      },
      ta.getNameNode(),
    );
  }
  for (const en of sf.getEnums()) {
    pushSymbol(
      {
        name: en.getName(),
        kind: "enum",
        file,
        lineStart: en.getStartLineNumber(),
        lineEnd: en.getEndLineNumber(),
        exported: en.isExported(),
      },
      en.getNameNode(),
    );
  }

  // Top-level variable declarations (React components, hooks, consts).
  for (const stmt of sf.getVariableStatements()) {
    const exported = stmt.isExported();
    for (const decl of stmt.getDeclarations()) {
      const name = decl.getName();
      const init = decl.getInitializer();
      const isFnLike =
        !!init &&
        (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
      pushSymbol(
        {
          name,
          kind: isFnLike ? "arrowFunction" : "variable",
          file,
          lineStart: stmt.getStartLineNumber(),
          lineEnd: stmt.getEndLineNumber(),
          exported,
        },
        decl.getNameNode(),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Import edges (the clean file->file dependency graph)
// ---------------------------------------------------------------------------
for (const sf of sourceFiles) {
  const fromFile = rel(sf.getFilePath());
  for (const imp of sf.getImportDeclarations()) {
    const target = imp.getModuleSpecifierSourceFile();
    if (!target || !inScope(target.getFilePath())) continue; // external dep -> skip
    imports.push({
      fromFile,
      toFile: rel(target.getFilePath()),
      named: imp.getNamedImports().map((n) => n.getName()),
      default: imp.getDefaultImport()?.getText(),
      namespace: imp.getNamespaceImport()?.getText(),
    });
  }
}

// ---------------------------------------------------------------------------
// Call edges, resolve each call site's callee to its declaration.
// ---------------------------------------------------------------------------
let callsSeen = 0;
let callsResolvedInRepo = 0;
let callsExternal = 0;
let callsUnresolved = 0;

/** Nearest NAMED enclosing function / method / named arrow-const, else <module>. */
const enclosingSymbolName = (node: Node): string => {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (Node.isFunctionDeclaration(cur)) {
      const n = cur.getName();
      if (n) return n;
    } else if (Node.isMethodDeclaration(cur)) {
      const cls = cur.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
      const cn = cls?.getName() ?? "<class>";
      return `${cn}.${cur.getName()}`;
    } else if (Node.isArrowFunction(cur) || Node.isFunctionExpression(cur)) {
      const parent = cur.getParent();
      if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
      // anonymous callback, keep walking to find a named owner
    }
    cur = cur.getParent();
  }
  return "<module>";
};

/** The identifier node that names what is being called. */
const calleeNameNode = (expr: Node): Node | undefined => {
  if (Node.isIdentifier(expr)) return expr;
  if (Node.isPropertyAccessExpression(expr)) return expr.getNameNode();
  if (Node.isParenthesizedExpression(expr))
    return calleeNameNode(expr.getExpression());
  return undefined;
};

const firstInScopeDecl = (sym: MorphSymbol): Node | undefined => {
  const decls = sym.getDeclarations();
  return decls.find((d) => inScope(d.getSourceFile().getFilePath())) ?? decls[0];
};

const callEdgeSeen = new Set<string>();

for (const sf of sourceFiles) {
  const callerFile = rel(sf.getFilePath());
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    callsSeen++;
    const nameNode = calleeNameNode(call.getExpression());
    if (!nameNode) {
      callsUnresolved++;
      continue;
    }
    let sym = nameNode.getSymbol();
    if (!sym) {
      callsUnresolved++;
      continue;
    }
    const aliased = sym.getAliasedSymbol();
    if (aliased) sym = aliased;
    const decl = firstInScopeDecl(sym);
    if (!decl) {
      callsUnresolved++;
      continue;
    }
    const declFile = decl.getSourceFile().getFilePath();
    if (!inScope(declFile)) {
      callsExternal++;
      continue;
    }
    callsResolvedInRepo++;
    const callee = sym.getName();
    const calleeFile = rel(declFile);
    const caller = enclosingSymbolName(call);
    const key = `${callerFile}::${caller}=>${calleeFile}::${callee}`;
    if (callEdgeSeen.has(key)) continue;
    callEdgeSeen.add(key);
    callEdges.push({
      caller,
      callee,
      callerFile,
      calleeFile,
      line: call.getStartLineNumber(),
    });
  }
}

// ---------------------------------------------------------------------------
// Nested provider/hook methods (depth-1 named functions, e.g. DataProvider.addLead).
// The top-level pass misses these; Location questions target them heavily, so the
// answer key needs their exact line ranges. Only capture directly-nested (depth 1)
// named function-like declarations, deeper callbacks are noise.
// ---------------------------------------------------------------------------
const fnLikeKind = (init: Node | undefined): SymbolKind | null => {
  if (!init) return null;
  if (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    return "arrowFunction";
  // hook-wrapped: useCallback(() => {...}) / useMemo(() => {...})
  if (Node.isCallExpression(init)) {
    const hasFnArg = init
      .getArguments()
      .some((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
    if (hasFnArg) return "arrowFunction";
  }
  return null;
};
const functionScopeDepth = (node: Node): number => {
  let depth = 0;
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (
      Node.isArrowFunction(cur) ||
      Node.isFunctionExpression(cur) ||
      Node.isFunctionDeclaration(cur) ||
      Node.isMethodDeclaration(cur)
    )
      depth++;
    cur = cur.getParent();
  }
  return depth;
};

for (const sf of sourceFiles) {
  const file = rel(sf.getFilePath());
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const kind = fnLikeKind(decl.getInitializer());
    if (!kind) continue;
    if (functionScopeDepth(decl) !== 1) continue; // only direct methods of a top-level fn
    const container = enclosingSymbolName(decl.getNameNode());
    if (container === "<module>") continue; // top-level already captured above
    const stmt =
      decl.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? decl;
    symbols.push({
      name: decl.getName(),
      kind,
      file,
      lineStart: stmt.getStartLineNumber(),
      lineEnd: stmt.getEndLineNumber(),
      exported: false,
      container,
    });
  }
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    const name = fn.getName();
    if (!name) continue;
    if (functionScopeDepth(fn) !== 1) continue;
    const container = enclosingSymbolName(fn);
    if (container === "<module>") continue;
    symbols.push({
      name,
      kind: "function",
      file,
      lineStart: fn.getStartLineNumber(),
      lineEnd: fn.getEndLineNumber(),
      exported: false,
      container,
    });
  }
}

// ---------------------------------------------------------------------------
// usedBy, cross-file references of each exported symbol.
// ---------------------------------------------------------------------------
for (const { node, key } of exportedDecls) {
  if (!Node.isReferenceFindable(node)) continue;
  const declFile = rel(node.getSourceFile().getFilePath());
  const set = usedBy.get(key) ?? new Set<string>();
  for (const ref of node.findReferencesAsNodes()) {
    const refFile = rel(ref.getSourceFile().getFilePath());
    if (!inScope(ref.getSourceFile().getFilePath())) continue;
    if (refFile === declFile) continue; // same-file uses aren't a dependency
    set.add(refFile);
  }
  if (set.size) usedBy.set(key, set);
}

// ---------------------------------------------------------------------------
// Emit, deterministic ordering so the dump is reproducible.
// ---------------------------------------------------------------------------
const byFileThenName = (a: { file: string; name: string }, b: typeof a) =>
  a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file);

symbols.sort(byFileThenName);
imports.sort(
  (a, b) =>
    a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile),
);
callEdges.sort(
  (a, b) =>
    a.callerFile.localeCompare(b.callerFile) ||
    a.caller.localeCompare(b.caller) ||
    a.calleeFile.localeCompare(b.calleeFile) ||
    a.callee.localeCompare(b.callee),
);

const usedByObj: Record<string, string[]> = {};
for (const k of [...usedBy.keys()].sort())
  usedByObj[k] = [...usedBy.get(k)!].sort();

const totalLoc = sourceFiles.reduce((n, sf) => n + sf.getEndLineNumber(), 0);

const dump = {
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

const out =
  outFile ??
  join("answer-key", dump.repo.name ?? "repo", "mechanical.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(dump, null, 2));

console.log(`Analyzed ${sourceFiles.length} files from ${repoRoot}`);
console.table(dump.stats);
console.log(`\nWrote mechanical answer key -> ${out}`);
