#!/usr/bin/env node
// A/B/C benchmark runner for entropy-filter on a real repository (docs/SPEC.md §8, ADR-less: a tool).
//
//   node bench/ab/run.mjs --repo <git repo> --scenarios <dir> --out <results.json>
//        [--runs 5] [--arms off,on,on+hint] [--model claude-sonnet-5-5] [--budget 20] [--only s1,s3]
//
// Scenario files (<dir>/*.json) are project-specific and stay in that project:
//   { id, title, patch?, preRun?, prompt, check: { type: "tests" } | { type: "answer", patterns: [...], noChanges? } }
//
// Each run: fresh detached worktree from HEAD → patch + commit → (on+hint: CLAUDE.md line + commit)
// → preRun → `claude -p` → check → transcript metrics. Arms are shuffled per repetition.
// Results are saved after every run; re-running skips finished ids. Stops at the budget.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { transcriptMetrics } from "./metrics.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const REPO = resolve(opt("--repo", "."));
const SCEN = resolve(opt("--scenarios", join(REPO, "bench", "scenarios")));
const OUT = resolve(opt("--out", join(REPO, "bench", "results-ab.json")));
const RUNS = Number(opt("--runs", "5"));
const ARMS = opt("--arms", "off,on,on+hint").split(",");
const MODEL = opt("--model", "claude-sonnet-5-5");
const BUDGET = Number(opt("--budget", "20"));
const ONLY = opt("--only", "").split(",").filter(Boolean);
const WORK = join(dirname(OUT), "ab-work");

export const HINT =
  "\n\n## Komut çıktıları\nBu projede `mvn` gibi test/derleme komutlarını Bash yerine `entropy_exec` MCP aracıyla çalıştır; " +
  "çıktıyı `| grep`, `| tail`, `| head` ile kısaltma (Digest hataları ve özeti zaten korur). " +
  "Digest'te atlanan satırlar gerekirse `entropy_read_slice` kullan, komutu yeniden çalıştırma.\n";

const ALLOWED = [
  "Read", "Edit", "Write", "Glob", "Grep",
  "Bash(mvn:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(git:*)",
  "Bash(sed -n:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)",
  "mcp__plugin_entropy-filter_entropy-filter__entropy_exec",
  "mcp__plugin_entropy-filter_entropy-filter__entropy_read_slice",
];

const sh = (cmd, cwd, extra = {}) => spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", maxBuffer: 64 << 20, ...extra });
const git = (a, cwd) => spawnSync("git", a, { cwd, encoding: "utf8" });
const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what}: ${r.stderr || r.stdout}`);
  return r;
};

// Deterministic shuffle so a rerun of the same plan keeps the same order.
function shuffle(xs, seed) {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function worktree(rid, scen, arm) {
  const wt = join(WORK, "wt", rid);
  if (existsSync(wt)) git(["worktree", "remove", "--force", wt], REPO);
  mkdirSync(dirname(wt), { recursive: true });
  must(git(["worktree", "add", "-q", "--detach", wt, "HEAD"], REPO), "worktree add");
  const commit = (msg) => must(git(["-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-qam", msg, "--no-verify"], wt), "commit");
  if (scen.patch) {
    must(git(["apply", join(SCEN, scen.patch)], wt), "apply patch");
    commit("bench: scenario setup");
  }
  if (arm === "on+hint") {
    // Committed, so `git diff HEAD` / `git status` checks see only the agent's own changes.
    appendFileSync(join(wt, "CLAUDE.md"), HINT);
    git(["add", "CLAUDE.md"], wt);
    commit("bench: entropy_exec hint");
  }
  if (scen.preRun) sh(scen.preRun, wt, { timeout: 900_000 });
  return wt;
}

function claude(prompt, cwd, arm, logFile) {
  const settings = {
    enabledPlugins: { "state-ledger@state-ledger": false, ...(arm === "off" ? { "entropy-filter@entropy-filter": false } : {}) },
  };
  const env = { ...process.env, ...(arm === "off" ? { ENTROPY_FILTER: "off" } : {}) };
  delete env.ENTROPY_FILTER_ROOT;
  const t0 = Date.now();
  const r = spawnSync(
    "claude",
    ["-p", prompt, "--model", MODEL, "--output-format", "json", "--settings", JSON.stringify(settings), "--max-turns", "80", "--permission-mode", "acceptEdits", "--allowedTools", ...ALLOWED],
    { cwd, env, encoding: "utf8", input: "", timeout: 3_600_000, maxBuffer: 64 << 20 },
  );
  writeFileSync(logFile, `${r.stdout}\n--- stderr ---\n${r.stderr}`);
  let d;
  try {
    d = JSON.parse(r.stdout);
  } catch {
    d = { is_error: true, result: String(r.stdout).slice(-2000) };
  }
  d.wall_s = Math.round((Date.now() - t0) / 100) / 10;
  return d;
}

// Untracked/changed paths the agent made, ignoring build output and the filter's own store.
const agentChanges = (wt) =>
  git(["status", "--porcelain"], wt)
    .stdout.split("\n")
    .filter((l) => l && !/\s(target\/|\.entropy-filter\/)/.test(l));

function check(scen, wt, result) {
  if (scen.check.type === "tests") {
    const green = sh("mvn -o -q test", wt, { timeout: 900_000 }).status === 0;
    const touched = git(["diff", "--name-only", "HEAD", "--", "src/test"], wt).stdout.trim() !== "";
    return { tests_green: green, test_files_untouched: !touched, pass: green && !touched };
  }
  const answer = String(result.result ?? "");
  const found = Object.fromEntries(scen.check.patterns.map((p) => [p, new RegExp(p, "i").test(answer)]));
  const clean = !scen.check.noChanges || agentChanges(wt).length === 0;
  return { ...found, no_changes: clean, pass: Object.values(found).every(Boolean) && clean };
}

function main() {
  const scenarios = readdirSync(SCEN)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SCEN, f), "utf8")))
    .filter((s) => !ONLY.length || ONLY.includes(s.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { model: MODEL, runs: [] };
  const pluginVersion = spawnSync("claude", ["plugin", "list"], { encoding: "utf8" }).stdout.match(/entropy-filter@entropy-filter\s+Version: ([\d.]+)/)?.[1];
  results.model = MODEL;
  mkdirSync(join(WORK, "logs"), { recursive: true });
  const spent = () => results.runs.reduce((s, r) => s + (r.total_cost_usd || 0), 0);

  for (let rep = 1; rep <= RUNS; rep++) {
    for (const scen of scenarios) {
      for (const arm of shuffle(ARMS, rep * 97 + scen.id.charCodeAt(1))) {
        const rid = `${scen.id}-${arm}-${rep}`;
        if (results.runs.some((r) => r.id === rid)) continue;
        if (spent() >= BUDGET) {
          console.log(`budget $${BUDGET} reached ($${spent().toFixed(2)}); stopping`);
          return;
        }
        console.log(`start ${rid}`);
        const wt = worktree(rid, scen, arm);
        const res = claude(scen.prompt, wt, arm, join(WORK, "logs", `${rid}.json`));
        const verdict = check(scen, wt, res);
        const tm = transcriptMetrics([res.session_id]);
        writeFileSync(join(WORK, "logs", `${rid}.diff`), git(["diff", "HEAD"], wt).stdout);
        const u = res.usage || {};
        results.runs.push({
          id: rid, scenario: scen.id, arm, rep, plugin_version: pluginVersion, session_id: res.session_id,
          total_cost_usd: res.total_cost_usd ?? 0, num_turns: res.num_turns ?? 0, wall_s: res.wall_s,
          input_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          output_tokens: u.output_tokens || 0,
          pass: verdict.pass, checks: verdict, is_error: !!res.is_error, ...tm,
          valid: arm === "off" ? !tm.filterFired : tm.filterFired,
        });
        writeFileSync(OUT, JSON.stringify(results, null, 2));
        const last = results.runs.at(-1);
        console.log(`done  ${rid} $${last.total_cost_usd.toFixed(3)} turns=${last.num_turns} chars=${last.toolResultChars} fired=${last.filterFired} pass=${last.pass} (total $${spent().toFixed(2)})`);
        git(["worktree", "remove", "--force", wt], REPO);
      }
    }
  }
  console.log("all runs done");
}

main();
