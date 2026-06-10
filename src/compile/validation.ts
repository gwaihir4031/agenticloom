import { existsSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import {
  FlowItem,
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

/** Probe `dirs` in order for the first directory containing `leaf`; returns
 *  the found path (or null) plus every attempted candidate so error messages
 *  can name the exact paths that were checked. This existence-only probe is
 *  the copilot resolution arm; claude resolution instead walks every layer
 *  by frontmatter name (`resolveClaudePersonaByName`). The runtime delegates
 *  persona resolution to the CLI and keeps no copy. Module-private: external
 *  callers (notably `emit-walker.ts`'s human_gate persona probe) go through
 *  `validatePersonaFile`, so no caller can bypass the per-cli semantics. */
function firstExisting(
  dirs: string[],
  leaf: string,
): { found: string | null; attempted: string[] } {
  const attempted: string[] = [];
  for (const dir of dirs) {
    const candidate = layerCandidate(dir, leaf);
    attempted.push(candidate);
    if (existsSync(candidate)) return { found: candidate, attempted };
  }
  return { found: null, attempted };
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

/** Why an existing candidate file failed to satisfy a claude reference.
 *  `reason` is the path-suffixed fragment ("declares frontmatter name: 'x'
 *  but the pipeline references 'y'", "has no 'name:' frontmatter", "declares
 *  name: 'x' but has no 'description:' frontmatter", "could not be read:
 *  <err>") shared by the single-candidate errors and the aggregated
 *  multi-layer error, so both render identical per-file wording. */
type PersonaRejection = {
  path: string;
  kind: 'unreadable' | 'no-name' | 'name-mismatch' | 'no-description';
  reason: string;
};

/** The minimal frontmatter block claude will register — both `name:` and
 *  `description:` are required (claude refuses to register an agent file
 *  without a description). Every fix-it tail shows this full block so the
 *  advice never instructs the user to create an unloadable name-only file. */
function minimalFrontmatterBlock(name: string): string {
  return `  ---\n  name: ${name}\n  description: <one line on when to use this agent>\n  ---`;
}

/** Render the exactly-one-failing-file compile error in the single-file
 *  wording (pinned by tests and unchanged from when claude's check examined
 *  only the first existing layer): each kind frames `reason` with its own
 *  fix-it guidance. */
function singleLayerRejectionError(r: PersonaRejection, name: string, contextLabel: string): Error {
  switch (r.kind) {
    case 'unreadable':
      return new Error(
        `Compile error: ${contextLabel} references agent '${name}' but its persona file at ` +
          `${r.path} ${r.reason}`,
      );
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

/** The claude arm of `validatePersonaFile`: resolve `--agent <name>` the way
 *  claude itself does — claude registers the agent files of BOTH layers and
 *  matches by frontmatter `name:`, not filename — and return the first layer
 *  (project-most, mirroring claude's project-over-global precedence) whose
 *  file satisfies the reference. A layer whose file exists but does not
 *  satisfy it (no frontmatter name / mismatched name / missing description /
 *  unreadable) is recorded and SKIPPED, exactly as claude skips it: a project
 *  `reviewer.md` declaring `name: other` is a different agent, not a broken
 *  reference, and a global `reviewer.md` declaring `name: reviewer` still
 *  resolves the spawn. A name-matched file additionally needs a non-empty
 *  string `description:` — claude (live-verified on 2.1.170) refuses to
 *  register an agent whose frontmatter lacks one, so without the check the
 *  spawn would run persona-less despite the matching name. Throws only when
 *  NO layer satisfies, naming every examined file and why it was rejected. */
function resolveClaudePersonaByName(
  agentDirs: string[],
  leaf: string,
  name: string,
  contextLabel: string,
): string {
  const attempted: string[] = [];
  const examined = new Set<string>();
  const rejections: PersonaRejection[] = [];
  for (const dir of agentDirs) {
    const candidate = layerCandidate(dir, leaf);
    attempted.push(candidate);
    if (!existsSync(candidate)) continue;
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
      rejections.push({
        path: candidate,
        kind: 'unreadable',
        reason: `could not be read: ${readProblem}`,
      });
      continue;
    }
    if (fmName === undefined) {
      const parseNote =
        parseProblem === undefined ? '' : ` (frontmatter YAML failed to parse: ${parseProblem})`;
      rejections.push({
        path: candidate,
        kind: 'no-name',
        reason: `has no 'name:' frontmatter${parseNote}`,
      });
      continue;
    }
    if (fmName !== name) {
      rejections.push({
        path: candidate,
        kind: 'name-mismatch',
        reason: `declares frontmatter name: '${fmName}' but the pipeline references '${name}'`,
      });
      continue;
    }
    if (fmDescription === undefined || fmDescription.trim() === '') {
      rejections.push({
        path: candidate,
        kind: 'no-description',
        reason: `declares name: '${name}' but has no 'description:' frontmatter`,
      });
      continue;
    }
    return candidate;
  }
  if (rejections.length === 0) throw missingPersonaError(contextLabel, name, attempted);
  if (rejections.length === 1) throw singleLayerRejectionError(rejections[0], name, contextLabel);
  throw new Error(
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

/** Resolve agent `name`'s persona file across the layered `agentDirs` and
 *  return the resolved path; throws a compile error otherwise. Shared by the
 *  flow-walking check (`validateAgentFilesExist`) and emit-walker's inline
 *  human_gate persona probe so both sites enforce identical resolution
 *  semantics; `contextLabel` carries each site's error prefix
 *  (`pipeline '<name>'` / `human_gate interactive mode`).
 *
 *  Per-cli resolution semantics:
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
 *  - copilot: existence-only, first existing leaf wins. Its resolution
 *    semantics are less verified, and it already fails loud at runtime on an
 *    unresolved `--agent`. */
export function validatePersonaFile(
  agentDirs: string[],
  cli: AgentCli,
  name: string,
  contextLabel: string,
): string {
  const leaf = agentFileLeaf(cli, name);
  if (cli === 'claude') {
    return resolveClaudePersonaByName(agentDirs, leaf, name, contextLabel);
  }
  const { found, attempted } = firstExisting(agentDirs, leaf);
  if (found === null) throw missingPersonaError(contextLabel, name, attempted);
  return found;
}

/** Walk the flow and collect every agent name referenced by a `step:` or
 *  by a `review_loop`'s string-form writer/reviewer. Verify each via
 *  `validatePersonaFile`: a persona file must exist in at least one layer of
 *  `agentDirs`, and (claude only) some layer's file must declare a
 *  frontmatter `name:` matching the reference plus a non-empty
 *  `description:`. Missing in every layer → compile error naming every
 *  attempted path. Pushes the "persona file exists and is loadable" check up from
 *  runtime to compile time, so a typo or missing file fails before the
 *  pipeline starts running rather than mid-flight.
 *
 *  Throws on the FIRST failing reference (Set traversal order); does not
 *  aggregate. Iterate-and-fix-and-rerun is the preserved UX. */
export function validateAgentFilesExist(
  flow: FlowItem[],
  agentDirs: string[],
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
