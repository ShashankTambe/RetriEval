import packager from "electron-packager";

const paths = await packager({
  dir: ".",
  name: "RetriEval",
  platform: "win32",
  arch: "x64",
  out: "dist-pack",
  overwrite: true,
  asar: false,
  extraResource: ["build-staging/lesstokenify"],
  prune: true,
  // answer-key ships (curated paraphrase sets); heavy/dev dirs excluded
  ignore: [/^\/(eval-results|build-staging|dist-pack|\.git|tools)($|\/)/],
});
console.log("Packaged to:", paths);
