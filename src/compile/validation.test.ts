import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { compile } from './index.js';
import { agentFileLeaf, validatePersonaFile } from './validation.js';
import { setupCompileTestEnv, setupFixture } from './test-helpers.js';

let teardown: () => void;

beforeEach(() => {
  teardown = setupCompileTestEnv();
});

afterEach(() => {
  teardown();
});

describe('agentFileLeaf', () => {
  // The persona-file leaf must be the exact filename each CLI opens, so the
  // compile-time existence check probes for the persona at that leaf.
  it('returns the bare .md leaf for a claude agent', () => {
    expect(agentFileLeaf('claude', 'reviewer')).toBe('reviewer.md');
  });

  it('returns the .agent.md leaf for a copilot agent', () => {
    expect(agentFileLeaf('copilot', 'reviewer')).toBe('reviewer.agent.md');
  });
});

describe('validateAgentFilesExist (via compile)', () => {
  it('accepts a pipeline where all referenced agents have .md files', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: ok
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('rejects a pipeline that references an agent without a persona file', () => {
    const yamlPath = setupFixture({
      agents: ['only-this-one'],
      yaml: `
pipeline: missing
cli: claude
inputs: [x]
flow:
  - step: missing-agent
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /references agent 'missing-agent'.*no persona file exists at either layer.*\.claude\/agents\/missing-agent\.md/s,
    );
  });

  it('walks compound subflow steps when checking', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'], // only writer; reviewers missing
      yaml: `
pipeline: compound-missing
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: ac-writer
      input: $x
      writer_produces: out.md
      reviewer:
        - parallel:
            - step: missing-reviewer
              input: $out
              produces: r.json
              bind: r
        - aggregate:
            inputs: { r: $r }
            verdict_field: status
            bind: v
`,
    });
    expect(() => compile(yamlPath)).toThrow(/missing-reviewer/);
  });

  it('walks branch arms when checking', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: branch-missing
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
    bind: out
  - branch:
      when: 'true'
      then:
        - step: missing-then
          input: $out
          produces: t.md
      else:
        - step: missing-else
          input: $out
          produces: e.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/missing-(then|else)/);
  });

  it('detects missing agent referenced inside a foreach body', () => {
    // Per Decision M: the walker recurses into foreach bodies the same
    // way it descends into parallel + branch arms + review_loop subflows.
    // Without this, a typo / refactor leftover inside a foreach body
    // would only surface at runtime (first iteration spawn) instead of
    // at compile time.
    const yamlPath = setupFixture({
      agents: ['planner'],
      yaml: `
pipeline: foreach-missing
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: nonexistent-agent
          input: $task
          produces: out.md
          bind: w
`,
    });
    expect(() => compile(yamlPath)).toThrow(/nonexistent-agent/);
  });

  it('walks interactive human_gate agents (separate compile-time check)', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'], // ac-writer exists; gate-agent missing
      yaml: `
pipeline: gate-missing
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
    bind: out
  - human_gate:
      interactive: true
      agent: gate-agent
      input: $out
      prompt: review
`,
    });
    expect(() => compile(yamlPath)).toThrow(/gate-agent/);
  });

  it('validates a copilot pipeline against the .github/agents/<name>.agent.md leaf', () => {
    // The existence check must validate the SAME file the CLI opens. GitHub
    // Copilot CLI reads `<name>.agent.md` under `.github/agents/`, so a correct
    // copilot persona at that leaf must pass. setupFixture(cli: 'copilot')
    // writes exactly that file.
    const yamlPath = setupFixture({
      agents: ['reviewer'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-ok
cli: copilot
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('rejects a copilot pipeline naming the .agent.md path at both layers when absent', () => {
    // No persona file created. The thrown error must name the copilot leaf
    // (`<name>.agent.md`) at both the project (.github/agents) and global
    // (~/.copilot/agents) layers — the exact files the copilot CLI would open.
    const yamlPath = setupFixture({
      yaml: `
pipeline: copilot-missing
cli: copilot
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /references agent 'reviewer'.*no persona file exists at either layer.*\.github\/agents\/reviewer\.agent\.md/s,
    );
    // Global layer too: `~/.copilot/agents/` (the `~/` is expanded to the
    // sandbox HOME by the layered probe, so match the expanded tail).
    expect(() => compile(yamlPath)).toThrow(/\.copilot\/agents\/reviewer\.agent\.md/);
  });

  it('rejects a copilot pipeline whose persona sits at the .md leaf (copilot opens .agent.md)', () => {
    // A `<name>.md` in `.github/agents/` is not the file the copilot CLI
    // opens, so it must NOT satisfy the check — this is the crux of the
    // cli-aware leaf. Write the wrong leaf and assert compile still fails,
    // naming the `.agent.md` path it actually requires.
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync('.github/agents/reviewer.md', '---\nname: reviewer\n---\nbody\n');
    const yamlPath = setupFixture({
      yaml: `
pipeline: copilot-wrong-leaf
cli: copilot
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/\.github\/agents\/reviewer\.agent\.md/);
  });

  it('validates a copilot review_loop writer and string reviewer against the .agent.md leaf', () => {
    // The walker collects review_loop writer/reviewer names through a
    // different arm than the plain-step case, so confirm those references
    // also resolve the cli-aware copilot leaf. Both personas sit at
    // `.github/agents/<name>.agent.md`, so compile must succeed.
    const yamlPath = setupFixture({
      agents: ['writer', 'reviewer'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-review-loop
cli: copilot
inputs: [x]
flow:
  - review_loop:
      writer: writer
      reviewer: reviewer
      input: $x
      writer_produces: draft.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('rejects a copilot review_loop whose reviewer persona is missing, naming the .agent.md leaf', () => {
    // Only the writer exists; the reviewer reference must fail the cli-aware
    // probe and name the copilot leaf it requires.
    const yamlPath = setupFixture({
      agents: ['writer'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-review-loop-missing
cli: copilot
inputs: [x]
flow:
  - review_loop:
      writer: writer
      reviewer: reviewer
      input: $x
      writer_produces: draft.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /references agent 'reviewer'.*\.github\/agents\/reviewer\.agent\.md/s,
    );
  });

  it('resolves a copilot persona present only in the global ~/.copilot/agents layer', () => {
    // The positive copilot cases above seed only the project layer
    // (.github/agents). Seed the persona at the GLOBAL copilot leaf alone to
    // prove the cli-aware `.agent.md` leaf is applied at every probe layer,
    // not just the project dir. HOME is sandboxed to the per-test tmp dir by
    // setupCompileTestEnv, so `~/.copilot/agents/` expands there.
    const globalDir = path.join(homedir(), '.copilot', 'agents');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      path.join(globalDir, 'reviewer.agent.md'),
      '---\nname: reviewer\ndescription: test persona\n---\nbody\n',
    );
    const yamlPath = setupFixture({
      yaml: `
pipeline: copilot-global-layer
cli: copilot
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });
});

describe('claude frontmatter name check (via compile)', () => {
  // claude registers agents by the frontmatter `name:` field, not the
  // filename — a persona file whose frontmatter is missing or mismatched is
  // invisible to `--agent <name>`, and claude exits 0 and runs persona-less.
  // claude also refuses to REGISTER an agent whose frontmatter lacks a
  // `description:` (live-verified on 2.1.170), so a name-only file is just
  // as invisible. These tests pin the compile-time guard on top of the
  // existence check. The positive case is covered throughout this file:
  // every setupFixture persona carries `name: <agent>` + `description:`
  // frontmatter.
  const yamlReferencing = (agent: string) => `
pipeline: fm-check
cli: claude
inputs: [x]
flow:
  - step: ${agent}
    input: $x
    produces: out.md
`;

  it('rejects a persona whose frontmatter name mismatches the reference, naming both', () => {
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync('.claude/agents/reviewer.md', '---\nname: other-name\n---\nbody\n');
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).toThrow(
      /\.claude\/agents\/reviewer\.md declares frontmatter name: 'other-name' but the pipeline references 'reviewer'/,
    );
  });

  it('rejects a persona file with no frontmatter, telling the user to add name:', () => {
    // Files written for the pre-delegation runtime (which inlined bodies
    // regardless of frontmatter) may have no frontmatter at all.
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync('.claude/agents/reviewer.md', 'You are a meticulous reviewer.\n');
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).toThrow(
      /has no 'name:' frontmatter[\s\S]*Add frontmatter at the top of the file:[\s\S]*name: reviewer/,
    );
  });

  it('rejects a persona whose frontmatter block lacks a name: field', () => {
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync('.claude/agents/reviewer.md', '---\ntools: Read\n---\nbody\n');
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).toThrow(/has no 'name:' frontmatter/);
  });

  it('rejects a persona whose frontmatter YAML is malformed, naming the parse problem', () => {
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync('.claude/agents/reviewer.md', '---\nname: [unclosed\n---\nbody\n');
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).toThrow(/frontmatter YAML failed to parse/);
  });

  it('rejects a persona whose frontmatter has a matching name: but no description:', () => {
    // claude (live-verified on 2.1.170) refuses to REGISTER an agent whose
    // frontmatter lacks description:, so a name-only file passes the name
    // check yet never loads — `--agent reviewer` would run persona-less.
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync('.claude/agents/reviewer.md', '---\nname: reviewer\n---\nbody\n');
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    let message = '';
    try {
      compile(yamlPath);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    // ONE thrown error covers everything asserted below: the path, the
    // missing-description reason, the persona-less consequence, and the
    // fix-it showing the FULL minimal loadable block (a name-only template
    // would instruct the user to create another unloadable file).
    expect(message).toContain('.claude/agents/reviewer.md');
    expect(message).toContain("declares name: 'reviewer' but has no 'description:' frontmatter");
    expect(message).toContain('claude refuses to register agents without a description');
    expect(message).toContain('persona-less');
    expect(message).toMatch(
      /Add a description line to the frontmatter:\n {2}---\n {2}name: reviewer\n {2}description: <one line on when to use this agent>\n {2}---/,
    );
  });

  it('rejects a persona whose description: is an empty string', () => {
    // An empty description is as unloadable as a missing one — claude does
    // not register the agent either way.
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync(
      '.claude/agents/reviewer.md',
      "---\nname: reviewer\ndescription: ''\n---\nbody\n",
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).toThrow(/has no 'description:' frontmatter/);
  });

  it('accepts a frontmatter-only persona (name + description, empty body)', () => {
    // The bare-cli agent convention: the CLI loads an empty system prompt
    // but applies the file's frontmatter. name: + description: is the
    // minimal block claude registers, so it must compile clean as-is.
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync(
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\ndescription: test persona\n---\n',
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('accepts a CRLF persona whose name: is the last frontmatter line', () => {
    // Splitting on '\n' alone left a trailing \r on the last frontmatter
    // line, so the name parsed as 'reviewer\r' — a mismatch error whose two
    // names rendered identically. claude loads CRLF files fine.
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync(
      '.claude/agents/reviewer.md',
      '---\r\ndescription: test persona\r\nname: reviewer\r\n---\r\nbody\r\n',
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('accepts a persona with a UTF-8 BOM before the opening fence', () => {
    // A BOM at byte 0 defeated the startsWith('---') fence check and
    // produced a false "no frontmatter" error for a file claude loads fine.
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync(
      '.claude/agents/reviewer.md',
      '\uFEFF---\nname: reviewer\ndescription: test persona\n---\nbody\n',
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('does not close the fence on an indented --- inside a block scalar', () => {
    // The close-fence scan used trim() === '---', so an indented '---'
    // (here: block-scalar content) closed the block early and hid the
    // name: that follows it. Column-0-anchored parsers (and claude) don't.
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync(
      '.claude/agents/reviewer.md',
      '---\ndescription: |\n  ---\nname: reviewer\n---\nbody\n',
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('accepts an opening fence with trailing whitespace', () => {
    // claude loads '--- \n' fences; the exact startsWith('---\n') check
    // rejected them with a false "no frontmatter" error.
    mkdirSync('.claude/agents', { recursive: true });
    writeFileSync(
      '.claude/agents/reviewer.md',
      '--- \nname: reviewer\ndescription: test persona\n---\nbody\n',
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('reports an unreadable persona file (directory at the .md path) as a compile error', () => {
    // existsSync is true for a directory named reviewer.md, but the read
    // throws EISDIR — which used to escape as a raw fs crash with no
    // compile-error prefix, pipeline name, or agent name.
    mkdirSync('.claude/agents/reviewer.md', { recursive: true });
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).toThrow(
      /Compile error: .*references agent 'reviewer' but its persona file at \.claude\/agents\/reviewer\.md could not be read: /,
    );
  });

  describe('layered by-name resolution', () => {
    /** setupCompileTestEnv points cwd and $HOME at the SAME tmp dir, which
     *  collapses claude's project (`.claude/agents/`) and global
     *  (`~/.claude/agents/`) layers into one directory — fine for the
     *  single-layer tests above, useless for layered ones. chdir into a
     *  `project/` subdir so the two layers are distinct directories, as in a
     *  real checkout (teardown's chdir + rmSync still cleans up: the subdir
     *  lives inside the sandbox tmp dir). Creates both agents dirs and
     *  returns the global one for seeding. */
    function splitProjectLayerFromGlobal(): string {
      const projectRoot = path.join(process.cwd(), 'project');
      mkdirSync(path.join(projectRoot, '.claude', 'agents'), { recursive: true });
      process.chdir(projectRoot);
      const globalAgents = path.join(homedir(), '.claude', 'agents');
      mkdirSync(globalAgents, { recursive: true });
      return globalAgents;
    }

    it('resolves past a mismatched project-layer name to a matching global-layer persona', () => {
      // The regression case: claude registers agents from BOTH layers and
      // resolves --agent by frontmatter name, so a project reviewer.md
      // declaring `name: other-name` is a DIFFERENT agent, not a broken
      // reference — `--agent reviewer` loads the global file and the run
      // works. Compile must mirror that and pass.
      const globalAgents = splitProjectLayerFromGlobal();
      writeFileSync('.claude/agents/reviewer.md', '---\nname: other-name\n---\nbody\n');
      writeFileSync(
        path.join(globalAgents, 'reviewer.md'),
        '---\nname: reviewer\ndescription: test persona\n---\nbody\n',
      );
      const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
      expect(() => compile(yamlPath)).not.toThrow();
    });

    it('returns the satisfying layer path, not the first existing layer', () => {
      // Direct contract check (the resolved path is invisible through
      // compile()): the path handed back is the file claude will actually
      // load, so a skipped project file must not be returned. The dirs
      // mirror compile's claude AGENT_DIR_DEFAULTS layers.
      const globalAgents = splitProjectLayerFromGlobal();
      writeFileSync('.claude/agents/reviewer.md', '---\nname: other-name\n---\nbody\n');
      const globalPath = path.join(globalAgents, 'reviewer.md');
      writeFileSync(globalPath, '---\nname: reviewer\ndescription: test persona\n---\nbody\n');
      const resolved = validatePersonaFile(
        ['.claude/agents/', '~/.claude/agents/'],
        'claude',
        'reviewer',
        'pipeline test',
      );
      expect(resolved).toBe(globalPath);
    });

    it('accepts a matching project layer without consulting the global layer', () => {
      // Project-first precedence: the satisfying project file resolves the
      // reference on its own, so a global file that would fail the check
      // (mismatched name) must not be able to break compile.
      const globalAgents = splitProjectLayerFromGlobal();
      writeFileSync(
        '.claude/agents/reviewer.md',
        '---\nname: reviewer\ndescription: test persona\n---\nbody\n',
      );
      writeFileSync(path.join(globalAgents, 'reviewer.md'), '---\nname: wrong-name\n---\nbody\n');
      const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
      expect(() => compile(yamlPath)).not.toThrow();
    });

    it('throws one error naming every examined layer when no layer satisfies the reference', () => {
      const globalAgents = splitProjectLayerFromGlobal();
      // Two different rejection reasons, so the aggregated error must carry
      // each path's own: the project file mismatches, the global file has
      // no frontmatter at all.
      writeFileSync('.claude/agents/reviewer.md', '---\nname: other-name\n---\nbody\n');
      writeFileSync(path.join(globalAgents, 'reviewer.md'), 'You are a meticulous reviewer.\n');
      const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
      let message = '';
      try {
        compile(yamlPath);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      // ONE thrown error covers everything asserted below.
      expect(message).toMatch(
        /Compile error: pipeline 'fm-check' references agent 'reviewer' but no layer's persona file satisfies it/,
      );
      // The project line (relative spelling, listed first in layer order)
      // with the mismatch reason...
      expect(message).toMatch(
        /\n {2}\.claude\/agents\/reviewer\.md declares frontmatter name: 'other-name' but the pipeline references 'reviewer'\n/,
      );
      // ...the global line (absolute, ~-expanded spelling) with the
      // no-frontmatter reason...
      expect(message).toMatch(
        /\n {2}\/[^\n]*\.claude\/agents\/reviewer\.md has no 'name:' frontmatter\n/,
      );
      // ...and the fix-it tail showing the full minimal loadable block
      // (name: alone is unloadable — claude refuses to register an agent
      // without a description).
      expect(message).toMatch(
        /the minimal loadable block is:\n {2}---\n {2}name: reviewer\n {2}description: <one line on when to use this agent>\n {2}---/,
      );
    });

    it('skips a description-less project layer and resolves a loadable global-layer persona', () => {
      // claude refuses to register the description-less project file, so
      // `--agent reviewer` loads the global file and the run works. Compile
      // must mirror that skip rather than failing on the first name-matched
      // layer.
      const globalAgents = splitProjectLayerFromGlobal();
      writeFileSync('.claude/agents/reviewer.md', '---\nname: reviewer\n---\nbody\n');
      writeFileSync(
        path.join(globalAgents, 'reviewer.md'),
        '---\nname: reviewer\ndescription: test persona\n---\nbody\n',
      );
      const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
      expect(() => compile(yamlPath)).not.toThrow();
    });

    it('renders a no-description layer reason in the multi-layer listing', () => {
      // Project file matches the name but lacks a description (claude would
      // refuse to register it); global file has no frontmatter at all. The
      // aggregated error must carry each path's own reason.
      const globalAgents = splitProjectLayerFromGlobal();
      writeFileSync('.claude/agents/reviewer.md', '---\nname: reviewer\n---\nbody\n');
      writeFileSync(path.join(globalAgents, 'reviewer.md'), 'You are a meticulous reviewer.\n');
      const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
      let message = '';
      try {
        compile(yamlPath);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(
        /references agent 'reviewer' but no layer's persona file satisfies it/,
      );
      expect(message).toMatch(
        /\n {2}\.claude\/agents\/reviewer\.md declares name: 'reviewer' but has no 'description:' frontmatter\n/,
      );
      expect(message).toMatch(
        /\n {2}\/[^\n]*\.claude\/agents\/reviewer\.md has no 'name:' frontmatter\n/,
      );
    });
  });
});

describe('copilot frontmatter description check (via compile)', () => {
  // GitHub Copilot CLI (live-verified on 1.0.61) registers an agent file iff
  // its frontmatter parses and carries a STRING `description:` — and resolves
  // `--agent <ref>` by registered frontmatter name OR by the filename stem of
  // a registrable `<ref>.agent.md`. So a frontmatter/filename name mismatch
  // still loads (NOT an error for copilot, unlike claude), while ANY
  // description-less file is unregistered and `--agent <ref>` exits 1 at
  // spawn ("No such agent: <ref>") — after every upstream pipeline step has
  // already run. These tests pin the compile-time guard to exactly those
  // probed semantics.
  const yamlReferencing = (agent: string) => `
pipeline: copilot-fm-check
cli: copilot
inputs: [x]
flow:
  - step: ${agent}
    input: $x
    produces: out.md
`;

  it('rejects a copilot persona without frontmatter', () => {
    // Probed: a plain-body probe-plain.agent.md never registers and
    // `--agent probe-plain` exits 1 "No such agent" — copilot has NO
    // filename fallback for frontmatter-less files.
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync('.github/agents/reviewer.agent.md', 'You are a meticulous reviewer.\n');
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    let message = '';
    try {
      compile(yamlPath);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    // ONE thrown error covers everything asserted below: the path, the
    // missing-description reason, the loud-but-late spawn consequence, and
    // the fix-it showing the full registrable block.
    expect(message).toContain('.github/agents/reviewer.agent.md');
    expect(message).toContain("has no 'description:' frontmatter");
    expect(message).toContain(`'--agent reviewer' would fail at spawn`);
    expect(message).toContain('No such agent: reviewer');
    expect(message).toMatch(
      /Add frontmatter at the top of the file:\n {2}---\n {2}name: reviewer\n {2}description: <one line on when to use this agent>\n {2}---/,
    );
  });

  it('rejects a copilot persona whose frontmatter has name: but no description:', () => {
    // Probed: probe-nodesc.agent.md (`name:` only) never registers — copilot
    // refuses description-less agent files just like claude, so the old
    // existence-only acceptance compiled a pipeline that died at spawn.
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync('.github/agents/reviewer.agent.md', '---\nname: reviewer\n---\nbody\n');
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).toThrow(/has no 'description:' frontmatter/);
  });

  it('rejects a copilot persona whose description: is null-valued', () => {
    // Probed: `description:` with no value parses to YAML null and copilot
    // does NOT register the file — the field must be a string.
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync(
      '.github/agents/reviewer.agent.md',
      '---\nname: reviewer\ndescription:\n---\nbody\n',
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).toThrow(/has no 'description:' frontmatter/);
  });

  it('accepts a copilot persona whose description: is an empty string', () => {
    // Probed boundary against claude: copilot DOES register
    // `description: ''` (claude refuses), so the copilot arm must not
    // borrow claude's non-empty rule.
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync(
      '.github/agents/reviewer.agent.md',
      "---\nname: reviewer\ndescription: ''\n---\nbody\n",
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('accepts a copilot persona whose frontmatter name: mismatches the reference', () => {
    // Probed: probe-foo.agent.md declaring `name: probe-bar` registers as
    // probe-bar AND `--agent probe-foo` still resolves and loads the persona
    // by filename stem — a mismatch is a working spawn for copilot, so the
    // claude name-match rule must NOT extend here. The mismatch fixture that
    // fails the claude check must PASS for copilot (with the description
    // copilot requires), pinning the per-cli divergence.
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync(
      '.github/agents/reviewer.agent.md',
      '---\nname: other-name\ndescription: test persona\n---\nbody\n',
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('accepts a copilot persona with description: but no name:', () => {
    // Probed: a name-less probe-desconly.agent.md registers under its
    // FILENAME stem and `--agent probe-desconly` loads it — `name:` is
    // optional for copilot (claude would reject this file).
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync(
      '.github/agents/reviewer.agent.md',
      '---\ndescription: test persona\n---\nbody\n',
    );
    const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  describe('layered description resolution', () => {
    /** Copilot twin of the claude `splitProjectLayerFromGlobal` helper: chdir
     *  into a `project/` subdir so the project (`.github/agents/`) and global
     *  (`~/.copilot/agents/`) layers are distinct directories, as in a real
     *  checkout. Creates both agents dirs and returns the global one. */
    function splitCopilotLayers(): string {
      const projectRoot = path.join(process.cwd(), 'project');
      mkdirSync(path.join(projectRoot, '.github', 'agents'), { recursive: true });
      process.chdir(projectRoot);
      const globalAgents = path.join(homedir(), '.copilot', 'agents');
      mkdirSync(globalAgents, { recursive: true });
      return globalAgents;
    }

    it('skips a description-less project layer and resolves a registrable global-layer persona', () => {
      // Probed: with a description-less project probe-lay.agent.md and a
      // registrable global one, `--agent probe-lay` loads the GLOBAL persona
      // — the unregistrable project file does not shadow it. Compile must
      // mirror that skip rather than failing on the first existing layer.
      const globalAgents = splitCopilotLayers();
      writeFileSync('.github/agents/reviewer.agent.md', '---\nname: reviewer\n---\nbody\n');
      writeFileSync(
        path.join(globalAgents, 'reviewer.agent.md'),
        '---\nname: reviewer\ndescription: test persona\n---\nbody\n',
      );
      const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
      expect(() => compile(yamlPath)).not.toThrow();
    });

    it('throws one error naming every examined copilot layer when none is registrable', () => {
      // Two different rejection flavors: the project file has name-only
      // frontmatter, the global file's frontmatter YAML is malformed (probed:
      // copilot registers neither). The aggregated error must carry each
      // path's own reason plus the copilot spawn framing.
      const globalAgents = splitCopilotLayers();
      writeFileSync('.github/agents/reviewer.agent.md', '---\nname: reviewer\n---\nbody\n');
      writeFileSync(
        path.join(globalAgents, 'reviewer.agent.md'),
        '---\nname: [unclosed\n---\nbody\n',
      );
      const yamlPath = setupFixture({ yaml: yamlReferencing('reviewer') });
      let message = '';
      try {
        compile(yamlPath);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      // ONE thrown error covers everything asserted below.
      expect(message).toMatch(
        /Compile error: pipeline 'copilot-fm-check' references agent 'reviewer' but no layer's persona file satisfies it/,
      );
      expect(message).toContain('No such agent: reviewer');
      // The project line (relative spelling, listed first in layer order)...
      expect(message).toMatch(
        /\n {2}\.github\/agents\/reviewer\.agent\.md has no 'description:' frontmatter\n/,
      );
      // ...the global line (absolute, ~-expanded spelling) with the
      // parse-problem note...
      expect(message).toMatch(
        /\n {2}\/[^\n]*\.copilot\/agents\/reviewer\.agent\.md has no 'description:' frontmatter \(frontmatter YAML failed to parse: /,
      );
      // ...and the fix-it tail showing the full registrable block.
      expect(message).toMatch(
        /the minimal registrable block is:\n {2}---\n {2}name: reviewer\n {2}description: <one line on when to use this agent>\n {2}---/,
      );
    });
  });
});

describe('validatePath (via compile)', () => {
  it('rejects absolute path in produces', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: abs
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: /etc/passwd
`,
    });
    expect(() => compile(yamlPath)).toThrow(/absolute path/);
  });

  it('rejects parent-traversal in produces', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: trav
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: ../escape.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/parent-directory traversal/);
  });

  it('accepts a deep but valid relative path', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: deep
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: deep/nested/out.md
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });
});

describe('validateReviewerSubflow (via compile)', () => {
  it('rejects empty reviewer subflow', () => {
    const yamlPath = setupFixture({
      agents: ['w'],
      yaml: `
pipeline: empty-sub
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      input: $x
      writer_produces: out.md
      reviewer: []
`,
    });
    expect(() => compile(yamlPath)).toThrow(/has empty reviewer subflow/);
  });

  it('rejects reviewer subflow whose last item is not aggregate', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'r'],
      yaml: `
pipeline: no-agg
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      input: $x
      writer_produces: out.md
      reviewer:
        - step: r
          input: $out
          produces: r.json
          bind: r
`,
    });
    expect(() => compile(yamlPath)).toThrow(/reviewer subflow's last item must be 'aggregate'/);
  });
});
