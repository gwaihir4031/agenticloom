import { z } from 'zod/v4';

/** Maximum recursion depth into nested `invalid_union` issues. The loom
 *  grammar bottoms out at depth 2-3 in practice; the cap exists only to
 *  guard against pathologically self-referential schemas. */
export const MAX_FLATTEN_DEPTH = 5;

/** Flatten a ZodError's issues, drilling into union-member errors so the
 *  user sees the field-specific failure instead of a collapsed "Invalid
 *  input" bullet at the union root.
 *
 *  Zod surfaces a discriminated-union (or plain `z.union`) failure as ONE
 *  outer issue with `code: 'invalid_union'`, `message: 'Invalid input'`, and
 *  `errors: $ZodIssue[][]` holding one inner array per union member's
 *  failure. (v3 used `unionErrors: ZodError[]`; v4 flattened the wrapping —
 *  inner arrays of $ZodIssue directly, no ZodError objects around them.)
 *  Without recursing into those nested issue arrays the user only sees
 *  `flow.0: Invalid input` — accurate but useless. The nested issue
 *  `flow.0.on_fail.revise_with: Required` is what they need.
 *
 *  Strategy: among the union members, pick the one(s) whose flattened
 *  issues reach the DEEPEST member-relative path. That's the variant the
 *  input "tried to be" (e.g. for a `step:` item, the StepItem member
 *  produces an issue at member-relative `on_fail.revise_with` — depth 2,
 *  surfaced absolute as `flow.0.on_fail.revise_with` after the
 *  path-prefix prepend — while sibling members produce shallow noise
 *  like `review_loop: Required` (depth 1) or root-level `Unrecognized
 *  key(s)` (depth 0)). Discarding the shallower members suppresses
 *  cross-variant noise that a naive "print every nested issue" pass would
 *  produce. Ties at the deepest depth fall through to the de-dup pass at
 *  the call site (`path + message` Set) so symmetric union members
 *  don't double-print.
 *
 *  Recurses into nested invalid_union issues (a union member that itself
 *  failed inside a sub-union) up to `MAX_FLATTEN_DEPTH`. On overflow we
 *  degrade gracefully to the input issues unchanged — same as the pre-fix
 *  behavior.
 *
 *  Member-issue paths are rewritten on the way out: v4 emits union-member
 *  issue paths RELATIVE to the union-member scope (v3 was absolute from the
 *  root), so the outer invalid_union issue's path is prepended to each
 *  surviving member issue. Callers receive absolute, root-relative paths
 *  (matching v3's pre-flattened behavior). Note this means the inner
 *  depth-comparison runs on PRE-prepend (member-relative) paths — that's
 *  intentional, since the question "which variant tried hardest?" is
 *  scoped per-member.
 *
 *  Lossy reduction: union-member provenance is discarded by the
 *  deepest-wins selection (callers cannot recover which member produced a
 *  surviving issue). Suitable for the user-facing error-bullet path; not a
 *  general-purpose ZodError walker. */
export function flattenZodIssues(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  depth = 0,
): ReadonlyArray<z.core.$ZodIssue> {
  if (depth > MAX_FLATTEN_DEPTH) return issues;
  const out: z.core.$ZodIssue[] = [];
  for (const issue of issues) {
    // `issue.code === 'invalid_union'` narrows to $ZodIssueInvalidUnion
    // (v4's discriminated union of $ZodIssue). v4 exposes nested errors as
    // `errors: $ZodIssue[][]` — one inner array per union member — so we
    // iterate the member arrays directly without unwrapping any enclosing
    // ZodError. (v3 had `unionErrors: ZodError[]` and required `.issues`
    // unwrapping per member.)
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      const flattenedPerMember = issue.errors.map((memberIssues) =>
        flattenZodIssues(memberIssues, depth + 1),
      );
      // `Math.max(0, ...[])` returns 0 for an empty list — fine, since a
      // member with no issues couldn't be a "best" candidate over one with
      // real issues anyway.
      const depthsPerMember = flattenedPerMember.map((memberIssues) =>
        Math.max(0, ...memberIssues.map((i) => i.path.length)),
      );
      const bestDepth = Math.max(...depthsPerMember);
      // v4 path-relativization: $ZodIssueInvalidUnion.errors[i] member-issue
      // paths are relative to the union-member scope (v3 kept paths absolute
      // from the root ZodError). Prepend the outer issue's path so callers
      // see `flow.0.on_fail.revise_with: ...` instead of `on_fail.revise_with:
      // ...` (the latter loses which flow item failed).
      const prefix = issue.path;
      for (let i = 0; i < flattenedPerMember.length; i++) {
        if (depthsPerMember[i] !== bestDepth) continue;
        for (const memberIssue of flattenedPerMember[i]) {
          out.push({ ...memberIssue, path: [...prefix, ...memberIssue.path] });
        }
      }
    } else {
      out.push(issue);
    }
  }
  return out;
}
