/** Optional per-project settings (.entropy-filter/config.json) and command passthrough. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIRNAME } from "./store.js";

export interface Config {
  passthroughCommands: string[];
  budgetRatio: number;
  maxDigestChars: number;
  halo: number;
  shortLines: number;
}

export const DEFAULT_PASSTHROUGH = ["git diff", "git show", "git log -p", "git log --patch", "cat", "head", "tail", "sed -n", "jq", "less"];

export const DEFAULTS: Config = {
  passthroughCommands: [],
  budgetRatio: 0.25,
  maxDigestChars: 8000,
  halo: 3,
  shortLines: 30,
};

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : d);

/** Load config; any problem falls back to defaults (the filter must never fail on config). */
export function loadConfig(root: string): Config {
  try {
    const path = join(root, DIRNAME, "config.json");
    if (!existsSync(path)) return DEFAULTS;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      passthroughCommands: Array.isArray(raw.passthroughCommands) ? raw.passthroughCommands.filter((x): x is string => typeof x === "string") : [],
      budgetRatio: num(raw.budgetRatio, 0.01, 1, DEFAULTS.budgetRatio),
      maxDigestChars: num(raw.maxDigestChars, 1000, 100_000, DEFAULTS.maxDigestChars),
      halo: Math.round(num(raw.halo, 0, 20, DEFAULTS.halo)),
      shortLines: Math.round(num(raw.shortLines, 1, 10_000, DEFAULTS.shortLines)),
    };
  } catch {
    return DEFAULTS;
  }
}

const WRAPPERS = new Set(["sudo", "time", "command", "exec", "nice", "nohup", "env"]);

/** Program + arguments of one shell segment, without leading env assignments and wrappers. */
function words(segment: string): string[] {
  const ws = segment.trim().replace(/^[({]+\s*/, "").split(/\s+/).filter(Boolean);
  while (ws.length && (/^\w+=/.test(ws[0]!) || WRAPPERS.has(ws[0]!))) ws.shift();
  if (ws[0]) ws[0] = ws[0].replace(/^.*\//, ""); // /usr/bin/cat → cat
  return ws;
}

/**
 * True when the command's output is content rather than noise: some segment (split on
 * &&, ||, ;, |, newline) runs a listed program with all the listed arguments.
 */
export function isPassthrough(command: string, extra: string[] = []): boolean {
  const rules = [...DEFAULT_PASSTHROUGH, ...extra].map((r) => r.trim().split(/\s+/)).filter((r) => r.length && r[0]);
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const ws = words(seg);
    if (!ws.length) continue;
    for (const [prog, ...args] of rules) {
      if (ws[0] === prog && args.every((a) => ws.slice(1).includes(a))) return true;
    }
  }
  return false;
}
