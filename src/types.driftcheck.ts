// FlowItem variant types — bidirectional drift detection (LOAD-BEARING)
// ============================================================================
//
// This file exists exclusively to compile-check the structural identity of
// each Zod schema body against its hand-written interface counterpart. It
// emits a near-empty JS module after type erasure; it is NOT exported from
// `package.json`'s `exports` map and is never imported by runtime code.
//
// Why a separate `.ts` file (not in `types.test.ts`):
// - The standard `tsconfig.json` EXCLUDES test files from the build pass,
//   so any `Expect<Equal<...>>` assertion living in a `*.test.ts` would
//   compile-check only under a manual `tsc -p tsconfig.test.json` run that
//   CI does NOT currently execute. Putting the assertions here makes them
//   load-bearing under the standard `npm run build` invocation that CI
//   already runs on every PR.
//
// What drift is caught:
// - REMOVED or RETYPED field in a Zod body → caught by the `z.ZodType<XT>`
//   annotation on the public schema in `types.ts` (inferred type no longer
//   satisfies the interface). This file is the safety net for the reverse
//   case below.
// - ADDED optional field in a Zod body that the interface lacks → caught by
//   the `Equal<>` idiom here. The annotation alone would let it slip because
//   TS treats "missing optional" and "present-undefined optional" as
//   assignment-compatible.
//
// To verify these assertions actually fire (and aren't silently
// tautological): temporarily add `phantom: z.string().optional()` to one of
// the `*ItemBody` strictObjects in `types.ts`, then run `npm run build`.
// The matching assertion below will fail compilation with "Type 'false' is
// not assignable to type 'true'". Revert before committing.

import type { z } from 'zod/v4';
import {
  type StepItemBody,
  type ReviewLoopItemBody,
  type HumanGateItemBody,
  type AggregateItemBody,
  type ParallelItemBody,
  type BranchItemBody,
  type ForeachItemBody,
  type StepItemT,
  type ReviewLoopItemT,
  type HumanGateItemT,
  type AggregateItemT,
  type ParallelItemT,
  type BranchItemT,
  type ForeachItemT,
} from './types.js';

/** Compile-time structural equality. Returns the literal type `true` iff
 *  `X` and `Y` are structurally identical at every depth; otherwise `false`.
 *  Uses the canonical "two identical conditional function types compare
 *  equal" trick — distributing `extends` over a generic `T` forces TS to
 *  resolve the comparison without flattening optional-vs-missing differences. */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** Compile-time assertion: `type _ = Expect<Equal<A, B>>` fails to compile
 *  when its argument is not exactly `true`. */
type Expect<T extends true> = T;

// One assertion per variant. If any of these fails to compile, the
// hand-written interface in `types.ts` and the corresponding Zod body have
// drifted out of structural identity. Fix the side that's wrong.
//
// The `_X` names are unused type aliases — TS doesn't complain because they're
// not declared as values. This file's entire purpose is the side effect of
// type-checking these lines.
type _StepDrift = Expect<Equal<z.infer<typeof StepItemBody>, StepItemT>>;
type _ReviewLoopDrift = Expect<Equal<z.infer<typeof ReviewLoopItemBody>, ReviewLoopItemT>>;
type _HumanGateDrift = Expect<Equal<z.infer<typeof HumanGateItemBody>, HumanGateItemT>>;
type _AggregateDrift = Expect<Equal<z.infer<typeof AggregateItemBody>, AggregateItemT>>;
type _ParallelDrift = Expect<Equal<z.infer<typeof ParallelItemBody>, ParallelItemT>>;
type _BranchDrift = Expect<Equal<z.infer<typeof BranchItemBody>, BranchItemT>>;
type _ForeachDrift = Expect<Equal<z.infer<typeof ForeachItemBody>, ForeachItemT>>;

// Suppress unused-type warnings — these aliases ARE the test.
export type {
  _StepDrift,
  _ReviewLoopDrift,
  _HumanGateDrift,
  _AggregateDrift,
  _ParallelDrift,
  _BranchDrift,
  _ForeachDrift,
};
