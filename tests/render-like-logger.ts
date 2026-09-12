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
 * It is a mirror rather than a call into the real thing for a reason specific
 * to its CALLER, not an absolute one: `tests/unit/cli/drift-per-resource-failure.test.ts`
 * replaces `src/utils/logger.js` with a `vi.mock` factory that exports no
 * `ConsoleLogger`, so the class is unreachable from that suite. A suite that
 * does NOT mock the module can recover the line — `formatMessage` is private,
 * but spying on `console.debug` and slicing past the level prefix gets it, and
 * `logger-formatter-mirror.test.ts`'s `realTail` does exactly that. What it
 * costs is a spy plus a prefix strip per call, which is why the drift suite's
 * `debugRendered` helper reads this function instead -- one call site there,
 * feeding the three assertions that read the string it returns.
 *
 * A mirror goes stale in SILENCE, and this one already did. #3003 added the
 * sanitiser to production while the mirror kept rendering raw; the re-sync then
 * applied `displaySafe` PER ARG, keeping the string exemption it had inherited
 * from the pre-#3003 version, where production applies the sanitiser ONCE to
 * the joined args and exempts nothing. Both versions still returned a plausible
 * string, so every assertion reading it stayed green while testing something
 * production does not do. That is why
 * `tests/unit/utils/logger-formatter-mirror.test.ts` compares this function
 * against a REAL `ConsoleLogger` across the shapes the two spellings disagreed
 * on.
 */
export function renderLikeLogger(call: readonly unknown[]): string {
  const [message, ...args] = call;
  const formattedArgs =
    args.length > 0 ? ' ' + displaySafe(args.map((a) => JSON.stringify(a)).join(' ')) : '';
  return String(message) + formattedArgs;
}
