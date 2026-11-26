/** The Capture store: raw outputs on local disk, evicted by quota (ADR-0002). */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DIRNAME = ".entropy-filter";
export const MAX_CAPTURES = 200;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export interface CaptureMeta {
  id: string;
  command?: string;
  source: string; // "stdout" | "stderr" | "text"
  createdAt: string;
  lines: number;
  bytes: number;
  truncated: boolean;
}

/** Project root: ENTROPY_FILTER_ROOT, else the git worktree root, else cwd. */
export function resolveRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ENTROPY_FILTER_ROOT) return env.ENTROPY_FILTER_ROOT;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim() || cwd;
  } catch {
    return cwd;
  }
}

export class EvictedError extends Error {}

export interface Limits {
  maxCaptures: number;
  maxTotalBytes: number;
  maxCaptureBytes: number;
}

export const LIMITS: Limits = { maxCaptures: MAX_CAPTURES, maxTotalBytes: MAX_TOTAL_BYTES, maxCaptureBytes: MAX_CAPTURE_BYTES };

export class Store {
  readonly dir: string;
  readonly capturesDir: string;
  constructor(
    readonly root: string,
    private readonly limits: Limits = LIMITS,
  ) {
    this.dir = join(root, DIRNAME);
    this.capturesDir = join(this.dir, "captures");
  }

  private ensure(): void {
    mkdirSync(this.capturesDir, { recursive: true });
    const gi = join(this.capturesDir, ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*\n");
  }

  private newId(): string {
    for (;;) {
      const id = randomBytes(3).toString("hex");
      if (!existsSync(join(this.capturesDir, `${id}.log`))) return id;
    }
  }

  /** Store raw text; returns its meta. Text beyond the per-Capture cap is dropped and flagged. */
  write(text: string, source: string, command?: string): CaptureMeta {
    this.ensure();
    let body = text;
    let truncated = false;
    if (Buffer.byteLength(body) > this.limits.maxCaptureBytes) {
      body = Buffer.from(body).subarray(0, this.limits.maxCaptureBytes).toString("utf8");
      truncated = true;
    }
    const id = this.newId();
    const lines = body === "" ? 0 : body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
    const meta: CaptureMeta = { id, command, source, createdAt: new Date().toISOString(), lines, bytes: Buffer.byteLength(body), truncated };
    writeFileSync(join(this.capturesDir, `${id}.log`), body);
    writeFileSync(join(this.capturesDir, `${id}.json`), JSON.stringify(meta) + "\n");
    this.evict();
    return meta;
  }

  /** Oldest-first eviction once the count or byte quota is exceeded. */
  evict(): void {
    const logs = readdirSync(this.capturesDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const st = statSync(join(this.capturesDir, f));
        return { id: f.slice(0, -4), size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = logs.reduce((s, l) => s + l.size, 0);
    let count = logs.length;
    for (const l of logs) {
      if (count <= this.limits.maxCaptures && total <= this.limits.maxTotalBytes) break;
      for (const ext of [".log", ".json"]) {
        try {
          unlinkSync(join(this.capturesDir, l.id + ext));
        } catch {
          /* already gone */
        }
      }
      count--;
      total -= l.size;
    }
  }

  remove(id: string): void {
    for (const ext of [".log", ".json"]) {
      try {
        unlinkSync(join(this.capturesDir, id + ext));
      } catch {
        /* already gone */
      }
    }
  }

  /** Raw lines [start, end] (1-based, inclusive) of a Capture. */
  slice(id: string, start: number, end: number): { lines: string[]; total: number } {
    if (!/^[0-9a-f]{6}$/.test(id)) throw new Error(`"${id}" is not a Capture id (6 hex characters, e.g. c7f2a1)`);
    const path = join(this.capturesDir, `${id}.log`);
    if (!existsSync(path)) throw new EvictedError(`Capture ${id} was evicted by rotation (or never existed); re-run the command.`);
    const all = readFileSync(path, "utf8").split("\n");
    if (all[all.length - 1] === "") all.pop();
    return { lines: all.slice(Math.max(start, 1) - 1, Math.max(end, 0)), total: all.length };
  }

  /** Append one measurement line; never throws. */
  stat(entry: Record<string, unknown>): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, "stats.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    } catch {
      /* measurement is best-effort */
    }
  }

  readStats(): Record<string, unknown>[] {
    const path = join(this.dir, "stats.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }
}
