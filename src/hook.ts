/**
 * Claude Code PostToolUse hook: replace long Bash / Read output with a Digest (ADR-0003).
 * Returns the hook's JSON reply, or undefined to leave the output untouched. Callers fail open.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { isPassthrough, loadConfig, type Config } from "./config.js";
import { buildDigest, computeBudget } from "./digest.js";
import { filterStreams, isShort } from "./filter.js";
import { cleanLine, isNoise, splitLines, templateOf } from "./lines.js";
import { resolveRoot, Store } from "./store.js";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const reply = (updatedToolOutput: unknown) => ({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput } });

export function runHook(input: Json, env: NodeJS.ProcessEnv = process.env): Json | undefined {
  if (env.ENTROPY_FILTER === "off") return undefined;
  if (input.hook_event_name !== "PostToolUse") return undefined; // failures cannot be replaced (ADR-0003)
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (!isObj(input.tool_input) || !isObj(input.tool_response)) return undefined;
  if (input.tool_name === "Bash") return bash(input.tool_input, input.tool_response, cwd, env);
  if (input.tool_name === "Read") return read(input.tool_input, input.tool_response, cwd, env);
  return undefined;
}

/**
 * GitHub Copilot (CLI, and VS Code which shares its hook harness) `postToolUse`:
 * stdin `{ cwd, toolName, toolArgs, toolResult: { resultType, textResultForLlm } }`,
 * reply `{ modifiedResult: { resultType: "success", textResultForLlm } }` replaces the result.
 * Copilot merges stdout and stderr into one text and fires this event only for "success"
 * results, which include shell commands that exited non-zero.
 */
export function runCopilotHook(input: Json, env: NodeJS.ProcessEnv = process.env): Json | undefined {
  if (env.ENTROPY_FILTER === "off") return undefined;
  const tool = String(input.toolName ?? input.tool_name ?? "").toLowerCase();
  if (tool !== "bash" && tool !== "powershell") return undefined;
  const result = isObj(input.toolResult) ? input.toolResult : isObj(input.tool_result) ? input.tool_result : undefined;
  const text = result?.textResultForLlm ?? result?.text_result_for_llm;
  if (typeof text !== "string") return undefined;
  let args: unknown = input.toolArgs ?? input.tool_input;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = { command: args };
    }
  }
  const command = isObj(args) && typeof args.command === "string" ? args.command : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const root = resolveRoot(cwd, env);
  const cfg = loadConfig(root);
  if (isPassthrough(command, cfg.passthroughCommands)) return undefined;
  const store = new Store(root);
  const res = filterStreams({ stdout: text, stderr: "" }, cfg, store, command);
  if (!res) {
    store.stat({ kind: "passthrough", tool: "copilot:" + tool, rawChars: text.length });
    return undefined;
  }
  return { modifiedResult: { resultType: "success", textResultForLlm: res.stdout.text } };
}

function bash(ti: Json, r: Json, cwd: string, env: NodeJS.ProcessEnv): Json | undefined {
  if (r.interrupted || r.isImage || r.backgroundTaskId) return undefined;
  if (typeof r.stdout !== "string" || typeof r.stderr !== "string") return undefined;
  const command = typeof ti.command === "string" ? ti.command : "";
  const root = resolveRoot(cwd, env);
  const cfg = loadConfig(root);
  if (isPassthrough(command, cfg.passthroughCommands)) return undefined;

  // Over 30,000 characters Claude Code hands us a truncated stdout; the full text is on disk.
  let stdout = r.stdout;
  if (typeof r.persistedOutputPath === "string" && existsSync(r.persistedOutputPath)) {
    stdout = readFileSync(r.persistedOutputPath, "utf8");
  }
  const store = new Store(root);
  const res = filterStreams({ stdout, stderr: r.stderr }, cfg, store, command);
  if (!res) {
    store.stat({ kind: "passthrough", tool: "Bash", rawChars: stdout.length + r.stderr.length });
    return undefined;
  }
  return reply({ ...r, stdout: res.stdout.text, stderr: res.stderr.text });
}

// Never filter source or structured files: their repetition is meaning, not noise.
const NEVER = new Set(
  (
    ".ts .tsx .js .jsx .mjs .cjs .py .java .kt .kts .scala .go .rs .c .h .cc .cpp .hpp .cs .rb .php .swift .m .mm " +
    ".sh .bash .zsh .fish .ps1 .sql .json .jsonc .yaml .yml .toml .ini .xml .html .htm .css .scss .less .vue .svelte " +
    ".md .mdx .rst .adoc .tex .csv .tsv .gradle .properties .env .lock .proto .graphql .tf .dart .lua .r .ex .exs .erl .hs .ml .clj .pl"
  ).split(" "),
);
const LOG_EXT = new Set([".log", ".out", ".err"]);

/** Share of meaningful lines whose Template occurs at least 3 times. */
export function repetitionRatio(text: string): number {
  const ts = splitLines(text)
    .map(cleanLine)
    .filter((l) => !isNoise(l))
    .map(templateOf);
  if (!ts.length) return 0;
  const counts = new Map<string, number>();
  for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
  return ts.filter((t) => counts.get(t)! >= 3).length / ts.length;
}

export function shouldFilterRead(path: string, content: string, cfg: Config): boolean {
  const ext = extname(path).toLowerCase();
  if (NEVER.has(ext) || basename(path).startsWith(".")) return false;
  if (isShort(content, cfg)) return false;
  return LOG_EXT.has(ext) || repetitionRatio(content) >= 0.4;
}

function read(ti: Json, r: Json, cwd: string, env: NodeJS.ProcessEnv): Json | undefined {
  // A targeted read (usually opening an Elision) always passes through, or it could loop.
  if (ti.offset != null || ti.limit != null) return undefined;
  if (r.type !== "text" || !isObj(r.file)) return undefined;
  const file = r.file;
  if (typeof file.content !== "string" || typeof file.filePath !== "string") return undefined;
  const root = resolveRoot(cwd, env);
  const cfg = loadConfig(root);
  if (!shouldFilterRead(file.filePath, file.content, cfg)) return undefined;
  const startLine = typeof file.startLine === "number" ? file.startLine : 1;
  const header =
    `[entropy-filter · ${file.filePath} · L${startLine}-${startLine + splitLines(file.content).length - 1} → {kept} lines · ` +
    `margin numbers are not file lines; open an omitted range with Read(file_path, offset=<start>, limit=<count>)]`;
  const d = buildDigest(file.content, { budget: computeBudget(file.content.length, cfg.budgetRatio, cfg.maxDigestChars), header, halo: cfg.halo, firstLine: startLine });
  const text = d.text.replace("{kept}", String(d.keptLines));
  try {
    new Store(root).stat({ kind: "digest", tool: "Read", file: file.filePath, rawChars: file.content.length, digestChars: text.length, size: statSync(file.filePath).size });
  } catch {
    /* best-effort */
  }
  return reply({ ...r, file: { ...file, content: text, numLines: splitLines(text).length } });
}
