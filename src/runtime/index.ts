// Public `agenticloom/runtime` surface. Every named symbol the compiled emit
// references — and every symbol the ambient `runtime.d.ts` declaration
// block (the `RUNTIME_AMBIENT_DTS` const in `src/compile/test-helpers.ts`)
// types against — must appear here. The per-file modules under `./` own
// the implementations; this file is consumer-facing re-exports only —
// no logic.

// Agent primitives + HaltPipelineError (the cross-primitive halt signal).
export { runAgent, HaltPipelineError, loadAgentSystemPrompt, requireFile } from './agent.js';
export type { RunAgentOpts, AgentCli, AgentRole, RequireFileContext } from './agent.js';

// Stream-event formatting + tool-arg extraction.
export {
  formatStreamEvent,
  extractPrimaryArg,
  TOOL_PRIMARY_ARG,
  PRIMARY_ARG_MAX_LEN,
} from './stream.js';
export type { StreamEvent } from './stream.js';

// JSON-contract reader for agent-produced files.
export { readAgentFile } from './read-agent-file.js';

// review_loop primitive (single + compound shapes).
export { reviewLoop } from './review-loop.js';
export type {
  ReviewLoopOpts,
  SingleReviewerOpts,
  CompoundReviewerOpts,
  ReviewerPathInfo,
} from './review-loop.js';

// parallel primitive (fan-out of zero-arg thunks).
export { parallel } from './parallel.js';

// aggregate + retryGateZone (the retry-from-bind helper).
export { aggregate, retryGateZone } from './aggregate.js';
export type { AggregateOpts, RetryGateZoneOpts } from './aggregate.js';

// human_gate primitive (plain y/N + interactive REPL modes).
export { humanGate } from './human-gate.js';
export type { InteractiveGateOpts } from './human-gate.js';

// Branch.when condition helpers (file IO).
export { readJson, readText, fileExists } from './pipeline-helpers.js';

// foreach primitive (JSONL iteration).
export { foreach } from './foreach.js';
export type { ForeachOpts, ForeachResult } from './foreach.js';
