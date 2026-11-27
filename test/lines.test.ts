import { describe, expect, it } from "vitest";
import { cleanLine, clipLine, isFrameworkFrame, isNoise, isSignal, templateOf } from "../src/lines.js";

describe("cleanLine", () => {
  it("strips ANSI colours and keeps only the last \\r rewrite", () => {
    expect(cleanLine("\x1b[31mnpm\x1b[39m ERR!")).toBe("npm ERR!");
    expect(cleanLine("50% [==>   ]\r100% [=====]")).toBe("100% [=====]");
    expect(cleanLine("done\r")).toBe("done");
  });
});

describe("clipLine", () => {
  it("keeps head and tail of an over-long line", () => {
    const s = "a".repeat(5000) + "END";
    const c = clipLine(s);
    expect(c.length).toBeLessThanOrEqual(2000);
    expect(c.startsWith("aaa")).toBe(true);
    expect(c.endsWith("END")).toBe(true);
    expect(c).toMatch(/⟪\+\d+ chars⟫/);
  });
});

describe("isNoise", () => {
  it.each(["[INFO] ", "[INFO] ------------------------------------------------------------------------", "", "   ", "⠋", "[=====>     ] 45%", "45% |██████████      |"])("noise: %j", (l) => expect(isNoise(l)).toBe(true));
  it.each(["PASS src/a.test.ts", "Tests: 1 failed"])("not noise: %j", (l) => expect(isNoise(l)).toBe(false));
});

describe("templateOf", () => {
  it("folds variable parts so same-shaped lines match", () => {
    expect(templateOf("PASS src/mod1/a.test.ts (12 ms)")).toBe(templateOf("PASS src/mod99/b.test.ts (7 ms)"));
    expect(templateOf("2026-11-27 10:00:01.123 INFO id=550e8400-e29b-41d4-a716-446655440000")).toBe("<ts> INFO id=<uuid>");
  });
});

describe("isSignal", () => {
  it.each([
    "Error: Cannot find module 'x'",
    "FAIL src/a.test.ts",
    "npm ERR! code ERESOLVE",
    "E       assert 1 == 2",
    "  ● Invoice › applies KDV",
    "panic: runtime error",
    "Traceback (most recent call last):",
    "HATA [Muhasebe] fiş oluşturulamadı",
    "İSTİSNA: NullPointer",
    "İşlem BAŞARISIZ: stok yetersiz",
    "Sunucu çöktü",
    "GİB servisine bağlantıda zaman aşımı",
    "Hesap bulunamadı",
    "Process exited with code 3",
    "✗ should work",
  ])("signal: %s", (l) => expect(isSignal(l)).toBe(true));

  it.each([
    "PASS src/error-handler.test.ts",
    "Found 0 errors.",
    "Tests: 12 passed, failed: 0",
    "İşlem tamamlandı, hata yok",
    "compiled without errors",
    "INFO Fatura #12 işlendi",
    "errorHandler registered",
  ])("not a signal: %s", (l) => expect(isSignal(l)).toBe(false));
});

describe("isFrameworkFrame", () => {
  it.each([
    "\tat org.junit.platform.engine.support.hierarchical.NodeTestTask.execute(NodeTestTask.java:1)",
    "\tat java.base/java.util.ArrayList.forEach(ArrayList.java:1596)",
    "        at app//org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:151)",
    "    at node:internal/process/task_queues:95:5",
  ])("framework: %s", (l) => expect(isFrameworkFrame(l)).toBe(true));
  it.each(["\tat com.acme.shop.files.FakeStorage.delete(FakeStorage.java:121)", "    at Object.<anonymous> (src/a.test.ts:42:23)"])("project: %s", (l) =>
    expect(isFrameworkFrame(l)).toBe(false),
  );
});
