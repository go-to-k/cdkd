/**
 * Issue go-to-k/cdkd#3370 — `cdkd rollback` over a state record whose BODY
 * `region` disagrees with the KEY it was read from.
 *
 * `getState` reports that as `divergentBodyRegion` and normalizes the record to
 * the key's region, and the replay then acts there: a rolled-back CREATE's
 * delete that comes back not-found is read as "already gone", the row is
 * dropped and saved, and the resource stays live in the other region. The
 * destroy path refuses such a record (go-to-k/cdkd#3328); this is the rollback
 * half.
 *
 * Two call sites read the record, and each gets its own cases:
 *
 *  1. the start-of-run read — refused before the plan, the prompt and every
 *     replay arm. One case PER ARM that calls AWS, each with a control proving
 *     the same journal reaches that arm's provider call when the record agrees,
 *     so a refusal placed below any one arm reds here.
 *  2. the retry save's re-read after a lost conditional write — a rewrite that
 *     now diverges is NOT written over.
 *
 * The getState double is `readAtKeyRegion`, which reports divergence the way
 * production does; a double returning the stored record verbatim reports none
 * and every refusal case here would pass against a command that never refuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import { readAtKeyRegion } from '../_state-read-double.js';

const logger = vi.hoisted(() => {
  const l: Record<string, unknown> = {};
  Object.assign(l, {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  });
  return l as {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
});
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => logger }));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

const replayProvider = {
  delete: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue({ physicalId: 'p' }),
  create: vi.fn().mockResolvedValue({ physicalId: 'old' }),
};
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: replayProvider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
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
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';
import { STATE_REGION_DIVERGED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

const KEY_REGION = 'us-east-1';
/** The body's value. Region-shaped on purpose: it is the one a message must NOT print. */
const BODY_REGION = 'eu-west-1';
const STACK = 'S';
const TYPE = 'AWS::SSM::Parameter';

type Arm = {
  label: string;
  /** The provider call this arm makes when the record agrees with its key. */
  reaches: 'delete' | 'update' | 'create';
  revertFailed?: boolean;
  resources: StackState['resources'];
  segment: Record<string, unknown>;
};

/**
 * One journal per replay arm that calls AWS. Built FRESH per call: the command
 * drains `journal.segments` in memory, so a shared object leaves a later case
 * reading "nothing to roll back".
 */
const ARMS: Arm[] = [
  {
    label: 'a rolled-back CREATE (delete)',
    reaches: 'delete',
    resources: { A: { physicalId: 'p', resourceType: TYPE, properties: {} } },
    segment: {
      operations: [{ logicalId: 'A', changeType: 'CREATE', resourceType: TYPE, physicalId: 'p' }],
    },
  },
  {
    label: 'an in-place UPDATE (revert)',
    reaches: 'update',
    resources: { A: { physicalId: 'p', resourceType: TYPE, properties: { Value: 'new' } } },
    segment: {
      operations: [
        {
          logicalId: 'A',
          changeType: 'UPDATE',
          resourceType: TYPE,
          physicalId: 'p',
          properties: { Value: 'new' },
          previousState: { physicalId: 'p', resourceType: TYPE, properties: { Value: 'old' } },
        },
      ],
    },
  },
  {
    label: 'a replacement UPDATE (reverse-replacement re-CREATE)',
    reaches: 'create',
    resources: { A: { physicalId: 'new', resourceType: TYPE, properties: { Value: 'new' } } },
    segment: {
      operations: [
        {
          logicalId: 'A',
          changeType: 'UPDATE',
          resourceType: TYPE,
          physicalId: 'new',
          properties: { Value: 'new' },
          previousResourceType: TYPE,
          oldResourceRetained: false,
          previousState: { physicalId: 'old', resourceType: TYPE, properties: { Value: 'old' } },
        },
      ],
    },
  },
  {
    label: 'a failed CREATE under --revert-failed (delete)',
    reaches: 'delete',
    revertFailed: true,
    resources: { A: { physicalId: 'p', resourceType: TYPE, properties: {} } },
    segment: {
      operations: [],
      failedOperations: [
        { logicalId: 'A', changeType: 'CREATE', resourceType: TYPE, physicalId: 'p' },
      ],
    },
  },
  {
    label: 'a failed UPDATE under --revert-failed (forced update)',
    reaches: 'update',
    revertFailed: true,
    resources: { A: { physicalId: 'p', resourceType: TYPE, properties: { Value: 'old' } } },
    segment: {
      operations: [],
      failedOperations: [
        {
          logicalId: 'A',
          changeType: 'UPDATE',
          resourceType: TYPE,
          physicalId: 'p',
          attemptedProperties: { Value: 'new' },
          previousState: { physicalId: 'p', resourceType: TYPE, properties: { Value: 'old' } },
        },
      ],
    },
  },
];

function install(opts: {
  resources: StackState['resources'];
  segment: Record<string, unknown>;
  /** Body region of the record at the start-of-run read. */
  bodyRegion: string;
  /** Body region of the record at the retry save's re-read; omitted = no retry. */
  rereadBodyRegion?: string;
}) {
  const popRollbackJournalSegment = vi.fn().mockResolvedValue(0);
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const record = (bodyRegion: string): StackState => ({
    version: 9,
    stackName: STACK,
    region: bodyRegion,
    resources: structuredClone(opts.resources),
    outputs: {},
    lastModified: 1,
  });
  const getState = vi
    .fn()
    .mockResolvedValueOnce(readAtKeyRegion(record(opts.bodyRegion), KEY_REGION));
  const saveState = vi.fn();
  if (opts.rereadBodyRegion !== undefined) {
    // The first conditional save loses (a rewrite under the run), which is the
    // ONLY route to the re-read; the second call is the one under test.
    getState.mockResolvedValueOnce(readAtKeyRegion(record(opts.rereadBodyRegion), KEY_REGION));
    saveState.mockRejectedValueOnce(new Error('PreconditionFailed'));
  }
  saveState.mockResolvedValue('etag-2');
  setupMock.mockResolvedValue({
    stateBackend: {
      listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: KEY_REGION }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState,
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: STACK,
        region: KEY_REGION,
        segments: [structuredClone(opts.segment)],
      }),
      saveState,
      popRollbackJournalSegment,
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState,
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    awsClients: {},
    region: KEY_REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
  return { getState, saveState, popRollbackJournalSegment, deleteState };
}

const opts = (revertFailed?: boolean) =>
  ({
    yes: true,
    stateBucket: 'b',
    region: KEY_REGION,
    ...(revertFailed && { revertFailed: true }),
  }) as unknown as Parameters<typeof rollbackCommand>[1];

function awsCalls(): number {
  return (
    replayProvider.delete.mock.calls.length +
    replayProvider.update.mock.calls.length +
    replayProvider.create.mock.calls.length
  );
}

describe('cdkd rollback refuses a record whose body region diverged from its key (go-to-k/cdkd#3370)', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const arm of ARMS) {
    it(`refuses before ${arm.label}, calling nothing and saving nothing`, async () => {
      const h = install({ ...arm, bodyRegion: BODY_REGION });
      const thrown = await rollbackCommand(STACK, opts(arm.revertFailed)).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_REGION_DIVERGED);
      expect(awsCalls(), 'a replay arm reached AWS before the refusal').toBe(0);
      expect(h.saveState).not.toHaveBeenCalled();
    });

    it(`CONTROL: the same journal reaches ${arm.label} when the record agrees`, async () => {
      // DRIVEN to the arm's own provider call — a control that fails early for
      // an unrelated reason would make the refusal case above vacuous.
      install({ ...arm, bodyRegion: KEY_REGION });
      const thrown = await rollbackCommand(STACK, opts(arm.revertFailed)).catch((e: unknown) => e);
      expect((thrown as { code?: string } | undefined)?.code).not.toBe(STATE_REGION_DIVERGED);
      expect(
        replayProvider[arm.reaches],
        `the control never reached ${arm.reaches}(), so it proves nothing about the refusal`
      ).toHaveBeenCalled();
    });
  }

  it('prints the KIND of the body value, never the value, and names what the replay would do', async () => {
    install({ ...ARMS[0]!, bodyRegion: BODY_REGION });
    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);
    const message = (thrown as CdkdError).message;
    expect(message).toContain("cdkd will not roll back 'S' (us-east-1)");
    expect(message).toContain('(a string)');
    expect(message).toContain('it still lists 1 resource ');
    expect(message).toContain('ALREADY DELETED');
    // The misdirection channel: a printed region is one to aim a re-run at.
    expect(message).not.toContain(BODY_REGION);
    // A rollback, not a destroy — the destroy builder's wording must not leak in.
    expect(message).not.toMatch(/will not destroy/);
  });

  it('lets a resource-LESS divergent record through, where no arm can reach AWS', async () => {
    // The conjunction: every AWS-calling arm needs a current row, so a record
    // listing none replays only skips — and refusing it would strand the
    // record the way the destroy sibling's note describes.
    const h = install({
      resources: {},
      segment: ARMS[0]!.segment,
      bodyRegion: BODY_REGION,
    });
    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);
    expect((thrown as { code?: string } | undefined)?.code).not.toBe(STATE_REGION_DIVERGED);
    expect(awsCalls()).toBe(0);
    // Ran to completion — the segment was replayed and popped — rather than
    // failing early for some other reason.
    expect(thrown).toBeUndefined();
    expect(h.popRollbackJournalSegment).toHaveBeenCalledTimes(1);
  });
});

describe('cdkd rollback does not write over a record rewritten mid-run with a divergent region (go-to-k/cdkd#3370)', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * An initial-deploy segment with TWO rolled-back CREATEs, so the run could
   * both keep replaying after the decline and, with the record emptied, reach
   * the terminal `deleteState` — the two things declining the save must stop.
   */
  const TWO_CREATES = {
    resources: {
      A: { physicalId: 'pa', resourceType: TYPE, properties: {} },
      B: { physicalId: 'pb', resourceType: TYPE, properties: {} },
    },
    segment: {
      initialDeploy: true,
      operations: [
        { logicalId: 'A', changeType: 'CREATE', resourceType: TYPE, physicalId: 'pa' },
        { logicalId: 'B', changeType: 'CREATE', resourceType: TYPE, physicalId: 'pb' },
      ],
    },
  };

  it('declines the retry save, stops the replay, keeps the journal and the record, exits partial', async () => {
    const h = install({ ...TWO_CREATES, bodyRegion: KEY_REGION, rereadBodyRegion: BODY_REGION });
    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);
    // The re-read happened (so the case reached the site under test)...
    expect(h.getState).toHaveBeenCalledTimes(2);
    // ...and only the LOST first attempt was a save: nothing wrote over the rewrite.
    expect(h.saveState, 'the retry wrote the key region over a divergent rewrite').toHaveBeenCalledTimes(1);
    // The replay stopped after the op whose save was declined.
    expect(replayProvider.delete, 'the replay kept going after the decline').toHaveBeenCalledTimes(1);
    // The segment stays, so the re-run has something to replay and meets the refusal...
    expect(h.popRollbackJournalSegment).not.toHaveBeenCalled();
    // ...and the record the save declined to overwrite is not deleted either.
    expect(h.deleteState).not.toHaveBeenCalled();
    expect((thrown as Error).constructor.name).toBe('PartialFailureError');
    expect((thrown as Error).message).toContain('Rollback stopped');
    expect((thrown as Error).message).not.toContain('interrupted');
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("carries a 'region' of its own (a string)");
    expect(warned).not.toContain(BODY_REGION);
    expect((thrown as Error).message).not.toContain(BODY_REGION);
  });

  it('stops the --revert-failed replay too, and the completed ops after it', async () => {
    // Two failed CREATEs replayed before one completed CREATE: the decline on
    // the first failed op's save must stop the second AND the completed op.
    const h = install({
      resources: {
        A: { physicalId: 'pa', resourceType: TYPE, properties: {} },
        B: { physicalId: 'pb', resourceType: TYPE, properties: {} },
        C: { physicalId: 'pc', resourceType: TYPE, properties: {} },
      },
      segment: {
        failedOperations: [
          { logicalId: 'A', changeType: 'CREATE', resourceType: TYPE, physicalId: 'pa' },
          { logicalId: 'B', changeType: 'CREATE', resourceType: TYPE, physicalId: 'pb' },
        ],
        operations: [{ logicalId: 'C', changeType: 'CREATE', resourceType: TYPE, physicalId: 'pc' }],
      },
      bodyRegion: KEY_REGION,
      rereadBodyRegion: BODY_REGION,
    });
    const thrown = await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);
    expect(h.getState).toHaveBeenCalledTimes(2);
    expect(replayProvider.delete, 'the replay kept going after the decline').toHaveBeenCalledTimes(1);
    expect(h.popRollbackJournalSegment).not.toHaveBeenCalled();
    expect((thrown as Error).message).toContain('Rollback stopped');
  });

  it('declines on the LAST op of a segment too: no pop, no deleteState', async () => {
    // The replay never sees an interrupt here (there is no next op to stop
    // before), so the pop and the terminal delete are guarded on their own.
    const h = install({ ...ARMS[0]!, segment: { ...ARMS[0]!.segment, initialDeploy: true }, bodyRegion: KEY_REGION, rereadBodyRegion: BODY_REGION });
    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);
    expect(h.getState).toHaveBeenCalledTimes(2);
    expect(replayProvider.delete).toHaveBeenCalledTimes(1);
    expect(h.popRollbackJournalSegment).not.toHaveBeenCalled();
    expect(h.deleteState).not.toHaveBeenCalled();
    expect((thrown as Error).message).toContain('Rollback stopped');
  });

  it('CONTROL: an agreeing re-read is saved over, the replay finishes, and the record is removed', async () => {
    const h = install({ ...TWO_CREATES, bodyRegion: KEY_REGION, rereadBodyRegion: KEY_REGION });
    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);
    expect(thrown).toBeUndefined();
    expect(h.getState).toHaveBeenCalledTimes(2);
    // Lost first save + its retry, then the second op's save.
    expect(h.saveState).toHaveBeenCalledTimes(3);
    expect(replayProvider.delete).toHaveBeenCalledTimes(2);
    expect(h.popRollbackJournalSegment).toHaveBeenCalledTimes(1);
    expect(h.deleteState).toHaveBeenCalledTimes(1);
  });
});
