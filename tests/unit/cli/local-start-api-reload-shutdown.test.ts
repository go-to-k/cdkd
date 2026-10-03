import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue #4495: a `--watch` reload of `cdkd local start-api` swaps a new
 * container pool in and disposes the previous one in the background. The ^C
 * cleanup disposes only the pools the servers hold, then exits, so it must be
 * able to await the swapped-out pool's dispose, and a reload whose re-synth
 * outlasts the ^C must swap in no pool the cleanup has already passed by.
 */

vi.mock('../../../src/local/api-server-grouping.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  groupRoutesByServer: (): unknown[] => [
    { serverKey: 'api', displayName: 'Api', routes: [] },
  ],
}));

const { reloadAllServers } = await import('../../../src/cli/commands/local-start-api.js');

type ReloadArgs = Parameters<typeof reloadAllServers>[0];

function fakePool(dispose: () => Promise<void>): { dispose: () => Promise<void> } {
  return { dispose: vi.fn(dispose) };
}

function fakeServer(initialPool: unknown): {
  booted: ReloadArgs['servers'][number];
  current: () => unknown;
} {
  let state = { routes: [], pool: initialPool, corsConfigByApiId: new Map() };
  const server = {
    host: '127.0.0.1',
    port: 3000,
    scheme: 'http',
    getServerState: () => state,
    setServerState: (next: typeof state) => {
      const prev = state;
      state = next;
      return prev;
    },
  };
  return {
    booted: {
      group: { serverKey: 'api', displayName: 'Api', routes: [] },
      server,
    } as unknown as ReloadArgs['servers'][number],
    current: () => state.pool,
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
const material = { routes: [], specs: new Map(), corsConfigByApiId: new Map() };

let realWrite: typeof process.stdout.write;
beforeEach(() => {
  realWrite = process.stdout.write;
  (process.stdout as unknown as { write: () => boolean }).write = () => true;
});
afterEach(() => {
  (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
});

describe('reloadAllServers and shutdown (issue #4495)', () => {
  it("hands the swapped-out pool's dispose to shutdown until it finishes", async () => {
    let finishDispose!: () => void;
    const oldPool = fakePool(
      () =>
        new Promise<void>((r) => {
          finishDispose = r;
        })
    );
    const newPool = fakePool(async () => undefined);
    const { booted, current } = fakeServer(oldPool);
    const retiredPoolDisposals = new Set<Promise<void>>();

    await reloadAllServers({
      synthesizeAndBuild: async () => material as never,
      servers: [booted],
      buildPool: () => newPool as never,
      logger: logger as never,
      isClosing: () => false,
      retiredPoolDisposals,
    });

    expect(current()).toBe(newPool);
    expect(oldPool.dispose).toHaveBeenCalledTimes(1);
    // Still draining: shutdown has it to await.
    expect(retiredPoolDisposals.size).toBe(1);

    finishDispose();
    await Promise.all([...retiredPoolDisposals]);
    await new Promise((r) => setImmediate(r));
    expect(retiredPoolDisposals.size).toBe(0);
  });

  it('a failed dispose of the swapped-out pool still leaves the set', async () => {
    let failDispose!: (err: Error) => void;
    const oldPool = fakePool(
      () =>
        new Promise<void>((_, reject) => {
          failDispose = reject;
        })
    );
    const { booted } = fakeServer(oldPool);
    const retiredPoolDisposals = new Set<Promise<void>>();

    await reloadAllServers({
      synthesizeAndBuild: async () => material as never,
      servers: [booted],
      buildPool: () => fakePool(async () => undefined) as never,
      logger: logger as never,
      isClosing: () => false,
      retiredPoolDisposals,
    });
    expect(retiredPoolDisposals.size).toBe(1);
    failDispose(new Error('cdkd-unit-dispose-failure'));
    // Awaiting it never rejects, so shutdown's wait cannot end early on it.
    await expect(Promise.all([...retiredPoolDisposals])).resolves.toBeDefined();
    await new Promise((r) => setImmediate(r));
    expect(retiredPoolDisposals.size).toBe(0);
  });

  it('shutdown began during the re-synth: the reload swaps nothing and builds no pool', async () => {
    let closing = false;
    const oldPool = fakePool(async () => undefined);
    const buildPool = vi.fn(() => fakePool(async () => undefined) as never);
    const { booted, current } = fakeServer(oldPool);
    const retiredPoolDisposals = new Set<Promise<void>>();

    await reloadAllServers({
      synthesizeAndBuild: async () => {
        closing = true; // the ^C lands while the app re-synthesizes
        return material as never;
      },
      servers: [booted],
      buildPool,
      logger: logger as never,
      isClosing: () => closing,
      retiredPoolDisposals,
    });

    expect(buildPool).not.toHaveBeenCalled();
    expect(current()).toBe(oldPool);
    expect(oldPool.dispose).not.toHaveBeenCalled();
    expect(retiredPoolDisposals.size).toBe(0);
  });
});
