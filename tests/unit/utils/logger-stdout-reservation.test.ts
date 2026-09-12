import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  ConsoleLogger,
  getLogger,
  isStdoutReservedForPayload,
  releaseStdoutForPayload,
  reserveStdoutForPayload,
} from '../../../src/utils/logger.js';

/**
 * Issue [#2230](https://github.com/go-to-k/cdkd/issues/2230): the stdout
 * reservation, fenced directly against the REAL `ConsoleLogger` rather than
 * through a command.
 *
 * This is where the half of the fix that `tests/unit/cli/drift-json-stream.test.ts`
 * cannot reach is pinned: the reservation exists precisely because prose reaches
 * stdout from modules a command's own file does not own — `applyRoleArnIfSet`'s
 * `Assumed role ...` line (`src/utils/role-arn.ts:286`) and
 * `S3StateBackend.saveState`'s legacy-migration notice
 * (`src/state/s3-state-backend.ts:448`) both fire on the `cdkd drift --json`
 * path through a `child()` logger. The child case below is the one that says
 * those lines are covered; a per-call-site fix in `drift.ts` could not move them
 * at all.
 *
 * The assertions read the CONSOLE METHOD, not a captured stream: `console.info`
 * / `console.debug` go to fd 1 and `console.warn` / `console.error` to fd 2 by
 * Node's own contract, and (measured on this toolchain) Vitest intercepts
 * `console` so the stream methods see nothing at all.
 */
describe('ConsoleLogger stdout reservation (issue #2230)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    releaseStdoutForPayload();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('defaults to stdout for info and debug', () => {
    expect(isStdoutReservedForPayload()).toBe(false);

    const logger = new ConsoleLogger('debug', false);
    logger.info('an info line');
    logger.debug('a debug line');
    logger.warn('a warn line');
    logger.error('an error line');

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('routes info and debug to stderr once stdout is reserved', () => {
    const logger = new ConsoleLogger('debug', false);
    reserveStdoutForPayload();
    expect(isStdoutReservedForPayload()).toBe(true);

    logger.info('an info line');
    logger.debug('a debug line');

    // Nothing on fd 1 at all.
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    // MOVED, not dropped -- the operator still sees both lines. Asserting the
    // rendered TEXT rather than just the call count, because "did not reach
    // stdout" is also true of a line that was swallowed. At `debug` level the
    // logger renders its verbose form (timestamp + padded level), so the level
    // is pinned alongside the message and only the timestamp is left loose.
    const lines = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ INFO {2}an info line$/);
    expect(lines[1]).toMatch(/ DEBUG a debug line$/);
  });

  it('leaves warn and error on stderr unchanged', () => {
    const logger = new ConsoleLogger('debug', false);
    reserveStdoutForPayload();

    logger.warn('a warn line');
    logger.error('an error line');

    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      expect.stringMatching(/ WARN {2}a warn line$/),
    ]);
    expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      expect.stringMatching(/ ERROR an error line$/),
    ]);
  });

  /**
   * The case a per-call-site fix inside `drift.ts` structurally cannot reach.
   * `child()` returns a FRESH logger instance, so an instance field would leave
   * every helper module's logger on stdout; the flag is module-level for exactly
   * this reason.
   */
  it('a child logger created by a helper module inherits the reservation', () => {
    const child = getLogger().child('role-arn');
    reserveStdoutForPayload();

    child.info('Assumed role arn:aws:iam::111122223333:role/x (session expires ...)');

    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'Assumed role arn:aws:iam::111122223333:role/x (session expires ...)',
    ]);
  });

  it('releasing the reservation puts info back on stdout', () => {
    const logger = new ConsoleLogger('info', false);
    reserveStdoutForPayload();
    releaseStdoutForPayload();
    expect(isStdoutReservedForPayload()).toBe(false);

    logger.info('an info line');

    expect(infoSpy.mock.calls.map((c: unknown[]) => c[0])).toEqual(['an info line']);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

/**
 * Issue [#3003](https://github.com/go-to-k/cdkd/issues/3003): an EXTRA logger
 * argument reaches the terminal through `JSON.stringify`, which is not a
 * terminal-safety boundary.
 *
 * The live caller is `LockManager.getLockRecord`, which logs the parsed
 * `lock.json` as an extra arg. That object is an unchecked cast of a file
 * anyone with `s3:PutObject` on the state bucket can write, and only its
 * `owner` and `operation` are sanitized -- so any OTHER key carried whatever
 * bytes the attacker put there. `cdkd state show --verbose` renders it.
 *
 * The fixture is deliberately split by escape class, because the two halves
 * fail for opposite reasons and a single case cannot say which one regressed:
 * `JSON.stringify` already escapes C0 (so `\n` was never the hole), while
 * `U+0085`, the C1 range and `U+2028`/`U+2029` pass through it untouched.
 */
describe('ConsoleLogger sanitizes EXTRA arguments (issue #3003)', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rendered = (): string => (debugSpy.mock.calls[0]?.[0] as string) ?? '';

  it('strips the escapes `JSON.stringify` passes through', () => {
    const logger = new ConsoleLogger('debug');

    // U+009B is CSI in a UTF-8 terminal, U+0085 is NEL, U+2028 is a line
    // separator to every JSON and web log viewer that re-renders this text.
    logger.debug('Lock info:', { owner: 'ok', x: '\u009b31mFAKE', y: 'a\u0085b', z: 'c\u2028d' });

    expect(rendered()).not.toMatch(/[\u0085\u009b\u2028\u2029]/);
    // Removal, not censorship -- the surrounding text still reads.
    expect(rendered()).toContain('31mFAKE');
    expect(rendered()).toContain('owner');
  });

  it('leaves an ordinary extra argument intact', () => {
    const logger = new ConsoleLogger('debug');

    logger.debug('Lock info:', { owner: 'user@host:123', operation: 'deploy' });

    expect(rendered()).toContain('"owner":"user@host:123"');
    expect(rendered()).toContain('"operation":"deploy"');
  });
});
