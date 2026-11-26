// Runs against dist/entropy-filter.mjs; `npm run build` first.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BUNDLE = resolve(import.meta.dirname, "../../dist/entropy-filter.mjs");
const root = () => mkdtempSync(join(tmpdir(), "ef-e2e-"));

function hook(input: unknown, env: Record<string, string>) {
  return spawnSync(process.execPath, [BUNDLE, "hook", "post-tool-use"], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, ...env }, encoding: "utf8" });
}

const long = Array.from({ length: 800 }, (_, i) => `ok ${i} - handler ${i % 17} responded`).concat(["not ok 801 - refund rounds down", "# fail 1"]).join("\n");

describe("hook (bundle)", () => {
  it("prints a PostToolUse reply for long Bash output", () => {
    const r = hook({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: "/", tool_input: { command: "npm test" }, tool_response: { stdout: long, stderr: "", interrupted: false, isImage: false } }, { ENTROPY_FILTER_ROOT: root() });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toContain("not ok 801 - refund rounds down");
  });

  it("speaks Copilot's protocol with --client copilot", () => {
    const r = spawnSync(process.execPath, [BUNDLE, "hook", "post-tool-use", "--client", "copilot"], {
      input: JSON.stringify({ cwd: "/", toolName: "bash", toolArgs: '{"command":"npm test"}', toolResult: { resultType: "success", textResultForLlm: long + "\n<exited with exit code 1>" } }),
      env: { ...process.env, ENTROPY_FILTER_ROOT: root() },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.modifiedResult.resultType).toBe("success");
    expect(out.modifiedResult.textResultForLlm).toContain("not ok 801 - refund rounds down");
  });

  it.each([["garbage", "{not json"], ["empty", ""], ["array", "[1,2]"]])("fails open on %s input", (_, input) => {
    const r = hook(input, { ENTROPY_FILTER_ROOT: root() });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("fails open when the store cannot be written", () => {
    const r = hook({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: "/", tool_input: { command: "npm test" }, tool_response: { stdout: long, stderr: "" } }, { ENTROPY_FILTER_ROOT: "/dev/null/nope" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("answers within the hook timeout on a large log", () => {
    const big = Array.from({ length: 200_000 }, (_, i) => `2026-11-27 10:00:00.${i % 1000} INFO worker-${i % 8} processed item ${i}`).join("\n");
    const t = Date.now();
    const r = hook({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: "/", tool_input: { command: "x" }, tool_response: { stdout: big, stderr: "" } }, { ENTROPY_FILTER_ROOT: root() });
    expect(r.status).toBe(0);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput.stdout.length).toBeLessThanOrEqual(8000);
  });
});

describe("MCP server (bundle)", () => {
  it("exposes exactly entropy_exec and entropy_read_slice, and they work together", async () => {
    const dir = root();
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE, "serve"], cwd: dir, env: { ...(process.env as Record<string, string>), ENTROPY_FILTER_ROOT: dir } }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["entropy_exec", "entropy_read_slice"]);
      expect(tools.find((t) => t.name === "entropy_read_slice")!.annotations?.readOnlyHint).toBe(true);

      const cmd = `for i in $(seq 1 600); do echo "PASS suite $i"; done; echo "FAIL suite 601: expected 3 got 4" 1>&2; exit 3`;
      const r = (await client.callTool({ name: "entropy_exec", arguments: { command: cmd } })) as { content: { text: string }[] };
      const text = r.content[0]!.text;
      expect(text).toMatch(/^\[exit 3 · /);
      expect(text).toContain("FAIL suite 601: expected 3 got 4");
      const id = /\[entropy-filter ([0-9a-f]{6}) · stdout/.exec(text)![1]!;
      const m = /⟪L(\d+)-(\d+) ×/.exec(text)!;

      const s = (await client.callTool({ name: "entropy_read_slice", arguments: { capture_id: id, start_line: Number(m[1]), end_line: Number(m[1]) + 2 } })) as { content: { text: string }[] };
      expect(s.content[0]!.text).toContain(`${m[1]}\tPASS suite ${m[1]}`);
    } finally {
      await client.close();
    }
  });
});

describe("CLI (bundle)", () => {
  it("exec returns the command's exit code", () => {
    const r = spawnSync(process.execPath, [BUNDLE, "exec", "--", "echo hi; exit 4"], { env: { ...process.env, ENTROPY_FILTER_ROOT: root() }, encoding: "utf8" });
    expect(r.status).toBe(4);
    expect(r.stdout).toContain("[exit 4");
  });

  it("filter passes short input through unchanged", () => {
    expect(execFileSync(process.execPath, [BUNDLE, "filter"], { input: "a\nb\n", env: { ...process.env, ENTROPY_FILTER_ROOT: root() }, encoding: "utf8" })).toBe("a\nb\n");
  });
});
