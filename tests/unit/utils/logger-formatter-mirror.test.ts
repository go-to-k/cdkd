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
  // Keyed by the ARM's own `emit` union, not `string`: `tsconfig.test.json`
  // sets `noUncheckedIndexedAccess: false`, so a `Record<string, ...>` would
  // let an arm name a real `ConsoleLogger` method with no spy here
  // (`setLevel`, `child`) and type-check, then crash at `mockClear()`.
  let spies: Record<(typeof ARMS)[number]['emit'], ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    spies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * One entry per `return` in `formatMessage`. There are SIX, and each splices
   * `${formattedArgs}` in separately, so a change confined to one is invisible
   * to every case driving another -- measured: deleting `${formattedArgs}`
   * from the compact `error` and `warn` returns reddened ZERO while nine cases
   * drove the verbose arm and nine more drove the compact PLAIN one.
   *
   * `level` selects the verbose (`debug`) or compact branch; `useColors` splits
   * each of those; and within compact-with-colours the emitted LEVEL picks
   * between the red `error`, yellow `warn` and uncoloured returns.
   *
   * The two live extra-arg call sites outside the verbose arm --
   * `src/cli/commands/destroy-runner.ts`'s two `logger.error(msg, detail)` --
   * run through the GLOBAL logger, so which arm they take depends on the flag:
   * at the default level they are compact-with-colours-and-`error`, and under
   * `cdkd destroy --verbose` (`destroy.ts` calls `logger.setLevel('debug')` on
   * that same object) they move to the verbose-colour arm. Both are in `ARMS`,
   * which is the point of enumerating the returns rather than picking one.
   */
  const ARMS = [
    { name: 'verbose, colours', loggerLevel: 'debug', emit: 'debug', colors: true },
    { name: 'verbose, no colours', loggerLevel: 'debug', emit: 'debug', colors: false },
    { name: 'compact, colours, error', loggerLevel: 'info', emit: 'error', colors: true },
    { name: 'compact, colours, warn', loggerLevel: 'info', emit: 'warn', colors: true },
    { name: 'compact, colours, info', loggerLevel: 'info', emit: 'info', colors: true },
    { name: 'compact, no colours', loggerLevel: 'info', emit: 'info', colors: false },
  ] as const;

  /**
   * The real logger's line for one arm, reduced to the part the mirror claims
   * to reproduce: ANSI removed, and the verbose arm's `<ts> LEVEL ` prefix
   * sliced off.
   *
   * The ANSI strip is asymmetric, deliberately: it removes escapes from the
   * whole line, MESSAGE included, while `renderLikeLogger` sanitizes only the
   * args and passes the message through. No case here carries an
   * escape-bearing message; one would false-FAIL, which is the safe direction.
   */
  const realLine = (arm: (typeof ARMS)[number], call: readonly unknown[]): string => {
    const spy = spies[arm.emit];
    spy.mockClear();
    const logger = new ConsoleLogger(arm.loggerLevel, arm.colors);
    (logger[arm.emit] as (m: string, ...a: unknown[]) => void)(
      ...(call as [string, ...unknown[]])
    );
    // Exactly one line, so a routing change (the stdout reservation sends
    // `info` to `console.error`) fails loudly instead of comparing against ''.
    expect(spy.mock.calls).toHaveLength(1);
    // eslint-disable-next-line no-control-regex
    const stripped = String(spy.mock.calls[0][0]).replace(/\u001b\[[0-9;]*m/g, '');
    if (arm.loggerLevel !== 'debug') return stripped;
    const marker = ` ${arm.emit.toUpperCase().padEnd(5)} `;
    const at = stripped.indexOf(marker);
    return at === -1 ? stripped : stripped.slice(at + marker.length);
  };

  const CSI = String.fromCodePoint(0x9b);

  /**
   * The shapes the mirror's two stale spellings disagreed with production
   * about, plus the control byte the sanitiser exists for.
   *
   * `undefined as the only arg` is deliberately kept even though it can never
   * discriminate the sanitiser -- `[undefined].join(' ')` is already `''` --
   * because it DOES discriminate the `args.length > 0` guard and the separator.
   */
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

  for (const arm of ARMS) {
    describe(`${arm.name}`, () => {
      for (const [name, call] of CASES) {
        it(`renders the same line as the real logger: ${name}`, () => {
          expect(renderLikeLogger(call)).toBe(realLine(arm, call));
        });
      }
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
