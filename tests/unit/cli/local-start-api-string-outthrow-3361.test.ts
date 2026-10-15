import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/local-start-api.ts` slice: three handlers rendered the
 * value they received with a bare `String()`, which throws for a
 * null-prototype object (`TypeError: Cannot convert object to primitive
 * value`).
 *
 * - the `uncaughtException` listener: a throw from inside it ends the process
 *   without the shutdown that removes the warm containers and the profile
 *   credentials tmpdir;
 * - the `unhandledRejection` listener: the original rejection was replaced by
 *   the converter's `TypeError`;
 * - the `--watch` reload's synth catch: the "keeping previous version" warning
 *   was lost, because the reload chain swallows the rejection.
 *
 * Each case passes exactly that value and asserts the degradation still
 * happens (shutdown is called, the reload resolves without swapping) AND the
 * placeholder is rendered, so a fix that dropped the report would not pass.
 */

const { installFatalShutdownHandlers, reloadAllServers } =
  await import('../../../src/cli/commands/local-start-api.js');

type ReloadArgs = Parameters<typeof reloadAllServers>[0];

/** What `safeStringify` / `describeAwsFailure(x).detail` render for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A value whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

type FatalEvent = 'uncaughtException' | 'unhandledRejection';

const installed: Array<{ event: FatalEvent; listener: (...args: unknown[]) => void }> = [];

/**
 * Install the handlers and return the listener each one added, so a case
 * calls the REAL listener without raising a real process-level event (the
 * test runner has listeners of its own on both).
 */
function install(): {
  error: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  listener: (event: FatalEvent) => (...args: unknown[]) => void;
} {
  const before = {
    uncaughtException: new Set(process.listeners('uncaughtException')),
    unhandledRejection: new Set(process.listeners('unhandledRejection')),
  };
  const error = vi.fn();
  const shutdown = vi.fn(async () => undefined);
  installFatalShutdownHandlers({ error }, shutdown);
  const added = (event: FatalEvent): Array<(...args: unknown[]) => void> =>
    (process.listeners(event) as Array<(...args: unknown[]) => void>).filter(
      (l) => !before[event].has(l as never)
    );
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    for (const listener of added(event)) installed.push({ event, listener });
  }
  return {
    error,
    shutdown,
    listener: (event) => {
      const found = added(event);
      expect(found).toHaveLength(1);
      return found[0]!;
    },
  };
}

afterEach(() => {
  for (const { event, listener } of installed.splice(0)) process.off(event, listener);
});

describe('cdkd local start-api fatal-event handlers (#3361)', () => {
  it('an uncaught exception that cannot be converted to text still reaches the shutdown', () => {
    const { error, shutdown, listener } = install();

    expect(() => listener('uncaughtException')(unconvertible(), 'uncaughtException')).not.toThrow();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith('uncaughtException', 1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(`Uncaught exception: ${PLACEHOLDER}`);
  });

  it('an unhandled rejection that cannot be converted to text still reaches the shutdown', () => {
    const { error, shutdown, listener } = install();

    expect(() =>
      listener('unhandledRejection')(unconvertible(), Promise.resolve())
    ).not.toThrow();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith('unhandledRejection', 1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(`Unhandled rejection: ${PLACEHOLDER}`);
  });

  it('keeps the stack of an Error and the text of a convertible value unchanged', () => {
    const { error, listener } = install();
    const err = new Error('boom');

    listener('uncaughtException')(err, 'uncaughtException');
    listener('unhandledRejection')('plain reason', Promise.resolve());

    expect(error.mock.calls).toEqual([
      [`Uncaught exception: ${err.stack}`],
      ['Unhandled rejection: plain reason'],
    ]);
  });
});

describe('cdkd local start-api --watch reload (#3361)', () => {
  /** Run a reload whose re-synth rejects with `reason`; return what it touched. */
  async function reloadRejectingWith(reason: unknown): Promise<{
    warn: ReturnType<typeof vi.fn>;
    buildPool: ReturnType<typeof vi.fn>;
    setServerState: ReturnType<typeof vi.fn>;
  }> {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const buildPool = vi.fn();
    const setServerState = vi.fn();
    const booted = {
      group: { serverKey: 'api', displayName: 'Api', routes: [] },
      server: { setServerState },
    } as unknown as ReloadArgs['servers'][number];

    await expect(
      reloadAllServers({
        synthesizeAndBuild: () => Promise.reject(reason),
        servers: [booted],
        buildPool: buildPool as unknown as ReloadArgs['buildPool'],
        logger: logger as unknown as ReloadArgs['logger'],
      })
    ).resolves.toBeUndefined();
    return { warn: logger.warn, buildPool, setServerState };
  }

  it('keeps the previous version and reports it when the re-synth rejects with an unconvertible value', async () => {
    const { warn, buildPool, setServerState } = await reloadRejectingWith(unconvertible());

    expect(buildPool).not.toHaveBeenCalled();
    expect(setServerState).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `cdk synth failed during reload; keeping previous version. (${PLACEHOLDER})`
    );
  });

  it("keeps an AWS-authored Error's own message verbatim in the warning", async () => {
    // An SDK-shaped error: `describeAwsFailure` would REDACT it in `.summary`,
    // so this pins that the warning still takes `.detail`, the raw message.
    const err = Object.assign(new Error('Stack [cdkd-macro] does not exist'), {
      name: 'ValidationError',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });

    const { warn } = await reloadRejectingWith(err);

    expect(warn).toHaveBeenCalledWith(
      'cdk synth failed during reload; keeping previous version. (Stack [cdkd-macro] does not exist)'
    );
  });
});
