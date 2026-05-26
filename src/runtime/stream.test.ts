import { describe, it, expect } from 'vitest';

describe('formatStreamEvent', () => {
  it('returns null for empty lines', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    expect(formatStreamEvent('')).toBeNull();
    expect(formatStreamEvent('   ')).toBeNull();
  });

  it('returns null for non-JSON lines', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    expect(formatStreamEvent('not json at all')).toBeNull();
  });

  it('renders session id for system.init event', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    const evt = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc123' });
    expect(formatStreamEvent(evt)).toBe('  (session abc123)\n');
  });

  it('renders session id as "?" when missing', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    const evt = JSON.stringify({ type: 'system', subtype: 'init' });
    expect(formatStreamEvent(evt)).toBe('  (session ?)\n');
  });

  it('renders tool name announcement for tool_use content_block_start', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    const evt = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
    });
    expect(formatStreamEvent(evt)).toBe('  ◇ Read: ');
  });

  it('returns text verbatim for text_delta', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    const evt = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } },
    });
    expect(formatStreamEvent(evt)).toBe('Hello world');
  });

  it('returns partial_json for input_json_delta when the fragment has no escaped newlines', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    const evt = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      },
    });
    expect(formatStreamEvent(evt)).toBe('{"path":');
  });

  it('decodes literal \\n escapes to real newlines in input_json_delta so the rolling window can wrap legibly', async () => {
    // Tool inputs are JSON-serialized; a Write tool's `content` field for a
    // multi-line file arrives with `\\n` (literal backslash-n) in place of
    // every newline. Letting that through verbatim turns the rolling window
    // into one giant wrapped logical line of `...\n\n...`. Decoding the
    // escapes at the formatter boundary lets the renderer break on real
    // newlines and FIFO-cap.
    const { formatStreamEvent } = await import('./stream.js');
    const evt = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"content": "line1\\nline2\\n"}' },
      },
    });
    expect(formatStreamEvent(evt)).toBe('{"content": "line1\nline2\n"}');
  });

  it('returns newline for content_block_stop', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    const evt = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    });
    expect(formatStreamEvent(evt)).toBe('\n');
  });

  it('returns null for result events (telemetry captured by caller)', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    const evt = JSON.stringify({
      type: 'result',
      num_turns: 3,
      total_cost_usd: 0.05,
      stop_reason: 'end_turn',
    });
    expect(formatStreamEvent(evt)).toBeNull();
  });

  it('returns null for unhandled stream_event subtypes', async () => {
    const { formatStreamEvent } = await import('./stream.js');
    const evt = JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } });
    expect(formatStreamEvent(evt)).toBeNull();
  });

  it('returns null for JSON-valid non-object values (null, scalars, arrays)', async () => {
    // JSON.parse accepts `null`, numbers, strings, and arrays; without the
    // typeof-object gate, `evt.type` would throw `TypeError: Cannot read
    // properties of null (reading 'type')` inside the readline 'line' callback
    // and escape as uncaughtException. Each variant returns null instead.
    const { formatStreamEvent } = await import('./stream.js');
    expect(formatStreamEvent('null')).toBeNull();
    expect(formatStreamEvent('42')).toBeNull();
    expect(formatStreamEvent('"text"')).toBeNull();
    expect(formatStreamEvent('[1,2]')).toBeNull();
  });
});

describe('extractPrimaryArg', () => {
  // Used by runAgent's mini-mode display: from the accumulated tool-input
  // JSON, pull the most useful one-line label (file_path for Read, command
  // for Bash, etc.). Returns null when the tool isn't in the primary-arg
  // table OR when the JSON doesn't parse OR when the primary value isn't a
  // string; the caller then shows the bare tool name without an argument.

  it('extracts file_path from a Read tool input', async () => {
    const { extractPrimaryArg } = await import('./stream.js');
    expect(extractPrimaryArg('Read', '{"file_path":"/scratch/ACS.md"}')).toBe('/scratch/ACS.md');
  });

  it('extracts file_path from a Write tool input', async () => {
    const { extractPrimaryArg } = await import('./stream.js');
    expect(extractPrimaryArg('Write', '{"file_path":"/out.md","content":"# ..."}')).toBe('/out.md');
  });

  it('extracts command from a Bash tool input', async () => {
    const { extractPrimaryArg } = await import('./stream.js');
    expect(extractPrimaryArg('Bash', '{"command":"ls -la"}')).toBe('ls -la');
  });

  it('extracts pattern from a Grep tool input', async () => {
    const { extractPrimaryArg } = await import('./stream.js');
    expect(extractPrimaryArg('Grep', '{"pattern":"export function"}')).toBe('export function');
  });

  it('returns null for an unknown tool', async () => {
    const { extractPrimaryArg } = await import('./stream.js');
    expect(extractPrimaryArg('SomeFutureTool', '{"foo":"bar"}')).toBeNull();
  });

  it('returns null when JSON is malformed', async () => {
    const { extractPrimaryArg } = await import('./stream.js');
    expect(extractPrimaryArg('Read', '{"file_path":')).toBeNull(); // partial
    expect(extractPrimaryArg('Read', 'not json')).toBeNull();
  });

  it('returns null when the primary key is missing from a parseable JSON', async () => {
    const { extractPrimaryArg } = await import('./stream.js');
    expect(extractPrimaryArg('Read', '{"limit":100}')).toBeNull();
  });

  it('truncates long values with an ellipsis', async () => {
    const { extractPrimaryArg } = await import('./stream.js');
    const longCommand = 'a'.repeat(80);
    const result = extractPrimaryArg('Bash', JSON.stringify({ command: longCommand }))!;
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThan(longCommand.length);
  });

  it('does not truncate short values', async () => {
    const { extractPrimaryArg } = await import('./stream.js');
    expect(extractPrimaryArg('Read', '{"file_path":"a.md"}')).toBe('a.md');
  });
});
