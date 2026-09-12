import { displaySafe } from '../src/utils/display-safe.js';

/**
 * A MIRROR of `ConsoleLogger.formatMessage`'s body, minus the timestamp / level
 * prefix.
 *
 * A suite that mocks `src/utils/logger.js` wholesale can only see the arguments
 * a call RECORDED, never what the real logger would have printed from them —
 * and the two differ in ways that matter. `JSON.stringify` renders an Error as
 * `{}`, because `message` / `stack` are non-enumerable; it THROWS on a cyclic
 * object, which is a `--verbose` crash in production; and since issue
 * [#3003](https://github.com/go-to-k/cdkd/issues/3003) the joined result is run
 * through the `displaySafe` denylist, so a control byte in a logged record is
 * flattened before it reaches a terminal.
 *
 * It is a mirror, and not a call into the real thing, because
 * `formatMessage` is PRIVATE — there is no way to hand `ConsoleLogger` a
 * recorded call and ask for the line it would print.
 *
 * A mirror goes stale in SILENCE, and this one already did: #3003 added the
 * sanitiser to production and the mirror kept rendering raw, and the first
 * attempt to re-sync applied `displaySafe` PER ARG and exempted strings, where
 * production applies it ONCE to the joined args and exempts nothing. Both
 * versions still returned a plausible string, so every assertion reading it
 * stayed green while testing something production does not do. That is why
 * `tests/unit/utils/logger-formatter-mirror.test.ts` compares this function
 * against a REAL `ConsoleLogger` across the shapes the two spellings disagreed
 * on — it lives in a suite that does NOT mock the logger, which is the whole
 * reason the fence can exist at all.
 */
export function renderLikeLogger(call: readonly unknown[]): string {
  const [message, ...args] = call;
  const formattedArgs =
    args.length > 0 ? ' ' + displaySafe(args.map((a) => JSON.stringify(a)).join(' ')) : '';
  return String(message) + formattedArgs;
}
