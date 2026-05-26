# Manual sanity check: layered discovery

This procedure verifies that loom resolves a pipeline + agent from the
global layer (`~/.loom/pipelines/` + `~/.claude/agents/`) when the
project layer is empty.

**$HOME is overridden for the check session** — the procedure does NOT
modify the user's real `~/.claude/agents/` (which is Claude Code's own
subagent dir) or `~/.loom/` (if they have one). Cleanup is a single
`rm -rf` of the sandbox.

> **User-gated**: smoke runs cost real money and wall-clock. Do not
> auto-run; wait for an explicit user instruction.

## Precondition

```bash
# Refresh dist/. The compiled pipeline's runtime imports resolve
# through dist/, not src/, and recent cleanup commits don't
# rebuild dist/ automatically. Same lesson as Phase 1.8 smoke #8.
npm run build
```

## Setup (per-check, sandbox-safe)

```bash
# Create the sandbox $HOME for this check session.
SANDBOX_HOME=$(mktemp -d -t loom-sanity-home-XXXXXX)

# Defensive: ensure mktemp didn't return a path inside the user's real
# home (e.g. some Linux mktemp implementations honor a TMPDIR pointing
# under $HOME). If it did, abort before the cat > below pollutes real
# home.
case "$SANDBOX_HOME" in
  "$HOME"|"$HOME"/*)
    echo "ABORT: \$SANDBOX_HOME ($SANDBOX_HOME) is inside your real home." >&2
    echo "Set TMPDIR to /tmp (or another non-home location) and rerun." >&2
    exit 1
    ;;
esac

mkdir -p "$SANDBOX_HOME/.loom/pipelines"
mkdir -p "$SANDBOX_HOME/.claude/agents"

# Copy the smoke_test fixture pipeline into the sandbox's global layer.
# Note: this `cp` assumes the current working directory is the loom
# repo root (`smoke_test/` is repo-relative). If you're running from
# elsewhere, replace with the absolute path to the fixture.
cp smoke_test/loom/pipelines/test-layered-discovery.yaml "$SANDBOX_HOME/.loom/pipelines/"

# Author a minimal persona file in the sandbox's global agents dir.
cat > "$SANDBOX_HOME/.claude/agents/loom-test-persona.md" <<'EOF'
---
name: loom-test-persona
description: Minimal persona for the layered-discovery sanity check
tools: Write
---

You are a test agent. Read the input and write a one-sentence
acknowledgement to the path provided in your prompt postscript.
EOF
```

## Run the sanity check

```bash
# Create a fresh invocation dir with NO loom-relevant content.
SANDBOX_CWD=$(mktemp -d -t loom-sanity-cwd-XXXXXX)
cd "$SANDBOX_CWD"

# Run loom with $HOME overridden so os.homedir() points at the sandbox.
HOME="$SANDBOX_HOME" loom run test-layered-discovery "test ticket content"
```

Expected behavior:

- `resolvePipeline` finds `$SANDBOX_HOME/.loom/pipelines/test-layered-discovery.yaml` (the project pipeline layer at `$SANDBOX_CWD/loom/pipelines/` is empty; falls back to global).
- `validateAgentFilesExist` finds `$SANDBOX_HOME/.claude/agents/loom-test-persona.md` (the project agent layer at `$SANDBOX_CWD/.claude/agents/` is empty; falls back to global).
- The pipeline compiles, spawns claude, and writes `out.md` to `$SANDBOX_CWD/loom/runs/<id>/out.md`.
- Exit code 0.

## Cleanup

```bash
cd -                                          # leave $SANDBOX_CWD before deleting it
rm -rf "$SANDBOX_HOME" "$SANDBOX_CWD"
unset SANDBOX_HOME SANDBOX_CWD
```

The user's real `~/.claude/agents/` and `~/.loom/` are untouched throughout.

## Notes

- The `$HOME` override approach mirrors what the project's automated
  tests do (`src/runtime.layered.test.ts`'s `beforeEach`) — same
  isolation strategy, scaled to a manual shell session.
- If `loom` is on the user's PATH via `npm link` against the source
  repo (the typical dev setup), the `HOME=...` env override flows
  through to the spawned `claude` process too, so `claude` itself
  resolves its own subagents under `$SANDBOX_HOME/.claude/agents/`.
  This is intentional — the sanity check is end-to-end for the layered
  resolution, with `claude` seeing the same layered world loom does.
