import * as path from 'path';
import { z } from 'zod/v4';
import { runAgent, HaltPipelineError } from './agent.js';
import type { RunAgentOpts, AgentCli } from './agent.js';
import { readAgentFile } from './read-agent-file.js';

/** Per-reviewer entry the compound subflow returns to the loop on each
 *  iteration. agentName + path are what the writer's revise prompt references. */
export interface ReviewerPathInfo {
  agentName: string;
  path: string;
}

/** Options for the single-reviewer review_loop shape. See reviewLoop. */
export interface SingleReviewerOpts {
  kind: 'single';
  cli: AgentCli;
  /** Layered persona-file lookup directories — see `RunAgentOpts.agentDirs`
   *  for the contract. The reviewLoop threads this through to both writer
   *  and reviewer `runAgent` calls verbatim. */
  agentDirs: string[];
  defaultExtraArgs: string[];
  writer: string;
  reviewer: string;
  /** Optional inline (general-agent) baked prompts for the writer and reviewer.
   *  When a field is set, that agent's `runAgent` calls take the inline spawn
   *  form — the baked prompt becomes the agent's identity and no `--agent` flag
   *  is passed (see `RunAgentOpts.inlinePrompt`); undefined selects the persona
   *  form, where the CLI resolves the `writer`/`reviewer` label's persona file
   *  via `--agent`. The label string stays the display/log name in both forms. */
  writerInlinePrompt?: string;
  reviewerInlinePrompt?: string;
  input: string;
  maxIters?: number;
  approveWhen?: string;
  onMaxExceeded?: 'fail' | 'continue';
  writerProduces: string;
  reviewerProduces: string;
  verdictField: string;
}

/** Options for the compound (subflow-based) review_loop shape. See reviewLoop. */
export interface CompoundReviewerOpts {
  kind: 'compound';
  cli: AgentCli;
  /** Layered persona-file lookup directories — see `RunAgentOpts.agentDirs`
   *  for the contract. The reviewLoop threads this through to the writer
   *  and to the compiler-synthesized reviewer subflow verbatim. */
  agentDirs: string[];
  defaultExtraArgs: string[];
  writer: string;
  /** Optional inline (general-agent) baked prompt for the writer — semantics
   *  match `SingleReviewerOpts.writerInlinePrompt`. The compound reviewer is a
   *  subflow (its inner reviewer steps carry their own inline handling), so
   *  this shape has no single-reviewer inline-prompt field. */
  writerInlinePrompt?: string;
  reviewerSubflow: (draftPath: string) => Promise<{
    verdict: string;
    reviewerPaths: ReviewerPathInfo[];
  }>;
  input: string;
  maxIters?: number;
  approveWhen?: string;
  onMaxExceeded?: 'fail' | 'continue';
  writerProduces: string;
}

export type ReviewLoopOpts = SingleReviewerOpts | CompoundReviewerOpts;

/** Discriminator: only the compound shape carries reviewerSubflow. Both shapes
 *  share writer/writerProduces/input/maxIters/approveWhen. */
function isCompoundOpts(opts: ReviewLoopOpts): opts is CompoundReviewerOpts {
  return opts.kind === 'compound';
}

/** writer → reviewer cycle. Returns the writer's artifact path.
 *
 *  Two reviewer shapes:
 *
 *  Single (SingleReviewerOpts): writer writes the artifact to `writerProduces`;
 *  the reviewer is invoked with that path (not the artifact body) and reads it
 *  via its own Read tool. The reviewer writes a JSON verdict to
 *  `reviewerProduces`; loom reads it via the JSON contract helper, extracts
 *  `parsed[verdictField]`, and approves when that value equals `approveWhen`
 *  (default `'pass'`). On fail, the writer is re-invoked with a revise prompt
 *  pointing at both the previous draft and the reviewer's full output file.
 *
 *  Compound (CompoundReviewerOpts): the reviewer is a subflow (typically
 *  parallel reviewers + aggregate) compiled into the `reviewerSubflow`
 *  callback. Each iteration calls the callback with the
 *  current draft path; the callback returns `{verdict, reviewerPaths}` where
 *  `verdict` is the aggregate's already-extracted overall verdict string and
 *  `reviewerPaths` is the list of per-reviewer output files. On fail, the
 *  writer is re-invoked with a revise prompt that names every reviewer file
 *  individually plus the overall verdict in text framing. No derived
 *  REVIEW.md is ever written; the prompt is synthesized in-memory from the
 *  in-memory verdict + paths.
 *
 *  In both shapes, no artifact content is ever embedded into any prompt; the
 *  orchestrator passes paths and agents read them with their own Read tool. */
export async function reviewLoop(opts: ReviewLoopOpts): Promise<string> {
  const max = opts.maxIters ?? 3;
  const approve = opts.approveWhen ?? 'pass';
  // Absolutify locally — `writerPath` and (single-mode) `reviewerPath`
  // appear verbatim in the in-function revise/reviewer-input prompts AND get
  // passed into runAgent as `producesPath`. runAgent absolutifies its own
  // parameter, but the in-function prompt construction (lines below) reads
  // the local variables directly; absolutifying here keeps the variables and
  // the prompts consistent with the bind-value-is-absolute invariant from
  // runAgent.
  const writerPath = path.resolve(opts.writerProduces);
  const writerOpts: RunAgentOpts = {
    cli: opts.cli,
    agentDirs: opts.agentDirs,
    extraArgs: opts.defaultExtraArgs,
    role: 'writer',
    // `writerInlinePrompt` is present on both opts shapes, so it reads off the
    // union directly. A string routes every writer spawn (initial draft +
    // revises) through runAgent's inline form; undefined leaves the persona
    // `--agent` form untouched.
    inlinePrompt: opts.writerInlinePrompt,
  };
  const reviewerOpts: RunAgentOpts = {
    cli: opts.cli,
    agentDirs: opts.agentDirs,
    extraArgs: opts.defaultExtraArgs,
    role: 'reviewer',
    // `reviewerInlinePrompt` lives only on the single-reviewer shape — the
    // compound reviewer is a subflow with no single reviewer — so narrow on the
    // discriminator before reading it (a union read would not typecheck).
    // reviewerOpts is consumed only in the single-reviewer branch below, where
    // this resolves to the field.
    inlinePrompt: isCompoundOpts(opts) ? undefined : opts.reviewerInlinePrompt,
  };

  let draft = await runAgent(opts.writer, opts.input, writerPath, writerOpts);

  for (let i = 1; i <= max; i++) {
    if (isCompoundOpts(opts)) {
      const { verdict, reviewerPaths } = await opts.reviewerSubflow(writerPath);
      if (verdict.trim() === approve.trim()) {
        console.log(
          `  ✓ compound reviewer approved on iteration ${i} (${reviewerPaths.length}/${reviewerPaths.length} approved)`,
        );
        return draft;
      }
      if (i === max) {
        const onMaxExceeded = opts.onMaxExceeded ?? 'continue';
        const message =
          `review_loop '${opts.writer}' exhausted max_iters=${max} without approval.\n` +
          `Last verdict: '${verdict}' (approve_when='${approve}'); the verdict was extracted by the inner aggregate.`;
        if (onMaxExceeded === 'fail') {
          throw new HaltPipelineError(message);
        }
        console.warn(`  ⚠ ${message} Returning last draft.`);
        return draft;
      }
      console.log(`  ↻ Iteration ${i}/${max}: revising (compound reviewer)`);
      draft = await runAgent(
        opts.writer,
        buildCompoundRevisePrompt(writerPath, verdict, reviewerPaths),
        writerPath,
        writerOpts,
      );
    } else {
      // Same canonical-absolute-path treatment as writerPath. Inline rather
      // than hoisting alongside writerPath because reviewerProduces only
      // exists on SingleReviewerOpts — the compound branch above has no
      // single reviewer file.
      const reviewerPath = path.resolve(opts.reviewerProduces);
      const reviewerInput = `The artifact to review is at: ${writerPath}\nRead it with your Read tool, then evaluate it against your reviewer role.`;
      const reviewPath = await runAgent(opts.reviewer, reviewerInput, reviewerPath, reviewerOpts);
      const schema = z.looseObject({ [opts.verdictField]: z.string() });
      // The closure overwrites the reviewer's existing `produces:` file — no
      // derived path, no separate retry artifact.
      const rewriteProducerFile = async (correctivePrompt: string): Promise<void> => {
        await runAgent(opts.reviewer, correctivePrompt, reviewerPath, reviewerOpts);
      };
      const parsed = await readAgentFile(reviewPath, schema, opts.reviewer, rewriteProducerFile);
      const verdict = parsed[opts.verdictField] as string;
      if (verdict.trim() === approve.trim()) {
        console.log(`  ✓ ${opts.reviewer} approved on iteration ${i}`);
        return draft;
      }
      if (i === max) {
        const onMaxExceeded = opts.onMaxExceeded ?? 'continue';
        const message =
          `review_loop '${opts.writer}' exhausted max_iters=${max} without approval.\n` +
          `Last verdict: '${verdict}' (verdict_field='${opts.verdictField}', approve_when='${approve}').`;
        if (onMaxExceeded === 'fail') {
          throw new HaltPipelineError(message);
        }
        console.warn(`  ⚠ ${message} Returning last draft.`);
        return draft;
      }
      console.log(`  ↻ Iteration ${i}/${max}: revising`);
      const revisePrompt = `Your previous draft is at: ${writerPath}\nRead it with your Read tool.\n\nThe reviewer's feedback is at: ${reviewerPath}\nRead that file and address every blocker/major finding.\n\nRevise the artifact and overwrite ${writerPath} with the revised version.`;
      draft = await runAgent(opts.writer, revisePrompt, writerPath, writerOpts);
    }
  }
  return draft;
}

/** Build the writer's revise prompt for a compound-reviewer iteration.
 *
 *  Mirrors the single-reviewer revise prompt's structure (previous-draft path
 *  + reviewer feedback paths + "address findings + overwrite") but lists the N
 *  reviewer paths with the same agent-name framing `wrapPathRef` uses for
 *  input refs, and surfaces the aggregate's overall verdict string in the
 *  prompt's text framing. No file is written; the prompt is in-memory text
 *  only. */
function buildCompoundRevisePrompt(
  writerPath: string,
  overallVerdict: string,
  reviewerPaths: ReviewerPathInfo[],
): string {
  if (reviewerPaths.length === 0)
    throw new Error('buildCompoundRevisePrompt: reviewerPaths must be non-empty');
  const total = reviewerPaths.length;
  const lines: string[] = [];
  lines.push(`Your previous draft is at: ${writerPath}`);
  lines.push(`Read it with your Read tool.`);
  lines.push('');
  lines.push(
    `${total} reviewer${total === 1 ? '' : 's'} examined your draft (overall verdict: ${overallVerdict}):`,
  );
  for (const r of reviewerPaths) {
    lines.push(`- ${r.agentName} finished its work. Its output is at: ${r.path}`);
  }
  lines.push('');
  lines.push(
    `Read each reviewer file with your Read tool. Address every blocker and major finding across all reviewers. Nits are optional. Overwrite ${writerPath} with the revised version.`,
  );
  return lines.join('\n');
}
