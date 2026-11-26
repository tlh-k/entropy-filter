/** `entropy-filter init --client …`: write MCP config and the rules block for one client. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MARK_END, MARK_START, RULES_BLOCK } from "./instructions.js";

export const CLIENTS = ["claude", "cursor", "cline", "codex"] as const;
export type Client = (typeof CLIENTS)[number];

export const NPX_COMMAND = { command: "npx", args: ["-y", "github:tlh-k/entropy-filter", "serve"] };

export interface InitOptions {
  client: Client;
  projectDir: string;
  homeDir?: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function readJsonStrict(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : {};
  } catch {
    throw new Error(`${path} is not valid JSON; fix or remove it and re-run`);
  }
}

function write(path: string, content: string, log: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  log.push(`wrote ${path}`);
}

/** Insert or replace the marker-delimited rules block (idempotent). */
export function upsertBlock(existing: string, block: string): string {
  const wrapped = `${MARK_START}\n${block.trim()}\n${MARK_END}`;
  const s = existing.indexOf(MARK_START);
  const e = existing.indexOf(MARK_END);
  if (s >= 0 && e > s) return existing.slice(0, s) + wrapped + existing.slice(e + MARK_END.length);
  return (existing.trimEnd() ? existing.trimEnd() + "\n\n" : "") + wrapped + "\n";
}

export function init(opts: InitOptions): string[] {
  const log: string[] = [];
  const home = opts.homeDir ?? homedir();
  const p = opts.projectDir;
  switch (opts.client) {
    case "claude":
      log.push(
        "Claude Code uses the plugin (PostToolUse hook + MCP tools + skill in one):",
        "  /plugin marketplace add tlh-k/entropy-filter",
        "  /plugin install entropy-filter@entropy-filter",
      );
      break;
    case "cursor": {
      const path = join(p, ".cursor", "mcp.json");
      const cfg = readJsonStrict(path);
      cfg.mcpServers = { ...(isObject(cfg.mcpServers) ? cfg.mcpServers : {}), "entropy-filter": NPX_COMMAND };
      write(path, JSON.stringify(cfg, null, 2) + "\n", log);
      write(join(p, ".cursor", "rules", "entropy-filter.mdc"), `---\ndescription: Run tests, builds and linters through entropy_exec\nalwaysApply: true\n---\n\n${RULES_BLOCK}`, log);
      break;
    }
    case "cline":
      write(join(p, ".clinerules", "entropy-filter.md"), RULES_BLOCK, log);
      log.push(
        "Add this server in Cline → MCP Servers → Configure (cline_mcp_settings.json):",
        JSON.stringify({ mcpServers: { "entropy-filter": NPX_COMMAND } }, null, 2),
      );
      break;
    case "codex": {
      const toml = join(home, ".codex", "config.toml");
      const cur = existsSync(toml) ? readFileSync(toml, "utf8") : "";
      if (cur.includes("[mcp_servers.entropy-filter]")) log.push(`${toml} already has entropy-filter`);
      else write(toml, (cur.trimEnd() ? cur.trimEnd() + "\n\n" : "") + `[mcp_servers.entropy-filter]\ncommand = "npx"\nargs = ["-y", "github:tlh-k/entropy-filter", "serve"]\n`, log);
      const agents = join(p, "AGENTS.md");
      write(agents, upsertBlock(existsSync(agents) ? readFileSync(agents, "utf8") : "", RULES_BLOCK), log);
      break;
    }
  }
  return log;
}
