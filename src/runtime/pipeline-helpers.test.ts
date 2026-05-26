import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodePath from 'node:path';

// Mock fs — pipeline-helpers' readJson/readText/fileExists hit existsSync
// and readFileSync directly. The fakeFs map below substitutes path→content
// lookup with first-class absolute keys (matching the absolutified bind
// values upstream producers hand off).
let fakeFs: Record<string, string> = {};
const fakeFsLookup = (p: string): string | undefined => {
  if (Object.prototype.hasOwnProperty.call(fakeFs, p)) return fakeFs[p];
  if (nodePath.isAbsolute(p)) {
    const rel = nodePath.relative(process.cwd(), p);
    if (Object.prototype.hasOwnProperty.call(fakeFs, rel)) return fakeFs[rel];
  }
  return undefined;
};

vi.mock('fs', () => ({
  existsSync: (p: string) => fakeFsLookup(p) !== undefined,
  readFileSync: (p: string, _enc?: string) => {
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
  fakeFs = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readJson', () => {
  // The fakeFs mock keys absolute paths because upstream producers
  // absolutify bind values in runAgent — by the time a $ref reaches a
  // helper, it carries an absolute path. The helpers themselves do NOT
  // absolutify; they pass the path string verbatim to readFileSync /
  // existsSync. Literal-relative arguments (e.g. fileExists('cached.json'))
  // flow through unchanged and Node resolves them against process.cwd().
  // Tests below populate fakeFs with the exact key shape they pass to the
  // helper; see fakeFsLookup for the absolute→relative fallback used when
  // production hands an absolute version of a relative-key entry.
  it('returns the parsed object when the file exists and contains valid JSON', async () => {
    fakeFs[nodePath.resolve('cls.json')] = JSON.stringify({ type: 'bug', severity: 'high' });
    const { readJson } = await import('./pipeline-helpers.js');
    expect(readJson(nodePath.resolve('cls.json'))).toEqual({ type: 'bug', severity: 'high' });
  });

  it('returns the parsed array when the file exists and contains a JSON array', async () => {
    fakeFs[nodePath.resolve('items.json')] = JSON.stringify([1, 'two', { three: 3 }]);
    const { readJson } = await import('./pipeline-helpers.js');
    expect(readJson(nodePath.resolve('items.json'))).toEqual([1, 'two', { three: 3 }]);
  });

  it('returns a primitive when the file contains a top-level JSON primitive', async () => {
    fakeFs[nodePath.resolve('prim-num.json')] = '42';
    fakeFs[nodePath.resolve('prim-str.json')] = '"hello"';
    fakeFs[nodePath.resolve('prim-bool.json')] = 'true';
    fakeFs[nodePath.resolve('prim-null.json')] = 'null';
    const { readJson } = await import('./pipeline-helpers.js');
    expect(readJson(nodePath.resolve('prim-num.json'))).toBe(42);
    expect(readJson(nodePath.resolve('prim-str.json'))).toBe('hello');
    expect(readJson(nodePath.resolve('prim-bool.json'))).toBe(true);
    expect(readJson(nodePath.resolve('prim-null.json'))).toBeNull();
  });

  it('throws ENOENT when the file does not exist', async () => {
    const { readJson } = await import('./pipeline-helpers.js');
    // fakeFs mock throws an Error with .code === 'ENOENT' and message
    // starting with 'ENOENT' — matches Node's native shape close enough
    // for the contract (the diagnostic surface in pipelines is the
    // `ENOENT` prefix, not the precise class).
    expect(() => readJson(nodePath.resolve('missing.json'))).toThrow(/ENOENT/);
  });

  it('throws SyntaxError when the file exists but contains malformed JSON', async () => {
    fakeFs[nodePath.resolve('broken.json')] = '{ not: valid json }';
    const { readJson } = await import('./pipeline-helpers.js');
    expect(() => readJson(nodePath.resolve('broken.json'))).toThrow(SyntaxError);
  });

  it('accepts a relative path and reads correctly', async () => {
    // The relative-key path of fakeFs (no nodePath.resolve) tests
    // process.cwd()-relative reads. The fakeFsLookup helper resolves
    // absolute→relative when production passes an absolute version of a
    // relative-key entry; here the helper passes the raw string verbatim,
    // so the relative key must match directly.
    fakeFs['rel.json'] = JSON.stringify({ x: 1 });
    const { readJson } = await import('./pipeline-helpers.js');
    expect(readJson('rel.json')).toEqual({ x: 1 });
  });
});

describe('readText', () => {
  it('returns the string contents when the file exists', async () => {
    fakeFs[nodePath.resolve('doc.md')] = '# Heading\n\nBody text.\n';
    const { readText } = await import('./pipeline-helpers.js');
    expect(readText(nodePath.resolve('doc.md'))).toBe('# Heading\n\nBody text.\n');
  });

  it('returns an empty string when the file is empty', async () => {
    fakeFs[nodePath.resolve('empty.md')] = '';
    const { readText } = await import('./pipeline-helpers.js');
    expect(readText(nodePath.resolve('empty.md'))).toBe('');
  });

  it('throws ENOENT when the file does not exist', async () => {
    const { readText } = await import('./pipeline-helpers.js');
    expect(() => readText(nodePath.resolve('missing.md'))).toThrow(/ENOENT/);
  });

  it('returns the contents byte-for-byte (no parsing, no trimming)', async () => {
    // Trailing whitespace, leading newline, embedded tabs — readText
    // returns the raw bytes; pipeline authors run their own normalization
    // if they want it.
    fakeFs[nodePath.resolve('raw.md')] = '\n  TODO\titem  \n\n';
    const { readText } = await import('./pipeline-helpers.js');
    expect(readText(nodePath.resolve('raw.md'))).toBe('\n  TODO\titem  \n\n');
  });

  it('accepts a relative path and reads correctly', async () => {
    fakeFs['rel.md'] = 'relative content';
    const { readText } = await import('./pipeline-helpers.js');
    expect(readText('rel.md')).toBe('relative content');
  });
});

describe('fileExists', () => {
  it('returns true when the file exists', async () => {
    fakeFs[nodePath.resolve('here.json')] = '{}';
    const { fileExists } = await import('./pipeline-helpers.js');
    expect(fileExists(nodePath.resolve('here.json'))).toBe(true);
  });

  it('returns false when the file does not exist', async () => {
    const { fileExists } = await import('./pipeline-helpers.js');
    expect(fileExists(nodePath.resolve('not-here.json'))).toBe(false);
  });

  it('never throws (no error on missing or pathological path)', async () => {
    const { fileExists } = await import('./pipeline-helpers.js');
    // existsSync is total in Node — even pathologically bad inputs return
    // false rather than throwing. Pipeline authors rely on this to guard
    // calls to the throwing helpers (`readJson`, `readText`).
    expect(() => fileExists('/definitely/not/there')).not.toThrow();
    expect(() => fileExists('')).not.toThrow();
    // Null-byte and other invalid path shapes Node would reject on open()
    // still return false from existsSync rather than throwing — pins the
    // non-throw contract for the fileExists($x) && readJson($x) guard.
    expect(() => fileExists('a\0b')).not.toThrow();
  });

  it('accepts a relative path', async () => {
    fakeFs['rel.json'] = '{}';
    const { fileExists } = await import('./pipeline-helpers.js');
    expect(fileExists('rel.json')).toBe(true);
  });
});
