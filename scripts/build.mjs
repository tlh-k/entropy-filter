import { build } from "esbuild";
import { chmodSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const out = "dist/entropy-filter.mjs";
await build({
  entryPoints: ["src/cli.ts"],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: false,
  legalComments: "none",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
chmodSync(out, 0o755);
console.log(`built ${out}`);

// rules/AGENTS.md mirrors the block `init` writes, for people who copy it by hand.
writeFileSync("rules/AGENTS.md", execFileSync(process.execPath, [out, "rules"], { encoding: "utf8" }));
