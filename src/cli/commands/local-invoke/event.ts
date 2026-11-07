import { readFileSync } from 'node:fs';
import { getLogger } from '../../../utils/logger.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../../utils/json-parse-failure.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { type LocalInvokeOptions } from './types.js';

/**
 * Read the event payload from `--event <file>`, `--event-stdin`, or
 * default `{}`. JSON-validated at parse time so a typo doesn't reach
 * the handler as a string blob.
 */
export async function readEvent(options: LocalInvokeOptions): Promise<unknown> {
  if (options.event && options.eventStdin) {
    throw new Error('--event and --event-stdin are mutually exclusive.');
  }
  if (options.eventStdin) {
    const raw = await readStdin();
    return parseEvent(raw, '<stdin>');
  }
  if (options.event) {
    const raw = readFileSync(options.event, 'utf-8');
    return parseEvent(raw, options.event);
  }
  return {};
}

export function parseEvent(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    // V8's `SyntaxError` quotes a window of the payload, so the message names
    // only the failure's offset and size; V8's text goes to `debug` only
    // (issue #5254).
    getLogger().debug(safeMsg`Event payload failed to parse: ${parseFailureDebugDetail(err)}`);
    throw new Error(
      `Failed to parse event payload from ${source} as JSON: ${describeJsonParseFailure(err, utf8ByteLength(raw))}`
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
