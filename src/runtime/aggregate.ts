import * as path from 'path';
import { z } from 'zod/v4';
import { HaltPipelineError } from './agent.js';
import { readAgentFile } from './read-agent-file.js';

export interface AggregateOpts {
  inputs: Record<string, string>;
  require?: 'all_approved';
  verdictField: string;
  approveWhen?: string;
  /** Per-input file-rewrite closures for retry-on-parse-failure. Each takes
   *  the corrective prompt `readAgentFile` constructs (so the agent gets new
   *  information on retry, not the same prompt that produced the broken
   *  output). Compile emits one entry per `step`-kind input (with a known
   *  agentName + producesPath); non-step inputs (review_loop binds, pipeline
   *  inputs) are omitted and fall through to loud-fail on parse error. */
  rewriteProducerFiles?: Record<string, (correctivePrompt: string) => Promise<void>>;
}

/** Deterministic aggregation across parallel review outputs.
 *
 *  Each input value is a file path that the upstream step's `produces:`
 *  wrote. Loom reads each file via the JSON contract helper, extracts
 *  `parsed[verdictField]` (must be a string), and treats the input as
 *  approved when that value equals `approveWhen` (default `'pass'`, matching
 *  the reference script's `status: "pass" | "fail"` convention).
 *
 *  Reads are parallelized (`Promise.all`) so when multiple inputs trigger a
 *  parse-failure retry, the retries run concurrently — wall-clock is bounded
 *  by the slowest retry, not the sum. Each rewrite closure invokes an agent
 *  that writes to a distinct `produces:` path (the compile-time collision
 *  check guarantees this), so no write race.
 *
 *  Returns the in-memory overall verdict string (`approveWhen` value when
 *  every input passed, otherwise `'NEEDS_REVISION'`). The orchestrator does
 *  NOT write a derived consolidated document — downstream consumers that
 *  want to inspect per-reviewer findings read the per-reviewer JSON files
 *  directly. The returned string is small and is not intended to flow into
 *  agent prompts as a substitute for an artifact file (`checkConsume`
 *  rejects `$ref` to an aggregate's bind because aggregate is no longer
 *  file-bound). The compound reviewer loop does surface this string in the
 *  writer's revise prompt as text framing alongside the per-reviewer file
 *  paths — that is intended. */
export async function aggregate(opts: AggregateOpts): Promise<string> {
  const policy = opts.require ?? 'all_approved';
  const approve = opts.approveWhen ?? 'pass';

  const verdicts = await Promise.all(
    Object.entries(opts.inputs).map(async ([label, value]) => {
      const schema = z.looseObject({ [opts.verdictField]: z.string() });
      const rewriteProducerFile = opts.rewriteProducerFiles?.[label];
      // Absolutify at the boundary, same posture as runAgent/reviewLoop.
      // `$ref` inputs already arrive absolute (bind values from runAgent are
      // absolute post-fix); literal-string inputs (`inputs: { x: "foo.json" }`)
      // arrive as raw YAML relatives — without resolving, readAgentFile would
      // open them relative to cwd and the diagnostic ENOENT message would
      // omit the cwd context. Extends the bind-values-are-absolute invariant
      // to the only remaining runtime file-read site.
      const parsed = await readAgentFile(path.resolve(value), schema, label, rewriteProducerFile);
      const verdict = parsed[opts.verdictField] as string;
      return { label, approved: verdict.trim() === approve.trim() };
    }),
  );

  const passed = policy === 'all_approved' && verdicts.every((v) => v.approved);
  const overall = passed ? approve : 'NEEDS_REVISION';
  const approvedCount = verdicts.filter((v) => v.approved).length;

  console.log(
    `  ${passed ? '✓' : '⚠'} Overall: ${overall} (${approvedCount}/${verdicts.length} approved)`,
  );
  return overall;
}

/** Options for the retry-from-bind runtime helper. The `kind` discriminator
 *  selects how the initial verdict is sourced — step-host gates pass a
 *  file path (the gate step's `produces:`), aggregate-host gates pass the
 *  aggregate's return string. Both variants converge on the same retry
 *  loop afterwards. */
export type RetryGateZoneOpts =
  | {
      kind: 'step';
      initialVerdictPath: string;
      verdictField: string;
      approveWhen: string;
      maxRetries: number;
      onMaxExceeded: 'fail' | 'continue';
      gateAgent: string;
      /** Returns the next iteration's verdict PATH (the gate step's
       *  `produces:` after the retry attempt). */
      retry: (currentVerdict: string) => Promise<string>;
    }
  | {
      kind: 'aggregate';
      initialVerdict: string;
      approveWhen: string;
      maxRetries: number;
      onMaxExceeded: 'fail' | 'continue';
      gateAgent: string;
      /** Returns the next iteration's verdict STRING (the aggregate's
       *  re-fired return value). */
      retry: (currentVerdict: string) => Promise<string>;
    };

/** Retry-from-bind runtime helper. See RetryGateZoneOpts. */
export async function retryGateZone(opts: RetryGateZoneOpts): Promise<string> {
  // Single exhaustive narrowing for the `kind` discriminator — both verdict
  // sourcing (initial source string + later JSON-parse-or-passthrough) and
  // the exhaustion message's verdict_field clause read from the same
  // `if/else if/throw` chain. Folding the routing into one place means a
  // future malformed `kind` (e.g. a typo) fails loud at the first
  // `narrowKind` call rather than burning the retry budget on silent
  // mis-routing.
  function narrowKind<T>(
    onStep: (o: Extract<RetryGateZoneOpts, { kind: 'step' }>) => T,
    onAggregate: (o: Extract<RetryGateZoneOpts, { kind: 'aggregate' }>) => T,
  ): T {
    if (opts.kind === 'step') return onStep(opts);
    if (opts.kind === 'aggregate') return onAggregate(opts);
    throw new Error(
      `retryGateZone: unknown kind '${(opts as { kind: string }).kind}' — ` +
        `expected 'step' or 'aggregate'.`,
    );
  }

  async function readVerdict(source: string): Promise<string> {
    return narrowKind(
      async (stepOpts) => {
        // `z.looseObject` keeps reviewer-supplied extras (e.g. `details_md`)
        // from triggering unrecognized-key errors.
        const verdictSchema = z.looseObject({
          [stepOpts.verdictField]: z.string(),
        });
        const parsed = await readAgentFile(source, verdictSchema, stepOpts.gateAgent);
        return parsed[stepOpts.verdictField] as string;
      },
      // Aggregate-host gates pass the verdict string directly because the
      // aggregate primitive already extracted it.
      async (_aggOpts) => source,
    );
  }

  let current = narrowKind(
    (stepOpts) => stepOpts.initialVerdictPath,
    (aggOpts) => aggOpts.initialVerdict,
  );
  let currentVerdict = await readVerdict(current);

  if (currentVerdict.trim() === opts.approveWhen.trim()) {
    return current;
  }

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    console.log(
      `  ↻ Retry zone (gate '${opts.gateAgent}'): attempt ${attempt}/${opts.maxRetries} (last verdict: ${JSON.stringify(currentVerdict)})`,
    );
    current = await opts.retry(currentVerdict);
    currentVerdict = await readVerdict(current);
    if (currentVerdict.trim() === opts.approveWhen.trim()) {
      console.log(`  ✓ Retry zone (gate '${opts.gateAgent}') converged on attempt ${attempt + 1}`);
      return current;
    }
  }

  const totalAttempts = opts.maxRetries + 1;
  // `verdict_field` only exists on step-host gates; aggregate gates extract
  // the verdict inside the aggregate primitive itself, so the message only
  // surfaces the field name when it's actually load-bearing. Routed through
  // `narrowKind` so a malformed discriminator throws the same exhaustive
  // error as the verdict-source branches above, rather than silently
  // producing a step-shaped message for unknown kinds.
  const verdictFieldLabel = narrowKind(
    (stepOpts) => `verdict_field='${stepOpts.verdictField}', `,
    (_aggOpts) => '',
  );
  const continueTail = narrowKind(
    (_stepOpts) => `produces file`,
    (_aggOpts) => `verdict`,
  );
  const message =
    `Retry zone gated by '${opts.gateAgent}' exhausted max_retries=${opts.maxRetries} ` +
    `(${totalAttempts} total attempts). Last verdict: ${JSON.stringify(currentVerdict)} ` +
    `(${verdictFieldLabel}approve_when='${opts.approveWhen}').`;
  if (opts.onMaxExceeded === 'fail') {
    throw new HaltPipelineError(message);
  }
  console.warn(`  ⚠ ${message} Continuing past gate with last attempt's ${continueTail}.`);
  return current;
}
