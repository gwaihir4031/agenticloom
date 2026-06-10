import { existsSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import {
  FlowItem,
  AgentRef,
  ReviewLoopItemT,
  isStep,
  isReviewLoop,
  isParallel,
  isBranch,
  isAggregate,
  isForeach,
  isInlineAgent,
} from '../types.js';
// Type-only import: `AgentCli` is a string union, so this adds no runtime
// edge into the module graph — compile/ stays free of runtime/agent.ts's
// heavy deps (child_process, readline, RollingWindow).
import type { AgentCli } from '../runtime/agent.js';

/** Expand a leading `~/` to the user's home directory, so a tilde-prefixed
 *  layer (e.g. `~/.claude/agents/`) resolves to a real path. This is the
 *  sole owner of `~` expansion: the runtime no longer resolves persona
 *  files at all (the CLI does, via `--agent`), so only the compile-time
 *  probes expand tildes. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** The candidate persona path for `leaf` in layer `dir` — the exact path the
 *  existence/frontmatter probes examine and the path error messages display
 *  (the project layer stays relative, the global layer's `~/` is expanded). */
function layerCandidate(dir: string, leaf: string): string {
  return expandHome(path.posix.join(dir, leaf));
}

/** Per-cli persona-file leaf suffix. claude opens `<name>.md`; GitHub Copilot
 *  CLI opens `<name>.agent.md`. The directory and the leaf are the two halves
 *  of "the file the CLI will open", so the leaf is parameterized by cli the
 *  same way the directory already is (see `compile/index.ts`'s
 *  AGENT_DIR_DEFAULTS). The `satisfies Record<AgentCli, ...>` compiler-enforces
 *  an entry per cli, so adding a future cli (`gemini`, `codex`, ...) trips a
 *  type error here before `agentFileLeaf` can return an undefined suffix. */
const AGENT_FILE_SUFFIX = {
  claude: '.md',
  copilot: '.agent.md',
} as const satisfies Record<AgentCli, string>;

/** The persona-file leaf name agent `name` lives at for `cli` — the basis of
 *  the compile-time existence check, so a typo or missing persona file fails at
 *  compile time against the exact filename the CLI will open (claude
 *  `<name>.md`, copilot `<name>.agent.md`). */
export function agentFileLeaf(cli: AgentCli, name: string): string {
  return `${name}${AGENT_FILE_SUFFIX[cli]}`;
}

/** Probe a persona file for a leading `---` YAML frontmatter block and return
 *  its string `name:` and `description:` fields. `name` is undefined when the
 *  file has no frontmatter block, the block has no string `name:`, or the
 *  block's YAML fails to parse — three cases claude treats identically (the
 *  agent is not registered); `description` is undefined under the same
 *  conditions plus a missing/non-string `description:` field (claude — live-
 *  verified on 2.1.170 — also refuses to register an agent whose frontmatter
 *  has no description). `parseProblem` is set in the malformed-YAML case and
 *  `readProblem` when the file itself can't be read (a directory at the .md
 *  path, a permission error, ...), so the caller's error can surface each.
 *
 *  Fence rules are deliberately matched to what claude's loader accepts — a
 *  false compile error here kills a persona that would have loaded fine:
 *  - open and close fences are column-0 `---` followed only by optional
 *    spaces/tabs; an indented `---` (e.g. inside a block scalar) does NOT
 *    close the block;
 *  - CRLF line endings are tolerated — the /\r?\n/ split keeps stray `\r`
 *    out of YAML values, where it once turned a matching name into an
 *    invisible `'reviewer\r'` mismatch;
 *  - a leading UTF-8 BOM is stripped before fence detection. */
function personaFrontmatter(filePath: string): {
  name: string | undefined;
  description: string | undefined;
  parseProblem?: string;
  readProblem?: string;
} {
  const none = { name: undefined, description: undefined };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { ...none, readProblem: e instanceof Error ? e.message : String(e) };
  }
  const content = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const fence = /^---[ \t]*$/;
  const lines = content.split(/\r?\n/);
  if (!fence.test(lines[0])) return none;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (fence.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return none;
  try {
    const data: unknown = parseYaml(lines.slice(1, closeIdx).join('\n'));
    if (typeof data === 'object' && data !== null) {
      const fields = data as Record<string, unknown>;
      return {
        name: typeof fields.name === 'string' ? fields.name : undefined,
        description: typeof fields.description === 'string' ? fields.description : undefined,
      };
    }
    return none;
  } catch (e) {
    return { ...none, parseProblem: e instanceof Error ? e.message : String(e) };
  }
}

/** The no-file-at-any-layer compile error, shared by both cli arms: zero
 *  layers had a file at the cli-aware leaf, so name every attempted path. */
function missingPersonaError(contextLabel: string, name: string, attempted: string[]): Error {
  return new Error(
    `Compile error: ${contextLabel} references agent '${name}' but no persona file exists at either layer:\n` +
      attempted.map((p) => `  ${p}`).join('\n') +
      '\n' +
      `Create the file at either path (frontmatter only is fine for a bare-cli agent), or fix the agent name.`,
  );
}

/** Why an existing candidate file failed to satisfy a reference. `reason`
 *  is the path-suffixed fragment ("declares frontmatter name: 'x' but the
 *  pipeline references 'y'", "has no 'name:' frontmatter", "declares
 *  name: 'x' but has no 'description:' frontmatter", "could not be read:
 *  <err>") shared by the single-candidate errors and the aggregated
 *  multi-layer error, so both render identical per-file wording. The claude
 *  evaluator produces all four kinds; the copilot evaluator only
 *  'unreadable' and 'no-description' (copilot resolution ignores the
 *  frontmatter `name:` for the file at the reference's own leaf — see
 *  `evaluateCopilotCandidate`). */
type PersonaRejection = {
  path: string;
  kind: 'unreadable' | 'no-name' | 'name-mismatch' | 'no-description';
  reason: string;
};

/** The minimal frontmatter block BOTH clis will register — claude requires
 *  `name:` plus a non-empty `description:`; GitHub Copilot CLI (live-verified
 *  on 1.0.61) requires a string `description:` and treats a missing `name:`
 *  as the filename stem. Every fix-it tail shows this full block so the
 *  advice never instructs the user to create a file one cli would refuse
 *  (e.g. a name-only file, which NEITHER cli registers). */
function minimalFrontmatterBlock(name: string): string {
  return `  ---\n  name: ${name}\n  description: <one line on when to use this agent>\n  ---`;
}

/** The cli-neutral unreadable-persona compile error (a directory at the
 *  persona path, a permission error, ...): identical wording for both clis,
 *  framing the raw fs failure as a compile error instead of letting it
 *  escape unprefixed. */
function unreadablePersonaError(r: PersonaRejection, name: string, contextLabel: string): Error {
  return new Error(
    `Compile error: ${contextLabel} references agent '${name}' but its persona file at ` +
      `${r.path} ${r.reason}`,
  );
}

/** Render the exactly-one-failing-file compile error for a claude reference
 *  in the single-file wording (pinned by validation.test.ts): each kind
 *  frames `reason` with its own fix-it guidance. */
function singleClaudeRejectionError(
  r: PersonaRejection,
  name: string,
  contextLabel: string,
): Error {
  switch (r.kind) {
    case 'unreadable':
      return unreadablePersonaError(r, name, contextLabel);
    case 'no-name':
      return new Error(
        `Compile error: ${contextLabel} references agent '${name}' but persona file ${r.path} ` +
          `${r.reason} — claude registers agents by frontmatter name, ` +
          `so '--agent ${name}' would not load this file and the spawn would run persona-less. ` +
          `Add frontmatter at the top of the file:\n` +
          minimalFrontmatterBlock(name),
      );
    case 'no-description':
      return new Error(
        `Compile error: ${contextLabel} references agent '${name}' but persona file ${r.path} ` +
          `${r.reason} — claude refuses to register agents without a description, ` +
          `so '--agent ${name}' would not load this file and the spawn would run persona-less. ` +
          `Add a description line to the frontmatter:\n` +
          minimalFrontmatterBlock(name),
      );
    case 'name-mismatch':
      return new Error(
        `Compile error: ${contextLabel}: persona file ${r.path} ${r.reason} — ` +
          `claude resolves --agent by frontmatter name, ` +
          `so this spawn would silently run persona-less. Align the frontmatter name with the ` +
          `reference (or rename the reference).`,
      );
  }
}

/** Render the exactly-one-failing-file compile error for a copilot
 *  reference. The copilot evaluator produces only 'unreadable' and
 *  'no-description' rejections, so every non-unreadable rejection renders
 *  the missing-description wording. The spawn behavior it names is
 *  live-verified on GitHub Copilot CLI 1.0.61: an unregistered `--agent`
 *  exits 1 with `No such agent: <name>` before running anything — loud,
 *  but only AFTER every upstream pipeline step has already run and paid
 *  its cost, which is exactly what this compile-time check prevents. */
function singleCopilotRejectionError(
  r: PersonaRejection,
  name: string,
  contextLabel: string,
): Error {
  if (r.kind === 'unreadable') return unreadablePersonaError(r, name, contextLabel);
  return new Error(
    `Compile error: ${contextLabel} references agent '${name}' but persona file ${r.path} ` +
      `${r.reason} — GitHub Copilot CLI registers an agent file only when its frontmatter ` +
      `carries a string 'description:', so '--agent ${name}' would fail at spawn with ` +
      `"No such agent: ${name}". Add frontmatter at the top of the file:\n` +
      minimalFrontmatterBlock(name),
  );
}

/** The aggregated no-layer-satisfies error for a claude reference, naming
 *  every examined file and the reason claude would skip it. */
function multiLayerClaudeError(
  rejections: PersonaRejection[],
  name: string,
  contextLabel: string,
): Error {
  return new Error(
    `Compile error: ${contextLabel} references agent '${name}' but no layer's persona file satisfies it — ` +
      `claude registers agents by frontmatter name, so '--agent ${name}' would not load any of these ` +
      `files and the spawn would silently run persona-less:\n` +
      rejections.map((r) => `  ${r.path} ${r.reason}`).join('\n') +
      '\n' +
      `Align one file's frontmatter name with the reference (or rename the reference); ` +
      `if a file is missing frontmatter or a description, the minimal loadable block is:\n` +
      minimalFrontmatterBlock(name),
  );
}

/** The aggregated no-layer-satisfies error for a copilot reference — same
 *  shape as the claude one, but framing copilot's loud-but-late spawn
 *  failure ("No such agent", exit 1) instead of claude's silent
 *  persona-less run. */
function multiLayerCopilotError(
  rejections: PersonaRejection[],
  name: string,
  contextLabel: string,
): Error {
  return new Error(
    `Compile error: ${contextLabel} references agent '${name}' but no layer's persona file satisfies it — ` +
      `GitHub Copilot CLI registers an agent file only when its frontmatter carries a string ` +
      `'description:', so '--agent ${name}' would fail at spawn with "No such agent: ${name}":\n` +
      rejections.map((r) => `  ${r.path} ${r.reason}`).join('\n') +
      '\n' +
      `Add a 'description:' to one file's frontmatter; the minimal registrable block is:\n` +
      minimalFrontmatterBlock(name),
  );
}

/** Append the probed-but-absent layer paths to a rejection-based compile
 *  error (single-candidate and multi-layer, both clis). Without the tail
 *  those errors name only the files that EXIST and fail — a user who
 *  believes a persona lives at another layer (typo'd directory, different
 *  $HOME) would "fix" the named file (e.g. delete it) and re-run into a
 *  missing-persona error instead of converging in one pass. Returns the
 *  error unchanged when every probed layer had a file. */
function withNoFileTail(error: Error, noFile: readonly string[]): Error {
  if (noFile.length === 0) return error;
  return new Error(`${error.message}\nAlso checked (no file): ${noFile.join(', ')}`);
}

/** Evaluate one existing claude candidate file against the reference: null
 *  means the file satisfies it (claude registers it under `name`); otherwise
 *  the rejection explaining why claude would skip it. claude — live-verified
 *  on 2.1.170 — registers an agent file only when its frontmatter `name:`
 *  matches AND a non-empty string `description:` is present; anything else
 *  leaves `--agent <name>` running silently persona-less. */
function evaluateClaudeCandidate(candidate: string, name: string): PersonaRejection | null {
  const {
    name: fmName,
    description: fmDescription,
    parseProblem,
    readProblem,
  } = personaFrontmatter(candidate);
  if (readProblem !== undefined) {
    // existsSync passed but the read failed — e.g. a directory named
    // `<name>.md`, or a permission error. Without this guard the raw fs
    // error (EISDIR/EACCES) would escape with no compile-error framing.
    return { path: candidate, kind: 'unreadable', reason: `could not be read: ${readProblem}` };
  }
  if (fmName === undefined) {
    const parseNote =
      parseProblem === undefined ? '' : ` (frontmatter YAML failed to parse: ${parseProblem})`;
    return { path: candidate, kind: 'no-name', reason: `has no 'name:' frontmatter${parseNote}` };
  }
  if (fmName !== name) {
    return {
      path: candidate,
      kind: 'name-mismatch',
      reason: `declares frontmatter name: '${fmName}' but the pipeline references '${name}'`,
    };
  }
  if (fmDescription === undefined || fmDescription.trim() === '') {
    return {
      path: candidate,
      kind: 'no-description',
      reason: `declares name: '${name}' but has no 'description:' frontmatter`,
    };
  }
  return null;
}

/** Evaluate one existing copilot candidate file: null means it satisfies the
 *  reference. Live-verified on GitHub Copilot CLI 1.0.61: copilot registers
 *  an agent file iff its frontmatter parses and carries a STRING
 *  `description:` — the empty string is accepted (unlike claude); a
 *  null-valued `description:`, a missing field, missing frontmatter, and
 *  malformed YAML are all refused, and `--agent` then exits 1 at spawn with
 *  "No such agent". The frontmatter `name:` is irrelevant to whether THIS
 *  reference resolves: when absent, copilot registers the file under its
 *  filename stem (which IS the reference — the candidate is
 *  `<reference>.agent.md`); when present but different, `--agent
 *  <reference>` still resolves and loads the file by filename stem (a
 *  `probe-foo.agent.md` declaring `name: probe-bar` loads under BOTH
 *  `--agent probe-foo` and `--agent probe-bar`). So the only rejection
 *  kinds produced here are 'unreadable' and 'no-description'. */
function evaluateCopilotCandidate(candidate: string): PersonaRejection | null {
  const { description, parseProblem, readProblem } = personaFrontmatter(candidate);
  if (readProblem !== undefined) {
    return { path: candidate, kind: 'unreadable', reason: `could not be read: ${readProblem}` };
  }
  if (description === undefined) {
    const parseNote =
      parseProblem === undefined ? '' : ` (frontmatter YAML failed to parse: ${parseProblem})`;
    return {
      path: candidate,
      kind: 'no-description',
      reason: `has no 'description:' frontmatter${parseNote}`,
    };
  }
  return null;
}

/** Warn about each layer skipped on the way to a satisfying one. Skipping is
 *  CORRECT (the CLIs themselves skip unregistrable files, and compile mirrors
 *  them), but it is also silent: a user whose project-layer file has a typo'd
 *  frontmatter name would compile clean and run with the GLOBAL persona
 *  variant, with zero signal that their file was passed over. One WARN line
 *  per skipped layer, reusing the rejection's reason fragment and naming the
 *  layer that does resolve the reference. */
function warnSkippedLayers(
  rejections: readonly PersonaRejection[],
  name: string,
  winner: string,
): void {
  for (const r of rejections) {
    console.warn(
      `WARN: persona '${name}': skipped ${r.path} (${r.reason}); ` +
        `'--agent ${name}' resolves via ${winner}.`,
    );
  }
}

/** Resolve `--agent <name>` across the layered `agentDirs` the way `cli`
 *  itself does: examine the file at the cli-aware `leaf` in each layer and
 *  return the first (project-most) layer whose file satisfies the reference
 *  under that cli's live-verified registration rules
 *  (`evaluateClaudeCandidate` / `evaluateCopilotCandidate`). A layer whose
 *  file exists but does not satisfy is recorded and SKIPPED, exactly as the
 *  CLIs themselves skip unregistrable files — live-verified for both clis: a
 *  failing project-layer file does not shadow a satisfying global-layer one.
 *  Each skipped layer is surfaced as a WARN line (`warnSkippedLayers`) so the
 *  passed-over file doesn't fail silently. Throws only when NO layer
 *  satisfies, naming every examined file and why it was rejected — plus, when
 *  some probed layer had no file at all, an `Also checked (no file)` tail
 *  naming those paths (`withNoFileTail`).
 *
 *  The returned path is validation-only at every call site (both
 *  `validateAgentFilesExist` and emit-walker's human_gate probe discard it).
 *  For claude it is also the file claude would load (project-over-global
 *  precedence); copilot — live-observed on 1.0.61 — loads the GLOBAL file
 *  when both layers register the same name, so for copilot the return means
 *  "a satisfying layer", not "the loading layer".
 *
 *  Module-private: external callers (notably `emit-walker.ts`'s human_gate
 *  persona probe) go through `validatePersonaFile`, so no caller can bypass
 *  the per-cli semantics. */
function resolvePersonaByFrontmatter(
  agentDirs: readonly string[],
  leaf: string,
  name: string,
  contextLabel: string,
  cli: AgentCli,
): string {
  const attempted: string[] = [];
  const noFile: string[] = [];
  const examined = new Set<string>();
  const rejections: PersonaRejection[] = [];
  for (const dir of agentDirs) {
    const candidate = layerCandidate(dir, leaf);
    attempted.push(candidate);
    if (!existsSync(candidate)) {
      noFile.push(candidate);
      continue;
    }
    // Two layer spellings can denote the same file — running loom from $HOME
    // collapses `.claude/agents/` and `~/.claude/agents/` into one directory.
    // That is ONE candidate, not two: dedupe by realpath (not string
    // comparison — on darwin a cwd under `/private/var` and a $HOME under
    // `/var` alias the same file) so a single file's failure is reported
    // once, in the single-file wording.
    let realPath: string;
    try {
      realPath = realpathSync(candidate);
    } catch (e) {
      // existsSync passed but realpath failed (file vanished, parent
      // permission, ...) — record with compile-error framing rather than
      // letting the raw fs error escape.
      rejections.push({
        path: candidate,
        kind: 'unreadable',
        reason: `could not be read: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (examined.has(realPath)) continue;
    examined.add(realPath);
    const rejection =
      cli === 'claude'
        ? evaluateClaudeCandidate(candidate, name)
        : evaluateCopilotCandidate(candidate);
    if (rejection === null) {
      warnSkippedLayers(rejections, name, candidate);
      return candidate;
    }
    rejections.push(rejection);
  }
  if (rejections.length === 0) throw missingPersonaError(contextLabel, name, attempted);
  if (rejections.length === 1) {
    throw withNoFileTail(
      cli === 'claude'
        ? singleClaudeRejectionError(rejections[0], name, contextLabel)
        : singleCopilotRejectionError(rejections[0], name, contextLabel),
      noFile,
    );
  }
  throw withNoFileTail(
    cli === 'claude'
      ? multiLayerClaudeError(rejections, name, contextLabel)
      : multiLayerCopilotError(rejections, name, contextLabel),
    noFile,
  );
}

/** Resolve agent `name`'s persona file across the layered `agentDirs` and
 *  return the resolved path; throws a compile error otherwise. Shared by the
 *  flow-walking check (`validateAgentFilesExist`) and emit-walker's inline
 *  human_gate persona probe so both sites enforce identical resolution
 *  semantics; `contextLabel` carries each site's error prefix
 *  (`pipeline '<name>'` / `human_gate interactive mode`).
 *
 *  Per-cli resolution semantics (both live-verified — claude 2.1.170,
 *  GitHub Copilot CLI 1.0.61):
 *  - claude: BY NAME ACROSS LAYERS, mirroring how claude itself registers
 *    agents from both layers and resolves `--agent` by the frontmatter
 *    `name:` field, NOT the filename. The first layer whose file's
 *    frontmatter name equals the reference AND carries a non-empty
 *    `description:` (claude refuses to register description-less agents)
 *    wins and ITS path is returned; a layer that exists but doesn't satisfy
 *    is skipped, so e.g. a project `reviewer.md` declaring `name: other`
 *    doesn't shadow a global `reviewer.md` declaring `name: reviewer`. Only
 *    when no layer satisfies does compile fail — without the check claude
 *    would exit 0 and run persona-less. The runtime init-roster guard
 *    (runtime/agent.ts) catches that at spawn; this catches it at compile
 *    time with a fix-it message.
 *  - copilot: BY REGISTRABLE FILE AT THE LEAF. copilot registers each
 *    `*.agent.md` whose frontmatter parses and carries a string
 *    `description:` (empty string included), under its frontmatter `name:`
 *    when present or the filename stem when absent — and `--agent <name>`
 *    ADDITIONALLY loads `<name>.agent.md` by filename stem even when its
 *    frontmatter declares a different name. So the reference resolves iff
 *    some layer's `<name>.agent.md` carries a string description: a
 *    frontmatter/filename name mismatch still loads and is NOT an error
 *    here, while a description-less file is never registered and `--agent`
 *    exits 1 at spawn ("No such agent") — loud but LATE, after every
 *    upstream step has already run. This check moves that failure to
 *    compile time. */
export function validatePersonaFile(
  agentDirs: readonly string[],
  cli: AgentCli,
  name: string,
  contextLabel: string,
): string {
  return resolvePersonaByFrontmatter(agentDirs, agentFileLeaf(cli, name), name, contextLabel, cli);
}

/** Walk the flow and collect every agent name referenced by a string-form
 *  `step:` or by a `review_loop`'s string-form writer/reviewer (inline-object
 *  agents reference no file and are skipped). Verify each via
 *  `validatePersonaFile`: a persona file must exist in at least one layer of
 *  `agentDirs`, and some layer's file must satisfy the per-cli registration
 *  rules (claude: frontmatter `name:` matching the reference plus a
 *  non-empty `description:`; copilot: a string `description:` — see
 *  `validatePersonaFile` for the live-verified semantics). Missing in every
 *  layer → compile error naming every attempted path. Pushes the "persona
 *  file exists and is loadable" check up from runtime to compile time, so a
 *  typo or missing file fails before the pipeline starts running rather
 *  than mid-flight.
 *
 *  Throws on the FIRST failing reference (Set traversal order); does not
 *  aggregate. Iterate-and-fix-and-rerun is the preserved UX. */
export function validateAgentFilesExist(
  flow: FlowItem[],
  agentDirs: readonly string[],
  cli: AgentCli,
  pipelineLabel: string,
): void {
  const referenced = new Set<string>();
  function walk(item: FlowItem): void {
    if (isStep(item)) {
      // Only persona-name steps have a file to check; inline agents (object
      // form) carry their prompt inline and reference no persona file.
      if (!isInlineAgent(item.step)) referenced.add(item.step);
    } else if (isReviewLoop(item)) {
      const r = item.review_loop;
      // Only persona-name writers/reviewers reference a file; inline agents
      // (object form) carry their prompt inline and reference no persona file.
      if (!isInlineAgent(r.writer)) referenced.add(r.writer);
      if (Array.isArray(r.reviewer)) {
        for (const child of r.reviewer) walk(child);
      } else if (!isInlineAgent(r.reviewer)) {
        referenced.add(r.reviewer);
      }
      // An inline-object reviewer has no persona file — skip it.
    } else if (isParallel(item)) {
      for (const child of item.parallel) walk(child);
    } else if (isBranch(item)) {
      const b = item.branch;
      for (const child of b.then) walk(child);
      if (b.else) for (const child of b.else) walk(child);
    } else if (isForeach(item)) {
      // foreach references agents only through its body; recurse the body
      // the same way sibling compound primitives do.
      for (const child of item.foreach.body) walk(child);
    }
    // aggregate and human_gate don't directly reference agents by name in
    // a way this validator owns. human_gate's interactive agent is handled
    // separately in the interactive validator (see emit-walker.ts's
    // human_gate emit branch).
  }
  for (const item of flow) walk(item);

  for (const name of referenced) {
    validatePersonaFile(agentDirs, cli, name, pipelineLabel);
  }
}

/** Structural shape check for a compound `reviewer:` subflow. The schema
 *  accepts any `FlowItem[]`; this validator enforces the additional rule
 *  that the loop's verdict signal must come from a terminal aggregate. */
export function validateReviewerSubflow(reviewerSubflow: FlowItem[], loopLabel: string): void {
  if (reviewerSubflow.length === 0) {
    throw new Error(
      `Compile error: ${loopLabel} has empty reviewer subflow. ` +
        `A compound reviewer must contain at least one item, with an 'aggregate' as the final item.`,
    );
  }
  const last = reviewerSubflow[reviewerSubflow.length - 1];
  if (!isAggregate(last)) {
    throw new Error(
      `Compile error: ${loopLabel} reviewer subflow's last item must be 'aggregate' ` +
        `(its verdict string is what the loop checks against 'approve_when'). ` +
        `Found: ${Object.keys(last as object).join(', ')}.`,
    );
  }
}

/** The `reviewer:` union read as a discriminated shape. The single arm covers
 *  both single-agent forms (persona name and inline object) and carries the
 *  verdict-extraction fields as plain strings; the subflow arm carries the
 *  `FlowItem[]` whose terminal aggregate does its own verdict extraction. */
export type ReviewerArm =
  | { kind: 'single'; reviewer: AgentRef; reviewerProduces: string; verdictField: string }
  | { kind: 'subflow'; subflow: FlowItem[] };

/** Encode the `reviewer:` union's cross-field invariants as a `ReviewerArm`
 *  (same cure as `readRetryGate` in retry-gate.ts). The schema's refines
 *  guarantee `reviewer_produces` + `verdict_field` exactly when the reviewer
 *  is a single agent and forbid them for a subflow — but refines are invisible
 *  to the type checker, so direct field reads at the emit site would need `!`,
 *  and a schema-bypassing caller (hand-built item) would sail past those into
 *  emitting a literal `undefined`. This reader is the single place that
 *  knowledge lives: missing fields on the single arm throw a structured
 *  internal-contract error naming the loop instead.
 *
 *  Splits on Array.isArray (not typeof === 'string') so an inline-object
 *  reviewer routes through the single arm, where its verdict comes from
 *  reviewer_produces/verdict_field exactly as a persona's does. */
export function readReviewerArm(r: ReviewLoopItemT['review_loop'], loopLabel: string): ReviewerArm {
  if (Array.isArray(r.reviewer)) {
    return { kind: 'subflow', subflow: r.reviewer };
  }
  if (r.reviewer_produces === undefined || r.verdict_field === undefined) {
    const missing: string[] = [];
    if (r.reviewer_produces === undefined) missing.push("'reviewer_produces'");
    if (r.verdict_field === undefined) missing.push("'verdict_field'");
    throw new Error(
      `Internal compile error: ${loopLabel} has a single-agent reviewer but is missing ` +
        `${missing.join(' and ')}; the ReviewLoopItem schema refines guarantee both fields ` +
        `for parsed pipelines, so this item bypassed schema validation.`,
    );
  }
  return {
    kind: 'single',
    reviewer: r.reviewer,
    reviewerProduces: r.reviewer_produces,
    verdictField: r.verdict_field,
  };
}

/** Reject absolute paths and `..` traversal in agent-write fields. Loom only
 *  writes inside the workspace (CWD); a YAML typo must not escape it.
 *  Uses posix normalization since YAML uses forward-slash paths by convention
 *  and loom targets darwin/linux. */
export function validatePath(value: string, fieldName: string, contextLabel: string): void {
  if (value.startsWith('/')) {
    throw new Error(
      `Compile error: ${contextLabel} has absolute path in '${fieldName}': ${JSON.stringify(value)}. ` +
        `Use a workspace-relative path.`,
    );
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(
      `Compile error: ${contextLabel} has parent-directory traversal in '${fieldName}': ${JSON.stringify(value)}. ` +
        `Paths must stay within the workspace.`,
    );
  }
}
