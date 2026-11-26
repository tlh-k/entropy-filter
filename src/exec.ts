/** entropy_exec: run a shell command, Capture its streams, return exit code + Digest. */
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { filterStreams } from "./filter.js";
import { MAX_CAPTURE_BYTES, Store } from "./store.js";

export const DEFAULT_TIMEOUT_MS = 600_000;

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  text: string;
}

function collector() {
  const chunks: Buffer[] = [];
  let size = 0;
  let dropped = 0;
  return {
    push(b: Buffer) {
      if (size >= MAX_CAPTURE_BYTES) {
        dropped += b.length;
        return;
      }
      chunks.push(b);
      size += b.length;
    },
    text() {
      const s = Buffer.concat(chunks).toString("utf8");
      return dropped ? `${s}\n[entropy-filter: ${dropped} more bytes dropped]` : s;
    },
  };
}

export function runCommand(command: string, cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Omit<ExecResult, "text"> & { stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: process.platform === "win32" ? true : "/bin/sh", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const out = collector();
    const err = collector();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => err.push(Buffer.from(String(e.message))));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, durationMs: Date.now() - started, stdout: out.text(), stderr: err.text() });
    });
  });
}

export async function entropyExec(command: string, cwd: string, root: string, timeoutMs?: number): Promise<ExecResult> {
  const r = await runCommand(command, cwd, timeoutMs);
  const cfg = loadConfig(root);
  const store = new Store(root);
  const res = filterStreams({ stdout: r.stdout, stderr: r.stderr }, cfg, store, command);
  if (!res) store.stat({ kind: "passthrough", tool: "entropy_exec", rawChars: r.stdout.length + r.stderr.length });
  const status = r.timedOut ? `timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : r.signal ? `killed by ${r.signal}` : `exit ${r.exitCode}`;
  const parts = [`[${status} · ${(r.durationMs / 1000).toFixed(1)}s]`];
  const stderr = res ? res.stderr.text : r.stderr;
  const stdout = res ? res.stdout.text : r.stdout;
  const both = stderr.trim() !== "" && stdout.trim() !== "";
  if (stderr.trim()) parts.push("── stderr ──", stderr.trimEnd());
  if (stdout.trim()) parts.push(...(both ? ["── stdout ──"] : []), stdout.trimEnd());
  return { ...r, text: parts.join("\n") };
}
