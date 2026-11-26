/** MCP tool descriptions and handlers, kept free of transport so they can be tested directly. */
import { DEFAULT_TIMEOUT_MS, entropyExec } from "./exec.js";
import { EvictedError, Store } from "./store.js";

export const MAX_SLICE_LINES = 400;
export const MAX_SLICE_CHARS = 40_000;

export const TOOL_DESCRIPTIONS = {
  entropy_exec:
    "Run a shell command and get its exit code plus a Digest: the lines that carry information (errors, stack traces, " +
    "failing assertions, summaries) in original order, with repeated boilerplate folded into ⟪L<a>-<b> ×<n> \"<template>\"⟫ " +
    "Elisions. Use it instead of plain Bash for test, build, lint, install and other long-output commands, whether or not " +
    "they are expected to fail. Raw output is kept locally; open an omitted range with entropy_read_slice instead of re-running.",
  entropy_read_slice:
    "Return raw lines [start_line, end_line] (1-based, inclusive) of a Capture named in a Digest header " +
    `([entropy-filter <capture_id> · …]). At most ${MAX_SLICE_LINES} lines per call. Use it to open an Elision ` +
    "instead of re-running the command.",
} as const;

export interface ToolResult {
  text: string;
  isError: boolean;
}

export async function callExec(args: { command: string; cwd?: string; timeout_ms?: number }, workspace: string, root: string): Promise<ToolResult> {
  const r = await entropyExec(args.command, args.cwd ?? workspace, root, args.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  return { text: r.text, isError: false };
}

export function callSlice(args: { capture_id: string; start_line: number; end_line: number }, root: string): ToolResult {
  const store = new Store(root);
  try {
    const start = Math.max(1, Math.floor(args.start_line));
    const end = Math.min(Math.floor(args.end_line), start + MAX_SLICE_LINES - 1);
    if (end < start) return { text: "end_line must be ≥ start_line", isError: true };
    const { lines, total } = store.slice(args.capture_id, start, end);
    let body = "";
    let shown = 0;
    for (const [k, l] of lines.entries()) {
      const row = `${start + k}\t${l}\n`;
      if (body.length + row.length > MAX_SLICE_CHARS) break;
      body += row;
      shown++;
    }
    const last = start + shown - 1;
    store.stat({ kind: "slice", capture: args.capture_id, start, end: last });
    const more = last < Math.min(args.end_line, total) ? ` · truncated; continue from ${last + 1}` : "";
    return { text: `[${args.capture_id} L${start}-${last} of ${total}${more}]\n${body}`.trimEnd(), isError: false };
  } catch (e) {
    return { text: e instanceof EvictedError ? e.message : `entropy_read_slice: ${(e as Error).message}`, isError: true };
  }
}
