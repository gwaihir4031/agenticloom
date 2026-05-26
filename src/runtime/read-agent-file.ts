import { readFileSync } from 'fs';
import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';
import { z } from 'zod/v4';
import { requireFile, buildCorrectivePrompt } from './agent.js';

/** Read, parse, and validate a JSON file produced by an agent. The strictness
 *  policy (`z.strictObject` at top level, `z.looseObject` at finding level) is
 *  the caller's responsibility — set it on the passed schema.
 *
 *  When `rewriteProducerFile` is provided and budget remains, parse failures
 *  (including empty-file) trigger one recursive retry; the original error
 *  shape is preserved when budget exhausts, so CLI-wrapper error handling
 *  is unchanged. The closure takes the corrective prompt as an argument (not
 *  zero-arg) — re-running the original input prompt that already produced
 *  broken output would just trigger the same failure; the corrective prompt
 *  is the new information the agent gets on retry. Zod-shape failures do NOT
 *  trigger retry — they need a different correction prompt; v1 keeps scope
 *  tight to parse-only. */
export async function readAgentFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  agent: string,
  rewriteProducerFile?: (correctivePrompt: string) => Promise<void>,
  maxRetries: number = 1,
  retryAttempted: boolean = false,
): Promise<T> {
  // Existence is probed by `requireFile` (mirrors runAgent's pre-spawn check);
  // any I/O failure that lands here (permissions, EISDIR, EIO, ...) propagates
  // unmasked from `readFileSync`.
  requireFile(filePath, { kind: 'reading-output', agent });
  const raw = readFileSync(filePath, 'utf-8');

  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  // Distinguishes a retry-exhausted failure from a first-attempt failure when
  // building the thrown error message. Otherwise the two look identical and
  // operators can't tell from the error alone whether retry was attempted.
  // Tracked separately (not derived from `maxRetries < 1`) so callers passing
  // `maxRetries: 0` explicitly ("no retry") don't false-positive the suffix.
  const retrySuffix = retryAttempted ? ' (after 1 corrective retry)' : '';

  if (stripped === '') {
    if (rewriteProducerFile && maxRetries > 0) {
      const correctivePrompt = buildCorrectivePrompt(filePath, 'empty file');
      console.log(
        `  ↻ ${agent} wrote empty ${filePath}; re-invoking with corrective prompt (${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'} left)`,
      );
      await rewriteProducerFile(correctivePrompt);
      return readAgentFile(filePath, schema, agent, rewriteProducerFile, maxRetries - 1, true);
    }
    throw new Error(`agent '${agent}' wrote ${filePath} but the file is empty${retrySuffix}`);
  }

  const errors: ParseError[] = [];
  const value = parseJsonc(stripped, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join('; ');
    if (rewriteProducerFile && maxRetries > 0) {
      const firstDetail = `${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`;
      const correctivePrompt = buildCorrectivePrompt(filePath, firstDetail);
      console.log(
        `  ↻ ${agent} wrote invalid JSON in ${filePath} (${firstDetail}); re-invoking with corrective prompt (${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'} left)`,
      );
      await rewriteProducerFile(correctivePrompt);
      return readAgentFile(filePath, schema, agent, rewriteProducerFile, maxRetries - 1, true);
    }
    throw new Error(`agent '${agent}' wrote invalid JSON in ${filePath}: ${detail}${retrySuffix}`);
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `agent '${agent}' wrote ${filePath} but it failed validation: ${result.error.message}`,
    );
  }
  return result.data;
}
