/**
 * The filter: score each line of a Capture, pick what fits the Budget, render the Digest.
 * Deterministic and pure; see docs/SPEC.md §4 and ADR-0001.
 */
import { clipLine, cleanLine, isFrameworkFrame, isNoise, isSignal, isStackFrame, prefixOf, splitLines, templateOf, wordEntropy } from "./lines.js";

export interface DigestOptions {
  /** Size ceiling for the whole Digest, header included. */
  budget: number;
  /** First line of the Digest (identifies the Capture and how to read omitted ranges). */
  header: string;
  /** Lines kept before and after each Signal Line. */
  halo?: number;
  /** Trailing meaningful lines always kept (summaries live there). */
  tail?: number;
  /** Number of the first line (Read output may start mid-file). Default 1. */
  firstLine?: number;
}

export interface Digest {
  text: string;
  totalLines: number;
  keptLines: number;
  elisions: number;
}

const ELISION_RESERVE = 96; // upper bound on one rendered Elision, used while choosing lines
const STACK_MAX = 8; // stack-trace lines kept after one Signal Line (framework frames skipped)
const STACK_SCAN = 80; // how far a stack trace is followed
const SIGNAL_REPEATS = 2; // occurrences of the same Signal Template forced from the start (plus the last)
const SNIPPET_MAX = 60;
const RARE_MAX = 2;
/**
 * Room for rare-but-not-signal lines on top of the forced ones (Signal Lines, Halos, tail).
 * Measured on Claude Code A/B runs: an agent's own `| grep` of a build log is ~2,000 characters, so a
 * Digest that fills all 8,000 with "rare" lines costs more than it saves (docs/SPEC.md §8.3).
 */
export const FILL_MAX = 1500; // a Template seen more often than this is folded, never used to fill

interface Line {
  display: string;
  template: string;
  noise: boolean;
}

export function computeBudget(rawChars: number, ratio: number, cap: number): number {
  return Math.min(Math.max(Math.round(rawChars * ratio), 2000), cap);
}

/** Incremental cost tracker: kept-line characters + one reserve per gap + header. */
class Selection {
  readonly kept: Uint8Array;
  cost: number;
  constructor(private readonly lines: Line[], header: string) {
    this.kept = new Uint8Array(lines.length);
    // Initially everything is one gap.
    this.cost = header.length + 1 + (lines.length > 0 ? ELISION_RESERVE : 0);
  }
  private isKeptOrEdge(i: number): boolean {
    return i < 0 || i >= this.lines.length || this.kept[i] === 1;
  }
  delta(i: number): number {
    if (this.kept[i]) return 0;
    const left = this.isKeptOrEdge(i - 1);
    const right = this.isKeptOrEdge(i + 1);
    const gaps = left && right ? -1 : !left && !right ? 1 : 0;
    return this.lines[i]!.display.length + 1 + gaps * ELISION_RESERVE;
  }
  add(i: number): void {
    this.cost += this.delta(i);
    this.kept[i] = 1;
  }
  tryAdd(i: number, budget: number): boolean {
    if (this.kept[i]) return true;
    if (this.cost + this.delta(i) > budget) return false;
    this.add(i);
    return true;
  }
}

function prepare(text: string): Line[] {
  return splitLines(text).map((raw) => {
    const clean = cleanLine(raw);
    return { display: clipLine(clean), template: templateOf(clean), noise: isNoise(clean) };
  });
}

/** Self-information of each line's Template and prefix within this Capture. */
function noveltyScores(lines: Line[]): Float64Array {
  const tCount = new Map<string, number>();
  const pCount = new Map<string, number>();
  let total = 0;
  for (const l of lines) {
    if (l.noise) continue;
    total++;
    tCount.set(l.template, (tCount.get(l.template) ?? 0) + 1);
    const p = prefixOf(l.template);
    pCount.set(p, (pCount.get(p) ?? 0) + 1);
  }
  // The Budget is a ceiling, not a target: lines whose Template (or prefix) repeats are what
  // Elisions are for, so only rare lines may fill leftover room.
  const prefixLimit = Math.max(5, total * 0.05);
  const scores = new Float64Array(lines.length).fill(-Infinity);
  lines.forEach((l, i) => {
    if (l.noise) return;
    const tc = tCount.get(l.template)!;
    const pc = pCount.get(prefixOf(l.template))!;
    if (tc > RARE_MAX || pc > prefixLimit) return;
    const it = -Math.log2(tc / total);
    const ip = -Math.log2(pc / total);
    scores[i] = 0.5 * it + 0.5 * ip + 0.05 * wordEntropy(l.display);
  });
  return scores;
}

/** Signal Lines, de-duplicated by Template, each with its trailing stack frames. */
function findSignals(lines: Line[]): { at: number; stack: number[] }[] {
  const seen = new Map<string, number[]>();
  lines.forEach((l, i) => {
    if (l.noise || !isSignal(l.display)) return;
    const list = seen.get(l.template) ?? [];
    list.push(i);
    seen.set(l.template, list);
  });
  const chosen: number[] = [];
  for (const list of seen.values()) {
    chosen.push(...list.slice(0, SIGNAL_REPEATS));
    if (list.length > SIGNAL_REPEATS) chosen.push(list[list.length - 1]!);
  }
  chosen.sort((a, b) => a - b);
  return chosen.map((at) => {
    const stack: number[] = [];
    for (let j = at + 1; j < lines.length && j <= at + STACK_SCAN && stack.length < STACK_MAX; j++) {
      const l = lines[j]!.display;
      if (!isStackFrame(l)) break;
      if (!isFrameworkFrame(l)) stack.push(j);
    }
    return { at, stack };
  });
}

function tailLines(lines: Line[], n: number): number[] {
  const out: number[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) if (!lines[i]!.noise) out.push(i);
  return out.reverse();
}

function forcedSet(lines: Line[], signals: { at: number; stack: number[] }[], halo: number, stackMax: number): number[] {
  const set = new Set<number>();
  for (const s of signals) {
    for (let j = s.at - halo; j <= s.at + halo; j++) if (j >= 0 && j < lines.length && !lines[j]!.noise) set.add(j);
    set.add(s.at);
    for (const j of s.stack.slice(0, stackMax)) set.add(j);
  }
  return [...set].sort((a, b) => a - b);
}

/** Alternate from both ends: 1st, last, 2nd, 2nd-to-last, ... */
function bothEnds<T>(xs: T[]): T[] {
  const out: T[] = [];
  for (let a = 0, b = xs.length - 1; a <= b; a++, b--) {
    out.push(xs[a]!);
    if (b !== a) out.push(xs[b]!);
  }
  return out;
}

function choose(lines: Line[], opts: Required<DigestOptions>): Selection {
  const signals = findSignals(lines);
  const tail = tailLines(lines, opts.tail);
  // Forced lines must fit; shrink Halos (and stack frames) before giving up on Signal Lines.
  for (const [halo, stackMax] of [
    [opts.halo, STACK_MAX],
    [Math.min(opts.halo, 1), 5],
    [0, 0],
  ] as const) {
    const sel = new Selection(lines, opts.header);
    for (const i of [...forcedSet(lines, signals, halo, stackMax), ...tail]) sel.add(i);
    if (sel.cost <= opts.budget) return fill(lines, sel, Math.min(opts.budget, sel.cost + FILL_MAX));
  }
  // Even bare Signal Lines overflow: keep them from both ends, the tail right after the first and last.
  const sel = new Selection(lines, opts.header);
  const order = bothEnds(signals.map((s) => s.at));
  const priority = [...order.slice(0, 2), ...tail.slice().reverse(), ...order.slice(2)];
  for (const i of priority) sel.tryAdd(i, opts.budget);
  return sel;
}

function fill(lines: Line[], sel: Selection, budget: number): Selection {
  const scores = noveltyScores(lines);
  const order = [...scores.keys()].filter((i) => scores[i]! > -Infinity && !sel.kept[i]);
  order.sort((a, b) => scores[b]! - scores[a]! || a - b);
  for (const i of order) {
    if (sel.cost >= budget) break;
    sel.tryAdd(i, budget);
  }
  return sel;
}

function elisionText(lines: Line[], from: number, to: number, first: number): string {
  const counts = new Map<string, number>();
  for (let i = from; i <= to; i++) {
    const l = lines[i]!;
    if (!l.noise) counts.set(l.template, (counts.get(l.template) ?? 0) + 1);
  }
  let top = "";
  let best = 0;
  for (const [t, c] of counts) if (c > best) [top, best] = [t, c];
  const what = best === 0 ? "blank/progress" : `"${top.length > SNIPPET_MAX ? top.slice(0, SNIPPET_MAX - 1) + "…" : top}"`;
  return `⟪L${from + first}-${to + first} ×${to - from + 1} ${what}⟫`;
}

function render(lines: Line[], sel: Selection, header: string, first: number): { text: string; elisions: number; kept: number } {
  const out = [header];
  let elisions = 0;
  let kept = 0;
  for (let i = 0; i < lines.length; ) {
    if (sel.kept[i]) {
      out.push(lines[i]!.display);
      kept++;
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length && !sel.kept[j + 1]) j++;
    const marker = elisionText(lines, i, j, first);
    const plain = lines.slice(i, j + 1).map((l) => l.display);
    // A gap shorter than its own marker is cheaper to show than to hide.
    if (plain.join("\n").length <= marker.length) {
      out.push(...plain);
      kept += plain.length;
    } else {
      out.push(marker);
      elisions++;
    }
    i = j + 1;
  }
  return { text: out.join("\n"), elisions, kept };
}

/** Build a Digest of `text`. Lines are numbered from `firstLine` (default 1) in Elisions. */
export function buildDigest(text: string, options: DigestOptions): Digest {
  const opts: Required<DigestOptions> = { halo: 3, tail: 5, firstLine: 1, ...options };
  const lines = prepare(text);
  const sel = choose(lines, opts);
  const r = render(lines, sel, opts.header, opts.firstLine);
  let out = r.text;
  // Hard ceiling: estimates should keep us under it, but never let a Digest exceed the Budget.
  if (out.length > opts.budget) {
    const cut = out.lastIndexOf("\n", opts.budget - 40);
    out = out.slice(0, Math.max(cut, 0)) + "\n⟪…Digest truncated at Budget⟫";
  }
  return { text: out, totalLines: lines.length, keptLines: r.kept, elisions: r.elisions };
}
