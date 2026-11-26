/**
 * Offline replay: run the filter over real Claude Code transcripts (~/.claude/projects/**.jsonl)
 * and report what it would have saved, and why it did not fire where it could not.
 * No model calls; Captures go to a throwaway directory.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, isPassthrough } from "./config.js";
import { filterStreams } from "./filter.js";
import { shouldFilterRead } from "./hook.js";
import { buildDigest, computeBudget } from "./digest.js";
import { Store } from "./store.js";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why a tool result ended up as it did. */
export type Outcome =
  | "digest" // the hook would replace it
  | "short" // under the pass-through threshold
  | "passthrough-cmd" // git diff, cat, tail, …
  | "self-truncated" // command already pipes into tail/head/grep (output small by construction)
  | "failed-blind" // non-zero exit: Claude Code ignores replacements (ADR-0003)
  | "read-digest"
  | "read-skip"; // source code, targeted read, short, not log-like

export interface Row {
  tool: "Bash" | "Read";
  outcome: Outcome;
  rawChars: number;
  afterChars: number;
  /** For failed-blind rows: what a Digest would have been if the hook could replace it. */
  potentialChars?: number;
}

const SELF_TRUNCATE = /\|\s*(?:tail|head|grep|egrep|rg|cut|sed -n|awk)\b/;

export function walk(dir: string, out: string[] = [], max = 5000): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= max) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, max);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function digestSize(text: string): number {
  const store = new Store(mkdtempSync(join(tmpdir(), "ef-replay-")));
  try {
    const r = filterStreams({ stdout: text, stderr: "" }, DEFAULTS, store);
    return r ? Math.min(r.stdout.text.length, text.length) : text.length;
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
}

/** Classify every Bash and Read result in one transcript. */
export function replayFile(path: string): Row[] {
  const uses = new Map<string, { name: string; input: Json }>();
  const rows: Row[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let d: Json;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = isObj(d.message) ? d.message : undefined;
    const content = Array.isArray(msg?.content) ? (msg!.content as unknown[]) : [];
    for (const c of content) {
      if (!isObj(c)) continue;
      if (c.type === "tool_use" && typeof c.id === "string" && isObj(c.input)) uses.set(c.id, { name: String(c.name), input: c.input });
      if (c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
      const use = uses.get(c.tool_use_id);
      if (!use || (use.name !== "Bash" && use.name !== "Read")) continue;
      const r = d.toolUseResult;
      if (use.name === "Bash") {
        const command = String(use.input.command ?? "");
        if (typeof r === "string") {
          // Failed call: "Error: Exit code N\n<output>"
          const body = r.replace(/^Error: Exit code \d+\n/, "");
          const potential = isPassthrough(command) ? r.length : digestSize(body);
          rows.push({ tool: "Bash", outcome: "failed-blind", rawChars: r.length, afterChars: r.length, potentialChars: Math.min(potential, r.length) });
          continue;
        }
        if (!isObj(r) || typeof r.stdout !== "string") continue;
        let stdout = r.stdout;
        if (typeof r.persistedOutputPath === "string") {
          try {
            stdout = readFileSync(r.persistedOutputPath, "utf8");
          } catch {
            /* persisted file gone: use the preview */
          }
        }
        const text = stdout + (typeof r.stderr === "string" && r.stderr ? "\n" + r.stderr : "");
        let outcome: Outcome;
        let after = text.length;
        if (SELF_TRUNCATE.test(command) && digestSize(text) >= text.length) outcome = "self-truncated";
        else if (isPassthrough(command)) outcome = "passthrough-cmd";
        else {
          after = digestSize(text);
          outcome = after < text.length ? "digest" : SELF_TRUNCATE.test(command) ? "self-truncated" : "short";
        }
        rows.push({ tool: "Bash", outcome, rawChars: text.length, afterChars: after });
      } else {
        if (!isObj(r) || !isObj(r.file) || typeof r.file.content !== "string") continue;
        const content = r.file.content;
        const targeted = use.input.offset != null || use.input.limit != null;
        if (targeted || !shouldFilterRead(String(r.file.filePath ?? ""), content, DEFAULTS)) {
          rows.push({ tool: "Read", outcome: "read-skip", rawChars: content.length, afterChars: content.length });
          continue;
        }
        const d2 = buildDigest(content, { budget: computeBudget(content.length, DEFAULTS.budgetRatio, DEFAULTS.maxDigestChars), header: "[entropy-filter · x]" });
        rows.push({ tool: "Read", outcome: "read-digest", rawChars: content.length, afterChars: d2.text.length });
      }
    }
  }
  return rows;
}

export function summarize(rows: Row[], files: number): string {
  const total = rows.reduce((s, r) => s + r.rawChars, 0);
  const saved = rows.reduce((s, r) => s + (r.rawChars - r.afterChars), 0);
  const order: Outcome[] = ["digest", "read-digest", "failed-blind", "self-truncated", "short", "passthrough-cmd", "read-skip"];
  const pct = (n: number) => (total ? ((n / total) * 100).toFixed(1) + "%" : "-");
  const lines = [
    `transcripts: ${files} · Bash+Read results: ${rows.length} · raw chars: ${total}`,
    "",
    `${"outcome".padEnd(16)}${"calls".padStart(7)}${"raw chars".padStart(12)}${"share".padStart(8)}${"after".padStart(11)}`,
  ];
  for (const o of order) {
    const rs = rows.filter((r) => r.outcome === o);
    const raw = rs.reduce((s, r) => s + r.rawChars, 0);
    const after = rs.reduce((s, r) => s + r.afterChars, 0);
    lines.push(`${o.padEnd(16)}${String(rs.length).padStart(7)}${String(raw).padStart(12)}${pct(raw).padStart(8)}${String(after).padStart(11)}`);
  }
  const blind = rows.filter((r) => r.outcome === "failed-blind");
  const blindSavable = blind.reduce((s, r) => s + (r.rawChars - (r.potentialChars ?? r.rawChars)), 0);
  const selfTrunc = rows.filter((r) => r.outcome === "self-truncated").length;
  const bash = rows.filter((r) => r.tool === "Bash").length;
  lines.push(
    "",
    `saved by the hook:              ${saved} chars (${pct(saved)} of all Bash+Read result text)`,
    `lost to non-zero exits (blind): ${blindSavable} chars (${pct(blindSavable)}) would be saved if failures were replaceable`,
    `Bash calls already piped into tail/head/grep: ${selfTrunc} of ${bash}`,
  );
  return lines.join("\n");
}

export function replay(dir: string, sinceDays?: number): string {
  const cutoff = sinceDays ? Date.now() - sinceDays * 86_400_000 : 0;
  const files = walk(dir).filter((f) => statSync(f).mtimeMs >= cutoff);
  const rows = files.flatMap((f) => {
    try {
      return replayFile(f);
    } catch {
      return [];
    }
  });
  return summarize(rows, files.length);
}
