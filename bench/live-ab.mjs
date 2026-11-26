#!/usr/bin/env node
// Live A/B (SPEC §8, layer 2): run the same task with and without the plugin through
// `claude -p` and compare tokens, cost, turns, entropy_read_slice calls, repeated commands
// and whether the answer found the planted failures. Manual, costs real tokens:
//
//   npm run build && node bench/live-ab.mjs [--runs 3] [--model claude-haiku-5-5]
//
// Not a CI gate.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const RUNS = Number(arg("--runs", "3"));
const MODEL = arg("--model", "claude-haiku-5-5");

const TASK =
  "The test command for this repo is ./run-tests.sh and the build is ./build.sh. Run both. " +
  "Report: (1) the failing test name with expected and received values, (2) the build error with file and line, " +
  "(3) the error line in logs/app.log.";
const EXPECT = [/applies KDV/, /120/, /100/, /pg\.go:118/, /391\.01/];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ef-ab-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const tests = ["#!/bin/sh", 'i=1; while [ $i -le 400 ]; do echo "PASS src/mod$i.test.ts ($((i % 40 + 3)) ms)"; i=$((i+1)); done',
    'echo "FAIL src/billing/invoice.test.ts"; echo "  ● Invoice › applies KDV"; echo "    Expected: 120"; echo "    Received: 100"',
    'while [ $i -le 800 ]; do echo "PASS src/mod$i.test.ts ($((i % 40 + 3)) ms)"; i=$((i+1)); done', 'echo "Tests: 1 failed, 799 passed, 800 total"; exit 1'];
  const build = ["#!/bin/sh", 'i=1; while [ $i -le 300 ]; do echo "   Compiling crate$i v0.$((i % 9)).$((i % 5))"; i=$((i+1)); done',
    'echo "internal/store/pg.go:118:9: undefined: pgx.ErrNoRows" 1>&2', 'while [ $i -le 500 ]; do echo "   Compiling crate$i v0.1.0"; i=$((i+1)); done', "exit 2"];
  writeFileSync(join(dir, "run-tests.sh"), tests.join("\n") + "\n");
  writeFileSync(join(dir, "build.sh"), build.join("\n") + "\n");
  chmodSync(join(dir, "run-tests.sh"), 0o755);
  chmodSync(join(dir, "build.sh"), 0o755);
  execFileSync("mkdir", ["-p", join(dir, "logs")]);
  const log = Array.from({ length: 3000 }, (_, i) => `2026-11-27 10:00:${String(i % 60).padStart(2, "0")} INFO [FaturaServisi] Fatura #${10000 + i} işlendi`);
  log[1777] = "2026-11-27 10:29:37 HATA [Muhasebe] Yevmiye fişi oluşturulamadı: hesap 391.01 bulunamadı";
  writeFileSync(join(dir, "logs", "app.log"), log.join("\n") + "\n");
  return dir;
}

function transcript(sessionId) {
  const base = join(homedir(), ".claude", "projects");
  for (const d of readdirSync(base)) {
    const f = join(base, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  return [];
}

function runOnce(withPlugin) {
  const dir = makeRepo();
  // The prompt goes first: --allowedTools is variadic and would swallow a trailing prompt.
  const args = ["-p", TASK, "--model", MODEL, "--output-format", "json", "--allowedTools",
    "Bash Read Grep mcp__plugin_entropy-filter_entropy-filter__entropy_exec mcp__plugin_entropy-filter_entropy-filter__entropy_read_slice"];
  if (withPlugin) args.push("--plugin-dir", PLUGIN);
  const r = spawnSync("claude", args, { cwd: dir, encoding: "utf8", input: "", timeout: 600_000 });
  if (!r.stdout.trim()) throw new Error(`claude -p produced no output: ${r.stderr.slice(0, 500)}`);
  const out = JSON.parse(r.stdout);
  const uses = transcript(out.session_id).flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : [])).filter((c) => c.type === "tool_use");
  const cmds = uses.map((u) => u.input?.command).filter(Boolean).map((c) => c.replace(/^cd [^&]+&&\s*/, "").trim());
  const repeats = cmds.length - new Set(cmds).size;
  const u = out.usage ?? {};
  return {
    plugin: withPlugin,
    found: EXPECT.filter((re) => re.test(out.result ?? "")).length,
    turns: out.num_turns,
    cost: out.total_cost_usd,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    toolCalls: uses.length,
    entropyExec: uses.filter((x) => x.name.endsWith("entropy_exec")).length,
    slices: uses.filter((x) => x.name.endsWith("entropy_read_slice")).length,
    repeatedCommands: repeats,
  };
}

const rows = [];
for (let i = 0; i < RUNS; i++) for (const p of [false, true]) {
  const row = runOnce(p);
  rows.push(row);
  console.log(JSON.stringify(row));
}
const avg = (p, k) => {
  const xs = rows.filter((r) => r.plugin === p).map((r) => Number(r[k] ?? 0));
  return (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(k === "cost" ? 4 : 1);
};
console.log(`\n${"metric".padEnd(18)}${"without".padStart(10)}${"with".padStart(10)}`);
for (const k of ["found", "turns", "cost", "inputTokens", "outputTokens", "toolCalls", "entropyExec", "slices", "repeatedCommands"]) {
  console.log(`${k.padEnd(18)}${avg(false, k).padStart(10)}${avg(true, k).padStart(10)}`);
}
console.log(`\nfound = planted facts in the answer (of ${EXPECT.length}). A regression is: found drops, or slices/repeatedCommands rise enough to cancel the token savings.`);
