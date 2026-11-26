# Copilot gets the hook, Antigravity gets MCP and rules only

Each client's post-tool hook was checked against its own docs (2026-11-27):

| Client | Post-tool hook sees the output? | Can it replace it? | What we ship |
| --- | --- | --- | --- |
| Claude Code | yes (`tool_response`) | yes, `updatedToolOutput`, but not after a non-zero exit (ADR-0003) | plugin: hook + MCP + skill |
| Copilot CLI | yes (`toolResult.textResultForLlm`, stdout and stderr merged) | yes, `{ modifiedResult: { resultType: "success", textResultForLlm } }`, and failed shell commands are still "success" results | `~/.copilot/hooks/entropy-filter.json` + MCP + `.github/copilot-instructions.md` |
| VS Code Copilot agent | shares the Copilot hook files and harness | not stated on its own page | same files; MCP via `.vscode/mcp.json` |
| Antigravity | no: PostToolUse input has `toolCall` and `stepIdx` but no result | no, it must return `{}` | plugin: MCP + rules + skill, no hook |

We do not wrap Antigravity's `run_command` in a PreToolUse rewrite to get the output: that is the command-rewriting path ADR-0003 rejected, and forum reports say its PostToolUse hooks do not reliably fire in the IDE anyway. On Antigravity the rules and skill steer test, build and lint commands to `entropy_exec`.

## Consequences

- Copilot is the one client where failing test output is filtered automatically, because its shell tool reports non-zero exits as successful results with an exit-code line, which the Digest keeps in its tail.
- The Copilot hook is verified against the documented schema and unit tests only, not in a live Copilot session; the VS Code agent's handling of `modifiedResult` is unconfirmed.
- `init --client copilot` copies the bundle to `~/.entropy-filter/bin/` so the per-call hook starts without npx; project files (`.vscode/mcp.json`) keep the portable npx command.
