import { existsSync, readFileSync } from 'fs';

/** Read and JSON-parse a file. Consumed in `branch.when:` expressions for
 *  content-aware routing (e.g. `readJson($cls).type === 'bug'`). Returns
 *  `unknown` rather than a typed schema — pipeline authors accept the runtime
 *  cost of a missing field as `undefined`. Loom does not impose a schema on
 *  the parsed shape; the helper's job is to make the file content available
 *  to the JS condition.
 *
 *  Path resolution: passed verbatim to Node's `readFileSync`. Relative paths
 *  anchor at `process.cwd()` — `cli.ts` does `process.chdir(workspaceDir)`
 *  before invoking the compiled pipeline, so relative literals resolve at
 *  the workspace root (same convention as step `produces:` paths). Absolute
 *  literals and post-substitution `$ref` values (which are absolute) pass
 *  through unchanged.
 *
 *  Error semantics: throws Node-stock `ENOENT` on missing file, `SyntaxError`
 *  on malformed JSON. Loom does NOT wrap these — the outer catch in `main()`
 *  surfaces them with the user's path verbatim. Guard with `fileExists`
 *  first if the file may not exist. */
export function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/** Read a file as UTF-8 text. Consumed in `branch.when:` expressions for
 *  content-aware routing (e.g. `readText($draft).includes('TODO')`). No
 *  parsing, no trimming — the returned string is byte-for-byte the file's
 *  contents.
 *
 *  Path resolution: same as `readJson` — `process.cwd()`-relative or absolute,
 *  passed verbatim to `readFileSync`.
 *
 *  Error semantics: throws Node-stock `ENOENT` on missing file. Guard with
 *  `fileExists` first if the file may not exist. */
export function readText(filePath: string): string {
  return readFileSync(filePath, 'utf-8');
}

/** Probe for a file's existence. Consumed in `branch.when:` expressions as a
 *  guard for the read-or-skip pattern (e.g.
 *  `fileExists('cached-result.json') && readJson('cached-result.json').version === 2`).
 *  Never throws — that's its purpose; pipeline authors call this before the
 *  potentially-throwing helpers.
 *
 *  Path resolution: same as `readJson` / `readText` — `process.cwd()`-relative
 *  or absolute, passed verbatim to `existsSync`. */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}
