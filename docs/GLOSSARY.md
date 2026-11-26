# entropy-filter

Shrinks long command and tool output before it reaches a coding agent's context, keeping the lines that carry information and leaving a way back to the rest.

## Language

### Output and storage

**Capture**:
The raw, unfiltered output of one command or tool call, stored locally under a short id.
_Avoid_: raw log, output store, dump

**Slice**:
A contiguous line range read back verbatim from a Capture.
_Avoid_: excerpt, chunk, re-read

### What the agent sees

**Digest**:
The filtered view of a Capture handed to the agent, in original line order.
_Avoid_: summary, compressed output, filtered log

**Elision**:
A one-line marker inside a Digest standing in for a run of omitted lines, naming the Capture and the exact line range.
_Avoid_: anchor, placeholder, "lines omitted" note

### Scoring

**Template**:
A line with its variable parts (numbers, ids, paths, quoted strings, timestamps) replaced by placeholders, so that repeated lines of the same shape match.
_Avoid_: pattern, shape, normalized line

**Novelty**:
How surprising a line's Template is within its Capture; rare Templates score high, repeated ones near zero.
_Avoid_: entropy score, information density

**Signal Line**:
A line kept unconditionally because it matches a bilingual (TR/EN) failure marker such as ERROR, Exception, HATA or Zaman aşımı.
_Avoid_: anchor line, critical line, boosted line

**Halo**:
The neighbouring lines kept before and after a Signal Line so it can be read in context.
_Avoid_: context window, surrounding lines

**Budget**:
The size ceiling a Digest must fit within.
_Avoid_: limit, token cap
