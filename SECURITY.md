# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in loom, please **do not open a public issue**. Instead, open a [private security advisory](https://github.com/gwaihir4031/agenticloom/security/advisories/new) on this repository.

We'll acknowledge within 72 hours and aim to publish a fix + advisory within 14 days for high-severity issues.

## Supported Versions

Versions currently receiving security patches:

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

Pre-1.0 releases mean breaking changes may land in minor versions; security patches still flow regardless.

## Scope

loom orchestrates CLI coding agents via `child_process.spawn` and reads/writes user-controlled file paths. Vulnerabilities in either surface — command injection, path traversal, arbitrary file write, prompt-injection vectors that escalate into either — are in scope.

Vulnerabilities in upstream agent CLIs (e.g. `claude`, `copilot`) or in the LLM responses those CLIs produce are **not** in scope for loom itself; please report those to the respective vendors.
