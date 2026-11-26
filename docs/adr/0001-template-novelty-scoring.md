# Score lines by Template Novelty, not by character entropy

Per-line character entropy cannot tell `PASS src/a.test.ts` from `TypeError: x is undefined`: both score about the same. We instead reduce each line to a Template and score it by its self-information within the Capture (`-log2(count/total)`), use word-level entropy only as a tie-breaker, and treat bilingual Signal Lines as unconditionally kept rather than "boosted". Selection is budget-driven (keep highest-scoring lines until the Budget is met), but the Digest is always emitted in original line order.

## Consequences

- The Budget is a hard ceiling (default ~25% of the Capture, capped at 8,000 characters). If Signal Lines plus Halos alone exceed it, Halos are trimmed first; if still over, the first and last Signal Lines are kept and the ceiling is enforced on the rest.
- When one tool call yields two streams (stdout and stderr), each gets its own Capture and Digest but they share one 8,000-character ceiling; stderr is allotted first and stdout gets the remainder.
- The "Shannon entropy" in the product pitch refers to this Template self-information, not to character distributions.
