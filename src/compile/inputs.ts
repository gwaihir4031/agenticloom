import { FlowItem, StepItemT, isStep, isReviewLoop, isParallel } from '../types.js';
import { escapeTplLit } from './flow-helpers.js';
import { ProducerInfo, wrapPathRef } from './scope.js';

/** Compile-time emit-slot description for a path-bound producer inside a
 *  reviewer subflow. Distinct from `runtime/review-loop.ts`'s `ReviewerPathInfo` — that
 *  carries the resolved file path at execution time; this carries the in-scope
 *  bind identifier the emitted code will reference. Used to build the
 *  `reviewerPaths` array the runtime hands the writer on revise. File-local
 *  — only consumed by `collectReviewerPaths` and its caller. */
interface ReviewerPathSlot {
  agentName: string;
  bindName: string;
}

/** Walk the reviewer subflow once at compile time; yield (agentName,
 *  bindName) pairs for every path-bound producer. The terminal aggregate is
 *  not file-bound and is excluded. Branches inside the subflow are intentionally
 *  not walked — the only currently-supported subflow shape is `parallel` of
 *  reviewers + `aggregate`. Extend here if a future YAML structure needs it. */
export function collectReviewerPaths(subflow: FlowItem[]): ReviewerPathSlot[] {
  const out: ReviewerPathSlot[] = [];
  function walk(item: FlowItem): void {
    if (isStep(item)) {
      if (item.produces && item.bind) {
        out.push({ agentName: item.step, bindName: item.bind });
      }
    } else if (isReviewLoop(item)) {
      const r = item.review_loop;
      if (r.bind) {
        out.push({ agentName: r.writer, bindName: r.bind });
      }
    } else if (isParallel(item)) {
      for (const child of item.parallel) walk(child);
    }
  }
  for (const item of subflow) walk(item);
  return out;
}

/** Compile-time substitution for `step.input` / `review_loop.input`. Path-bound
 *  `$ref`s are wrapped with provenance + read instruction; pipeline inputs
 *  (text) and literal strings pass through unwrapped. */
export function inputExprFor(expr: string | undefined, scope: Map<string, ProducerInfo>): string {
  if (expr === undefined) return '""';
  if (!expr.startsWith('$')) return JSON.stringify(expr);
  const refName = expr.slice(1);
  const info = scope.get(refName);
  if (info === undefined) return refName;
  if (info.kind === 'input') return refName;
  return wrapPathRef(refName, info);
}

/** Compile-time substitution for `branch.when:` expressions. Strips the `$`
 *  prefix from `$identifier` tokens that resolve to a known bind in scope,
 *  matching the convention used by `step.input` / `step.inputs` /
 *  `revise_with.inputs:` / `aggregate.inputs:`. After substitution, the
 *  emitted JS sees the bare identifier — which IS the bind variable in
 *  scope at the branch's emit site.
 *
 *  Hand-rolled tokenizer rather than a parser dependency: the substitution
 *  is a narrow string-rewrite, not a JS-parse-and-rewrite, so a single-pass
 *  character walk with string-literal-state tracking is sufficient. A real
 *  JS parser (e.g. `@babel/parser`) would add a dependency and a parse-error
 *  surface for what's already a permissive `z.string()` field.
 *
 *  Rules:
 *
 *  1. **Outside string literals**, `$identifier` (regex
 *     `/\$([a-zA-Z_][a-zA-Z0-9_]*)/`) is eligible for substitution when the
 *     `$` is NOT preceded by an identifier character (so `cls$foo` is one
 *     JS identifier, NOT a candidate for substitution).
 *  2. **Substitution is scope-aware via set-membership only:** if
 *     `scope.has(identifier)` is true, strip the `$`. Otherwise leave the
 *     `$identifier` verbatim — it surfaces as a runtime `ReferenceError`
 *     when the emitted JS evaluates, the same diagnostic an unresolved
 *     bind reference produces.
 *  3. **Inside string literals (single, double, template)**, `$identifier`
 *     is left untouched. Template-literal `${...}` interpolations open a
 *     non-string region where substitution fires again; balanced `{}` inside
 *     interpolations are tracked via a depth counter.
 *  4. **Backslash escapes inside string literals** consume the next
 *     character verbatim. Naive 1-char-after-backslash is correct for the
 *     common cases (`\'`, `\"`, `` \` ``, `\\`, `\n`, `\t`) and sufficient
 *     for substitution correctness on multi-char escapes (`\xFF`, `\uABCD`):
 *     substitution only fires outside string literals, so escape-length
 *     inside a literal doesn't affect whether the closing quote is
 *     recognized.
 *  5. **The substitution is non-failing.** Unknown `$identifier` patterns
 *     surface as a runtime ReferenceError when the emitted JS runs. The
 *     emit prelude provides `readJson` / `readText` / `fileExists` as bare
 *     function names — those are not `$`-prefixed in user pipelines and so
 *     trivially skip the substitution rule. */
export function substituteBindRefs(when: string, scope: { has(name: string): boolean }): string {
  type StringState = 'none' | 'single' | 'double' | 'template';
  const out: string[] = [];
  let stringState: StringState = 'none';
  // Stack of template-literal states each push/pop matches a `${...}`
  // interpolation opening / closing. The active state at the top tells the
  // tokenizer the brace depth inside the current interpolation; when it
  // drops to zero on a `}`, the outer template state restores.
  const templateStack: Array<{ braceDepth: number }> = [];
  const isIdChar = (c: string): boolean => /[a-zA-Z0-9_]/.test(c);
  const isIdStart = (c: string): boolean => /[a-zA-Z_]/.test(c);

  for (let i = 0; i < when.length; i++) {
    const c = when[i];

    if (stringState !== 'none') {
      // Inside a string literal: track escapes + closing quote. `$identifier`
      // inside the literal is not substituted.
      if (c === '\\' && i + 1 < when.length) {
        out.push(c);
        out.push(when[i + 1]);
        i++;
        continue;
      }
      if (stringState === 'single' && c === "'") {
        stringState = 'none';
        out.push(c);
        continue;
      }
      if (stringState === 'double' && c === '"') {
        stringState = 'none';
        out.push(c);
        continue;
      }
      if (stringState === 'template') {
        if (c === '`') {
          stringState = 'none';
          out.push(c);
          continue;
        }
        if (c === '$' && when[i + 1] === '{') {
          // Open a `${...}` interpolation: leave template state, track
          // brace depth so the matching `}` restores it.
          templateStack.push({ braceDepth: 1 });
          stringState = 'none';
          out.push(c);
          out.push('{');
          i++;
          continue;
        }
      }
      out.push(c);
      continue;
    }

    // stringState === 'none' below: substitution is active.

    // Template-interpolation brace tracking. `{` and `}` outside any string
    // increment/decrement the active interpolation's depth; reaching 0 on a
    // `}` closes the interpolation and restores the enclosing template
    // state.
    if (templateStack.length > 0) {
      const top = templateStack[templateStack.length - 1];
      if (c === '{') {
        top.braceDepth++;
        out.push(c);
        continue;
      }
      if (c === '}') {
        top.braceDepth--;
        if (top.braceDepth === 0) {
          templateStack.pop();
          stringState = 'template';
        }
        out.push(c);
        continue;
      }
    }

    // String-literal openings outside any string literal.
    if (c === "'") {
      stringState = 'single';
      out.push(c);
      continue;
    }
    if (c === '"') {
      stringState = 'double';
      out.push(c);
      continue;
    }
    if (c === '`') {
      stringState = 'template';
      out.push(c);
      continue;
    }

    // `$identifier` substitution candidate. The `$` must not be a
    // continuation of an outer JS identifier (e.g. `cls$foo` is one
    // identifier; the `$` at position 3 is NOT a substitution site).
    if (c === '$') {
      const prev = i > 0 ? when[i - 1] : '';
      const next = i + 1 < when.length ? when[i + 1] : '';
      if ((i === 0 || !isIdChar(prev)) && isIdStart(next)) {
        // Read the candidate identifier.
        let j = i + 1;
        while (j < when.length && isIdChar(when[j])) j++;
        const ident = when.slice(i + 1, j);
        if (scope.has(ident)) {
          // Drop the `$`, keep the identifier verbatim.
          out.push(ident);
          i = j - 1;
          continue;
        }
        // Unknown identifier — leave `$identifier` verbatim. The emitted JS
        // will produce a runtime ReferenceError, surfacing the typo or
        // refactor leftover rather than silently masking it.
      }
      out.push(c);
      continue;
    }

    out.push(c);
  }

  return out.join('');
}

/** Compile-time substitution for a labeled multi-input map. Each entry is
 *  formatted per its source kind: pipeline inputs and literal strings render
 *  as `${label}: ${value}`; path-bound refs render as `${agentName} finished
 *  its work. Its output is at: ${path} (labeled: ${label})`. A trailing
 *  "Read the input files…" line is appended iff at least one entry is
 *  path-bound. Emits a `[...].join('\\n\\n')` expression so each part can
 *  be either a JSON-quoted literal or a template literal referencing a JS
 *  identifier in scope. */
export function multiInputExpr(
  inputs: Record<string, string>,
  scope: Map<string, ProducerInfo>,
): string {
  const parts: string[] = [];
  let hasPath = false;
  for (const [label, expr] of Object.entries(inputs)) {
    if (!expr.startsWith('$')) {
      parts.push(JSON.stringify(`${label}: ${expr}`));
      continue;
    }
    const refName = expr.slice(1);
    const info = scope.get(refName);
    if (info === undefined || info.kind === 'input') {
      parts.push('`' + escapeTplLit(label) + ': ${' + refName + '}`');
      continue;
    }
    hasPath = true;
    parts.push(
      '`' +
        escapeTplLit(info.agentName) +
        ' finished its work. Its output is at: ${' +
        refName +
        '} (labeled: ' +
        escapeTplLit(label) +
        ')`',
    );
  }
  if (hasPath) {
    parts.push(JSON.stringify('Read the input files with your Read tool, then perform your task.'));
  }
  return '[' + parts.join(', ') + "].join('\\n\\n')";
}

/** Validate a `$ref` at a consume site against the current scope.
 *
 *  Two error modes:
 *  1. Unknown bind — the name has never been declared anywhere reachable
 *     from this site. Catches typos and ordering bugs.
 *  2. Not file-bound — the name was declared, but its producer has no
 *     `produces:` / `writer_produces:` set, or it is an aggregate (which
 *     no longer has a file-bound output). Consuming such a bind would mean
 *     the orchestrator pipes the producer's stdout — or aggregate's in-memory
 *     verdict string — into the consumer's prompt. That violates loom's
 *     file-bound I/O contract (every cross-step value is a file path).
 *
 *  Pass-through for literal strings (non-`$` values). */
export function checkConsume(
  expr: string | undefined,
  consumeSiteLabel: string,
  scope: Map<string, ProducerInfo>,
): void {
  if (expr === undefined) return;
  if (!expr.startsWith('$')) return;
  const refName = expr.slice(1);
  const info = scope.get(refName);
  if (info === undefined) {
    throw new Error(
      `Compile error: ${consumeSiteLabel} references unknown bind '$${refName}'. ` +
        `No producer (or pipeline input) declares that name in scope.`,
    );
  }
  if (!info.fileBound) {
    let remedy: string;
    if (info.kind === 'foreach') {
      // List-bound rejection. The bind resolves to a list of iter-N/
      // directory paths; consuming a list-of-paths bind via step.input is
      // not supported — no list-iterator primitive exists yet. The bind is
      // still ADMISSIBLE as a `retry_from:` target (whole-foreach replay)
      // and as a `--resume-from` cursor (replays from iter-0); only `$ref`
      // consumption is rejected. Throw the full diagnostic here rather
      // than the generic "no file-bound output" wrapper below — the user
      // needs the alternatives explicitly listed.
      throw new Error(
        `Compile error: ${consumeSiteLabel} references '$${refName}', whose producer ` +
          `foreach (bind '${refName}') is list-bound. v1 does not support consuming ` +
          `a list-of-paths bind via step.input — no list-iterator primitive exists.\n\n` +
          `Either:\n` +
          `  - Use the bind only as a 'retry_from:' target or a '--resume-from' cursor, OR\n` +
          `  - Remove the $ref consumer at ${consumeSiteLabel}.`,
      );
    }
    if (info.kind === 'parallel') {
      // A parallel block produces N outputs (one per child), not one — so a
      // `$ref` to the parallel bind cannot resolve to a single file. The
      // user almost certainly wants either a specific child's output or an
      // aggregate of them. List the explicit child binds when present so
      // the remedy is concrete; if every child was unbound, the user has no
      // way to reach them by name and aggregation is the only path forward.
      const childBindList = (info.parallelChildBinds ?? []).map((b) => `$${b}`).join(', ');
      remedy =
        `bind '${refName}' identifies a parallel block, which has multiple outputs ` +
        `(one per child). Use individual child binds${childBindList ? ` (e.g. ${childBindList})` : ''} ` +
        `or aggregate them first.`;
    } else if (info.kind === 'branch') {
      // Branch with `bind:` reaches the not-file-bound branch only when the
      // explicit-rejoin classification rejected the arms — every consumable
      // branch's ProducerInfo has `fileBound: true`. The classification's
      // `reason` discriminates the per-arm error rendering.
      const consumability = info.branchConsumability;
      if (consumability === undefined) {
        throw new Error(
          `Internal compile error: checkConsume reached the branch-rejection path for '${refName}' ` +
            `with no branchConsumability set. The branch emit (or pre-cursor rewrite) should have ` +
            `populated this field before any downstream $ref consumer could fire.`,
        );
      }
      if (consumability.consumable === true) {
        throw new Error(
          `Internal compile error: checkConsume reached the branch-rejection path for a CONSUMABLE ` +
            `branch bind '${refName}'. ProducerInfo.fileBound should match consumability.consumable; ` +
            `the file-bound check above this branch should have admitted the consumption.`,
        );
      }
      switch (consumability.reason.kind) {
        case 'missing_else': {
          throw new Error(
            `Compile error: ${consumeSiteLabel} references '$${refName}'. ` +
              `branch (bind '${refName}') is consumed via $ref by ${consumeSiteLabel}, but the ` +
              `branch has no 'else:' arm. The bind would be unset when 'when:' is false.\n\n` +
              `Either:\n` +
              `  - Add an 'else:' arm whose terminal is a file-bound producer, OR\n` +
              `  - Remove the $ref consumer at ${consumeSiteLabel}.`,
          );
        }
        case 'arm_terminal_not_file_bound': {
          // `terminalLabel` already surfaces the deepest non-file-bound
          // offender — `classifyArmTerminal`'s recursive call composes the
          // nested-branch failure chain into the label inline, so no walk
          // is needed here.
          const r = consumability.reason;
          throw new Error(
            `Compile error: ${consumeSiteLabel} references '$${refName}'. ` +
              `branch (bind '${refName}') is consumed via $ref by ${consumeSiteLabel}, but its ` +
              `${r.arm}-arm terminal ${r.terminalLabel} is not file-bound. The bind ` +
              `would have no defined value when the ${r.arm} arm runs.\n\n` +
              `Either:\n` +
              `  - Add 'produces:' to ${r.terminalLabel} (or end the ${r.arm} arm with a different file-bound producer), OR\n` +
              `  - Remove the $ref consumer at ${consumeSiteLabel}.`,
          );
        }
        case 'mixed_arm_kinds': {
          throw new Error(
            `Internal compile error: branch '${refName}' classified as mixed_arm_kinds but v1's ` +
              `classifier doesn't construct this reason. The string-bound branch arm extension ` +
              `must have landed partially without updating this dispatch.`,
          );
        }
      }
      // Exhaustive switch above throws on every branch; TS narrows
      // `consumability.reason` to `never` here. Defensive assignment so the
      // function still type-checks if the union ever grows a new variant.
      remedy = `Internal compile error: unhandled branchConsumability reason for '${refName}'.`;
    } else if (info.fileField) {
      remedy = `Add '${info.fileField}:' to that producer so the value passed downstream is a path, not stdout.`;
    } else {
      remedy =
        `That producer cannot be made file-bound; restructure the pipeline so downstream agents read ` +
        `the underlying per-input files directly instead of consuming this bind.`;
    }
    throw new Error(
      `Compile error: ${consumeSiteLabel} references '$${refName}', whose producer ` +
        `${info.location} has no file-bound output. ${remedy}`,
    );
  }
}

/** Compute the array of `inputPaths` expressions for a step's runAgent emit.
 *  Each entry is either a JS identifier (a bind in scope) or a JSON-stringified
 *  literal (a literal-string input). Threaded as `RunAgentOpts.inputPaths`;
 *  the runtime iterates and validates each entry via `requireFile` before
 *  spawn. Order follows YAML iteration order (preserved through `js-yaml`'s
 *  parse + `Object.values`), so the first miss in the runtime's array walk
 *  matches the first declared input that's missing. */
export function computeInputPaths(it: StepItemT, scope: Map<string, ProducerInfo>): string[] {
  const out: string[] = [];
  const addEntry = (expr: string | undefined): void => {
    if (expr === undefined) return;
    if (!expr.startsWith('$')) {
      // Literal-string input (`input: "ticket.md"`). The runtime resolves
      // it against cwd via `path.resolve` inside `requireFile`.
      out.push(JSON.stringify(expr));
      return;
    }
    const refName = expr.slice(1);
    const info = scope.get(refName);
    // Unknown ref reaching here is an internal regression: checkConsume runs
    // first on every $ref consumption site and rejects unknown names with a
    // user-friendly error. If we silently skipped, the emitted runAgent call
    // would omit a path the runtime must validate — a silent missing-file
    // bypass. Throw loud so the regression surfaces during tsc/test rather
    // than at runtime as wrong-shape output.
    if (info === undefined) {
      throw new Error(
        `Internal compile error: computeInputPaths reached an unknown ref '${refName}'; ` +
          `checkConsume should have rejected this before now.`,
      );
    }
    // Pipeline inputs are file-bound by convention (the CLI absolutifies
    // path-shaped positionals before spawn). Emit as a JS identifier — the
    // bind value resolves to the path string at runtime.
    if (info.kind === 'input') {
      out.push(refName);
      return;
    }
    // Non-file-bound producers (parallel/branch container binds, aggregate
    // verdict strings): no file to validate, skip.
    if (!info.fileBound) return;
    // File-bound producers (step.produces, review_loop.writer_produces, or
    // a hoisted parallel child): emit the bind name as a JS identifier.
    out.push(refName);
  };
  if (it.inputs) {
    for (const expr of Object.values(it.inputs)) {
      addEntry(expr);
    }
  } else {
    addEntry(it.input);
  }
  return out;
}
