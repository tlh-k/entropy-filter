/** The rules block written into each client's instruction file by `init`. */
export const MARK_START = "<!-- entropy-filter:start -->";
export const MARK_END = "<!-- entropy-filter:end -->";

export const RULES_BLOCK = `## entropy-filter: long command output

**Run every test, build, lint, type-check and package-install command through the \`entropy_exec\` MCP tool, never through a plain shell.** This includes \`npm test\`, \`pytest\`, \`cargo build\`, \`go test\`, \`mvn\`, \`gradle\`, \`tsc\`, \`eslint\`, \`npm install\` and anything else that can print more than a screen. \`entropy_exec\` returns the exit code and a Digest: errors, stack traces, failing assertions and summaries kept in original order, repeated boilerplate folded into \`⟪L<a>-<b> ×<n> "<template>"⟫\` Elisions. It does this for failing commands too, which a plain shell cannot.

- The Digest is the real output with repetition removed; it is not a summary. Lines shown are verbatim.
- If you need an omitted range, call \`entropy_read_slice(capture_id, start_line, end_line)\` with the id from the Digest header and the numbers from the Elision. **Do not re-run the command to see more.**
- Short output (≤30 lines) comes back unchanged.
- Use a plain shell for commands whose output is the content you asked for: \`git diff\`, \`cat\`, \`head\`, \`sed -n\`, \`jq\`.
`;
