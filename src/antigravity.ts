import { RULES_BLOCK } from "./instructions.js";
import { VERSION } from "./version.js";

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/**
 * The Antigravity plugin, as files relative to the plugin root (excluding dist/ and skills/).
 * The repo root ships these (written by the build) and `init --client antigravity` installs the
 * same set into ~/.gemini/config/plugins/entropy-filter/, so both install paths stay identical.
 */
export function antigravityPluginFiles(): Record<string, string> {
  return {
    ".antigravity-plugin/plugin.json": json({
      $schema: "https://antigravity.google/schemas/v1/plugin.json",
      name: "entropy-filter",
      displayName: "Entropy Filter",
      version: VERSION,
      description: "Entropy-based output filter: run tests, builds and linters through entropy_exec to get errors, stack traces and summaries with repeated boilerplate folded away; raw output stays local.",
      repository: "https://github.com/tlh-k/entropy-filter",
    }),
    "mcp_config.json": json({
      mcpServers: { "entropy-filter": { command: "node", args: ["${PLUGIN_ROOT}/dist/entropy-filter.mjs", "serve"] } },
    }),
    "rules/AGENTS.md": RULES_BLOCK,
  };
}
