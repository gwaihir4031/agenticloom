import { existsSync, readFileSync } from 'fs';
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
} from '../types.js';
// Type-only import: `AgentCli` is a string union, so this adds no runtime
// edge into the module graph — preserving the "no heavy deps from
// runtime/agent.ts" rationale documented on expandHome / firstExisting below.
import type { AgentCli } from '../runtime/agent.js';

/** Expand a leading `~/` to the user's home directory. Duplicated from
 *  `runtime/agent.ts` intentionally — compile-time and runtime path resolution
 *  must apply identical `~/` expansion semantics so a tilde-prefixed
 *  layer (e.g. `~/.claude/agents/`) resolves consistently across both
 *  validation and runtime lookup. The duplication rationale (avoiding
 *  `runtime/agent.ts`'s heavy deps in compile/'s module graph) is preserved
 *  by keeping these inside compile/. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** Local copy of `runtime/agent.ts`'s `firstExisting` helper. Duplicated rather
 *  than imported to keep compile/'s module graph free of `runtime/agent.ts`'s
 *  heavy deps (child_process, readline, RollingWindow). Same pattern as
 *  `expandHome` above. See `src/runtime/agent.ts:firstExisting` for the
 *  contract and field-by-field documentation. Module-private: external
 *  callers (notably `emit-walker.ts`'s inline human_gate persona probe) go
 *  through `validatePersonaFile`, which layers the claude frontmatter check
 *  on top of the existence probe so no caller can get one without the other. */
function firstExisting(
  dirs: string[],
  leaf: string,
): { found: string | null; attempted: string[] } {
  const attempted: string[] = [];
  for (const dir of dirs) {
    const candidate = expandHome(path.posix.join(dir, leaf));
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
 *  its string `name:` field. `name` is undefined when the file has no
 *  frontmatter block, the block has no string `name:`, or the block's YAML
 *  fails to parse — three cases claude treats identically (the agent is not
 *  registered). `parseProblem` is set in the malformed-YAML case only, so the
 *  caller's error can surface it. Parsing is deliberately minimal: a leading
 *  `---` line, a closing line that trims to `---`, yaml-load of the slice. */
function personaFrontmatterName(filePath: string): {
  name: string | undefined;
  parseProblem?: string;
} {
  const content = readFileSync(filePath, 'utf-8');
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return { name: undefined };
  const lines = content.split('\n');
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return { name: undefined };
  try {
    const data: unknown = parseYaml(lines.slice(1, closeIdx).join('\n'));
    if (typeof data === 'object' && data !== null) {
      const n = (data as Record<string, unknown>).name;
      if (typeof n === 'string') return { name: n };
    }
    return { name: undefined };
  } catch (e) {
    return { name: undefined, parseProblem: e instanceof Error ? e.message : String(e) };
  }
}

/** Resolve agent `name`'s persona file across the layered `agentDirs` and —
 *  for claude — verify its frontmatter `name:` matches the reference. Returns
 *  the resolved path; throws a compile error otherwise. Shared by the
 *  flow-walking check (`validateAgentFilesExist`) and emit-walker's inline
 *  human_gate persona probe so both sites enforce identical resolution
 *  semantics; `contextLabel` carries each site's error prefix
 *  (`pipeline '<name>'` / `human_gate interactive mode`).
 *
 *  The claude frontmatter check exists because claude registers agents by the
 *  frontmatter `name:` field, NOT the filename — a `reviewer.md` whose
 *  frontmatter says `name: other` (or has no frontmatter at all, as files
 *  written for the pre-delegation runtime may not) is invisible to
 *  `--agent reviewer`, and claude exits 0 and runs persona-less. The runtime
 *  init-roster guard (runtime/agent.ts) catches that at spawn; this catches
 *  it at compile time with a fix-it message. copilot stays existence-only:
 *  its resolution semantics are less verified, and it already fails loud at
 *  runtime on an unresolved `--agent`. */
export function validatePersonaFile(
  agentDirs: string[],
  cli: AgentCli,
  name: string,
  contextLabel: string,
): string {
  const { found, attempted } = firstExisting(agentDirs, agentFileLeaf(cli, name));
  if (found === null) {
    throw new Error(
      `Compile error: ${contextLabel} references agent '${name}' but no persona file exists at either layer:\n` +
        attempted.map((p) => `  ${p}`).join('\n') +
        '\n' +
        `Create the file at either path (frontmatter only is fine for a bare-cli agent), or fix the agent name.`,
    );
  }
  if (cli === 'claude') {
    const { name: fmName, parseProblem } = personaFrontmatterName(found);
    if (fmName === undefined) {
      const parseNote =
        parseProblem === undefined ? '' : ` (frontmatter YAML failed to parse: ${parseProblem})`;
      throw new Error(
        `Compile error: ${contextLabel} references agent '${name}' but persona file ${found} ` +
          `has no 'name:' frontmatter${parseNote} — claude registers agents by frontmatter name, ` +
          `so '--agent ${name}' would not load this file and the spawn would run persona-less. ` +
          `Add frontmatter at the top of the file:\n` +
          `  ---\n  name: ${name}\n  ---`,
      );
    }
    if (fmName !== name) {
      throw new Error(
        `Compile error: ${contextLabel}: persona file ${found} declares frontmatter name: '${fmName}' ` +
          `but the pipeline references '${name}' — claude resolves --agent by frontmatter name, ` +
          `so this spawn would silently run persona-less. Align the frontmatter name with the ` +
          `reference (or rename the reference).`,
      );
    }
  }
  return found;
}

/** Walk the flow and collect every agent name referenced by a `step:` or
 *  by a `review_loop`'s string-form writer/reviewer. Verify each via
 *  `validatePersonaFile`: a persona file must exist in at least one layer of
 *  `agentDirs`, and (claude only) its frontmatter `name:` must match the
 *  reference. Missing in every layer → compile error naming every attempted
 *  path. Pushes the "persona file exists and is loadable" check up from
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
      if (typeof item.step === 'string') referenced.add(item.step);
    } else if (isReviewLoop(item)) {
      const r = item.review_loop;
      // Only persona-name writers/reviewers reference a file; inline agents
      // (object form) carry their prompt inline and reference no persona file.
      if (typeof r.writer === 'string') referenced.add(r.writer);
      if (Array.isArray(r.reviewer)) {
        for (const child of r.reviewer) walk(child);
      } else if (typeof r.reviewer === 'string') {
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
