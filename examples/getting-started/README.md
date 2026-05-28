# Getting started — runnable starter pack

A runnable companion to the [getting-started guide](../../GETTING_STARTED.md).
Each chapter's pipeline lives here so you can run it as you read.

## Prerequisites

- `agenticloom` installed (`npm install -g agenticloom`).
- Claude Code (or GitHub Copilot CLI) installed and authenticated.

## Run a chapter (Claude Code)

From this directory (`examples/getting-started/`), pass the ticket as a
positional argument:

```bash
loom run 01-first-step ticket.md
```

Swap the name for any chapter: `02-review-loop`, `03-human-gate`,
`04-parallel-review`, `05-impl-retry`, `06-foreach`. Chapters 3–6 include a
`human_gate` that pauses for your input. (If the CLI can't locate the ticket,
pass an absolute path: `loom run 01-first-step "$(pwd)/ticket.md"`.)

## Run with GitHub Copilot CLI

The pipelines default to `cli: claude` and `--model haiku`. Switch both in one
step, then run — the personas already ship in `.github/agents/` with Copilot
frontmatter:

```bash
sed -i.bak \
  -e 's/^cli: claude/cli: copilot/' \
  -e "s/\['--model', 'haiku'\]/['--model', 'gpt-4.1']/" \
  loom/pipelines/*.yaml
loom run 01-first-step ticket.md
```

## A note on the agent personas

The personas in `.claude/agents/` and `.github/agents/` are **minimal stubs** —
just enough to make the pipelines compile and run end to end. Their output is
for learning the pipeline mechanics, not for production use. Replace them with
real personas for real work.
