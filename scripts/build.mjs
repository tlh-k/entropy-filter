import { build } from "esbuild";
import { chmodSync } from "node:fs";
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

// The repo root doubles as an Antigravity plugin (.antigravity-plugin/, mcp_config.json,
// rules/AGENTS.md); regenerate those files from the code.
execFileSync(process.execPath, [out, "write-antigravity-plugin", "."], { stdio: "inherit" });
