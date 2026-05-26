import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodePath from 'node:path';

// Mock fs — readAgentFile reads agent-produced JSON via existsSync +
// readFileSync. These tests substitute fakeFs for the on-disk layer so
// failure modes (missing file, empty file, malformed JSON, retry on
// rewrite) are exercised deterministically.
let promptFileBody: string | null = '---\nname: test-agent\n---\nSYS PROMPT BODY\n';
let fakeFs: Record<string, string> = {};
const looksLikePersonaPath = (p: string): boolean => /(?:^|\/)agents\/[^/]+\.md$/.test(p);
const fakeFsLookup = (p: string): string | undefined => {
  if (Object.prototype.hasOwnProperty.call(fakeFs, p)) return fakeFs[p];
  if (nodePath.isAbsolute(p)) {
    const rel = nodePath.relative(process.cwd(), p);
    if (Object.prototype.hasOwnProperty.call(fakeFs, rel)) return fakeFs[rel];
  }
  return undefined;
};

vi.mock('fs', () => ({
  existsSync: (p: string) => {
    if (looksLikePersonaPath(p)) return promptFileBody !== null;
    return fakeFsLookup(p) !== undefined;
  },
  readFileSync: (p: string, _enc?: string) => {
    if (looksLikePersonaPath(p)) return promptFileBody ?? '';
    const v = fakeFsLookup(p);
    if (v !== undefined) return v;
    const err = new Error(
      `ENOENT: no such file or directory, open '${p}'`,
    ) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  },
}));

beforeEach(async () => {
  vi.resetModules();
  promptFileBody = '---\nname: test-agent\n---\nSYS PROMPT BODY\n';
  fakeFs = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readAgentFile (via aggregate)', () => {
  // readAgentFile is exercised via aggregate() — every input flows through
  // the verdict-extraction path, so aggregate's public surface is the
  // observation point for readAgentFile's parse / retry / error behavior.

  it('parses valid JSON and returns extracted verdict', async () => {
    fakeFs['review.json'] = JSON.stringify({ status: 'pass', findings: [] });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { r: 'review.json' },
      verdictField: 'status',
      approveWhen: 'pass',
    });
    expect(verdict).toBe('pass');
  });

  it('strips ```json fences before parsing', async () => {
    fakeFs['review.json'] = '```json\n{"status":"pass"}\n```';
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { r: 'review.json' },
      verdictField: 'status',
    });
    expect(verdict).toBe('pass');
  });

  it('strips bare ``` fences (no language tag) before parsing', async () => {
    fakeFs['review.json'] = '```\n{"status":"pass"}\n```';
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { r: 'review.json' },
      verdictField: 'status',
    });
    expect(verdict).toBe('pass');
  });

  it('tolerates trailing commas via jsonc-parser', async () => {
    fakeFs['review.json'] = '{"status":"pass",}';
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { r: 'review.json' },
      verdictField: 'status',
    });
    expect(verdict).toBe('pass');
  });

  it('throws on parse failure when no rewriteProducerFile available', async () => {
    fakeFs['review.json'] = '{ broken json';
    const { aggregate } = await import('./aggregate.js');
    await expect(
      aggregate({
        inputs: { r: 'review.json' },
        verdictField: 'status',
      }),
    ).rejects.toThrow(/wrote invalid JSON/);
  });

  it('throws with (after 1 corrective retry) suffix when retry exhausts', async () => {
    fakeFs['review.json'] = '{ still broken';
    const rewriter = vi.fn(async () => undefined); // rewriter doesn't fix the file
    const { aggregate } = await import('./aggregate.js');
    await expect(
      aggregate({
        inputs: { r: 'review.json' },
        verdictField: 'status',
        rewriteProducerFiles: { r: rewriter },
      }),
    ).rejects.toThrow(/\(after 1 corrective retry\)/);
    expect(rewriter).toHaveBeenCalledTimes(1);
  });

  it('retries successfully when rewriter fixes the JSON', async () => {
    fakeFs['review.json'] = '{ broken';
    const rewriter = vi.fn(async () => {
      fakeFs['review.json'] = '{"status":"pass"}';
    });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { r: 'review.json' },
      verdictField: 'status',
      rewriteProducerFiles: { r: rewriter },
    });
    expect(verdict).toBe('pass');
    expect(rewriter).toHaveBeenCalledTimes(1);
    // Lock in the corrective-prompt contract: buildCorrectivePrompt's prefix
    // 'failed to parse as JSON' is flagged as load-bearing in its JSDoc (the
    // broken-then-fixed-reviewer fixture matches it as the retry-detection
    // signal). Without this assertion, a future refactor that called the
    // rewriter with the original prompt — or no prompt — would re-run the
    // same input that produced the broken file and parse failures would
    // silently re-fire.
    expect(rewriter).toHaveBeenCalledWith(expect.stringContaining('failed to parse as JSON'));
    expect(rewriter.mock.calls[0][0]).toContain(
      `Your previous output at ${nodePath.resolve('review.json')}`,
    );
  });

  it('throws on empty file when no rewriter available', async () => {
    fakeFs['review.json'] = '';
    const { aggregate } = await import('./aggregate.js');
    await expect(
      aggregate({
        inputs: { r: 'review.json' },
        verdictField: 'status',
      }),
    ).rejects.toThrow(/file is empty/);
  });

  it('retries on empty file when rewriter writes content', async () => {
    fakeFs['review.json'] = '';
    const rewriter = vi.fn(async () => {
      fakeFs['review.json'] = JSON.stringify({ status: 'pass' });
    });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { r: 'review.json' },
      verdictField: 'status',
      rewriteProducerFiles: { r: rewriter },
    });
    expect(verdict).toBe('pass');
    expect(rewriter).toHaveBeenCalledTimes(1);
    // The empty-file branch threads 'empty file' through as the error detail
    // (vs. a parser-error code on the broken-JSON branch). Asserting on both
    // halves of the corrective prompt — the 'empty file' detail and the
    // 'Your previous output at <path>' prefix — locks in that the rewriter
    // receives a meaningfully-different prompt than the original.
    expect(rewriter).toHaveBeenCalledWith(expect.stringContaining('empty file'));
    expect(rewriter.mock.calls[0][0]).toContain(
      `Your previous output at ${nodePath.resolve('review.json')}`,
    );
  });

  it('throws on missing file (ENOENT) without retry', async () => {
    // fakeFs entry absent → requireFile probe at the readAgentFile entry
    // fails. This boundary IS the producer-output read (the orchestrator
    // is consuming what an upstream agent was supposed to write), so the
    // 'reading-output' context branch throws with the "did not write
    // expected file" wording — semantically right for the consumer here,
    // and the wording the pre-spawn input check site does NOT use (its
    // own 'consuming-input' branch reads "requires input file"). Aggregate
    // absolutifies inputs at the boundary, so the message carries the
    // workspace-rooted path (not the bare YAML literal).
    const { aggregate } = await import('./aggregate.js');
    const expectedAbs = nodePath.resolve('missing.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(
      aggregate({
        inputs: { r: 'missing.json' },
        verdictField: 'status',
      }),
    ).rejects.toThrow(new RegExp(`agent 'r' did not write expected file: ${expectedAbs}`));
  });
});
