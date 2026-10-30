/**
 * Shared probes for the "a `JSON.parse` failure must not quote the body" cases
 * (issues go-to-k/cdkd#5247, go-to-k/cdkd#5254).
 *
 * `LEAK_BODY` is a body V8 QUOTES: its `Unexpected token` family embeds a
 * window of the input, and `LEAK_TOKEN` sits inside that window. Every case
 * first calls {@link expectV8QuotesLeakToken}, so a V8 that stopped quoting
 * fails loudly instead of leaving the absence assertions vacuous.
 */
import { expect } from 'vite-plus/test';

export const LEAK_TOKEN = 'hunter2';
export const LEAK_BODY = '{"password":hunter2SECRET,"x":1}';

/** UTF-8 bytes of `LEAK_BODY`, the size the rendered failure reports. */
export const LEAK_BODY_BYTES = Buffer.byteLength(LEAK_BODY, 'utf8');

/** Premise: V8's own parse error for `body` contains {@link LEAK_TOKEN}. */
export function expectV8QuotesLeakToken(body: string = LEAK_BODY): void {
  let v8: unknown;
  try {
    JSON.parse(body);
  } catch (e) {
    v8 = e;
  }
  expect((v8 as Error).message).toContain(LEAK_TOKEN);
}

/**
 * Every `name`, `message` and `stack` along an error's `cause` chain: what
 * `formatError`'s `Caused by:` line and the CLI's last-resort `util.inspect`
 * render.
 */
export function causeChainText(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    parts.push(e.name, e.message, String(e.stack));
  }
  return parts.join('\n');
}

/** Every argument of every call a logger spy received, joined. */
export function loggedText(fn: { mock: { calls: unknown[][] } }): string {
  return fn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

/**
 * V8's text is at `debug` and nowhere louder: a `debug` -> `warn` slip would
 * print it at default verbosity.
 */
export function expectLeakTokenOnlyAtDebug(logger: {
  debug: { mock: { calls: unknown[][] } };
  info: { mock: { calls: unknown[][] } };
  warn: { mock: { calls: unknown[][] } };
  error: { mock: { calls: unknown[][] } };
}): void {
  expect(loggedText(logger.debug)).toContain(LEAK_TOKEN);
  for (const fn of [logger.info, logger.warn, logger.error]) {
    expect(loggedText(fn)).not.toContain(LEAK_TOKEN);
  }
}
