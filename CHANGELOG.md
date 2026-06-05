# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/gwaihir4031/agenticloom/releases/tag/v0.1.0
