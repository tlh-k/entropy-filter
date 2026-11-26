# In Claude Code, replace tool output after it runs; never rewrite the command

Claude Code offers two hook points: a PreToolUse hook can rewrite `npm test` into `entropy-filter exec -- npm test` (the RTK approach), and a PostToolUse hook can swap the finished result for a Digest via `hookSpecificOutput.updatedToolOutput`. We use only the PostToolUse path. Rewriting commands breaks on pipes, `cd &&` chains, heredocs, exports and interactive programs, can be denied by the auto-mode classifier because it reviewed the original command, and cannot reach the Read tool at all. Replacing output leaves the command untouched and works the same way for Bash and Read.

## Consequences

- The command still produces its full output and telemetry still sees it; only the agent's view shrinks.
- `entropy_exec` exists for clients without such a hook (Cursor, Cline, Codex), not for Claude Code.
- Verified on Claude Code 2.1.330: a Bash call that exits non-zero fires `PostToolUseFailure`, whose `updatedToolOutput` is ignored. Failing test and build output therefore cannot be shrunk by the hook. We accept this rather than masking exit codes with a PreToolUse wrapper (which would bring back every risk above and hide failures from Claude Code's own error tracking); the skill and client rules instead steer test, build and lint commands to `entropy_exec`, which returns a Digest plus the exit code whether or not the command failed. An opt-in wrapper may be reconsidered once live A/B data exists.
- Bash output over 30,000 characters reaches the hook already truncated, with the full text in `tool_response.persistedOutputPath`; the Capture is read from that file.
- A Read call carrying `offset` or `limit` is a targeted read, usually opening an Elision, and is passed through untouched; filtering it again could hand back the same Elision and trap the agent in a loop.
