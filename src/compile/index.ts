import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import {
  Pipeline,
  FlowItem,
  PipelineSpec,
  isStep,
  isReviewLoop,
  isParallel,
  isBranch,
  isAggregate,
  isForeach,
} from '../types.js';
import { AgentCli } from '../runtime/agent.js';
import { makeFresh, makeNextScopeId } from './flow-helpers.js';
import { validateAgentFilesExist } from './validation.js';
import { ProducerInfo } from './scope.js';
import { emit } from './emit-walker.js';

// Layered agent directories: project layer first, global layer second.
// Convention-driven by the pipeline's cli and asymmetric for copilot:
// GitHub Copilot CLI's documented project-level location is
// `.github/agents/` (not `.copilot/agents/`), while its global location
// is `~/.copilot/agents/`. Claude's convention is symmetric. Not
// configurable via a header field. The project layer MUST sit at
// `agentDirs[0]` because `cli.ts:absolutifyAgentDirsInEmit` hard-codes
// `idx === 0` for the chdir-anchored absolutification — passing
// `[globalLayer, projectLayer]` to the validator would still type-check
// and validate-pass (both layers exist conceptually) but would silently
// break the absolutification. The `satisfies` annotation compiler-
// enforces that every member of the `AgentCli` union has an entry, so
// adding a future cli (`gemini`, `codex`, ...) trips a type error here
// before the lookup at use-site can return `undefined`.
const AGENT_DIR_DEFAULTS = {
  claude: { project: '.claude/agents/', global: '~/.claude/agents/' },
  copilot: { project: '.github/agents/', global: '~/.copilot/agents/' },
} as const satisfies Record<AgentCli, { project: string; global: string }>;

// Re-export the public retry-gate cursor-check helper consumed by cli.ts;
// the canonical implementation lives in retry-gate.ts, but cli.ts (per the
// pre-split surface) imports it from the compile module's entry point.
export { readRetryGateForCursorCheck } from './retry-gate.js';

/** Walk the whole flow once (descending into compound bodies) and return
 *  true iff any retry gate (step's `on_fail` OR aggregate's top-level
 *  `retry_from`) appears anywhere. Used to decide whether to include
 *  `retryGateZone` in the emitted file's runtime imports — keeping the
 *  import list minimal for pipelines that don't use the feature. */
function flowHasRetryGate(flow: FlowItem[]): boolean {
  for (const item of flow) {
    if (isStep(item)) {
      if (item.on_fail !== undefined) return true;
    } else if (isAggregate(item)) {
      if (item.aggregate.retry_from !== undefined) return true;
    } else if (isReviewLoop(item)) {
      const r = item.review_loop;
      if (Array.isArray(r.reviewer) && flowHasRetryGate(r.reviewer)) return true;
    } else if (isParallel(item)) {
      if (flowHasRetryGate(item.parallel)) return true;
    } else if (isBranch(item)) {
      const b = item.branch;
      if (flowHasRetryGate(b.then)) return true;
      if (b.else && flowHasRetryGate(b.else)) return true;
    } else if (isForeach(item)) {
      if (flowHasRetryGate(item.foreach.body)) return true;
    }
  }
  return false;
}

/** Walk the whole flow once (descending into compound bodies) and return
 *  true iff any `branch:` appears anywhere. Used to decide whether to
 *  include `readJson` / `readText` / `fileExists` in the emitted file's
 *  runtime imports — keeping the import list minimal for pipelines that
 *  don't use the feature. Sister-helper to `flowHasRetryGate` (which gates
 *  the `retryGateZone` import on the same suffix-append principle).
 *
 *  Descends into `review_loop.reviewer`, `parallel`, `branch.then`, and
 *  `branch.else` — the same compound bodies `flowHasRetryGate` walks, so
 *  the two predicates stay shape-aligned. A future primitive that wraps a
 *  body (e.g. `foreach`) extends every `flowHas*` walker by adding a
 *  recursion arm in the same edit, keeping the conditional-import contract
 *  intact across all helpers. */
function flowHasBranch(flow: FlowItem[]): boolean {
  for (const item of flow) {
    if (isBranch(item)) return true;
    if (isReviewLoop(item)) {
      const r = item.review_loop;
      if (Array.isArray(r.reviewer) && flowHasBranch(r.reviewer)) return true;
    } else if (isParallel(item)) {
      if (flowHasBranch(item.parallel)) return true;
    } else if (isBranch(item)) {
      // Unreachable today — the outer `if (isBranch(item)) return true` at
      // the top of the loop short-circuits before this arm fires — but kept
      // for shape-alignment with flowHasRetryGate. If the outer predicate
      // ever tightens (e.g. "any branch with a $-prefix substitution"), the
      // descent into branch arms becomes load-bearing.
      const b = item.branch;
      if (flowHasBranch(b.then)) return true;
      if (b.else && flowHasBranch(b.else)) return true;
    } else if (isForeach(item)) {
      // A branch nested inside a foreach body should still gate the
      // branch.when: helpers into the runtime import. Same descent pattern
      // as parallel / review_loop above.
      if (flowHasBranch(item.foreach.body)) return true;
    }
  }
  return false;
}

/** Walk the whole flow once (descending into compound bodies) and return
 *  true iff any `foreach:` appears anywhere. Used to gate the `foreach`
 *  symbol into the runtime import. Descends through every compound body
 *  so a foreach nested inside parallel / branch / review_loop subflow /
 *  another foreach still flips the flag. */
function flowHasForeach(flow: FlowItem[]): boolean {
  for (const item of flow) {
    if (isForeach(item)) return true;
    if (isReviewLoop(item)) {
      const r = item.review_loop;
      if (Array.isArray(r.reviewer) && flowHasForeach(r.reviewer)) return true;
    } else if (isParallel(item)) {
      if (flowHasForeach(item.parallel)) return true;
    } else if (isBranch(item)) {
      const b = item.branch;
      if (flowHasForeach(b.then)) return true;
      if (b.else && flowHasForeach(b.else)) return true;
    }
  }
  return false;
}

/** Compile options. `runtimeImport` overrides the default `'agenticloom/runtime'`
 *  bare-package import — used by `loom run` to inject an absolute `file://`
 *  URL to the installed runtime so the temp pipeline can resolve without
 *  depending on the user's cwd having loom in node_modules. */
export interface CompileOptions {
  runtimeImport?: string;
  /** Optional resume cursor. When set, names a top-level bind whose
   *  preceding top-level items are skipped at emit time (rewritten as
   *  bind-assignments to path-string literals for anchored producers, or
   *  `undefined` for non-anchored producers). The cursor primitive and
   *  every post-cursor item emit normally. The caller is responsible for
   *  validating that the cursor names a top-level bind (or a hoisted
   *  parallel child) in the resolved pipeline before calling `compile()` —
   *  see `src/cli.ts:main()`'s `run`-branch validation sequence. A cursor
   *  that doesn't match any top-level bind triggers a defensive throw
   *  (internal compile error — the cli.ts→compile/index.ts contract has drifted). */
  resumeFrom?: string;
}

/** Parse + zod-validate a YAML pipeline file. Exported for callers that
 *  want the typed spec without going through `compile` (e.g., the mermaid
 *  view emitter, which renders structure but doesn't need agent-file
 *  existence checks or TS emission). `compile()` delegates to this for the
 *  parse phase so both code paths share the same validation. */
export function parseSpec(yamlPath: string): PipelineSpec {
  const raw = parseYaml(readFileSync(yamlPath, 'utf-8'));
  return Pipeline.parse(raw);
}

export function compile(yamlPath: string, options?: CompileOptions): string {
  const fresh = makeFresh();
  const nextScopeId = makeNextScopeId();
  const spec = parseSpec(yamlPath);
  const sig = spec.inputs.join(', ');

  const projectLayer = AGENT_DIR_DEFAULTS[spec.cli].project;
  const globalLayer = AGENT_DIR_DEFAULTS[spec.cli].global;
  const agentDirs: string[] = [projectLayer, globalLayer];
  validateAgentFilesExist(spec.flow, agentDirs, `pipeline '${spec.pipeline}'`);

  // Allocate the top-level scope ID before declaring inputs so inputs
  // and the top-level emit body share the same `declarationScope` —
  // otherwise a top-level step's `retry_from: <pipelineInput>` would trip
  // the cross-scope check spuriously, masking the more accurate "inputs
  // are not valid retry_from targets" message. The on_fail resolution
  // block rejects `kind === 'input'` targets explicitly (see the input-
  // rejection branch in step emit) so the cross-scope check isn't the
  // last line of defense here.
  const topScopeId = nextScopeId();

  // Pipeline inputs are opaque CLI args, not produced by an agent — they
  // never trip the file-bound check.
  const scope = new Map<string, ProducerInfo>();
  for (const name of spec.inputs) {
    scope.set(name, {
      kind: 'input',
      fileBound: true,
      location: `pipeline input '${name}'`,
      fileField: '',
      agentName: `pipeline input '${name}'`,
      declarationScope: topScopeId,
    });
  }
  const runtimeImport = options?.runtimeImport ?? 'agenticloom/runtime';
  const defaultExtraArgsLiteral =
    spec.default_extra_args !== undefined ? JSON.stringify(spec.default_extra_args) : '[]';
  // Emit a symmetric length guard before the inputs destructure. Under-supply
  // burns money on `undefined` template-interpolated into agent prompts;
  // over-supply silently drops the user's intended extra args. Either is a
  // confusing UX — fail loud on both. `!== N` covers both directions; the
  // rendered error names the count received either way.
  const inputsList = spec.inputs.length > 0 ? ` (${spec.inputs.join(', ')})` : '';
  const expectedMsg = `Error: pipeline '${spec.pipeline}' expects ${spec.inputs.length} input(s)${inputsList}; received `;
  const argvSetup: string[] = [
    `const __args = process.argv.slice(2);`,
    `if (__args.length !== ${spec.inputs.length}) {`,
    `  console.error(${JSON.stringify(expectedMsg)} + __args.length + '.');`,
    `  process.exit(1);`,
    `}`,
  ];
  if (spec.inputs.length > 0) {
    argvSetup.push(`const [${spec.inputs.join(', ')}] = __args;`);
  }
  // Conditional runtime-import suffixes. Each `flowHas*` predicate gates
  // one fragment of the import suffix. Suffix-style append (rather than
  // building the list dynamically) preserves the exact order of existing
  // imports — required for byte-identical output on pipelines that don't
  // use the feature.
  //
  // Stable suffix order across v0.1.0 plans (so adding a new predicate
  // doesn't force back-edits of earlier plans' fragments): `retryGateZone`,
  // then the `branch.when:` helpers (`readJson`, `readText`, `fileExists`),
  // then any future foreach / HaltPipelineError fragments. The order is
  // fixed regardless of which fragments are present; predicates with
  // false-results contribute nothing, so the prelude line stays
  // unchanged from the no-gated-features baseline for pipelines that use
  // none of the gated features.
  const retrySuffix = flowHasRetryGate(spec.flow) ? ', retryGateZone' : '';
  const branchHelperSuffix = flowHasBranch(spec.flow) ? ', readJson, readText, fileExists' : '';
  const foreachSuffix = flowHasForeach(spec.flow) ? ', foreach' : '';
  const importSuffix = retrySuffix + branchHelperSuffix + foreachSuffix;
  return [
    `// AUTO-GENERATED from ${yamlPath} — edit the YAML and recompile.`,
    `import { runAgent, reviewLoop, humanGate, parallel, aggregate${importSuffix} } from ${JSON.stringify(runtimeImport)};`,
    ``,
    `const CLI = ${JSON.stringify(spec.cli)};`,
    `const AGENT_DIRS = ${JSON.stringify(agentDirs)};`,
    `const DEFAULT_EXTRA_ARGS = ${defaultExtraArgsLiteral};`,
    ``,
    `async function main(${sig}) {`,
    ...emit(
      spec.flow,
      '  ',
      scope,
      fresh,
      agentDirs,
      nextScopeId,
      topScopeId,
      undefined,
      options?.resumeFrom,
    ),
    `}`,
    ``,
    ...argvSetup,
    // The emitted catch references `e.name === 'ZodError'` and `e.issues` —
    // both APIs survive in zod v4 (the ZodError class name is preserved, and
    // .issues is canonical in v4; v3's .errors was removed). No emit-string
    // changes needed for the zod v4 migration.
    `main(${spec.inputs.join(', ')}).catch(e => {`,
    `  if (process.env.LOOM_DEBUG) {`,
    `    console.error(e);`,
    `  } else if (e && e.name === 'ZodError' && Array.isArray(e.issues)) {`,
    `    console.error('Pipeline schema error:');`,
    `    for (const issue of e.issues) {`,
    `      const where = issue.path.length ? issue.path.join('.') : '(root)';`,
    '      console.error(`  - ${where}: ${issue.message}`);',
    `    }`,
    `    console.error('(set LOOM_DEBUG=1 to see the full stack)');`,
    `  } else {`,
    '    console.error(`Error: ${e?.message ?? e}`);',
    `    console.error('(set LOOM_DEBUG=1 to see the full stack)');`,
    `  }`,
    `  process.exit(1);`,
    `});`,
    ``,
  ].join('\n');
}
