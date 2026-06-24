import { defineConfig } from "tsup";

// Self-contained engine bundle config (used by `npm run build:engine`).
// Builds src/index.ts with ALL npm deps inlined (noExternal:[/.*/]) into a
// single dist-engine/index.js that loads with NO node_modules present, so the
// fleet can vendor it for in-process embedding. react-devtools-core stays
// external (mirrors the cli entry in tsup.config.ts). Grammars are copied
// beside the bundle (dist-engine/grammars) by scripts/copy-tree-sitter-grammars-engine.mjs,
// matching the import.meta.url relative lookup in src/code-query/parser.ts.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: false,
  target: "node22",
  outDir: "dist-engine",
  platform: "node",
  noExternal: [/.*/],
  esbuildOptions(opts) {
    opts.external = [...(opts.external ?? []), "react-devtools-core"];
  },
});
