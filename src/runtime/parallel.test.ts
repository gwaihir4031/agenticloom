import { describe, it, expect } from 'vitest';

describe('parallel', () => {
  it('runs tasks concurrently and returns results in order', async () => {
    const { parallel } = await import('./parallel.js');
    const results = await parallel([
      async () => 'a' as const,
      async () => 1 as const,
      async () => true as const,
    ]);
    expect(results).toEqual(['a', 1, true]);
  });

  it('rejects with the first rejection', async () => {
    const { parallel } = await import('./parallel.js');
    await expect(
      parallel([
        async () => {
          throw new Error('first fail');
        },
        async () => 'ok' as const,
      ]),
    ).rejects.toThrow('first fail');
  });

  it('preserves tuple types', async () => {
    const { parallel } = await import('./parallel.js');
    const results: [string, number] = await parallel([async () => 'str', async () => 42]);
    expect(results[0]).toBe('str');
    expect(results[1]).toBe(42);
  });
});
