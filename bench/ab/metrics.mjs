// Per-run metrics read from the Claude Code transcript (~/.claude/projects/<cwd>/<session>.jsonl).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIGEST = /\[entropy-filter (?:[0-9a-f]{6} ·|·)/;
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function findTranscript(sessionId) {
  const base = join(homedir(), ".claude", "projects");
  for (const d of readdirSync(base)) {
    const f = join(base, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || "").join("") : "");
const norm = (s) => String(s ?? "").replace(/^cd [^&;]+(?:&&|;)\s*/, "").replace(/\s+/g, " ").trim();

/**
 * - toolResultChars: characters of tool results that entered the context (primary metric)
 * - digests / entropyExec: did the filter act at all (validity)
 * - retrievals: entropy_read_slice calls + targeted Reads (offset/limit) of a file already read in
 *   the session — both are "going back for omitted lines"
 * - reruns: the same command again with no edit in between
 */
export function transcriptMetrics(sessionIds) {
  const m = { toolResultChars: 0, toolCalls: 0, digests: 0, entropyExec: 0, slices: 0, targetedReads: 0, retrievals: 0, reruns: 0, failedTools: 0, byTool: {} };
  for (const sid of sessionIds) {
    const f = sid && findTranscript(sid);
    if (!f) continue;
    const uses = new Map();
    const seenResults = new Set(); // transcripts can repeat a record; count each call once
    const readPaths = new Set();
    const cmdsSinceEdit = new Set();
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const content = Array.isArray(d.message?.content) ? d.message.content : [];
      for (const c of content) {
        if (c.type === "tool_use") {
          if (uses.has(c.id)) continue;
          const name = String(c.name).split("__").pop();
          const input = c.input || {};
          uses.set(c.id, name);
          m.toolCalls++;
          m.byTool[name] = (m.byTool[name] || 0) + 1;
          if (EDITS.has(name)) cmdsSinceEdit.clear();
          if (name === "entropy_exec") m.entropyExec++;
          if (name === "entropy_read_slice") m.slices++;
          if (name === "Read") {
            const p = String(input.file_path ?? "");
            if ((input.offset != null || input.limit != null) && readPaths.has(p)) m.targetedReads++;
            readPaths.add(p);
          }
          if (name === "Bash" || name === "entropy_exec") {
            const k = norm(input.command);
            if (cmdsSinceEdit.has(k)) m.reruns++;
            cmdsSinceEdit.add(k);
          }
        }
        if (c.type === "tool_result") {
          if (seenResults.has(c.tool_use_id)) continue;
          seenResults.add(c.tool_use_id);
          const t = text(c.content);
          m.toolResultChars += t.length;
          if (DIGEST.test(t)) m.digests++;
          if (c.is_error) m.failedTools++;
        }
      }
    }
  }
  m.retrievals = m.slices + m.targetedReads;
  // Fired = a Digest actually reached the model. entropy_exec on a piped, already-short command
  // produces no Digest, so it does not count.
  m.filterFired = m.digests > 0;
  return m;
}
