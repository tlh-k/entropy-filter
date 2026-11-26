# entropy-filter

> Türkçe: [README.tr.md](README.tr.md)

Coding agents read a lot of build logs, test runs and install output, and most of it is repeated boilerplate. **entropy-filter** replaces long output with a **Digest**. Errors, stack traces, failing assertions and summaries are kept verbatim and in their original order. Repeated lines are folded into one-line **Elisions** that say what was there and where. The raw output stays on your disk, so the agent can open any omitted range without re-running the command.

```
$ entropy-filter exec -- ./run-tests.sh
[exit 1 · 0.0s]
[entropy-filter 8239e9 · stdout · 606→13 lines · omitted ranges: entropy_read_slice(capture_id, start_line, end_line)]
⟪L1-297 ×297 "PASS <path> (<n> ms)"⟫
PASS src/mod298.test.ts (21 ms)
PASS src/mod299.test.ts (22 ms)
PASS src/mod300.test.ts (23 ms)
FAIL src/billing/invoice.test.ts
  ● Invoice › applies KDV
    Expected: 120
    Received: 100
      at Object.<anonymous> (src/billing/invoice.test.ts:42:23)
⟪L306-601 ×296 "PASS <path> (<n> ms)"⟫
PASS src/mod597.test.ts (40 ms)
PASS src/mod598.test.ts (41 ms)
PASS src/mod599.test.ts (42 ms)
PASS src/mod600.test.ts (3 ms)
Tests: 1 failed, 599 passed, 600 total
```

It runs on the CPU in milliseconds. It needs no model, no GPU and no network port. It works the same on Turkish, English and mixed logs.

## Why not just keep the first and last N lines?

Because the line that matters is often in the middle. Fixed head/tail truncation drops it, and the agent then guesses or re-runs. Re-running costs more than the truncation saved. entropy-filter decides line by line:

- **Signal Lines** are always kept: `error`, `FAIL`, `Exception`, `Traceback`, `panic`, `exit code N`, … and the Turkish `HATA`, `İstisna`, `Başarısız`, `Çöktü`, `Zaman aşımı`, `bulunamadı`, …. Each keeps a few neighbouring lines (its **Halo**) and the stack trace that follows it.
- **Novelty**: every line is reduced to a **Template**, with numbers, paths, ids and timestamps replaced by placeholders. A Template seen 400 times carries almost no information, while a one-off line carries a lot. This is the Shannon self-information `-log2(p)` of the Template.
- The last 5 lines are always kept, because that is where test summaries live.
- Everything fits a **Budget**: 25% of the raw size, never more than 8,000 characters.

Details: [docs/SPEC.md](docs/SPEC.md) · terms: [docs/GLOSSARY.md](docs/GLOSSARY.md) · decisions: [docs/adr/](docs/adr/).

## Install

### Claude Code (plugin: hook + MCP tools + skill)

```
/plugin marketplace add tlh-k/entropy-filter
/plugin install entropy-filter@entropy-filter
```

- A **PostToolUse hook** shrinks long successful `Bash` output and long log files opened with `Read`. Source code is never filtered. A `Read` with `offset`/`limit` is never filtered either.
- **MCP tools**: `entropy_exec` runs a command and returns `[exit N]` plus a Digest; `entropy_read_slice` returns raw lines of a stored output.
- A **skill** tells the agent to run tests, builds and linters through `entropy_exec`. This matters because Claude Code does not let hooks change the output of a command that **exits non-zero** ([ADR-0003](docs/adr/0003-replace-output-after-the-fact.md)).

### GitHub Copilot (CLI + VS Code agent: hook + MCP + instructions)

```bash
npx -y github:tlh-k/entropy-filter init --client copilot
```

This copies the bundle to `~/.entropy-filter/bin/`. It adds the MCP server to `~/.copilot/mcp-config.json` and `.vscode/mcp.json`, installs a `postToolUse` hook in `~/.copilot/hooks/entropy-filter.json`, and adds the rules to `.github/copilot-instructions.md`. Copilot's hook can replace shell results, **including commands that exit non-zero**, so failing test runs are filtered automatically. This is checked against Copilot's documented hook schema, not yet in a live Copilot session. VS Code's agent hooks are in preview.

### Antigravity (plugin: MCP + rules + skill)

```bash
npx -y github:tlh-k/entropy-filter init --client antigravity
```

This installs the plugin into `~/.gemini/config/plugins/entropy-filter/`; restart Antigravity afterwards. Antigravity's PostToolUse hook never sees a tool's output, so filtering there happens only when the agent runs commands through `entropy_exec`, which the rules tell it to do ([ADR-0004](docs/adr/0004-copilot-and-antigravity.md)).

### Cursor, Cline, Codex (MCP + rules)

```bash
npx -y github:tlh-k/entropy-filter init --client cursor   # .cursor/mcp.json + .cursor/rules/entropy-filter.mdc
```

```bash
npx -y github:tlh-k/entropy-filter init --client cline    # .clinerules/entropy-filter.md + server JSON to paste
```

```bash
npx -y github:tlh-k/entropy-filter init --client codex    # ~/.codex/config.toml + AGENTS.md block
```

### CLI

```bash
entropy-filter exec -- npm test            # exit status + Digest, exits with the command's code
entropy-filter filter build.log            # Digest of a file (or stdin)
entropy-filter slice c7f2a1 300 340        # raw lines of a stored output
entropy-filter stats                       # digests, pass-throughs, slices read
```

## Storage and privacy

- Raw outputs (**Captures**) are written to `.entropy-filter/captures/` in the project root. That folder ignores itself in git.
- Captures are kept across sessions, so Elisions stay valid after `--resume` and compaction. The oldest are removed once the project holds more than 200 Captures or 100 MB. A single Capture is capped at 16 MB.
- Nothing leaves your machine. There is no HTTP server, only stdio and local files.
- `.entropy-filter/stats.jsonl` counts digests, pass-throughs and slice reads. Use it to see whether the agent has to go back for omitted lines.

## Configuration

Configuration is optional. Settings go in `.entropy-filter/config.json`:

```json
{ "passthroughCommands": ["terraform plan"], "budgetRatio": 0.25, "maxDigestChars": 8000, "halo": 3, "shortLines": 30 }
```

- Output of 30 lines or fewer, and 8,000 characters or fewer, is never touched.
- `git diff`, `git show`, `git log -p`, `cat`, `head`, `tail`, `sed -n`, `jq` and `less` are never filtered: their output is the content you asked for.
- `ENTROPY_FILTER=off` turns everything off.

## Measuring it

- `npm test` includes the **recall gate**. It covers 12 fixtures: jest, pytest, cargo, tsc, gradle, npm with ANSI colours, a container build with progress bars, go panic, vitest, a Turkish ERP log, mixed TR/EN and short clean output. Every planted failure line must survive verbatim in the Digest, or the build fails. Today Digests are 1.3–19.5% of the raw size.
- `entropy-filter replay --days 30` replays your past Claude Code sessions through the filter, with no model calls, and shows how much it would have saved and why it stayed out of the way elsewhere. On the author's last 30 days it shrank **7.5%** of all Bash and Read output. Most long output was already cut by the agent itself (`| head`, `| tail`, 21%) or was file content (`cat`, `sed -n`, `git diff`, 57%). Expect a modest saving, concentrated in sessions that run long builds and tests unpiped.
- `node bench/ab/run.mjs --repo <your repo> --scenarios <dir>` runs a real-project A/B/C benchmark with three arms: plugin off, on, and on plus a one-line `CLAUDE.md` hint to use `entropy_exec`. Each run gets a fresh git worktree and the arms are shuffled. It reads the context characters each run consumed, whether the filter fired, retrievals (`entropy_read_slice` plus targeted `Read`) and re-runs from the transcript. Scenarios are JSON files that stay in your project. `node bench/ab/report.mjs results-ab.json` prints medians with bootstrap 95% CIs.
- `node bench/live-ab.mjs --runs 5` runs the same task through `claude -p` with and without the plugin. It compares tokens, cost, turns, slice reads and repeated commands. First single run with `claude-haiku-5-5`: 5/5 facts found in both runs, cost $0.0135 without the plugin and $0.0070 with it. One run is not a result; repeat it before trusting it.

## Development

```bash
npm install
npm run check      # typecheck + unit tests + recall gate + build + e2e on the bundle
```

`dist/` is committed so that `npx github:tlh-k/entropy-filter` works without a build step. CI fails if it is stale.

## License

MIT
