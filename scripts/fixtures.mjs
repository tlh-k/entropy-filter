// Generates the recall-gate corpus in test/fixtures/: <name>.txt (raw output) and
// <name>.needles (one line per substring that must survive verbatim in the Digest).
// Deterministic: re-running produces identical files. Real logs can be dropped in beside them.
import { mkdirSync, writeFileSync } from "node:fs";

const dir = new URL("../test/fixtures/", import.meta.url);
mkdirSync(dir, { recursive: true });

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const ts = (i) => `2026-11-27 10:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(int(0, 999)).padStart(3, "0")}`;

function emit(name, lines, needles) {
  writeFileSync(new URL(`${name}.txt`, dir), lines.join("\n") + "\n");
  writeFileSync(new URL(`${name}.needles`, dir), needles.join("\n") + "\n");
}

// 1. jest: one failure buried in the middle of 600 passing suites.
{
  const l = ["> app@1.0.0 test", "> jest --ci", ""];
  for (let i = 0; i < 300; i++) l.push(`PASS src/${pick(["api", "ui", "core", "db"])}/mod${i}.test.ts (${int(2, 900)} ms)`);
  l.push(
    "FAIL src/billing/invoice.test.ts",
    "  ● Invoice › applies KDV to the net amount",
    "",
    "    expect(received).toBe(expected) // Object.is equality",
    "",
    "    Expected: 120",
    "    Received: 100",
    "",
    "      40 |     const inv = makeInvoice({ net: 100 });",
    "      41 |     inv.applyTax();",
    "    > 42 |     expect(inv.total).toBe(120);",
    "         |                       ^",
    "      at Object.<anonymous> (src/billing/invoice.test.ts:42:23)",
  );
  for (let i = 300; i < 600; i++) l.push(`PASS src/${pick(["api", "ui", "core", "db"])}/mod${i}.test.ts (${int(2, 900)} ms)`);
  l.push("", "Test Suites: 1 failed, 599 passed, 600 total", "Tests:       1 failed, 2411 passed, 2412 total", "Snapshots:   0 total", "Time:        48.112 s", "Ran all test suites.");
  emit("jest-fail-middle", l, ["FAIL src/billing/invoice.test.ts", "Expected: 120", "Received: 100", "at Object.<anonymous> (src/billing/invoice.test.ts:42:23)", "Tests:       1 failed, 2411 passed, 2412 total"]);
}

// 2. pytest: progress dots, then a traceback with E-lines, then the short summary.
{
  const l = ["============================= test session starts ==============================", "platform linux -- Python 3.12.4, pytest-8.3.2, pluggy-1.5.0", "rootdir: /work/app", "collected 1840 items", ""];
  for (let i = 0; i < 120; i++) l.push(`tests/test_${pick(["models", "views", "utils", "tasks"])}_${i}.py ${".".repeat(int(5, 30))}${" ".repeat(4)}[ ${String(Math.round((i / 120) * 100)).padStart(3)}%]`);
  l.push(
    "",
    "=================================== FAILURES ===================================",
    "__________________________ test_refund_rounds_down ____________________________",
    "",
    "    def test_refund_rounds_down():",
    "        order = make_order(total=Decimal('10.005'))",
    ">       assert refund(order) == Decimal('10.00')",
    "E       AssertionError: assert Decimal('10.01') == Decimal('10.00')",
    "E        +  where Decimal('10.01') = refund(<Order 77>)",
    "",
    "tests/test_payments.py:88: AssertionError",
    "=========================== short test summary info ============================",
    "FAILED tests/test_payments.py::test_refund_rounds_down - AssertionError: assert Decimal('10.01') == Decimal('10.00')",
    "======================= 1 failed, 1839 passed in 63.20s ========================",
  );
  emit("pytest-traceback", l, ["E       AssertionError: assert Decimal('10.01') == Decimal('10.00')", "tests/test_payments.py:88: AssertionError", "FAILED tests/test_payments.py::test_refund_rounds_down", "1 failed, 1839 passed"]);
}

// 3. cargo: hundreds of Compiling lines, warnings, one error in the middle, more compiling.
{
  const l = ["    Updating crates.io index"];
  for (let i = 0; i < 260; i++) l.push(`   Compiling ${pick(["serde", "tokio", "syn", "quote", "proc-macro2", "libc", "hyper", "rand"])}${i % 7 ? "" : "_derive"} v${int(0, 2)}.${int(0, 40)}.${int(0, 20)}`);
  l.push(
    "error[E0308]: mismatched types",
    "  --> src/ledger/post.rs:57:24",
    "   |",
    "57 |     let amount: i64 = entry.amount_str;",
    "   |                 ---   ^^^^^^^^^^^^^^^^ expected `i64`, found `String`",
    "   |                 |",
    "   |                 expected due to this",
    "",
  );
  for (let i = 0; i < 140; i++) l.push(`   Compiling ${pick(["axum", "tower", "sqlx", "chrono", "uuid"])} v${int(0, 2)}.${int(0, 40)}.${int(0, 20)}`);
  l.push("For more information about this error, try `rustc --explain E0308`.", "error: could not compile `ledger` (bin \"ledger\") due to 1 previous error");
  emit("cargo-error-middle", l, ["error[E0308]: mismatched types", "--> src/ledger/post.rs:57:24", "expected `i64`, found `String`", "could not compile `ledger`"]);
}

// 4. tsc: 150 near-identical errors plus one different one.
{
  const l = [];
  for (let i = 0; i < 150; i++) l.push(`src/components/Field${i}.tsx(${int(3, 300)},${int(1, 40)}): error TS2322: Type 'string | undefined' is not assignable to type 'string'.`);
  l.splice(77, 0, "src/server/routes.ts(14,8): error TS2307: Cannot find module '@app/auth' or its corresponding type declarations.");
  l.push("", "Found 151 errors in 151 files.");
  emit("tsc-many-errors", l, ["error TS2307: Cannot find module '@app/auth'", "Found 151 errors in 151 files."]);
}

// 5. gradle: task list, then the FAILURE block.
{
  const l = ["> Configure project :app"];
  for (let i = 0; i < 220; i++) l.push(`> Task :${pick(["core", "app", "billing", "api"])}:${pick(["compileJava", "processResources", "classes", "jar", "compileTestJava"])} ${pick(["UP-TO-DATE", "NO-SOURCE", "FROM-CACHE", ""])}`.trimEnd());
  l.push(
    "> Task :billing:test FAILED",
    "",
    "InvoiceServiceTest > kdvIsAppliedOnce() FAILED",
    "    org.opentest4j.AssertionFailedError: expected: <120.00> but was: <144.00>",
    "        at app//org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:151)",
    "        at app//com.zer.billing.InvoiceServiceTest.kdvIsAppliedOnce(InvoiceServiceTest.java:61)",
    "",
    "312 tests completed, 1 failed",
    "",
    "FAILURE: Build failed with an exception.",
    "",
    "* What went wrong:",
    "Execution failed for task ':billing:test'.",
    "> There were failing tests. See the report at: file:///work/billing/build/reports/tests/test/index.html",
    "",
    "BUILD FAILED in 1m 12s",
    "41 actionable tasks: 12 executed, 29 up-to-date",
  );
  emit("gradle-test-failure", l, ["AssertionFailedError: expected: <120.00> but was: <144.00>", "InvoiceServiceTest.kdvIsAppliedOnce(InvoiceServiceTest.java:61)", "Execution failed for task ':billing:test'.", "BUILD FAILED in 1m 12s"]);
}

// 6. npm install: ANSI colours, many deprecation warnings, an error block in the middle.
{
  const l = [];
  for (let i = 0; i < 160; i++) l.push(`\x1b[33mnpm\x1b[39m \x1b[30;43mWARN\x1b[0m \x1b[35mdeprecated\x1b[0m ${pick(["inflight", "glob", "rimraf", "har-validator", "request", "uuid"])}@${int(1, 9)}.${int(0, 9)}.${int(0, 9)}: ${pick(["This module is not supported", "Glob versions prior to v9 are no longer supported", "Rimraf versions prior to v4 are no longer supported", "Please upgrade"])}`);
  l.splice(
    90,
    0,
    "\x1b[31mnpm\x1b[39m \x1b[31mERR!\x1b[39m code ERESOLVE",
    "\x1b[31mnpm\x1b[39m \x1b[31mERR!\x1b[39m ERESOLVE unable to resolve dependency tree",
    "\x1b[31mnpm\x1b[39m \x1b[31mERR!\x1b[39m Found: react@18.3.1",
    "\x1b[31mnpm\x1b[39m \x1b[31mERR!\x1b[39m Could not resolve dependency: peer react@\"^17.0.0\" from legacy-datepicker@2.4.0",
  );
  l.push("", "added 1291 packages, and audited 1292 packages in 41s", "", "214 packages are looking for funding", "  run `npm fund` for details");
  emit("npm-install-ansi", l, ["ERESOLVE unable to resolve dependency tree", "peer react@\"^17.0.0\" from legacy-datepicker@2.4.0", "added 1291 packages"]);
}

// 7. Container build with \r progress bars and spinners; the real error is mid-stream.
{
  const l = [];
  for (let i = 0; i < 60; i++) l.push(`#${int(5, 9)} ${(i / 10).toFixed(1)}s Downloading  [${"=".repeat(i % 40)}>${" ".repeat(40 - (i % 40))}]  ${int(1, 99)}.${int(0, 9)}MB/${int(100, 200)}MB\r#${int(5, 9)} ${(i / 10).toFixed(1)}s Downloading  [${"=".repeat(40)}]  100%`);
  for (let i = 0; i < 80; i++) l.push(pick(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"]) + " ".repeat(int(0, 3)));
  l.push(
    "#11 [build 4/6] RUN go build -o /out/api ./cmd/api",
    "#11 3.112 # example.com/api/internal/store",
    "#11 3.112 internal/store/pg.go:118:9: undefined: pgx.ErrNoRows",
    "#11 ERROR: process \"/bin/sh -c go build -o /out/api ./cmd/api\" did not complete successfully: exit code: 1",
  );
  for (let i = 0; i < 100; i++) l.push(`#${int(12, 14)} ${(i / 7).toFixed(1)}s ${pick(["sha256:", "extracting sha256:"])}${int(10000000, 99999999).toString(16)}${int(10000000, 99999999).toString(16)} ${int(1, 99)}% done`);
  l.push("ERROR: failed to solve: process \"/bin/sh -c go build -o /out/api ./cmd/api\" did not complete successfully: exit code: 1");
  emit("container-progress", l, ["internal/store/pg.go:118:9: undefined: pgx.ErrNoRows", "ERROR: failed to solve"]);
}

// 8. Turkish ERP application log: routine INFO lines, one HATA with a Java stack, one timeout.
{
  const l = [];
  const svc = ["FaturaServisi", "StokServisi", "CariHesapServisi", "SiparisServisi"];
  for (let i = 0; i < 900; i++) l.push(`${ts(i)} INFO  [${pick(svc)}] ${pick(["Fatura", "Sipariş", "İrsaliye"])} #${int(10000, 99999)} işlendi, tutar=${int(1, 99)}.${int(100, 999)},${int(10, 99)} TL`);
  l.splice(
    455,
    0,
    `${ts(455)} HATA  [MuhasebeEntegrasyonu] Yevmiye fişi oluşturulamadı: hesap 391.01 bulunamadı`,
    "    at com.zer.muhasebe.YevmiyeServisi.olustur(YevmiyeServisi.java:212)",
    "    at com.zer.muhasebe.EntegrasyonKuyrugu.isle(EntegrasyonKuyrugu.java:87)",
    "    ... 14 more",
  );
  l.splice(700, 0, `${ts(700)} UYARI [GibEFaturaIstemcisi] GİB servisine bağlantıda zaman aşımı (30 sn), yeniden denenecek`);
  l.push(`${ts(901)} INFO  [Zamanlayici] Gün sonu işlemleri tamamlandı: 903 kayıt, 1 HATA`);
  emit("tr-erp-log", l, ["HATA  [MuhasebeEntegrasyonu] Yevmiye fişi oluşturulamadı: hesap 391.01 bulunamadı", "at com.zer.muhasebe.YevmiyeServisi.olustur(YevmiyeServisi.java:212)", "GİB servisine bağlantıda zaman aşımı (30 sn)", "Gün sonu işlemleri tamamlandı"]);
}

// 9. Mixed TR/EN: English framework logs with a Turkish business failure at INFO level.
{
  const l = [];
  for (let i = 0; i < 500; i++) l.push(`${ts(i)}  INFO 4821 --- [nio-8080-exec-${int(1, 9)}] o.s.web.servlet.DispatcherServlet : Completed ${pick(["200 OK", "204 NO_CONTENT", "304 NOT_MODIFIED"])}`);
  l.splice(260, 0, `${ts(260)}  INFO 4821 --- [nio-8080-exec-3] c.z.stok.StokKontrol : İşlem başarısız: Stok yetersiz (ürün: ABC-123, istenen: 5, mevcut: 2)`);
  l.splice(330, 0, `${ts(330)}  WARN 4821 --- [nio-8080-exec-7] o.h.engine.jdbc.spi.SqlExceptionHelper : SQL Error: 0, SQLState: 40P01`, `${ts(330)} ERROR 4821 --- [nio-8080-exec-7] o.h.engine.jdbc.spi.SqlExceptionHelper : ERROR: deadlock detected`);
  emit("mixed-tr-en", l, ["İşlem başarısız: Stok yetersiz (ürün: ABC-123, istenen: 5, mevcut: 2)", "ERROR: deadlock detected"]);
}

// 10. go test with a panic in the middle.
{
  const l = [];
  for (let i = 0; i < 200; i++) l.push(`ok  \texample.com/api/${pick(["store", "http", "auth", "billing"])}/pkg${i}\t${(rnd() * 3).toFixed(3)}s`);
  l.splice(
    120,
    0,
    "--- FAIL: TestSettle (0.00s)",
    "panic: runtime error: invalid memory address or nil pointer dereference [recovered]",
    "[signal SIGSEGV: segmentation violation code=0x1 addr=0x18 pc=0x6f2a1c]",
    "",
    "goroutine 41 [running]:",
    "example.com/api/billing.(*Settler).Settle(0x0, {0x7a2b40, 0xc0001a2000})",
    "\t/work/billing/settle.go:73 +0x3c",
    "FAIL\texample.com/api/billing\t0.412s",
  );
  l.push("FAIL");
  emit("go-test-panic", l, ["--- FAIL: TestSettle", "panic: runtime error: invalid memory address or nil pointer dereference", "/work/billing/settle.go:73", "FAIL\texample.com/api/billing\t0.412s"]);
}

// 11. Everything passes: the tail summary must survive and the Digest must be small.
{
  const l = ["> vitest run", ""];
  for (let i = 0; i < 700; i++) l.push(` ✓ test/${pick(["a", "b", "c", "d"])}/case${i}.test.ts (${int(1, 40)} tests) ${int(3, 400)}ms`);
  l.push("", " Test Files  700 passed (700)", "      Tests  9188 passed (9188)", "   Start at  10:41:07", "   Duration  31.40s (transform 2.1s, setup 0ms, collect 9.8s, tests 18.2s)");
  emit("all-pass-vitest", l, ["Test Files  700 passed (700)", "Tests  9188 passed (9188)", "Duration  31.40s"]);
}

// 13. Maven, all green, but passing tests log expected exceptions with deep JUnit stacks.
// The Digest must keep the overall summary and stay small (no framework frames, no rule lines).
{
  const l = ["[INFO] Scanning for projects...", "[INFO] ", "[INFO] ------------------< com.acme:shop >------------------", "[INFO] Building shop 2.0", "[INFO] --------------------------------[ war ]---------------------------------"];
  for (let i = 0; i < 12; i++) l.push(`[WARNING] /work/src/main/java/com/acme/legacy/Util${i}.java:[${int(10, 400)},${int(5, 40)}] deprecated item is not annotated with @Deprecated`);
  l.push("[INFO] --- surefire:3.5.4:test (default-test) @ shop ---", "[INFO] ", "[INFO] -------------------------------------------------------", "[INFO]  T E S T S", "[INFO] -------------------------------------------------------");
  const junit = () => Array.from({ length: 40 }, (_, k) => `\tat org.junit.platform.engine.support.hierarchical.NodeTestTask.executeRecursively(NodeTestTask.java:${100 + k})`);
  for (let c = 0; c < 60; c++) {
    l.push(`[INFO] Running com.acme.shop.service.Service${c}Test`);
    if (c === 21 || c === 44) {
      l.push(
        `Nov 27, 2026 2:51:30 AM com.acme.shop.files.AttachmentService remove`,
        `WARNING: attachment could not be deleted, left orphaned: B00${c}/scan.pdf`,
        `java.lang.IllegalStateException: storage unreachable: B00${c}/scan.pdf`,
        `\tat com.acme.shop.files.FakeStorage.delete(FakeStorage.java:${c + 100})`,
        `\tat java.base/java.util.ArrayList.forEach(ArrayList.java:1596)`,
        ...junit(),
      );
    }
    l.push(`[INFO] Tests run: ${int(1, 30)}, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.0${int(10, 99)} s -- in com.acme.shop.service.Service${c}Test`);
  }
  l.push("[INFO] ", "[INFO] Results:", "[INFO] ", "[INFO] Tests run: 658, Failures: 0, Errors: 0, Skipped: 0", "[INFO] ", "[INFO] ------------------------------------------------------------------------", "[INFO] BUILD SUCCESS", "[INFO] ------------------------------------------------------------------------", "[INFO] Total time:  6.052 s", "[INFO] Finished at: 2026-11-27T02:51:31+03:00", "[INFO] ------------------------------------------------------------------------");
  emit("maven-green-logged-exceptions", l, ["Tests run: 658, Failures: 0, Errors: 0, Skipped: 0", "BUILD SUCCESS", "storage unreachable: B0021/scan.pdf", "FakeStorage.delete(FakeStorage.java:121)"]);
}

// 12. Short, clean output: must pass through byte for byte.
{
  const l = ["Already up to date.", "On branch main", "Your branch is up to date with 'origin/main'.", "", "nothing to commit, working tree clean"];
  emit("short-clean", l, l.filter(Boolean));
}

console.log("fixtures written to test/fixtures/");
