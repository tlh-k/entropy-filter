// The recall gate (SPEC §8): every needle of every fixture must survive verbatim in the Digest.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { filterStreams } from "../src/filter.js";
import { cleanLine } from "../src/lines.js";
import { Store } from "../src/store.js";

const dir = join(import.meta.dirname, "fixtures");
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => f.slice(0, -4));

// Per-fixture ceiling on Digest size as a share of the raw output. Default 0.5.
const MAX_RATIO: Record<string, number> = { "all-pass-vitest": 0.1, "jest-fail-middle": 0.25, "tr-erp-log": 0.1, "mixed-tr-en": 0.1, "maven-green-logged-exceptions": 0.15 };

const report: string[] = [];

describe("recall gate", () => {
  it("has a corpus", () => expect(names.length).toBeGreaterThanOrEqual(10));

  for (const name of names) {
    it(name, () => {
      const raw = readFileSync(join(dir, `${name}.txt`), "utf8");
      const needles = readFileSync(join(dir, `${name}.needles`), "utf8").split("\n").filter(Boolean);
      const store = new Store(mkdtempSync(join(tmpdir(), "ef-recall-")));
      const res = filterStreams({ stdout: raw, stderr: "" }, DEFAULTS, store);
      if (!res) {
        // Pass-through: nothing stored, output unchanged.
        report.push(`${name.padEnd(22)} passthrough`);
        return;
      }
      const digest = res.stdout.text;
      // Needles are compared against the cleaned text (ANSI and \r rewrites removed).
      const missing = needles.filter((n) => !digest.includes(cleanLine(n)));
      expect(missing, `missing from Digest of ${name}:\n${digest}`).toEqual([]);
      expect(digest.length).toBeLessThanOrEqual(DEFAULTS.maxDigestChars);
      const ratio = digest.length / raw.length;
      report.push(`${name.padEnd(22)} ${String(raw.length).padStart(7)} → ${String(digest.length).padStart(5)} chars (${(ratio * 100).toFixed(1)}%)`);
      expect(ratio).toBeLessThanOrEqual(MAX_RATIO[name] ?? 0.5);
    });
  }

  it("short clean output passes through untouched", () => {
    const raw = readFileSync(join(dir, "short-clean.txt"), "utf8");
    const root = mkdtempSync(join(tmpdir(), "ef-short-"));
    expect(filterStreams({ stdout: raw, stderr: "" }, DEFAULTS, new Store(root))).toBeUndefined();
  });

  it("keeps a passing Maven Digest small: no framework frames, no rule lines", () => {
    const raw = readFileSync(join(dir, "maven-green-logged-exceptions.txt"), "utf8");
    const res = filterStreams({ stdout: raw, stderr: "" }, DEFAULTS, new Store(mkdtempSync(join(tmpdir(), "ef-mvn-"))))!;
    expect(res.stdout.text).not.toMatch(/^\s*at org\.junit/m);
    expect(res.stdout.text.length).toBeLessThan(3000);
  });

  it("prints the compression report", () => console.log("\n" + report.join("\n")));
});
