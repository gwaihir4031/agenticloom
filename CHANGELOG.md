# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-05-27

### Fixed

- Skill install path: package now ships `skills/loom-author/SKILL.md` instead of `skills/loom-author.md` so Claude Code and Copilot CLI can discover the `loom-author` skill at the canonical `<skills-dir>/<name>/SKILL.md` path. README install commands updated to use `cp -r`. ([#1](https://github.com/gwaihir4031/agenticloom/pull/1))

## [0.1.0] - 2026-05-26

Initial release. YAML → TypeScript pipeline compiler for orchestrating CLI coding agents (`claude`, `copilot`) with seven primitives: `step`, `review_loop`, `human_gate`, `parallel`, `branch`, `aggregate`, `foreach`. Ships the `loom` / `agenticloom` CLI plus the `loom-author` Claude/Copilot skill.

[Unreleased]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/gwaihir4031/agenticloom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/gwaihir4031/agenticloom/releases/tag/v0.1.0
