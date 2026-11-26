---
name: entropy-filter
description: Run tests, builds, linters, type-checks and package installs through the entropy_exec MCP tool, and read Digests and Elisions (⟪L45-88 ×44 "…"⟫) correctly. Use whenever you are about to run a command that can print more than a screen, when a tool result starts with "[entropy-filter", or when you need lines a Digest omitted.
---

# entropy-filter

Long command output reaches you as a **Digest**: the real lines that carry information (errors, stack traces, failing assertions, summaries), verbatim and in original order, with repeated boilerplate folded into **Elisions** such as `⟪L45-88 ×44 "PASS <path> (<n> ms)"⟫` — lines 45 to 88, 44 lines, mostly of that shape.

## Run test, build and lint commands with `entropy_exec`

**Use the `entropy_exec` MCP tool, not Bash, for every test, build, lint, type-check and install command** (`npm test`, `pytest`, `cargo build`, `go test`, `mvn`, `gradle`, `tsc`, `eslint`, `npm install`, `docker build`, …).

Why: when a command fails, Claude Code cannot shrink its Bash output, so a failing test run lands in your context in full. `entropy_exec` returns `[exit N · 12.4s]` plus a Digest whether the command passed or failed.

Use plain Bash for commands whose output *is* the content you want: `git diff`, `git show`, `cat`, `head`, `tail`, `sed -n`, `jq`. Those are never filtered.

## Reading a Digest

- Header `[entropy-filter c7f2a1 · stdout · 3000→112 lines · …]`: `c7f2a1` is the Capture id; the raw output is stored locally.
- Lines shown are exact. Nothing was paraphrased.
- An Elision tells you what was there. Usually that is enough: 300 lines of `PASS <path>` need no reading.

## When you need omitted lines

Call `entropy_read_slice(capture_id, start_line, end_line)` with the numbers from the Elision (max 400 lines per call). **Do not re-run the command to see more** — that costs the full output again and may give different results.

For a log *file* you Read, the header names the file instead of a Capture; open an omitted range with `Read(file_path, offset=<start>, limit=<count>)`. Targeted reads are never filtered.

If a slice says the Capture was evicted, re-run the command.

## Turning it off

`ENTROPY_FILTER=off` in the environment disables all filtering. Extra pass-through commands go in `.entropy-filter/config.json` under `passthroughCommands`.
