/**
 * A rollback that leaves a `DeletionPolicy: Retain` resource in AWS must RECORD
 * what it left (issue #2934).
 *
 * cdkd's generated physical names are deterministic, so such a resource holds
 * the exact name the next deploy will ask AWS for. Without the record that
 * deploy collides, rolls back, and repeats forever — the loop an external user
 * reported in go-to-k/cdkd#2902 and escaped only by hand-deleting through the
 * AWS API.
 *
 * The cases below pin the two facts a later edit can quietly break: that the
 * record carries the DISCARDED STATE RECORD rather than an id, and that the
 * arms which must NOT record stay silent.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { orphansAfterRollback, type ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

const processGlobalClients = { tag: 'process-global' };
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => processGlobalClients,
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::IAM::Role',
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function makeCtx(deleteImpl = vi.fn(async () => undefined)): {
  ctx: RollbackExecutorContext;
  del: ReturnType<typeof vi.fn>;
} {
  const ctx = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProvider: () => ({ delete: deleteImpl }),
      getProviderFor: () => ({ provider: { delete: deleteImpl }, provisionedBy: 'sdk' }),
    },
  } as unknown as RollbackExecutorContext;
  return { ctx, del: deleteImpl };
}

function createOp(overrides: Partial<CompletedOperation> = {}): CompletedOperation {
  return {
    logicalId: 'KeptRole',
    changeType: 'CREATE',
    resourceType: 'AWS::IAM::Role',
    physicalId: 'cdkd-sandbox-KeptRole',
    ...overrides,
  } as CompletedOperation;
}

describe('rollback records what it orphans (#2934)', () => {
  it('a Retain CREATE rollback returns the DISCARDED STATE RECORD, not just an id', async () => {
    const { ctx, del } = makeCtx();
    // A property bag that is recognisably the failed deploy's TEMPLATE values.
    // This is the whole point of carrying the record: the next deploy diffs
    // against these, so an AWS readback substituted here would put a generated
    // `RoleName` on the old side and the diff would read it as a create-only
    // REMOVAL — replacing (and destroying) the resource being rescued.
    const discarded = res({
      physicalId: 'cdkd-sandbox-KeptRole',
      deletionPolicy: 'Retain',
      properties: { AssumeRolePolicyDocument: { Version: '2012-10-17' }, Path: '/svc/' },
      attributes: { Arn: 'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole' },
    });
    const state: Record<string, ResourceState> = { KeptRole: discarded };

    const result = await replayRollback([createOp()], state, 'MyStack', ctx);

    expect(del).not.toHaveBeenCalled();
    expect(state['KeptRole']).toBeUndefined();
    expect(result.orphaned).toHaveLength(1);
    const record = result.orphaned[0]!;
    expect(record.logicalId).toBe('KeptRole');
    expect(record.state.physicalId).toBe('cdkd-sandbox-KeptRole');
    // The bag, not a summary of it — asserted by VALUE so a future change that
    // narrows the record to `{ physicalId, resourceType }` fails here.
    expect(record.state.properties).toEqual({
      AssumeRolePolicyDocument: { Version: '2012-10-17' },
      Path: '/svc/',
    });
    expect(record.state.attributes).toEqual({
      Arn: 'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole',
    });
    expect(typeof record.orphanedAt).toBe('number');
  });

  it('a CREATE rollback WITHOUT Retain deletes and records nothing', async () => {
    const { ctx, del } = makeCtx();
    const state: Record<string, ResourceState> = {
      Gone: res({ physicalId: 'phys-gone' }),
    };

    const result = await replayRollback(
      [createOp({ logicalId: 'Gone', physicalId: 'phys-gone' })],
      state,
      'MyStack',
      ctx
    );

    // The discriminator for the case above: the resource left state BOTH times,
    // so "state.X is undefined" proves nothing on its own. What separates them
    // is that this one was DELETED from AWS, and so has no name left to collide
    // with and nothing to record.
    expect(del).toHaveBeenCalledTimes(1);
    expect(result.orphaned).toEqual([]);
  });

  it('`RetainExceptOnCreate` deletes and records nothing', async () => {
    const { ctx, del } = makeCtx();
    const state: Record<string, ResourceState> = {
      KeptRole: res({
        physicalId: 'cdkd-sandbox-KeptRole',
        deletionPolicy: 'RetainExceptOnCreate',
      }),
    };

    const result = await replayRollback([createOp()], state, 'MyStack', ctx);

    // The policy exists to say "delete me on a CREATE rollback", so there is no
    // survivor to record. Keeping this beside the `Retain` case is what pins
    // that the two are still distinguished — collapsing them was the objection
    // that killed the delete-on-rollback design.
    expect(del).toHaveBeenCalledTimes(1);
    expect(result.orphaned).toEqual([]);
  });

  it('an explicit `--orphan` skip records nothing (deliberately out of scope)', async () => {
    const { ctx, del } = makeCtx();
    const state: Record<string, ResourceState> = {
      KeptRole: res({ physicalId: 'cdkd-sandbox-KeptRole' }),
    };

    const result = await replayRollback([createOp()], state, 'MyStack', ctx, {
      orphanLogicalIds: new Set(['KeptRole']),
    });

    // `--orphan` is an operational escape hatch for a rollback that is STUCK on
    // a resource, not a `DeletionPolicy`. Only the two Retain arms mint records.
    expect(del).not.toHaveBeenCalled();
    expect(state['KeptRole']).toBeUndefined();
    expect(result.orphaned).toEqual([]);
  });
});

describe('the record reaches the caller BEFORE the per-op save (#2934)', () => {
  it('`onOrphan` fires before `afterOp`, so an intermediate save can carry it', async () => {
    const { ctx } = makeCtx();
    const state: Record<string, ResourceState> = {
      KeptRole: res({ physicalId: 'cdkd-sandbox-KeptRole', deletionPolicy: 'Retain' }),
    };
    const order: string[] = [];
    const seen: string[] = [];

    await replayRollback([createOp()], state, 'MyStack', ctx, {
      onOrphan: (record) => {
        order.push('onOrphan');
        seen.push(record.logicalId);
      },
      afterOp: () => {
        order.push('afterOp');
      },
    });

    // The ORDER is the whole assertion. `cdkd rollback` saves state from
    // `afterOp`, and it appends to its own list from `onOrphan`; reading
    // `result.orphaned` after the replay RETURNS instead — which is what this
    // sink replaced — meant every intermediate save persisted the resource's
    // absence from `resources` with no record of it. A crash in that window
    // loses the only trace of a live, billing AWS resource, which is the
    // unrecoverable loop this feature closes, reached through its own
    // implementation.
    expect(order).toEqual(['onOrphan', 'afterOp']);
    expect(seen).toEqual(['KeptRole']);
  });

  it('the FAILED-CREATE arm fires the sink before `afterOp` too', async () => {
    const { ctx } = makeCtx();
    const state: Record<string, ResourceState> = {
      PartialRole: res({ physicalId: 'cdkd-sandbox-PartialRole', deletionPolicy: 'Retain' }),
    };
    const order: string[] = [];

    await replayFailedOperations(
      [
        {
          logicalId: 'PartialRole',
          changeType: 'CREATE',
          resourceType: 'AWS::IAM::Role',
          physicalId: 'cdkd-sandbox-PartialRole',
        } as FailedOperation,
      ],
      state,
      'MyStack',
      ctx,
      {
        onOrphan: () => order.push('onOrphan'),
        afterOp: () => {
          order.push('afterOp');
        },
      }
    );

    // A DIFFERENT FUNCTION with the same window: the `replayRollback` case
    // above says nothing about this one, and this is the arm
    // `cdkd rollback --revert-failed` drives — the command that saves per op in
    // the first place.
    //
    // Not a claim that these are the only two arms dropping a row beside a
    // save: `orphan-flag` is a third, and it deliberately mints nothing (the
    // `--orphan` case in the first describe pins that).
    expect(order).toEqual(['onOrphan', 'afterOp']);
  });

  it('the sink is OPTIONAL — the automatic rollback passes none and still records', async () => {
    const { ctx } = makeCtx();
    const state: Record<string, ResourceState> = {
      KeptRole: res({ physicalId: 'cdkd-sandbox-KeptRole', deletionPolicy: 'Retain' }),
    };

    // The engine saves once at the end, so it has no window to close and
    // passes no sink. `result.orphaned` must still carry the record, or the
    // post-rollback save writes nothing.
    const result = await replayRollback([createOp()], state, 'MyStack', ctx);
    expect(result.orphaned).toHaveLength(1);
  });
});

describe('the failed-in-flight CREATE arm records too (#2934)', () => {
  it('`orphan-failed-create-retain` returns the discarded record', async () => {
    const { ctx, del } = makeCtx();
    const discarded = res({
      physicalId: 'cdkd-sandbox-PartialRole',
      deletionPolicy: 'Retain',
      properties: { Path: '/partial/' },
    });
    const state: Record<string, ResourceState> = { PartialRole: discarded };
    const failedOps: FailedOperation[] = [
      {
        logicalId: 'PartialRole',
        changeType: 'CREATE',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'cdkd-sandbox-PartialRole',
      } as FailedOperation,
    ];

    const result = await replayFailedOperations(failedOps, state, 'MyStack', ctx);

    // This arm lives ONLY in `replayFailedOperations`, which only the standalone
    // `cdkd rollback --revert-failed` reaches — the automatic rollback never
    // gets here. So the `replayRollback` cases above cannot cover it, and
    // deleting this arm's push left the whole suite green.
    expect(del).not.toHaveBeenCalled();
    expect(state['PartialRole']).toBeUndefined();
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0]?.logicalId).toBe('PartialRole');
    expect(result.orphaned[0]?.state.properties).toEqual({ Path: '/partial/' });
  });

  it('a failed CREATE with no physical id records nothing', async () => {
    const { ctx } = makeCtx();
    const state: Record<string, ResourceState> = {};
    const failedOps: FailedOperation[] = [
      { logicalId: 'Unknown', changeType: 'CREATE', resourceType: 'AWS::IAM::Role' },
    ];

    const result = await replayFailedOperations(failedOps, state, 'MyStack', ctx);

    // `skip-failed-unknown`: cdkd never learned a physical id, so it has no
    // name to record and nothing the next deploy could adopt. That arm keeps
    // the go-to-k/cdkd#2916 diagnosis as its answer, which is why the diagnosis
    // is kept rather than removed.
    expect(result.orphaned).toEqual([]);
  });
});

describe('orphansAfterRollback (#2934)', () => {
  const entry = (logicalId: string, orphanedAt: number, physicalId: string) => ({
    logicalId,
    orphanedAt,
    state: res({ physicalId }),
  });

  it('returns {} when there is nothing on either side', () => {
    // Load-bearing: a stack that never orphaned anything must keep a
    // byte-identical state.json, so an old binary sees exactly what it saw
    // before and the no-schema-bump argument holds.
    expect(orphansAfterRollback({}, [])).toEqual({});
    expect(orphansAfterRollback({ orphans: undefined }, [])).toEqual({});
  });

  it('carries an existing set forward when this rollback orphaned nothing', () => {
    const previous = [entry('A', 1, 'phys-a')];
    expect(orphansAfterRollback({ orphans: previous }, [])).toEqual({ orphans: previous });
  });

  it('appends a new orphan beside an unrelated existing one', () => {
    const result = orphansAfterRollback({ orphans: [entry('A', 1, 'phys-a')] }, [
      entry('B', 2, 'phys-b'),
    ]);
    expect(result.orphans?.map((o) => o.logicalId)).toEqual(['A', 'B']);
  });

  it('the NEWER record wins for a logical id orphaned twice', () => {
    // One live AWS resource, two records describing it. The later deploy is the
    // one that actually left it there, so keeping both would make the adoption
    // pick arbitrarily between two states of the same resource.
    const result = orphansAfterRollback({ orphans: [entry('A', 1, 'phys-old')] }, [
      entry('A', 2, 'phys-new'),
    ]);
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans?.[0]?.state.physicalId).toBe('phys-new');
    expect(result.orphans?.[0]?.orphanedAt).toBe(2);
  });
});
