import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
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

const nestedCtx = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }));
vi.mock('../../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (ctx: Record<string, unknown>, fn: () => unknown) => {
    nestedCtx.last = ctx;
    return fn();
  },
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

import { displayIdent, displayStackName } from '../../../../src/utils/display-safe.js';
import {
  backendErrorText,
  rerunRollback,
  rollbackCommand,
} from '../../../../src/cli/commands/rollback.js';
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
 * `docs/cli-destroy.md` states for all four commands that hold a lock at
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

/**
 * `safeStack` renders in `src/cli/commands/rollback.ts`: every place a cdkd
 * state-record STACK NAME reaches a message. A LITERAL, not a number derived
 * from the file it guards -- a population computed from the subject cannot
 * notice the subject shrinking.
 */
// Three of the twelve were the `cdkd rollback <stack>` retry hints; since
// go-to-k/cdkd#3436 the name reaches those through `pasteableCommand`'s gate on
// a labelled line instead of through `safeStack` inside prose quotes, so they
// are no longer renders of this helper.
//
// Went 9 -> 10 in go-to-k/cdkd#3370: the divergent-record-region refusal names
// the stack it will not roll back.
//
// Went 10 -> 8 in go-to-k/cdkd#3760: the multi-journal candidate list and the
// lock-release warning name a stack through `plainOrDescribed` /
// `quotedOrDescribed`, since each is printed near a labelled command line.
//
// Went 8 -> 11 in go-to-k/cdkd#3754: the refusal of a journal holding a nested
// child's pending record names the child and its parent, and the plan preview
// names the nested child whose journal a row's revert replays.
const EXPECTED_STACK_NAME_RENDERS = 11;

/**
 * Bare `safe` references in the same file -- 1 declaration plus every render of
 * a region, logical id, resource type or change type, none of which needs the
 * wider stack-name cap. Exact, so a stack name ADDED through the weak helper
 * moves a number instead of slipping past a pattern.
 *
 * Went 59 -> 58 in go-to-k/cdkd#3397: the `--role-arn` note moved OFF `safe()`
 * onto `safeRoleArn()`, because an AWS-legal role ARN reaches 613 code points
 * and the 255 default was cutting it inside the sentence that names it. That is
 * the fence behaving as designed -- it refused the first cut of that fix, which
 * spelled the cap inline at the site, and the refusal is what produced the
 * named helper.
 *
 * Went 58 -> 62 in go-to-k/cdkd#2668: the plan labels render a replacement's
 * OLD type beside its new one (`replacementTypes`), plus the two new labels
 * (`refuse-replacement-routing`, `skip-failed-type-change`). All resource types
 * and logical ids; no stack name among them.
 *
 * Went 62 -> 63 in go-to-k/cdkd#3370: the divergent-record-region refusal
 * renders the KEY's region beside the stack it names.
 *
 * Went 63 -> 61 in go-to-k/cdkd#3760: the candidate list and the lock-release
 * warning name a region through `plainOrDescribed`.
 *
 * Went 61 -> 63 in go-to-k/cdkd#3754: the nested-pending refusal renders the
 * region, and the nested plan preview renders a failed read's error text.
 */
const EXPECTED_SAFE_REFERENCES = 63;

/**
 * Bare `safeRoleArn` references -- 1 declaration plus the single role-ARN
 * render (the `--role-arn` note on the journal's newest segment).
 *
 * A THIRD exact total rather than folding ARNs into one of the two above, for
 * the reason the `safe` note gives about stack names: a shared count is
 * satisfied by a render moving between helpers, and moving an ARN onto the
 * 255-code-point helper is exactly the regression this file now guards.
 */
const EXPECTED_ROLE_ARN_RENDERS = 1;

/** A journal + state pair with ONE replayable CREATE, enough to reach the prompt. */
function installOneCreateSegment(stackName = 'S'): FakeBackend {
  const createOp = {
    logicalId: 'Bucket',
    changeType: 'CREATE',
    resourceType: 'AWS::S3::Bucket',
    physicalId: 'phys-Bucket',
  };
  return installSetup({
    listStacks: vi.fn().mockResolvedValue([{ stackName, region: 'us-east-1' }]),
    getState: vi.fn().mockResolvedValue({
      state: {
        version: 8,
        stackName,
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
      stackName,
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

  it('no arg: a nested child journal whose parent also has one is not a separate candidate (#3754)', async () => {
    const backend = installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        'cdkd/A/us-east-1/rollback-journal.json',
        'cdkd/A~Child/us-east-1/rollback-journal.json',
      ]),
    });
    // Resolves to `A` alone, so it proceeds to A's journal load instead of
    // refusing with the multi-candidate list.
    await expect(rollbackCommand(undefined, { ...baseOpts })).rejects.toThrow(/Nothing to roll back for/);
    expect(backend.loadRollbackJournal).toHaveBeenCalledWith('A', 'us-east-1');
  });

  it('CONTROL: an ORPHANED nested child journal (no parent candidate) is still offered', async () => {
    installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        'cdkd/B/us-east-1/rollback-journal.json',
        'cdkd/A~Child/us-east-1/rollback-journal.json',
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
      // was itself an ARITY-STRICT #1463-style fence (no 6th argument at all),
      // and the loose form would admit any field a later change added silently.
      // This site and the property-driven replacement are the ONLY fences
      // covering the main CREATE path, so it would have removed cover from the
      // most-travelled site.
      //
      // `expectedRegion` is the rollback context's own region, threaded for
      // issue #2301 item 1 so a Cloud-Control-routed revert-failed cannot be
      // applied against a client pointing somewhere else. It stays in the
      // EXACT object for the same arity-strict reason as the rest.
      //
      // `replayingState` is issue #3141 and it is CORRECT here — an earlier
      // version of this comment cited it as the leak the exact form exists to
      // catch, which was true only while the field was `CreateContext`-only.
      // `UpdateContext` has its own since #3141, and this arm's desired bag IS
      // `previousState.properties`, a cdkd state record: without the flag a
      // provider refusal written for a bad TEMPLATE fires on a bag the user
      // cannot edit and the force-revert cannot complete. The exact form still
      // does its job — it now pins the flag's PRESENCE here as tightly as it
      // pinned its absence before, and `deploy-engine-provider-secret-masker`
      // carries the matching negative control for the template path.
      { maskSecrets: expect.any(Function), expectedRegion: 'us-east-1', replayingState: true }
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

  describe('the replacement labels do not promise a delete the replay will skip (issue #2598)', () => {
    // The #1366 class, one layer over from the Snapshot case above: both
    // `reverse-replacement` labels said "delete new" unconditionally, and
    // `UpdateReplacePolicy: Retain` on the NEW copy means the replay leaves it
    // alone. Coverage gap found by the test reviewer on PR 2634 — the
    // mechanism (`RollbackPlanItem.retainsNewResource`) was pinned in the
    // executor suite, but the TEXT the user confirms was not.
    function installReplacementStack(opts: {
      newCopyPolicy?: 'Retain';
      oldResourceRetained: boolean;
      /** The OLD record's type (issue #2668); defaults to the op's own. */
      previousType?: string;
      /** The stamped journal field; omitted = a journal written before it existed. */
      previousResourceType?: string;
      /** A failed in-flight op recorded beside the completed one. */
      failedOperations?: unknown[];
    }): void {
      const op = {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: 'AWS::SQS::Queue',
        physicalId: 'phys-new',
        provisionedBy: 'sdk',
        oldResourceRetained: opts.oldResourceRetained,
        ...(opts.previousResourceType !== undefined && {
          previousResourceType: opts.previousResourceType,
        }),
        previousState: {
          physicalId: 'phys-old',
          resourceType: opts.previousType ?? 'AWS::SQS::Queue',
          properties: { a: 1 },
          attributes: {},
          dependencies: [],
        },
      };
      installSetup({
        listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
        getState: vi.fn().mockResolvedValue({
          state: {
            version: 8,
            stackName: 'S',
            region: 'us-east-1',
            resources: {
              R: {
                physicalId: 'phys-new',
                resourceType: 'AWS::SQS::Queue',
                properties: { a: 2 },
                attributes: {},
                dependencies: [],
                provisionedBy: 'sdk',
                ...(opts.newCopyPolicy && { updateReplacePolicy: opts.newCopyPolicy }),
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
              reason: 'no-rollback-failure',
              initialDeploy: false,
              operations: [op],
              ...(opts.failedOperations && { failedOperations: opts.failedOperations }),
            },
          ],
        }),
      });
    }

    /**
     * Run the command for its PLAN PREVIEW only. The preview is printed before
     * the replay, and this suite's shared `replayProvider` stub has no
     * `create`, so a reverse-replacement's re-create fails and the command
     * ends in `PartialFailureError`. Swallowed deliberately: these cases are
     * about the TEXT the user confirms, and the replay behaviour has its own
     * coverage in `rollback-executor-retain-new-resource.test.ts`.
     */
    async function plannedLines(): Promise<string[]> {
      const { getLogger } = await import('../../../../src/utils/logger.js');
      const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
      return info.mock.calls.map((c) => String(c[0]));
    }

    async function runForPlan(): Promise<string[]> {
      await rollbackCommand('S', { ...baseOpts }).catch(() => undefined);
      return plannedLines();
    }

    it('re-adopt: announces the retained new copy instead of promising a delete', async () => {
      installReplacementStack({ newCopyPolicy: 'Retain', oldResourceRetained: true });
      const lines = await runForPlan();
      expect(lines.some((l) => /new one RETAINED \(UpdateReplacePolicy: Retain\)/.test(l))).toBe(
        true
      );
      // The pre-fix text must be GONE, not merely joined by the new one — a
      // label carrying both would still mislead.
      expect(lines.some((l) => /delete new, re-adopt retained old resource/.test(l))).toBe(false);
    });

    it('re-create: announces the retention AND that a name collision refuses', async () => {
      installReplacementStack({ newCopyPolicy: 'Retain', oldResourceRetained: false });
      const lines = await runForPlan();
      expect(lines.some((l) => /new one RETAINED \(UpdateReplacePolicy: Retain\)/.test(l))).toBe(
        true
      );
      // The replay REFUSES this op when the re-create collides with the name
      // the pinned copy holds, and the plan cannot know in advance — so the
      // label has to carry the possibility rather than promise the happy path.
      expect(lines.some((l) => /REFUSED instead if the re-create collides/.test(l))).toBe(true);
      expect(lines.some((l) => /re-create old resource, delete new/.test(l))).toBe(false);
    });

    it('re-create WITHOUT the policy still promises the delete', async () => {
      // The other polarity. Without it, a label hard-wired to the retain text
      // would pass the cases above.
      installReplacementStack({ oldResourceRetained: false });
      const lines = await runForPlan();
      expect(lines.some((l) => /re-create old resource, delete new/.test(l))).toBe(true);
      expect(lines.some((l) => /RETAINED \(UpdateReplacePolicy: Retain\)/.test(l))).toBe(false);
    });

    describe('a replacement that changed the resource Type (issue #2668)', () => {
      const reverseLine = (lines: string[]): string | undefined =>
        lines.find((l) => l.includes('reverse-replace R'));

      it('shows NEW -> OLD, from the stamped field', async () => {
        installReplacementStack({
          oldResourceRetained: false,
          previousType: 'AWS::SSM::Parameter',
          previousResourceType: 'AWS::SSM::Parameter',
        });
        expect(reverseLine(await runForPlan())).toContain(
          '(AWS::SQS::Queue -> AWS::SSM::Parameter)'
        );
      });

      it('shows NEW -> OLD for a LEGACY journal too (previous record only)', async () => {
        installReplacementStack({ oldResourceRetained: false, previousType: 'AWS::SSM::Parameter' });
        expect(reverseLine(await runForPlan())).toContain(
          '(AWS::SQS::Queue -> AWS::SSM::Parameter)'
        );
      });

      it('CONTROL: an ordinary replacement shows the single type, no arrow', async () => {
        installReplacementStack({ oldResourceRetained: false });
        const line = reverseLine(await runForPlan());
        expect(line).toContain('(AWS::SQS::Queue)');
        expect(line).not.toContain('->');
      });

      it('an unroutable op is labelled REFUSED with the reason, never as a skip or a reverse', async () => {
        installReplacementStack({
          oldResourceRetained: false,
          previousType: 'AWS::SSM::Parameter',
          previousResourceType: 'AWS::SNS::Topic',
        });
        const lines = await runForPlan();
        const refused = lines.find((l) => l.includes('(REFUSED) R'));
        expect(refused).toBeDefined();
        expect(refused).toContain('two different types');
        expect(reverseLine(lines)).toBeUndefined();
        expect(lines.some((l) => /- skip\s+R /.test(l))).toBe(false);
      });

      it('--revert-failed labels a failed Type change as a skip naming both types', async () => {
        installReplacementStack({
          oldResourceRetained: false,
          failedOperations: [
            {
              logicalId: 'R',
              changeType: 'UPDATE',
              resourceType: 'AWS::SNS::Topic',
              physicalId: 'phys-new',
              previousState: {
                physicalId: 'phys-new',
                resourceType: 'AWS::SQS::Queue',
                properties: { a: 1 },
                attributes: {},
                dependencies: [],
              },
            },
          ],
        });
        await rollbackCommand('S', { ...baseOpts, revertFailed: true }).catch(() => undefined);
        const lines = await plannedLines();
        const failed = lines.find((l) => l.includes('failed Type change is a replacement'));
        expect(failed).toBeDefined();
        expect(failed).toContain('(AWS::SQS::Queue -> AWS::SNS::Topic)');
        expect(lines.some((l) => /FAILED update — remote state unknown/.test(l))).toBe(false);
      });
    });

    it('re-adopt WITHOUT the policy still promises the delete', async () => {
      // The readopt arm's own negative. The previous revision of this file
      // asserted "both labels" from ONE case and left this arm unpinned:
      // hard-wiring the readopt default label to the retain text kept all 34
      // cases green. Both arms now carry a positive AND a negative.
      installReplacementStack({ oldResourceRetained: true });
      const lines = await runForPlan();
      expect(lines.some((l) => /delete new, re-adopt retained old resource/.test(l))).toBe(true);
      expect(lines.some((l) => /RETAINED \(UpdateReplacePolicy: Retain\)/.test(l))).toBe(false);
    });
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
    deletionPolicy: 'Snapshot' | 'Retain',
    opts: { initialDeploy?: boolean } = {}
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
            initialDeploy: opts.initialDeploy ?? false,
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

  it('Retain: the resource left in AWS is RECORDED in the saved state (#2934)', async () => {
    const backend = installFailedCreateStack('AWS::EC2::Volume', 'Retain');
    await rollbackCommand('S', { ...baseOpts, revertFailed: true });

    // The command's OWN wiring, which the executor's tests cannot reach: this
    // is what proves `onOrphan: (record) => mintedOrphans.push(record)` is
    // actually passed, and that the saved literal spreads the merged set.
    // Delete either and the executor stays correct while cdkd persists a state
    // that has forgotten a live, billing AWS resource.
    const saved = backend.saveState.mock.calls.at(-1)![2] as { orphans?: unknown[] };
    expect(saved.orphans).toHaveLength(1);
    expect((saved.orphans![0] as { logicalId: string }).logicalId).toBe('D');
    // And the resource really did leave `resources` — otherwise the record
    // could be present for a resource still managed, which proves nothing.
    expect((saved as unknown as { resources: Record<string, unknown> }).resources).not.toHaveProperty(
      'D'
    );
  });

  it('Retain on an INITIAL deploy: state.json survives because a record was minted (#2934)', async () => {
    // `initialDeploy: true` is load-bearing and was the first version's bug:
    // the delete guard only fires on an initial-deploy segment, so a case built
    // on `false` asserted nothing — probing the guard away left it GREEN.
    const backend = installFailedCreateStack('AWS::EC2::Volume', 'Retain', {
      initialDeploy: true,
    });
    await rollbackCommand('S', { ...baseOpts, revertFailed: true });

    // The twin of the `initialDeploy segment with empty ops` case above, which
    // asserts the DELETE. Dropping `&& survivingOrphans.length === 0` deletes
    // `state.json` in the same run that minted the record — the reported
    // first-deploy-fails flow exactly, where `resources` ends up empty and the
    // record is the only trace of what is still standing in AWS.
    expect(backend.deleteState).not.toHaveBeenCalled();
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

/**
 * Issue [#3064](https://github.com/go-to-k/cdkd/issues/3064): the plan preview
 * is what the user CONFIRMS against, so a forged row here is worse than a
 * forged diagnostic line -- the confirmation attests to something other than
 * what will run.
 *
 * `rollback-journal.json` is a sibling of `state.json` in the same bucket and
 * carries no more validation than an unchecked cast, so every field the
 * preview renders is attacker-writable.
 *
 * Two dimensions per site. The HOLE is the guard being dropped. The CLASS is
 * `asciiOnly` being swapped for the denylist, which still removes a newline
 * but leaves the invisible formatters and bidi marks that `display-safe.ts`
 * names as its residual -- a control byte is in BOTH classes and cannot tell
 * them apart, which is why every fixture below carries a zero-width space too.
 */
describe('rollbackCommand — a planted journal cannot forge a plan row (#3064)', () => {
  let originalIsTTY: boolean | undefined;
  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    vi.clearAllMocks();
  });
  afterEach(() => setStdinIsTty(originalIsTTY));

  const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const INVISIBLE = /[\u200b-\u200f\ufeff]/;

  const FORGED_ID = 'Vic\u200btim\n  - delete   RealDatabase (AWS::RDS::DBInstance)';
  const FORGED_TYPE = 'AWS::S3::Buc\u200bket\n  - delete   RealBucket (AWS::S3::Bucket)';

  function installForgedJournal(
    kind: 'completed' | 'failed',
    opOverride: Record<string, unknown> = {},
    roleArnOverride?: string
  ): FakeBackend {
    const op = {
      logicalId: FORGED_ID,
      changeType: 'CRE\u200bATE\n  forged-change-type',
      resourceType: FORGED_TYPE,
      physicalId: 'phys-D',
      provisionedBy: 'sdk',
      ...(kind === 'failed' && { attemptedProperties: {} }),
      ...opOverride,
    };
    return installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: {},
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
            runId: '2026\u200b0101\n  - delete   RealQueue (AWS::SQS::Queue)',
            timestamp: 1,
            reason: 'auto-rollb\u200back-clean\n  - delete   RealTable (AWS::DynamoDB::Table)',
            // Rendered in its own `Note:` line directly ABOVE the plan header --
            // the one journal field the first fix round did not enumerate.
            roleArn:
              roleArnOverride ??
              'arn:aws:iam::1:role/De\u200bploy\n  - delete   RealRole (AWS::IAM::Role)',
            initialDeploy: false,
            operations: kind === 'completed' ? [op] : [],
            ...(kind === 'failed' && { failedOperations: [op] }),
          },
        ],
      }),
    });
  }

  async function forgedPlanLines(
    kind: 'completed' | 'failed',
    opts: Record<string, unknown> = {},
    opOverride: Record<string, unknown> = {},
    roleArnOverride?: string
  ): Promise<string[]> {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
    installForgedJournal(kind, opOverride, roleArnOverride);
    await rollbackCommand('S', { ...baseOpts, ...opts }).catch(() => undefined);
    return info.mock.calls.map((c) => String(c[0]));
  }

  /**
   * The plan's own first line begins with a newline (it separates segments), so
   * "contains no newline" is the wrong assertion. What must hold is that no
   * line the journal CONTRIBUTED text to gained a second one -- i.e. the
   * forged rows never become rows.
   */
  const forgedRowCount = (lines: string[]): number =>
    lines.join('\n').split('\n').filter((l) => /^\s*- delete\s+Real/.test(l)).length;

  it('the completed-operation label cannot inject a row', async () => {
    const lines = await forgedPlanLines('completed');

    expect(forgedRowCount(lines)).toBe(0);
    for (const line of lines) {
      expect(line.replace(/^\n/, '')).not.toMatch(CTRL);
      expect(line).not.toMatch(INVISIBLE);
    }
    // Removed, not censored: the operator still sees what the journal claimed.
    expect(lines.join('\n')).toContain('Vic tim');
  });

  it('an all-ASCII id cannot plant the row\'s own annotation wording -- its boundary is quoted (#3092)', async () => {
    // Survives the allowlist untouched: no newline, no invisible. Un-quoted,
    // the row read `- skip     X (AWS::RDS::DBInstance) -- already reverted
    // (AWS::S3::Bucket) — already reverted`, and a reader stops at the first
    // `(type)`.
    const spoof = 'X (AWS::RDS::DBInstance) -- already reverted';
    const lines = await forgedPlanLines('completed', {}, {
      logicalId: spoof,
      resourceType: 'AWS::S3::Bucket',
      changeType: 'CREATE',
    });
    const rows = lines.join('\n').split('\n').filter((l) => /^\s*- /.test(l));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`- skip     "${spoof}" (AWS::S3::Bucket) — already reverted`);
    // Outside the quotes, the annotation appears exactly once: the genuine one.
    expect(rows[0]!.replace(`"${spoof}"`, '').split('already reverted')).toHaveLength(2);
  });

  it('a MAXIMAL role ARN in the --role-arn note is NOT cut (issue #3397 review)', async () => {
    // The BEHAVIOURAL half of `safeRoleArn`. The source-shape assertions above
    // pin that the helper exists and which cap it names; only this one proves
    // an AWS-legal ARN survives the render. Before the helper this value went
    // through `safe()`'s 255 default and came back
    // `[cut: 358 more characters withheld]` -- inside `pass --role-arn to
    // match`, the sentence whose only job is to say which role to pass back.
    //
    // 613 code points: `arn:` + `aws-us-gov` + `:iam::` + 12 + `:role`, then a
    // 512-character path (its own slashes included) and a 64-character name.
    const path = `/${'p'.repeat(510)}/`;
    const maximalArn = `arn:aws-us-gov:iam::123456789012:role${path}${'n'.repeat(64)}`;
    expect(Array.from(maximalArn).length).toBe(613);

    const lines = await forgedPlanLines('completed', {}, {}, maximalArn);
    const note = lines.find((l) => l.includes('the failed deploy ran with --role-arn'));

    expect(note, 'the --role-arn note was not rendered at all').toBeDefined();
    expect(note, 'a legitimate maximal ARN was truncated in the message naming it').toContain(
      maximalArn
    );
    expect(note).not.toContain('withheld');
    // ...and the note still carries its remedy, so the assertion above is not
    // satisfied by a line that is nothing but the ARN.
    expect(note).toContain('pass --role-arn to match');
  });

  it('a value past the identifier cap is cut and the cut is named (#3092)', async () => {
    const long = 'A'.repeat(300);
    const lines = await forgedPlanLines('completed', {}, {
      logicalId: long,
      resourceType: 'AWS::S3::Bucket',
      changeType: 'CREATE',
    });
    const row = lines.join('\n').split('\n').find((l) => /^\s*- skip/.test(l));

    expect(row).toBeDefined();
    expect(row).not.toContain(long);
    expect(row).toContain(`${'A'.repeat(255)} [cut: 45 more characters withheld] (AWS::S3::Bucket)`);
  });

  it('the failed-operation label cannot inject a row', async () => {
    const lines = await forgedPlanLines('failed', { revertFailed: true });

    expect(forgedRowCount(lines)).toBe(0);
    for (const line of lines) {
      expect(line.replace(/^\n/, '')).not.toMatch(CTRL);
      expect(line).not.toMatch(INVISIBLE);
    }
  });

  it('the not-reverting `left as-is` label cannot inject a row', async () => {
    // `--revert-failed` OFF is a different label function from the two above,
    // and it renders the failed op's changeType as well.
    const lines = await forgedPlanLines('failed');

    expect(forgedRowCount(lines)).toBe(0);
    for (const line of lines) {
      expect(line.replace(/^\n/, '')).not.toMatch(CTRL);
      expect(line).not.toMatch(INVISIBLE);
    }
    expect(lines.join('\n')).toContain('CRE ATE');
  });

  it('the SEGMENT header cannot inject a row through its reason or run id', async () => {
    const lines = await forgedPlanLines('completed');
    const header = lines.find((l) => l.includes('Segment 1/1'));

    expect(header).toBeDefined();
    expect(header!.replace(/^\n/, '')).not.toMatch(CTRL);
    expect(header).not.toMatch(INVISIBLE);
    expect(header).toContain('auto-rollb ack-clean');
    expect(header).toContain('2026 0101');
  });

  it('the `--role-arn` NOTE above the plan cannot inject a row', async () => {
    // A journal field the first round's enumeration missed: it is not an op
    // field and not a segment-header field, and it prints INSIDE the block the
    // user confirms against.
    const lines = await forgedPlanLines('completed');
    const note = lines.find((l) => l.includes('ran with --role-arn'));

    expect(note).toBeDefined();
    expect(note).not.toMatch(CTRL);
    expect(note).not.toMatch(INVISIBLE);
    expect(note).toContain('role/De ploy');
    expect(forgedRowCount(lines)).toBe(0);
  });

  it('a field that sanitizes to NOTHING renders the placeholder, not an empty slot', async () => {
    // `logicalId: '\u200b'` is all invisibles. Without the fallback the row
    // reads `- skip      (AWS::...)`, i.e. as if the id were absent -- while
    // the replay still keys on the raw `'\u200b'`. The predicate's
    // `|| UNRENDERABLE` is what keeps the slot visibly filled.
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: { version: 8, stackName: 'S', region: 'us-east-1', resources: {}, outputs: {}, lastModified: 1 },
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
            operations: [
              {
                logicalId: '\u200b',
                changeType: 'CREATE',
                resourceType: 'AWS::S3::Bucket',
                physicalId: 'p',
                provisionedBy: 'sdk',
              },
            ],
          },
        ],
      }),
    });
    await rollbackCommand('S', { ...baseOpts }).catch(() => undefined);
    const row = info.mock.calls.map((c) => String(c[0])).find((l) => /^\s*- skip/.test(l));

    expect(row).toBeDefined();
    expect(row).toContain('<unrenderable> (AWS::S3::Bucket)');
  });

  it('the stack name and region reach every message sanitized on the no-arg path', async () => {
    // With no positional argument the command picks the single journaled
    // stack from a RAW KEY SCAN, so `stackName` / `region` are S3 key segments
    // there -- the same population `state.ts` guards. The plan header and the
    // confirmation prompt are the two lines that matter most.
    const hostileStack = 'Gho\u200bst\n  - delete   RealDatabase (AWS::RDS::DBInstance)';
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: hostileStack, region: 'us-east-1' }]),
      listRawKeys: vi.fn().mockResolvedValue([
        `cdkd/${hostileStack}/us-east-1/rollback-journal.json`,
      ]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: hostileStack,
          region: 'us-east-1',
          resources: {},
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: hostileStack,
        region: 'us-east-1',
        segments: [
          { timestamp: 1, reason: 'auto-rollback-clean', initialDeploy: false, operations: [] },
        ],
      }),
    });
    await rollbackCommand(undefined, { ...baseOpts }).catch(() => undefined);
    const lines = info.mock.calls.map((c) => String(c[0]));

    expect(forgedRowCount(lines)).toBe(0);
    for (const line of lines) {
      expect(line.replace(/^\n/, '')).not.toMatch(CTRL);
      expect(line).not.toMatch(INVISIBLE);
    }
    expect(lines.some((l) => l.includes("Rollback plan for '\"Gho st"))).toBe(true);
  });

  it('the CONFIRMATION PROMPT itself is sanitized', async () => {
    // The prompt is the one line the user answers `y` to. It is reached only
    // without `--force` / `--yes` and on a TTY; the readline mock at the top
    // of this file records the exact text handed to `question()`.
    const hostileStack = 'Gho\u200bst\n  - delete   RealDatabase (AWS::RDS::DBInstance)';
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue('n');
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: hostileStack, region: 'us-east-1' }]),
      listRawKeys: vi.fn().mockResolvedValue([
        `cdkd/${hostileStack}/us-east-1/rollback-journal.json`,
      ]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: hostileStack,
          region: 'us-east-1',
          resources: {},
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: hostileStack,
        region: 'us-east-1',
        segments: [
          { timestamp: 1, reason: 'auto-rollback-clean', initialDeploy: false, operations: [] },
        ],
      }),
    });
    await rollbackCommand(undefined, { ...baseOpts, force: false, yes: false }).catch(
      () => undefined
    );

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    const prompt = String(readlineQuestion.mock.calls[0]![0]);
    expect(prompt).not.toMatch(CTRL);
    expect(prompt).not.toMatch(INVISIBLE);
    expect(prompt).toContain("Roll back '\"Gho st");
  });

  it('the previewState LOOKUPS stay keyed on the RAW logicalId', async () => {
    // The one place sanitizing is WRONG. The preview classifies each older
    // segment against a running copy of state that the newer segments' plan
    // has already mutated, and those mutations index by `op.logicalId`. A
    // sanitized key would delete the wrong entry (nothing), so the older
    // segment's op on the same id would classify as a live `revert` instead
    // of `no longer in state`. This fixture is the only one in the suite whose
    // journal id differs from its sanitized form AND exists in state, which is
    // what makes the two keys observable as different -- an ASCII id cannot.
    const X = 'Vic\u200btim';
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
    const record = {
      physicalId: 'phys-X',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    };
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { [X]: record },
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
          // OLDER: an update of X, replayed second.
          {
            timestamp: 1,
            reason: 'auto-rollback-clean',
            initialDeploy: false,
            operations: [
              {
                logicalId: X,
                changeType: 'UPDATE',
                resourceType: 'AWS::S3::Bucket',
                physicalId: 'phys-X',
                provisionedBy: 'sdk',
                previousState: { ...record, properties: { Old: true } },
              },
            ],
          },
          // NEWER: the create of X, replayed first; its `delete` removes X
          // from the preview, so the older UPDATE must then read as gone.
          {
            timestamp: 2,
            reason: 'auto-rollback-clean',
            initialDeploy: false,
            operations: [
              {
                logicalId: X,
                changeType: 'CREATE',
                resourceType: 'AWS::S3::Bucket',
                physicalId: 'phys-X',
                provisionedBy: 'sdk',
              },
            ],
          },
        ],
      }),
    });
    await rollbackCommand('S', { ...baseOpts }).catch(() => undefined);
    const rows = info.mock.calls.map((c) => String(c[0])).filter((l) => /^\s*- /.test(l));

    expect(rows.some((l) => /^\s*- delete\s+"Vic tim/.test(l))).toBe(true);
    expect(rows.some((l) => /^\s*- skip\s+"Vic tim" .*no longer in state/.test(l))).toBe(true);
    expect(rows.some((l) => /^\s*- revert\s+Vic tim/.test(l))).toBe(false);
  });

  it('the REGION reaches the plan header and the prompt sanitized', async () => {
    // Every other fixture in this file uses `us-east-1`, so un-sanitizing the
    // REGION half of a `${safe(stackName)} (${safe(region)})` pair reddened
    // nothing while the stack-name half was fenced. The region is an S3 key
    // segment on the no-arg path exactly as the stack name is.
    const hostileRegion = 'us-\u200beast-1\n  - delete   RealDatabase (AWS::RDS::DBInstance)';
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue('n');
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as unknown as ReturnType<typeof vi.fn>;
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: hostileRegion }]),
      listRawKeys: vi.fn().mockResolvedValue([`cdkd/S/${hostileRegion}/rollback-journal.json`]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: hostileRegion,
          resources: {},
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: hostileRegion,
        segments: [
          { timestamp: 1, reason: 'auto-rollback-clean', initialDeploy: false, operations: [] },
        ],
      }),
    });
    await rollbackCommand(undefined, { ...baseOpts, force: false, yes: false }).catch(
      () => undefined
    );
    const lines = info.mock.calls.map((c) => String(c[0]));
    const prompt = String(readlineQuestion.mock.calls[0]?.[0] ?? '');

    expect(forgedRowCount(lines)).toBe(0);
    expect(lines.some((l) => l.includes("Rollback plan for 'S' (\"us- east-1"))).toBe(true);
    expect(prompt).not.toMatch(CTRL);
    expect(prompt).not.toMatch(INVISIBLE);
    expect(prompt).toContain('("us- east-1');
  });

  it('the multi-journal CANDIDATE LIST cannot inject a row', async () => {
    // Reached with no argument when more than one stack has a journal. The
    // names and regions come straight from a raw key scan.
    const a = 'Al\u200bpha\n  - delete   RealDatabase (AWS::RDS::DBInstance)';
    const b = 'Be\u200bta';
    installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        `cdkd/${a}/us-east-1/rollback-journal.json`,
        `cdkd/${b}/eu-\u200bwest-1/rollback-journal.json`,
      ]),
    });
    const caught = await rollbackCommand(undefined, { ...baseOpts }).catch((e: unknown) => e);
    const message = (caught as Error).message;

    expect(message).toContain('Multiple stacks have a rollback journal');
    // The list's own newlines are structural; the forged row must not be one.
    expect(message.split('\n').filter((l) => /^\s*- delete\s+Real/.test(l))).toHaveLength(0);
    expect(message).not.toMatch(INVISIBLE);
    // go-to-k/cdkd#3760: a name or region that is not a plain identifier is
    // described, never printed, so neither planted spelling survives.
    expect(message).not.toContain('Al pha');
    expect(message).not.toContain('west-1');
    expect(message).toContain(
      '  - a stack name that is not a plain identifier (us-east-1)\n' +
        '  - a stack name that is not a plain identifier (a region that is not a plain identifier)'
    );
  });

  it('the CANDIDATE LIST cannot wrap a padded name into a counterfeit row (#3760)', async () => {
    // No newline and no invisible character: interior padding alone would
    // wrap on a terminal of the right width, so a folding helper let it through.
    const padded = `ProdStack${' '.repeat(60)}Re-run with: cdkd destroy --all --force #`;
    installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        `cdkd/${padded}/us-east-1/rollback-journal.json`,
        `cdkd/Other/us-east-1/rollback-journal.json`,
      ]),
    });
    const caught = await rollbackCommand(undefined, { ...baseOpts }).catch((e: unknown) => e);
    const message = (caught as Error).message;

    expect(message).toContain('Multiple stacks have a rollback journal');
    expect(message).not.toContain('cdkd destroy');
    expect(message).toContain('  - a stack name that is not a plain identifier (us-east-1)');
    // A plain sibling keeps its identity.
    expect(message).toContain('  - Other (us-east-1)');
    // A described row says where the records are listed as stored.
    expect(message).toContain("list the records as stored with 'cdkd state list --long'");
  });

  it('the CANDIDATE LIST points to the stored records for a described REGION alone (#3760)', async () => {
    installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        `cdkd/Plain/us${' '.repeat(60)}Re-run with: evil #/rollback-journal.json`,
        `cdkd/Other/us-east-1/rollback-journal.json`,
      ]),
    });
    const caught = await rollbackCommand(undefined, { ...baseOpts }).catch((e: unknown) => e);
    const message = (caught as Error).message;

    expect(message).toContain('  - Plain (a region that is not a plain identifier)');
    expect(message).toContain("list the records as stored with 'cdkd state list --long'");
    expect(message).not.toContain('evil');
  });

  it('the CANDIDATE LIST does not cut a legitimate deep nested-stack name', async () => {
    // Issue #3164's cap, at this list rather than at `cdkd state list`. A cdkd
    // state-record name is NOT a CloudFormation stack name: a nested-stack
    // child's is `${parent}~${logicalId}`, applied once per nesting level, so a
    // legitimate deep child runs past `displayIdent`'s 255 default. These rows
    // are what the user copies a `cdkd rollback <stack>` argument OUT of, so a
    // cut one hands them an argument that resolves to nothing -- which is worse
    // than a long row, and is a byte change on a LEGITIMATE value either way.
    //
    // The expected value is built from its own literals (`128`, `255`, `4`)
    // rather than from the constant the subject reads, so a mutation of that
    // constant cannot move both sides together.
    const deepest = `${'R'.repeat(128)}${`~${'L'.repeat(255)}`.repeat(4)}`;
    expect(deepest).toHaveLength(1152);

    installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        `cdkd/${deepest}/us-east-1/rollback-journal.json`,
        `cdkd/Other/us-east-1/rollback-journal.json`,
      ]),
    });
    const caught = await rollbackCommand(undefined, { ...baseOpts }).catch((e: unknown) => e);
    const message = (caught as Error).message;

    expect(message).toContain(`  - ${deepest} (us-east-1)`);
    expect(message).not.toContain('[cut:');
    // Nothing is described, so no pointer is printed.
    expect(message).not.toContain('cdkd state list --long');
  });

  it('the CANDIDATE LIST does not print a planted name past the stack-name cap', async () => {
    // The FLOOR half. Widening a cap is one-sided without it: site-local
    // over-loosening (`maxCodePoints: 999999`) stays green against the case
    // above, so only this one distinguishes "the right cap" from "no cap".
    // Since go-to-k/cdkd#3760 a name past the cap is not a plain identifier, so
    // it is described rather than cut.
    const planted = `P${'q'.repeat(1152)}`;

    installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        `cdkd/${planted}/us-east-1/rollback-journal.json`,
        `cdkd/Other/us-east-1/rollback-journal.json`,
      ]),
    });
    const caught = await rollbackCommand(undefined, { ...baseOpts }).catch((e: unknown) => e);
    const message = (caught as Error).message;

    expect(message).not.toContain('qqqq');
    expect(message).toContain('  - a stack name that is not a plain identifier (us-east-1)');
  });

  it('every stack-name render in this file takes the wider cap, not just the candidate list', () => {
    // PORTED from `state-ref-display-boundary.test.ts`'s fence, after the first
    // version here was measured green under SIX evasions: a new
    // `safe(ref.stackName)` site, `const aliasSafe = safe`, `{ s: safe }.s(...)`,
    // `safe(String(stackName))`, and two existing sites reverted through a
    // template literal. That version was a two-spelling blacklist plus a `>= 10`
    // floor against 11 real sites -- it could not see a rename, and ten of the
    // twelve sites have no other behavioural coverage, so it was their only
    // guard.
    //
    // The working shape counts BARE references against an EXACT total. An alias
    // or an object property is still a reference and still counts, so every
    // evasion above moves the number instead of slipping past a pattern.
    const src = readFileSync(
      new URL('../../../../src/cli/commands/rollback.ts', import.meta.url),
      'utf8'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    // Prove the scan SAW its input first: a stripper that ate the code as well
    // as the comments would satisfy an equality of two zeroes.
    expect(code.length).toBeGreaterThan(20_000);
    expect(code).toContain('function safeStack');
    expect(code).toContain('function safe');

    const safeStackRefs = code.match(/\bsafeStack\b/g) ?? [];
    const safeStackDecls = code.match(/\bfunction\s+safeStack\b/g) ?? [];
    expect(safeStackDecls).toHaveLength(1);

    // 1 declaration + 12 stack-name renders. The twelfth is the corrupted-state
    // key path, which joined its segments BEFORE sanitizing and so rendered the
    // whole `prefix/stack/region` under the identifier default.
    expect(safeStackRefs).toHaveLength(safeStackDecls.length + EXPECTED_STACK_NAME_RENDERS);

    // The `safeStack` total alone catches a render MOVED off the wide cap; it
    // cannot see one ADDED through the weak helper, because that leaves the
    // count untouched -- measured, and it is the first of the six evasions that
    // defeated this fence's previous version. So `safe` carries an exact total
    // too. It is deliberately NOT a spelling blacklist: an alias, an object
    // property and a `safe(String(x))` wrapper are all still references and all
    // still counted.
    //
    // Adding a legitimate `safe(...)` render means updating this number, which
    // is the forcing function -- the reviewer has to say which helper the new
    // value belongs in.
    const safeRefs = code.match(/\bsafe\b/g) ?? [];
    expect(safeRefs).toHaveLength(EXPECTED_SAFE_REFERENCES);

    // The ROLE-ARN class, tracked the same way and for the same reason
    // (go-to-k/cdkd#3397). `\bsafe\b` does not match inside `safeRoleArn` --
    // both sides of the boundary are word characters -- so this total is
    // independent of the one above, exactly as `safeStack`'s is.
    expect(code).toContain('function safeRoleArn');
    const roleArnDecls = code.match(/\bfunction\s+safeRoleArn\b/g) ?? [];
    expect(roleArnDecls).toHaveLength(1);
    const roleArnRefs = code.match(/\bsafeRoleArn\b/g) ?? [];
    expect(roleArnRefs).toHaveLength(roleArnDecls.length + EXPECTED_ROLE_ARN_RENDERS);

    // ...and the cap it carries is the ARN one. Without this the helper could
    // be quietly re-pointed at the 255 default and every count above would
    // still balance -- the "a fence must watch the field it claims" rule.
    expect(code).toMatch(
      /function safeRoleArn\([^)]*\)[^{]*\{\s*return displayIdent\(value, \{ maxCodePoints: ROLE_ARN_MAX_CODE_POINTS \}\);/
    );
  });

  it('the comment stripper does not remove code', () => {
    // Companion to the fence above, ported with it: both totals are exact, so
    // a stripper that ate a line carrying a reference would UNDER-count and
    // read as "no change". Pinned on inputs whose answer is known by eye,
    // including the shape that makes a naive `//` rule wrong -- a `://` inside
    // a URL string.
    const strip = (x: string): string =>
      x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    expect(strip('a(); // safeStack\nb();')).toBe('a(); \nb();');
    expect(strip('/* safeStack */ keep();')).toBe(' keep();');
    expect(strip("const u = 'https://x/y'; safe(r);")).toBe("const u = 'https://x/y'; safe(r);");
  });

  it('SOURCE SHAPE: no plan-label arm interpolates a journal field bare', () => {
    // The per-arm wiring fence. `safe()` itself is pinned above, but each of
    // the ~20 label arms wires it separately, and a hostile fixture reaches
    // only the arms its classification lands on. Reading the source closes the
    // rest at once: a bare `${op.logicalId}` / `${op.resourceType}` /
    // `${op.changeType}` / `${fop.*}` anywhere in this file is a rendered
    // journal field that escaped the predicate. The `previewState[op.logicalId]`
    // LOOKUPS are bracket access, not `${...}`, so they are not matched -- and
    // must not be.
    const src = readFileSync(
      new URL('../../../../src/cli/commands/rollback.ts', import.meta.url),
      'utf8'
    );
    const bare = src.match(/\$\{(?:op|fop)\.(?:logicalId|resourceType|changeType)\}/g) ?? [];

    expect(bare).toEqual([]);
    // The fence sees its input: the wrapped form must be present in numbers.
    expect((src.match(/\$\{safe\((?:op|fop)\.(?:logicalId|resourceType|changeType)\)\}/g) ?? []).length)
      .toBeGreaterThan(20);
  });

  it('a free-form SDK error message takes the DENYLIST, not the allowlist, and cannot forge a row', async () => {
    // The lock-release failure is the most reachable of the free-form renders:
    // any rejection from `releaseLock` lands here. S3's own text echoes the KEY,
    // which embeds the stack name -- so this is journal-adjacent even though
    // the message is the SDK's. Two things are pinned: the newline is gone
    // (the forgery), and a benign non-ASCII character SURVIVES (the class --
    // `asciiOnly` would eat the accented name, which is what makes it the
    // wrong class for prose an operator has to read).
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    installOneCreateSegment();
    mockReleaseLock.mockRejectedValueOnce(
      new Error('AccessDenied for caf\u00e9\n  - delete   RealDatabase (AWS::RDS::DBInstance)')
    );
    await rollbackCommand('S', { ...baseOpts }).catch(() => undefined);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('Failed to release lock'));

    expect(line).toBeDefined();
    expect(line!.split('\n')).toHaveLength(1);
    expect(line).not.toMatch(CTRL);
    expect(line).toContain('caf\u00e9');
    expect(line).toContain('- delete   RealDatabase');
  });

  it('the failed-persist warning renders the S3 error through the DENYLIST too', async () => {
    // The second free-form render. `saveState` is retried once against a fresh
    // ETag, so BOTH attempts have to reject for the warn to fire -- a
    // `mockRejectedValue` (not `Once`) does that.
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    const hostile = 'PreconditionFailed on caf\u00e9\n  - delete   RealDatabase (AWS::RDS::DBInstance)';
    const backend = installOneCreateSegment();
    backend.saveState.mockRejectedValue(new Error(hostile));
    await rollbackCommand('S', { ...baseOpts }).catch(() => undefined);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Failed to persist state after a rollback operation'));

    expect(line).toBeDefined();
    // TWO lines now, and the second is cdkd's own labelled command
    // (go-to-k/cdkd#3436). The invariant is unchanged -- no line comes from the
    // AWS TEXT -- and still exact: the denylist render drops the newline a
    // planted message would need, so a third line could only come from a
    // regression here.
    const lines = line!.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Re-run with: cdkd rollback S$/);
    expect(lines[0]).toContain('caf\u00e9');
    expect(lines[0]).toContain('- delete   RealDatabase');
  });

  // go-to-k/cdkd#3760: a padded name wraps into a counterfeit `Re-run with:`
  // row even with no newline. The backend RE-SPELLS the value (`stackRef`:
  // JSON-quoted, trimmed, folded, cut), so each case builds its error the way
  // the backend does, and every class that alters the spelling is listed.
  const FORGED = `${' '.repeat(60)}Re-run with: cdkd destroy --all --force #`;
  const WITHHELD =
    'its error text names a stack or region that is not a plain identifier, so it is not shown';
  const backendMessage = (name: string, region: string): string =>
    `Failed to save state for stack ${displayStackName(name)} (${displayIdent(region)}): AccessDenied`;
  const PADDED_CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['plain padding', `S${FORGED}`, 'us-east-1'],
    ['a double quote', `S"${FORGED}`, 'us-east-1'],
    ['a backslash', `S\\${FORGED}`, 'us-east-1'],
    ['a trailing space', `S${FORGED} `, 'us-east-1'],
    ['a non-ASCII character', `S\u00e9${FORGED}`, 'us-east-1'],
    ['a control character', `S\u0001${FORGED}`, 'us-east-1'],
    ['a name past the cap', `S${FORGED}${'q'.repeat(1200)}`, 'us-east-1'],
    ['a padded region', 'S', `us${FORGED}`],
    ['a region past the cap', 'S', `us${FORGED}${'p'.repeat(200)}`],
  ];

  it.each(PADDED_CASES)(
    'backendErrorText withholds the backend text for %s',
    (_label, name, region) => {
      // The premise: the value really reaches the backend's message.
      expect(backendMessage(name, region)).toContain('cdkd destroy');
      expect(backendErrorText(new Error(backendMessage(name, region)), name, region)).toBe(WITHHELD);
    }
  );

  it('backendErrorText keeps the text for a plain name, folded to one line', () => {
    expect(backendErrorText(new Error(backendMessage('S', 'us-east-1')), 'S', 'us-east-1')).toBe(
      'Failed to save state for stack S (us-east-1): AccessDenied'
    );
    expect(backendErrorText('boom\nsecond', 'S', 'us-east-1')).not.toContain('\n');
  });

  it('the failed-persist warning withholds the S3 error text for a padded stack (go-to-k/cdkd#3760)', async () => {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    const name = `S"${FORGED}`;
    const backend = installOneCreateSegment(name);
    backend.saveState.mockRejectedValue(new Error(backendMessage(name, 'us-east-1')));
    await rollbackCommand(name, { ...baseOpts }).catch(() => undefined);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Failed to persist state after a rollback operation'));

    expect(line).toBeDefined();
    expect(line).not.toContain('cdkd destroy');
    expect(line).toContain(WITHHELD);
  });

  it('the lock-release warning names neither the padded stack nor its error text (go-to-k/cdkd#3760)', async () => {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    const name = `S${FORGED}`;
    installOneCreateSegment(name);
    mockReleaseLock.mockRejectedValueOnce(
      new Error(`Failed to release lock for ${displayStackName(name)} (us-east-1)`)
    );
    await rollbackCommand(name, { ...baseOpts }).catch(() => undefined);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('Failed to release lock'));

    expect(line).toBeDefined();
    expect(line).not.toContain('cdkd destroy');
    expect(line).toBe(
      `Failed to release lock for a stack name that is not a plain identifier (us-east-1): ${WITHHELD}`
    );
  });

  it('rerunRollback names a plain stack and withholds a padded or newline one (go-to-k/cdkd#3773)', () => {
    // The PADDED name is the one that exercises `plainIdent`: it renders
    // exactly, so the command gate alone would name it shell-quoted. The
    // newline name is already withheld as `altered` without it.
    expect(rerunRollback('S')).toBe('\nRe-run with: cdkd rollback S');
    for (const name of [
      `S${' '.repeat(60)}Re-run with: cdkd destroy --all --force #`,
      'S\nRe-run with: cdkd destroy --all --force #',
    ]) {
      const out = rerunRollback(name);
      expect(out).not.toContain('--all --force');
      expect(out.split('\n').filter((l) => l.startsWith('Re-run with:'))).toEqual([
        "Re-run with: cdkd rollback '<stack>'",
      ]);
      expect(out).toContain("This stack's name");
      expect(out.indexOf("This stack's name")).toBeLessThan(out.indexOf('\nRe-run with:'));
    }
  });

  /**
   * The three `rerunRollback` call sites, each driven with a name that renders
   * exactly (so only `plainIdent` withholds it) -- a helper-level case cannot
   * see a site reverted to the bare gate (go-to-k/cdkd#3773).
   */
  const PADDED_STACK = `S${' '.repeat(60)}Re-run with: cdkd destroy --all --force #`;
  const rerunLines = (message: string): string[] =>
    message.split('\n').filter((l) => l.startsWith('Re-run with:'));

  function installPaddedCreateSegment(): FakeBackend {
    const backend = installOneCreateSegment();
    backend.listStacks.mockResolvedValue([{ stackName: PADDED_STACK, region: 'us-east-1' }]);
    backend.getState.mockResolvedValue({
      state: {
        version: 8,
        stackName: PADDED_STACK,
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
    });
    backend.loadRollbackJournal.mockResolvedValue({
      journalVersion: 1,
      stackName: PADDED_STACK,
      region: 'us-east-1',
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
    });
    return backend;
  }

  it('the failed-persist WARNING names no padded stack on its Re-run line (go-to-k/cdkd#3773)', async () => {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    const backend = installPaddedCreateSegment();
    backend.saveState.mockRejectedValue(new Error('PreconditionFailed'));
    await rollbackCommand(PADDED_STACK, { ...baseOpts }).catch(() => undefined);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Failed to persist state after a rollback operation'));

    expect(line).toBeDefined();
    expect(rerunLines(line!)).toEqual(["Re-run with: cdkd rollback '<stack>'"]);
  });

  it('the INTERRUPTED refusal names no padded stack on its Re-run line (go-to-k/cdkd#3773)', async () => {
    // Fire ONLY the listeners the command added, during the replayed delete
    // (the pattern in tests/unit/cli/rollback-lock-release-ordering.test.ts).
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const preExisting = new Set(process.listeners('SIGINT'));
    replayProvider.delete.mockImplementationOnce(async () => {
      for (const listener of process.listeners('SIGINT')) {
        if (preExisting.has(listener)) continue;
        (listener as unknown as () => void)();
      }
    });
    installPaddedCreateSegment();
    let err: unknown;
    try {
      err = await rollbackCommand(PADDED_STACK, { ...baseOpts }).catch((e) => e);
    } finally {
      process.stderr.write = realWrite;
    }

    expect(err).toBeInstanceOf(PartialFailureError);
    expect((err as Error).message).toContain('Rollback interrupted');
    expect(rerunLines((err as Error).message)).toEqual(["Re-run with: cdkd rollback '<stack>'"]);
  });

  it('the FAILED-OPERATIONS refusal names no padded stack on its Re-run line (go-to-k/cdkd#3773)', async () => {
    replayProvider.delete.mockClear();
    replayProvider.delete.mockRejectedValueOnce(new Error('AWS delete boom'));
    installPaddedCreateSegment();
    const err = await rollbackCommand(PADDED_STACK, { ...baseOpts }).catch((e) => e);

    expect(err).toBeInstanceOf(PartialFailureError);
    expect((err as Error).message).toContain('failed operation(s)');
    expect(rerunLines((err as Error).message)).toEqual(["Re-run with: cdkd rollback '<stack>'"]);
  });

  it('the failed-strip warning renders the S3 error through the DENYLIST too', async () => {
    // The third free-form render, reached only under `--revert-failed` after a
    // failed op has been replayed and the per-op strip of the journal rejects.
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    const hostile = 'NoSuchKey on caf\u00e9\n  - delete   RealDatabase (AWS::RDS::DBInstance)';
    const failedOp = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-Q',
      previousState: {
        physicalId: 'phys-Q',
        resourceType: 'AWS::SQS::Queue',
        properties: { a: 1 },
        attributes: {},
        dependencies: [],
      },
      attemptedProperties: { a: 2 },
    };
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: {
            Q: {
              physicalId: 'phys-Q',
              resourceType: 'AWS::SQS::Queue',
              properties: { a: 1 },
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
          {
            timestamp: 1,
            reason: 'no-rollback-failure',
            initialDeploy: false,
            operations: [],
            failedOperations: [failedOp],
          },
        ],
      }),
      setRollbackJournalFailedOperations: vi.fn().mockRejectedValue(new Error(hostile)),
    });
    await rollbackCommand('S', { ...baseOpts, revertFailed: true }).catch(() => undefined);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Failed to strip replayed failed-ops'));

    expect(line).toBeDefined();
    expect(line!.split('\n')).toHaveLength(1);
    expect(line).toContain('caf\u00e9');
    expect(line).toContain('- delete   RealDatabase');
  });

  it('the failed-strip warning withholds the S3 error text for a padded stack (go-to-k/cdkd#3760)', async () => {
    // The third free-form render, reached only under `--revert-failed` after a
    // failed op has been replayed and the per-op strip of the journal rejects.
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    const name = `S"${FORGED}`;
    const hostile = backendMessage(name, 'us-east-1');
    const failedOp = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-Q',
      previousState: {
        physicalId: 'phys-Q',
        resourceType: 'AWS::SQS::Queue',
        properties: { a: 1 },
        attributes: {},
        dependencies: [],
      },
      attemptedProperties: { a: 2 },
    };
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: name, region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: name,
          region: 'us-east-1',
          resources: {
            Q: {
              physicalId: 'phys-Q',
              resourceType: 'AWS::SQS::Queue',
              properties: { a: 1 },
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
        stackName: name,
        region: 'us-east-1',
        segments: [
          {
            timestamp: 1,
            reason: 'no-rollback-failure',
            initialDeploy: false,
            operations: [],
            failedOperations: [failedOp],
          },
        ],
      }),
      setRollbackJournalFailedOperations: vi.fn().mockRejectedValue(new Error(hostile)),
    });
    await rollbackCommand(name, { ...baseOpts, revertFailed: true }).catch(() => undefined);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Failed to strip replayed failed-ops'));

    expect(line).toBeDefined();
    expect(line).not.toContain('cdkd destroy');
    expect(line).toContain(WITHHELD);
  });
});

describe('rollbackCommand — nested-stack rows (issue #3754)', () => {
  const nestedRecord = {
    physicalId: 'arn:child',
    resourceType: 'AWS::CloudFormation::Stack',
    properties: { TemplateURL: 'new' },
    attributes: {},
    dependencies: [],
  };
  const updateOp = (templateUrl: string) => ({
    logicalId: 'Child',
    changeType: 'UPDATE',
    resourceType: 'AWS::CloudFormation::Stack',
    physicalId: 'arn:child',
    previousState: { ...nestedRecord, properties: { TemplateURL: templateUrl } },
  });
  const parentState = {
    state: {
      version: 8,
      stackName: 'S',
      region: 'us-east-1',
      resources: { Child: nestedRecord },
      outputs: {},
      lastModified: 1,
    },
    etag: 'e0',
  };
  const childJournal = {
    journalVersion: 1,
    stackName: 'S~Child',
    region: 'us-east-1',
    segments: [
      { runId: 'r1', timestamp: 1, reason: 'nested-pending-parent', initialDeploy: false, operations: [] },
      { runId: 'r2', timestamp: 2, reason: 'nested-pending-parent', initialDeploy: false, operations: [] },
    ],
  };

  it('reverts each nested row inside its segment run, and drops that run pending child segments after the pop', async () => {
    const { getNestedRevertRun } = await import('../../../../src/deployment/nested-child-journal.js');
    const seenRuns: unknown[] = [];
    replayProvider.update.mockReset();
    replayProvider.update.mockImplementation(async () => {
      seenRuns.push(getNestedRevertRun());
      return { physicalId: 'arn:child', wasReplaced: false };
    });
    const dropRollbackJournalSegments = vi.fn().mockResolvedValue(1);
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockImplementation(async (name: string) => (name === 'S' ? parentState : null)),
      loadRollbackJournal: vi.fn().mockImplementation(async (name: string) =>
        name === 'S'
          ? {
              journalVersion: 1,
              stackName: 'S',
              region: 'us-east-1',
              segments: [
                // A DIFFERENT previous record per segment, so the older one is
                // not classified as already done once the newer one restored.
                { runId: 'r1', timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [updateOp('oldest')] },
                { runId: 'r2', timestamp: 2, reason: 'no-rollback-failure', initialDeploy: false, operations: [updateOp('old')] },
              ],
            }
          : childJournal
      ),
      ...({ dropRollbackJournalSegments } as object),
    });

    await expect(rollbackCommand('S', { ...baseOpts })).resolves.toBeUndefined();

    // Newest segment first, each nested row revert carrying ITS segment's run.
    expect(seenRuns).toEqual([{ runId: 'r2' }, { runId: 'r1' }]);
    expect(dropRollbackJournalSegments).toHaveBeenCalledTimes(2);
    const predicates = dropRollbackJournalSegments.mock.calls.map(
      (c) => [c[0], c[2]] as [string, (s: { runId?: string; reason?: string }) => boolean]
    );
    expect(predicates.map(([name]) => name)).toEqual(['S~Child', 'S~Child']);
    const pending = (runId: string) => ({ runId, reason: 'nested-pending-parent' });
    expect(predicates[0]![1](pending('r2'))).toBe(true);
    expect(predicates[0]![1](pending('r1'))).toBe(false);
    expect(predicates[1]![1](pending('r1'))).toBe(true);
    expect(predicates[1]![1]({ runId: 'r1', reason: 'no-rollback-failure' })).toBe(false);
  });

  it('a failed nested revert keeps the segment AND the child segments', async () => {
    replayProvider.update.mockReset();
    replayProvider.update.mockRejectedValue(new Error('Cannot revert nested stack S~Child'));
    const dropRollbackJournalSegments = vi.fn().mockResolvedValue(1);
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockImplementation(async (name: string) => (name === 'S' ? parentState : null)),
      loadRollbackJournal: vi.fn().mockImplementation(async (name: string) =>
        name === 'S'
          ? {
              journalVersion: 1,
              stackName: 'S',
              region: 'us-east-1',
              segments: [
                { runId: 'r1', timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [updateOp('old')] },
              ],
            }
          : childJournal
      ),
      ...({ dropRollbackJournalSegments } as object),
    });

    await expect(rollbackCommand('S', { ...baseOpts })).rejects.toBeInstanceOf(PartialFailureError);
    expect(backend.popRollbackJournalSegment).not.toHaveBeenCalled();
    expect(dropRollbackJournalSegments).not.toHaveBeenCalled();
  });

  it('a nested row the segment did NOT revert keeps its child journal', async () => {
    replayProvider.delete.mockClear();
    const dropRollbackJournalSegments = vi.fn().mockResolvedValue(1);
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockImplementation(async (name: string) =>
        name === 'S'
          ? {
              ...parentState,
              state: {
                ...parentState.state,
                resources: {
                  Child: nestedRecord,
                  Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {}, attributes: {}, dependencies: [] },
                },
              },
            }
          : null
      ),
      loadRollbackJournal: vi.fn().mockImplementation(async (name: string) =>
        name === 'S'
          ? {
              journalVersion: 1,
              stackName: 'S',
              region: 'us-east-1',
              segments: [
                {
                  runId: 'r1',
                  timestamp: 1,
                  reason: 'no-rollback-failure',
                  initialDeploy: false,
                  operations: [{ logicalId: 'Bucket', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'b' }],
                },
              ],
            }
          : childJournal
      ),
      ...({ dropRollbackJournalSegments } as object),
    });

    await expect(rollbackCommand('S', { ...baseOpts })).resolves.toBeUndefined();

    expect(replayProvider.delete).toHaveBeenCalled();
    expect(dropRollbackJournalSegments).not.toHaveBeenCalled();
  });

  it('REFUSES to roll back a stack whose journal holds a nested pending record, naming the parent', async () => {
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S~Child', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({ ...parentState, state: { ...parentState.state, stackName: 'S~Child' } }),
      loadRollbackJournal: vi.fn().mockResolvedValue(childJournal),
    });

    await expect(rollbackCommand('S~Child', { ...baseOpts })).rejects.toThrow(
      /its parent has not settled[\s\S]*Roll back the parent stack/
    );
    expect(backend.popRollbackJournalSegment).not.toHaveBeenCalled();
    expect(backend.saveState).not.toHaveBeenCalled();
  });

  it('the plan names what the nested child replay will do, and a missing record', async () => {
    const { getLogger } = await import('../../../../src/utils/logger.js');
    const info = getLogger().info as ReturnType<typeof vi.fn>;
    info.mockClear();
    replayProvider.update.mockReset();
    replayProvider.update.mockResolvedValue({ physicalId: 'arn:child', wasReplaced: false });
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockImplementation(async (name: string) =>
        name === 'S'
          ? parentState
          : {
              state: {
                version: 8,
                stackName: 'S~Child',
                region: 'us-east-1',
                resources: { Db: { physicalId: 'db-1', resourceType: 'AWS::SQS::Queue', properties: {}, attributes: {}, dependencies: [] } },
                outputs: {},
                lastModified: 1,
              },
              etag: 'c0',
            }
      ),
      loadRollbackJournal: vi.fn().mockImplementation(async (name: string) =>
        name === 'S'
          ? {
              journalVersion: 1,
              stackName: 'S',
              region: 'us-east-1',
              segments: [
                { runId: 'r1', timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [updateOp('old')] },
                { runId: 'r9', timestamp: 2, reason: 'no-rollback-failure', initialDeploy: false, operations: [updateOp('older')] },
              ],
            }
          : {
              ...childJournal,
              segments: [
                {
                  runId: 'r1',
                  timestamp: 1,
                  reason: 'nested-pending-parent',
                  initialDeploy: false,
                  operations: [{ logicalId: 'Db', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue', physicalId: 'db-1' }],
                },
              ],
            }
      ),
      ...({ dropRollbackJournalSegments: vi.fn().mockResolvedValue(1) } as object),
    });

    await rollbackCommand('S', { ...baseOpts }).catch(() => undefined);

    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('nested stack S~Child replays its own journal'))).toBe(true);
    expect(lines.some((l) => l.includes('Db'))).toBe(true);
    // The r9 segment has no child record: the plan says the revert will fail.
    expect(lines.some((l) => l.includes('no journal record for this run'))).toBe(true);
  });

  it('--skip-final-snapshot reaches the nested context a child revert replays through', async () => {
    for (const skip of [true, false]) {
      nestedCtx.last = undefined;
      replayProvider.update.mockReset();
      replayProvider.update.mockResolvedValue({ physicalId: 'arn:child', wasReplaced: false });
      installSetup({
        listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
        getState: vi.fn().mockImplementation(async (name: string) => (name === 'S' ? parentState : null)),
        loadRollbackJournal: vi.fn().mockImplementation(async (name: string) =>
          name === 'S'
            ? {
                journalVersion: 1,
                stackName: 'S',
                region: 'us-east-1',
                segments: [
                  { runId: 'r1', timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [updateOp('old')] },
                ],
              }
            : childJournal
        ),
        ...({ dropRollbackJournalSegments: vi.fn().mockResolvedValue(1) } as object),
      });

      await rollbackCommand('S', { ...baseOpts, ...(skip && { skipFinalSnapshot: true }) });

      const destroyOptions = nestedCtx.last?.['destroyOptions'] as Record<string, unknown>;
      expect(destroyOptions['skipFinalSnapshot'] === true).toBe(skip);
    }
  });

  it('no arg: the parent filter compares the REGION too', async () => {
    installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        'cdkd/A/us-east-1/rollback-journal.json',
        'cdkd/A~Child/eu-west-1/rollback-journal.json',
      ]),
    });
    // The parent's journal is in ANOTHER region, so the child is its own choice.
    await expect(rollbackCommand(undefined, { ...baseOpts })).rejects.toThrow(/Multiple stacks/);
  });
});
