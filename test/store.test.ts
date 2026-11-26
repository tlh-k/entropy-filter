import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPassthrough, loadConfig, DEFAULTS } from "../src/config.js";
import { init, upsertBlock } from "../src/init.js";
import { Store } from "../src/store.js";
import { callSlice } from "../src/tools.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("Store", () => {
  it("writes a Capture with a self-ignoring directory", () => {
    const root = tmp("ef-store-");
    const meta = new Store(root).write("a\nb\nc\n", "stdout", "make");
    expect(meta.id).toMatch(/^[0-9a-f]{6}$/);
    expect(meta.lines).toBe(3);
    expect(readFileSync(join(root, ".entropy-filter", "captures", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("evicts oldest first by count and by bytes", () => {
    const root = tmp("ef-evict-");
    const s = new Store(root, { maxCaptures: 3, maxTotalBytes: 1e9, maxCaptureBytes: 1e9 });
    const ids = [0, 1, 2, 3, 4].map((i) => {
      const id = s.write(`capture ${i}\n`, "stdout").id;
      const t = new Date(Date.now() - (10 - i) * 1000);
      utimesSync(join(s.capturesDir, `${id}.log`), t, t);
      return id;
    });
    s.evict();
    const left = readdirSync(s.capturesDir).filter((f) => f.endsWith(".log")).map((f) => f.slice(0, 6));
    expect(left.sort()).toEqual(ids.slice(2).sort());
    expect(existsSync(join(s.capturesDir, `${ids[0]}.json`))).toBe(false);

    const b = new Store(tmp("ef-bytes-"), { maxCaptures: 100, maxTotalBytes: 25, maxCaptureBytes: 1e9 });
    for (let i = 0; i < 5; i++) b.write("0123456789\n", "stdout");
    expect(readdirSync(b.capturesDir).filter((f) => f.endsWith(".log"))).toHaveLength(2);
  });

  it("caps a single Capture and flags it", () => {
    const s = new Store(tmp("ef-cap-"), { maxCaptures: 10, maxTotalBytes: 1e9, maxCaptureBytes: 100 });
    const m = s.write("x".repeat(1000), "stdout");
    expect(m.truncated).toBe(true);
    expect(m.bytes).toBe(100);
  });
});

describe("entropy_read_slice", () => {
  it("returns raw numbered lines and reports re-retrieval in stats", () => {
    const root = tmp("ef-slice-");
    const s = new Store(root);
    const id = s.write(Array.from({ length: 50 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m`).join("\n") + "\n", "stdout").id;
    const r = callSlice({ capture_id: id, start_line: 10, end_line: 12 }, root);
    expect(r.isError).toBe(false);
    expect(r.text).toBe(`[${id} L10-12 of 50]\n10\t\x1b[32mline 10\x1b[0m\n11\t\x1b[32mline 11\x1b[0m\n12\t\x1b[32mline 12\x1b[0m`);
    expect(s.readStats().filter((x) => x.kind === "slice")).toHaveLength(1);
  });

  it("says plainly when a Capture was evicted", () => {
    const r = callSlice({ capture_id: "abcdef", start_line: 1, end_line: 5 }, tmp("ef-gone-"));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/evicted by rotation.*re-run the command/);
  });

  it("caps a slice at 400 lines and says where to continue", () => {
    const root = tmp("ef-big-");
    const id = new Store(root).write(Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n"), "stdout").id;
    const r = callSlice({ capture_id: id, start_line: 1, end_line: 1000 }, root);
    expect(r.text.split("\n")).toHaveLength(401);
    expect(r.text).toMatch(/continue from 401/);
  });
});

describe("config", () => {
  it("falls back to defaults on a broken file", () => {
    const root = tmp("ef-cfg-");
    require("node:fs").mkdirSync(join(root, ".entropy-filter"));
    require("node:fs").writeFileSync(join(root, ".entropy-filter", "config.json"), "{nope");
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it.each([
    ["git diff", true],
    ["git -C web diff --stat", true],
    ["git log -p -3", true],
    ["git log --oneline", false],
    ["LANG=C sudo cat /var/log/syslog", true],
    ["/usr/bin/head -50 x", true],
    ["sed -i s/a/b/ x", false],
    ["npm test", false],
    ["npm test | jq .", true],
  ])("isPassthrough(%j) = %s", (cmd, want) => expect(isPassthrough(cmd)).toBe(want));
});

describe("init", () => {
  it("writes Cursor MCP config and rules, keeping other servers", () => {
    const p = tmp("ef-init-");
    require("node:fs").mkdirSync(join(p, ".cursor"));
    require("node:fs").writeFileSync(join(p, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    init({ client: "cursor", projectDir: p, homeDir: p });
    const cfg = JSON.parse(readFileSync(join(p, ".cursor", "mcp.json"), "utf8"));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["entropy-filter", "other"]);
    expect(readFileSync(join(p, ".cursor", "rules", "entropy-filter.mdc"), "utf8")).toContain("entropy_exec");
  });

  it("adds the Codex server once and upserts AGENTS.md", () => {
    const p = tmp("ef-codex-");
    init({ client: "codex", projectDir: p, homeDir: p });
    init({ client: "codex", projectDir: p, homeDir: p });
    const toml = readFileSync(join(p, ".codex", "config.toml"), "utf8");
    expect(toml.match(/\[mcp_servers\.entropy-filter\]/g)).toHaveLength(1);
    const agents = readFileSync(join(p, "AGENTS.md"), "utf8");
    expect(agents.match(/entropy-filter:start/g)).toHaveLength(1);
  });

  it("upsertBlock replaces in place", () => {
    const a = upsertBlock("# Mine\n", "one");
    const b = upsertBlock(a + "\ntrailing\n", "two");
    expect(b).toContain("two");
    expect(b).not.toContain("one");
    expect(b).toContain("trailing");
  });
});
