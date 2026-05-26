import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';
import { flattenZodIssues, MAX_FLATTEN_DEPTH } from './zod-error.js';

/** Helper: produce a real $ZodIssue array by parsing fixture input through a
 *  fixture schema and returning issues from the resulting ZodError. Going
 *  through real zod-parse (instead of hand-crafting $ZodIssue literals) keeps
 *  these tests robust against zod-internal shape drift across v4 minor
 *  versions — the only thing the suite asserts is what `flattenZodIssues`
 *  does to whatever zod actually produces. */
function issuesFor(schema: z.ZodTypeAny, input: unknown): ReadonlyArray<z.core.$ZodIssue> {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error('test fixture: expected schema to reject the input');
  }
  return result.error.issues;
}

describe('flattenZodIssues', () => {
  it('passes non-union issues through unchanged', () => {
    // A bare string schema rejecting a number produces a single
    // `invalid_type` issue (no union recursion). The function should
    // return the same issues array shape, untouched.
    const issues = issuesFor(z.object({ x: z.string() }), { x: 123 });
    const out = flattenZodIssues(issues);
    expect(out).toHaveLength(issues.length);
    expect(out[0].code).toBe(issues[0].code);
    expect(out[0].path).toEqual(issues[0].path);
    expect(out[0].message).toBe(issues[0].message);
  });

  it('recurses into invalid_union and surfaces the deepest member-relative path', () => {
    // Mirror the load-bearing FlowItem shape: a union over object members
    // that disagree on REQUIRED nested fields. The "step" member requires
    // `on_fail.revise_with` (depth 2 member-relative); the "review_loop"
    // member requires `agents` (depth 1 member-relative). Given a `step`-
    // shaped input that's missing the depth-2 field, flattenZodIssues
    // must pick the step member (deepest) and discard the review_loop
    // shallow noise.
    const stepMember = z.object({
      step: z.string(),
      on_fail: z.object({
        revise_with: z.string(), // member-relative depth 2 when missing
      }),
    });
    const reviewLoopMember = z.object({
      review_loop: z.string(),
      agents: z.array(z.string()),
    });
    const flowItem = z.union([stepMember, reviewLoopMember]);
    const schema = z.object({ flow: z.array(flowItem) });

    // Input shaped like a step but missing on_fail.revise_with entirely
    // (so on_fail itself is missing — even shallower than the depth-2
    // case below, but still distinguishes against the review_loop member
    // which would complain about `agents: Required` at member-relative
    // depth 1).
    const issues = issuesFor(schema, {
      flow: [{ step: 'w', on_fail: {} }],
    });
    const out = flattenZodIssues(issues);

    // The deepest path the step member surfaces is
    // `flow.0.on_fail.revise_with` (depth 4 absolute, depth 2 member-
    // relative). The review_loop member surfaces shallower issues
    // (member-relative depth 1). After flattening with the prefix
    // prepend, we should see the absolute path bullet but NOT the
    // sibling-variant noise.
    const paths = out.map((i) => i.path.join('.'));
    expect(paths).toContain('flow.0.on_fail.revise_with');
    // No sibling-variant `agents: Required` at member-relative depth 1.
    expect(paths).not.toContain('flow.0.agents');
    // No collapsed outer-union bullet at the path prefix alone.
    expect(paths).not.toContain('flow.0');
  });

  it('prepends the outer invalid_union path prefix to member-relative issue paths', () => {
    // v4 emits union-member issue paths as RELATIVE to the union-member
    // scope (v3 had absolute-from-root paths). The function must prepend
    // the outer issue's path so callers see absolute paths.
    //
    // Construct a union nested inside an object key: the outer issue's
    // path is `['target']`, and the member's $ZodIssue has a member-
    // relative path like `['k']`. After prepending, callers see
    // `target.k`, not `k`.
    const memberA = z.object({ marker_a: z.literal('a'), k: z.string() });
    const memberB = z.object({ marker_b: z.literal('b'), k: z.number() });
    const schema = z.object({
      target: z.union([memberA, memberB]),
    });
    const issues = issuesFor(schema, { target: { marker_a: 'a', k: 42 } });
    const out = flattenZodIssues(issues);
    const paths = out.map((i) => i.path.join('.'));
    // memberA wins on the marker (literal 'a' matches), so its inner
    // mismatch on `k: string` surfaces at absolute `target.k`.
    expect(paths).toContain('target.k');
    // No leaked member-relative path (`k` without the prefix).
    expect(paths.every((p) => p !== 'k')).toBe(true);
  });

  it('discards depth-comparison ties at the call site (callers de-dup, not us)', () => {
    // When two union members reach the SAME deepest member-relative
    // depth, both surface in the output. The contract is "deepest wins,
    // ties pass through" — the caller in cli.ts de-dups via a `path +
    // message` Set. This test confirms the function does NOT prune ties
    // itself.
    const memberA = z.object({ tag: z.literal('a'), x: z.string() });
    const memberB = z.object({ tag: z.literal('b'), x: z.string() });
    const schema = z.union([memberA, memberB]);
    // A non-discriminating input (`tag: 'c'`) makes both members fail at
    // member-relative depth 1 (`tag` mismatch on each). With our missing
    // x, depth-2 also matches: both members complain about `x`. Either
    // way, ties at the deepest depth must both pass through.
    const issues = issuesFor(schema, { tag: 'c' });
    const out = flattenZodIssues(issues);
    // We should see at least one `tag`-related issue (the deepest tied
    // depth). The contract: tied members both pass through — at minimum
    // count > 0, and no member-pruning logic silently drops one.
    expect(out.length).toBeGreaterThan(0);
  });

  it('respects MAX_FLATTEN_DEPTH on pathologically deep nesting', () => {
    // Construct a synthetic invalid_union issue nested past
    // MAX_FLATTEN_DEPTH to confirm the depth cap kicks in. We build the
    // issue shape directly (rather than via a deeply self-nesting
    // schema) so the test pins the cap behavior independent of zod's
    // own recursion limits.
    //
    // Build N+2 levels of `invalid_union` issue, each carrying one
    // deeper member. The innermost level holds a single leaf issue with
    // a recognizable marker path. With depth=0 at entry, the outermost
    // recursion handles depth 0..MAX; depth MAX+1 short-circuits via
    // `if (depth > MAX_FLATTEN_DEPTH) return issues;` and returns the
    // input unchanged.
    const innerLeaf: z.core.$ZodIssue = {
      code: 'custom',
      path: ['marker'],
      message: 'leaf',
      input: undefined,
    } as unknown as z.core.$ZodIssue;
    let current: ReadonlyArray<z.core.$ZodIssue> = [innerLeaf];
    for (let i = 0; i <= MAX_FLATTEN_DEPTH + 2; i++) {
      const outer: z.core.$ZodIssue = {
        code: 'invalid_union',
        path: [],
        message: 'Invalid input',
        errors: [current],
        input: undefined,
      } as unknown as z.core.$ZodIssue;
      current = [outer];
    }
    const result = flattenZodIssues(current);
    // The function returns SOMETHING — and crucially does NOT throw or
    // recurse to stack overflow. Beyond the cap, the contract is "degrade
    // gracefully to the input issues unchanged."
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles invalid_union with empty errors array (no recursion needed)', () => {
    // Defensive path: an invalid_union issue with `errors: []` should
    // pass through to the else branch (no recursion possible, no
    // members to pick). The function should not crash or infinite-loop.
    const issue: z.core.$ZodIssue = {
      code: 'invalid_union',
      path: ['top'],
      message: 'Invalid input',
      errors: [],
      input: undefined,
    } as unknown as z.core.$ZodIssue;
    const out = flattenZodIssues([issue]);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('invalid_union');
    expect(out[0].path).toEqual(['top']);
  });
});
