import { describe, it, expect } from 'vitest';
import * as runtimeSurface from './index.js';

// `index.ts` is loom's public `agenticloom/runtime` surface: the compiled emit
// and the ambient runtime d.ts (RUNTIME_AMBIENT_DTS in compile/test-helpers.ts)
// both bind against the names re-exported here. Persona resolution at spawn time
// is delegated to the CLI via `--agent`, so the runtime no longer reads persona
// files itself and the persona-body reader is no longer part of that surface.
describe('runtime public surface', () => {
  it('does not expose loadAgentSystemPrompt', () => {
    // The removed persona-body reader must not reappear on the public surface —
    // re-adding it would re-couple external embedders (and the ambient d.ts) to
    // runtime-side persona-file reading, the exact coupling this removal sheds.
    expect('loadAgentSystemPrompt' in runtimeSurface).toBe(false);
  });

  it('still exposes the surviving agent primitives', () => {
    // Surgical removal: the sibling re-exports from the same agent.js module must
    // remain. These also anchor the absence assertion above — their presence
    // proves the namespace genuinely loaded, so the absence check cannot pass
    // vacuously against a failed or empty import.
    expect('runAgent' in runtimeSurface).toBe(true);
    expect('HaltPipelineError' in runtimeSurface).toBe(true);
    expect('requireFile' in runtimeSurface).toBe(true);
  });
});
