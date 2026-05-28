# Getting started — runnable starter pack

A runnable companion to the [getting-started guide](../../GETTING_STARTED.md).
Work through that guide — each chapter opens with the `loom run` command for its
pipeline. The pipelines and agent personas the guide references all live in this
directory.

## Prerequisites

- `agenticloom` installed (`npm install -g agenticloom`).
- Claude Code (or GitHub Copilot CLI) installed and authenticated.

## Running with GitHub Copilot CLI

The pipelines default to Claude. The guide's [Using Copilot CLI instead of
Claude Code](../../GETTING_STARTED.md#using-copilot-cli-instead-of-claude-code)
section has a one-line `sed` that switches all six pipelines to Copilot.

## A note on the agent personas

The personas in `.claude/agents/` and `.github/agents/` are **minimal stubs** —
just enough to make the pipelines compile and run end to end. Their output is
for learning the pipeline mechanics, not for production use. Replace them with
real personas for real work.
