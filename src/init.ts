/** `entropy-filter init --client …`: write MCP config and the rules block for one client. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { antigravityPluginFiles } from "./antigravity.js";
import { MARK_END, MARK_START, RULES_BLOCK } from "./instructions.js";

export const CLIENTS = ["claude", "cursor", "cline", "codex", "copilot", "antigravity"] as const;
export type Client = (typeof CLIENTS)[number];

export const NPX_COMMAND = { command: "npx", args: ["-y", "github:tlh-k/entropy-filter", "serve"] };

export interface InitOptions {
  client: Client;
  projectDir: string;
  homeDir?: string;
  /** The bundle to install (default: the running bundle, dist/entropy-filter.mjs). */
  bundleSource?: string;
  /** Package root holding skills/ (default: the directory above the running bundle). */
  packageRoot?: string;
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

/** Readable as plain JSON (missing/empty counts); false for JSONC files with comments. */
function isPlainJson(path: string): boolean {
  try {
    readJsonStrict(path);
    return true;
  } catch {
    return false;
  }
}

function mergeServer(path: string, key: "mcpServers" | "servers", server: Json, log: string[]): void {
  const cfg = readJsonStrict(path);
  cfg[key] = { ...(isObject(cfg[key]) ? cfg[key] : {}), "entropy-filter": server };
  write(path, JSON.stringify(cfg, null, 2) + "\n", log);
}

function bundlePath(opts: InitOptions): string {
  const src = opts.bundleSource ?? fileURLToPath(import.meta.url);
  if (!src.endsWith(".mjs")) throw new Error("init must run from the built bundle (npx -y github:tlh-k/entropy-filter init …)");
  return src;
}

/**
 * Copy the bundle to ~/.entropy-filter/bin/ so user-level configs start it fast and offline
 * (no npx resolution per session). Re-run init to update it.
 */
function installBundle(home: string, opts: InitOptions, log: string[]): string {
  const dest = join(home, ".entropy-filter", "bin", "entropy-filter.mjs");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(bundlePath(opts), dest);
  log.push(`installed ${dest}`);
  return dest;
}

const upsertRules = (path: string, log: string[]) => write(path, upsertBlock(existsSync(path) ? readFileSync(path, "utf8") : "", RULES_BLOCK), log);

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
      upsertRules(join(p, "AGENTS.md"), log);
      break;
    }
    case "copilot": {
      // Copilot CLI: user-level MCP config pointing at a local copy of the bundle.
      const bundle = installBundle(home, opts, log);
      mergeServer(join(home, ".copilot", "mcp-config.json"), "mcpServers", { type: "local", command: "node", args: [bundle, "serve"], tools: ["*"] }, log);
      // postToolUse can replace a shell result (modifiedResult). Same bash/powershell command so it also runs on Windows.
      const cmd = `node "${bundle}" hook post-tool-use --client copilot`;
      write(
        join(home, ".copilot", "hooks", "entropy-filter.json"),
        JSON.stringify({ version: 1, hooks: { postToolUse: [{ type: "command", bash: cmd, powershell: cmd, timeoutSec: 10 }] } }, null, 2) + "\n",
        log,
      );
      // VS Code agent mode: project file, may be committed, so use the portable npx command.
      const vscode = join(p, ".vscode", "mcp.json");
      const server = { type: "stdio", ...NPX_COMMAND };
      if (isPlainJson(vscode)) mergeServer(vscode, "servers", server, log);
      else log.push(`add this server to ${vscode} under "servers" (the file has comments, so it was not edited):`, JSON.stringify({ "entropy-filter": server }, null, 2));
      upsertRules(join(p, ".github", "copilot-instructions.md"), log);
      break;
    }
    case "antigravity": {
      const dest = join(home, ".gemini", "config", "plugins", "entropy-filter");
      const bundle = bundlePath(opts);
      for (const [rel, content] of Object.entries(antigravityPluginFiles())) write(join(dest, rel), content, log);
      mkdirSync(join(dest, "dist"), { recursive: true });
      copyFileSync(bundle, join(dest, "dist", "entropy-filter.mjs"));
      const skill = join(opts.packageRoot ?? join(dirname(bundle), ".."), "skills", "entropy-filter", "SKILL.md");
      if (existsSync(skill)) write(join(dest, "skills", "entropy-filter", "SKILL.md"), readFileSync(skill, "utf8"), log);
      log.push(`installed plugin ${dest} (restart Antigravity to load it)`);
      break;
    }
  }
  return log;
}
