/** Per-line text helpers: cleaning, Templates, Signal Lines. Pure functions, no I/O. */

// CSI (colours, cursor), OSC (titles, hyperlinks) and single-char escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export const MAX_LINE_CHARS = 2000;

/** Split text into lines; a trailing newline does not create an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Strip escape sequences and keep only what a terminal would finally show after `\r` rewrites. */
export function cleanLine(raw: string): string {
  let s = raw.replace(ANSI, "");
  if (s.endsWith("\r")) s = s.slice(0, -1);
  const cr = s.lastIndexOf("\r");
  if (cr >= 0) s = s.slice(cr + 1);
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Shorten an over-long line in the middle, keeping its head and tail. */
export function clipLine(line: string, max = MAX_LINE_CHARS): string {
  if (line.length <= max) return line;
  const keep = Math.floor((max - 24) / 2);
  return `${line.slice(0, keep)}…⟪+${line.length - 2 * keep} chars⟫…${line.slice(-keep)}`;
}

const SPINNER = /^[\s|/\\\-–—⠀-⣿◐◓◑◒●○◴◷◶◵⣾⣽⣻⢿⡿⣟⣯⣷.·•*]*$/u;
const PROGRESS_BAR = /[[(|]?[=#>█▓▒░■□━─\-.\s]{6,}[\])|]?\s*\d{1,3}(?:\.\d+)?\s*%|\d{1,3}(?:\.\d+)?\s*%\s*[|[]?[=#>█▓▒░■□━\s]{6,}/u;

/** Lines that carry nothing on their own: blanks, spinners, progress bars. */
export function isNoise(clean: string): boolean {
  // An INFO/DEBUG tag alone, or a tag plus a rule ("[INFO] -----"), carries nothing.
  const t = clean.replace(/^\s*\[(?:INFO|DEBUG|TRACE)\]\s?/, "").trim();
  if (t === "") return true;
  if (t.length >= 3 && /^[-=_*~#.]+$/.test(t)) return true;
  if (SPINNER.test(t)) return true;
  return PROGRESS_BAR.test(t) && t.replace(PROGRESS_BAR, "").trim().length < 40;
}

const TEMPLATE_RULES: [RegExp, string][] = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  [/\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\b/g, "<ts>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, "<str>"],
  [/(?:[A-Za-z]:)?[\w.@~+-]*[/\\][\w.@~+/\\:-]*/g, "<path>"],
  [/\b0x[0-9a-f]+\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<hex>"],
  [/\d+(?:[.,]\d+)*/g, "<n>"],
];

/** Reduce a cleaned line to its Template: variable parts become placeholders. */
export function templateOf(clean: string): string {
  let s = clean;
  for (const [re, rep] of TEMPLATE_RULES) s = s.replace(re, rep);
  return s.replace(/\s+/g, " ").trim();
}

/** The first two words of a Template: groups lines that share a shape but differ in names. */
export function prefixOf(template: string): string {
  return template.split(" ").slice(0, 2).join(" ");
}

/** Word-level Shannon entropy of a line, normalised to 0..1. */
export function wordEntropy(clean: string): number {
  const words = clean.split(/[\s,;:()[\]{}]+/).filter(Boolean);
  if (words.length < 2) return 0;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / words.length;
    h -= p * Math.log2(p);
  }
  return h / Math.log2(words.length);
}

/** Turkish-aware case fold: İ, I and ı all become i, then lower-case. */
export function fold(s: string): string {
  return s.replace(/[İIı]/g, "i").toLowerCase();
}

const SIGNAL_WORDS = [
  // English
  "error", "errors", "err!", "fail", "failed", "failure", "failures", "failing", "exception", "traceback",
  "fatal", "panic", "panicked", "assert", "assertion", "assertionerror", "segfault", "segmentation fault",
  "not ok", "aborted", "abort", "undefined reference", "cannot find", "could not", "unable to",
  "permission denied", "access denied", "connection refused", "timed out", "timeout", "uncaught", "unhandled",
  "critical", "severe", "killed", "oomkilled", "out of memory", "stack overflow", "deadlock",
  // Türkçe (fold edilmiş: ı → i)
  "hata", "hatasi", "hatalar", "hatali", "istisna", "istisnasi", "başarisiz", "başarisiz oldu", "çöktü", "çökme",
  "zaman aşimi", "zaman aşimina", "bulunamadi", "reddedildi", "geçersiz", "yetkisiz", "erişim engellendi",
  "kritik", "ölümcül", "iptal edildi", "bağlanti kurulamadi", "yapilamadi",
].map(fold);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Letter boundaries rather than \b: \b is ASCII-only and would miss Turkish letters.
const SIGNAL = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${SIGNAL_WORDS.map(esc).join("|")})(?![\\p{L}\\p{N}_])`, "u");
const SIGNAL_SYMBOLS = /[✗✕✘❌]|^\s*●\s|^E\s{2,}\S|^\s*(?:FAIL|ERROR|FATAL)\b|\bexit (?:code|status) [1-9]|\bexited with (?:code |status )?[1-9]/u;
// Zero counters are good news, not signals: "0 errors", "failed: 0", "hata yok".
const ZERO_COUNT = new RegExp(
  `(?<![\\p{N}])0\\s+(?:${["errors", "error", "failed", "failures", "failing", "hata", "hatali"].join("|")})|` +
    `(?:errors?|failed|failures?|failing|hata)\\s*[:=]\\s*0(?![\\p{N}])|\\bno errors?\\b|\\bhata yok\\b|\\bwithout errors?\\b`,
  "gu",
);
// Paths often contain words like "error" (src/error-handler.ts); they are not signals.
const PATHLIKE = /(?:[A-Za-z]:)?[\w.@~+-]*[/\\][\w.@~+/\\:-]*/g;

export function isSignal(clean: string): boolean {
  if (SIGNAL_SYMBOLS.test(clean)) return true;
  const masked = fold(clean).replace(PATHLIKE, " ").replace(ZERO_COUNT, " ");
  return SIGNAL.test(masked);
}

const STACK_FRAME = /^\s+at\s|^\s*File ".*", line \d+|^\s+\S|^\s*\.\.\.\s*\d+ more|^\s*Caused by:|^\s*\|/;

// Frames from the runtime, test framework or build tool: they say how the code was called, not where it broke.
const FRAMEWORK_FRAME = /^\s*at\s+(?:(?:app\/\/|java\.base\/|jdk\.\w+\/)?(?:java|javax|jdk|sun|com\.sun|org\.junit|junit|org\.apache\.maven|org\.gradle|org\.testng|kotlin|kotlinx|scala|org\.springframework\.(?:test|aop|cglib))\.|node:internal|<anonymous>|process\.processTicksAndRejections)/;

export function isFrameworkFrame(clean: string): boolean {
  return FRAMEWORK_FRAME.test(clean);
}

/** A line that continues a stack trace or an indented failure block. */
export function isStackFrame(clean: string): boolean {
  return clean.trim() !== "" && STACK_FRAME.test(clean);
}
