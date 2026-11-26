import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveRoot } from "./store.js";
import { MAX_SLICE_LINES, TOOL_DESCRIPTIONS, callExec, callSlice } from "./tools.js";
import { VERSION } from "./version.js";

function isGitWorktree(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** stdio MCP server. The tool surface is fixed for the whole session (prompt-cache stability). */
export async function serve(): Promise<void> {
  const server = new McpServer({ name: "entropy-filter", version: VERSION });
  // Workspace: the process cwd, or the client's first MCP root when cwd is not a project
  // (IDE clients may start servers outside the workspace).
  let workspace: Promise<string> | undefined;
  const resolveWorkspace = async (): Promise<string> => {
    const cwd = process.cwd();
    if (process.env.ENTROPY_FILTER_ROOT || isGitWorktree(cwd) || !server.server.getClientCapabilities()?.roots) return cwd;
    try {
      const { roots } = await server.server.listRoots();
      const first = roots.find((r) => r.uri.startsWith("file://"));
      return first ? fileURLToPath(first.uri) : cwd;
    } catch {
      return cwd;
    }
  };
  const ws = async () => {
    workspace ??= resolveWorkspace();
    const dir = await workspace;
    return { dir, root: resolveRoot(dir) };
  };
  const text = (r: { text: string; isError: boolean }) => ({ content: [{ type: "text" as const, text: r.text }], isError: r.isError });

  server.registerTool(
    "entropy_exec",
    {
      description: TOOL_DESCRIPTIONS.entropy_exec,
      inputSchema: {
        command: z.string().min(1).describe("Shell command, run with /bin/sh -c"),
        cwd: z.string().optional().describe("Working directory (default: the workspace root)"),
        timeout_ms: z.number().int().min(1000).max(3_600_000).optional().describe("Default 600000"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const { dir, root } = await ws();
      return text(await callExec(args, dir, root));
    },
  );

  server.registerTool(
    "entropy_read_slice",
    {
      description: TOOL_DESCRIPTIONS.entropy_read_slice,
      inputSchema: {
        capture_id: z.string().describe("6-hex id from the Digest header, e.g. c7f2a1"),
        start_line: z.number().int().min(1),
        end_line: z.number().int().min(1).describe(`At most ${MAX_SLICE_LINES} lines after start_line`),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => text(callSlice(args, (await ws()).root)),
  );

  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    workspace = undefined;
  });

  await server.connect(new StdioServerTransport());
}
