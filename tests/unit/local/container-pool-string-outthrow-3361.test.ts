import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/local/container-pool.ts` slice: the teardown handlers stringified their
 * caught value with `x instanceof Error ? x.message : String(x)`, and
 * `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value` -- so the handler threw
 * from inside itself and the cleanup it was degrading stopped.
 *
 * Each case rejects (or throws) with exactly that value and asserts the
 * DEGRADATION still happens (the container is removed, `dispose()` resolves and
 * tears down the warm handles), never merely "it did not throw". The
 * placeholder is asserted too, so a fix that swallowed the failure without
 * reporting it would not pass.
 */

const debugSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

const mocks = vi.hoisted(() => ({
  runDetached: vi.fn(async (_args: unknown): Promise<string> => 'cid-warm'),
  removeContainer: vi.fn(async (_id: string): Promise<void> => undefined),
  pickFreePort: vi.fn(async (): Promise<number> => 18000),
  streamLogs: vi.fn((_id: string) => (): void => undefined),
}));

vi.mock('../../../src/local/docker-runner.js', () => mocks);

vi.mock('../../../src/local/rie-client.js', () => ({
  waitForRieReady: vi.fn(async (): Promise<void> => undefined),
}));

import { createContainerPool, type ContainerSpec } from '../../../src/local/container-pool.js';
import type { ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A value whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const debugs = (): string[] => debugSpy.mock.calls.map((c) => String(c[0]));
const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

function fakeSpec(logicalId: string): ContainerSpec {
  return {
    kind: 'zip',
    lambda: {
      kind: 'zip',
      stack: {} as unknown as StackInfo,
      logicalId,
      resource: {} as never,
      runtime: 'nodejs20.x',
      handler: 'index.handler',
      memoryMb: 128,
      timeoutSec: 3,
      codePath: '/tmp/code',
      layers: [],
      architecture: 'x86_64',
    } as ResolvedZipLambda,
    codeDir: '/tmp/code',
    platform: 'linux/amd64',
    env: {},
    containerHost: '127.0.0.1',
  };
}

describe('container pool teardown with an unconvertible failure (#3361)', () => {
  beforeEach(() => {
    debugSpy.mockReset();
    warnSpy.mockReset();
    mocks.runDetached.mockReset();
    mocks.runDetached.mockImplementation(async () => 'cid-warm');
    mocks.removeContainer.mockReset();
    mocks.removeContainer.mockImplementation(async () => undefined);
    mocks.streamLogs.mockReset();
    mocks.streamLogs.mockImplementation(() => (): void => undefined);
  });

  it('still removes the container when stopping its log stream throws one', async () => {
    mocks.streamLogs.mockImplementation(() => (): void => {
      throw unconvertible();
    });
    const pool = createContainerPool(new Map([['L', fakeSpec('L')]]), {
      perLambdaConcurrency: 1,
    });
    pool.release(await pool.acquire('L'));

    await pool.dispose();

    expect(mocks.removeContainer).toHaveBeenCalledWith('cid-warm');
    expect(debugs().some((m) => m.includes(`failed: ${PLACEHOLDER}`))).toBe(true);
  });

  it('reports a container removal that rejects with one', async () => {
    mocks.removeContainer.mockImplementation(async () => {
      throw unconvertible();
    });
    const pool = createContainerPool(new Map([['L', fakeSpec('L')]]), {
      perLambdaConcurrency: 1,
      streamLogs: false,
    });
    pool.release(await pool.acquire('L'));

    await expect(pool.dispose()).resolves.toBeUndefined();

    expect(
      warnings().some((m) => m.includes(`: ${PLACEHOLDER}. Continuing cleanup.`)),
      warnings().join('\n')
    ).toBe(true);
  });

  it('still tears down the warm containers when an in-flight start rejects with one', async () => {
    const pool = createContainerPool(
      new Map([
        ['Warm', fakeSpec('Warm')],
        ['Cold', fakeSpec('Cold')],
      ]),
      { perLambdaConcurrency: 1, streamLogs: false }
    );
    pool.release(await pool.acquire('Warm'));

    let rejectRun!: (value: unknown) => void;
    mocks.runDetached.mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectRun = reject;
        })
    );
    // The start's own rejection is the value under test, not this case's subject.
    const coldAcquire = pool.acquire('Cold').catch(() => undefined);
    await vi.waitFor(() => expect(mocks.runDetached).toHaveBeenCalledTimes(2));

    const disposed = pool.dispose();
    rejectRun(unconvertible());

    await expect(disposed).resolves.toBeUndefined();
    await coldAcquire;
    expect(mocks.removeContainer).toHaveBeenCalledWith('cid-warm');
    expect(debugs()).toContain(`In-flight startOne rejected during dispose: ${PLACEHOLDER}`);
  });
});
