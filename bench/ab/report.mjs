#!/usr/bin/env node
// Summarize results-ab.json: medians per scenario × arm and bootstrap 95% CIs of the median
// difference against "off". "All runs" = real life; "fired only" = runs where the filter acted.
//
//   node bench/ab/report.mjs <results-ab.json> [> report.md]
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node bench/ab/report.mjs <results-ab.json>");
  process.exit(2);
}
const { model, runs } = JSON.parse(readFileSync(file, "utf8"));

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

let seed = 1;
const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const resample = (xs) => xs.map(() => xs[Math.floor(rnd() * xs.length)]);

/** Bootstrap 95% CI of median(b) - median(a). */
function ciDiff(a, b, iters = 4000) {
  if (a.length < 2 || b.length < 2) return [NaN, NaN];
  const ds = [];
  for (let i = 0; i < iters; i++) ds.push(median(resample(b)) - median(resample(a)));
  ds.sort((x, y) => x - y);
  return [ds[Math.floor(iters * 0.025)], ds[Math.floor(iters * 0.975)]];
}

const fmt = (v, k) => (Number.isNaN(v) ? "–" : k === "total_cost_usd" ? v.toFixed(3) : Math.round(v).toString());
const METRICS = ["toolResultChars", "total_cost_usd", "num_turns", "retrievals", "reruns"];

const out = [`# entropy-filter A/B — ${model}`, "", `${runs.length} runs.`, ""];
for (const scen of [...new Set(runs.map((r) => r.scenario))].sort()) {
  const rs = runs.filter((r) => r.scenario === scen);
  const arms = [...new Set(rs.map((r) => r.arm))].sort((a, b) => (a === "off" ? -1 : b === "off" ? 1 : a.localeCompare(b)));
  out.push(`## ${scen}`, "");
  out.push(`| arm | n | pass | filter fired | used entropy_exec | ${METRICS.map((m) => `median ${m}`).join(" | ")} |`);
  out.push(`| --- | --- | --- | --- | --- | ${METRICS.map(() => "---").join(" | ")} |`);
  for (const arm of arms) {
    const a = rs.filter((r) => r.arm === arm);
    out.push(
      `| ${arm} | ${a.length} | ${a.filter((r) => r.pass).length}/${a.length} | ${a.filter((r) => r.filterFired).length}/${a.length} | ${a.filter((r) => r.entropyExec > 0).length}/${a.length} | ` +
        METRICS.map((m) => fmt(median(a.map((r) => r[m])), m)).join(" | ") + " |",
    );
  }
  out.push("");
  const off = rs.filter((r) => r.arm === "off");
  for (const arm of arms.filter((a) => a !== "off")) {
    for (const [label, sel] of [["all runs", (r) => true], ["fired only", (r) => r.filterFired]]) {
      const b = rs.filter((r) => r.arm === arm && sel(r));
      const parts = ["toolResultChars", "total_cost_usd"].map((m) => {
        const d = median(b.map((r) => r[m])) - median(off.map((r) => r[m]));
        const [lo, hi] = ciDiff(off.map((r) => r[m]), b.map((r) => r[m]));
        const verdict = Number.isNaN(lo) ? "n too small" : lo > 0 ? "higher" : hi < 0 ? "lower" : "no detectable difference";
        return `${m} Δ ${fmt(d, m)} [${fmt(lo, m)}, ${fmt(hi, m)}] → ${verdict}`;
      });
      out.push(`- **${arm} vs off (${label}, n=${b.length})**: ${parts.join("; ")}`);
    }
  }
  out.push("");
}
console.log(out.join("\n"));
