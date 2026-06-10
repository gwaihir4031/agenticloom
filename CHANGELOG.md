# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Persona steps now spawn through the CLI's native `--agent <name>`** — loom no longer reads the persona file and inlines its body into the prompt. On claude the persona's `tools:` frontmatter now binds (real least privilege on the headless path, even under `--dangerously-skip-permissions`); the copilot interactive `human_gate` delegates the same way instead of baking the persona body into its first message. ([#15](https://github.com/gwaihir4031/agenticloom/pull/15))
- The compile-time agent-file check validates what the CLI actually loads, per CLI: the file leaf is `.github/agents/<name>.agent.md` for copilot (starter pack migrated); claude personas must carry frontmatter `name:` equal to the reference plus a non-empty `description:`, resolved by-name across the project/global layers; copilot personas must carry a string `description:` (its registration rule, probed on v1.0.61). Errors carry fix-its showing the minimal loadable block, list probed-but-empty layers, and a skipped-but-failing layer warns. **Migration:** persona files written for the old body-inlining runtime that lack `name:`/`description:` frontmatter now fail compile with a fix-it — previously they compiled and would silently run persona-less under `--agent`. ([#15](https://github.com/gwaihir4031/agenticloom/pull/15))

### Added

- **Inline agents** — `step:`, `review_loop.writer`, and `review_loop.reviewer` accept `{ prompt, name }` besides a persona name: a one-off agent defined directly in the pipeline YAML, no persona file, all tools. `prompt` is the task (static text); `name` is required and is the agent's identity in logs, window titles, error messages, and mermaid nodes. The getting-started guide's chapter 6 planner is now one. ([#15](https://github.com/gwaihir4031/agenticloom/pull/15))
- **General `human_gate`** — an interactive gate may omit `agent:`; the gate's required `prompt:` becomes the agent's whole task (all tools, no persona). ([#15](https://github.com/gwaihir4031/agenticloom/pull/15))
- **Spawn-time persona verification (claude)** — `runAgent` audits the stream-json init event's agent roster and fails loud, killing the child, when claude did not load the requested persona; claude otherwise exits 0 and runs persona-less on an unknown `--agent`. Older CLIs without the roster field are tolerated; copilot already fails loud. ([#15](https://github.com/gwaihir4031/agenticloom/pull/15))
- **Parse- and spawn-time guard rails** for the delegation surface: dash-leading prompts rejected on all prompt fields (inline, gate, `revise_with` — the CLI parses a dash-leading argv value as a flag) plus a runtime check on the assembled prompt; persona names must be non-empty and not dash-leading; `--agent`/`--agents` rejected inside `extra_args` (they would silently replace or shadow the compile-validated persona); gate prompts must be non-empty. ([#15](https://github.com/gwaihir4031/agenticloom/pull/15))

## [0.1.5] - 2026-06-06

### Added

- `runAgent` now surfaces the claude CLI's `api_retry` events: each transient-failure retry (HTTP 529 overload, rate-limit) renders live as `⟳ retry N/M — category, waiting Ns` in both display modes (and tees to the `--save-logs` log), and a per-run retry summary (count, category, budget-exhausted flag) is captured into the result telemetry and shown on the collapsed status line. Observe-only; claude path only — the copilot raw-stdout path has no equivalent structured event. ([#12](https://github.com/gwaihir4031/agenticloom/pull/12))

## [0.1.4] - 2026-06-06

### Fixed

- A `parallel` block inside a retry zone now retries correctly. Its destructured bindings were emitted as `const`, so when a retry gate re-ran the block the reassignment threw `TypeError: Assignment to constant variable` and aborted the run. The bindings are now declared `let` when the parallel feeds a retry gate. ([#10](https://github.com/gwaihir4031/agenticloom/pull/10))

## [0.1.3] - 2026-06-06

### Added

- `runAgent` now captures agent stderr — surfaced as a bounded tail on failure errors (a failed run names why the agent died) and teed to the `--save-logs` log marked `stderr│ `. ([#7](https://github.com/gwaihir4031/agenticloom/pull/7))

## [0.1.2] - 2026-06-05

### Added

- Getting-started guide (`GETTING_STARTED.md`) — a hands-on walkthrough that builds one multi-agent pipeline from `step` through `foreach` and teaches **context engineering** (what each agent sees, hands off, and gets back on retry), with a runnable starter pack at `examples/getting-started/` for Claude Code and Copilot CLI.

### Fixed

- Retry pre-flight check now follows `revise_with`. On a retry, a gate's retry-target had its prompt rebuilt from `revise_with` but its silent pre-flight input-existence check left pinned to the step's original `inputs:` — so the guard validated files the agent no longer reads and could miss a genuinely-absent feedback file. The check now derives from `revise_with` by mode, for step (`on_fail`) and aggregate (`retry_from`) gates, including branch retry-targets. ([#5](https://github.com/gwaihir4031/agenticloom/pull/5))

## [0.1.1] - 2026-05-27

### Fixed

- Skill install path: package now ships `skills/loom-author/SKILL.md` instead of `skills/loom-author.md` so Claude Code and Copilot CLI can discover the `loom-author` skill at the canonical `<skills-dir>/<name>/SKILL.md` path. README install commands updated to use `cp -r`. ([#1](https://github.com/gwaihir4031/agenticloom/pull/1))

## [0.1.0] - 2026-05-26

Initial release. YAML → TypeScript pipeline compiler for orchestrating CLI coding agents (`claude`, `copilot`) with seven primitives: `step`, `review_loop`, `human_gate`, `parallel`, `branch`, `aggregate`, `foreach`. Ships the `loom` / `agenticloom` CLI plus the `loom-author` Claude/Copilot skill.

[Unreleased]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/gwaihir4031/agenticloom/releases/tag/v0.1.0
