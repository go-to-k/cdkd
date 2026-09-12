import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { ConsoleLogger } from '../../../src/utils/logger.js';
import { renderLikeLogger } from '../../render-like-logger.js';

/**
 * `tests/render-like-logger.ts` mirrors the body of
 * `ConsoleLogger.formatMessage`, which is PRIVATE — so a suite that mocks the
 * logger wholesale (`tests/unit/cli/drift-per-resource-failure.test.ts`) can
 * only reproduce the rendering, never call it.
 *
 * A mirror goes stale in SILENCE. This one already did twice, both times
 * still returning a plausible string, so every assertion reading it stayed
 * green while testing something production does not do:
 *
 * 1. Issue [#3003](https://github.com/go-to-k/cdkd/issues/3003) added the
 *    `displaySafe` denylist to `formatMessage`; the mirror kept rendering raw.
 * 2. The first re-sync applied `displaySafe` PER ARG and exempted strings,
 *    where production applies it ONCE to the joined args and exempts nothing.
 *
 * The shapes below are exactly the ones those two spellings disagreed about,
 * plus the control-byte case the sanitiser exists for. This suite does NOT
 * mock `src/utils/logger.js`, which is what makes the comparison possible.
 */
describe('renderLikeLogger mirrors ConsoleLogger.formatMessage (issue #3003)', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The real logger's line, with the timestamp / level prefix removed. At
   * `debug` level `formatMessage` prepends `<ts> DEBUG ` (with ANSI colour),
   * and the mirror deliberately reproduces only the part after it.
   *
   * The ANSI strip is asymmetric, deliberately: it removes escapes from the
   * whole line, MESSAGE included, while `renderLikeLogger` sanitizes only the
   * args and passes the message through. No case here carries an
   * escape-bearing message; one would false-FAIL, which is the safe direction.
   */
  const realTail = (call: readonly unknown[]): string => {
    debugSpy.mockClear();
    new ConsoleLogger('debug').debug(...(call as [string, ...unknown[]]));
    const line = String(debugSpy.mock.calls[0]?.[0] ?? '');
    // eslint-disable-next-line no-control-regex
    const stripped = line.replace(/\u001b\[[0-9;]*m/g, '');
    const marker = ' DEBUG ';
    const at = stripped.indexOf(marker);
    return at === -1 ? stripped : stripped.slice(at + marker.length);
  };

  /**
   * The same line from the COMPACT arm -- a logger BELOW `debug` level, which
   * emits no timestamp and no level word, so the whole line is the tail.
   *
   * This arm needs its own cases because `formatMessage` re-splices
   * `formattedArgs` into each of its four returns. Sanitizing only inside the
   * verbose branch reddened ZERO cases, because every #3003 case built a
   * `debug`-level logger -- while the two live extra-arg call sites outside
   * debug (`src/cli/commands/destroy-runner.ts`'s two `logger.error(msg,
   * detail)`) run at the DEFAULT level, i.e. only through this arm.
   */
  const realCompact = (call: readonly unknown[]): string => {
    infoSpy.mockClear();
    new ConsoleLogger('info').info(...(call as [string, ...unknown[]]));
    const line = String(infoSpy.mock.calls[0]?.[0] ?? '');
    // eslint-disable-next-line no-control-regex
    return line.replace(/\u001b\[[0-9;]*m/g, '');
  };

  const CSI = String.fromCodePoint(0x9b);

  const CASES: ReadonlyArray<readonly [string, readonly unknown[]]> = [
    ['no extra args', ['plain message']],
    ['one object arg', ['Lock info:', { owner: 'ok' }]],
    // Production stringifies a string arg, so it renders QUOTED. The stale
    // mirror exempted strings and rendered it bare.
    ['a STRING extra arg', ['m', 'extra']],
    // `displaySafe` trims, and production applies it to the JOINED args -- so
    // an interior `undefined` collapses the double space the stale per-arg
    // mirror preserved.
    ['undefined between args', ['m', undefined, 1]],
    ['undefined as the last arg', ['m', 1, undefined]],
    ['undefined as the only arg', ['m', undefined]],
    ['several args', ['m', 1, { a: 2 }, 'three']],
    // The reason the sanitiser is there at all.
    ['a control byte inside an arg', ['Lock info:', { x: `${CSI}31mFAKE` }]],
    ['a benign non-ASCII value', ['Lock info:', { owner: 'José-café' }]],
  ];

  for (const [name, call] of CASES) {
    it(`renders the same line as the real logger: ${name}`, () => {
      expect(renderLikeLogger(call)).toBe(realTail(call));
    });

    it(`renders the same line in COMPACT mode: ${name}`, () => {
      expect(renderLikeLogger(call)).toBe(realCompact(call));
    });
  }

  /**
   * THROWING is behaviour the mirror has to reproduce, not an accident.
   *
   * `tests/unit/cli/drift-per-resource-failure.test.ts`'s
   * `expect(() => debugRendered()).not.toThrow()` is the ONLY mechanism
   * guarding the #2151 circular-error regression: that suite mocks the logger,
   * so production never stringifies there and the mirror is what stands in for
   * it. Wrapping the mirror's `JSON.stringify` in a `try`/`catch` reddened
   * ZERO cases before these two existed, which would have made the regression
   * uncatchable while the assertion still read as a guard.
   */
  describe('throws exactly where the real logger throws', () => {
    it('a cyclic argument', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;

      expect(() => renderLikeLogger(['m', cyclic])).toThrow(TypeError);
      expect(() => new ConsoleLogger('debug').debug('m', cyclic)).toThrow(TypeError);
    });

    it('a bigint argument', () => {
      expect(() => renderLikeLogger(['m', 1n])).toThrow(TypeError);
      expect(() => new ConsoleLogger('debug').debug('m', 1n)).toThrow(TypeError);
    });
  });
});
