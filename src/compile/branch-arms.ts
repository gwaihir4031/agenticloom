import {
  FlowItem,
  BranchItemT,
  isStep,
  isReviewLoop,
  isHumanGate,
  isParallel,
  isBranch,
  isAggregate,
  agentLabel,
} from '../types.js';
import { ProducerInfo, BranchConsumability } from './scope.js';

/** Per-arm terminal classification for the explicit-rejoin rule. `fileBound:
 *  true` means the arm's terminal item contributes a file path to the
 *  branch's bind; `fileBound: false` means the arm fails the terminal-must-
 *  be-file-bound rule and `itemLabel` carries the offender for the consumer-
 *  site error. `path` on the success variant is the JS identifier or quoted
 *  literal that the arm's closure returns:
 *
 *  - step with `produces:` → step's bind name.
 *  - review_loop → loop's bind name.
 *  - interactive human_gate with literal input → JSON-stringified literal.
 *  - interactive human_gate with `$ref` input → resolved upstream bind name.
 *  - nested branch with consumable bind → inner branch's bind name.
 *
 *  The `kind: 'file' | 'string'` discriminant matches `BranchConsumability.kind`;
 *  v1 constructs only `'file'`. File-local — only branch-arms.ts consumes it. */
type TerminalClassification =
  | { fileBound: true; kind: 'file' | 'string'; path: string }
  | { fileBound: false; itemLabel: string };

/** Classify a single arm's terminal item. Recursive for nested-branch
 *  terminals (the inner branch must itself be consumable + file-bound for the
 *  outer arm to be file-bound). `scope` is threaded so the interactive
 *  human_gate with `$ref` input case resolves against the outer scope.
 *
 *  Called by `classifyArmTerminals` BEFORE the arm body emits. `scope` is
 *  the outer-scope snapshot at the branch's emit site — arm-local
 *  declarations don't exist yet, and the classifier doesn't need them; it
 *  inspects the terminal item's typed-DU directly. The `$ref` human_gate
 *  case resolves against the outer scope only. */
export function classifyArmTerminal(
  arm: FlowItem[],
  scope: Map<string, ProducerInfo>,
): TerminalClassification {
  if (arm.length === 0) {
    // Schema rejects `then: []` / `else: []` via `.min(1)`. This is an
    // internal regression guard, not a user-facing path.
    throw new Error('Internal compile error: classifyArmTerminal called on empty arm.');
  }
  const last = arm[arm.length - 1];

  if (isStep(last)) {
    if (last.produces !== undefined) {
      // The closure's `return` line names the step's bind. `last.bind`
      // is guaranteed set by the arm emit (which calls `item.bind ??=
      // fresh()` before passing here) — but we read defensively in case
      // the call ordering ever changes; an internal error fires rather
      // than emitting a `return undefined` that masks the bug.
      if (last.bind === undefined) {
        throw new Error(
          `Internal compile error: classifyArmTerminal saw a terminal step '${agentLabel(last.step)}' ` +
            `with produces: but no bind. The arm emit should have synthesized a fresh bind ` +
            `before classifying.`,
        );
      }
      return { fileBound: true, kind: 'file', path: last.bind };
    }
    return {
      fileBound: false,
      itemLabel: `step '${agentLabel(last.step)}'`,
    };
  }

  if (isReviewLoop(last)) {
    // review_loop's writer_produces is required by schema — always file-bound.
    if (last.review_loop.bind === undefined) {
      throw new Error(
        `Internal compile error: classifyArmTerminal saw a terminal review_loop with no ` +
          `bind. The arm emit should have synthesized a fresh bind before classifying.`,
      );
    }
    return { fileBound: true, kind: 'file', path: last.review_loop.bind };
  }

  if (isHumanGate(last)) {
    const h = last.human_gate;
    if (h.interactive !== true) {
      return { fileBound: false, itemLabel: `human_gate (plain y/N)` };
    }
    const input = h.input!;
    if (!input.startsWith('$')) {
      // Literal-string input: the closure's return is the JSON-quoted literal.
      return { fileBound: true, kind: 'file', path: JSON.stringify(input) };
    }
    const refName = input.slice(1);
    const info = scope.get(refName);
    if (info === undefined || !info.fileBound) {
      // The classifier runs at the branch's emit site BEFORE the arm body
      // emits, so the gate's own `checkConsume` on `input` has not fired
      // yet — a legitimate forward $ref to an outer-scope producer resolves
      // here; the post-emit `checkConsume` catches a genuine unresolved ref
      // when the gate emits. Reaching this branch means the ref resolves
      // to a producer in scope that is not file-bound (e.g. a sibling
      // branch's non-consumable bind); surface as non-file-bound so the
      // consumer-site error names the gate.
      return {
        fileBound: false,
        itemLabel: `interactive human_gate input '${input}' unresolvable`,
      };
    }
    return { fileBound: true, kind: 'file', path: refName };
  }

  if (isBranch(last)) {
    // Recursive: nested branch's bind must classify as consumable + file-bound.
    const inner = last.branch;
    if (inner.bind === undefined) {
      return { fileBound: false, itemLabel: `nested branch (no bind:)` };
    }
    if (inner.else === undefined) {
      return {
        fileBound: false,
        itemLabel: `nested branch (bind '${inner.bind}') with no else-arm`,
      };
    }
    const thenClass = classifyArmTerminal(inner.then, scope);
    if (!thenClass.fileBound) {
      return {
        fileBound: false,
        itemLabel: `nested branch (bind '${inner.bind}') then-arm terminal ${thenClass.itemLabel}`,
      };
    }
    const elseClass = classifyArmTerminal(inner.else, scope);
    if (!elseClass.fileBound) {
      return {
        fileBound: false,
        itemLabel: `nested branch (bind '${inner.bind}') else-arm terminal ${elseClass.itemLabel}`,
      };
    }
    // v1 constructs only kind: 'file'; the string-bound extension will
    // pick up kind: 'string' here once it lands.
    return { fileBound: true, kind: thenClass.kind, path: inner.bind };
  }

  if (isAggregate(last)) {
    // Aggregate binds a verdict string. v1 rejects; the string-bound
    // branch arm extension admits this as kind: 'string'.
    return { fileBound: false, itemLabel: `aggregate (verdict string, not a path)` };
  }

  if (isParallel(last)) {
    // Parallel has N outputs, no single value. The parallel-combinor
    // extension admits this once a combinor is set.
    return { fileBound: false, itemLabel: `parallel block (no single output)` };
  }

  // FlowItem is a closed union; reaching here means a new primitive landed
  // without an arm-of this switch. Surface loud so the omission catches
  // tsc/test rather than a silent miss-classification.
  throw new Error(
    `Internal compile error: classifyArmTerminal encountered unhandled FlowItem kind: ${JSON.stringify(Object.keys(last as object))}.`,
  );
}

/** Walk an arm to collect every file-path expression a terminal might
 *  produce, recursively expanding nested branches. Used by `classifyArmTerminals`
 *  to populate `allLeafPaths` on `BranchConsumability`, which feeds the
 *  `--resume-from` disk-probe IIFE in `emitPreCursorItem`.
 *
 *  Returns string-quoted path literals (for literal-input human_gates and
 *  step/review_loop produces paths). The disk-probe emit JSON-stringifies
 *  each entry, so the literals here are the raw filesystem paths (NOT
 *  pre-quoted). Caller composes the JSON quoting at emit time. */
export function collectLeafPaths(arm: FlowItem[], scope: Map<string, ProducerInfo>): string[] {
  const last = arm[arm.length - 1];
  if (isStep(last)) {
    if (last.produces === undefined) {
      throw new Error(
        'Internal compile error: collectLeafPaths reached a step terminal without produces.',
      );
    }
    return [last.produces];
  }
  if (isReviewLoop(last)) {
    return [last.review_loop.writer_produces];
  }
  if (isHumanGate(last)) {
    const h = last.human_gate;
    if (h.interactive !== true) {
      throw new Error(
        'Internal compile error: collectLeafPaths reached a plain y/N human_gate (not file-bound).',
      );
    }
    const input = h.input!;
    if (!input.startsWith('$')) return [input];
    const refName = input.slice(1);
    const info = scope.get(refName);
    if (info?.producesPath === undefined) {
      throw new Error(
        `Internal compile error: collectLeafPaths could not resolve $ref '${input}' to a ` +
          `producer with a static producesPath. classifyArmTerminals should have admitted this ` +
          `branch only when every leaf resolves to a static path.`,
      );
    }
    return [info.producesPath];
  }
  if (isBranch(last)) {
    const inner = last.branch;
    const out: string[] = [...collectLeafPaths(inner.then, scope)];
    if (inner.else) out.push(...collectLeafPaths(inner.else, scope));
    return out;
  }
  throw new Error('Internal compile error: collectLeafPaths reached non-file-bound terminal.');
}

/** Classify both arms of a branch and return the `BranchConsumability`
 *  verdict. Constructs the success variant only when both arms admit
 *  `fileBound: true` AND `else:` is defined; otherwise returns the matching
 *  reason. v1 constructs only `kind: 'file'` consumable variants and
 *  `missing_else` / `arm_terminal_not_file_bound` reasons; `mixed_arm_kinds`
 *  is reserved for the string-bound branch arm extension. */
export function classifyArmTerminals(
  b: BranchItemT['branch'],
  scope: Map<string, ProducerInfo>,
): BranchConsumability {
  if (b.else === undefined) {
    return { consumable: false, reason: { kind: 'missing_else' } };
  }
  const thenClass = classifyArmTerminal(b.then, scope);
  if (!thenClass.fileBound) {
    return {
      consumable: false,
      reason: {
        kind: 'arm_terminal_not_file_bound',
        arm: 'then',
        terminalLabel: thenClass.itemLabel,
      },
    };
  }
  const elseClass = classifyArmTerminal(b.else, scope);
  if (!elseClass.fileBound) {
    return {
      consumable: false,
      reason: {
        kind: 'arm_terminal_not_file_bound',
        arm: 'else',
        terminalLabel: elseClass.itemLabel,
      },
    };
  }
  // Both arms file-bound. Walk again to collect every leaf path (a
  // single-level arm contributes one; a nested-branch arm expands
  // recursively). The plural walk is separate from the singular admission
  // so `classifyArmTerminal`'s recursion stays focused on yes/no admission.
  const allLeafPaths: string[] = [
    ...collectLeafPaths(b.then, scope),
    ...collectLeafPaths(b.else, scope),
  ];
  return {
    consumable: true,
    kind: thenClass.kind,
    thenPath: thenClass.path,
    elsePath: elseClass.path,
    allLeafPaths,
  };
}
