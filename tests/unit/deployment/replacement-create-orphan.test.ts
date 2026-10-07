/**
 * go-to-k/cdkd#4604 — a replacement's NEW resource whose provider `create()`
 * proved it made the resource before failing (`markCreatedBeforeFailure`).
 * The engine journals it as a proven orphan beside the replacement's UPDATE,
 * naming the record it was replacing (`replacedPhysicalId` /
 * `replacedResourceType`); every default path then deletes it without
 * touching that record. A rollback's own re-create that leaves such a
 * resource deletes it inline.
 *
 * go-to-k/cdkd#4615 — an in-place UPDATE that changed the physical id (an SQS
 * QueuePolicy's is its first queue) is reverted in place when its completed
 * op carries the provider's `wasReplaced: false`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

import {
  classifyFailedOp,
  classifyRollbackOp,
  isReplacementOp,
  planFailedOps,
  replayFailedOperations,
  replayRollback,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import { RollbackInlinePolicyWriters } from '../../../src/deployment/inline-policy-claims.js';
import { markCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const TYPE = 'AWS::Kinesis::Stream';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

const warned = (): string =>
  (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n');

const res = (over: Partial<ResourceState> = {}): ResourceState => ({
  physicalId: 'stream-a',
  resourceType: TYPE,
  properties: { Name: 'stream-a' },
  attributes: { Arn: 'arn-a' },
  dependencies: [],
  provisionedBy: 'cc-api',
  ...over,
});

/** The new stream a replacement of `S` (stream-a -> stream-b) made, then failed on. */
const orphan = (over: Partial<FailedOperation> = {}): FailedOperation => ({
  logicalId: 'S',
  changeType: 'CREATE',
  resourceType: TYPE,
  provisionedBy: 'sdk',
  physicalId: 'stream-b',
  physicalIdRecoveredFromError: true,
  replacedPhysicalId: 'stream-a',
  replacedResourceType: TYPE,
  // go-to-k/cdkd#4655: the provider's live read answers the same token.
  createdResourceIdentity: 'created-token',
  attemptedProperties: { Name: 'stream-b' },
  ...over,
});

function ctxWith(given: Record<string, unknown>) {
  const provider = { resourceIdentity: vi.fn(async () => 'created-token'), ...given };
  const getProviderFor = vi.fn(() => ({ provider, provisionedBy: 'sdk' }));
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor,
      getProvider: () => provider,
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
  return { ctx, getProviderFor };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('classifyFailedOp: a replacement orphan beside the record it replaced (go-to-k/cdkd#4604)', () => {
  it('deletes it while the record under its logical id is the replaced resource', () => {
    expect(classifyFailedOp(orphan(), { S: res() })).toBe('delete-failed-create');
  });

  it('honours its journaled DeletionPolicy there', () => {
    expect(classifyFailedOp(orphan({ deletionPolicy: 'Retain' }), { S: res() })).toBe(
      'orphan-failed-create-retain'
    );
  });

  it('deletes it once the replaced record is gone too', () => {
    expect(classifyFailedOp(orphan(), {})).toBe('delete-failed-create');
  });

  // A later deploy put another resource under the id: it may own this one.
  it('skips on a record naming another physical id', () => {
    expect(classifyFailedOp(orphan(), { S: res({ physicalId: 'stream-c' }) })).toBe(
      'skip-failed-mismatch'
    );
  });

  it('skips on a record of another type under the replaced id', () => {
    expect(
      classifyFailedOp(orphan(), { S: res({ resourceType: 'AWS::SQS::Queue' }) })
    ).toBe('skip-failed-mismatch');
  });

  it('settles as a no-op when state now records the orphan itself', () => {
    expect(classifyFailedOp(orphan(), { S: res({ physicalId: 'stream-b' }) })).toBe(
      'skip-failed-noop'
    );
    expect(
      classifyFailedOp(orphan(), { S: res(), Other: res({ physicalId: 'stream-b' }) })
    ).toBe('skip-failed-noop');
  });

  it('still skips with a warning once demoted', () => {
    expect(
      classifyFailedOp(orphan({ physicalIdRecoveredFromError: false }), { S: res() })
    ).toBe('skip-failed-superseded');
  });

  // The rule the exception narrows: an orphan with no replaced record named.
  it('control: a first-time orphan beside a record is still a mismatch', () => {
    const plain = orphan();
    delete plain.replacedPhysicalId;
    delete plain.replacedResourceType;
    expect(classifyFailedOp(plain, { S: res() })).toBe('skip-failed-mismatch');
  });

  // A Type change: the new resource is of the template's type, the replaced
  // record of the old one.
  it('deletes it beside a replaced record of another type it names', () => {
    const op = orphan({ resourceType: 'AWS::SQS::Queue', replacedResourceType: TYPE });
    expect(classifyFailedOp(op, { S: res() })).toBe('delete-failed-create');
  });

  it('plans the delete on the journaled route, not the replaced record’s', () => {
    const [item] = planFailedOps([orphan()], { S: res({ provisionedBy: 'cc-api' }) });
    expect(item!.effectiveProvisionedBy).toBe('sdk');
  });
});

describe('replayFailedOperations: the replacement orphan is deleted, the replaced record kept (go-to-k/cdkd#4604)', () => {
  it('deletes the new stream through the journaled route and leaves the record as it was', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, getProviderFor } = ctxWith({ delete: del });
    const record = res();
    const state: Record<string, ResourceState> = { S: record };
    const afterOp = vi.fn();

    const result = await replayFailedOperations([orphan()], state, 'Stack', ctx, { afterOp });

    expect(del).toHaveBeenCalledOnce();
    const [logicalId, physicalId, type, props, context] = del.mock.calls[0]!;
    expect([logicalId, physicalId, type, props]).toEqual(['S', 'stream-b', TYPE, { Name: 'stream-b' }]);
    // The replaced record's attributes describe the OLD stream.
    expect((context as { recordedAttributes?: unknown }).recordedAttributes).toBeUndefined();
    expect(getProviderFor).toHaveBeenCalledWith({ resourceType: TYPE, provisionedBy: 'sdk' });
    expect(state['S']).toBe(record);
    expect(result.failures).toBe(0);
    expect(result.remainingFailedOps).toEqual([]);
  });

  it('keeps it in AWS under Retain without orphaning or dropping the replaced record', async () => {
    const del = vi.fn();
    const { ctx } = ctxWith({ delete: del });
    const record = res();
    const state: Record<string, ResourceState> = { S: record };
    const onOrphan = vi.fn();

    const result = await replayFailedOperations(
      [orphan({ deletionPolicy: 'Retain' })],
      state,
      'Stack',
      ctx,
      { onOrphan }
    );

    expect(del).not.toHaveBeenCalled();
    expect(state['S']).toBe(record);
    expect(result.orphaned).toEqual([]);
    expect(onOrphan).not.toHaveBeenCalled();
    expect(result.remainingFailedOps).toEqual([]);
  });

  it('control: a record a later deploy put there leaves the orphan undeleted', async () => {
    const del = vi.fn();
    const { ctx } = ctxWith({ delete: del });
    await replayFailedOperations([orphan()], { S: res({ physicalId: 'stream-c' }) }, 'Stack', ctx, {});
    expect(del).not.toHaveBeenCalled();
  });
});

describe('settleJournaledOrphansOnSuccess: a replacement orphan (go-to-k/cdkd#4604)', () => {
  function settle(stateResources: Record<string, ResourceState>, newerIds: string[] = []) {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = ctxWith({ delete: del });
    const journal = {
      journalVersion: 1,
      stackName: 'Stack',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [orphan()],
        },
      ],
    };
    const stateBackend = {
      loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
      reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    };
    const foreignHolder = vi.fn(async () => undefined);
    const outcome = settleJournaledOrphansOnSuccess({
      stateBackend: stateBackend as never,
      stackName: 'Stack',
      region: 'us-east-1',
      stateResources,
      rollbackOrphans: undefined,
      newerOperations: newerIds.map(
        (logicalId) =>
          ({ logicalId, changeType: 'UPDATE', resourceType: TYPE, physicalId: 'x' }) as CompletedOperation
      ),
      foreignHolder,
      ctx,
      logger,
    });
    return { outcome, del, foreignHolder };
  }

  it('deletes it when the record under its id is still the replaced stream', async () => {
    const { outcome, del, foreignHolder } = settle({ S: res() });
    expect(await outcome).toMatchObject({ unaddressed: 0, keepJournal: false });
    expect(foreignHolder).toHaveBeenCalledWith(TYPE, 'stream-b');
    expect(del.mock.calls.map((c) => c[1])).toEqual(['stream-b']);
  });

  it('demotes it when this deploy completed an op under its id', async () => {
    const { outcome, del } = settle({ S: res() }, ['S']);
    expect((await outcome).unaddressed).toBe(1);
    expect(del).not.toHaveBeenCalled();
  });

  it('demotes it when the record under its id names another stream', async () => {
    const { outcome, del } = settle({ S: res({ physicalId: 'stream-c' }) });
    expect((await outcome).unaddressed).toBe(1);
    expect(del).not.toHaveBeenCalled();
  });
});

describe('a rollback re-create that made its resource and failed (go-to-k/cdkd#4604)', () => {
  /** The replacement being reversed: stream-a was replaced by stream-b. */
  const replacementOp = (
    prev: Partial<ResourceState> = {},
    type: string = TYPE
  ): CompletedOperation => ({
    logicalId: 'S',
    changeType: 'UPDATE',
    resourceType: type,
    physicalId: 'stream-b',
    provisionedBy: 'sdk',
    previousState: res({ provisionedBy: 'sdk', resourceType: type, ...prev }),
    oldResourceRetained: false,
    ...(prev.resourceType !== undefined &&
      prev.resourceType !== type && { previousResourceType: prev.resourceType }),
  });

  function run(
    failure: Error,
    opts: {
      prev?: Partial<ResourceState>;
      deleteFails?: boolean;
      deleteSkips?: boolean;
      /** The template's (new) type, the current record's too. */
      type?: string;
      extraState?: Record<string, ResourceState>;
    } = {}
  ) {
    const type = opts.type ?? TYPE;
    const create = vi.fn().mockRejectedValue(failure);
    const del = vi.fn(async (..._args: unknown[]) => {
      if (opts.deleteFails) throw new Error('AccessDenied');
      if (opts.deleteSkips) return { outcome: 'skipped' as const, reason: 'a guard refused' };
      return undefined;
    });
    const { ctx } = ctxWith({ create, delete: del });
    const state: Record<string, ResourceState> = {
      S: res({
        physicalId: 'stream-b',
        resourceType: type,
        properties: { Name: 'stream-b' },
        provisionedBy: 'sdk',
      }),
      ...opts.extraState,
    };
    return {
      del,
      state,
      result: replayRollback([replacementOp(opts.prev, type)], state, 'Stack', ctx),
    };
  }

  const madeA = (): Error =>
    markCreatedBeforeFailure(new Error('retention rejected'), 'S', TYPE, 'stream-a');

  it('deletes what the re-create made, and nothing else', async () => {
    const { del, state, result } = run(madeA());
    expect((await result).failures).toBe(1);
    expect(del.mock.calls.map((c) => c[1])).toEqual(['stream-a']);
    expect(state['S']?.physicalId).toBe('stream-b');
    // The persisted bag, never the resolved one handed to the re-create.
    expect(del.mock.calls[0]![3]).toEqual({ Name: 'stream-a' });
    expect(del.mock.calls[0]![2]).toBe(TYPE);
    expect(del.mock.calls[0]![4]).toEqual({ expectedRegion: 'us-east-1', deletionPolicy: 'Delete' });
  });

  // Only a record of the made resource's own type holds it.
  it('control: a record of another type under the made id does not block the delete', async () => {
    const other = res({ physicalId: 'stream-a', resourceType: 'AWS::SQS::Queue' });
    const { del, result } = run(madeA(), { extraState: { Q: other } });
    await result;
    expect(del.mock.calls.map((c) => c[1])).toEqual(['stream-a']);
  });

  // A Type change: the re-create made the OLD type, which the mark must name.
  it('reads the mark by the old type across a Type change', async () => {
    const OLD = 'AWS::SQS::Queue';
    const prev = { resourceType: OLD };
    const marked = run(markCreatedBeforeFailure(new Error('x'), 'S', OLD, 'stream-a'), { prev });
    await marked.result;
    expect(marked.del.mock.calls.map((c) => [c[1], c[2]])).toEqual([['stream-a', OLD]]);
    const newType = run(markCreatedBeforeFailure(new Error('x'), 'S', TYPE, 'stream-a'), { prev });
    await newType.result;
    expect(newType.del).not.toHaveBeenCalled();
  });

  // CloudFormation's absent default for a standalone DB instance is Snapshot.
  it('keeps an RDS instance whose old record declares no DeletionPolicy', async () => {
    const RDS = 'AWS::RDS::DBInstance';
    const { del, result } = run(markCreatedBeforeFailure(new Error('x'), 'S', RDS, 'db-a'), {
      type: RDS,
      prev: { physicalId: 'db-a', properties: {} },
    });
    await result;
    expect(del).not.toHaveBeenCalled();
    expect(warned()).toContain('DeletionPolicy: Snapshot');
  });

  it('keeps it, named, under the old record’s Retain', async () => {
    const { del, result } = run(madeA(), { prev: { deletionPolicy: 'Retain' } });
    await result;
    expect(del).not.toHaveBeenCalled();
    expect(warned()).toContain('DeletionPolicy: Retain');
  });

  it('keeps it, named, under the old record’s Snapshot', async () => {
    const { del, result } = run(madeA(), { prev: { deletionPolicy: 'Snapshot' } });
    await result;
    expect(del).not.toHaveBeenCalled();
    expect(warned()).toContain('DeletionPolicy: Snapshot');
  });

  it('names it when the provider skips the delete', async () => {
    const { del, result } = run(madeA(), { deleteSkips: true });
    await result;
    expect(del).toHaveBeenCalledOnce();
    expect(warned()).toContain('could not delete');
  });

  it('names it when the delete fails', async () => {
    const { del, result } = run(madeA(), { deleteFails: true });
    expect((await result).failures).toBe(1);
    expect(del).toHaveBeenCalledOnce();
    expect(warned()).toContain('could not delete');
  });

  it('never deletes an id a state record holds', async () => {
    const { del, result } = run(markCreatedBeforeFailure(new Error('x'), 'S', TYPE, 'stream-b'));
    await result;
    expect(del).not.toHaveBeenCalled();
  });

  it('control: an unmarked re-create failure deletes nothing', async () => {
    const { del, result } = run(new Error('retention rejected'));
    await result;
    expect(del).not.toHaveBeenCalled();
  });
});

describe('isReplacementOp honours the provider’s wasReplaced (go-to-k/cdkd#4615)', () => {
  const QP = 'AWS::SQS::QueuePolicy';
  /** QueuePolicy [Q1,Q2,Q3] -> [Q2,Q3]: updated in place, its id moved Q1 -> Q2. */
  const policyOp = (wasReplaced?: boolean): CompletedOperation => ({
    logicalId: 'P',
    changeType: 'UPDATE',
    resourceType: QP,
    physicalId: 'q2',
    properties: { Queues: ['q2', 'q3'] },
    previousState: {
      physicalId: 'q1',
      resourceType: QP,
      properties: { Queues: ['q1', 'q2', 'q3'] },
      attributes: {},
      dependencies: [],
    },
    ...(wasReplaced !== undefined && { wasReplaced }),
  });
  const current = {
    P: {
      physicalId: 'q2',
      resourceType: QP,
      properties: { Queues: ['q2', 'q3'] },
      attributes: {},
      dependencies: [],
    } as ResourceState,
  };

  it('reverts an in-place update that changed the id in place', () => {
    expect(isReplacementOp(policyOp(false))).toBe(false);
    expect(classifyRollbackOp(policyOp(false), current, new Set())).toBe('revert');
  });

  it('keeps reading a changed id as a replacement for a journal without the field', () => {
    expect(isReplacementOp(policyOp())).toBe(true);
    expect(classifyRollbackOp(policyOp(), current, new Set())).toBe('reverse-replacement');
  });

  it('still reverses a real replacement', () => {
    expect(classifyRollbackOp(policyOp(true), current, new Set())).toBe('reverse-replacement');
  });

  // An in-place answer never hides a Type change, which has no in-place revert.
  it('still treats a Type change as a replacement', () => {
    const op = { ...policyOp(false), physicalId: 'q1', previousResourceType: 'AWS::SNS::TopicPolicy' };
    expect(isReplacementOp(op)).toBe(true);
  });
});

describe('the delete-new-first arm deletes what its re-create made too (go-to-k/cdkd#4604)', () => {
  const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
  const TG_NAME = 'CdkdX-Tg';
  const NEW_ARN = `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${TG_NAME}/0123456789abcdef`;
  /** The SDK shape ELBv2 throws: the NAME states the collision (#3208). */
  const collision = (): Error => {
    const e = new Error(`A target group with the same name '${TG_NAME}' exists, but with different settings`);
    e.name = 'DuplicateTargetGroupNameException';
    return e;
  };
  const tg = (over: Partial<ResourceState> = {}): ResourceState => ({
    physicalId: NEW_ARN,
    resourceType: TG,
    properties: { Name: TG_NAME },
    attributes: {},
    dependencies: [],
    ...over,
  });
  const op = (): CompletedOperation => ({
    logicalId: 'Tg',
    changeType: 'UPDATE',
    resourceType: TG,
    physicalId: NEW_ARN,
    previousState: tg({ physicalId: 'arn-old' }),
  });

  it('deletes the new resource first, then what the failed re-create made', async () => {
    let calls = 0;
    const create = vi.fn(async () => {
      if (calls++ === 0) throw collision();
      throw markCreatedBeforeFailure(new Error('follow-up rejected'), 'Tg', TG, 'arn-made');
    });
    const del = vi.fn(async (..._args: unknown[]) => undefined);
    const { ctx } = ctxWith({ create, delete: del });
    const result = await replayRollback([op()], { Tg: tg() }, 'CdkdX', ctx);
    expect(result.failures).toBe(1);
    expect(del.mock.calls.map((c) => c[1])).toEqual([NEW_ARN, 'arn-made']);
  });

  // The collision was this create's own earlier attempt's resource, which the
  // catch just deleted: no holder proof runs, so the live new resource stays.
  it('fails the op without deleting the new resource once its own leftover is deleted', async () => {
    const create = vi.fn(async () => {
      throw markCreatedBeforeFailure(collision(), 'Tg', TG, 'arn-made');
    });
    const del = vi.fn(async (..._args: unknown[]) => undefined);
    const { ctx } = ctxWith({ create, delete: del });
    const state = { Tg: tg() };
    const result = await replayRollback([op()], state, 'CdkdX', ctx);
    expect(result.failures).toBe(1);
    expect(del.mock.calls.map((c) => c[1])).toEqual(['arn-made']);
    expect(state.Tg.physicalId).toBe(NEW_ARN);
  });
});

describe('the in-place revert of an id-changing update (go-to-k/cdkd#4615)', () => {
  it('updates the current id back to the previous properties and restores the previous record', async () => {
    const QP = 'AWS::SQS::QueuePolicy';
    const prev: ResourceState = {
      physicalId: 'q1',
      resourceType: QP,
      properties: { Queues: ['q1', 'q2', 'q3'] },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    };
    const current: ResourceState = { ...prev, physicalId: 'q2', properties: { Queues: ['q2', 'q3'] } };
    const update = vi.fn(async (..._args: unknown[]) => ({ physicalId: 'q1', wasReplaced: false }));
    const create = vi.fn();
    const del = vi.fn();
    const { ctx } = ctxWith({ update, create, delete: del });
    const state: Record<string, ResourceState> = { P: current };
    const op: CompletedOperation = {
      logicalId: 'P',
      changeType: 'UPDATE',
      resourceType: QP,
      physicalId: 'q2',
      provisionedBy: 'sdk',
      properties: current.properties,
      previousState: prev,
      wasReplaced: false,
    };

    const result = await replayRollback([op], state, 'Stack', ctx);

    expect(result.failures).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(update.mock.calls[0]!.slice(0, 4)).toEqual(['P', 'q2', QP, { Queues: ['q1', 'q2', 'q3'] }]);
    expect(state['P']?.physicalId).toBe('q1');
  });
});

describe('a settled replacement orphan settles its logical id for the inline-policy put-back (go-to-k/cdkd#4604)', () => {
  const ROLE = 'AWS::IAM::Role';
  const role: ResourceState = {
    physicalId: 'role-a',
    resourceType: ROLE,
    properties: { Policies: [{ PolicyName: 'n', PolicyDocument: 'd' }] },
    attributes: {},
    dependencies: [],
  };

  it.each([
    ['deleted', undefined],
    ['kept under Retain', 'Retain'],
  ] as const)('leaves the replaced record no unsettled holder once the orphan is %s', async (_l, policy) => {
    const writers = new RollbackInlinePolicyWriters();
    const { ctx } = ctxWith({ delete: vi.fn().mockResolvedValue(undefined) });
    const state: Record<string, ResourceState> = { R: role };
    const op = orphan({
      logicalId: 'R',
      resourceType: ROLE,
      physicalId: 'role-b',
      replacedPhysicalId: 'role-a',
      replacedResourceType: ROLE,
      ...(policy && { deletionPolicy: policy }),
    });
    await replayFailedOperations([op], state, 'Stack', ctx, { inlinePolicyWriters: writers });
    // Another revert of this rollback removes `n` from role-a, which R holds.
    writers.claimedFor('AWS::IAM::Policy', 'Remover', {})!('role', 'role-a', 'n');
    const [held] = writers.takeHeldRemovals(state);
    expect(held?.holders.map((h) => h.logicalId)).toEqual(['R']);
    expect(held?.unsettled).toEqual([]);
  });
});

describe('a failed replacement UPDATE beside its orphan (go-to-k/cdkd#4604)', () => {
  const update = (): FailedOperation => ({
    logicalId: 'S',
    changeType: 'UPDATE',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    physicalId: 'stream-a',
    previousState: res(),
    attemptedProperties: { Name: 'stream-b', RetentionPeriodHours: 9000 },
  });

  it('settles as a no-op, never a force-revert of the old resource', () => {
    expect(classifyFailedOp(update(), { S: res() }, [update(), orphan()])).toBe('skip-failed-noop');
    // Demoted, the orphan still proves the replacement never swapped.
    expect(
      classifyFailedOp(update(), { S: res() }, [orphan({ physicalIdRecoveredFromError: false })])
    ).toBe('skip-failed-noop');
  });

  it('control: without its orphan it is reverted as before', () => {
    expect(classifyFailedOp(update(), { S: res() }, [])).toBe('revert-failed-update');
    expect(classifyFailedOp(update(), { S: res() }, [orphan({ replacedPhysicalId: 'other' })])).toBe(
      'revert-failed-update'
    );
  });

  // A later operation moved the record: this op applied nothing, so its
  // previous properties must not land on that operation's resource.
  it('never force-reverts a record a later operation moved', () => {
    expect(classifyFailedOp(update(), { S: res({ physicalId: 'stream-c' }) }, [orphan()])).toBe(
      'skip-failed-noop'
    );
  });

  // Delete-first: the record names a resource the replacement removed.
  it('warns, never a silent no-op, when the replacement deleted the old resource first', () => {
    const deletedFirst = orphan({ replacedResourceDeleted: true });
    expect(classifyFailedOp(update(), { S: res() }, [deletedFirst])).toBe(
      'skip-failed-replaced-deleted'
    );
    expect(classifyFailedOp(update(), { S: res({ physicalId: 'stream-c' }) }, [deletedFirst])).toBe(
      'skip-failed-noop'
    );
  });

  it('replays the delete-first pair: deletes the new stream, warns about the old, settles both', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const upd = vi.fn();
    const { ctx } = ctxWith({ delete: del, update: upd });
    const state: Record<string, ResourceState> = { S: res() };
    const result = await replayFailedOperations(
      [update(), orphan({ replacedResourceDeleted: true })],
      state,
      'Stack',
      ctx,
      {}
    );
    expect(del.mock.calls.map((c) => c[1])).toEqual(['stream-b']);
    expect(upd).not.toHaveBeenCalled();
    expect(warned()).toContain('its replacement deleted the old resource');
    expect(result.skipped).toBe(1);
    expect(result.remainingFailedOps).toEqual([]);
  });

  // The pair as the engine journals it, replayed in one run: the orphan is
  // deleted, the old stream is never updated, and both entries settle.
  it('replays the journaled pair: deletes the new stream, leaves the old one untouched', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const upd = vi.fn();
    const { ctx } = ctxWith({ delete: del, update: upd });
    const record = res();
    const state: Record<string, ResourceState> = { S: record };
    const result = await replayFailedOperations([update(), orphan()], state, 'Stack', ctx, {});
    expect(del.mock.calls.map((c) => c[1])).toEqual(['stream-b']);
    expect(upd).not.toHaveBeenCalled();
    expect(state['S']).toBe(record);
    expect(result.failures).toBe(0);
    expect(result.remainingFailedOps).toEqual([]);
  });
});

describe("the success settle clears a replacement orphan's failed UPDATE with it (go-to-k/cdkd#4604)", () => {
  it('its strip of the cleared entries removes both', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const upd = vi.fn();
    const { ctx } = ctxWith({ delete: del, update: upd });
    const update: FailedOperation = {
      logicalId: 'S',
      changeType: 'UPDATE',
      resourceType: TYPE,
      physicalId: 'stream-a',
      previousState: res(),
    };
    const journal = {
      journalVersion: 1,
      stackName: 'Stack',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [update, orphan()],
        },
      ],
    };
    const drop = vi.fn().mockResolvedValue(2);
    const outcome = await settleJournaledOrphansOnSuccess({
      stateBackend: {
        loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
        reduceRollbackJournalToFailedOperations: vi.fn(),
        markRollbackJournalSuperseded: vi.fn(),
        dropRollbackJournalFailedOperations: drop,
      } as never,
      stackName: 'Stack',
      region: 'us-east-1',
      stateResources: { S: res() },
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: async () => undefined,
      ctx,
      logger,
    });
    expect(del.mock.calls.map((c) => c[1])).toEqual(['stream-b']);
    expect(upd).not.toHaveBeenCalled();
    await outcome.stripCleared!();
    const keep = drop.mock.calls[0]![2] as (op: FailedOperation, seg: unknown) => boolean;
    const fresh = structuredClone(journal.segments[0]!);
    expect(keep(fresh.failedOperations[0]!, fresh)).toBe(true);
    expect(keep(fresh.failedOperations[1]!, fresh)).toBe(true);
  });
});

describe('a failed replacement UPDATE reads on its own (go-to-k/cdkd#4604 review round 5)', () => {
  const update = (over: Partial<FailedOperation> = {}): FailedOperation => ({
    logicalId: 'S',
    changeType: 'UPDATE',
    resourceType: TYPE,
    physicalId: 'stream-a',
    previousState: res(),
    ...over,
  });

  // An interrupted rollback can settle the orphan and leave the UPDATE.
  it('is never a force-revert without its orphan, once stamped', () => {
    expect(classifyFailedOp(update({ replacementOrphaned: 'create-first' }), { S: res() }, [])).toBe(
      'skip-failed-noop'
    );
    expect(classifyFailedOp(update({ replacementOrphaned: 'delete-first' }), { S: res() }, [])).toBe(
      'skip-failed-replaced-deleted'
    );
    expect(
      classifyFailedOp(update({ replacementOrphaned: 'delete-first' }), { S: res({ physicalId: 'c' }) }, [])
    ).toBe('skip-failed-noop');
  });

  // Another resource's orphan sharing the physical id proves nothing about it.
  it('control: an orphan of another logical id is no sibling', () => {
    expect(classifyFailedOp(update(), { S: res() }, [orphan({ logicalId: 'Other' })])).toBe(
      'revert-failed-update'
    );
  });

  it('names what recreates the deleted resource on a rollback, and the record drop on a destroy', async () => {
    const { ctx } = ctxWith({ delete: vi.fn(), update: vi.fn() });
    const op = update({ replacementOrphaned: 'delete-first' });
    await replayFailedOperations([op], { S: res() }, 'Stack', ctx, {});
    expect(warned()).toContain('a deploy whose template still replaces it creates it again');
    expect(warned()).not.toContain('--recreate-via');
    vi.mocked(logger.warn).mockClear();
    await replayFailedOperations([op], { S: res() }, 'Stack', ctx, { forDestroy: true });
    expect(warned()).toContain('the destroy drops its record');
    expect(warned()).not.toContain('--recreate-via');
  });
});

describe('the inline-policy settle of the failed replacement pair (go-to-k/cdkd#4604 review round 5)', () => {
  const ROLE = 'AWS::IAM::Role';
  const role: ResourceState = {
    physicalId: 'role-a',
    resourceType: ROLE,
    properties: { Policies: [{ PolicyName: 'n', PolicyDocument: 'd' }] },
    attributes: {},
    dependencies: [],
  };
  const roleOrphan = (): FailedOperation =>
    orphan({
      logicalId: 'R',
      resourceType: ROLE,
      physicalId: 'role-b',
      replacedPhysicalId: 'role-a',
      replacedResourceType: ROLE,
    });
  const unsettledAfter = async (ops: FailedOperation[], del: ReturnType<typeof vi.fn>) => {
    const writers = new RollbackInlinePolicyWriters();
    const { ctx } = ctxWith({ delete: del });
    const state: Record<string, ResourceState> = { R: role };
    await replayFailedOperations(ops, state, 'Stack', ctx, { inlinePolicyWriters: writers });
    writers.claimedFor('AWS::IAM::Policy', 'Remover', {})!('role', 'role-a', 'n');
    return writers.takeHeldRemovals(state)[0]?.unsettled;
  };

  it('a warned delete-first UPDATE settles its logical id', async () => {
    const upd: FailedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: 'role-a',
      previousState: role,
      replacementOrphaned: 'delete-first',
    };
    // The UPDATE runs last (newest-first replay): its outcome is the final word.
    expect(await unsettledAfter([upd, roleOrphan()], vi.fn().mockResolvedValue(undefined))).toEqual([]);
  });

  it('an orphan whose delete failed leaves its logical id unsettled', async () => {
    expect(await unsettledAfter([roleOrphan()], vi.fn().mockRejectedValue(new Error('AccessDenied')))).toEqual([
      'R',
    ]);
  });
});
