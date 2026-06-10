import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import * as path from 'path';
import { compile } from './index.js';
import { compileAndTypeCheck, setupCompileTestEnv, setupFixture } from './test-helpers.js';

let teardown: () => void;

beforeEach(() => {
  teardown = setupCompileTestEnv();
});

afterEach(() => {
  teardown();
});

/** Group H + I shared helper: extract the consumable-branch disk-probe IIFE
 *  expression (or the closure-call shape) from a compiled emit and wrap it in
 *  a self-contained Node script that executes it against the per-test tmp
 *  dir's fixtures. Returns the resolved value (stdout) or throws (non-zero
 *  exit). The script supplies `fileExists` (and `runAgent` for Group I) as
 *  inline stubs so no `agenticloom/runtime` import resolution is needed at runtime.
 *  Per the plan: real disk I/O via mkdtempSync + execFileSync(process.execPath,
 *  [emitPath]). */
function runIIFEScript(scriptSource: string): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const scriptDir = mkdtempSync(path.join(tmpdir(), 'loom-iife-'));
  try {
    const scriptPath = path.join(scriptDir, 'probe.mjs');
    writeFileSync(scriptPath, scriptSource);
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf-8', cwd: scriptDir });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

describe('emit shape — aggregate retry closure threads per-step extra_args', () => {
  it('threads per-step extra_args into the aggregate retry closure', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: retry-haiku
cli: claude
default_extra_args: ["--model", "sonnet"]
inputs: [x]
flow:
  - step: ac-writer
    extra_args: ["--model", "haiku"]
    input: $x
    produces: out.json
    bind: r
  - aggregate:
      inputs: { r: $r }
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    // The first-call runAgent should use haiku:
    expect(emitted).toMatch(/runAgent\("ac-writer"[^)]+extraArgs: \["--model","haiku"\]/);
    // The retry closure inside rewriteProducerFiles uses the same per-step
    // extra_args as the first call — per-step extra_args is the source of
    // truth on both passes (it REPLACES default_extra_args end-to-end, so
    // retry can't silently fall back to a different model than the first
    // call).
    expect(emitted).toMatch(
      /rewriteProducerFiles:[\s\S]+extraArgs: \["--model","haiku"\][\s\S]+\.then/,
    );
  });

  it('falls back to DEFAULT_EXTRA_ARGS when step has no per-step extra_args', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: retry-default
cli: claude
default_extra_args: ["--model", "sonnet"]
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.json
    bind: r
  - aggregate:
      inputs: { r: $r }
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    // Both first-call and retry closure should reference DEFAULT_EXTRA_ARGS
    // (no inline override):
    expect(emitted).toMatch(/runAgent\("ac-writer"[^)]+extraArgs: DEFAULT_EXTRA_ARGS/);
    expect(emitted).toMatch(
      /rewriteProducerFiles:[\s\S]+extraArgs: DEFAULT_EXTRA_ARGS[\s\S]+\.then/,
    );
  });

  it('threads per-step timeout into the aggregate retry closure', () => {
    // Same posture as extra_args: the retry should honor the step's
    // declared timeout rather than silently relaxing to runAgent's 30-min
    // default. Without this, a step with `timeout: 60000` would retry
    // with a 30x looser bound on the retry path only.
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: retry-timeout
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    timeout: 60000
    input: $x
    produces: out.json
    bind: r
  - aggregate:
      inputs: { r: $r }
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("ac-writer"[^)]+timeout: 60000/);
    expect(emitted).toMatch(/rewriteProducerFiles:[\s\S]+timeout: 60000[\s\S]+\.then/);
  });

  it('omits timeout from the retry closure when step has no per-step timeout', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: retry-no-timeout
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.json
    bind: r
  - aggregate:
      inputs: { r: $r }
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    // The retry closure should not contain `timeout:` — runtime applies its
    // 30-min default when the field is absent.
    const closureMatch = emitted.match(/rewriteProducerFiles:[\s\S]+?\.then/);
    expect(closureMatch).not.toBeNull();
    expect(closureMatch![0]).not.toMatch(/timeout:/);
  });

  it("aggregate retry closure points at the step's producesPath", () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: retry-path
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: specific-output.json
    bind: r
  - aggregate:
      inputs: { r: $r }
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    // The closure should pass the producer's path as the produces arg:
    expect(emitted).toMatch(/runAgent\("ac-writer",\s*correctivePrompt,\s*"specific-output\.json"/);
  });
});

describe('emit shape — argv-length guard', () => {
  it('emits a symmetric length-check before destructuring inputs', () => {
    // Under-supply burns money on `undefined` template-interpolating into
    // agent prompts; over-supply silently drops the user's intended extras.
    // `!== N` catches both. Error message names pipeline + inputs.
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: argv-guard
cli: claude
inputs: [ticket, branch]
flow:
  - step: ac-writer
    input: $ticket
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/const __args = process\.argv\.slice\(2\);/);
    expect(emitted).toMatch(/if \(__args\.length !== 2\) \{/);
    expect(emitted).toMatch(/pipeline 'argv-guard' expects 2 input\(s\) \(ticket, branch\)/);
    expect(emitted).toMatch(/process\.exit\(1\);/);
    expect(emitted).toMatch(/const \[ticket, branch\] = __args;/);
  });

  it('emits a 0-input guard for zero-input pipelines (fails on any positional)', () => {
    // Same posture as N-input pipelines: silent drop of unexpected positionals
    // is a confusing UX. Guard fires on `__args.length !== 0`; no destructure
    // line is emitted because there are no inputs to bind.
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: zero-input
cli: claude
flow:
  - step: ac-writer
    input: literal
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/const __args = process\.argv\.slice\(2\);/);
    expect(emitted).toMatch(/if \(__args\.length !== 0\) \{/);
    expect(emitted).toMatch(/pipeline 'zero-input' expects 0 input\(s\); received/);
    expect(emitted).toMatch(/process\.exit\(1\);/);
    // No inputs to bind → no destructure line in the emit.
    expect(emitted).not.toMatch(/const \[.*\] = __args;/);
  });
});

describe('emit shape — human_gate per-gate extra_args', () => {
  it('threads per-gate extra_args into the humanGate call when set', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: gate-haiku
cli: claude
default_extra_args: ["--model", "sonnet"]
inputs: [x]
flow:
  - human_gate:
      interactive: true
      agent: ac-writer
      input: $x
      prompt: iterate
      extra_args: ["--model", "haiku"]
`,
    });
    const emitted = compile(yamlPath);
    // Same posture as StepItem.extra_args: per-gate override REPLACES
    // default; emitted as a literal array.
    expect(emitted).toMatch(/humanGate\({[\s\S]+extraArgs: \["--model","haiku"\]/);
    expect(emitted).not.toMatch(/humanGate\({[\s\S]+extraArgs: DEFAULT_EXTRA_ARGS/);
  });

  it('falls back to DEFAULT_EXTRA_ARGS when no per-gate override', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: gate-default
cli: claude
default_extra_args: ["--model", "sonnet"]
inputs: [x]
flow:
  - human_gate:
      interactive: true
      agent: ac-writer
      input: $x
      prompt: iterate
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/humanGate\({[\s\S]+extraArgs: DEFAULT_EXTRA_ARGS/);
  });
});

describe('emit shape — interactive human_gate persona probe (cli-aware leaf)', () => {
  it('resolves the copilot .agent.md leaf for an interactive human_gate agent', () => {
    // The inline human_gate persona probe (its own emit branch) must use the
    // same cli-aware leaf as the flow-walking check: for copilot it resolves
    // `.github/agents/<agent>.agent.md`. validateAgentFilesExist does not walk
    // human_gate agents, so a human_gate-only flow exercises the inline probe
    // specifically. With the persona at exactly that leaf, compile succeeds.
    const yamlPath = setupFixture({
      agents: ['gate-agent'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-gate-ok
cli: copilot
inputs: [x]
flow:
  - human_gate:
      interactive: true
      agent: gate-agent
      input: $x
      prompt: review
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/await humanGate\({[\s\S]*?agent: "gate-agent"/);
  });

  it('rejects an interactive copilot human_gate whose persona sits at the .md leaf', () => {
    // A `<agent>.md` in `.github/agents/` is not the file copilot opens, so
    // the inline probe must reject it and name the `.agent.md` path it wants.
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync('.github/agents/gate-agent.md', '---\nname: gate-agent\n---\nbody\n');
    const yamlPath = setupFixture({
      yaml: `
pipeline: copilot-gate-wrong-leaf
cli: copilot
inputs: [x]
flow:
  - human_gate:
      interactive: true
      agent: gate-agent
      input: $x
      prompt: review
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /human_gate interactive mode references agent 'gate-agent'[\s\S]*\.github\/agents\/gate-agent\.agent\.md/,
    );
  });

  it('resolves the copilot .agent.md leaf for a human_gate nested in a branch arm', () => {
    // The flow-walking validator does not probe human_gate agents, so a gate
    // buried in a branch arm is checked only by the inline emit() probe. It
    // resolves the copilot leaf only if `cli` was threaded into the branch
    // arm's recursive emit() call — this pins that threading, not just the
    // top-level probe the sibling tests cover.
    const yamlPath = setupFixture({
      agents: ['gate-agent'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-gate-in-branch
cli: copilot
inputs: [x]
flow:
  - branch:
      when: 'true'
      then:
        - human_gate:
            interactive: true
            agent: gate-agent
            input: $x
            prompt: review
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/await humanGate\({[\s\S]*?agent: "gate-agent"/);
  });

  it('rejects a copilot human_gate nested in a branch arm whose persona sits at the .md leaf', () => {
    // Same nested position, wrong leaf: the branch-arm inline probe must
    // still demand the copilot `.agent.md` file, proving the threaded cli
    // (not a hard-coded claude default) drives the nested check.
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync('.github/agents/gate-agent.md', '---\nname: gate-agent\n---\nbody\n');
    const yamlPath = setupFixture({
      yaml: `
pipeline: copilot-gate-in-branch-wrong-leaf
cli: copilot
inputs: [x]
flow:
  - branch:
      when: 'true'
      then:
        - human_gate:
            interactive: true
            agent: gate-agent
            input: $x
            prompt: review
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /human_gate interactive mode references agent 'gate-agent'[\s\S]*\.github\/agents\/gate-agent\.agent\.md/,
    );
  });

  it('resolves the copilot .agent.md leaf for a human_gate nested in a foreach body', () => {
    // A foreach body is a separate recursive emit() call site from the branch
    // arm the sibling tests pin. A gate inside it is checked only by the
    // inline emit() probe, which sees the copilot leaf only if `cli` was
    // forwarded into the foreach-body recursive emit() — a copilot persona at
    // the .agent.md leaf resolving here proves that second site forwards the
    // threaded cli rather than defaulting to claude.
    const yamlPath = setupFixture({
      agents: ['gate-agent'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-gate-in-foreach
cli: copilot
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - human_gate:
            interactive: true
            agent: gate-agent
            input: $task
            prompt: review
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/await humanGate\({[\s\S]*?agent: "gate-agent"/);
  });

  it('rejects an interactive claude human_gate whose persona frontmatter name mismatches', () => {
    // The gate probe shares validatePersonaFile with the flow-walking check,
    // so claude's frontmatter-name guard applies to gate personas too: a
    // mismatched name: would make `--agent gate-agent` silently run
    // persona-less.
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync('.claude/agents/gate-agent.md', '---\nname: other-name\n---\nbody\n');
    const yamlPath = setupFixture({
      yaml: `
pipeline: claude-gate-fm-mismatch
cli: claude
inputs: [x]
flow:
  - human_gate:
      interactive: true
      agent: gate-agent
      input: $x
      prompt: review
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /human_gate interactive mode[\s\S]*declares frontmatter name: 'other-name' but the pipeline references 'gate-agent'/,
    );
  });
});

describe('emit shape — general (omitted-agent) human_gate', () => {
  it('omits the agent field for a general gate while keeping every other field', () => {
    // A general gate omits `agent:`; the emitted humanGate({...}) carries no
    // `agent:` field but still emits interactive/cli/agentDirs/extraArgs/
    // input/prompt. No persona file is created — the probe must be skipped.
    const yamlPath = setupFixture({
      yaml: `
pipeline: general-gate
cli: claude
default_extra_args: ["--model", "sonnet"]
inputs: [x]
flow:
  - human_gate:
      interactive: true
      input: $x
      prompt: iterate
`,
    });
    const emitted = compile(yamlPath);
    // Every always-emitted field is present.
    expect(emitted).toMatch(/await humanGate\({[\s\S]*?interactive: true/);
    expect(emitted).toMatch(/await humanGate\({[\s\S]*?cli: CLI/);
    expect(emitted).toMatch(/await humanGate\({[\s\S]*?agentDirs: AGENT_DIRS/);
    expect(emitted).toMatch(/await humanGate\({[\s\S]*?extraArgs: DEFAULT_EXTRA_ARGS/);
    expect(emitted).toMatch(/await humanGate\({[\s\S]*?prompt: "iterate"/);
    // ...but the `agent:` field is absent. `agentDirs:` is not a false match —
    // the literal `agent: ` requires the colon immediately after `agent`.
    expect(emitted).not.toMatch(/await humanGate\({[\s\S]*?agent: /);
  });

  it('compiles a general gate nested in a branch arm with no persona file (probe skipped)', () => {
    // The persona probe (validatePersonaFile) runs only when `agent` is
    // present, at every emit() site including the recursive branch-arm one.
    // A general gate references no persona file, so compile must not probe —
    // it would otherwise throw a missing-persona error for a file that was
    // never meant to exist. No agents are created here.
    const yamlPath = setupFixture({
      yaml: `
pipeline: general-gate-in-branch
cli: copilot
inputs: [x]
flow:
  - branch:
      when: 'true'
      then:
        - human_gate:
            interactive: true
            input: $x
            prompt: review
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('keeps the agent field for a persona gate (contrast with the general form)', () => {
    // Parity guard for the persona path: when `agent:` is present the emit
    // still carries `agent: <name>`, byte-identical to the pre-general-gate
    // behavior. Paired with the general-gate test above so the persona-vs-
    // general split is asserted from both sides.
    const yamlPath = setupFixture({
      agents: ['gate-agent'],
      yaml: `
pipeline: persona-gate
cli: claude
inputs: [x]
flow:
  - human_gate:
      interactive: true
      agent: gate-agent
      input: $x
      prompt: iterate
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/await humanGate\({[\s\S]*?agent: "gate-agent"/);
  });
});

describe('emit shape — step timeout', () => {
  it('threads timeout into the options bag when set', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: t
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
    timeout: 60000
`,
    });
    const emitted = compile(yamlPath);
    // The step emit's options bag must carry the literal timeout value so the
    // runtime can read opts.timeout without a separate fetch. Schema strictness
    // guarantees positive-integer ms; we just check the literal makes it through.
    expect(emitted).toMatch(/timeout:\s*60000/);
  });

  it('omits timeout from the options bag when unset', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: t
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    // Without a YAML override, the options bag has no `timeout:` field — the
    // 30-min default is applied inside runAgent (opts.timeout ?? 30 * 60 * 1000)
    // rather than baked into emit, so unset steps stay terse.
    expect(emitted).not.toMatch(/timeout:/);
  });
});

describe('emit shape — module-level constants prologue', () => {
  it('emits CLI, AGENT_DIRS, DEFAULT_EXTRA_ARGS at the top of main() for claude pipelines', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: prologue
cli: claude
default_extra_args: ["--model", "sonnet"]
inputs: [x]
flow:
  - step: a
    input: $x
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/const CLI = "claude";/);
    expect(emitted).toMatch(/const AGENT_DIRS = \["\.claude\/agents\/","~\/\.claude\/agents\/"\];/);
    expect(emitted).toMatch(/const DEFAULT_EXTRA_ARGS = \["--model","sonnet"\];/);
  });

  it('emits per-cli AGENT_DIRS for copilot pipelines', () => {
    // cli: 'copilot' makes setupFixture write the persona to the copilot
    // project layer at its cli-aware leaf — `.github/agents/a.agent.md`
    // (GitHub Copilot CLI's documented location + `.agent.md` leaf). That
    // is the exact file the compile-time existence check now probes, so
    // compile succeeds and we can assert the emitted per-cli AGENT_DIRS.
    const yamlPath = setupFixture({
      agents: ['a'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-prologue
cli: copilot
inputs: [x]
flow:
  - step: a
    input: $x
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/const CLI = "copilot";/);
    expect(emitted).toMatch(
      /const AGENT_DIRS = \["\.github\/agents\/","~\/\.copilot\/agents\/"\];/,
    );
  });

  it('throws on the FIRST missing agent reference, not aggregating across all refs', () => {
    // Pipeline references TWO agents, neither exists at either layer.
    // The validator throws on the first miss without iterating to find
    // others. This preserves the existing fix-and-rerun loop UX
    // (spec verdict line 73).
    const yamlPath = setupFixture({
      // No agents in setupFixture — neither agent-a nor agent-b will have
      // a persona file under .claude/agents/. Real $HOME could in principle
      // have ~/.claude/agents/agent-a.md or agent-b.md and skew this test;
      // the contract is that the validator throws on the FIRST miss, so as
      // long as at least one name is missing the test exercises the path.
      yaml: `
pipeline: p
cli: claude
inputs: [t]
flow:
  - step: agent-a
    input: $t
    produces: a.md
  - step: agent-b
    input: $t
    produces: b.md
`,
    });
    let caught: Error | undefined;
    try {
      compile(yamlPath);
    } catch (e: any) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const msg = caught?.message ?? '';
    const mentionsA = msg.includes("agent 'agent-a'");
    const mentionsB = msg.includes("agent 'agent-b'");
    // Exactly one name appears — the iteration order is implementation-
    // dependent (Set traversal), so either is acceptable; both is not.
    expect(mentionsA !== mentionsB).toBe(true);
  });

  it('emits empty default_extra_args when YAML omits it', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: no-defaults
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/const DEFAULT_EXTRA_ARGS = \[\];/);
  });

  it('runtimeImport option overrides the default agenticloom/runtime import', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: custom-import
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: out.md
`,
    });
    const emitted = compile(yamlPath, { runtimeImport: 'file:///abs/runtime.js' });
    expect(emitted).toMatch(/from "file:\/\/\/abs\/runtime\.js"/);
  });
});

describe('compile with resumeFrom — pre-cursor rewrite', () => {
  // The pre-cursor rewrite replaces every top-level item strictly before
  // the cursor with a single bind-assignment line (path string for
  // anchored producers, `undefined` for non-anchored, nothing for items
  // without a bind). The cursor and every post-cursor item emit normally.
  // Pre-cursor items still declare() so post-cursor $refs resolve.

  it('rewrites a pre-cursor step+produces to a path-literal bind-assignment', () => {
    const yamlPath = setupFixture({
      agents: ['writer-a', 'writer-b'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer-a
    input: $x
    produces: a.md
    bind: aOut
  - step: writer-b
    input: $aOut
    produces: b.md
    bind: bOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'bOut' });
    expect(emitted).toMatch(/const aOut = "a\.md";/);
    // No runAgent call for the pre-cursor step.
    expect(emitted).not.toMatch(/runAgent\("writer-a"/);
    // The cursor step IS emitted normally.
    expect(emitted).toMatch(/runAgent\("writer-b"/);
  });

  it('emits no line for a pre-cursor step without a bind', () => {
    const yamlPath = setupFixture({
      agents: ['side-effect', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: side-effect
    input: $x
  - step: follower
    input: $x
    produces: f.md
    bind: followerOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'followerOut' });
    // No bind declared on the pre-cursor step; no runAgent and no orphan
    // declaration emitted for it.
    expect(emitted).not.toMatch(/runAgent\("side-effect"/);
    // Verify directly: no synthetic anonymous bind (`_N`) is emitted, and
    // the only flow-body declaration is the cursor's followerOut. We slice
    // by the `async function main(...)` boundary so module-level prologue
    // (const CLI, AGENT_DIRS, DEFAULT_EXTRA_ARGS) doesn't count.
    expect(emitted).not.toMatch(/const _\d+ =/);
    const fnStart = emitted.indexOf('async function main');
    const fnEnd = emitted.indexOf('\n}\n', fnStart);
    const fnBody = emitted.slice(fnStart, fnEnd);
    const flowDeclLines = fnBody.match(/^\s+(?:const|let) \S+ = /gm) ?? [];
    expect(flowDeclLines).toHaveLength(1);
  });

  it('rewrites a pre-cursor review_loop to a writer_produces path literal', () => {
    const yamlPath = setupFixture({
      agents: ['rl-writer', 'rl-reviewer', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: rl-writer
      reviewer: rl-reviewer
      input: $x
      writer_produces: rl.md
      reviewer_produces: rl-rev.json
      verdict_field: status
      bind: rlOut
  - step: follower
    input: $rlOut
    produces: f.md
    bind: followerOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'followerOut' });
    expect(emitted).toMatch(/const rlOut = "rl\.md";/);
    expect(emitted).not.toMatch(/reviewLoop\(/);
  });

  it('rewrites a pre-cursor aggregate (non-anchored bind) to undefined', () => {
    const yamlPath = setupFixture({
      agents: ['writer-a', 'writer-b', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer-a
    input: $x
    produces: a.json
    bind: aOut
  - step: writer-b
    input: $x
    produces: b.json
    bind: bOut
  - aggregate:
      inputs: { a: $aOut, b: $bOut }
      verdict_field: status
      bind: aggOut
  - step: follower
    input: $aOut
    produces: f.md
    bind: followerOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'followerOut' });
    expect(emitted).toMatch(/const aggOut = undefined;/);
    expect(emitted).not.toMatch(/await aggregate\(/);
  });

  it('rewrites a pre-cursor parallel and mirrors the hoist with per-child path literals', () => {
    const yamlPath = setupFixture({
      agents: ['child-a', 'child-b', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - parallel:
      - step: child-a
        input: $x
        produces: a.md
        bind: aOut
      - step: child-b
        input: $x
        produces: b.md
        bind: bOut
    bind: parOut
  - step: follower
    input: $aOut
    produces: f.md
    bind: followerOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'followerOut' });
    // Hoist mirror: per the parallel-pre-cursor special case, anchored
    // hoisted children still get path-literal lines so post-cursor $refs
    // to hoisted child names resolve.
    expect(emitted).toMatch(/const parOut = undefined;/);
    expect(emitted).toMatch(/const aOut = "a\.md";/);
    expect(emitted).toMatch(/const bOut = "b\.md";/);
    // No spawns for the parallel's children — only their hoisted path-
    // literal lines appear.
    expect(emitted).not.toMatch(/runAgent\("child-a"/);
    expect(emitted).not.toMatch(/runAgent\("child-b"/);
  });

  it('pre-cursor parallel hoists review_loop and aggregate children (not just step children)', () => {
    // The CLI's enumerateTopLevelBinds dual-writes any bind-carrying
    // parallel child into the top-level scope. Without hoisting review_loop
    // / aggregate children here, a post-cursor $ref to such a hoisted name
    // would surface as a misleading "unknown bind" inside checkConsume.
    const yamlPath = setupFixture({
      agents: ['rl-writer', 'rl-reviewer', 'agg-input', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - parallel:
      - review_loop:
          writer: rl-writer
          reviewer: rl-reviewer
          input: $x
          writer_produces: rl.md
          reviewer_produces: rl-rev.json
          verdict_field: status
          bind: rlChildOut
      - step: agg-input
        input: $x
        produces: ai.json
        bind: aiOut
      - aggregate:
          inputs: { a: $aiOut }
          verdict_field: status
          bind: aggChildOut
    bind: parOut
  - step: follower
    input: $rlChildOut
    produces: f.md
    bind: followerOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'followerOut' });
    // The hoisted review_loop child resolves to its writer_produces path.
    expect(emitted).toMatch(/const rlChildOut = "rl\.md";/);
    // The hoisted aggregate child resolves to undefined (non-anchored).
    expect(emitted).toMatch(/const aggChildOut = undefined;/);
    // No spawns / reviewLoop / aggregate calls for the pre-cursor parallel.
    expect(emitted).not.toMatch(/reviewLoop\(/);
    expect(emitted).not.toMatch(/runAgent\("rl-writer"/);
    expect(emitted).not.toMatch(/runAgent\("agg-input"/);
    expect(emitted).not.toMatch(/await aggregate\(/);
    // The post-cursor consumer of the hoisted review_loop bind compiles.
    expect(emitted).toMatch(/runAgent\("follower"/);
  });

  it('rewrites a pre-cursor consumable file-bound branch to a disk-probe IIFE; no descent into arms', () => {
    // Both arms terminate in file-bound steps → branch is consumable +
    // `kind: 'file'`. The pre-cursor rewrite emits a sync disk-probe IIFE
    // that rehydrates the bind to whichever arm's terminal file exists
    // on disk. No arm body is emitted (no runAgent for either step).
    const yamlPath = setupFixture({
      agents: ['then-step', 'else-step', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: 'true'
      then:
        - step: then-step
          input: $x
          produces: t.md
          bind: thenOut
      else:
        - step: else-step
          input: $x
          produces: e.md
          bind: elseOut
      bind: branchOut
  - step: follower
    input: $x
    produces: f.md
    bind: followerOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'followerOut' });
    // Disk-probe IIFE shape — both leaf paths in __candidates, fileExists
    // filter, single-survivor return, error paths for zero / many present.
    expect(emitted).toMatch(/const branchOut = \(\(\) => \{/);
    expect(emitted).toContain('const __candidates = ["t.md", "e.md"]');
    expect(emitted).toMatch(/__existing\.length === 1.*return __existing\[0\]/s);
    // No descent into arms: neither arm's runAgent appears in the emit,
    // and no `if (true)` block from the branch primitive either.
    expect(emitted).not.toMatch(/runAgent\("then-step"/);
    expect(emitted).not.toMatch(/runAgent\("else-step"/);
    expect(emitted).not.toMatch(/if \(true\)/);
  });

  it('rewrites a pre-cursor non-consumable branch (missing else) to undefined; no descent into arms', () => {
    // Missing `else:` makes the branch non-consumable; pre-cursor rewrite
    // emits the bare `const <bind> = undefined;` shape. The bind exists
    // for retry-zone walking + post-cursor downstream binding consistency.
    const yamlPath = setupFixture({
      agents: ['then-step', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: 'true'
      then:
        - step: then-step
          input: $x
          produces: t.md
          bind: thenOut
      bind: branchOut
  - step: follower
    input: $x
    produces: f.md
    bind: followerOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'followerOut' });
    expect(emitted).toMatch(/const branchOut = undefined;/);
    expect(emitted).not.toMatch(/runAgent\("then-step"/);
    expect(emitted).not.toMatch(/if \(true\)/);
  });

  it('no-op when the cursor is the first top-level item (byte-identical to no-resume emit)', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: w.md
    bind: writerOut
  - step: follower
    input: $writerOut
    produces: f.md
    bind: followerOut
`,
    });
    const emittedWithoutResume = compile(yamlPath);
    const emittedWithResume = compile(yamlPath, { resumeFrom: 'writerOut' });
    expect(emittedWithResume).toBe(emittedWithoutResume);
  });

  it('throws defensively when the resumeFrom cursor matches no top-level bind', () => {
    // cli.ts validates this before passing through; the compile-side
    // trip-wire fires if the contract drifts (regression detection).
    const yamlPath = setupFixture({
      agents: ['writer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: w.md
    bind: writerOut
`,
    });
    expect(() => compile(yamlPath, { resumeFrom: 'unknownBind' })).toThrow(
      /Internal compile error: --resume-from cursor 'unknownBind' does not match/,
    );
  });

  it('resolves a cursor naming a hoisted parallel-child bind to the enclosing parallel', () => {
    // The cursor on a hoisted child name resolves to the parallel's
    // index — the parallel runs as the cursor primitive (its children
    // all spawn normally); items strictly before the parallel are pre-
    // cursor. Spec: "Hoisted-from-parallel bind named as the cursor:
    // Allowed."
    const yamlPath = setupFixture({
      agents: ['pre-step', 'child-a', 'child-b'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: pre-step
    input: $x
    produces: pre.md
    bind: preOut
  - parallel:
      - step: child-a
        input: $preOut
        produces: a.md
        bind: aOut
      - step: child-b
        input: $preOut
        produces: b.md
        bind: bOut
    bind: parOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'aOut' });
    // Pre-step is pre-cursor → path-literal line.
    expect(emitted).toMatch(/const preOut = "pre\.md";/);
    // The parallel (the cursor) runs normally — both children spawn.
    expect(emitted).toMatch(/runAgent\("child-a"/);
    expect(emitted).toMatch(/runAgent\("child-b"/);
  });

  it('cursor AFTER a retry zone — zone members are pre-cursor and rewritten as const literals; no retryGateZone wrapper for the skipped gate', () => {
    // The pre-pass's zone-membership additions skip gates whose index is
    // pre-cursor, so the pre-cursor rewrite emits `const` (matching the
    // bind-assignment shape) without clashing with a `let`-implying
    // zone-member registration.
    const yamlPath = setupFixture({
      agents: ['writer', 'rev', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: w.md
    bind: writerOut
  - step: rev
    input: $writerOut
    produces: r.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: writerOut
      revise_with:
        prompt: Retry.
  - step: follower
    input: $revOut
    produces: f.md
    bind: followerOut
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'followerOut' });
    // Pre-cursor zone members get path literals (writerOut, revOut).
    expect(emitted).toMatch(/const writerOut = "w\.md";/);
    expect(emitted).toMatch(/const revOut = "r\.json";/);
    // The pre-cursor gate's retryGateZone wrapper is skipped entirely —
    // the gate is rewritten wholesale by emitPreCursorItem, so no retry
    // path is emitted for the pre-cursor zone.
    expect(emitted).not.toMatch(/await retryGateZone\(/);
  });
});

describe('review_loop on_max_exceeded emit', () => {
  it('emits onMaxExceeded literal when YAML sets on_max_exceeded: fail (single reviewer)', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'r'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      reviewer: r
      input: $x
      writer_produces: out.md
      reviewer_produces: review.json
      verdict_field: status
      on_max_exceeded: fail
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toContain('onMaxExceeded: "fail"');
  });

  it('emits onMaxExceeded literal when YAML sets on_max_exceeded: continue (single reviewer)', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'r'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      reviewer: r
      input: $x
      writer_produces: out.md
      reviewer_produces: review.json
      verdict_field: status
      on_max_exceeded: continue
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toContain('onMaxExceeded: "continue"');
  });

  it('omits onMaxExceeded when YAML does not set the field (single reviewer)', () => {
    // Default-applied-at-runtime contract: the schema field is optional;
    // when absent, no emit line — `opts.onMaxExceeded ?? 'continue'` in
    // reviewLoop applies the default. Tests that the field doesn't leak
    // through with `undefined` or a hardcoded default.
    const yamlPath = setupFixture({
      agents: ['w', 'r'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      reviewer: r
      input: $x
      writer_produces: out.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).not.toContain('onMaxExceeded:');
  });

  it('emits onMaxExceeded literal in compound-reviewer review_loop', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'sec', 'api'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      input: $x
      writer_produces: out.md
      bind: spec
      on_max_exceeded: fail
      reviewer:
        - step: sec
          input: $spec
          produces: sec.json
          bind: secOut
        - step: api
          input: $spec
          produces: api.json
          bind: apiOut
        - aggregate:
            inputs:
              security: $secOut
              api: $apiOut
            verdict_field: status
            bind: overall
`,
    });
    const emitted = compile(yamlPath);
    // The compound site is the only reviewLoop({ ... }) in this emit;
    // a plain contain check suffices to pin the compound-branch emit.
    expect(emitted).toContain("kind: 'compound'");
    expect(emitted).toContain('onMaxExceeded: "fail"');
  });

  it('omits onMaxExceeded in compound-reviewer review_loop when YAML does not set the field', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'sec', 'api'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      input: $x
      writer_produces: out.md
      bind: spec
      reviewer:
        - step: sec
          input: $spec
          produces: sec.json
          bind: secOut
        - step: api
          input: $spec
          produces: api.json
          bind: apiOut
        - aggregate:
            inputs:
              security: $secOut
              api: $apiOut
            verdict_field: status
            bind: overall
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toContain("kind: 'compound'");
    expect(emitted).not.toContain('onMaxExceeded:');
  });
});

describe('branch arm bind hoisting — terminal kinds (Group A)', () => {
  // Group A: every consumable terminal kind compiles + is tsc-clean.

  it('A-1: branch with step terminal (explicit bind) — closure shape + tsc-clean', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // The `let outcome;` declaration sits at outer scope.
    expect(emitted).toMatch(/let outcome;/);
    // Closures are declared BEFORE the if/else block, both named with the
    // user-provided bind suffix.
    const letIdx = emitted.indexOf('let outcome;');
    const runThenIdx = emitted.indexOf('const runThen_outcome = async');
    const ifIdx = emitted.indexOf('outcome = await runThen_outcome');
    expect(runThenIdx).toBeGreaterThan(letIdx);
    expect(ifIdx).toBeGreaterThan(runThenIdx);
    expect(emitted).toContain('const runElse_outcome = async');
    expect(emitted).toContain('outcome = await runElse_outcome');
    // The closure returns the arm's terminal bind name.
    expect(emitted).toMatch(/return aBind;/);
    expect(emitted).toMatch(/return bBind;/);
  });

  it('A-2: branch with step terminal (no explicit bind) — synthesized fresh name returned', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
      else:
        - step: b
          input: $x
          produces: B.md
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // Both arms get fresh synthesized binds (e.g. _1, _2); the closure
    // returns whichever name was synthesized.
    expect(emitted).toMatch(/const runThen_outcome = async.*\n.*const _\d+ = await runAgent\("a"/);
    expect(emitted).toMatch(/return _\d+;/);
  });

  it('A-3: branch with single-mode review_loop terminal — tsc-clean closure-call', () => {
    const yamlPath = setupFixture({
      agents: ['rl-w', 'rl-r', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - review_loop:
            writer: rl-w
            reviewer: rl-r
            input: $x
            writer_produces: w.md
            reviewer_produces: r.json
            verdict_field: status
            bind: rlOut
      else:
        - review_loop:
            writer: rl-w
            reviewer: rl-r
            input: $x
            writer_produces: w2.md
            reviewer_produces: r2.json
            verdict_field: status
            bind: rlOut2
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    expect(emitted).toContain('const runThen_outcome = async');
    expect(emitted).toMatch(/return rlOut;/);
    expect(emitted).toMatch(/return rlOut2;/);
  });

  it('A-5: branch with interactive human_gate + literal input — literal in return', () => {
    const yamlPath = setupFixture({
      agents: ['hg', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - human_gate:
            interactive: true
            agent: hg
            input: t.md
            prompt: Review t.
      else:
        - human_gate:
            interactive: true
            agent: hg
            input: e.md
            prompt: Review e.
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // The closure returns the JSON-quoted literal path.
    expect(emitted).toContain('return "t.md";');
    expect(emitted).toContain('return "e.md";');
  });

  it('A-6: branch with interactive human_gate + $ref input — resolved bind in return', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'hg', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: w.md
    bind: wBind
  - branch:
      when: $x
      bind: outcome
      then:
        - human_gate:
            interactive: true
            agent: hg
            input: $wBind
            prompt: Review w.
      else:
        - human_gate:
            interactive: true
            agent: hg
            input: $wBind
            prompt: Review w again.
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // The closure returns the resolved upstream bind name.
    expect(emitted).toMatch(/return wBind;/);
  });

  it('A-7: branch with 1-deep nested branch terminal — inner-branch bind returned', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outerOutcome
      then:
        - branch:
            when: $x
            bind: innerOutcome
            then:
              - step: a
                input: $x
                produces: A.md
                bind: aBind
            else:
              - step: b
                input: $x
                produces: B.md
                bind: bBind
      else:
        - step: c
          input: $x
          produces: C.md
          bind: cBind
  - step: cons
    input: $outerOutcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // Outer then-closure body contains inner closure declarations.
    // Both declarations are nested INSIDE the outer closure (assertion is
    // simply membership in the emit — the test doesn't try to extract a
    // sub-region because TS lexical scoping is what places them, validated
    // by the tsc-clean check in compileAndTypeCheck).
    expect(emitted).toContain('const runThen_outerOutcome');
    expect(emitted).toContain('const runThen_innerOutcome');
    expect(emitted).toContain('const runElse_innerOutcome');
    // The outer closure returns the inner branch's bind name; the inner
    // closures return their step's bind names.
    expect(emitted).toMatch(/return innerOutcome;/);
    expect(emitted).toMatch(/return aBind;/);
    expect(emitted).toMatch(/return bBind;/);
    expect(emitted).toMatch(/return cBind;/);
  });

  it('A-8: branch with 2-deep nested branch terminal — recursive consumable', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'd', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outerOutcome
      then:
        - branch:
            when: $x
            bind: midOutcome
            then:
              - branch:
                  when: $x
                  bind: innerOutcome
                  then:
                    - step: a
                      input: $x
                      produces: A.md
                  else:
                    - step: b
                      input: $x
                      produces: B.md
            else:
              - step: c
                input: $x
                produces: C.md
      else:
        - step: d
          input: $x
          produces: D.md
  - step: cons
    input: $outerOutcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // Three nested closure declaration pairs.
    expect(emitted).toContain('const runThen_outerOutcome');
    expect(emitted).toContain('const runThen_midOutcome');
    expect(emitted).toContain('const runThen_innerOutcome');
  });
});

describe('branch arm bind hoisting — multi-step arms (Group B)', () => {
  it('B-1: 2-step arm where step #2 refs step #1 — cross-step $ref in closure body', () => {
    const yamlPath = setupFixture({
      agents: ['a1', 'a2', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a1
          input: $x
          produces: A1.md
          bind: a1Bind
        - step: a2
          input: $a1Bind
          produces: A2.md
          bind: a2Bind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // Both steps inside the closure body; closure returns step 2.
    expect(emitted).toMatch(/const runThen_outcome = async/);
    expect(emitted).toMatch(/const a1Bind = await runAgent\("a1"/);
    expect(emitted).toMatch(/const a2Bind = await runAgent\("a2"/);
    expect(emitted).toMatch(/return a2Bind;/);
  });

  it('B-2: 3-step chain — terminal returns last step', () => {
    const yamlPath = setupFixture({
      agents: ['s1', 's2', 's3', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: s1
          input: $x
          produces: 1.md
          bind: s1Bind
        - step: s2
          input: $s1Bind
          produces: 2.md
          bind: s2Bind
        - step: s3
          input: $s2Bind
          produces: 3.md
          bind: s3Bind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    expect(emitted).toMatch(/return s3Bind;/);
  });
});

describe('branch arm bind hoisting — mixed terminal kinds (Group C)', () => {
  it('C-1: then=step, else=review_loop — both classified file-bound', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'rl-w', 'rl-r', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - review_loop:
            writer: rl-w
            reviewer: rl-r
            input: $x
            writer_produces: w.md
            reviewer_produces: r.json
            verdict_field: status
            bind: rlOut
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    expect(emitted).toContain('return aBind;');
    expect(emitted).toContain('return rlOut;');
  });

  it('C-3: both arms nested branches at different depths — asymmetric nesting', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'd', 'e', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outer
      then:
        - branch:
            when: $x
            bind: t1
            then:
              - branch:
                  when: $x
                  bind: t2
                  then:
                    - step: a
                      input: $x
                      produces: A.md
                  else:
                    - step: b
                      input: $x
                      produces: B.md
            else:
              - step: c
                input: $x
                produces: C.md
      else:
        - branch:
            when: $x
            bind: e1
            then:
              - step: d
                input: $x
                produces: D.md
            else:
              - step: e
                input: $x
                produces: E.md
  - step: cons
    input: $outer
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    expect(emitted).toContain('const runThen_outer');
    expect(emitted).toContain('const runThen_t1');
    expect(emitted).toContain('const runThen_t2');
    expect(emitted).toContain('const runThen_e1');
  });

  it('C-2: then=nested branch, else=step — recursive admission', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outerOutcome
      then:
        - branch:
            when: $x
            bind: innerOutcome
            then:
              - step: a
                input: $x
                produces: A.md
            else:
              - step: b
                input: $x
                produces: B.md
      else:
        - step: c
          input: $x
          produces: C.md
  - step: cons
    input: $outerOutcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    expect(emitted).toContain('const runThen_outerOutcome');
    expect(emitted).toContain('const runThen_innerOutcome');
  });
});

describe('branch arm bind hoisting — non-consumable rejection (Group D)', () => {
  it('D-1: aggregate as arm terminal + $ref consumer — consumer-site error', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: A.md
    bind: aBind
  - branch:
      when: $x
      bind: outcome
      then:
        - aggregate:
            inputs: { a: $aBind }
            verdict_field: status
            bind: thenAgg
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /outcome.*then-arm terminal aggregate \(verdict string/,
    );
  });

  it('D-2: aggregate as arm terminal + NO consumer — compiles cleanly', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: A.md
    bind: aBind
  - branch:
      when: $x
      bind: outcome
      then:
        - aggregate:
            inputs: { a: $aBind }
            verdict_field: status
            bind: thenAgg
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('D-3: plain human_gate as terminal + $ref consumer — consumer-site error', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - human_gate: {}
      else:
        - step: a
          input: $x
          produces: A.md
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/outcome.*then-arm terminal human_gate \(plain y\/N\)/);
  });

  it('D-4: parallel as terminal + $ref consumer — consumer-site error', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - parallel:
          - step: a
            input: $x
            produces: A.md
            bind: aBind
          - step: b
            input: $x
            produces: B.md
            bind: bBind
      else:
        - step: c
          input: $x
          produces: C.md
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /outcome.*then-arm terminal parallel block \(no single output\)/,
    );
  });

  it('D-5: missing else + $ref consumer — missing-else error', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/outcome.*no 'else:' arm/);
  });

  it('D-6: asymmetric arms (then file-bound, else aggregate) + $ref — names else arm', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: b
    input: $x
    produces: B.md
    bind: bBind
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - aggregate:
            inputs: { b: $bBind }
            verdict_field: status
            bind: elseAgg
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/outcome.*else-arm terminal aggregate/);
  });

  it('D-8: nested-branch deepest-offender walk surfaces leaf aggregate label', () => {
    // Outer arm's terminal is a nested branch whose own arm's terminal is
    // a non-file-bound aggregate. The consumer-site error should surface
    // the deepest offender (the aggregate label), not the wrapper.
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: A.md
    bind: aBind
  - branch:
      when: $x
      bind: outer
      then:
        - branch:
            when: $x
            bind: inner
            then:
              - aggregate:
                  inputs: { a: $aBind }
                  verdict_field: status
                  bind: innerAgg
            else:
              - step: b
                input: $x
                produces: B.md
                bind: bBind
      else:
        - step: c
          input: $x
          produces: C.md
          bind: cBind
  - step: cons
    input: $outer
    produces: out.md
`,
    });
    // The error names the outer branch's then-arm AND mentions the inner
    // aggregate as the deepest offender (via the chained itemLabel).
    expect(() => compile(yamlPath)).toThrow(/outer.*then-arm.*aggregate \(verdict string/);
  });

  it('D-7: asymmetric arms + NO $ref consumer — admitted as retry_from target', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: A.md
    bind: aBind
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $aBind
          produces: A2.md
      else:
        - aggregate:
            inputs: { a: $aBind }
            verdict_field: status
            bind: elseAgg
  - step: rev
    input: $aBind
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    // Admitted: branch is retry_from target even when non-consumable.
    expect(() => compile(yamlPath)).not.toThrow();
  });
});

describe('branch arm bind hoisting — compound intermediates (Group E)', () => {
  it('E-1: parallel intermediate + step terminal that refs a parallel child', () => {
    // The arm's parallel emits children inside the closure body's scope;
    // the terminal step's `$childBind` ref resolves to the inner scope's
    // hoisted child name. compileAndTypeCheck asserts the closure body's
    // recursive emit composed the parallel + terminal step without leaking
    // child names to outer scope.
    const yamlPath = setupFixture({
      agents: ['pa', 'pb', 'term', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - parallel:
            - step: pa
              input: $x
              produces: pa.md
              bind: paBind
            - step: pb
              input: $x
              produces: pb.md
              bind: pbBind
          bind: parBind
        - step: term
          input: $paBind
          produces: term.md
          bind: termBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // The parallel emit is inside the then-closure body; the closure
    // returns the terminal step's bind.
    expect(emitted).toContain('const runThen_outcome');
    expect(emitted).toContain('await parallel(');
    expect(emitted).toContain('return termBind;');
  });

  it('E-2: intermediate aggregate followed by step terminal that refs the aggregate is rejected', () => {
    // The aggregate's bind is a verdict string (non-file-bound). The
    // terminal step references it via `$aggBind` — the existing
    // `checkConsume` rejection fires INSIDE the closure body's recursive
    // emit (the rejection is the load-bearing assertion: the closure
    // body's `emit()` call uses the same admit/reject machinery the
    // outer pipeline uses).
    const yamlPath = setupFixture({
      agents: ['a', 'term', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: A.md
    bind: aBind
  - branch:
      when: $x
      bind: outcome
      then:
        - aggregate:
            inputs: { a: $aBind }
            verdict_field: status
            bind: aggBind
        - step: term
          input: $aggBind
          produces: term.md
          bind: termBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/aggBind.*no file-bound output/);
  });

  it('E-3: intermediate nested non-terminal branch + step terminal that refs the nested branch', () => {
    // The inner branch's bind is consumable (both arms file-bound + else
    // present), so the terminal step can `$ref` it. The recursive emit
    // composes inner-branch closure declarations + if/else inside the
    // outer arm's closure body, then the terminal step. tsc validates
    // the cross-reference resolves inside the closure scope.
    const yamlPath = setupFixture({
      agents: ['ia', 'ib', 'term', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - branch:
            when: $x
            bind: innerOutcome
            then:
              - step: ia
                input: $x
                produces: IA.md
                bind: iaBind
            else:
              - step: ib
                input: $x
                produces: IB.md
                bind: ibBind
        - step: term
          input: $innerOutcome
          produces: term.md
          bind: termBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    expect(emitted).toContain('const runThen_outcome');
    expect(emitted).toContain('const runThen_innerOutcome');
    expect(emitted).toContain('return termBind;');
  });
});

describe('branch arm bind hoisting — retry-zone shapes (Group F)', () => {
  it('F-1: step-host gate (on_fail) targeting branch — retry callback calls closures', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry the branch.
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // Retry callback calls the SAME closures, not re-emitted bodies.
    const retryIdx = emitted.indexOf('retry: async (currentVerdict) => {');
    expect(retryIdx).toBeGreaterThan(-1);
    const retrySlice = emitted.slice(retryIdx);
    expect(retrySlice).toMatch(/outcome = await runThen_outcome\("Retry the branch\.", \[\]\)/);
    expect(retrySlice).toMatch(/outcome = await runElse_outcome\("Retry the branch\.", \[\]\)/);
  });

  it('F-2: aggregate-host gate targeting branch — same closure-call shape', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
  - aggregate:
      inputs: { r: $revOut }
      verdict_field: status
      bind: overall
      retry_from: outcome
      revise_with:
        prompt: Retry from outcome.
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    const retryIdx = emitted.indexOf('retry: async (currentVerdict) => {');
    expect(retryIdx).toBeGreaterThan(-1);
    const retrySlice = emitted.slice(retryIdx);
    expect(retrySlice).toMatch(/outcome = await runThen_outcome\("Retry from outcome\.", \[\]\)/);
    expect(retrySlice).toMatch(/outcome = await runElse_outcome\("Retry from outcome\.", \[\]\)/);
  });

  it('F-5: revise_with.prompt literal text appears in retry-callback closure-call', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: UNIQUE-PROMPT-MARKER
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // Prompt appears in BOTH closure-call sites (then + else).
    const occurrences = emitted.match(/UNIQUE-PROMPT-MARKER/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('F-3: retry target branch with consumable bind — downstream reads via $ref', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // The downstream rev step reads `outcome` (the consumable branch's
    // rejoin variable). Both the main pass and the retry callback assign
    // to it via the closure-call shape.
    expect(emitted).toMatch(/let outcome;/);
    expect(emitted).toMatch(/await runAgent\("rev",.*outcome/);
  });

  it('F-4: retry target branch with non-consumable bind (retry_from-only) — admitted', () => {
    // Branch has bind but missing else — non-consumable. retry_from
    // targets it; no downstream $ref consumes the bind, so checkConsume
    // never fires. The branch is admitted as a retry_from target despite
    // being non-consumable — side-effect-only branches are valid retry
    // targets so long as no $ref tries to consume their bind.
    const yamlPath = setupFixture({
      agents: ['a', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
  - step: rev
    input: $x
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    expect(() => compileAndTypeCheck(yamlPath)).not.toThrow();
  });

  it('F-10: branch as INTERMEDIATE retry-zone member (between target and gate)', () => {
    const yamlPath = setupFixture({
      agents: ['t', 'a', 'b', 'r'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: t
    input: $x
    produces: t.md
    bind: tBind
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $tBind
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $tBind
          produces: B.md
          bind: bBind
  - step: r
    input: $outcome
    produces: r.json
    bind: rBind
    on_fail:
      verdict_field: status
      retry_from: tBind
      revise_with:
        prompt: Retry from t.
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    const retryIdx = emitted.indexOf('retry: async (currentVerdict) => {');
    const retrySlice = emitted.slice(retryIdx);
    // The retry callback re-fires the branch (intermediate) WITHOUT the
    // revise prompt — only the retry_from target's terminal step gets
    // the prompt override.
    expect(retrySlice).toMatch(/outcome = await runThen_outcome\(undefined, undefined\)/);
    expect(retrySlice).toMatch(/outcome = await runElse_outcome\(undefined, undefined\)/);
  });

  it('F-6: multi-step arm refire on retry — every step in the arm lives in the closure body', () => {
    // Retry re-fires by CALLING the closure, not by re-emitting the arm body.
    // Every step in the multi-step arm must therefore live inside the
    // closure's body — calling the closure on retry naturally re-runs the
    // whole arm. Assertion: each step's runAgent declaration is between the
    // closure's `const runThen_outcome` opener and the closure's `return`.
    const yamlPath = setupFixture({
      agents: ['a1', 'a2', 'a3', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a1
          input: $x
          produces: A1.md
          bind: a1Bind
        - step: a2
          input: $a1Bind
          produces: A2.md
          bind: a2Bind
        - step: a3
          input: $a2Bind
          produces: A3.md
          bind: a3Bind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    const thenStart = emitted.indexOf('const runThen_outcome');
    const thenReturn = emitted.indexOf('return a3Bind;', thenStart);
    expect(thenStart).toBeGreaterThan(-1);
    expect(thenReturn).toBeGreaterThan(thenStart);
    const thenBody = emitted.slice(thenStart, thenReturn);
    expect(thenBody).toContain('runAgent("a1"');
    expect(thenBody).toContain('runAgent("a2"');
    expect(thenBody).toContain('runAgent("a3"');
    // Retry callback calls the closure (no re-emit of the steps).
    const retryIdx = emitted.indexOf('retry: async (currentVerdict) => {');
    const retrySlice = emitted.slice(retryIdx);
    expect(retrySlice).toMatch(/outcome = await runThen_outcome\("Retry\.", \[\]\);/);
    // Steps a1/a2 in the retry callback would indicate inline re-emit (the
    // pattern this design rejects); they must NOT appear there.
    expect(retrySlice).not.toContain('runAgent("a1"');
    expect(retrySlice).not.toContain('runAgent("a2"');
  });

  it('F-7: nested branch refire on retry — inner closures live inside outer closure body', () => {
    // The outer arm's closure body contains the inner branch's closure
    // declarations + if/else assignment. On retry, the outer closure call
    // re-runs the inner branch by virtue of the outer body re-executing.
    // Assertion: inner-branch closures live BETWEEN outer-closure opener
    // and outer-closure return; outer retry callback calls only the outer
    // closures.
    const yamlPath = setupFixture({
      agents: ['ia', 'ib', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - branch:
            when: $x
            bind: innerOutcome
            then:
              - step: ia
                input: $x
                produces: IA.md
                bind: iaBind
            else:
              - step: ib
                input: $x
                produces: IB.md
                bind: ibBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    const outerStart = emitted.indexOf('const runThen_outcome');
    const outerReturn = emitted.indexOf('return innerOutcome;', outerStart);
    expect(outerStart).toBeGreaterThan(-1);
    expect(outerReturn).toBeGreaterThan(outerStart);
    const outerBody = emitted.slice(outerStart, outerReturn);
    // Inner branch's closures live inside the outer closure body.
    expect(outerBody).toContain('const runThen_innerOutcome');
    expect(outerBody).toContain('const runElse_innerOutcome');
    // Retry callback calls the OUTER closure — the outer body's
    // re-execution re-runs the inner branch by construction.
    const retryIdx = emitted.indexOf('retry: async (currentVerdict) => {');
    const retrySlice = emitted.slice(retryIdx);
    expect(retrySlice).toMatch(/outcome = await runThen_outcome\("Retry\.", \[\]\);/);
    // Inner closure-call must NOT appear in the retry callback — it's
    // reached transitively by calling the outer closure.
    expect(retrySlice).not.toMatch(/innerOutcome = await runThen_innerOutcome/);
  });

  it('F-8: review_loop terminal refire on retry — closure body contains the reviewLoop call', () => {
    // v1 pin: the closure ignores `revisePromptForTerminal` when the
    // terminal is a review_loop; the loop re-runs from iteration 1 on
    // retry (the closure body's reviewLoop call re-executes). Assertion:
    // the reviewLoop call lives inside the closure body, and the retry
    // callback calls the closure (no re-emit of reviewLoop).
    const yamlPath = setupFixture({
      agents: ['w', 'r', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - review_loop:
            writer: w
            reviewer: r
            input: $x
            writer_produces: w.md
            reviewer_produces: r.json
            verdict_field: status
            bind: loopBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    const thenStart = emitted.indexOf('const runThen_outcome');
    const thenReturn = emitted.indexOf('return loopBind;', thenStart);
    expect(thenStart).toBeGreaterThan(-1);
    expect(thenReturn).toBeGreaterThan(thenStart);
    const thenBody = emitted.slice(thenStart, thenReturn);
    expect(thenBody).toMatch(/await reviewLoop\(/);
    // Retry callback calls the closure; no inline reviewLoop re-emit.
    const retryIdx = emitted.indexOf('retry: async (currentVerdict) => {');
    const retrySlice = emitted.slice(retryIdx);
    expect(retrySlice).toMatch(/outcome = await runThen_outcome/);
    // The retry callback's reviewLoop call would indicate broken seal /
    // inline re-emit. The reviewLoop call must live INSIDE the closure.
    const retryHasReviewLoop = /await reviewLoop\(/.test(retrySlice);
    expect(retryHasReviewLoop).toBe(false);
  });

  it('F-9: aggregate-host gate retry callback assigns the outer branch bind', () => {
    // When the gate is an aggregate-host (top-level retry_from on the
    // aggregate), its retry callback reassigns the branch bind via the
    // closure-call. The `let outcome;` declaration at outer scope ensures
    // the reassignment is legal. Assertion: outer scope declares `let
    // outcome;`, the aggregate-host retry callback contains
    // `outcome = await runThen_outcome`, and the closure-call site sits
    // INSIDE the aggregate's `retry:` lambda (i.e. after the
    // `retryGateZone({ kind: 'aggregate'` opening).
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'g1'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - aggregate:
      inputs: { a: $outcome }
      verdict_field: status
      bind: aggOut
      retry_from: outcome
      revise_with:
        prompt: Retry from outcome.
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // The branch bind is `let`-declared at outer scope so the retry
    // callback can reassign it.
    expect(emitted).toMatch(/\blet outcome;/);
    // Locate the aggregate-host retry callback opener; assert the
    // closure-call reassignments land inside it (after the opener, before
    // the closing `},`).
    const aggKindIdx = emitted.indexOf("kind: 'aggregate'");
    expect(aggKindIdx).toBeGreaterThan(-1);
    const retryIdx = emitted.indexOf('retry: async (currentVerdict) => {', aggKindIdx);
    expect(retryIdx).toBeGreaterThan(aggKindIdx);
    const retrySlice = emitted.slice(retryIdx);
    expect(retrySlice).toMatch(/outcome = await runThen_outcome\("Retry from outcome\.", \[\]\);/);
    expect(retrySlice).toMatch(/outcome = await runElse_outcome\("Retry from outcome\.", \[\]\);/);
  });
});

describe('branch arm bind hoisting — --resume-from interactions (Group G)', () => {
  it('G-1: consumable branch pre-cursor + post-cursor $ref — disk-probe IIFE', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
    bind: consOut
`,
    });
    const emitted = compileAndTypeCheck(yamlPath, { resumeFrom: 'consOut' });
    expect(emitted).toMatch(/const outcome = \(\(\) => \{/);
    expect(emitted).toContain('const __candidates = ["A.md", "B.md"]');
    expect(emitted).toContain('__existing = __candidates.filter(p => fileExists(p))');
  });

  it('G-2: pre-cursor branch with literal-input human_gate terminal — leaf is literal', () => {
    const yamlPath = setupFixture({
      agents: ['hg', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - human_gate:
            interactive: true
            agent: hg
            input: t.md
            prompt: Review t.
      else:
        - human_gate:
            interactive: true
            agent: hg
            input: e.md
            prompt: Review e.
  - step: cons
    input: $outcome
    produces: out.md
    bind: consOut
`,
    });
    const emitted = compileAndTypeCheck(yamlPath, { resumeFrom: 'consOut' });
    expect(emitted).toContain('const __candidates = ["t.md", "e.md"]');
  });

  it('G-3: pre-cursor branch with nested branch terminal — recursive leaf collection', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - branch:
            when: $x
            bind: innerOutcome
            then:
              - step: a
                input: $x
                produces: A.md
            else:
              - step: b
                input: $x
                produces: B.md
      else:
        - step: c
          input: $x
          produces: C.md
  - step: cons
    input: $outcome
    produces: out.md
    bind: consOut
`,
    });
    const emitted = compileAndTypeCheck(yamlPath, { resumeFrom: 'consOut' });
    // Three distinct leaf paths from the recursive walk: A.md, B.md, C.md
    expect(emitted).toMatch(/const __candidates = \["A\.md", "B\.md", "C\.md"\]/);
  });

  it('G-4: pre-cursor branch with $ref interactive human_gate terminal — leaf is resolved producesPath', () => {
    // The interactive human_gate's `$ref` input resolves to an upstream
    // producer's static `producesPath`. `collectLeafPaths` resolves the
    // ref against the outer scope (where the pre-cursor upstream step's
    // bind lives) and emits the resolved path as the leaf — NOT the
    // literal `$ref` string. Disk-probe candidates name the resolved
    // path.
    const yamlPath = setupFixture({
      agents: ['upstream', 'hg', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: upstream
    input: $x
    produces: up.md
    bind: upBind
  - branch:
      when: $x
      bind: outcome
      then:
        - human_gate:
            interactive: true
            agent: hg
            input: $upBind
            prompt: Review t.
      else:
        - step: cons
          input: $x
          produces: E.md
          bind: eBind
  - step: cons
    input: $outcome
    produces: out.md
    bind: consOut
`,
    });
    const emitted = compileAndTypeCheck(yamlPath, { resumeFrom: 'consOut' });
    // The disk-probe's `__candidates` list contains the RESOLVED path
    // (the upstream step's `produces:` value), not the `$ref` literal.
    expect(emitted).toContain('const __candidates = ["up.md", "E.md"]');
  });

  it('G-5: pre-cursor non-consumable branch — bare undefined; consumer fails checkConsume', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
  - step: cons
    input: $outcome
    produces: out.md
    bind: consOut
`,
    });
    // Missing else makes branch non-consumable; $ref consumer fails.
    expect(() => compile(yamlPath, { resumeFrom: 'consOut' })).toThrow(/outcome.*no 'else:' arm/);
  });
});

describe('branch arm bind hoisting — disk-probe IIFE runtime (Group H)', () => {
  // Each Group H test compiles a fixture that emits a multi-leaf disk-probe
  // IIFE, extracts the IIFE expression from the emit, writes a self-
  // contained Node script that defines `fileExists` against the test's
  // disk fixtures, executes the script via spawnSync, and asserts the
  // resolution against expected output.
  //
  // The IIFE region runs between `const __candidates = [...]` and the
  // closing `})();` of the IIFE — extracting that region lets the test
  // execute the runtime logic without spawning the full pipeline's
  // runAgent calls.

  /** Compile a fixture, extract the disk-probe IIFE expression for the
   *  given branch bind, and return a runnable script source that supplies
   *  fileExists from a literal map of paths → exists. */
  function buildProbeScript(
    emit: string,
    bindName: string,
    existsMap: Record<string, boolean>,
  ): string {
    const iifeOpenIdx = emit.indexOf(`const ${bindName} = (() => {`);
    if (iifeOpenIdx === -1) {
      throw new Error(
        `buildProbeScript: emit has no disk-probe IIFE for bind '${bindName}'.\n${emit}`,
      );
    }
    const iifeStartIdx = emit.indexOf('(() => {', iifeOpenIdx);
    // Find the matching close — the IIFE ends with `})();` at the right
    // indent level. The shape is well-formed, so we scan forward for the
    // first `})();` after iifeStartIdx.
    const closeMarker = '})();';
    const iifeEndIdx = emit.indexOf(closeMarker, iifeStartIdx) + closeMarker.length;
    if (iifeEndIdx < closeMarker.length) {
      throw new Error(`buildProbeScript: could not find IIFE close in emit.\n${emit}`);
    }
    const iifeExpr = emit.slice(iifeStartIdx, iifeEndIdx - 1); // strip trailing ';'
    return [
      `const __existsMap = ${JSON.stringify(existsMap)};`,
      `const fileExists = (p) => Boolean(__existsMap[p]);`,
      `try {`,
      `  const result = ${iifeExpr};`,
      `  process.stdout.write(JSON.stringify({ ok: true, value: result }));`,
      `} catch (e) {`,
      `  process.stdout.write(JSON.stringify({ ok: false, message: e.message }));`,
      `}`,
    ].join('\n');
  }

  /** Compile a fixture that emits a disk-probe IIFE for `outcome` with the
   *  two leaf paths `A.md` + `B.md` (or shared path when sharedPath is set). */
  function compileTwoArmFixture(opts: { sharedPath?: string } = {}): string {
    const thenProduces = opts.sharedPath ?? 'A.md';
    const elseProduces = opts.sharedPath ?? 'B.md';
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: ${thenProduces}
          bind: aBind
      else:
        - step: b
          input: $x
          produces: ${elseProduces}
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
    bind: consOut
`,
    });
    return compile(yamlPath, { resumeFrom: 'consOut' });
  }

  it('H-1: only then-arm file exists — bind resolves to then path', () => {
    const emit = compileTwoArmFixture();
    const script = buildProbeScript(emit, 'outcome', { 'A.md': true, 'B.md': false });
    const r = runIIFEScript(script);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, value: 'A.md' });
  });

  it('H-2: only else-arm file exists — bind resolves to else path', () => {
    const emit = compileTwoArmFixture();
    const script = buildProbeScript(emit, 'outcome', { 'A.md': false, 'B.md': true });
    const r = runIIFEScript(script);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, value: 'B.md' });
  });

  it('H-3: neither file exists — IIFE throws with both paths named', () => {
    const emit = compileTwoArmFixture();
    const script = buildProbeScript(emit, 'outcome', { 'A.md': false, 'B.md': false });
    const r = runIIFEScript(script);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('"A.md"');
    expect(parsed.message).toContain('"B.md"');
    expect(parsed.message).toContain('Resume error');
  });

  it('H-4: both files exist different paths — IIFE throws ambiguity error', () => {
    const emit = compileTwoArmFixture();
    const script = buildProbeScript(emit, 'outcome', { 'A.md': true, 'B.md': true });
    const r = runIIFEScript(script);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('"A.md"');
    expect(parsed.message).toContain('"B.md"');
    expect(parsed.message).toMatch(/ambiguous|multiple/i);
  });

  it('H-5: both arms produce the same path — unique-path fast path (no IIFE) resolves to that path', () => {
    // When both arms write to the same path, the disk-probe collapses to
    // a path-literal fast path: `const outcome = "S.md";` — no IIFE, no
    // ternary, no disk probe.
    const emit = compileTwoArmFixture({ sharedPath: 'S.md' });
    // The fast-path is a literal assignment; the emit must NOT contain
    // the IIFE shape for `outcome`.
    expect(emit).toContain('const outcome = "S.md";');
    expect(emit).not.toMatch(/const outcome = \(\(\) => \{/);
    // The literal binds unconditionally — no disk-probe; no fixtures
    // need to exist for this case.
  });
});

describe('branch arm bind hoisting — runtime retry verification (Group I)', () => {
  // Group I exercises the closure-call retry path via real Node execution.
  // The emit's `agenticloom/runtime` import is resolved via an inline stub written
  // alongside the emit; the stub's runAgent counts invocations + records
  // arguments, which the test inspects after the spawned process exits.
  //
  // Per the plan: stub the runtime helpers (runAgent, reviewLoop, etc.)
  // with invocation-counting wrappers and assert the count + arguments
  // after the emit runs. The harness writes the emit + stub + a tiny
  // driver to a tmp dir, execFileSync's the driver, and reads back a JSON
  // log of recorded calls from a file the stub writes.

  /** Build a self-contained Node script that:
   *  1. Defines an inline `agenticloom/runtime` mock (runAgent + reviewLoop +
   *     aggregate + retryGateZone + humanGate + parallel + readJson +
   *     readText + fileExists + HaltPipelineError).
   *  2. Inlines the compiled emit (with the `import { ... } from
   *     'agenticloom/runtime'` line replaced by destructured references to the
   *     local mock).
   *  3. Calls `main()` with the test's input args.
   *  4. Writes the recorded call log to a JSON file.
   *
   *  `runAgentBehavior` describes what each runAgent call returns: a
   *  function (callIndex, args) → string. `gateBehavior` shapes the
   *  retryGateZone result on each attempt — `attemptCount` controls how
   *  many retry-callback re-fires happen.
   */
  function buildExecScript(
    emit: string,
    opts: {
      input: string;
      runAgentBehavior?: string;
      gateBehavior?: string;
      reviewLoopBehavior?: string;
      logPath: string;
    },
  ): string {
    // Replace the emit's runtime import + argv-guard with our inline mock +
    // direct main() invocation. The emit is plain JS (no TS syntax leaks
    // into the closure declarations), so Node's ESM loader parses it
    // directly without any pre-processing.
    const importLineRegex = /^import \{[^}]*\} from "agenticloom\/runtime";$/m;
    const argvBlockStart = emit.indexOf('const __args = process.argv.slice(2);');
    const emitPreArgv = emit
      .slice(0, argvBlockStart)
      .replace(importLineRegex, '// runtime imports replaced by inline mock below');
    return [
      `import { writeFileSync } from 'fs';`,
      `const __calls = [];`,
      `function record(name, args) { __calls.push({ name, args }); }`,
      `const runAgent = async (name, input, produces, opts) => {`,
      `  record('runAgent', { name, input, produces, opts });`,
      `  return (${opts.runAgentBehavior ?? '() => produces ?? "stdout"'})(__calls.length - 1, name, input, produces);`,
      `};`,
      `const reviewLoop = async (opts) => {`,
      `  record('reviewLoop', { opts });`,
      `  return (${opts.reviewLoopBehavior ?? '() => "loop-result"'})(__calls.length - 1, opts);`,
      `};`,
      `const aggregate = async (opts) => {`,
      `  record('aggregate', { opts });`,
      `  return 'fail';`,
      `};`,
      `let __gateAttempt = 0;`,
      `const retryGateZone = async (opts) => {`,
      `  record('retryGateZone', { kind: opts.kind, initialVerdict: opts.initialVerdict });`,
      `  const attemptShape = (${opts.gateBehavior ?? '() => [true]'})();`,
      `  for (const retry of attemptShape) {`,
      `    if (retry) await opts.retry(opts.initialVerdict);`,
      `  }`,
      `  return 'pass';`,
      `};`,
      `const humanGate = async () => {};`,
      `const parallel = async (fns) => Promise.all(fns.map(f => f()));`,
      `const readJson = (p) => ({});`,
      `const readText = (p) => '';`,
      `const fileExists = (p) => false;`,
      `class HaltPipelineError extends Error {}`,
      emitPreArgv,
      // Replace the emit's argv-guard with a direct invocation using our test input.
      `main(${JSON.stringify(opts.input)}).then(() => {`,
      `  writeFileSync(${JSON.stringify(opts.logPath)}, JSON.stringify(__calls));`,
      `}).catch((e) => {`,
      `  writeFileSync(${JSON.stringify(opts.logPath)}, JSON.stringify({ error: e.message, calls: __calls }));`,
      `  process.exit(1);`,
      `});`,
    ].join('\n');
  }

  /** Run the script, then read the log file. */
  function execAndReadLog(
    script: string,
    logPath: string,
  ): Array<{ name: string; args: Record<string, unknown> }> {
    const scriptDir = mkdtempSync(path.join(tmpdir(), 'loom-exec-'));
    try {
      const scriptPath = path.join(scriptDir, 'driver.mjs');
      const actualLogPath = path.join(scriptDir, path.basename(logPath));
      // Rewrite the script to reference the actual logPath in this dir.
      const finalScript = script.split(JSON.stringify(logPath)).join(JSON.stringify(actualLogPath));
      writeFileSync(scriptPath, finalScript);
      const result = spawnSync(process.execPath, [scriptPath], {
        encoding: 'utf-8',
        cwd: scriptDir,
      });
      if (result.status !== 0) {
        throw new Error(
          `Group I exec failed:\n` +
            (result.error ? `SPAWN ERROR: ${result.error.message}\n` : '') +
            `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nSCRIPT:\n${finalScript}`,
        );
      }
      const logRaw = readFileSync(actualLogPath, 'utf-8');
      return JSON.parse(logRaw);
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  }

  function compileSimpleRetryFixture(): string {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry-Prompt-Text.
`,
    });
    return compile(yamlPath);
  }

  it('I-1: single-step retry-target arm — retry re-fires the step (2 runAgent calls for the arm)', () => {
    const emit = compileSimpleRetryFixture();
    // The on_fail gate is a step-host gate (the `rev` step's on_fail).
    // Step-host gates use a different runtime helper than retryGateZone
    // — they emit an explicit catch/retry block. We'll exercise the
    // closure-call shape by checking the emitted code DOES call the
    // closure on retry (the on_fail emit's catch block).
    expect(emit).toContain('const runThen_outcome');
    expect(emit).toContain('const runElse_outcome');
    expect(emit).toMatch(/outcome = await runThen_outcome\("Retry-Prompt-Text\.", \[\]\)/);
  });

  it('I-2: review_loop terminal — closure body calls reviewLoop (re-runs on retry)', () => {
    // The closure body's `await reviewLoop(...)` line ensures retry re-runs
    // the loop from iteration 1 (v1 pin — no revise-prompt threading
    // into review_loop terminals).
    const yamlPath = setupFixture({
      agents: ['w', 'r', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - review_loop:
            writer: w
            reviewer: r
            input: $x
            writer_produces: w.md
            reviewer_produces: r.json
            verdict_field: status
            bind: loopBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    const emit = compile(yamlPath);
    const thenStart = emit.indexOf('const runThen_outcome');
    const thenReturn = emit.indexOf('return loopBind;', thenStart);
    const thenBody = emit.slice(thenStart, thenReturn);
    expect(thenBody).toMatch(/await reviewLoop\(/);
  });

  it('I-3: nested branch terminal — inner closures live inside outer closure body', () => {
    // The outer arm's closure body contains the inner branch's closure
    // declarations + if/else. On retry, calling the outer closure
    // re-executes the inner branch by virtue of the outer body
    // re-evaluating its if/else.
    const yamlPath = setupFixture({
      agents: ['ia', 'ib', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - branch:
            when: $x
            bind: innerOutcome
            then:
              - step: ia
                input: $x
                produces: IA.md
                bind: iaBind
            else:
              - step: ib
                input: $x
                produces: IB.md
                bind: ibBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    const emit = compile(yamlPath);
    const outerStart = emit.indexOf('const runThen_outcome');
    const outerReturn = emit.indexOf('return innerOutcome;', outerStart);
    const outerBody = emit.slice(outerStart, outerReturn);
    expect(outerBody).toContain('const runThen_innerOutcome');
    expect(outerBody).toContain('const runElse_innerOutcome');
  });

  it('I-4: multi-step arm — every step in the arm executes on every closure invocation (real run)', () => {
    // Aggregate-host retry zone (so we can drive the retry via our mock's
    // gateBehavior). The mock fires the retry callback exactly once; both
    // arm steps should execute on first call AND on retry → 2 runAgent
    // invocations per step → 4 total for 'a1' + 'a2'.
    const yamlPath = setupFixture({
      agents: ['a1', 'a2', 'b'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a1
          input: $x
          produces: A1.md
          bind: a1Bind
        - step: a2
          input: $a1Bind
          produces: A2.md
          bind: a2Bind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - aggregate:
      inputs: { a: $outcome }
      verdict_field: status
      bind: aggOut
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    const emit = compile(yamlPath);
    const logPath = '/tmp/loom-i4.log.json';
    const script = buildExecScript(emit, {
      input: 'truthy', // when: $x ⇒ truthy string ⇒ then arm fires
      // Single retry: gate calls opts.retry once.
      gateBehavior: '() => [true]',
      logPath,
    });
    const calls = execAndReadLog(script, logPath);
    // Then-arm has 'a1' + 'a2'; both fire on initial call AND on the one
    // retry → 2 calls each → 4 runAgent calls total. Else-arm's 'b' must
    // NOT have fired (when is truthy).
    const a1Calls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'a1');
    const a2Calls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'a2');
    const bCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'b');
    expect(a1Calls).toHaveLength(2);
    expect(a2Calls).toHaveLength(2);
    expect(bCalls).toHaveLength(0);
  });

  it('I-5: retry callback threads revise prompt into terminal step input expression', () => {
    // The terminal step is `a` (no intermediate steps). The closure body
    // emits a's runAgent input expression as
    // `(revisePromptForTerminal ?? <normal input>)` — a RUNTIME `??`.
    // The main-pass call site passes the literal `undefined` as the closure
    // arg, so the parameter is undefined inside the closure and the `??`
    // falls through to the normal input (the resolved `$x` → the input
    // identifier `x` → 'truthy'). On the retry call the closure receives
    // the rendered revise prompt as an argument, and the `??` resolves to
    // that prompt.
    const yamlPath = setupFixture({
      agents: ['a', 'b'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - aggregate:
      inputs: { a: $outcome }
      verdict_field: status
      bind: aggOut
      retry_from: outcome
      revise_with:
        prompt: REVISE-PROMPT-LITERAL.
`,
    });
    const emit = compile(yamlPath);
    const logPath = '/tmp/loom-i5.log.json';
    const script = buildExecScript(emit, {
      input: 'truthy',
      gateBehavior: '() => [true]',
      logPath,
    });
    const calls = execAndReadLog(script, logPath);
    const aCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'a');
    expect(aCalls).toHaveLength(2);
    // Main pass: the closure-parameter `revisePromptForTerminal` is
    // undefined; the runtime `??` falls through to the step's normal input
    // expression. `inputExprFor($x)` resolves to the bare input identifier
    // `x`, whose value (from the pipeline argv) is 'truthy'.
    expect(aCalls[0].args.input).toBe('truthy');
    // Retry pass: the closure is invoked with the rendered revise prompt
    // as its argument; the runtime `??` resolves to the (non-null) prompt
    // string, substituting the normal input expression for this iteration.
    expect(aCalls[1].args.input).toBe('REVISE-PROMPT-LITERAL.');
  });

  it('I-6: revise prompt propagates ONLY to terminal step, not intermediate steps', () => {
    // Multi-step arm: `a1` (intermediate) + `a2` (terminal). The closure-body
    // emit threads `terminalContext` into the recursive emit, which attaches
    // it positionally to the last item only — `a2`. Only `a2`'s runAgent
    // input expression is rewritten to `(revisePromptForTerminal ?? <normal>)`;
    // `a1` keeps its plain input expression on every iteration.
    const yamlPath = setupFixture({
      agents: ['a1', 'a2', 'b'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a1
          input: $x
          produces: A1.md
          bind: a1Bind
        - step: a2
          input: $a1Bind
          produces: A2.md
          bind: a2Bind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - aggregate:
      inputs: { a: $outcome }
      verdict_field: status
      bind: aggOut
      retry_from: outcome
      revise_with:
        prompt: ONLY-TERMINAL-PROMPT.
`,
    });
    const emit = compile(yamlPath);
    const logPath = '/tmp/loom-i6.log.json';
    const script = buildExecScript(emit, {
      input: 'truthy',
      gateBehavior: '() => [true]',
      logPath,
    });
    const calls = execAndReadLog(script, logPath);
    const a1Calls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'a1');
    const a2Calls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'a2');
    expect(a1Calls).toHaveLength(2);
    expect(a2Calls).toHaveLength(2);
    // Intermediate step `a1` sees its normal input expression both times
    // (`inputExprFor($x)` → bare input identifier `x` = 'truthy'). The
    // revise prompt does NOT propagate to it.
    expect(a1Calls[0].args.input).toBe('truthy');
    expect(a1Calls[1].args.input).toBe('truthy');
    // Terminal step `a2`'s emit is `(revisePromptForTerminal ?? <normal>)`.
    // Main pass: parameter undefined → fall through to `wrapPathRef`'s
    // rendered template literal for `$a1Bind` (a1's produces path bound
    // to its runtime stdout/path, which the mock resolves to "A1.md").
    // Retry pass: parameter is the revise-prompt string → `??` resolves
    // to that string.
    expect(a2Calls[0].args.input).toBe(
      'a1 finished its work. Its output is at: A1.md\n\nRead the input file with your Read tool, then perform your task.',
    );
    expect(a2Calls[1].args.input).toBe('ONLY-TERMINAL-PROMPT.');
    // inputPaths follows the prompt in lockstep via the parallel runtime
    // `reviseInputPathsForTerminal ?? [<original>]`. This revise is
    // prompt-only, so on retry the inputPaths param is `[]` → the pre-flight
    // check validates NOTHING (the rewritten prompt names no feedback files).
    // The old single-emit-site behavior left the original `$a1Bind` check in
    // place on retry — a file the prompt-only retry agent no longer reads.
    const a2MainOpts = a2Calls[0].args.opts as { inputPaths?: unknown };
    const a2RetryOpts = a2Calls[1].args.opts as { inputPaths?: unknown };
    expect(a2MainOpts.inputPaths).toEqual(['A1.md']);
    expect(a2RetryOpts.inputPaths).toEqual([]);
  });

  it('I-7: nested-branch terminal threads revise prompt to its inner terminals', () => {
    // Outer branch's then-arm terminates in a nested branch. The nested
    // branch's then-arm terminates in step `inner`. On retry of the outer
    // branch (via the wrapping aggregate gate), the outer closure invokes
    // its nested-branch main-pass call site with `revisePromptForTerminal`.
    // The nested closure receives that argument and threads it to the
    // inner terminal step's runAgent input (nested-branch recursive
    // threading).
    const yamlPath = setupFixture({
      agents: ['inner', 'innerElse', 'outerElse'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outerBind
      then:
        - branch:
            when: $x
            bind: innerBind
            then:
              - step: inner
                input: $x
                produces: I.md
                bind: innerStepBind
            else:
              - step: innerElse
                input: $x
                produces: IE.md
                bind: innerElseStepBind
      else:
        - step: outerElse
          input: $x
          produces: OE.md
          bind: outerElseStepBind
  - aggregate:
      inputs: { a: $outerBind }
      verdict_field: status
      bind: aggOut
      retry_from: outerBind
      revise_with:
        prompt: NESTED-REVISE.
`,
    });
    const emit = compile(yamlPath);
    const logPath = '/tmp/loom-i7.log.json';
    const script = buildExecScript(emit, {
      input: 'truthy',
      gateBehavior: '() => [true]',
      logPath,
    });
    const calls = execAndReadLog(script, logPath);
    const innerCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'inner');
    // The inner step fires twice: once on main pass, once on retry.
    expect(innerCalls).toHaveLength(2);
    // Main pass: outer closure's call site passes the literal `undefined`,
    // and the outer closure's body in turn passes its (undefined) parameter
    // into the nested closure call, so the nested closure's parameter is
    // also undefined → the runtime `??` falls through to inner step's
    // normal input expression.
    expect(innerCalls[0].args.input).toBe('truthy');
    // Retry pass: outer closure invoked by retry callback with the
    // rendered revise prompt; outer closure's main-pass call site threads
    // its parameter into the nested closure invocation; nested closure's
    // step terminal sees the revise prompt via the runtime `??`.
    expect(innerCalls[1].args.input).toBe('NESTED-REVISE.');
    // Highest-risk path: the inner terminal's runtime inputPaths must follow
    // revise_with recursively, exactly as the prompt does. The
    // `reviseInputPathsForTerminal` param threads outer-closure → nested
    // closure → inner step. This revise is prompt-only, so the retry pass
    // propagates `[]` all the way down → the inner pre-flight check validates
    // NOTHING; the main pass validates the inner step's original `$x` input.
    const innerMainOpts = innerCalls[0].args.opts as { inputPaths?: unknown };
    const innerRetryOpts = innerCalls[1].args.opts as { inputPaths?: unknown };
    expect(innerMainOpts.inputPaths).toEqual(['truthy']);
    expect(innerRetryOpts.inputPaths).toEqual([]);
  });

  it('I-8: single-arm bound branch with side-effect step (no produces) — retry threads revise prompt', () => {
    // Side-effect-step pattern: a single-arm bound branch whose terminal
    // step has no `produces:` and no `bind:`, used only as a `retry_from`
    // target. The branch's bind classifies as non-consumable (single-arm,
    // no else); position-based terminal dispatch still wires
    // `revisePromptForTerminal` into the side-effect step's runAgent
    // input on retry. The aggregate's `inputs` consume a separate
    // file-bound producer (`$rev`) so consumability is never required on the
    // branch's bind.
    const yamlPath = setupFixture({
      agents: ['writer', 'side', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [ticket]
flow:
  - step: writer
    input: $ticket
    produces: DRAFT.md
    bind: writerOut
  - branch:
      when: $ticket
      bind: branchPoint
      then:
        - step: side
          input: $ticket
  - step: reviewer
    input: $writerOut
    produces: review.json
    bind: rev
  - aggregate:
      inputs: { r: $rev }
      verdict_field: status
      bind: overall
      retry_from: branchPoint
      revise_with:
        prompt: SIDE-EFFECT-REVISE.
`,
    });
    const emit = compile(yamlPath);
    const logPath = '/tmp/loom-i8.log.json';
    const script = buildExecScript(emit, {
      input: 'ticket-data',
      gateBehavior: '() => [true]',
      logPath,
    });
    const calls = execAndReadLog(script, logPath);
    const sideCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'side');
    expect(sideCalls).toHaveLength(2);
    // Main pass: closure call site passes the literal `undefined` as the
    // closure arg → `revisePromptForTerminal` is undefined inside → runtime
    // `??` falls through to side-effect step's normal input (`$ticket`
    // resolves to the bare input identifier `ticket` = 'ticket-data').
    expect(sideCalls[0].args.input).toBe('ticket-data');
    // Retry pass: closure invoked with the rendered revise prompt → runtime
    // `??` resolves to that prompt.
    expect(sideCalls[1].args.input).toBe('SIDE-EFFECT-REVISE.');
  });

  it('I-9: single-arm bound branch with terminal step bind, no produces — retry threads revise prompt', () => {
    // Same shape as I-8 but the side-effect step carries an explicit `bind:`
    // for arm-local reference. The branch still classifies as non-consumable
    // (single-arm), so the bind cannot be `$ref`-consumed downstream — but
    // position-based dispatch wires the revise prompt regardless of whether
    // the terminal step has a bind.
    const yamlPath = setupFixture({
      agents: ['writer', 'side', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [ticket]
flow:
  - step: writer
    input: $ticket
    produces: DRAFT.md
    bind: writerOut
  - branch:
      when: $ticket
      bind: branchPoint
      then:
        - step: side
          input: $ticket
          bind: sideOut
  - step: reviewer
    input: $writerOut
    produces: review.json
    bind: rev
  - aggregate:
      inputs: { r: $rev }
      verdict_field: status
      bind: overall
      retry_from: branchPoint
      revise_with:
        prompt: SIDE-WITH-BIND-REVISE.
`,
    });
    const emit = compile(yamlPath);
    const logPath = '/tmp/loom-i9.log.json';
    const script = buildExecScript(emit, {
      input: 'ticket-data',
      gateBehavior: '() => [true]',
      logPath,
    });
    const calls = execAndReadLog(script, logPath);
    const sideCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'side');
    expect(sideCalls).toHaveLength(2);
    expect(sideCalls[0].args.input).toBe('ticket-data');
    expect(sideCalls[1].args.input).toBe('SIDE-WITH-BIND-REVISE.');
  });

  it('I-10: nested single-arm bound branches — revise prompt threads through outer to inner terminal', () => {
    // The outer branch has a single arm whose terminal is a nested branch;
    // the nested branch also has a single arm whose terminal is a side-effect
    // step. On retry of the outer (via the aggregate gate's `retry_from`),
    // the outer closure's main-pass call site for the nested branch threads
    // its `revisePromptForTerminal` parameter into the nested closure;
    // position-based dispatch then propagates the parameter to the nested
    // closure's terminal step's runAgent input.
    const yamlPath = setupFixture({
      agents: ['writer', 'inner', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [ticket]
flow:
  - step: writer
    input: $ticket
    produces: DRAFT.md
    bind: writerOut
  - branch:
      when: $ticket
      bind: outerPoint
      then:
        - branch:
            when: $ticket
            bind: innerPoint
            then:
              - step: inner
                input: $ticket
  - step: reviewer
    input: $writerOut
    produces: review.json
    bind: rev
  - aggregate:
      inputs: { r: $rev }
      verdict_field: status
      bind: overall
      retry_from: outerPoint
      revise_with:
        prompt: NESTED-SINGLE-ARM-REVISE.
`,
    });
    const emit = compile(yamlPath);
    const logPath = '/tmp/loom-i10.log.json';
    const script = buildExecScript(emit, {
      input: 'ticket-data',
      gateBehavior: '() => [true]',
      logPath,
    });
    const calls = execAndReadLog(script, logPath);
    const innerCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'inner');
    expect(innerCalls).toHaveLength(2);
    expect(innerCalls[0].args.input).toBe('ticket-data');
    expect(innerCalls[1].args.input).toBe('NESTED-SINGLE-ARM-REVISE.');
  });

  it('I-11: mixed-kind asymmetric arms with no $ref consumer — retry threads revise prompt to the step terminal', () => {
    // Mixed-kind asymmetric arms admitted at construction: one arm
    // terminates in a file-bound producer (then-arm), the other does not
    // (else-arm — side-effect step, no produces). The classification flags
    // the bind as non-consumable with
    // `reason.kind: 'arm_terminal_not_file_bound'` on the else arm; a
    // `$ref` consumer would reject, but `retry_from` is not a `$ref`
    // consumer and is admitted unconditionally. Position-based dispatch
    // threads the revise prompt to whichever arm's terminal step runs on
    // retry.
    const yamlPath = setupFixture({
      agents: ['writer', 'fileArm', 'sideArm', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [ticket]
flow:
  - step: writer
    input: $ticket
    produces: DRAFT.md
    bind: writerOut
  - branch:
      when: $ticket
      bind: asymmetric
      then:
        - step: fileArm
          input: $ticket
          produces: FILE.md
      else:
        - step: sideArm
          input: $ticket
  - step: reviewer
    input: $writerOut
    produces: review.json
    bind: rev
  - aggregate:
      inputs: { r: $rev }
      verdict_field: status
      bind: overall
      retry_from: asymmetric
      revise_with:
        prompt: ASYMMETRIC-REVISE.
`,
    });
    const emit = compile(yamlPath);
    const logPath = '/tmp/loom-i11.log.json';
    const script = buildExecScript(emit, {
      input: 'truthy',
      gateBehavior: '() => [true]',
      logPath,
    });
    const calls = execAndReadLog(script, logPath);
    const fileArmCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'fileArm');
    // when: $ticket → truthy → then-arm fires. Both main pass + retry → 2 calls.
    expect(fileArmCalls).toHaveLength(2);
    expect(fileArmCalls[0].args.input).toBe('truthy');
    expect(fileArmCalls[1].args.input).toBe('ASYMMETRIC-REVISE.');
    // sideArm (else) does not fire on this when-truthy run.
    const sideArmCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'sideArm');
    expect(sideArmCalls).toHaveLength(0);
  });

  describe('retry-target inputPaths follow revise_with (Group L)', () => {
    // A branch-as-retry-target's terminal step is emitted ONCE and reused on
    // both passes via the runtime `reviseInputPathsForTerminal ?? [<original>]`.
    // These exec-based tests verify, per pass, the actual runtime `opts.inputPaths`
    // the pre-flight check would validate — that on retry it follows `revise_with`
    // (the files the rewritten prompt names), not the terminal's stale `inputs:`.
    // The aggregate gate hosts the retry; `gateBehavior: '() => [true]'` fires
    // exactly one retry pass.

    // then-arm fixture: `when: $x` truthy → the then-arm terminal `a` is the
    // step that runs on both passes. `fb` (before the zone) produces the
    // feedback file the revise modes point at.
    function thenArmFixture(reviseWithYaml: string): string {
      const yamlPath = setupFixture({
        agents: ['fb', 'a', 'b'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: fb
    input: $x
    produces: FB.md
    bind: fbBind
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - aggregate:
      inputs: { o: $outcome }
      verdict_field: status
      bind: aggOut
      retry_from: outcome
${reviseWithYaml}
`,
      });
      return compile(yamlPath);
    }

    // else-arm fixture: `when: $x === 'pick-then'` is false for the input below,
    // so the else-arm terminal `b` is the step that runs on both passes.
    function elseArmFixture(reviseWithYaml: string): string {
      const yamlPath = setupFixture({
        agents: ['fb', 'a', 'b'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: fb
    input: $x
    produces: FB.md
    bind: fbBind
  - branch:
      when: $x === 'pick-then'
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - aggregate:
      inputs: { o: $outcome }
      verdict_field: status
      bind: aggOut
      retry_from: outcome
${reviseWithYaml}
`,
      });
      return compile(yamlPath);
    }

    // multi-input fixture: two pre-zone feedback steps (`fb` → FB.md, `fb2` →
    // FB2.md) so `revise_with.inputs` can name MORE than one bind — pins the
    // ordered rendering of multiple tokens through `reviseInputPaths.join`.
    function multiInputThenFixture(reviseWithYaml: string): string {
      const yamlPath = setupFixture({
        agents: ['fb', 'fb2', 'a', 'b'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: fb
    input: $x
    produces: FB.md
    bind: fbBind
  - step: fb2
    input: $x
    produces: FB2.md
    bind: fb2Bind
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - aggregate:
      inputs: { o: $outcome }
      verdict_field: status
      bind: aggOut
      retry_from: outcome
${reviseWithYaml}
`,
      });
      return compile(yamlPath);
    }

    // nested fixture: outer branch retry-target whose then-arm terminates in a
    // nested branch terminating in `inner`. A pre-zone `fb` step supplies the
    // feedback file, so an inputs-bearing revise threads a NON-empty array
    // through outer-closure -> nested closure -> inner step (I-7 only covers
    // the prompt-only `[]` case).
    function nestedInputsFixture(reviseWithYaml: string): string {
      const yamlPath = setupFixture({
        agents: ['fb', 'inner', 'innerElse', 'outerElse'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: fb
    input: $x
    produces: FB.md
    bind: fbBind
  - branch:
      when: $x
      bind: outerBind
      then:
        - branch:
            when: $x
            bind: innerBind
            then:
              - step: inner
                input: $x
                produces: I.md
                bind: innerStepBind
            else:
              - step: innerElse
                input: $x
                produces: IE.md
                bind: innerElseStepBind
      else:
        - step: outerElse
          input: $x
          produces: OE.md
          bind: outerElseStepBind
  - aggregate:
      inputs: { a: $outerBind }
      verdict_field: status
      bind: aggOut
      retry_from: outerBind
${reviseWithYaml}
`,
      });
      return compile(yamlPath);
    }

    function runExec(emit: string, input: string, logPath: string) {
      const script = buildExecScript(emit, {
        input,
        gateBehavior: '() => [true]',
        logPath,
      });
      return execAndReadLog(script, logPath);
    }

    it('retry-target inputPaths: then-arm terminal — inputs-only retry validates the revise_with bind, not the original', () => {
      const emit = thenArmFixture(`      revise_with:\n        inputs:\n          - $fbBind`);
      const calls = runExec(emit, 'truthy', '/tmp/loom-l1.log.json');
      const aCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'a');
      expect(aCalls).toHaveLength(2);
      // Main pass: the terminal's original `$x` input (runtime value 'truthy').
      expect((aCalls[0].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['truthy']);
      // Retry pass: the revise_with.inputs bind `$fbBind` (fb produces FB.md),
      // and NOT the terminal's original `$x` — the pre-flight check now validates
      // exactly the files the rewritten prompt points the agent at.
      expect((aCalls[1].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['FB.md']);
    });

    it('retry-target inputPaths: then-arm terminal — prompt+inputs retry validates the revise_with bind, not the original', () => {
      const emit = thenArmFixture(
        `      revise_with:\n        prompt: Address the feedback.\n        inputs:\n          - $fbBind`,
      );
      const calls = runExec(emit, 'truthy', '/tmp/loom-l2.log.json');
      const aCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'a');
      expect(aCalls).toHaveLength(2);
      expect((aCalls[0].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['truthy']);
      // prompt+inputs derives inputPaths from `inputs:` (the prompt rewrite is
      // orthogonal), so retry still validates the revise bind, not the original.
      expect((aCalls[1].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['FB.md']);
    });

    it('retry-target inputPaths: else-arm terminal — inputs-only retry validates the revise_with bind, not the original', () => {
      const emit = elseArmFixture(`      revise_with:\n        inputs:\n          - $fbBind`);
      // when: $x === 'pick-then' is false → else-arm terminal `b` runs.
      const calls = runExec(emit, 'pick-else', '/tmp/loom-l3.log.json');
      const bCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'b');
      expect(bCalls).toHaveLength(2);
      expect((bCalls[0].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['pick-else']);
      expect((bCalls[1].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['FB.md']);
    });

    it('retry-target inputPaths: else-arm terminal — prompt+inputs retry validates the revise_with bind, not the original', () => {
      const emit = elseArmFixture(
        `      revise_with:\n        prompt: Address the feedback.\n        inputs:\n          - $fbBind`,
      );
      // when: $x === 'pick-then' is false → else-arm terminal `b` runs.
      const calls = runExec(emit, 'pick-else', '/tmp/loom-l6.log.json');
      const bCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'b');
      expect(bCalls).toHaveLength(2);
      expect((bCalls[0].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['pick-else']);
      // prompt+inputs derives inputPaths from `inputs:` — the prompt rewrite is
      // orthogonal — so the else-arm retry validates the revise bind, not `$x`.
      expect((bCalls[1].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['FB.md']);
    });

    it('retry-target inputPaths: then-arm terminal — prompt-only retry validates nothing while main pass validates the original', () => {
      const emit = thenArmFixture(`      revise_with:\n        prompt: Retry the branch.`);
      const calls = runExec(emit, 'truthy', '/tmp/loom-l4.log.json');
      const aCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'a');
      expect(aCalls).toHaveLength(2);
      // Main pass validates the original `$x`.
      expect((aCalls[0].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['truthy']);
      // Prompt-only revise names no feedback files → the retry inputPaths param
      // is `[]` → `[] ?? [orig]` = `[]` → the runtime requireFile loop iterates
      // zero times → validates NOTHING.
      expect((aCalls[1].args.opts as { inputPaths?: unknown }).inputPaths).toEqual([]);
    });

    it('retry-target inputPaths: else-arm terminal — prompt-only retry validates nothing while main pass validates the original', () => {
      const emit = elseArmFixture(`      revise_with:\n        prompt: Retry the branch.`);
      const calls = runExec(emit, 'pick-else', '/tmp/loom-l5.log.json');
      const bCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'b');
      expect(bCalls).toHaveLength(2);
      expect((bCalls[0].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['pick-else']);
      expect((bCalls[1].args.opts as { inputPaths?: unknown }).inputPaths).toEqual([]);
    });

    it('retry-target inputPaths: branch terminal emits the runtime-conditional inputPaths clause', () => {
      // Compile-string assertion for the mechanism itself: the terminal's
      // inputPaths is a runtime `??` expression, not a compile-time array — the
      // single emit serves both passes. Note (known ripple): EVERY bound-branch
      // terminal carries this clause now, not only retry-targets; runtime
      // behavior is preserved (non-retry terminals are only ever called with
      // `undefined` → fall through to `[<original>]`).
      const emit = thenArmFixture(`      revise_with:\n        prompt: Retry the branch.`);
      expect(emit).toMatch(/inputPaths: reviseInputPathsForTerminal \?\? \[x\]/);
    });

    it('retry-target inputPaths: then-arm terminal — multi-input retry validates all revise_with binds in order, not the original', () => {
      // revise_with.inputs naming two binds must render BOTH tokens, in order,
      // into the retry pass's inputPaths — guards the `reviseInputPaths.join`
      // rendering against single-bind-only coverage.
      const emit = multiInputThenFixture(
        `      revise_with:\n        inputs:\n          - $fbBind\n          - $fb2Bind`,
      );
      const calls = runExec(emit, 'truthy', '/tmp/loom-l7.log.json');
      const aCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'a');
      expect(aCalls).toHaveLength(2);
      expect((aCalls[0].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['truthy']);
      expect((aCalls[1].args.opts as { inputPaths?: unknown }).inputPaths).toEqual([
        'FB.md',
        'FB2.md',
      ]);
    });

    it('retry-target inputPaths: nested-branch inner terminal — inputs-bearing retry threads the revise_with bind recursively, not the original', () => {
      // Highest-risk path with a NON-empty array: the inner terminal's runtime
      // inputPaths must follow revise_with down outer-closure -> nested closure
      // -> inner step. I-7 only proves `[]` propagates; this proves a real bind
      // does too.
      const emit = nestedInputsFixture(`      revise_with:\n        inputs:\n          - $fbBind`);
      const calls = runExec(emit, 'truthy', '/tmp/loom-l8.log.json');
      const innerCalls = calls.filter((c) => c.name === 'runAgent' && c.args.name === 'inner');
      expect(innerCalls).toHaveLength(2);
      // Main pass validates the inner step's original `$x`.
      expect((innerCalls[0].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['truthy']);
      // Retry pass validates the revise_with bind threaded through both closures.
      expect((innerCalls[1].args.opts as { inputPaths?: unknown }).inputPaths).toEqual(['FB.md']);
    });
  });
});

describe('branch arm bind hoisting — closure-shape regression (Group J)', () => {
  it('J-1: closures declared BEFORE the if/else block', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    const runThenIdx = emitted.indexOf('const runThen_outcome');
    const runElseIdx = emitted.indexOf('const runElse_outcome');
    const ifIdx = emitted.indexOf('outcome = await runThen_outcome');
    expect(runThenIdx).toBeGreaterThan(-1);
    expect(runElseIdx).toBeGreaterThan(-1);
    expect(ifIdx).toBeGreaterThan(runThenIdx);
    expect(ifIdx).toBeGreaterThan(runElseIdx);
  });

  it('J-2: main-pass call site passes literal `undefined` (no revise prompt yet)', () => {
    // The closure parameter `revisePromptForTerminal` has no type
    // annotation so Node can parse the emit as `.mjs` (TS `?: string`
    // would SyntaxError there). The parameter is therefore required at
    // every call site. The main pass has no revise prompt to thread, so
    // it passes the literal `undefined` — the closure's terminal-step
    // emit uses `revisePromptForTerminal ?? <normal input>` to fall
    // through to the normal input on `undefined`.
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toContain('outcome = await runThen_outcome(undefined, undefined);');
    expect(emitted).toContain('outcome = await runElse_outcome(undefined, undefined);');
  });

  it('J-3: retry-callback call site uses revisePromptForTerminal as closure arg', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: rev
    input: $outcome
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: outcome
      revise_with:
        prompt: Retry.
`,
    });
    const emitted = compile(yamlPath);
    const retryIdx = emitted.indexOf('retry: async (currentVerdict) => {');
    expect(retryIdx).toBeGreaterThan(-1);
    const retrySlice = emitted.slice(retryIdx);
    // The retry call site threads the rendered revise prompt (the
    // JSON-quoted user string) as the closure's first argument; the second
    // is the runtime inputPaths (here `[]` — prompt-only revise validates
    // nothing on retry).
    expect(retrySlice).toMatch(/outcome = await runThen_outcome\("Retry\.", \[\]\);/);
    expect(retrySlice).toMatch(/outcome = await runElse_outcome\("Retry\.", \[\]\);/);
  });

  it('J-4: arm-internal binds do NOT appear at outer scope', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    // Locate the outer main body bounds: from `async function main` open
    // brace to the first `const runThen_outcome` declaration. Arm-internal
    // binds `aBind` / `bBind` should NOT appear in this slice as `const
    // <name>` or `let <name>` declarations.
    const mainStart = emitted.indexOf('async function main');
    const runThenStart = emitted.indexOf('const runThen_outcome');
    const outerPrefix = emitted.slice(mainStart, runThenStart);
    expect(outerPrefix).not.toMatch(/\b(let|const) aBind\b/);
    expect(outerPrefix).not.toMatch(/\b(let|const) bBind\b/);
  });

  it('J-5: tsc-clean for consumable branch with cons (load-bearing seal assertion)', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    // The act of running compileAndTypeCheck is the assertion — if the
    // closure leaked an arm-internal bind to outer scope, tsc would fail
    // with "Cannot find name."
    expect(() => compileAndTypeCheck(yamlPath)).not.toThrow();
  });

  it('J-6: bindless branch emits a bare if/else block (no let, no closures)', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      then:
        - step: a
          input: $x
          produces: A.md
      else:
        - step: b
          input: $x
          produces: B.md
`,
    });
    const emitted = compile(yamlPath);
    // Bare if/else, no closure declarations, no rejoin let.
    expect(emitted).toContain('if (x) {');
    expect(emitted).toContain('} else {');
    expect(emitted).not.toContain('const runThen_');
    expect(emitted).not.toContain('const runElse_');
    expect(emitted).not.toMatch(/^\s*let \w+;\s*$/m);
  });

  it('J-7: no-branch pipeline emit contains no closure-shape lines', () => {
    // Pipelines that never use branch-bind never trigger the closure-shape
    // emit path. The emit must contain zero `runThen_` / `runElse_`
    // declarations and zero branch-bind `let` slots. Guards against
    // accidental shape regressions where a non-branch-bind composition
    // would pick up closure scaffolding it doesn't need.
    const yamlPath = setupFixture({
      agents: ['writer', 'reviewer', 'follower'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: w.md
    bind: wBind
  - review_loop:
      writer: writer
      reviewer: reviewer
      input: $wBind
      writer_produces: w2.md
      reviewer_produces: r.json
      verdict_field: status
      bind: loopBind
  - step: follower
    input: $loopBind
    produces: f.md
    bind: fBind
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).not.toContain('runThen_');
    expect(emitted).not.toContain('runElse_');
    // No spurious `let <name>;` standalone declarations (the lone-let
    // pattern is unique to branch-bind rejoin slots).
    expect(emitted).not.toMatch(/^\s*let \w+;\s*$/m);
  });
});

describe('branch arm bind hoisting — non-trivial nested compositions (Group K)', () => {
  it('K-1: 3-deep nested branches with steps at each leaf, fully consumable', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'd', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: l1
      then:
        - branch:
            when: $x
            bind: l2
            then:
              - branch:
                  when: $x
                  bind: l3
                  then:
                    - step: a
                      input: $x
                      produces: A.md
                  else:
                    - step: b
                      input: $x
                      produces: B.md
            else:
              - step: c
                input: $x
                produces: C.md
      else:
        - step: d
          input: $x
          produces: D.md
  - step: cons
    input: $l1
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    expect(emitted).toContain('const runThen_l1');
    expect(emitted).toContain('const runThen_l2');
    expect(emitted).toContain('const runThen_l3');
  });

  it('K-2: 2-deep where outer terminal IS the inner branch — chained closure-call return', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outer
      then:
        - branch:
            when: $x
            bind: inner
            then:
              - step: a
                input: $x
                produces: A.md
            else:
              - step: b
                input: $x
                produces: B.md
      else:
        - step: c
          input: $x
          produces: C.md
  - step: cons
    input: $outer
    produces: out.md
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // The outer then-closure body contains the inner branch's closure
    // declarations + the if/else assignment + a return of the inner bind.
    expect(emitted).toContain('const runThen_outer');
    expect(emitted).toContain('const runThen_inner');
    // Outer arm's terminal is a nested branch, so the outer closure's
    // main-pass call site threads its own `revisePromptForTerminal`
    // parameter into the inner branch's closure invocation. The inner
    // closures recursively propagate it to their own terminals
    // (nested-branch recursive threading).
    expect(emitted).toMatch(
      /inner = await runThen_inner\(revisePromptForTerminal, reviseInputPathsForTerminal\);/,
    );
    expect(emitted).toMatch(
      /inner = await runElse_inner\(revisePromptForTerminal, reviseInputPathsForTerminal\);/,
    );
    expect(emitted).toMatch(/return inner;/);
    // The else-arm's step (no explicit bind) returns a fresh synthesized
    // identifier.
    expect(emitted).toMatch(/return _\d+;/);
  });

  it('K-3: nested branch inside a parallel inside an arm — closure inside parallel arrow', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'sib', 'inner-a', 'inner-b', 'c'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outer
      then:
        - parallel:
          - step: sib
            input: $x
            produces: sib.md
            bind: sibBind
          - branch:
              when: $x
              bind: inner
              then:
                - step: inner-a
                  input: $x
                  produces: ia.md
              else:
                - step: inner-b
                  input: $x
                  produces: ib.md
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: c
          input: $x
          produces: C.md
`,
    });
    // No $ref to outer downstream → non-consumable is fine; the test
    // just verifies the inner branch's closure declarations live inside
    // the parallel child's arrow function.
    const emitted = compileAndTypeCheck(yamlPath);
    // The inner branch is consumable on its own (both arms produce). Its
    // closures live inside the parallel child's `async () =>` body.
    expect(emitted).toContain('const runThen_inner');
  });

  it('K-4: review_loop compound reviewer subflow contains a nested branch', () => {
    // The subflow's reviewer block contains a nested branch whose closures
    // live INSIDE the subflow's `reviewerSubflow: async (loopBind) =>`
    // closure. The inner branch's bind seals to the subflow scope —
    // review_loop emits its reviewer subflow as a closure, so JS lexical
    // scoping seals subflow-internal binds. tsc validates the
    // closure-scope correctness; the inner branch's bind identifier must
    // not leak out of the subflow.
    const yamlPath = setupFixture({
      agents: ['w', 'innerA', 'innerB', 'apiCheck'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      input: $x
      writer_produces: w.md
      bind: spec
      reviewer:
        - branch:
            when: $spec
            bind: rev
            then:
              - step: innerA
                input: $spec
                produces: ia.json
                bind: iaBind
            else:
              - step: innerB
                input: $spec
                produces: ib.json
                bind: ibBind
        - step: apiCheck
          input: $rev
          produces: api.json
          bind: apiBind
        - aggregate:
            inputs:
              rev: $rev
              api: $apiBind
            verdict_field: status
            bind: overall
`,
    });
    const emitted = compileAndTypeCheck(yamlPath);
    // The subflow is wrapped in reviewerSubflow: async (loopBind) => { ... }.
    // The nested branch's closure declarations live inside that arrow body.
    expect(emitted).toContain('reviewerSubflow: async');
    expect(emitted).toContain('const runThen_rev');
    expect(emitted).toContain('const runElse_rev');
    // The compound review_loop emits `kind: 'compound'`.
    expect(emitted).toContain("kind: 'compound'");
  });
});

describe('foreach emit', () => {
  it('emits a module-level body closure + foreach call (bindless)', () => {
    const yamlPath = setupFixture({
      agents: ['worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
`,
    });
    const ts = compileAndTypeCheck(yamlPath);
    expect(ts).toMatch(/const __foreach_body_\d+ = async \(task, iterScratchDir\) => \{/);
    expect(ts).toMatch(/await foreach\(\{/);
    // Bindless foreach omits the bindName field entirely (optional in
    // ForeachOpts; runtime falls back to syntheticName).
    expect(ts).not.toMatch(/bindName:/);
    expect(ts).toMatch(/onIterationFail: "abort"/);
  });

  it('emits outer-scope declaration when bind is set', () => {
    const yamlPath = setupFixture({
      agents: ['worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
      bind: results
`,
    });
    const ts = compileAndTypeCheck(yamlPath);
    expect(ts).toMatch(/const results = await foreach\(\{/);
    expect(ts).toMatch(/bindName: "results"/);
  });

  it('emits onIterationFail: continue when set', () => {
    const yamlPath = setupFixture({
      agents: ['worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
      bind: results
      on_iteration_fail: continue
`,
    });
    const ts = compileAndTypeCheck(yamlPath);
    expect(ts).toMatch(/onIterationFail: "continue"/);
  });

  it('emits body content inside the closure with $task interpolated', () => {
    const yamlPath = setupFixture({
      agents: ['worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
`,
    });
    const ts = compileAndTypeCheck(yamlPath);
    const closureStart = ts.indexOf('const __foreach_body_');
    const closureEnd = ts.indexOf('};', closureStart);
    const closureBody = ts.slice(closureStart, closureEnd);
    expect(closureBody).toMatch(/await runAgent\("worker"/);
    // Template-literal interpolation of the as-bind.
    expect(closureBody).toMatch(/\$\{task\}/);
  });

  it('emits over: as the bare JS identifier for a $-prefixed file-bound bind', () => {
    // Regression: smoke testing surfaced foreach.over being wrapped in the
    // `<agent> finished its work. Its output is at: ${ref}...` agent-prompt
    // template (via inputExprFor), then handed verbatim to readFileSync —
    // ENOENT because the whole template string isn't a path. `over` is a
    // file path the runtime opens, NOT an input to an agent. Assert the
    // bare identifier shape with no wrap.
    const yamlPath = setupFixture({
      agents: ['planner', 'worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [seed]
flow:
  - step: planner
    input: $seed
    produces: plan.jsonl
    bind: plan
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
`,
    });
    const ts = compileAndTypeCheck(yamlPath);
    // Bare JS identifier, no template-literal wrap. The trailing comma
    // anchors the match to the field value, not a substring of a wrap.
    expect(ts).toMatch(/over: plan,/);
    // Defensive: assert the wrapped prompt template is absent.
    expect(ts).not.toMatch(/over: `planner finished its work/);
  });

  it('emits over: as a JSON-stringified literal for a non-$ path', () => {
    // The other valid `over:` shape is a literal path. Emit as a JS
    // string literal so the runtime helper opens the path directly.
    const yamlPath = setupFixture({
      agents: ['worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [seed]
flow:
  - foreach:
      over: /tmp/literal-plan.jsonl
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
`,
    });
    const ts = compileAndTypeCheck(yamlPath);
    expect(ts).toMatch(/over: "\/tmp\/literal-plan\.jsonl",/);
  });
});

describe('emitPreCursorItem: foreach', () => {
  it('rewrites pre-cursor foreach to const <bind> = undefined; (bind set)', () => {
    const yamlPath = setupFixture({
      agents: ['worker', 'after'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
      bind: results
  - step: after
    input: $plan
    produces: post.md
    bind: post
`,
    });
    const ts = compileAndTypeCheck(yamlPath, { resumeFrom: 'post' });
    expect(ts).toMatch(/const results = undefined;/);
  });

  it('emits nothing for pre-cursor foreach with no bind', () => {
    const yamlPath = setupFixture({
      agents: ['worker', 'after'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
  - step: after
    input: $plan
    produces: post.md
    bind: post
`,
    });
    const ts = compileAndTypeCheck(yamlPath, { resumeFrom: 'post' });
    expect(ts).not.toMatch(/__foreach_body_/);
    expect(ts).not.toMatch(/await foreach\(\{/);
  });
});

describe('foreach body scope sealing', () => {
  it('rejects outer-sibling $ref to a body-internal bind', () => {
    const yamlPath = setupFixture({
      agents: ['worker', 'outer'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
      bind: results
  - step: outer
    input: $w
    produces: outer.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/unknown bind/);
  });

  it('rejects outer-sibling $ref to the as-bind', () => {
    const yamlPath = setupFixture({
      agents: ['worker', 'outer'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
  - step: outer
    input: $task
    produces: outer.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/unknown bind/);
  });
});

describe('branch arm bind hoisting — regression', () => {
  it('REG-1: existing bindless branch fixtures continue to compile equivalently', () => {
    // Bindless branches emit a bare `if/else` block — no closure wrap,
    // no rejoin variable, no `let`. Arm-internal binds stay sealed by
    // the recursive emit's own scope snapshot.
    const yamlPath = setupFixture({
      agents: ['w'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: 'true'
      then:
        - step: w
          input: $x
          produces: t.md
      else:
        - step: w
          input: $x
          produces: e.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toContain('if (true) {');
    expect(emitted).toContain('} else {');
    expect(emitted).not.toContain('runThen_');
    expect(emitted).not.toContain('let ');
  });
});

describe('emit shape — inline-agent step', () => {
  // An inline `step:` (object form) resolves to its required `name` — used as
  // the runAgent name — and ALWAYS bakes its prompt into the opts bag as
  // `inlinePrompt:`. Persona-name steps emit byte-identically (no inlinePrompt).

  it('uses the inline name as the runAgent name and bakes inlinePrompt', () => {
    // No `agents:` — an inline agent references no persona file.
    const yamlPath = setupFixture({
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step:
      prompt: Review the diff and emit a verdict.
      name: reviewer
    input: $x
    produces: out.json
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("reviewer",/);
    expect(emitted).toMatch(/inlinePrompt: "Review the diff and emit a verdict\."/);
  });

  it('uses the inline name as the runAgent name even when a bind is set', () => {
    // The bind is the emit-internal variable name; the label is always the
    // inline agent's required `name`.
    const yamlPath = setupFixture({
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step:
      prompt: Do the thing.
      name: doer
    bind: myStep
    input: $x
    produces: out.json
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/const myStep = await runAgent\("doer",/);
    expect(emitted).toMatch(/inlinePrompt: "Do the thing\."/);
  });

  it('uses the inline name as the runAgent name for a bindless step', () => {
    // A bindless step gets a synthesized `_N` variable from fresh(); the
    // label stays the inline agent's required `name`, never the variable.
    const yamlPath = setupFixture({
      agents: ['persona-pre'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: persona-pre
    input: $x
    produces: pre.md
  - step:
      prompt: Do the thing.
      name: doer
    input: $x
    produces: out.json
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("doer",/);
    expect(emitted).toMatch(/inlinePrompt: "Do the thing\."/);
  });

  it('uses the inline name as the runAgent name inside a parallel block', () => {
    // A bindless parallel child gets a synthesized `_N` destructuring name
    // from resultNameFor; that emit-internal variable must never leak into
    // the runAgent name — the label is exactly the inline agent's `name`.
    const yamlPath = setupFixture({
      agents: ['persona-a'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - parallel:
      - step: persona-a
        input: $x
        produces: a.md
      - step:
          prompt: Scan for issues.
          name: par-scanner
        input: $x
        produces: scan.json
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("par-scanner",/);
    expect(emitted).not.toMatch(/runAgent\("_\d+",/);
    expect(emitted).toMatch(/inlinePrompt: "Scan for issues\."/);
  });

  it('emits a persona-name step byte-identically — no inlinePrompt clause', () => {
    // Parity guard: a persona step carries no inlinePrompt; its emit is the
    // same shape as before the AgentRef retype.
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("ac-writer",/);
    expect(emitted).not.toMatch(/inlinePrompt:/);
  });

  it('compiles an inline step with no persona file on disk (existence check is skipped)', () => {
    // validateAgentFilesExist only checks string (persona) steps; an inline
    // agent has no file to find. No `agents:` are created, so a persona step
    // named 'standalone' would fail compile — the inline form must not.
    const yamlPath = setupFixture({
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step:
      prompt: Do the thing.
      name: standalone
    input: $x
    produces: out.json
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("standalone",/);
  });

  it('re-bakes the inline prompt in the aggregate parse-retry rewrite closure', () => {
    // When an inline producer feeds an aggregate, the per-input rewrite
    // closure must re-fire the producer via its inline spawn form (the baked
    // prompt is the agent's identity) instead of degrading to a persona
    // `--agent <label>` lookup with no file. The closure carries the resolved
    // label as the runAgent name AND the baked inlinePrompt.
    const yamlPath = setupFixture({
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step:
      prompt: Produce the artifact.
      name: producer
    input: $x
    produces: out.json
    bind: r
  - aggregate:
      inputs: { r: $r }
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    // The closure re-fires the producer by its resolved label, threading
    // correctivePrompt as the input and the producer's producesPath.
    expect(emitted).toMatch(
      /rewriteProducerFiles:[\s\S]+runAgent\("producer", correctivePrompt, "out\.json"/,
    );
    // The same closure bakes the inline prompt so the retry spawn is inline.
    expect(emitted).toMatch(/rewriteProducerFiles:[\s\S]+inlinePrompt: "Produce the artifact\."/);
  });

  it('re-bakes the inline prompt in the rewrite closure for a pre-cursor producer (--resume-from)', () => {
    // Under --resume-from the inline producer is rewritten to a path-literal
    // bind-assignment, so the aggregate's rewrite closure is fed by
    // emitPreCursorItem's declare (agentName + inlinePrompt), not the main
    // pass's. The closure must still carry the inline label as the runAgent
    // name AND the baked prompt — dropping either would degrade the
    // parse-retry re-fire to a persona `--agent <label>` lookup with no file.
    const yamlPath = setupFixture({
      agents: ['mid-agent'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step:
      prompt: Produce the artifact.
      name: producer
    input: $x
    produces: out.json
    bind: r
  - step: mid-agent
    input: $x
    produces: mid.json
    bind: mid
  - aggregate:
      inputs: { r: $r, mid: $mid }
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath, { resumeFrom: 'mid' });
    // The pre-cursor producer is rewritten — a path-literal bind, no spawn...
    expect(emitted).toMatch(/const r = "out\.json";/);
    // ...yet its rewrite closure still re-fires by the inline label with the
    // baked prompt, mirroring the main-pass closure shape above.
    expect(emitted).toMatch(
      /rewriteProducerFiles:[\s\S]+runAgent\("producer", correctivePrompt, "out\.json"/,
    );
    expect(emitted).toMatch(/rewriteProducerFiles:[\s\S]+inlinePrompt: "Produce the artifact\."/);
  });

  it('re-bakes the inline prompt when an on_fail retry re-emits the retry_from target', () => {
    // The retry_from target is an inline producer; the step-gate retry
    // callback re-emits it through emitRunAgentExpr, so the inline prompt is
    // re-baked automatically rather than degrading to a persona lookup.
    const yamlPath = setupFixture({
      agents: ['reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step:
      prompt: Write the tests.
      name: tdd
    input: $x
    produces: tests.json
    bind: tests
  - step: reviewer
    input: $tests
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: tests
      revise_with:
        prompt: Address the feedback.
`,
    });
    const emitted = compile(yamlPath);
    // Inside the retry callback, the retry_from target re-fires by its inline
    // label and carries the baked prompt.
    expect(emitted).toMatch(
      /retry: async \(currentVerdict\) => \{[\s\S]+runAgent\("tdd",[\s\S]*?inlinePrompt: "Write the tests\."/,
    );
  });
});

describe('emit shape — inline-agent review_loop writer/reviewer', () => {
  // An inline `writer:` or single `reviewer:` (object form) resolves to its
  // required `name` — used as the reviewLoop `writer:` / `reviewer:` string —
  // plus a baked `writerInlinePrompt:` / `reviewerInlinePrompt:`. Persona
  // writer+reviewer emit byte-identically (no inline-prompt fields).

  it('bakes an inline named writer as writer label + writerInlinePrompt (persona reviewer)', () => {
    const yamlPath = setupFixture({
      agents: ['r'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer:
        prompt: Draft the spec.
        name: drafter
      reviewer: r
      input: $x
      writer_produces: out.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/writer: "drafter",/);
    expect(emitted).toMatch(/writerInlinePrompt: "Draft the spec\.",/);
    // The persona reviewer carries no inline prompt.
    expect(emitted).toMatch(/reviewer: "r",/);
    expect(emitted).not.toMatch(/reviewerInlinePrompt:/);
  });

  it('uses the inline writer name as the writer label even when the loop has a bind', () => {
    // The loop bind is the emit-internal variable; the writer label is always
    // the inline agent's required `name`.
    const yamlPath = setupFixture({
      agents: ['r'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer:
        prompt: Draft the spec.
        name: drafter
      reviewer: r
      input: $x
      bind: spec
      writer_produces: out.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/writer: "drafter",/);
    expect(emitted).toMatch(/writerInlinePrompt: "Draft the spec\.",/);
  });

  it('bakes an inline named single reviewer as reviewer label + reviewerInlinePrompt (persona writer)', () => {
    const yamlPath = setupFixture({
      agents: ['w'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      reviewer:
        prompt: Audit the draft.
        name: auditor
      input: $x
      writer_produces: out.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/reviewer: "auditor",/);
    expect(emitted).toMatch(/reviewerInlinePrompt: "Audit the draft\.",/);
    // The persona writer carries no inline prompt.
    expect(emitted).toMatch(/writer: "w",/);
    expect(emitted).not.toMatch(/writerInlinePrompt:/);
  });

  it('bakes both inline writer and inline reviewer prompts (no persona files needed)', () => {
    // Neither role references a persona file — validateAgentFilesExist skips
    // inline agents on both the writer and single-reviewer positions, so a
    // fixture with no `agents:` still compiles.
    const yamlPath = setupFixture({
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer:
        prompt: Draft the spec.
        name: drafter
      reviewer:
        prompt: Audit the draft.
        name: auditor
      input: $x
      writer_produces: out.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/writer: "drafter",/);
    expect(emitted).toMatch(/writerInlinePrompt: "Draft the spec\.",/);
    expect(emitted).toMatch(/reviewer: "auditor",/);
    expect(emitted).toMatch(/reviewerInlinePrompt: "Audit the draft\.",/);
  });

  it('emits a persona writer + persona reviewer byte-identically — no inline-prompt fields', () => {
    // Parity guard: the inline-prompt fields are gated on inline-ness, so an
    // all-persona single-reviewer loop emits the same shape as before the
    // AgentRef retype.
    const yamlPath = setupFixture({
      agents: ['w', 'r'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      reviewer: r
      input: $x
      writer_produces: out.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/writer: "w",/);
    expect(emitted).toMatch(/reviewer: "r",/);
    expect(emitted).not.toMatch(/writerInlinePrompt:/);
    expect(emitted).not.toMatch(/reviewerInlinePrompt:/);
  });

  it('bakes an inline writer prompt on the compound (subflow) reviewer path', () => {
    // The compound path emits the writer label + writerInlinePrompt the same
    // way the single path does; the subflow is unchanged and carries no single
    // reviewerInlinePrompt.
    const yamlPath = setupFixture({
      agents: ['sec', 'api'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer:
        prompt: Draft the spec.
        name: drafter
      input: $x
      writer_produces: out.md
      bind: spec
      reviewer:
        - step: sec
          input: $spec
          produces: sec.json
          bind: secOut
        - step: api
          input: $spec
          produces: api.json
          bind: apiOut
        - aggregate:
            inputs:
              security: $secOut
              api: $apiOut
            verdict_field: status
            bind: overall
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toContain("kind: 'compound'");
    expect(emitted).toMatch(/writer: "drafter",/);
    expect(emitted).toMatch(/writerInlinePrompt: "Draft the spec\.",/);
    expect(emitted).not.toMatch(/reviewerInlinePrompt:/);
  });

  it('resolves an inline reviewer step to its label in the compound reviewerPaths slot', () => {
    // The compound path hands the writer a `reviewerPaths` array on revise; each
    // entry's `agentName` is resolved through agentLabel, so an inline reviewer
    // step inside the subflow contributes its resolved label (here its `name`),
    // not the raw inline object. With an inline writer too, the whole loop needs
    // no persona files.
    const yamlPath = setupFixture({
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer:
        prompt: Draft the spec.
        name: drafter
      input: $x
      writer_produces: out.md
      bind: spec
      reviewer:
        - step:
            prompt: Audit the draft for security issues.
            name: secReviewer
          input: $spec
          produces: sec.json
          bind: secOut
        - aggregate:
            inputs:
              security: $secOut
            verdict_field: status
            bind: overall
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toContain("kind: 'compound'");
    // The reviewerPaths entry carries the inline reviewer step's resolved label,
    // not the inline object — exercises collectReviewerPaths' agentLabel call.
    expect(emitted).toMatch(/reviewerPaths: \[\{ agentName: "secReviewer", path: secOut \}\]/);
  });
});
