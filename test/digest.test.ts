import { describe, expect, it } from "vitest";
import { buildDigest, computeBudget } from "../src/digest.js";

const H = "[hdr]";
const noisy = (n: number, at: number, inject: string[]) => {
  const l = Array.from({ length: n }, (_, i) => `INFO worker ${i} handled request in ${i % 9} ms`);
  l.splice(at, 0, ...inject);
  return l.join("\n");
};

describe("buildDigest", () => {
  it("keeps a mid-log error with its Halo, in original order", () => {
    const text = noisy(1000, 500, ["Exception in thread main: boom", "    at a.b(C.java:1)", "    at d.e(F.java:2)"]);
    const d = buildDigest(text, { budget: 4000, header: H });
    const out = d.text.split("\n");
    const i = out.indexOf("Exception in thread main: boom");
    expect(i).toBeGreaterThan(0);
    expect(out[i + 1]).toBe("    at a.b(C.java:1)");
    expect(out[i - 1]).toBe("INFO worker 499 handled request in 4 ms"); // Halo before
    // Order: every kept INFO line number increases.
    const nums = out.map((l) => /INFO worker (\d+)/.exec(l)?.[1]).filter(Boolean).map(Number);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it("numbers Elisions with original line numbers (and firstLine offset)", () => {
    const text = noisy(200, 100, ["FATAL: disk full"]);
    const d = buildDigest(text, { budget: 3000, header: H, firstLine: 1001 });
    expect(d.text).toMatch(/⟪L1001-\d+ ×\d+ "INFO worker <n> handled request in <n> ms"⟫/);
    const m = [...d.text.matchAll(/⟪L(\d+)-(\d+) ×(\d+)/g)];
    for (const [, a, b, n] of m) expect(Number(b) - Number(a) + 1).toBe(Number(n));
  });

  it("always keeps the last lines (summaries)", () => {
    const text = noisy(500, 0, []) + "\nTests: 500 passed\nTime: 3.2 s";
    const d = buildDigest(text, { budget: 2000, header: H });
    expect(d.text.endsWith("Tests: 500 passed\nTime: 3.2 s")).toBe(true);
  });

  it("never exceeds the Budget, even when Signal Lines alone overflow it", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `ERROR job ${i} failed: ${"x".repeat(i % 50)} reason-${i * 7919}`);
    const d = buildDigest(lines.join("\n"), { budget: 2000, header: H });
    expect(d.text.length).toBeLessThanOrEqual(2000);
  });

  it("keeps first and last Signal Lines when it has to drop some", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `step ${i} error code E${(i * 7919) % 100000} in module m${i}`);
    const d = buildDigest(lines.join("\n"), { budget: 2000, header: H, tail: 0 });
    expect(d.text).toContain("step 0 error");
    expect(d.text).toContain("step 399 error");
  });

  it("shrinks Halos before dropping Signal Lines", () => {
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango".split(" ");
    const errs = words.map((w) => `ERROR ${w} subsystem failed`);
    const parts: string[] = [];
    for (const e of errs) parts.push(...Array.from({ length: 10 }, (_, i) => `INFO filler ${i} ${"y".repeat(60)}`), e);
    const d = buildDigest(parts.join("\n"), { budget: 3200, header: H });
    for (const e of errs) expect(d.text).toContain(e);
    expect(d.text.length).toBeLessThanOrEqual(3200);
  });

  it("folds repeats of the same Signal Template, keeping the first two and the last", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `ERROR job ${i} failed`);
    const d = buildDigest(lines.join("\n"), { budget: 8000, header: H, tail: 0 });
    expect(d.text).toContain("ERROR job 0 failed");
    expect(d.text).toContain("ERROR job 1 failed");
    expect(d.text).toContain("ERROR job 299 failed");
    expect(d.text).toMatch(/⟪L\d+-\d+ ×\d+ "ERROR job <n> failed"⟫/);
  });

  it("does not spend the Budget on repeated lines", () => {
    const text = noisy(2000, 1000, ["Error: boom"]);
    const d = buildDigest(text, { budget: 8000, header: H });
    expect(d.text.length).toBeLessThan(2000);
  });

  it("is deterministic", () => {
    const text = noisy(800, 300, ["Error: x", "  at y"]);
    expect(buildDigest(text, { budget: 3000, header: H }).text).toBe(buildDigest(text, { budget: 3000, header: H }).text);
  });
});

describe("computeBudget", () => {
  it("is 25% of raw, at least 2,000 and at most the cap", () => {
    expect(computeBudget(1000, 0.25, 8000)).toBe(2000);
    expect(computeBudget(20000, 0.25, 8000)).toBe(5000);
    expect(computeBudget(1_000_000, 0.25, 8000)).toBe(8000);
  });
});
