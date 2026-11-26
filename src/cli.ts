import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { entropyExec } from "./exec.js";
import { captureAndDigest, isShort } from "./filter.js";
import { computeBudget } from "./digest.js";
import { runHook } from "./hook.js";
import { CLIENTS, type Client, init } from "./init.js";
import { serve } from "./server.js";
import { resolveRoot, Store } from "./store.js";
import { callSlice } from "./tools.js";
import { VERSION } from "./version.js";

const USAGE = `entropy-filter ${VERSION}
Usage:
  entropy-filter serve                      Run the stdio MCP server
  entropy-filter hook post-tool-use         Claude Code hook handler (JSON on stdin)
  entropy-filter exec -- <command…>         Run a command, print exit status + Digest
  entropy-filter filter [file]              Digest a file or stdin (stores a Capture)
  entropy-filter slice <id> <start> <end>   Print raw lines of a Capture
  entropy-filter init --client <${CLIENTS.join("|")}> [--dir <project>]
  entropy-filter stats                      Digest / passthrough / slice counts for this project`;

/** Read all of stdin. readFileSync(0) can throw EAGAIN on large piped input. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function stats(root: string): string {
  const rows = new Store(root).readStats();
  const by = (k: string) => rows.filter((r) => r.kind === k);
  const digests = by("digest");
  const raw = digests.reduce((s, r) => s + Number(r.rawChars ?? 0), 0);
  const kept = digests.reduce((s, r) => s + Number(r.digestChars ?? 0), 0);
  const pct = raw ? ((1 - kept / raw) * 100).toFixed(1) : "0";
  return [
    `digests:      ${digests.length} (${raw} → ${kept} chars, −${pct}%)`,
    `passthrough:  ${by("passthrough").length}`,
    `slices read:  ${by("slice").length} (re-retrieval per digest: ${digests.length ? (by("slice").length / digests.length).toFixed(2) : "0"})`,
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "serve":
      await serve();
      return -1;
    case "hook": {
      // Fail-open: any problem means "no output, exit 0".
      try {
        const input = JSON.parse(await readStdin());
        if (input && typeof input === "object" && !Array.isArray(input)) {
          const out = runHook(input);
          if (out) process.stdout.write(JSON.stringify(out) + "\n");
        }
      } catch {
        /* fail open */
      }
      return 0;
    }
    case "exec": {
      const parts = rest[0] === "--" ? rest.slice(1) : rest;
      if (!parts.length) {
        console.error("usage: entropy-filter exec -- <command…>");
        return 2;
      }
      const r = await entropyExec(parts.join(" "), process.cwd(), resolveRoot(process.cwd()));
      console.log(r.text);
      return r.exitCode ?? 1;
    }
    case "filter": {
      const text = rest[0] ? readFileSync(rest[0], "utf8") : await readStdin();
      const root = resolveRoot(process.cwd());
      const cfg = loadConfig(root);
      if (isShort(text, cfg)) process.stdout.write(text);
      else console.log(captureAndDigest(text, rest[0] ? "file" : "stdin", computeBudget(text.length, cfg.budgetRatio, cfg.maxDigestChars), cfg, new Store(root)).text);
      return 0;
    }
    case "slice": {
      const [id, a, b] = rest;
      const r = callSlice({ capture_id: id ?? "", start_line: Number(a), end_line: Number(b ?? a) }, resolveRoot(process.cwd()));
      (r.isError ? console.error : console.log)(r.text);
      return r.isError ? 1 : 0;
    }
    case "init": {
      const client = arg(rest, "--client") as Client | undefined;
      if (!client || !CLIENTS.includes(client)) {
        console.error(`--client must be one of: ${CLIENTS.join(", ")}`);
        return 2;
      }
      for (const line of init({ client, projectDir: arg(rest, "--dir") ?? process.cwd() })) console.log(line);
      return 0;
    }
    case "stats":
      console.log(stats(resolveRoot(process.cwd())));
      return 0;
    case "rules": {
      // Build step: rules/AGENTS.md is generated from the same block init writes.
      const { RULES_BLOCK } = await import("./instructions.js");
      process.stdout.write(RULES_BLOCK);
      return 0;
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err) => {
    console.error(`entropy-filter: ${(err as Error).message}`);
    process.exitCode = 1;
  },
);
