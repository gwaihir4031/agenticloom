import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

describe('RollingWindow', () => {
  let originalIsTTY: boolean | undefined;
  let stdoutWrites: string[];
  let stdoutWriteMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset module so each test gets a fresh `altScreenDepth` /
    // `pendingCollapseLines`. Without this, a prior test that called
    // `start()` without a matching `finish()` (e.g., the "renders agent
    // header + ... on start" test) leaves depth>0 in the module, and the
    // next test's `finish()` defers the collapse line into pending instead
    // of writing it through.
    vi.resetModules();
    originalIsTTY = process.stdout.isTTY;
    stdoutWrites = [];
    stdoutWriteMock = vi.fn((chunk: string) => {
      stdoutWrites.push(chunk);
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(stdoutWriteMock as any);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  describe('TTY mode', () => {
    beforeEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    });

    it('renders agent header + top border + content rows + bottom border on start', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      const all = stdoutWrites.join('');
      expect(all).toContain('→ ac-writer');
      expect(all).toMatch(/┌─+┐/); // top border
      expect(all).toMatch(/└─+┘/); // bottom border
    });

    it('collapses to a single status line on finish with telemetry', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      window.setResult({ num_turns: 3, total_cost_usd: 0.0234, stop_reason: 'end_turn' });
      stdoutWrites = []; // discard the start render
      window.finish('ok');
      const all = stdoutWrites.join('');
      expect(all).toContain('✓ ac-writer');
      expect(all).toContain('3 turns');
      expect(all).toContain('$0.0234');
      expect(all).toContain('end_turn');
    });

    it('renders the retry summary on the collapse line when retry_count > 0', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      window.setResult({ retry_count: 3, retry_category: 'overloaded' });
      stdoutWrites = []; // discard the start render
      window.finish('ok');
      const all = stdoutWrites.join('');
      expect(all).toContain('✓ ac-writer');
      expect(all).toContain('retried 3× (overloaded)');
    });

    it('merges separate setResult calls so retry summary and result telemetry both survive', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      // Two independent sinks: the incremental retry summary and the terminal
      // result event. Neither call may clobber the other.
      window.setResult({ retry_count: 3, retry_category: 'overloaded' });
      window.setResult({ num_turns: 12, total_cost_usd: 0.01, stop_reason: 'end_turn' });
      stdoutWrites = [];
      window.finish('ok');
      const all = stdoutWrites.join('');
      expect(all).toContain('12 turns');
      expect(all).toContain('$0.0100');
      expect(all).toContain('retried 3× (overloaded)');
    });

    it('renders the retry summary on an error finish too', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      window.setResult({ retry_count: 3, retry_category: 'overloaded' });
      stdoutWrites = [];
      window.finish('error');
      const all = stdoutWrites.join('');
      expect(all).toContain('✗ ac-writer');
      expect(all).toContain('retried 3× (overloaded)');
    });

    it('renders retry count without a parenthetical when category is absent', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      window.setResult({ retry_count: 2 });
      stdoutWrites = [];
      window.finish('ok');
      const all = stdoutWrites.join('');
      expect(all).toContain('retried 2×');
      expect(all).not.toContain('retried 2× (');
    });

    it('omits the retry summary when retry_count is 0 or unset', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const zero = new RollingWindow('zero-agent', null);
      zero.start();
      zero.setResult({ retry_count: 0, num_turns: 1 });
      stdoutWrites = [];
      zero.finish('ok');
      expect(stdoutWrites.join('')).not.toContain('retried');

      const unset = new RollingWindow('unset-agent', null);
      unset.start();
      unset.setResult({ num_turns: 1 });
      stdoutWrites = [];
      unset.finish('ok');
      expect(stdoutWrites.join('')).not.toContain('retried');
    });

    it('merges a result event set before the retry fields without clobbering either', async () => {
      // Reverse of the other merge test: the terminal result event arrives
      // first, then the incremental retry summary. The later retry call must
      // not wipe the turns/cost already recorded.
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      window.setResult({ num_turns: 12, total_cost_usd: 0.01, stop_reason: 'end_turn' });
      window.setResult({ retry_count: 3, retry_category: 'overloaded' });
      stdoutWrites = [];
      window.finish('ok');
      const all = stdoutWrites.join('');
      expect(all).toContain('12 turns');
      expect(all).toContain('$0.0100');
      expect(all).toContain('retried 3× (overloaded)');
    });

    it('appends the retry clause as a dot-joined part after turns, cost, and stop_reason', async () => {
      // Pins the ordering: the retry clause is the last meta part, joined to
      // the result-event parts with the same ` · ` separator.
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      window.setResult({
        num_turns: 3,
        total_cost_usd: 0.01,
        stop_reason: 'end_turn',
        retry_count: 3,
        retry_category: 'overloaded',
      });
      stdoutWrites = [];
      window.finish('ok');
      const all = stdoutWrites.join('');
      expect(all).toContain('3 turns · $0.0100 · end_turn · retried 3× (overloaded)');
    });

    it('records retry_exhausted as a typed field without rendering it on the collapse line', async () => {
      // retry_exhausted is structured data for a future auto-resume consumer:
      // it must never appear in the rendered status line, even when set true.
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      window.setResult({ retry_count: 1, retry_category: 'overloaded', retry_exhausted: true });
      stdoutWrites = [];
      window.finish('error');
      const all = stdoutWrites.join('');
      expect(all).toContain('retried 1× (overloaded)');
      expect(all).not.toContain('exhausted');
    });

    it('renders ✗ icon on error finish', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      stdoutWrites = [];
      window.finish('error');
      expect(stdoutWrites.join('')).toContain('✗ ac-writer');
    });

    it('logStderrLine writes nothing to stdout (the live stderr echo belongs to runAgent)', async () => {
      // Constraint: logStderrLine is log-stream-only. It must neither echo to
      // stdout nor trigger a window render. In TTY mode, where stdout is
      // otherwise active, a clean call therefore produces zero stdout writes.
      // (logPath is null here; the no-stdout guarantee is independent of
      // whether a log stream exists, since the method never touches stdout.)
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      stdoutWrites = []; // discard the start() box render
      window.logStderrLine('boom');
      expect(stdoutWrites).toHaveLength(0);
      window.finish('ok'); // close the lifecycle so the resize listener is removed
    });

    it('logStderrLine does not surface the stderr line in the live rolling window', async () => {
      // Constraint: log-stream-only — logStderrLine must not push to the
      // window's line buffer. If it did, the stderr text would scroll into the
      // box on the next render. Feed stdout lines around a logStderrLine call
      // and confirm the re-render shows only the stdout lines, never the stderr.
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      window.feed('alpha\n');
      window.logStderrLine('beta');
      stdoutWrites = []; // capture only the render triggered by the next feed
      window.feed('gamma\n');
      const all = stdoutWrites.join('');
      expect(all).toContain('alpha');
      expect(all).toContain('gamma');
      expect(all).not.toContain('beta');
      window.finish('ok'); // close the lifecycle so the resize listener is removed
    });
  });

  describe('non-TTY mode', () => {
    beforeEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    });

    it('renders agent header only (no border) on start', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      const all = stdoutWrites.join('');
      expect(all).toContain('→ ac-writer');
      expect(all).not.toMatch(/┌─+┐/);
    });

    it('streams feed text line-by-line', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ac-writer', null);
      window.start();
      stdoutWrites = [];
      window.feed('line one\nline two\n');
      const all = stdoutWrites.join('');
      expect(all).toContain('line one');
      expect(all).toContain('line two');
    });

    it('renders status line on finish (same format as TTY mode)', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', null);
      window.start();
      stdoutWrites = [];
      window.finish('ok');
      expect(stdoutWrites.join('')).toContain('✓ a');
    });
  });

  describe('feed handling', () => {
    beforeEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    });

    it('handles empty input gracefully', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', null);
      window.start();
      expect(() => window.feed('')).not.toThrow();
    });

    it('accumulates partial lines until newline arrives', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', null);
      window.start();
      // Two feeds without newline; then a newline arrives.
      window.feed('partial ');
      window.feed('content\n');
      // Test passes if no throw and the line eventually commits.
    });

    it('fills the box from the top and pads with blank rows at the bottom when under-filled', async () => {
      // Three lines, WINDOW_ROWS=25 → 3 content rows at top + 22 blank rows
      // below. (Previous behavior was the opposite: 22 blanks at top, 3 lines
      // at bottom, content scrolling up. Flipped so the user reads
      // top-to-bottom.)
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', null);
      window.start();
      stdoutWrites = [];
      window.feed('first\nsecond\nthird\n');
      const all = stdoutWrites.join('');
      // Extract the content rows in render order (between top border and bottom border).
      // Each content row is emitted via `\r\x1b[2K  │<row>│\n`.
      const rowMatches = [...all.matchAll(/│(.{1,})│\n/g)].map((m) => m[1]);
      // After feed, the render emits exactly WINDOW_ROWS=25 rows then the
      // bottom border. The first three rows are content; the rest are blanks.
      expect(rowMatches.length).toBeGreaterThanOrEqual(25);
      expect(rowMatches[0].trimEnd()).toBe('first');
      expect(rowMatches[1].trimEnd()).toBe('second');
      expect(rowMatches[2].trimEnd()).toBe('third');
      expect(rowMatches[3].trim()).toBe(''); // first blank row
      expect(rowMatches[24].trim()).toBe(''); // last blank row before bottom border
    });

    it('wraps long lines to multiple visual rows instead of truncating with ellipsis', async () => {
      // cols=40 → inner = max(20, 40-4) = 36. A 100-char line wraps to
      // 3 visual rows (36 + 36 + 28). The render should emit each chunk
      // as its own row inside the box; no ellipsis character.
      const originalCols = process.stdout.columns;
      Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
      try {
        const { RollingWindow } = await import('./RollingWindow.js');
        const window = new RollingWindow('a', null);
        window.start();
        stdoutWrites = [];
        const longLine = 'X'.repeat(100);
        window.feed(longLine + '\n');
        const all = stdoutWrites.join('');
        // No truncation marker.
        expect(all).not.toContain('…');
        // First two visual rows: 36 X's each, no padding.
        const xs36 = 'X'.repeat(36);
        expect(all).toContain(`│${xs36}│`);
        // Third visual row: 28 X's + 8 spaces of padding to fill `inner=36`.
        const lastRow = 'X'.repeat(28) + ' '.repeat(8);
        expect(all).toContain(`│${lastRow}│`);
      } finally {
        Object.defineProperty(process.stdout, 'columns', {
          value: originalCols,
          configurable: true,
        });
      }
    });
  });

  describe('alt-screen buffer (TTY mode)', () => {
    // Module-level `altScreenDepth` / `pendingCollapseLines` state persists
    // across imports unless we explicitly reset. `vi.resetModules()` plus a
    // fresh `await import(...)` gives each test a clean module instance —
    // matters most for the parallel-collapse-buffer scenario, where a prior
    // test's start() without finish() would leave depth>0 and the next
    // test's collapse line would defer into pending instead of writing
    // through. The `'exit'`-listener registration is gated on a
    // `Symbol.for(...)`-keyed flag on `process` itself so re-imports don't
    // multi-register and trip Node's MaxListeners threshold.
    beforeEach(() => {
      vi.resetModules();
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    });

    it('activates the alt-screen buffer on first start() in TTY mode', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', null);
      window.start();
      const all = stdoutWrites.join('');
      // Enter alt-screen + hide cursor are both written before any rendering.
      expect(all).toContain('\x1b[?1049h');
      expect(all).toContain('\x1b[?25l');
    });

    it('does not re-emit activation on subsequent start() calls in same module', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      new RollingWindow('a', null).start(); // first start: activates
      stdoutWrites = [];
      new RollingWindow('b', null).start(); // second start: module flag set, skips
      const all = stdoutWrites.join('');
      expect(all).not.toContain('\x1b[?1049h');
    });

    it('does not activate alt-screen in non-TTY mode', async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      const { RollingWindow } = await import('./RollingWindow.js');
      new RollingWindow('a', null).start();
      const all = stdoutWrites.join('');
      expect(all).not.toContain('\x1b[?1049h');
      expect(all).not.toContain('\x1b[?25l');
    });

    it("defers parallel siblings' collapse lines until the last sibling exits alt", async () => {
      // 3 parallel agents: each `start()` increments depth (1, 2, 3). The
      // first two `finish()` calls happen while depth>0 (the third sibling
      // is still alive), so their collapse lines defer into the pending
      // buffer rather than writing to alt (which would lose them). The
      // third `finish()` decrements depth to 0, exits alt, and flushes all
      // three deferred lines to main buffer in finish-order.
      const { RollingWindow } = await import('./RollingWindow.js');
      const a = new RollingWindow('agentA', null);
      const b = new RollingWindow('agentB', null);
      const c = new RollingWindow('agentC', null);
      a.start(); // depth 0→1: emits alt-enter
      b.start(); // depth 1→2: no-op
      c.start(); // depth 2→3: no-op
      stdoutWrites = [];

      a.finish('ok'); // depth 3→2, push agentA's collapse to pending
      expect(stdoutWrites.join('')).not.toContain('agentA');

      b.finish('ok'); // depth 2→1, push agentB's
      expect(stdoutWrites.join('')).not.toContain('agentA');
      expect(stdoutWrites.join('')).not.toContain('agentB');

      c.finish('error'); // depth 1→0, exit alt, flush all 3 to main
      const writes = stdoutWrites.join('');
      expect(writes).toContain('✓ agentA');
      expect(writes).toContain('✓ agentB');
      expect(writes).toContain('✗ agentC');
      // Order preserved: finish-order is the flush-order.
      const idxA = writes.indexOf('✓ agentA');
      const idxB = writes.indexOf('✓ agentB');
      const idxC = writes.indexOf('✗ agentC');
      expect(idxA).toBeLessThan(idxB);
      expect(idxB).toBeLessThan(idxC);
    });
  });

  describe('mini layout (parallel agents)', () => {
    // When `parallel()` increments parallelDepth before tasks fire, each
    // RollingWindow created inside the parallel block uses the mini layout:
    // 4 rows total (1 header + 3 content), absolute cursor positioning to
    // a coordinator-assigned row range, no box borders. Sequential agents
    // (outside parallel context) keep the existing 25-row box.
    beforeEach(() => {
      vi.resetModules();
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    });

    it('uses mini layout when started inside a parallel context', async () => {
      const { RollingWindow, enterParallelContext, exitParallelContext } =
        await import('./RollingWindow.js');
      enterParallelContext();
      const window = new RollingWindow('p-agent', null);
      window.start();
      const all = stdoutWrites.join('');
      // Mini header uses ↪ (not the full-box →), absolute positioning at
      // row 1 (`\x1b[1;1H`), and no box-drawing characters.
      expect(all).toContain('↪ p-agent');
      expect(all).toContain('\x1b[1;1H');
      expect(all).not.toMatch(/┌─+┐/);
      exitParallelContext();
    });

    it('uses full box when started outside any parallel context', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('seq-agent', null);
      window.start();
      const all = stdoutWrites.join('');
      // Sequential agent gets the 25-row box with `→` header.
      expect(all).toContain('→ seq-agent');
      expect(all).toMatch(/┌─+┐/);
      expect(all).toMatch(/└─+┘/);
    });

    it('allocates non-overlapping row ranges to siblings', async () => {
      const { RollingWindow, enterParallelContext, exitParallelContext } =
        await import('./RollingWindow.js');
      enterParallelContext();
      const a = new RollingWindow('p1', null);
      const b = new RollingWindow('p2', null);
      const c = new RollingWindow('p3', null);
      a.start(); // row 1 (MINI_ROW_COUNT=4 → covers 1-4)
      b.start(); // row 5 (covers 5-8)
      c.start(); // row 9 (covers 9-12)
      const all = stdoutWrites.join('');
      // Each header is written at its assigned absolute row.
      expect(all).toContain('\x1b[1;1H');
      expect(all).toContain('\x1b[5;1H');
      expect(all).toContain('\x1b[9;1H');
      // Each row is uniquely associated with its agent's header.
      const idx1 = all.indexOf('\x1b[1;1H');
      const idx5 = all.indexOf('\x1b[5;1H');
      const idx9 = all.indexOf('\x1b[9;1H');
      // The agent name should follow its row-positioning escape; the three
      // headers should appear in start-order in the output.
      expect(all.indexOf('↪ p1', idx1)).toBeGreaterThan(idx1);
      expect(all.indexOf('↪ p2', idx5)).toBeGreaterThan(idx5);
      expect(all.indexOf('↪ p3', idx9)).toBeGreaterThan(idx9);
      exitParallelContext();
    });

    it('releases rows on finish; next parallel block starts fresh at row 1', async () => {
      const { RollingWindow, enterParallelContext, exitParallelContext } =
        await import('./RollingWindow.js');
      enterParallelContext();
      const a1 = new RollingWindow('block1-a', null);
      const b1 = new RollingWindow('block1-b', null);
      a1.start();
      b1.start();
      a1.finish('ok');
      b1.finish('ok'); // both released; nextStartRow resets to 1
      exitParallelContext();

      stdoutWrites = [];
      enterParallelContext();
      const a2 = new RollingWindow('block2-a', null);
      a2.start();
      const all = stdoutWrites.join('');
      // New parallel block: row 1 is assigned again because the coordinator
      // reset on the previous block's release.
      expect(all).toContain('\x1b[1;1H');
      expect(all).toContain('↪ block2-a');
      a2.finish('ok');
      exitParallelContext();
    });

    it('renders content at absolute rows below the header', async () => {
      const { RollingWindow, enterParallelContext, exitParallelContext } =
        await import('./RollingWindow.js');
      enterParallelContext();
      const window = new RollingWindow('p', null);
      window.start();
      stdoutWrites = [];
      window.feed('hello\nworld\n');
      const all = stdoutWrites.join('');
      // Header at row 1, content rows at rows 2-4. Each content row
      // is positioned via `\x1b[r;1H`. With 2 fed lines + 1 blank to fill
      // the 3-row content area, we expect writes to rows 2, 3, and 4.
      expect(all).toContain('\x1b[2;1H');
      expect(all).toContain('\x1b[3;1H');
      expect(all).toContain('\x1b[4;1H');
      // Content is indented (4-space) under the header.
      expect(all).toContain('    hello');
      expect(all).toContain('    world');
      window.finish('ok');
      exitParallelContext();
    });

    it('releaseMiniRows throws on never-allocated window (contract violation)', async () => {
      // Defensive guard: today the only releaseMiniRows caller is
      // `RollingWindow.finish()`'s `if (this.miniStartRow !== undefined)`
      // branch, so this throw is unreachable through normal API. But the
      // previous unconditional `miniLayout.active.delete(window)` would
      // corrupt sibling allocations if a future code path released without
      // first allocating: the delete is a no-op, but the `active.size === 0`
      // branch still fires and resets `nextStartRow` to 1, breaking
      // surviving siblings' row ranges. Verifies the loud-fail throw is in
      // place. Simulates the contract violation by setting `miniStartRow`
      // on a fresh window (bypassing `start()`) — `finish()` then takes
      // the `miniStartRow !== undefined` branch and reaches releaseMiniRows
      // with a window that was never `allocateMiniRows`'d.
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('ghost', null);
      // Bypass the start() path so the window is NOT in miniLayout.active,
      // but force the finish() branch by setting miniStartRow directly.
      (window as unknown as { miniStartRow: number }).miniStartRow = 1;
      expect(() => window.finish('ok')).toThrow(/window not allocated/);
    });
  });

  describe('log tee (logPath)', () => {
    // Mock fs's createWriteStream + mkdirSync to assert RollingWindow opens
    // the right path in append mode under the right parent directory, and
    // tees committed lines into the write stream. Non-TTY is sufficient here
    // — the log tee runs identically in both TTY and non-TTY modes (the
    // commitLine() call site doesn't branch on isTTY for the logStream
    // write); non-TTY just keeps the stdout assertions out of scope.
    // `writeStreamMock` is a real EventEmitter so the constructor's
    // `logStream.on('error', ...)` listener wires correctly and tests can
    // synthesize stream errors via `.emit('error', new Error(...))`.
    let writeStreamMock: EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    let createWriteStreamMock: ReturnType<typeof vi.fn>;
    let mkdirSyncMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      writeStreamMock = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(),
      });
      createWriteStreamMock = vi.fn(() => writeStreamMock);
      mkdirSyncMock = vi.fn();
      vi.doMock('fs', () => ({
        createWriteStream: createWriteStreamMock,
        mkdirSync: mkdirSyncMock,
      }));
      vi.resetModules();
    });

    afterEach(() => {
      vi.doUnmock('fs');
      vi.resetModules();
    });

    it('opens a write stream at logPath in append mode', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      new RollingWindow('a', 'logs/a.log');
      expect(createWriteStreamMock).toHaveBeenCalledWith('logs/a.log', { flags: 'a' });
    });

    it('creates the parent directory recursively before opening the stream', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      new RollingWindow('a', 'logs/a.log');
      expect(mkdirSyncMock).toHaveBeenCalledWith('logs', { recursive: true });
    });

    it('tees committed lines to the log stream', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', 'logs/a.log');
      window.start();
      window.feed('hello\n');
      // commitLine() writes `${line}\n` for each newline-terminated chunk.
      expect(writeStreamMock.write).toHaveBeenCalledWith('hello\n');
    });

    it('does NOT open a write stream when logPath is null', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      new RollingWindow('a', null);
      expect(createWriteStreamMock).not.toHaveBeenCalled();
      expect(mkdirSyncMock).not.toHaveBeenCalled();
    });

    it('drops feed() calls after finish() — no stream write-after-end', async () => {
      // Timeout-then-late-readline-event race: `finish('error')` ends the
      // log stream; if a buffered readline event then arrives and calls
      // `feed(...)`, writing to the ended stream raises an
      // `ERR_STREAM_WRITE_AFTER_END` 'error' event with no listener and
      // escapes as uncaughtException. The `if (this.finished) return;`
      // guard in `feed()` prevents that — late content is silently
      // dropped (the agent's run was already concluded by the upstream
      // timeout/exit) instead of crashing the process.
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', 'logs/a.log');
      window.start();
      writeStreamMock.write.mockClear();
      window.finish('ok');
      // Snapshot the call count after finish() — finish() itself writes the
      // closing `=== finished ===` marker plus the summary; we only care
      // that a subsequent feed() doesn't add more.
      const callsAfterFinish = writeStreamMock.write.mock.calls.length;
      expect(() => window.feed('late content\n')).not.toThrow();
      expect(writeStreamMock.write).toHaveBeenCalledTimes(callsAfterFinish);
    });

    it('handles async logStream errors via console.error and disables further teeing', async () => {
      // EACCES/ENOSPC/EROFS/NFS-hiccup would otherwise escape as
      // uncaughtException. The constructor attaches an 'error' listener
      // that logs a diagnostic and nulls the log stream — the agent's
      // run continues via stdout, degraded but functional. After the
      // error, further `feed()` calls must not throw (the listener
      // dropped the stream reference, so the optional-chained
      // `logStream?.write(...)` in `commitLine()` is a no-op).
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('agent-x', 'logs/agent-x.log');
      window.start();
      writeStreamMock.emit('error', new Error('EACCES: permission denied'));
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const msg = consoleErrorSpy.mock.calls[0][0] as string;
      expect(msg).toContain('agent-x');
      expect(msg).toContain('EACCES: permission denied');
      expect(() => window.feed('line after error\n')).not.toThrow();
      consoleErrorSpy.mockRestore();
    });

    it('tees a stderr line to the log stream marked, in a single write', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', 'logs/a.log');
      window.start();
      writeStreamMock.write.mockClear(); // discard the start() header write
      window.logStderrLine('boom');
      // One write of the marker + line + trailing newline (NOT three writes).
      // Literal expected string pins the exact wire format independently of
      // the STDERR_LOG_MARKER constant.
      expect(writeStreamMock.write).toHaveBeenCalledTimes(1);
      expect(writeStreamMock.write).toHaveBeenCalledWith('stderr│ boom\n');
    });

    it('does NOT write a stderr line when logPath is null', async () => {
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', null);
      window.start();
      // logStream is null (--save-logs off): the optional chain makes this a
      // silent no-op rather than throwing.
      expect(() => window.logStderrLine('boom')).not.toThrow();
      expect(writeStreamMock.write).not.toHaveBeenCalled();
    });

    it('drops logStderrLine() calls after finish() — no stream write-after-end', async () => {
      // Same timeout-then-late-event race as the feed()-after-finish drop:
      // finish() ends the log stream, so a stderr line arriving afterward must
      // not write to the ended stream (ERR_STREAM_WRITE_AFTER_END). The
      // `if (this.finished) return;` guard drops it instead.
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', 'logs/a.log');
      window.start();
      writeStreamMock.write.mockClear();
      window.finish('ok');
      const callsAfterFinish = writeStreamMock.write.mock.calls.length;
      expect(() => window.logStderrLine('late')).not.toThrow();
      expect(writeStreamMock.write).toHaveBeenCalledTimes(callsAfterFinish);
    });

    it('preserves a blank stderr line as a marked empty line (does not drop it)', async () => {
      // No empty-guard on the method: a blank stderr line still tees exactly
      // one marked write (`stderr│ \n`), mirroring how the stdout tee preserves
      // a blank stdout line as `\n`. Keeps stderr's vertical spacing intact in
      // the post-mortem log and guards against a future `if (!line) return`
      // that would silently swallow blank stderr lines.
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', 'logs/a.log');
      window.start();
      writeStreamMock.write.mockClear(); // discard the start() header write
      window.logStderrLine('');
      expect(writeStreamMock.write).toHaveBeenCalledTimes(1);
      expect(writeStreamMock.write).toHaveBeenCalledWith('stderr│ \n');
    });

    it('interleaves stdout and stderr on the same log stream in arrival order, only stderr marked', async () => {
      // The marker's whole reason to exist (PRD scope boundary): stdout
      // (commitLine) and stderr (logStderrLine) tee into the SAME log stream in
      // arrival order, and ONLY the stderr lines carry `stderr│ ` so a
      // post-mortem reader can tell the two streams apart in the merged log.
      // The isolated tests above pin each half; this pins their coexistence —
      // the actual post-mortem-reader contract.
      const { RollingWindow } = await import('./RollingWindow.js');
      const window = new RollingWindow('a', 'logs/a.log');
      window.start();
      writeStreamMock.write.mockClear(); // discard the start() header write
      window.feed('out\n');
      window.logStderrLine('err');
      window.feed('out2\n');
      expect(writeStreamMock.write.mock.calls).toEqual([['out\n'], ['stderr│ err\n'], ['out2\n']]);
    });
  });
});
