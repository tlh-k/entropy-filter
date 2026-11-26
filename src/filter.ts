/** Turn raw streams into what the agent sees: raw when short, otherwise Capture + Digest. */
import type { Config } from "./config.js";
import { buildDigest, computeBudget } from "./digest.js";
import { splitLines } from "./lines.js";
import type { Store } from "./store.js";

export const SLICE_HINT = "omitted ranges: entropy_read_slice(capture_id, start_line, end_line)";

export function isShort(text: string, cfg: Config): boolean {
  return text.length <= cfg.maxDigestChars && splitLines(text).length <= cfg.shortLines;
}

export interface StreamResult {
  text: string;
  captureId?: string;
}

/** Store `text` as a Capture and return its Digest, sized to `budget`. */
export function captureAndDigest(text: string, source: string, budget: number, cfg: Config, store: Store, command?: string): StreamResult {
  const meta = store.write(text, source, command);
  const header = `[entropy-filter ${meta.id} · ${source} · ${meta.lines}→{kept} lines · ${SLICE_HINT}]`;
  const d = buildDigest(text, { budget, header, halo: cfg.halo });
  const out = d.text.replace("{kept}", String(d.keptLines));
  store.stat({ kind: "digest", capture: meta.id, source, command, rawChars: text.length, digestChars: out.length, lines: d.totalLines, kept: d.keptLines });
  return { text: out, captureId: meta.id };
}

/**
 * Filter stdout and stderr together. They share one ceiling; stderr is served first (SPEC §4.4).
 * Returns undefined when nothing needs to change.
 */
export function filterStreams(
  streams: { stdout: string; stderr: string },
  cfg: Config,
  store: Store,
  command?: string,
): { stdout: StreamResult; stderr: StreamResult } | undefined {
  const { stdout, stderr } = streams;
  if (isShort(stdout + (stderr ? "\n" + stderr : ""), cfg)) return undefined;
  const cap = cfg.maxDigestChars;

  let err: StreamResult = { text: stderr };
  if (!isShort(stderr, cfg)) {
    err = captureAndDigest(stderr, "stderr", computeBudget(stderr.length, cfg.budgetRatio, cap), cfg, store, command);
  }
  const remaining = Math.max(cap - err.text.length, 1000);
  let out: StreamResult = { text: stdout };
  if (!(isShort(stdout, cfg) && stdout.length <= remaining)) {
    out = captureAndDigest(stdout, "stdout", Math.min(computeBudget(stdout.length, cfg.budgetRatio, cap), remaining), cfg, store, command);
  }
  return { stdout: out, stderr: err };
}
