import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #2118 — the mirror of issue #1348 at the other end of the lock's life.
 *
 * `#1348` pinned that every lock-taking command registers its SIGINT handler
 * BEFORE acquiring the stack lock. `rollbackCommand`'s `finally` did the
 * opposite at the release end: it ran `unforwardSigterm()` and
 * `removeListener('SIGINT', ...)` FIRST and released the lock LAST. Between
 * those the process held the lock with ZERO SIGINT listeners, so a Ctrl-C
 * landing in the release round-trip took Node's default terminate — the
 * release never completed and the lock sat for its full 30-minute TTL,
 * blocking the next `cdkd rollback` / `deploy` / `destroy` on that stack.
 *
 * `destroy-runner.ts` states the rule these pin, and
 * `destroy-runner-lock-release-ordering.test.ts` is this file's twin:
 * "Release FIRST, remove the listener LAST: while the release round-trip is in
 * flight the handler stays armed."
 *
 * The SIGTERM half is not a second spelling of the SIGINT one, and the reason
 * is narrower than an earlier draft of this file claimed. It is NOT that the
 * order within the teardown pair matters — the two calls are adjacent and
 * synchronous, so no signal can land between them, and `unforwardSigterm()`
 * first would not empty the SIGINT set anyway (`sigintHandler` is still
 * registered at that point). What the SIGTERM case pins is that
 * `unforwardSigterm()` does not run BEFORE THE RELEASE: CI cancellation
 * delivers SIGTERM rather than Ctrl-C, and with the forwarder already gone that
 * signal takes the default terminate with the lock still held — the same
 * stranded lock through a different signal. A fix that reordered only the
 * SIGINT half would pass the case above and fail this one.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

const replayProvider = {
  delete: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue({ physicalId: 'p' }),
};
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: replayProvider }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));

// Matching `destroy-runner-lock-release-ordering.test.ts`. Without it each case
// leaves the process-global client set pointing at this file's stub `{}` —
// contained by per-file isolation today, but a real cross-test hazard the twin
// already declines to take.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({})),
}));

vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../../../src/provisioning/resource-name.js', () => ({
  withStackName: (_name: string, fn: () => unknown) => fn(),
}));

const setupMock = vi.fn();
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return {
    ...actual,
    setupStateBackend: (...args: unknown[]) => setupMock(...args),
  };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';

const REGION = 'us-east-1';
const STACK = 'S';

interface Observation {
  sigint: readonly unknown[];
  sigterm: readonly unknown[];
}

/**
 * Drive `rollbackCommand` far enough to reach the lock release, capturing the
 * signal listeners installed at the moment `releaseLock` is ENTERED.
 *
 * The "stack has no journal" throw happens INSIDE the try whose `finally` owns
 * the release, so it reaches the exact block under test with the least
 * scaffolding. `releaseLock` is the only observation point that sees the window
 * the defect lives in.
 */
function installSetup(
  releaseLock: ReturnType<typeof vi.fn>,
  acquireLockWithRetry: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): void {
  setupMock.mockResolvedValue({
    stateBackend: {
      listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({ state: { resources: {}, outputs: {} }, etag: 'e' }),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      saveState: vi.fn().mockResolvedValue('etag-1'),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry,
      releaseLock,
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

/** A `releaseLock` that records the listener sets live at the moment it runs. */
function observingRelease(): {
  releaseLock: ReturnType<typeof vi.fn>;
  observed: () => Observation;
} {
  let observed: Observation = { sigint: [], sigterm: [] };
  const releaseLock = vi.fn().mockImplementation(() => {
    observed = {
      sigint: [...process.listeners('SIGINT')],
      sigterm: [...process.listeners('SIGTERM')],
    };
    return Promise.resolve(undefined);
  });
  return { releaseLock, observed: () => observed };
}

/**
 * A setup whose stack has a real journal, so the command REPLAYS and returns
 * cleanly instead of throwing. Needed for two things the throw path cannot
 * reach: the ordering on the success path, and what a signal arriving during
 * the release actually does to the command's exit.
 */
function installReplayableSetup(releaseLock: ReturnType<typeof vi.fn>): void {
  setupMock.mockResolvedValue({
    stateBackend: {
      listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: STACK,
          region: REGION,
          resources: {
            Bucket: {
              physicalId: 'phys-Bucket',
              resourceType: 'AWS::S3::Bucket',
              properties: {},
              attributes: {},
              dependencies: [],
            },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: STACK,
        region: REGION,
        segments: [
          {
            timestamp: 1,
            reason: 'no-rollback-failure',
            initialDeploy: false,
            operations: [
              {
                logicalId: 'Bucket',
                changeType: 'CREATE',
                resourceType: 'AWS::S3::Bucket',
                physicalId: 'phys-Bucket',
              },
            ],
          },
        ],
      }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock,
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

const baseOpts = { statePrefix: 'cdkd', verbose: false, force: true };

describe('rollbackCommand releases the lock BEFORE unregistering its signal handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps its SIGINT handler armed for the whole release round-trip', async () => {
    // THE fence for the SIGINT half. Pre-fix this count equalled `before` —
    // the handler was already gone while the lock was still held, which is the
    // window a Ctrl-C stranded the lock in.
    const before = process.listeners('SIGINT');
    const { releaseLock, observed } = observingRelease();
    installSetup(releaseLock);

    await expect(rollbackCommand(STACK, { ...baseOpts })).rejects.toThrow(/Nothing to roll back/);

    expect(releaseLock).toHaveBeenCalledOnce();
    expect(observed().sigint.length).toBe(before.length + 1);
  });

  it('keeps the #1342 SIGTERM forwarder armed for the whole release round-trip', async () => {
    // THE fence for the ordering WITHIN the teardown pair. A fix that released
    // first but still called `unforwardSigterm()` before the release would pass
    // the SIGINT case above and fail this one: CI cancellation delivers SIGTERM,
    // and with the forwarder gone it takes the default terminate with the lock
    // still held — the same stranded lock through a different signal.
    const before = process.listeners('SIGTERM');
    const { releaseLock, observed } = observingRelease();
    installSetup(releaseLock);

    await expect(rollbackCommand(STACK, { ...baseOpts })).rejects.toThrow(/Nothing to roll back/);

    expect(observed().sigterm.length).toBe(before.length + 1);
  });

  it('...and removes BOTH once the release has resolved', async () => {
    // The other half: keeping them armed must not mean leaking them. A leaked
    // SIGINT listener would also stop the shared interrupt watch from ever
    // being the last listener, silently disabling its force-quit.
    const sigintBefore = process.listeners('SIGINT');
    const sigtermBefore = process.listeners('SIGTERM');
    const { releaseLock } = observingRelease();
    installSetup(releaseLock);

    await expect(rollbackCommand(STACK, { ...baseOpts })).rejects.toThrow(/Nothing to roll back/);

    expect(process.listeners('SIGINT')).toEqual(sigintBefore);
    expect(process.listeners('SIGTERM')).toEqual(sigtermBefore);
  });

  it('removes both even when the release throws SYNCHRONOUSLY', async () => {
    // The `.catch()` on the release covers a REJECTION, not a synchronous
    // throw, so without the inner `finally` a throwing release leaks both
    // listeners for the rest of the process — and this path is exactly where
    // the handlers matter, since the lock's fate is already uncertain.
    const sigintBefore = process.listeners('SIGINT');
    const sigtermBefore = process.listeners('SIGTERM');
    const releaseLock = vi.fn().mockImplementation(() => {
      throw new Error('lock manager exploded');
    });
    installSetup(releaseLock);

    await expect(rollbackCommand(STACK, { ...baseOpts })).rejects.toThrow(
      'lock manager exploded'
    );

    expect(process.listeners('SIGINT')).toEqual(sigintBefore);
    expect(process.listeners('SIGTERM')).toEqual(sigtermBefore);
  });

  it('holds the same ordering on the SUCCESS path, where a journal is replayed', async () => {
    // Every case above reaches the `finally` through the "Nothing to roll back"
    // throw. That is the same block, but the replay is the only path on which
    // the provider-side interrupt watch is ever armed -- so an ordering that
    // held only for the throw path would fence the cheaper half of the defect.
    const before = process.listeners('SIGINT');
    const { releaseLock, observed } = observingRelease();
    installReplayableSetup(releaseLock);

    await expect(rollbackCommand(STACK, { ...baseOpts })).resolves.toBeUndefined();

    expect(replayProvider.delete).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(observed().sigint.length).toBe(before.length + 1);
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('DELIBERATE: a Ctrl-C landing during the release does not fail the rollback', async () => {
    // Recording an accepted consequence rather than a gap, because the fix
    // CREATED it and the twin command resolved the same question the other way.
    //
    // Keeping the handler armed across the release moves the window a signal
    // can arrive in -- the round-4 regression `destroy-runner.ts` hit, where the
    // late flip left `result.interrupted` false and `destroy --all` went on to
    // delete the next stack. `rollback` has no such consumer: `interrupted` is
    // read only INSIDE the try (the loop guard and the PartialFailureError at
    // the end), `rollbackCommand` returns void, and its one call site is
    // `withErrorHandling`. So a signal this late is swallowed, and that is the
    // right answer here: every operation has already replayed, the journal is
    // popped and the state is saved, so turning it into a partial failure would
    // report exit 2 for a rollback that fully succeeded.
    //
    // What this case exists to stop is a later change quietly making that a
    // PartialFailureError because the destroy-runner precedent looks binding.
    const releaseLock = vi.fn().mockImplementation(() => {
      // Fire only the listeners live at this moment -- the command's own
      // handler among them -- so the harness's own SIGINT handling is untouched.
      for (const listener of process.listeners('SIGINT')) {
        (listener as unknown as () => void)();
      }
      return Promise.resolve(undefined);
    });
    installReplayableSetup(releaseLock);

    await expect(rollbackCommand(STACK, { ...baseOpts })).resolves.toBeUndefined();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('INVERTED CONTROL — the acquire-failure path releases nothing and still leaks nothing', async () => {
    // Without this the cases above pass for a `finally` that unregisters
    // unconditionally at the top of the command: the acquire-failure catch is a
    // DIFFERENT teardown site (no lock is held there, so there is nothing to
    // release), and it must keep cleaning up on its own.
    const sigintBefore = process.listeners('SIGINT');
    const sigtermBefore = process.listeners('SIGTERM');
    const { releaseLock } = observingRelease();
    installSetup(
      releaseLock,
      vi.fn().mockRejectedValue(new Error('lock is held by another run'))
    );

    await expect(rollbackCommand(STACK, { ...baseOpts })).rejects.toThrow(
      'lock is held by another run'
    );

    expect(releaseLock).not.toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(sigintBefore);
    expect(process.listeners('SIGTERM')).toEqual(sigtermBefore);
  });
});
