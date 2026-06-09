/** Shape of one JSONL event emitted by `claude -p --output-format stream-json
 *  --verbose --include-partial-messages`. Only fields loom renders or captures
 *  for telemetry are declared; the parser treats unknown shapes as no-op. */
export interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  // `init` system-event roster (only populated when subtype === "init"): the
  // agents the CLI actually loaded, named by their frontmatter `name:` values.
  // Entries are bare strings (tolerated as `{name}` objects too); older CLIs
  // omit the field entirely. Element type is unknown because runAgent trusts
  // only entries it can read a string name from.
  agents?: unknown[];
  // `api_retry` system-event telemetry (only populated when subtype ===
  // "api_retry"). `error` is the category string (e.g. "overloaded",
  // "rate_limit", "server_error"); `error_status` is the raw HTTP status and
  // is captured for telemetry but not rendered.
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number;
  error?: string;
  // Final `result` event telemetry (only populated when type === "result").
  num_turns?: number;
  total_cost_usd?: number;
  stop_reason?: string;
  event?: {
    type?: string;
    content_block?: { type?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string };
  };
}

/** Render one JSONL line from `claude -p --output-format stream-json` into a
 *  human-readable fragment, or null to suppress. Streams text deltas verbatim,
 *  announces each tool call by name, and inlines tool inputs as they accumulate;
 *  `system` init and api_retry events render their own one-liners (api_retry via
 *  formatApiRetry). Result events — and any unrecognized shape — return null;
 *  callers capture result telemetry separately for the summary line. */
export function formatStreamEvent(line: string): string | null {
  if (!line.trim()) return null;
  let evt: StreamEvent;
  try {
    evt = JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
  // JSON.parse accepts non-object scalars (`null`, `42`, `"text"`) and arrays;
  // dereferencing `evt.type` on any of those would throw `TypeError: Cannot
  // read properties of null` inside the readline 'line' callback and escape
  // as `uncaughtException`. Gate to plain object before any field access.
  if (typeof evt !== 'object' || evt === null || Array.isArray(evt)) return null;

  if (evt.type === 'system' && evt.subtype === 'init') {
    return `  (session ${evt.session_id ?? '?'})\n`;
  }

  // An api_retry is a `system` event, not a `stream_event`, so it must be
  // handled before the `stream_event` gate below.
  if (evt.type === 'system' && evt.subtype === 'api_retry') {
    return formatApiRetry(evt);
  }

  if (evt.type !== 'stream_event' || !evt.event) return null;
  const e = evt.event;

  if (e.type === 'content_block_start') {
    if (e.content_block?.type === 'tool_use') return `  ◇ ${e.content_block.name}: `;
  }

  if (e.type === 'content_block_delta') {
    if (e.delta?.type === 'text_delta') return e.delta.text ?? null;
    if (e.delta?.type === 'input_json_delta') {
      // `partial_json` is a fragment of a JSON-serialized tool input. Its
      // string-valued fields carry literal backslash-`n` (not real newlines)
      // wherever the source contained a newline — e.g., a Write tool's
      // `content` field for a multi-line file shows up as the 2-char escape
      // sequence in the stream. Substitute the escape with a real newline at
      // the display boundary so the rolling window breaks long content into
      // wrapped lines and the user sees something legible. Other JSON escapes
      // (`\\"`, `\\\\`, `\\t`) are left as-is — less visually disruptive and
      // decoding across chunk boundaries is ambiguous (a fragment ending in
      // `\` then `n` in the next chunk surfaces here as two separate calls,
      // each receiving only part of the escape; out of scope for this fix).
      const raw = e.delta.partial_json ?? null;
      return raw === null ? null : raw.replace(/\\n/g, '\n');
    }
  }

  if (e.type === 'content_block_stop') {
    return '\n';
  }

  return null;
}

/** Build the single status line for an `api_retry` system event, e.g.
 *  `  ⟳ retry 3/20 — overloaded, waiting 8s\n`. Carries the leading two-space
 *  indent and trailing newline to match the init/tool line convention. Missing
 *  attempt or max_retries render as `?`; the `— <category>` clause is omitted
 *  when `error` is empty or absent, and the `, waiting Ns` clause when
 *  `retry_delay_ms` is absent. Exported so the mini-mode mirror reuses the
 *  one format. */
export function formatApiRetry(evt: StreamEvent): string {
  let line = `  ⟳ retry ${evt.attempt ?? '?'}/${evt.max_retries ?? '?'}`;
  if (evt.error) line += ` — ${evt.error}`;
  if (evt.retry_delay_ms !== undefined)
    line += `, waiting ${Math.round(evt.retry_delay_ms / 1000)}s`;
  return line + '\n';
}

/** Map from tool name → the JSON-input key whose value is most useful as a
 *  one-line label in the mini parallel view. Read/Write/Edit show the file
 *  being touched; Bash shows the command being run; Grep/Glob show the
 *  pattern; LS the path; WebFetch the URL; WebSearch the query. Tools not in
 *  this table get just the bare name (the user sees `◇ ToolName` without an
 *  argument). The list is intentionally small — adding entries is cheap, but
 *  showing every possible field would defeat the "compact list" point of the
 *  mini layout. */
export const TOOL_PRIMARY_ARG: Record<string, string> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Bash: 'command',
  Grep: 'pattern',
  Glob: 'pattern',
  LS: 'path',
  WebFetch: 'url',
  WebSearch: 'query',
};

/** Maximum length of a primary-arg value to show in mini view. Longer values
 *  (Bash commands, occasional long file paths) get truncated with `…`. Sized
 *  to keep each tool line at roughly one visual row on an 80-col terminal. */
export const PRIMARY_ARG_MAX_LEN = 60;

/** Parse the accumulated `input_json_delta` buffer for a tool call and pull
 *  the value for `TOOL_PRIMARY_ARG[toolName]`. Returns `null` for tools not
 *  in the table, or when the buffer doesn't parse cleanly, or when the
 *  primary-key value isn't a string. The runtime falls back to displaying
 *  the bare tool name in those cases. */
export function extractPrimaryArg(toolName: string, argsBuffer: string): string | null {
  const key = TOOL_PRIMARY_ARG[toolName];
  if (key === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsBuffer);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[key];
  if (typeof value !== 'string') return null;
  return value.length > PRIMARY_ARG_MAX_LEN ? value.substring(0, PRIMARY_ARG_MAX_LEN) + '…' : value;
}
