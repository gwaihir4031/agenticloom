import { escapeTplLit } from './flow-helpers.js';
import { inputPathTokenForRef } from './inputs.js';
import { ProducerInfo } from './scope.js';

/** `revise_with` after schema parse + normalization for the compile layer.
 *  The schema's at-least-one-required refine guarantees at least one of
 *  `prompt` / `inputs` is set on every parsed `ReviseWith` literal — this
 *  discriminated union lifts that invariant into the type system so
 *  `buildRevisePromptExpr` and any other consumer narrows exhaustively
 *  rather than dealing with a both-optional shape. `normalizeReviseWith`
 *  is the single point that converts from the Zod-inferred loose shape
 *  into this DU; if it ever sees a both-unset literal (which the refine
 *  already rejects), it throws — preserving fail-loud semantics rather
 *  than silently producing an unusable revise prompt. */
export type ReviseWithCompile =
  | { prompt: string; inputs?: string[] }
  | { prompt?: string; inputs: string[] };

export function normalizeReviseWith(raw: {
  prompt?: string;
  inputs?: string[];
}): ReviseWithCompile {
  const promptSet = raw.prompt !== undefined;
  const inputsSet = raw.inputs !== undefined && raw.inputs.length > 0;
  if (!promptSet && !inputsSet) {
    throw new Error(
      'Internal compile error: revise_with reached normalizeReviseWith with neither ' +
        "`prompt` nor `inputs` set — the schema's at-least-one refine should have " +
        'rejected this literal at parse time.',
    );
  }
  // Construct each variant explicitly rather than casting `raw` — the cast
  // would let a future field on the loose shape leak into the DU without
  // a type error. Explicit construction keeps the DU's shape the single
  // source of truth.
  if (promptSet && inputsSet) return { prompt: raw.prompt!, inputs: raw.inputs! };
  if (promptSet) return { prompt: raw.prompt! };
  return { inputs: raw.inputs! };
}

/** Unified retry-gate descriptor, discriminated on `kind`. Read once via
 *  `readRetryGate(item)`. Step-host gates carry `verdictField` (the field
 *  name extracted from the gate's JSON output by the retry helper);
 *  aggregate-host gates do not — the aggregate primitive itself already
 *  extracts the verdict before the retry helper sees it. The DU makes the
 *  variant-specific field set part of the type so downstream consumers
 *  (`processRetryGate`, `buildRetryBody`, `buildRevisePromptExpr`) must
 *  narrow on `kind` before reading `verdictField` — TypeScript catches
 *  variant misuse at compile time rather than at runtime.
 *
 *  Shared fields: `retryFrom`, `maxRetries`, `onMaxExceeded`, `approveWhen`,
 *  `reviseWith`, `label`, `gateAgentLabel`. The retry-zone
 *  walker pre-pass, the activeZones registration, the intermediate-
 *  compound check, and the retry-callback emit all stay host-agnostic by
 *  reading through this shape. Schema refines guarantee every gate carries
 *  `revise_with`, so the field is non-optional.
 *
 *  Co-located with `revise.ts` (rather than `retry-gate.ts`) to avoid a
 *  revise↔retry-gate type cycle: `buildRevisePromptExpr` takes
 *  `RetryGateInfo` as a parameter, and `RetryGateInfo` references
 *  `ReviseWithCompile` via `reviseWith`. If types lived in `retry-gate.ts`,
 *  `revise.ts` would import `RetryGateInfo` from there AND `retry-gate.ts`
 *  would import `normalizeReviseWith` / `StepRetryGate` from `revise.ts` —
 *  a cycle. Co-location resolves it. */
export type RetryGateInfo =
  | {
      kind: 'step';
      retryFrom: string;
      maxRetries: number;
      onMaxExceeded: 'fail' | 'continue';
      verdictField: string;
      approveWhen: string;
      reviseWith: ReviseWithCompile;
      label: string;
      gateAgentLabel: string;
    }
  | {
      kind: 'aggregate';
      retryFrom: string;
      maxRetries: number;
      onMaxExceeded: 'fail' | 'continue';
      approveWhen: string;
      reviseWith: ReviseWithCompile;
      label: string;
      gateAgentLabel: string;
    };

export type StepRetryGate = Extract<RetryGateInfo, { kind: 'step' }>;
export type AggregateRetryGate = Extract<RetryGateInfo, { kind: 'aggregate' }>;

/** Emit the rewritten prompt expression that the retry_from target step
 *  receives on retry. Three template shapes by `revise_with` config:
 *
 *  - `prompt` only — JSON-quoted user string, no scaffolding (the
 *    iteration-1 prompt is fully replaced; users own context).
 *  - `inputs` only — default scaffolding (previous-output pointer,
 *    `${currentVerdict}` interpolation, feedback-file list, overwrite
 *    instruction). Mirrors `reviewLoop`'s single-reviewer revise shape.
 *  - both — user prompt as the leading text, then the standard
 *    "Feedback files to address:" block listing the resolved $refs.
 *
 *  Each input $ref resolves to a JS identifier in emit scope; the
 *  template literal interpolates that identifier so the runtime value
 *  (the path string) lands in the prompt at call time. `checkConsume`
 *  has already validated every $ref before this is called, so missing-
 *  bind / non-file-bound errors fire at the gate's compile site rather
 *  than from inside the prompt builder. */
export function buildRevisePromptExpr(
  gate: RetryGateInfo,
  target: { agentName: string; producesPath: string },
  scope: Map<string, ProducerInfo>,
): string {
  const { prompt, inputs } = gate.reviseWith;

  if (prompt !== undefined && inputs === undefined) {
    return JSON.stringify(prompt);
  }

  const resolvedInputs: Array<{ refName: string; agentName: string }> = [];
  if (inputs !== undefined) {
    for (const entry of inputs) {
      // Schema enforces `$`-prefix; strip to get the JS identifier in scope.
      const refName = entry.slice(1);
      const info = scope.get(refName);
      // checkConsume already validated existence + file-boundness at the
      // gate's compile site. If `info` is undefined here, a refactor has
      // bypassed validation — throw loud so the regression surfaces during
      // tsc/test, not as a confusing prompt where the bind name appears
      // where an agent name should.
      if (info === undefined) {
        throw new Error(
          `Internal compile error: revise_with.inputs entry '$${refName}' on ${gate.label} ` +
            `reached buildRevisePromptExpr without a scope entry. checkConsume should have ` +
            `rejected this $ref at the gate's compile site.`,
        );
      }
      resolvedInputs.push({ refName, agentName: info.agentName });
    }
  }

  const lines: string[] = [];
  if (prompt !== undefined) {
    lines.push(escapeTplLit(prompt));
    lines.push('');
    lines.push('Feedback files to address:');
  } else {
    lines.push(`This is a retry. Your previous output is at: ${escapeTplLit(target.producesPath)}`);
    lines.push('Read it with your Read tool.');
    lines.push('');
    lines.push(
      `The retry was triggered because gate '${escapeTplLit(gate.label)}' rejected with verdict '\${currentVerdict}'.`,
    );
    lines.push('');
    lines.push('Feedback files to address:');
  }
  for (const { refName, agentName } of resolvedInputs) {
    lines.push(`- ${escapeTplLit(agentName)} finished its work. Its output is at: \${${refName}}`);
  }
  if (prompt === undefined) {
    lines.push('');
    lines.push(
      `Read each feedback file and address every concern. Revise your output and overwrite ${escapeTplLit(target.producesPath)}.`,
    );
  }
  return '`' + lines.join('\\n') + '`';
}

/** Compute the `inputPaths` emit tokens for the retry-target step's retry-pass
 *  re-emission, derived from `revise_with` rather than the step's original
 *  `inputs:`. This restores the main-pass invariant on retry: the pre-flight
 *  existence check validates exactly the files the rewritten prompt points the
 *  agent at.
 *
 *  - `reviseWith.inputs` set (covers BOTH the inputs-only and the
 *    prompt+inputs modes): map each entry through `inputPathTokenForRef`. The
 *    schema guarantees the `$`-prefix and `processRetryGate` has already
 *    checkConsume-validated each entry at the gate site, so resolution here
 *    cannot hit the unknown-ref error in practice.
 *  - `inputs` undefined (prompt-only mode): return an empty array. The
 *    rewritten prompt names no feedback files, so the pre-flight check is
 *    dropped — the empty override makes `emitRunAgentExpr` omit the clause
 *    rather than leave the original step's now-stale input check in place. */
export function computeReviseInputPaths(
  reviseWith: ReviseWithCompile,
  scope: Map<string, ProducerInfo>,
): string[] {
  if (reviseWith.inputs === undefined) return [];
  const out: string[] = [];
  for (const entry of reviseWith.inputs) {
    const token = inputPathTokenForRef(entry.slice(1), scope);
    if (token !== undefined) out.push(token);
  }
  return out;
}
