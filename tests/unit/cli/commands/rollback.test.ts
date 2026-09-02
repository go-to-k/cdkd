import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../../stdin-tty.js';

vi.mock('../../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn(), child: () => l };
  return { getLogger: () => l };
});

vi.mock('../../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

// A ProviderRegistry stub whose getProviderFor returns a shared spyable
// provider so the replay path (CREATE delete / UPDATE update) can be driven.
const replayProvider = {
  delete: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue({ physicalId: 'p' }),
};
vi.mock('../../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: replayProvider }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

// The `AWS::EC2::Volume` + `DeletionPolicy: Snapshot` plan cases reach the
// pre-delete snapshot dispatcher, which would otherwise issue REAL EC2
// DescribeSnapshots / CreateSnapshot calls (or pay IMDS timeouts on a
// credential-less CI). The type sets / identifier builder / refusal factories
// stay REAL so the label cases still pin the actual routing matrix.
vi.mock('../../../../src/provisioning/final-snapshot.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/provisioning/final-snapshot.js')>();
  return { ...actual, createPreDeleteFinalSnapshot: vi.fn(async () => 'snap-unit') };
});

vi.mock('../../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../../../../src/provisioning/resource-name.js', () => ({
  withStackName: (_name: string, fn: () => unknown) => fn(),
}));

vi.mock('../../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));

// readline: this file drives `rollbackCommand`'s confirmation prompt, which
// every other case in it skips via `force: true`. Mocked so the TTY control
// below can answer it, and so a REGRESSION (the guard removed from
// `confirmOrRefuse`) reds the refusal case by CONSTRUCTING an interface
// rather than hanging. The hang itself is fenced against REAL readline in
// `tests/unit/cli/non-interactive-confirm-guards.test.ts`.
const readlineQuestion = vi.hoisted(() => vi.fn<(p: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
const createInterfaceMock = vi.hoisted(() =>
  vi.fn(() => ({ question: readlineQuestion, close: readlineClose }))
);
vi.mock('node:readline/promises', () => ({ createInterface: createInterfaceMock }));

const setupMock = vi.fn();
vi.mock('../../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/cli/commands/state.js')>(
    '../../../../src/cli/commands/state.js'
  );
  return {
    ...actual,
    setupStateBackend: (...args: unknown[]) => setupMock(...args),
  };
});

import { rollbackCommand } from '../../../../src/cli/commands/rollback.js';
import { CdkdError, PartialFailureError } from '../../../../src/utils/error-handler.js';

interface FakeBackend {
  listStacks: ReturnType<typeof vi.fn>;
  listRawKeys: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  loadRollbackJournal: ReturnType<typeof vi.fn>;
  saveState: ReturnType<typeof vi.fn>;
  popRollbackJournalSegment: ReturnType<typeof vi.fn>;
  setRollbackJournalFailedOperations: ReturnType<typeof vi.fn>;
  deleteState: ReturnType<typeof vi.fn>;
  deleteRollbackJournal: ReturnType<typeof vi.fn>;
  setCustomResourceResponseBucket?: ReturnType<typeof vi.fn>;
}

/**
 * Lock spies hoisted out of `installSetup` so a case can assert them.
 * `cdkd rollback` acquires the stack lock BEFORE its confirmation prompt, so
 * the refusal has to release it on the way out -- the guarantee
 * `docs/cli-reference.md` states for all four commands that hold a lock at
 * their prompt. A stuck lock blocks every other session against that stack,
 * which is a worse outcome than the run that failed. Re-created per test in
 * `installSetup` so counts do not accumulate across cases.
 */
let mockAcquireLockWithRetry: ReturnType<typeof vi.fn>;
let mockReleaseLock: ReturnType<typeof vi.fn>;

function installSetup(backend: Partial<FakeBackend>): FakeBackend {
  mockAcquireLockWithRetry = vi.fn().mockResolvedValue(undefined);
  mockReleaseLock = vi.fn().mockResolvedValue(undefined);
  const full: FakeBackend = {
    listStacks: vi.fn().mockResolvedValue([]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(null),
    loadRollbackJournal: vi.fn().mockResolvedValue(null),
    saveState: vi.fn().mockResolvedValue('etag-1'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    ...backend,
  };
  setupMock.mockResolvedValue({
    stateBackend: full,
    lockManager: {
      acquireLockWithRetry: mockAcquireLockWithRetry,
      releaseLock: mockReleaseLock,
    },
    awsClients: {},
    region: 'us-east-1',
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
  return full;
}

const baseOpts = { statePrefix: 'cdkd', verbose: false, force: true };

/** A journal + state pair with ONE replayable CREATE, enough to reach the prompt. */
function installOneCreateSegment(): FakeBackend {
  const createOp = {
    logicalId: 'Bucket',
    changeType: 'CREATE',
    resourceType: 'AWS::S3::Bucket',
    physicalId: 'phys-Bucket',
  };
  return installSetup({
    listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
    getState: vi.fn().mockResolvedValue({
      state: {
        version: 8,
        stackName: 'S',
        region: 'us-east-1',
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
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        { timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [createOp] },
      ],
    }),
  });
}

describe('rollbackCommand', () => {
  let originalIsTTY: boolean | undefined;
  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    vi.clearAllMocks();
  });
  afterEach(() => setStdinIsTty(originalIsTTY));

  /**
   * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275), the ROUTING
   * half — the ONE site that had none.
   *
   * `tests/unit/cli/non-interactive-confirm-guards.test.ts` probes this
   * command's prompt HELPER directly; what a helper-level probe cannot see is
   * whether the COMMAND's own call site still reaches it. Every OTHER case in
   * this file (and in `tests/unit/cli/rollback-lock-release-ordering.test.ts`)
   * hardcodes `force: true` via `baseOpts`, so `skipConfirmation` is true and
   * the prompt is never reached by any of them — the guard could be deleted
   * from `rollback.ts` and both suites would stay green.
   *
   * `force: false, yes: false` is what makes the gate live. The pair below is
   * a two-sided fence: this one asserts the refusal happens BEFORE an
   * interface exists, and the TTY control asserts the site is still reached
   * with its shipped `(y/N): ` suffix — so neither a deleted guard nor a
   * guard that refuses unconditionally survives both.
   */
  it('REFUSES a non-interactive run when neither --force nor --yes is passed', async () => {
    setStdinIsTty(undefined);
    const backend = installOneCreateSegment();

    const err = await rollbackCommand('S', {
      ...baseOpts,
      force: false,
      yes: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CdkdError);
    expect((err as CdkdError).code).toBe('NON_INTERACTIVE_CONFIRM');
    expect((err as Error).message).toContain('The cdkd rollback confirmation prompt cannot run');
    expect((err as Error).message).toContain('--force');
    expect((err as Error).message).toContain('-y / --yes');
    // Refused BEFORE the interface exists, which is the whole point: there is
    // no window in which a never-settling question could be awaited.
    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect(readlineQuestion).not.toHaveBeenCalled();
    // Nothing replayed, nothing persisted, journal untouched.
    expect(replayProvider.delete).not.toHaveBeenCalled();
    expect(replayProvider.update).not.toHaveBeenCalled();
    expect(backend.saveState).not.toHaveBeenCalled();
    expect(backend.popRollbackJournalSegment).not.toHaveBeenCalled();
    expect(backend.deleteState).not.toHaveBeenCalled();
    // ...and the lock taken before the prompt is handed back, not leaked.
    expect(mockAcquireLockWithRetry).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('still PROMPTS on a TTY, with its shipped (y/N): suffix, and a decline stops it', async () => {
    // The other half of the fence. Without it a guard that refused
    // unconditionally — or a call site deleted outright — would satisfy the
    // case above while breaking every interactive run. It also pins the
    // SUFFIX, which is user-visible output only this site and
    // `cdkd state orphan` spell as `(y/N): `.
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue('n');
    const backend = installOneCreateSegment();

    await expect(
      rollbackCommand('S', { ...baseOpts, force: false, yes: false })
    ).resolves.toBeUndefined();

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(readlineQuestion).toHaveBeenCalledWith("Roll back 'S' (us-east-1)? (y/N): ");
    // A decline is a different outcome from a refusal, reached through the
    // same code: the command returns cleanly and replays nothing.
    expect(replayProvider.delete).not.toHaveBeenCalled();
    expect(backend.popRollbackJournalSegment).not.toHaveBeenCalled();
  });

  it('no arg + no journals → returns without error', async () => {
    installSetup({ listRawKeys: vi.fn().mockResolvedValue([]) });
    await expect(rollbackCommand(undefined, { ...baseOpts })).resolves.toBeUndefined();
  });

  it('no arg + multiple journals → throws multi-candidate error', async () => {
    installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        'cdkd/A/us-east-1/rollback-journal.json',
        'cdkd/B/us-east-1/rollback-journal.json',
      ]),
    });
    await expect(rollbackCommand(undefined, { ...baseOpts })).rejects.toThrow(/Multiple stacks/);
  });

  it('named stack with no journal → throws nothing-to-roll-back', async () => {
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({ state: { resources: {}, outputs: {} }, etag: 'e' }),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).rejects.toThrow(/Nothing to roll back/);
  });

  it('journal present but state.json missing → throws corruption error', async () => {
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue(null),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).rejects.toThrow(/state appears corrupted|state\.json is missing/i);
  });

  it('replays a real CREATE segment → deletes the resource, saves state, pops the journal', async () => {
    replayProvider.delete.mockClear();
    const createOp = {
      logicalId: 'Bucket',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-Bucket',
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Bucket: { physicalId: 'phys-Bucket', resourceType: 'AWS::S3::Bucket', properties: {}, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [createOp] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).resolves.toBeUndefined();
    expect(replayProvider.delete).toHaveBeenCalledWith(
      'Bucket',
      'phys-Bucket',
      'AWS::S3::Bucket',
      undefined,
      expect.objectContaining({ expectedRegion: 'us-east-1' })
    );
    expect(backend.saveState).toHaveBeenCalled(); // state persisted after the delete
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
    // Not an initialDeploy → state.json NOT deleted.
    expect(backend.deleteState).not.toHaveBeenCalled();
  });

  it('a per-op provider failure → exit code 2 (PartialFailureError), journal kept', async () => {
    replayProvider.delete.mockClear();
    replayProvider.delete.mockRejectedValueOnce(new Error('AWS delete boom'));
    const createOp = {
      logicalId: 'Bucket',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-Bucket',
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Bucket: { physicalId: 'phys-Bucket', resourceType: 'AWS::S3::Bucket', properties: {}, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [createOp] }],
      }),
    });
    const err = await rollbackCommand('S', { ...baseOpts }).catch((e) => e);
    expect(err).toBeInstanceOf(PartialFailureError);
    expect((err as PartialFailureError).exitCode).toBe(2);
    // Failed segment is NOT popped (kept for re-run).
    expect(backend.popRollbackJournalSegment).not.toHaveBeenCalled();
  });

  it('a skip-with-warning op (unrecoverable DELETE) → exit code 2 but segment still pops', async () => {
    const deleteOp = { logicalId: 'Gone', changeType: 'DELETE', resourceType: 'AWS::S3::Bucket' };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: { version: 8, stackName: 'S', region: 'us-east-1', resources: {}, outputs: {}, lastModified: 1 },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [deleteOp] }],
      }),
    });
    const err = await rollbackCommand('S', { ...baseOpts }).catch((e) => e);
    expect(err).toBeInstanceOf(PartialFailureError);
    // A warning (not a failure) still pops the segment.
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
  });

  it('--revert-failed off: journaled failed op is left as-is, segment still pops (#1198)', async () => {
    replayProvider.update.mockClear();
    const failedOp = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-Q',
      previousState: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] },
      attemptedProperties: { a: 2 },
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Q: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [], failedOperations: [failedOp] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).resolves.toBeUndefined();
    expect(replayProvider.update).not.toHaveBeenCalled();
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
  });

  it('--revert-failed on: force-reverts the failed UPDATE with previous-vs-attempted (#1198)', async () => {
    replayProvider.update.mockClear();
    const failedOp = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-Q',
      previousState: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] },
      attemptedProperties: { a: 2 },
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Q: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [], failedOperations: [failedOp] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts, revertFailed: true })).resolves.toBeUndefined();
    expect(replayProvider.update).toHaveBeenCalledWith(
      'Q',
      'phys-Q',
      'AWS::SQS::Queue',
      { a: 1 }, // desired = previous properties
      { a: 2 }, // previous side of the diff = ATTEMPTED properties
      // EXACT object, not `objectContaining`: `toHaveBeenCalledWith(a, b, c)`
      // was itself an ARITY-STRICT #1463-style fence (no 6th argument at all), and
      // `objectContaining` would admit `replayingState: true` — the exact leak
      // those fences exist to catch. This site and the property-driven
      // replacement are the ONLY fences covering the main CREATE path, so the
      // loose form would have removed cover from the most-travelled site.
      //
      // `expectedRegion` is the rollback context's own region, threaded for
      // issue #2301 item 1 so a Cloud-Control-routed revert-failed cannot be
      // applied against a client pointing somewhere else. It stays in the
      // EXACT object for the same arity-strict reason as the rest.
      { maskSecrets: expect.any(Function), expectedRegion: 'us-east-1' }
    );
    expect(backend.saveState).toHaveBeenCalled();
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
    // Idempotency: the replayed failed-ops are stripped from the journal so a
    // later completed-op failure re-run cannot re-issue the revert.
    expect(backend.setRollbackJournalFailedOperations).toHaveBeenCalledWith('S', 'us-east-1', []);
  });

  it('--revert-failed on: a failed-op revert failure keeps the segment (exit 2)', async () => {
    replayProvider.update.mockClear();
    replayProvider.update.mockRejectedValueOnce(new Error('revert boom'));
    const failedOp = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-Q',
      previousState: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] },
      attemptedProperties: { a: 2 },
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Q: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [], failedOperations: [failedOp] }],
      }),
    });
    const err = await rollbackCommand('S', { ...baseOpts, revertFailed: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PartialFailureError);
    expect(backend.popRollbackJournalSegment).not.toHaveBeenCalled();
    // Failed revert → the failed-op stays in the journal for the re-run
    // (remaining list unchanged, so no strip write is issued).
    expect(backend.setRollbackJournalFailedOperations).not.toHaveBeenCalled();
  });

  it('initialDeploy segment with empty ops → pops journal and deletes state.json', async () => {
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({ state: { resources: {}, outputs: {}, region: 'us-east-1', stackName: 'S', version: 8, lastModified: 1 }, etag: 'e' }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: true, operations: [] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).resolves.toBeUndefined();
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
    expect(backend.deleteState).toHaveBeenCalledWith('S', 'us-east-1');
  });
});

describe('rollbackCommand corruption path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('journal-without-state is a HARD error (exit 1, plain Error — NOT PartialFailureError)', async () => {
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue(null),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [] }],
      }),
    });
    const err = await rollbackCommand('S', { ...baseOpts }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PartialFailureError); // hard error → exit 1, not partial
  });
});

/**
 * `--skip-final-snapshot` + `finalSnapshotClients` wiring (issue #1358).
 *
 * These pin the CLI -> `RollbackExecutorContext` plumbing specifically: the
 * executor's own behavior is covered in
 * `tests/unit/deployment/rollback-executor.test.ts`, but nothing there fails
 * if `rollbackCommand` stops PASSING the flag / the clients — the executor
 * just falls back to its defaults and the flag silently stops working.
 */
describe('rollbackCommand — DeletionPolicy: Snapshot wiring (#1358)', () => {
  beforeEach(() => vi.clearAllMocks());

  function installSnapshotStack(resourceType: string): FakeBackend {
    const createOp = {
      logicalId: 'D',
      changeType: 'CREATE',
      resourceType,
      physicalId: 'phys-D',
      provisionedBy: 'sdk',
    };
    return installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: {
            D: {
              physicalId: 'phys-D',
              resourceType,
              properties: {},
              attributes: {},
              dependencies: [],
              deletionPolicy: 'Snapshot',
              provisionedBy: 'sdk',
            },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [
          { timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [createOp] },
        ],
      }),
    });
  }

  it('default: threads a final-snapshot identifier into the rollback delete', async () => {
    installSnapshotStack('AWS::RDS::DBInstance');
    await rollbackCommand('S', { ...baseOpts });
    expect(replayProvider.delete).toHaveBeenCalledOnce();
    expect(replayProvider.delete.mock.calls[0]![4]).toEqual(
      expect.objectContaining({
        finalSnapshotIdentifier: expect.stringMatching(/^phys-d-final-\d{8}-\d{6}$/),
      })
    );
  });

  it('--skip-final-snapshot: plain delete, no identifier (the flag actually reaches the executor)', async () => {
    installSnapshotStack('AWS::RDS::DBInstance');
    await rollbackCommand('S', { ...baseOpts, skipFinalSnapshot: true });
    expect(replayProvider.delete).toHaveBeenCalledOnce();
    expect(replayProvider.delete.mock.calls[0]![4]).not.toHaveProperty('finalSnapshotIdentifier');
  });

  it('the plan preview labels the Snapshot action, and says so when the flag skips it', async () => {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;

    installSnapshotStack('AWS::RDS::DBInstance');
    await rollbackCommand('S', { ...baseOpts });
    const planned = info.mock.calls.map((c) => String(c[0]));
    expect(planned.some((l) => /final snapshot, then delete/.test(l))).toBe(true);

    vi.clearAllMocks();
    installSnapshotStack('AWS::RDS::DBInstance');
    await rollbackCommand('S', { ...baseOpts, skipFinalSnapshot: true });
    const skipped = info.mock.calls.map((c) => String(c[0]));
    expect(skipped.some((l) => /NO final snapshot \(--skip-final-snapshot\)/.test(l))).toBe(true);
  });
});

describe('createRollbackCommand option surface', () => {
  it('declares --skip-final-snapshot on the rollback subcommand itself (#1097 class)', async () => {
    const { createRollbackCommand } = await import('../../../../src/cli/commands/rollback.js');
    const flags = createRollbackCommand()
      .options.map((o) => o.long)
      .filter((f): f is string => typeof f === 'string');
    // Dropping the `.addOption(skipFinalSnapshotOption)` line yields
    // `error: unknown option '--skip-final-snapshot'` at runtime with every
    // unit test still green - exactly the issue #1097 failure class.
    expect(flags).toContain('--skip-final-snapshot');
  });
});

/**
 * `DeletionPolicy` on `--revert-failed`'s delete of a FAILED in-flight
 * CREATE (issue #1362). Same plumbing question as the #1358 block above,
 * one path over: nothing in the executor's own suite fails if
 * `rollbackCommand` stops passing the flag / the clients on THIS path, and
 * the plan preview is the only place the user sees what is about to happen.
 */
describe('rollbackCommand — DeletionPolicy on a failed CREATE (#1362)', () => {
  beforeEach(() => vi.clearAllMocks());

  function installFailedCreateStack(
    resourceType: string,
    deletionPolicy: 'Snapshot' | 'Retain'
  ): FakeBackend {
    const failedOp = {
      logicalId: 'D',
      changeType: 'CREATE',
      resourceType,
      physicalId: 'phys-D',
      provisionedBy: 'sdk',
      attemptedProperties: {},
    };
    return installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: {
            D: {
              physicalId: 'phys-D',
              resourceType,
              properties: {},
              attributes: {},
              dependencies: [],
              deletionPolicy,
              provisionedBy: 'sdk',
            },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [
          {
            timestamp: 1,
            reason: 'auto-rollback-clean',
            initialDeploy: false,
            operations: [],
            failedOperations: [failedOp],
          },
        ],
      }),
    });
  }

  it('Snapshot: threads a final-snapshot identifier into the --revert-failed delete', async () => {
    installFailedCreateStack('AWS::RDS::DBInstance', 'Snapshot');
    await rollbackCommand('S', { ...baseOpts, revertFailed: true });
    expect(replayProvider.delete).toHaveBeenCalledOnce();
    expect(replayProvider.delete.mock.calls[0]![4]).toEqual(
      expect.objectContaining({
        finalSnapshotIdentifier: expect.stringMatching(/^phys-d-final-\d{8}-\d{6}$/),
      })
    );
  });

  it('Snapshot + --skip-final-snapshot: plain delete (the flag reaches THIS path too)', async () => {
    installFailedCreateStack('AWS::RDS::DBInstance', 'Snapshot');
    await rollbackCommand('S', { ...baseOpts, revertFailed: true, skipFinalSnapshot: true });
    expect(replayProvider.delete).toHaveBeenCalledOnce();
    expect(replayProvider.delete.mock.calls[0]![4]).not.toHaveProperty('finalSnapshotIdentifier');
  });

  it('Retain: no delete at all — the resource is left in AWS', async () => {
    installFailedCreateStack('AWS::EC2::Volume', 'Retain');
    await rollbackCommand('S', { ...baseOpts, revertFailed: true });
    expect(replayProvider.delete).not.toHaveBeenCalled();
  });

  it('the plan preview labels each policy, and says so when the flag skips the snapshot', async () => {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
    const lines = (): string[] => info.mock.calls.map((c) => String(c[0]));

    installFailedCreateStack('AWS::RDS::DBInstance', 'Snapshot');
    await rollbackCommand('S', { ...baseOpts, revertFailed: true });
    expect(
      lines().some((l) => /FAILED create, DeletionPolicy Snapshot — final snapshot, then delete/.test(l))
    ).toBe(true);

    vi.clearAllMocks();
    installFailedCreateStack('AWS::RDS::DBInstance', 'Snapshot');
    await rollbackCommand('S', { ...baseOpts, revertFailed: true, skipFinalSnapshot: true });
    expect(lines().some((l) => /NO final snapshot \(--skip-final-snapshot\)/.test(l))).toBe(true);

    vi.clearAllMocks();
    installFailedCreateStack('AWS::EC2::Volume', 'Retain');
    await rollbackCommand('S', { ...baseOpts, revertFailed: true });
    expect(
      lines().some((l) => /orphan.*FAILED create, DeletionPolicy Retain — left in AWS/.test(l))
    ).toBe(true);
  });
});

/**
 * Issue #1366: the plan preview must not promise a final snapshot for a
 * shape the replay is about to REFUSE. Both label functions consult the same
 * mechanism matrix the executor runs, keyed on the route the delete will take.
 */
describe('rollbackCommand — plan preview vs the refusal matrix (#1366)', () => {
  beforeEach(() => vi.clearAllMocks());

  function installSnapshotPlan(
    resourceType: string,
    provisionedBy: 'sdk' | 'cc-api',
    kind: 'completed' | 'failed'
  ): FakeBackend {
    const op = {
      logicalId: 'D',
      changeType: 'CREATE',
      resourceType,
      physicalId: 'phys-D',
      // The JOURNAL deliberately disagrees with the record below, so a label
      // reading the journaled route instead of the effective one is visible.
      provisionedBy: 'sdk',
      ...(kind === 'failed' && { attemptedProperties: {} }),
    };
    return installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: {
            D: {
              physicalId: 'phys-D',
              resourceType,
              properties: {},
              attributes: {},
              dependencies: [],
              deletionPolicy: 'Snapshot',
              provisionedBy,
            },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [
          {
            timestamp: 1,
            reason: 'auto-rollback-clean',
            initialDeploy: false,
            operations: kind === 'completed' ? [op] : [],
            ...(kind === 'failed' && { failedOperations: [op] }),
          },
        ],
      }),
    });
  }

  async function planLines(
    resourceType: string,
    provisionedBy: 'sdk' | 'cc-api',
    kind: 'completed' | 'failed'
  ): Promise<string[]> {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
    installSnapshotPlan(resourceType, provisionedBy, kind);
    await rollbackCommand('S', {
      ...baseOpts,
      ...(kind === 'failed' && { revertFailed: true }),
    }).catch(() => undefined); // a refused plan exits 2; the label is the subject
    return info.mock.calls.map((c) => String(c[0]));
  }

  it('completed CREATE, cc-api-routed atomic type: the plan says it will REFUSE', async () => {
    const lines = await planLines('AWS::RDS::DBInstance', 'cc-api', 'completed');
    expect(lines.some((l) => /will REFUSE it/.test(l))).toBe(true);
    expect(lines.some((l) => /final snapshot, then delete/.test(l))).toBe(false);
  });

  it('completed CREATE, a type cdkd cannot snapshot at all: the plan says it will REFUSE', async () => {
    const lines = await planLines('AWS::S3::Bucket', 'sdk', 'completed');
    expect(lines.some((l) => /will REFUSE it/.test(l))).toBe(true);
  });

  it('completed CREATE, a snapshottable shape: the plan still promises the snapshot', async () => {
    const { createPreDeleteFinalSnapshot } = await import(
      '../../../../src/provisioning/final-snapshot.js'
    );
    const lines = await planLines('AWS::EC2::Volume', 'cc-api', 'completed');
    expect(lines.some((l) => /final snapshot, then delete/.test(l))).toBe(true);
    expect(lines.some((l) => /will REFUSE it/.test(l))).toBe(false);
    // The promise is kept AND the dispatcher is the stub — an un-intercepted
    // call here would be a real EC2 DescribeSnapshots/CreateSnapshot.
    expect(vi.mocked(createPreDeleteFinalSnapshot)).toHaveBeenCalledWith(
      'AWS::EC2::Volume',
      'phys-D',
      'D',
      expect.anything(),
      expect.anything()
    );
  });

  it('failed CREATE (--revert-failed) carries the same verdict', async () => {
    const refused = await planLines('AWS::RDS::DBInstance', 'cc-api', 'failed');
    expect(refused.some((l) => /FAILED create, DeletionPolicy Snapshot .*will REFUSE it/.test(l))).toBe(
      true
    );

    vi.clearAllMocks();
    const ok = await planLines('AWS::EC2::Volume', 'cc-api', 'failed');
    expect(ok.some((l) => /FAILED create, DeletionPolicy Snapshot — final snapshot, then delete/.test(l))).toBe(
      true
    );
  });

  it('--skip-final-snapshot wins over the refusal note (nothing is refused under the opt-out)', async () => {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
    installSnapshotPlan('AWS::RDS::DBInstance', 'cc-api', 'completed');
    await rollbackCommand('S', { ...baseOpts, skipFinalSnapshot: true });
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /NO final snapshot \(--skip-final-snapshot\)/.test(l))).toBe(true);
    expect(lines.some((l) => /will REFUSE it/.test(l))).toBe(false);
  });
});

/**
 * Issue #1368: the plan preview must not unwind a record for an op the
 * replay will REFUSE. Only observable across SEGMENTS — the preview state is
 * what the NEXT (older) segment's plan is classified against, so a wrongly
 * dropped record turns the older segment's real work into
 * `skip — already reverted` in the one preview the user reads before `y`.
 */
describe('rollbackCommand — plan preview vs a refused Snapshot delete (#1368)', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * TWO segments touching the SAME logical id, under a Snapshot policy on a
   * cc-api-routed atomic type (the shape the replay refuses).
   */
  function installTwoSegmentPlan(
    kind: 'completed' | 'failed',
    resourceType = 'AWS::RDS::DBInstance'
  ): FakeBackend {
    const op = {
      logicalId: 'D',
      changeType: 'CREATE',
      resourceType,
      physicalId: 'phys-D',
      provisionedBy: 'sdk',
      ...(kind === 'failed' && { attemptedProperties: {} }),
    };
    const segment = (reason: string) => ({
      timestamp: 1,
      reason,
      initialDeploy: false,
      operations: kind === 'completed' ? [op] : [],
      ...(kind === 'failed' && { failedOperations: [op] }),
    });
    return installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: {
            D: {
              physicalId: 'phys-D',
              resourceType,
              properties: {},
              attributes: {},
              dependencies: [],
              deletionPolicy: 'Snapshot',
              provisionedBy: 'cc-api',
            },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        // Oldest first; the preview walks newest-first.
        segments: [segment('no-rollback-failure'), segment('auto-rollback-clean')],
      }),
    });
  }

  async function planLinesFor(
    kind: 'completed' | 'failed',
    opts: Record<string, unknown> = {},
    resourceType = 'AWS::RDS::DBInstance'
  ): Promise<string[]> {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
    installTwoSegmentPlan(kind, resourceType);
    await rollbackCommand('S', {
      ...baseOpts,
      ...(kind === 'failed' && { revertFailed: true }),
      ...opts,
    }).catch(() => undefined); // the refusal exits 2; the preview is the subject
    return info.mock.calls.map((c) => String(c[0]));
  }

  it('a refused completed-CREATE keeps its record, so the older segment is not mislabelled', async () => {
    const lines = await planLinesFor('completed');
    // Both segments describe the same real work...
    expect(lines.filter((l) => /will REFUSE it/.test(l))).toHaveLength(2);
    // ...and neither is downgraded to a no-op by a preview that unwound a
    // delete which never happens.
    expect(lines.some((l) => /already reverted/.test(l))).toBe(false);
  });

  it('a refused failed-CREATE (--revert-failed) keeps its record too', async () => {
    const lines = await planLinesFor('failed');
    expect(lines.filter((l) => /FAILED create.*will REFUSE it/.test(l))).toHaveLength(2);
    expect(lines.some((l) => /left nothing to revert/.test(l))).toBe(false);
  });

  it('--skip-final-snapshot: nothing is refused, so the preview DOES unwind (opposite polarity)', async () => {
    const lines = await planLinesFor('completed', { skipFinalSnapshot: true });
    // The newest segment deletes for real, so the older segment's item for
    // the same id correctly becomes a no-op.
    expect(lines.filter((l) => /NO final snapshot \(--skip-final-snapshot\)/.test(l))).toHaveLength(
      1
    );
    expect(lines.some((l) => /already reverted/.test(l))).toBe(true);
  });

  it('a snapshottable shape still unwinds the preview (the carve-out is refusal-only)', async () => {
    // Same two-segment journal, but a type cdkd CAN snapshot on this route —
    // the delete WILL happen, so the record must still be unwound and the
    // older segment's item correctly becomes a no-op.
    const lines = await planLinesFor('completed', {}, 'AWS::EC2::Volume');
    expect(lines.filter((l) => /final snapshot, then delete/.test(l))).toHaveLength(1);
    expect(lines.some((l) => /already reverted/.test(l))).toBe(true);
  });
});
