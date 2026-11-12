/**
 * go-to-k/cdkd#6120: the rollback of a custom resource whose `Update` handler
 * answered a new `PhysicalResourceId`. The forward deploy left the old id live
 * (its Delete waits for the cleanup phase a failed deploy never reaches,
 * #6117), so CloudFormation reverts it with an `Update` to the NEW id carrying
 * the old properties, never a `Create` of the old id, and deletes whichever id
 * the stack no longer records once the rollback completes. A rollback
 * `Update` that moves any resource's id off the one it was sent to leaves that
 * id with the handler too, so it gets the same Delete.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  classifyRollbackOp,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { newMovedIdCleanupQueue } from '../../../src/deployment/rollback-executor/replay-moved-id-cleanup.js';
import {
  markDeleteFirstBlocked,
  deleteFirstBlocker,
} from '../../../src/deployment/rollback-executor/plan/delete-first.js';
import { supersededAfterRollback } from '../../../src/deployment/superseded-resources.js';
import type { ResourceState, SupersededResourceRecord } from '../../../src/types/state.js';
import type { ResourceUpdateResult } from '../../../src/types/resource.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const CR = 'Custom::Thing';
const TOPIC = 'AWS::SNS::Topic';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:handler';
const OLD_PROPS = { ServiceToken: TOKEN, Name: 'name-1' };
const NEW_PROPS = { ServiceToken: TOKEN, Name: 'name-2' };

const printed = { info: [] as string[], warn: [] as string[] };
const logger = {
  debug: vi.fn(),
  info: vi.fn((m: unknown) => printed.info.push(String(m))),
  warn: vi.fn((m: unknown) => printed.warn.push(String(m))),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

function record(physicalId: string, properties: Record<string, unknown>, extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId,
    resourceType: CR,
    properties,
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    ...extra,
  };
}

/** The journaled forward op: `Res` moved from name-1 to name-2. */
function movedOp(overrides: Partial<CompletedOperation> = {}): CompletedOperation {
  return {
    logicalId: 'Res',
    changeType: 'UPDATE',
    resourceType: CR,
    provisionedBy: 'sdk',
    physicalId: 'name-2',
    properties: NEW_PROPS,
    previousState: record('name-1', OLD_PROPS),
    previousResourceType: CR,
    oldResourceRetained: false,
    oldDeletedBeforeCreate: false,
    wasReplaced: true,
    oldPhysicalIdLeftForCleanup: true,
    ...overrides,
  };
}

/** A completed op before `Res`, so its revert runs AFTER `Res`'s. */
const topicOp: CompletedOperation = {
  logicalId: 'Topic',
  changeType: 'UPDATE',
  resourceType: TOPIC,
  provisionedBy: 'sdk',
  physicalId: 'topic',
  previousState: record('topic', { DisplayName: 'v1' }, { resourceType: TOPIC }),
  wasReplaced: false,
};

describe('rollback of a custom resource whose Update moved its id (#6120)', () => {
  let calls: string[];
  /** What the handler answers to the rollback Update of `Res`. */
  let answer: string;
  let deleteMode: 'ok' | 'throw' | 'skip';
  /** Whether a moved answer says the id moved off is left live (the CR provider does). */
  let leavesOld: boolean;
  /** A provider flagging the id it kept (never the CR provider): nothing may be deleted. */
  let flagSameId: boolean;
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let ctx: RollbackExecutorContext;
  let recorded: Record<string, unknown>[];

  beforeEach(() => {
    calls = [];
    printed.info.length = 0;
    printed.warn.length = 0;
    answer = 'name-1';
    deleteMode = 'ok';
    leavesOld = true;
    flagSameId = false;
    provider = {
      create: vi.fn(async (logicalId: string, _t: string, props: Record<string, unknown>) => {
        calls.push(`create ${logicalId} ${String(props['Name'])}`);
        return { physicalId: String(props['Name']), attributes: {} };
      }),
      update: vi.fn(
        async (logicalId: string, physicalId: string): Promise<ResourceUpdateResult> => {
          calls.push(`update ${logicalId} ${physicalId}`);
          if (logicalId !== 'Res') return { physicalId, wasReplaced: false };
          return {
            physicalId: answer,
            wasReplaced: answer !== physicalId,
            ...(leavesOld &&
              (answer !== physicalId || flagSameId) && { oldPhysicalIdLeftForCleanup: true as const }),
            attributes: {},
          };
        }
      ),
      delete: vi.fn(async (logicalId: string, physicalId: string) => {
        calls.push(`delete ${logicalId} ${physicalId}`);
        if (deleteMode === 'throw') throw new Error('the handler Lambda timed out');
        if (deleteMode === 'skip') {
          return { outcome: 'skipped' as const, reason: 'the Delete handler returned FAILED' };
        }
        return undefined;
      }),
    };
    recorded = [];
    ctx = {
      region: 'us-east-1',
      logger,
      recordEvent: (event) => {
        recorded.push(event as unknown as Record<string, unknown>);
      },
      providerRegistry: {
        getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
  });

  async function replay(
    opts: {
      op?: CompletedOperation;
      live?: ResourceState;
      others?: Record<string, ResourceState>;
      interruptAfterRes?: boolean;
      /** The save after the Delete settles the entry throws. */
      settleSaveFails?: boolean;
    } = {}
  ) {
    const state: Record<string, ResourceState> = {
      Res: opts.live ?? record('name-2', NEW_PROPS),
      Topic: record('topic', { DisplayName: 'v2' }, { resourceType: TOPIC }),
      ...opts.others,
    };
    const superseded: SupersededResourceRecord[] = [];
    const events: string[] = [];
    let interrupted = false;
    const outcome = await replayRollback([topicOp, opts.op ?? movedOp()], state, 'S', ctx, {
      afterOp: (id) => {
        events.push(`save ${id} ${superseded.map((e) => e.state.physicalId).join(',')}`);
        if (opts.interruptAfterRes && id === 'Res') interrupted = true;
        if (opts.settleSaveFails && id === 'Res' && events.length > 2) {
          throw new Error('PreconditionFailed: state changed');
        }
      },
      isInterrupted: () => interrupted,
      onSuperseded: (entry) => superseded.push(entry),
      onSupersededSettled: (entry) => superseded.splice(superseded.indexOf(entry), 1),
    });
    return { outcome, state, superseded, events };
  }

  it('sends the NEW id an Update with the old properties, never a Create, then deletes it', async () => {
    const { outcome, state, superseded, events } = await replay();
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.update).toHaveBeenCalledWith(
      'Res',
      'name-2',
      CR,
      OLD_PROPS,
      NEW_PROPS,
      expect.objectContaining({ replayingState: true })
    );
    // The Delete waits until every op has been reverted.
    expect(calls).toEqual(['update Res name-2', 'update Topic topic', 'delete Res name-2']);
    expect(provider.delete).toHaveBeenCalledWith(
      'Res',
      'name-2',
      CR,
      NEW_PROPS,
      expect.objectContaining({ expectedRegion: 'us-east-1' })
    );
    expect(state['Res']).toMatchObject({ physicalId: 'name-1', properties: OLD_PROPS });
    // Kept in state from the revert's save until the Delete settled.
    expect(events[0]).toBe('save Res name-2');
    expect(superseded).toEqual([]);
    expect(outcome.failures).toBe(0);
    expect(outcome.warnings).toBe(0);
  });

  it('records the new id and deletes nothing when the handler keeps it', async () => {
    answer = 'name-2';
    const { state, superseded } = await replay();
    expect(state['Res']).toMatchObject({ physicalId: 'name-2', properties: OLD_PROPS });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(superseded).toEqual([]);
  });

  it('never deletes the id the record holds, whatever the answer says', async () => {
    answer = 'name-2';
    flagSameId = true;
    const { state, outcome } = await replay();
    expect(state['Res']?.physicalId).toBe('name-2');
    expect(provider.delete).not.toHaveBeenCalled();
    // Nothing is queued at all, so no holder warning either.
    expect(printed.warn).toEqual([]);
    expect(outcome.warnings).toBe(0);
  });

  it('records a third id the handler answers and deletes the id it moved off', async () => {
    answer = 'name-3';
    const { state } = await replay();
    expect(state['Res']?.physicalId).toBe('name-3');
    expect(calls.at(-1)).toBe('delete Res name-2');
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('deletes the id an ordinary revert moved off (an unmarked op)', async () => {
    answer = 'name-9';
    const { state } = await replay({
      op: movedOp({
        physicalId: 'name-1',
        properties: NEW_PROPS,
        wasReplaced: false,
        oldPhysicalIdLeftForCleanup: undefined,
      }),
      live: record('name-1', NEW_PROPS),
    });
    expect(state['Res']?.physicalId).toBe('name-9');
    expect(calls).toEqual(['update Res name-1', 'update Topic topic', 'delete Res name-1']);
  });

  it('deletes nothing for a provider that retires the id it moved off itself', async () => {
    leavesOld = false;
    const { state, superseded } = await replay();
    expect(state['Res']?.physicalId).toBe('name-1');
    expect(provider.delete).not.toHaveBeenCalled();
    expect(superseded).toEqual([]);
  });

  it('keeps UpdateReplacePolicy: Retain', async () => {
    const { state } = await replay({ live: record('name-2', NEW_PROPS, { updateReplacePolicy: 'Retain' }) });
    expect(state['Res']?.physicalId).toBe('name-1');
    expect(provider.delete).not.toHaveBeenCalled();
    expect(printed.info.some((l) => l.includes('UpdateReplacePolicy: Retain'))).toBe(true);
  });

  it('never deletes an id another record holds', async () => {
    const { outcome, superseded } = await replay({ others: { Other: record('name-2', NEW_PROPS) } });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(printed.warn.some((l) => l.includes('Other records the same physical id'))).toBe(true);
    expect(superseded).toEqual([]);
    expect(outcome.warnings).toBe(1);
  });

  it.each(['throw', 'skip'] as const)('a delete that fails (%s) warns and keeps the id in state', async (mode) => {
    deleteMode = mode;
    const { outcome, superseded, state } = await replay();
    expect(state['Res']?.physicalId).toBe('name-1');
    expect(superseded.map((e) => e.state.physicalId)).toEqual(['name-2']);
    expect(printed.warn.some((l) => l.includes('deleting the physical id it moved off'))).toBe(true);
    expect(outcome.warnings).toBe(1);
    expect(outcome.failures).toBe(0);
  });

  it('keeps the id for the next deploy when the rollback is interrupted', async () => {
    const { superseded } = await replay({ interruptAfterRes: true });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(superseded.map((e) => e.state.physicalId)).toEqual(['name-2']);
    expect(printed.warn.some((l) => l.includes('the rollback was interrupted'))).toBe(true);
  });

  it('never records a NoEcho-masked record, and hands its delete the leaves', async () => {
    const leaves = [['Secret']];
    const { superseded, events } = await replay({
      live: record('name-2', { ...NEW_PROPS, Secret: '***' }, { noEchoLeaves: leaves } as Partial<ResourceState>),
    });
    expect(events[0]).toBe('save Res ');
    expect(superseded).toEqual([]);
    expect(provider.delete).toHaveBeenCalledWith(
      'Res',
      'name-2',
      CR,
      expect.anything(),
      expect.objectContaining({ recordedNoEchoLeaves: leaves })
    );
  });

  it.each([
    [false, 0, 1],
    [true, 1, 0],
  ] as const)(
    'UpdateReplacePolicy: Snapshot (--skip-final-snapshot: %s) deletes %i time(s)',
    async (skip, deletes, warnings) => {
      ctx = { ...ctx, ...(skip && { skipFinalSnapshot: true }) };
      const { outcome } = await replay({
        live: record('name-2', NEW_PROPS, { updateReplacePolicy: 'Snapshot' }),
      });
      expect(provider.delete).toHaveBeenCalledTimes(deletes);
      if (deletes > 0) {
        expect(provider.delete).toHaveBeenCalledWith(
          'Res',
          'name-2',
          CR,
          NEW_PROPS,
          expect.objectContaining({ deletionPolicy: 'Snapshot' })
        );
      }
      expect(outcome.warnings).toBe(warnings);
    }
  );

  it('keeps the policy on the superseded entry', async () => {
    deleteMode = 'throw';
    const { superseded } = await replay({
      live: record('name-2', NEW_PROPS, { updateReplacePolicy: 'Delete' }),
    });
    expect(superseded[0]?.updateReplacePolicy).toBe('Delete');
  });

  it('names an untracked id on a durable event when its delete fails', async () => {
    deleteMode = 'throw';
    await replay({
      live: record('name-2', { ...NEW_PROPS, Secret: '***' }, {
        noEchoLeaves: [['Secret']],
      } as Partial<ResourceState>),
    });
    expect(recorded.filter((e) => e['physicalId'] === 'name-2')).toEqual([
      expect.objectContaining({
        eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
        operation: 'UPDATE',
        logicalId: 'Res',
        reason: expect.stringContaining('no longer tracked by cdkd'),
      }),
    ]);
    expect(printed.warn.some((l) => l.includes('delete what the handler made under it manually'))).toBe(
      true
    );
  });

  it('sends no Delete for an untracked id after an interrupt, and names it', async () => {
    await replay({
      interruptAfterRes: true,
      live: record('name-2', { ...NEW_PROPS, Secret: '***' }, {
        noEchoLeaves: [['Secret']],
      } as Partial<ResourceState>),
    });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(recorded.some((e) => e['physicalId'] === 'name-2')).toBe(true);
  });

  it('a failed save after the Delete settles warns and does not throw', async () => {
    const { outcome } = await replay({ settleSaveFails: true });
    expect(calls.at(-1)).toBe('delete Res name-2');
    expect(printed.warn.some((l) => l.includes('saving state after settling'))).toBe(true);
    expect(outcome.warnings).toBe(1);
  });

  it('masks a secret the moved-off id spells in every line', async () => {
    const SECRET = 'hunter2-plaintext';
    ctx = {
      ...ctx,
      logOnlyNeedlesFor: () => new Map([[SECRET, '{{resolve:secretsmanager:s:SecretString}}']]),
    };
    deleteMode = 'throw';
    await replay({
      op: movedOp({ physicalId: `name-${SECRET}` }),
      live: record(`name-${SECRET}`, NEW_PROPS),
    });
    expect(calls.at(-1)).toBe(`delete Res name-${SECRET}`);
    const lines = [...printed.info, ...printed.warn];
    expect(lines.some((l) => l.includes('moved off'))).toBe(true);
    expect(lines.filter((l) => l.includes(SECRET))).toEqual([]);
  });

  it('the --revert-failed arm deletes the id its Update moved off', async () => {
    answer = 'name-9';
    const failed = {
      logicalId: 'Res',
      changeType: 'UPDATE',
      resourceType: CR,
      provisionedBy: 'sdk',
      physicalId: 'name-1',
      previousState: record('name-1', OLD_PROPS),
    } as FailedOperation;
    const state: Record<string, ResourceState> = { Res: record('name-1', NEW_PROPS) };
    const superseded: SupersededResourceRecord[] = [];
    const saves: string[] = [];
    provider.delete.mockImplementationOnce(async (logicalId: string, physicalId: string) => {
      calls.push(`delete ${logicalId} ${physicalId}`);
      recorded.push({ eventType: 'DELETE SENT' });
      return undefined;
    });
    const outcome = await replayFailedOperations([failed], state, 'S', ctx, {
      emitEnvelope: true,
      afterOp: () => {
        saves.push(superseded.map((e) => e.state.physicalId).join(','));
      },
      onSuperseded: (entry) => superseded.push(entry),
      onSupersededSettled: (entry) => superseded.splice(superseded.indexOf(entry), 1),
    });
    expect(outcome.failures).toBe(0);
    expect(state['Res']?.physicalId).toBe('name-9');
    expect(calls).toEqual(['update Res name-1', 'delete Res name-1']);
    // Recorded across the revert's save, settled after the Delete.
    expect(saves[0]).toBe('name-1');
    expect(superseded).toEqual([]);
    // The Delete runs inside this replay's event envelope.
    expect(recorded.map((e) => e['eventType']).slice(-2)).toEqual([
      'DELETE SENT',
      'ROLLBACK_FINISHED',
    ]);
    expect(recorded[0]?.['eventType']).toBe('ROLLBACK_STARTED');
  });

  it("an interrupted --revert-failed replay sends nothing from the caller's queue, and names the id", async () => {
    answer = 'name-9';
    const failed = (logicalId: string, resourceType: string, id: string) =>
      ({
        logicalId,
        changeType: 'UPDATE',
        resourceType,
        provisionedBy: 'sdk',
        physicalId: id,
        previousState: record(id, OLD_PROPS, { resourceType }),
      }) as FailedOperation;
    const state: Record<string, ResourceState> = {
      Res: record('name-1', NEW_PROPS),
      Topic: record('topic', NEW_PROPS, { resourceType: TOPIC }),
    };
    const superseded: SupersededResourceRecord[] = [];
    const queue = newMovedIdCleanupQueue({
      onSuperseded: (entry) => superseded.push(entry),
      onSupersededSettled: (entry) => superseded.splice(superseded.indexOf(entry), 1),
    });
    let interrupted = false;
    // Replayed newest first: Res, then the interrupt stops Topic.
    const outcome = await replayFailedOperations(
      [failed('Topic', TOPIC, 'topic'), failed('Res', CR, 'name-1')],
      state,
      'S',
      ctx,
      {
        movedIdCleanups: queue,
        afterOp: () => {
          interrupted = true;
        },
        isInterrupted: () => interrupted,
      }
    );
    expect(outcome.interrupted).toBe(true);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(superseded.map((e) => e.state.physicalId)).toEqual(['name-1']);
    expect(printed.warn.some((l) => l.includes('the rollback was interrupted'))).toBe(true);
  });

  it("a segment's shared queue deletes only after its completed ops", async () => {
    answer = 'name-9';
    const failed = {
      logicalId: 'Res',
      changeType: 'UPDATE',
      resourceType: CR,
      provisionedBy: 'sdk',
      physicalId: 'name-1',
      previousState: record('name-1', OLD_PROPS),
    } as FailedOperation;
    const state: Record<string, ResourceState> = {
      Res: record('name-1', NEW_PROPS),
      Topic: record('topic', { DisplayName: 'v2' }, { resourceType: TOPIC }),
    };
    const queue = newMovedIdCleanupQueue({});
    await replayFailedOperations([failed], state, 'S', ctx, { movedIdCleanups: queue });
    expect(provider.delete).not.toHaveBeenCalled();
    await replayRollback([topicOp], state, 'S', ctx, { movedIdCleanups: queue });
    expect(calls).toEqual(['update Res name-1', 'update Topic topic', 'delete Res name-1']);
  });
});

describe('classifying the moved-id op (#6120)', () => {
  const live = (physicalId: string, properties: Record<string, unknown>) => ({
    Res: record(physicalId, properties),
  });

  it('reverts the marked op in place', () => {
    expect(classifyRollbackOp(movedOp(), live('name-2', NEW_PROPS), new Set())).toBe('revert');
  });

  it('keeps reverse-replacement for a journal written before the mark', () => {
    expect(
      classifyRollbackOp(
        movedOp({ oldPhysicalIdLeftForCleanup: undefined }),
        live('name-2', NEW_PROPS),
        new Set()
      )
    ).toBe('reverse-replacement');
  });

  it('keeps reverse-replacement for a planted mark on a type that is not a custom resource', () => {
    const op = movedOp({
      resourceType: 'AWS::SQS::Queue',
      previousResourceType: 'AWS::SQS::Queue',
      previousState: record('name-1', OLD_PROPS, { resourceType: 'AWS::SQS::Queue' }),
    });
    expect(
      classifyRollbackOp(op, { Res: record('name-2', NEW_PROPS, { resourceType: 'AWS::SQS::Queue' }) }, new Set())
    ).toBe('reverse-replacement');
  });

  it('does not count the live old id as taken away for a delete-first reversal', () => {
    const deleteFirst: CompletedOperation = {
      logicalId: 'Consumer',
      changeType: 'UPDATE',
      resourceType: 'Custom::Consumer',
      physicalId: 'consumer',
      previousState: record('consumer', { Target: 'name-1' }, { resourceType: 'Custom::Consumer' }),
      wasReplaced: true,
      oldDeletedBeforeCreate: true,
    };
    markDeleteFirstBlocked([movedOp(), deleteFirst]);
    expect(deleteFirstBlocker(deleteFirst)).toBeUndefined();
    markDeleteFirstBlocked([movedOp({ oldPhysicalIdLeftForCleanup: undefined }), deleteFirst]);
    expect(deleteFirstBlocker(deleteFirst)).toEqual({ logicalId: 'Res', physicalId: 'name-1' });
  });

  it('skips an op already reverted, and one a later attempt moved elsewhere', () => {
    expect(classifyRollbackOp(movedOp(), live('name-1', OLD_PROPS), new Set())).toBe(
      'skip-already-done'
    );
    expect(classifyRollbackOp(movedOp(), live('name-7', NEW_PROPS), new Set())).toBe(
      'skip-mismatch'
    );
  });
});

describe('a rollback save carries each superseded id once (#6120)', () => {
  const entry = (physicalId: string): SupersededResourceRecord => ({
    logicalId: 'Res',
    supersededAt: 1,
    state: record(physicalId, OLD_PROPS),
  });

  it("drops the state's entry for an id the rollback's pending entries name", () => {
    const out = supersededAfterRollback(
      { supersededResources: [entry('name-1'), entry('name-4')] },
      { supersededResources: [entry('name-4')] }
    );
    expect(out.supersededResources?.map((e) => e.state.physicalId)).toEqual(['name-1', 'name-4']);
  });
});
