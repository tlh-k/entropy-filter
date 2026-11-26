// Payload shapes below are copied from a real Claude Code 2.1.330 run (see ADR-0003).
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/hook.js";

const longLog = (n = 600, inject = "Error: database connection refused") => {
  const l = Array.from({ length: n }, (_, i) => `INFO request ${i} served in ${i % 13} ms`);
  l.splice(Math.floor(n / 2), 0, inject);
  return l.join("\n") + "\n";
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ef-hook-"));
  return { root, env: { ENTROPY_FILTER_ROOT: root } as NodeJS.ProcessEnv };
}

const bashEvent = (command: string, stdout: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  cwd: "/tmp",
  tool_input: { command, description: "run" },
  tool_response: { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false, ...extra },
});

type Out = { hookSpecificOutput: { hookEventName: string; updatedToolOutput: Record<string, unknown> } };

describe("PostToolUse Bash", () => {
  it("replaces long stdout with a Digest and keeps the other fields", () => {
    const { root, env } = setup();
    const out = runHook(bashEvent("npm run build", longLog(), { returnCodeInterpretation: "x" }), env) as Out;
    const r = out.hookSpecificOutput.updatedToolOutput;
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(r.stdout).toMatch(/^\[entropy-filter [0-9a-f]{6} · stdout · 601→\d+ lines/);
    expect(r.stdout).toContain("Error: database connection refused");
    expect(r.returnCodeInterpretation).toBe("x");
    expect(r.interrupted).toBe(false);
    expect(readdirSync(join(root, ".entropy-filter", "captures")).filter((f) => f.endsWith(".log"))).toHaveLength(1);
  });

  it("leaves short output alone", () => {
    const { env } = setup();
    expect(runHook(bashEvent("echo hi", "hi\n"), env)).toBeUndefined();
  });

  it("reads the full text from persistedOutputPath when Claude Code truncated stdout", () => {
    const { root, env } = setup();
    const full = longLog(3000, "FATAL: the needle near the end");
    const path = join(root, "persisted.txt");
    writeFileSync(path, full);
    const truncated = full.slice(0, 30000);
    expect(truncated).not.toContain("needle");
    const out = runHook(bashEvent("make", truncated, { persistedOutputPath: path, persistedOutputSize: full.length }), env) as Out;
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toContain("FATAL: the needle near the end");
  });

  it("shares one ceiling between stderr and stdout, stderr first", () => {
    const { env } = setup();
    const ev = bashEvent("cargo build", longLog(3000));
    (ev.tool_response as Record<string, unknown>).stderr = longLog(3000, "error[E0308]: mismatched types");
    const r = (runHook(ev, env) as Out).hookSpecificOutput.updatedToolOutput;
    expect(String(r.stderr)).toContain("error[E0308]");
    expect(String(r.stderr).length + String(r.stdout).length).toBeLessThanOrEqual(8000 + 1000);
  });

  it.each([
    ["git diff HEAD~3", {}],
    ["cd web && cat build.log", {}],
    ["npm test 2>&1 | tail -80", {}],
    ["npm test", { interrupted: true }],
    ["npm test", { backgroundTaskId: "b1" }],
  ])("passes through %s %j", (command, extra) => {
    const { env } = setup();
    expect(runHook(bashEvent(command, longLog(), extra), env)).toBeUndefined();
  });

  it("does nothing for PostToolUseFailure (Claude Code ignores replacements there)", () => {
    const { env } = setup();
    const ev = { hook_event_name: "PostToolUseFailure", tool_name: "Bash", cwd: "/tmp", tool_input: { command: "npm test" }, error: "Exit code 1\n" + longLog() };
    expect(runHook(ev, env)).toBeUndefined();
  });

  it("is switched off by ENTROPY_FILTER=off", () => {
    const { env } = setup();
    expect(runHook(bashEvent("make", longLog()), { ...env, ENTROPY_FILTER: "off" })).toBeUndefined();
  });

  it("honours passthroughCommands from config.json", () => {
    const { root, env } = setup();
    const dir = join(root, ".entropy-filter");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ passthroughCommands: ["terraform plan"] }));
    expect(runHook(bashEvent("terraform plan -out x", longLog()), env)).toBeUndefined();
  });
});

const readEvent = (filePath: string, content: string, input: Record<string, unknown> = {}) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  cwd: "/tmp",
  tool_input: { file_path: filePath, ...input },
  tool_response: { type: "text", file: { filePath, content, numLines: content.split("\n").length, startLine: 1, totalLines: content.split("\n").length } },
});

describe("PostToolUse Read", () => {
  it("digests a long .log file and points Elisions at real file lines", () => {
    const { root, env } = setup();
    const path = join(root, "app.log");
    const content = longLog();
    writeFileSync(path, content);
    const r = (runHook(readEvent(path, content), env) as Out).hookSpecificOutput.updatedToolOutput as { file: { content: string; numLines: number } };
    expect(r.file.content).toContain("Error: database connection refused");
    expect(r.file.content).toMatch(/Read\(file_path, offset=<start>, limit=<count>\)/);
    expect(r.file.content).toMatch(/⟪L1-\d+ ×\d+/);
    expect(r.file.numLines).toBe(r.file.content.split("\n").length);
  });

  it("passes a targeted read (offset/limit) through, so opening an Elision cannot loop", () => {
    const { env } = setup();
    expect(runHook(readEvent("/x/app.log", longLog(), { offset: 300, limit: 50 }), env)).toBeUndefined();
  });

  it("never touches source code, however repetitive", () => {
    const { env } = setup();
    expect(runHook(readEvent("/x/generated.ts", longLog()), env)).toBeUndefined();
  });

  it("digests an extension-less file only when it looks like a log", () => {
    const { env } = setup();
    expect(runHook(readEvent("/x/output", longLog()), env)).toBeDefined();
    const vocab = "river stone quiet ledger amber north window circuit garden thunder copper velvet orbit harbor maple signal".split(" ");
    let seed = 7;
    const word = () => vocab[(seed = (seed * 48271) % 2147483647) % vocab.length];
    const prose = Array.from({ length: 200 }, () => Array.from({ length: 8 }, word).join(" ")).join("\n");
    expect(runHook(readEvent("/x/NOTES", prose), env)).toBeUndefined();
  });
});
