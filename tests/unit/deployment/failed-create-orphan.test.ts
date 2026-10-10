import { describe, it, expect, vi } from 'vite-plus/test';

import {
  classifyFailedOp,
  demoteSupersededOrphans,
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { priorAttemptsInJournal } from '../../../src/deployment/prior-attempt-scope.js';
import {
  carryCreatedBeforeFailure,
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
  markAuxiliaryFailure,
  markCreatedBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { maskSecretsInError } from '../../../src/deployment/secret-redaction/mask-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { RollbackJournal } from '../../../src/types/rollback-journal.js';
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

/**
 * go-to-k/cdkd#1710 — a provider whose `create()` throws AFTER its create call
 * already returned leaves a resource no state record holds. The provider marks
 * the thrown error (`markCreatedBeforeFailure`), the engine journals the id,
 * and `cdkd rollback --revert-failed` deletes it.
 */

const res = (over: Partial<ResourceState> = {}): ResourceState => ({
  physicalId: 'phys',
  resourceType: 'AWS::Kinesis::Stream',
  properties: {},
  attributes: {},
  dependencies: [],
  ...over,
});

const failedCreate = (over: Partial<FailedOperation> = {}): FailedOperation => ({
  logicalId: 'S',
  changeType: 'CREATE',
  resourceType: 'AWS::Kinesis::Stream',
  ...over,
});

describe('markCreatedBeforeFailure / createdBeforeFailure (go-to-k/cdkd#1710)', () => {
  it('reads the mark for the same logical id', () => {
    const err = markCreatedBeforeFailure(new ProvisioningError('boom', 'T', 'S', 's-1'), 'S', 'T', 's-1');
    expect(createdBeforeFailure(err, 'S', 'T')).toBe('s-1');
  });

  // The hazard: `ProvisioningError.physicalId` is the name a provider WAS going
  // to use, also on a collision with another owner's resource.
  it('reads nothing from an unmarked ProvisioningError.physicalId', () => {
    expect(createdBeforeFailure(new ProvisioningError('boom', 'T', 'S', 's-1'), 'S', 'T')).toBeUndefined();
  });

  it('finds the mark under the engine wrap', () => {
    const inner = markCreatedBeforeFailure(new ProvisioningError('inner', 'T', 'S', 's-1'), 'S', 'T', 's-1');
    const outer = new ProvisioningError('Failed to create resource S', 'T', 'S', undefined, inner);
    expect(createdBeforeFailure(outer, 'S', 'T')).toBe('s-1');
  });

  // The SDK error under a provider wrap carries the auxiliary mark of the same
  // create; the walk must pass it to reach a created-mark below it.
  it('passes an auxiliary-marked link of the same logical id', () => {
    const marked = markCreatedBeforeFailure(new Error('deeper'), 'S', 'T', 's-1');
    const aux = markAuxiliaryFailure(Object.assign(new Error('rejected'), { cause: marked }), 'S');
    const outer = new ProvisioningError('outer', 'T', 'S', undefined, aux);
    expect(createdBeforeFailure(outer, 'S', 'T')).toBe('s-1');
  });

  it("stops at another logical id's auxiliary-marked link", () => {
    const marked = markCreatedBeforeFailure(new Error('deeper'), 'S', 'T', 's-1');
    const aux = markAuxiliaryFailure(Object.assign(new Error('rejected'), { cause: marked }), 'Other');
    const outer = new ProvisioningError('outer', 'T', 'S', undefined, aux);
    expect(createdBeforeFailure(outer, 'S', 'T')).toBeUndefined();
  });

  // A nested child can share its parent row's logical id, never its type.
  it('refuses a mark of another resource type', () => {
    const err = markCreatedBeforeFailure(new Error('child'), 'S', 'AWS::Kinesis::Stream', 's-1');
    expect(createdBeforeFailure(err, 'S', 'AWS::CloudFormation::Stack')).toBeUndefined();
    expect(createdBeforeFailure(err, 'S', 'AWS::Kinesis::Stream')).toBe('s-1');
  });

  it('refuses a mark naming another logical id', () => {
    const err = markCreatedBeforeFailure(new ProvisioningError('boom', 'T', 'S', 'x'), 'Other', 'T', 'x');
    expect(createdBeforeFailure(err, 'S', 'T')).toBeUndefined();
  });

  // A nested stack's child error wrapped under its parent row: the walk stops
  // at the child's link even when the mark under it names the parent's id.
  it('stops at a link naming another logical id', () => {
    const marked = markCreatedBeforeFailure(new Error('deep'), 'S', 'T', 's-1');
    const child = new ProvisioningError('child', 'T', 'Child', undefined, marked);
    const outer = new ProvisioningError('outer', 'T', 'S', undefined, child);
    expect(createdBeforeFailure(outer, 'S', 'T')).toBeUndefined();
  });

  it('marks nothing for a blank id, a primitive, or a frozen error', () => {
    expect(createdBeforeFailure(markCreatedBeforeFailure(new Error('x'), 'S', 'T', ''), 'S', 'T')).toBeUndefined();
    expect(markCreatedBeforeFailure('boom', 'S', 'T', 's-1')).toBe('boom');
    const frozen = Object.freeze(new Error('x'));
    expect(createdBeforeFailure(markCreatedBeforeFailure(frozen, 'S', 'T', 's-1'), 'S', 'T')).toBeUndefined();
  });

  it('is non-enumerable, so it never serializes', () => {
    const err = markCreatedBeforeFailure(new Error('x'), 'S', 'T', 's-1');
    expect(JSON.stringify({ ...err })).not.toContain('s-1');
  });

  it('is depth-bounded against a self-referencing chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(createdBeforeFailure(err, 'S', 'T')).toBeUndefined();
  });

  // The engine masks the provider's error before wrapping it; the clone must
  // keep the mark or the recovery is lost whenever a secret matched.
  it("survives maskSecretsInError's clone", () => {
    const err = markCreatedBeforeFailure(
      new ProvisioningError('leaked hunter2', 'T', 'S', 's-1'),
      'S',
      'T',
      's-1'
    );
    const masked = maskSecretsInError(err, new Map([['hunter2', 'Secret']]));
    expect(masked).not.toBe(err);
    expect(createdBeforeFailure(masked, 'S', 'T')).toBe('s-1');
  });
});

describe('carryCreatedBeforeFailure (go-to-k/cdkd#1710)', () => {
  // A retried create collides with the resource its earlier attempt made; the
  // collision's own error proves nothing, so the earlier mark rides on it.
  it('carries an earlier attempt’s mark onto the later error', () => {
    const first = markCreatedBeforeFailure(new Error('throttled after create'), 'S', 'T', 's-1');
    const second = carryCreatedBeforeFailure(first, new Error('ResourceInUseException'));
    expect(createdBeforeFailure(second, 'S', 'T')).toBe('s-1');
  });

  it("keeps the later error's own mark", () => {
    const first = markCreatedBeforeFailure(new Error('a'), 'S', 'T', 's-1');
    const second = markCreatedBeforeFailure(new Error('b'), 'S', 'T', 's-2');
    expect(createdBeforeFailure(carryCreatedBeforeFailure(first, second), 'S', 'T')).toBe('s-2');
  });

  it('adds nothing when the earlier error carries no mark', () => {
    const second = carryCreatedBeforeFailure(new Error('a'), new Error('b'));
    expect(createdBeforeFailure(second, 'S', 'T')).toBeUndefined();
  });
});

// go-to-k/cdkd#4655: a provider may carry its create response's identity
// token on the mark, which the deploy engine journals without a live read.
describe('the mark\'s optional createdResourceIdentity (go-to-k/cdkd#4655)', () => {
  it('reads it back under the same anchor as the physical id', () => {
    const e = markCreatedBeforeFailure(new Error('x'), 'S', 'T', 's-1', 'tok-1');
    expect(createdBeforeFailure(e, 'S', 'T')).toBe('s-1');
    expect(createdResourceIdentityBeforeFailure(e, 'S', 'T')).toBe('tok-1');
    // Another logical id or type: neither is read.
    expect(createdResourceIdentityBeforeFailure(e, 'Other', 'T')).toBeUndefined();
    expect(createdResourceIdentityBeforeFailure(e, 'S', 'Other')).toBeUndefined();
  });

  it('is absent when the marker passed none or an empty one; the mark itself stands', () => {
    for (const e of [
      markCreatedBeforeFailure(new Error('x'), 'S', 'T', 's-1'),
      markCreatedBeforeFailure(new Error('x'), 'S', 'T', 's-1', ''),
    ]) {
      expect(createdBeforeFailure(e, 'S', 'T')).toBe('s-1');
      expect(createdResourceIdentityBeforeFailure(e, 'S', 'T')).toBeUndefined();
    }
  });

  it('the reader drops an identity that is not a non-empty string, keeping the mark', () => {
    for (const bad of [42, '', null, { a: 1 }]) {
      const e = new Error('x');
      Object.defineProperty(e, Symbol.for('cdkd.createdBeforeFailure'), {
        value: Object.freeze({
          logicalId: 'S',
          resourceType: 'T',
          physicalId: 's-1',
          createdResourceIdentity: bad,
        }),
      });
      expect(createdBeforeFailure(e, 'S', 'T')).toBe('s-1');
      expect(createdResourceIdentityBeforeFailure(e, 'S', 'T')).toBeUndefined();
    }
  });

  it('rides along when a retry carries the earlier attempt\'s mark onto the later error', () => {
    const first = markCreatedBeforeFailure(new Error('describe denied'), 'S', 'T', 's-1', 'tok-1');
    const second = carryCreatedBeforeFailure(first, new Error('AlreadyExists'));
    expect(createdBeforeFailure(second, 'S', 'T')).toBe('s-1');
    expect(createdResourceIdentityBeforeFailure(second, 'S', 'T')).toBe('tok-1');
  });
});

describe('classifyFailedOp: a failed CREATE that made its resource (go-to-k/cdkd#1710)', () => {
  // Before #1710 this returned `skip-failed-noop`: a failed CREATE never has a
  // state record, so the delete arms were unreachable for it.
  it('deletes the proven orphan, which has no state record', () => {
    const op = failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: true });
    expect(classifyFailedOp(op, {})).toBe('delete-failed-create');
  });

  it.each([
    ['Retain', 'orphan-failed-create-retain'],
    ['Snapshot', 'delete-failed-create-with-final-snapshot'],
    ['Delete', 'delete-failed-create'],
    ['RetainExceptOnCreate', 'delete-failed-create'],
  ] as const)('honours the journaled DeletionPolicy %s', (policy, expected) => {
    const op = failedCreate({
      physicalId: 's-1',
      physicalIdRecoveredFromError: true,
      deletionPolicy: policy,
    });
    expect(classifyFailedOp(op, {})).toBe(expected);
  });

  // CloudFormation's default for a standalone DB instance is Snapshot; the
  // attempted bag is what tells a standalone one from a cluster member.
  it('applies the absent-policy default from the attempted properties', () => {
    const base = {
      resourceType: 'AWS::RDS::DBInstance',
      physicalId: 'db-1',
      physicalIdRecoveredFromError: true,
    } as const;
    expect(classifyFailedOp(failedCreate({ ...base, attemptedProperties: {} }), {})).toBe(
      'delete-failed-create-with-final-snapshot'
    );
    expect(
      classifyFailedOp(
        failedCreate({ ...base, attemptedProperties: { DBClusterIdentifier: 'c' } }),
        {}
      )
    ).toBe('delete-failed-create');
  });

  // #1198's idempotent re-run: a state-sourced id whose record is gone was
  // already removed by an earlier --revert-failed.
  it('still skips a state-sourced id whose record is gone', () => {
    expect(classifyFailedOp(failedCreate({ physicalId: 's-1' }), {})).toBe('skip-failed-noop');
  });

  it('keeps the skip for a journal an older binary wrote', () => {
    const op = failedCreate({ physicalId: 's-1', deletionPolicy: 'Retain' });
    expect(classifyFailedOp(op, {})).toBe('skip-failed-noop');
  });

  it('still skips a failed CREATE with no physical id', () => {
    expect(classifyFailedOp(failedCreate({}), {})).toBe('skip-failed-unknown');
  });

  // No state record ever held the proven orphan, so a record now holding its
  // logical id is a LATER operation's, which owns the resource.
  it('skips when state now records its logical id with the same physical id', () => {
    const op = failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: true });
    expect(classifyFailedOp(op, { S: res({ physicalId: 's-1' }) })).toBe('skip-failed-noop');
  });

  // A `cdkd import` adopted the stream under another logical id.
  it('skips when state records its physical id under another logical id', () => {
    const op = failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: true });
    expect(classifyFailedOp(op, { Renamed: res({ physicalId: 's-1' }) })).toBe('skip-failed-noop');
  });

  // Every stack holds other resources of the type; only the SAME id blocks.
  it('control: a same-type record with another physical id does not block the delete', () => {
    const op = failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: true });
    expect(classifyFailedOp(op, { Other: res({ physicalId: 'different' }) })).toBe('delete-failed-create');
  });

  it('control: a same-id record of another type does not block the delete', () => {
    const op = failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: true });
    const other = res({ physicalId: 's-1', resourceType: 'AWS::SQS::Queue' });
    expect(classifyFailedOp(op, { Q: other })).toBe('delete-failed-create');
  });

  it('skips a proven orphan the supersede pass demoted, with a warned verdict', () => {
    const op = failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: false });
    expect(classifyFailedOp(op, {})).toBe('skip-failed-superseded');
  });

  it('still refuses on a mismatch against an existing record', () => {
    const op = failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: true });
    expect(classifyFailedOp(op, { S: res({ physicalId: 'other' }) })).toBe('skip-failed-mismatch');
  });
});

describe('priorAttemptsInJournal: a proven orphan stays evidence (go-to-k/cdkd#1710)', () => {
  const journalWith = (op: FailedOperation): RollbackJournal =>
    ({
      version: 1,
      segments: [{ timestamp: 1, reason: 'no-rollback-failure', operations: [], failedOperations: [op] }],
    }) as unknown as RollbackJournal;

  it('keeps the bag of a failed CREATE whose id the provider proved', () => {
    const op = failedCreate({
      physicalId: 's-1',
      physicalIdRecoveredFromError: true,
      attemptedProperties: { Name: 's-1' },
    });
    expect(priorAttemptsInJournal(journalWith(op), 'S', 'AWS::Kinesis::Stream')).toEqual([
      { Name: 's-1' },
    ]);
  });

  it('control: drops the bag of a failed CREATE with a state-sourced id', () => {
    const op = failedCreate({ physicalId: 's-1', attemptedProperties: { Name: 's-1' } });
    expect(priorAttemptsInJournal(journalWith(op), 'S', 'AWS::Kinesis::Stream')).toEqual([]);
  });

  // go-to-k/cdkd#4690: `cdkd rollback` keeps a delete-first replacement UPDATE
  // after settling its orphan; the orphan carried the evidence, not the UPDATE.
  it("ignores the bag of a replacement UPDATE that journaled its new resource as an orphan", () => {
    const update = (over: Partial<FailedOperation>): FailedOperation => ({
      logicalId: 'S',
      changeType: 'UPDATE',
      resourceType: 'AWS::Kinesis::Stream',
      physicalId: 's-old',
      previousState: {
        physicalId: 's-old',
        resourceType: 'AWS::Kinesis::Stream',
        properties: {},
        attributes: {},
        dependencies: [],
      },
      attemptedProperties: { Name: 's-new' },
      ...over,
    });
    for (const replacementOrphaned of ['delete-first', 'create-first'] as const) {
      expect(
        priorAttemptsInJournal(journalWith(update({ replacementOrphaned })), 'S', 'AWS::Kinesis::Stream')
      ).toEqual([]);
    }
    // Control: a bare delete-first UPDATE (no orphan) keeps its bag as evidence.
    expect(
      priorAttemptsInJournal(journalWith(update({ oldDeletedBeforeCreate: true })), 'S', 'AWS::Kinesis::Stream')
    ).toEqual([{ Name: 's-new' }]);
  });
});

describe('replayFailedOperations: the proven orphan is deleted (go-to-k/cdkd#1710)', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];

  function ctxWith(del: ReturnType<typeof vi.fn>) {
    const getProviderFor = vi.fn(() => ({ provider: { delete: del }, provisionedBy: 'sdk' }));
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger,
      providerRegistry: { getProviderFor } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    return { ctx, getProviderFor };
  }

  it('deletes it through the journaled route and settles the op', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, getProviderFor } = ctxWith(del);
    const op = failedCreate({
      physicalId: 's-1',
      physicalIdRecoveredFromError: true,
      provisionedBy: 'sdk',
      attemptedProperties: { Name: 's-1' },
    });
    const result = await replayFailedOperations([op], {}, 'Stack', ctx, {});
    expect(del).toHaveBeenCalledOnce();
    expect(del.mock.calls[0]!.slice(0, 4)).toEqual([
      'S',
      's-1',
      'AWS::Kinesis::Stream',
      { Name: 's-1' },
    ]);
    expect(getProviderFor).toHaveBeenCalledWith({
      resourceType: 'AWS::Kinesis::Stream',
      provisionedBy: 'sdk',
    });
    expect(result.failures).toBe(0);
    expect(result.remainingFailedOps).toEqual([]);
  });

  it('keeps it in AWS under a journaled Retain', async () => {
    const del = vi.fn();
    const { ctx } = ctxWith(del);
    const op = failedCreate({
      physicalId: 's-1',
      physicalIdRecoveredFromError: true,
      deletionPolicy: 'Retain',
    });
    const onOrphan = vi.fn();
    const result = await replayFailedOperations([op], {}, 'Stack', ctx, { onOrphan });
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(result.remainingFailedOps).toEqual([]);
    // It was never in state: no rollback-orphan record with an undefined state.
    expect(result.orphaned).toEqual([]);
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it('does not delete a stream state tracks under another logical id', async () => {
    const del = vi.fn();
    const { ctx } = ctxWith(del);
    const op = failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: true });
    await replayFailedOperations([op], { Renamed: res({ physicalId: 's-1' }) }, 'Stack', ctx, {});
    expect(del).not.toHaveBeenCalled();
  });

  it('control: an unflagged id with no record is not deleted', async () => {
    const del = vi.fn();
    const { ctx } = ctxWith(del);
    await replayFailedOperations([failedCreate({ physicalId: 's-1' })], {}, 'Stack', ctx, {});
    expect(del).not.toHaveBeenCalled();
  });
});

describe('demoteSupersededOrphans (go-to-k/cdkd#1710)', () => {
  type Seg = Parameters<typeof demoteSupersededOrphans>[0][number];
  const proven = (): FailedOperation =>
    failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: true });

  it('keeps an orphan in the newest segment', () => {
    const op = proven();
    expect(
      demoteSupersededOrphans([{ failedOperations: [failedCreate({ logicalId: 'X' })] }, { failedOperations: [op] }])
    ).toBe(0);
    expect(op.physicalIdRecoveredFromError).toBe(true);
    expect(classifyFailedOp(op, {})).toBe('delete-failed-create');
  });

  // The most common flow: the deploy failed after CreateStream, the user
  // redeployed, the retry's CreateStream collided with the orphan's name
  // (unmarked, no id) and other resources completed. The orphan is still the
  // stack's to delete.
  it('keeps the orphan through a redeploy whose CREATE collided with it', () => {
    const op = proven();
    const segs: Seg[] = [
      { operations: [], failedOperations: [op] },
      {
        operations: [
          { logicalId: 'Marker', changeType: 'UPDATE', resourceType: 'AWS::SSM::Parameter', physicalId: 'm', previousState: res({ physicalId: 'm', resourceType: 'AWS::SSM::Parameter' }) },
          { logicalId: 'Q', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue', physicalId: 'q' },
        ],
        failedOperations: [failedCreate({})],
      },
    ];
    expect(demoteSupersededOrphans(segs)).toBe(0);
    expect(classifyFailedOp(op, {})).toBe('delete-failed-create');
  });

  it.each([
    ['a completed CREATE of its type (any logical id)', { operations: [{ logicalId: 'Renamed', changeType: 'CREATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'other' }] }],
    ['an op naming its physical id', { operations: [{ logicalId: 'R', changeType: 'UPDATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 's-1' }] }],
    ['an op whose previous state names its physical id', { operations: [{ logicalId: 'R', changeType: 'DELETE', resourceType: 'AWS::Kinesis::Stream', previousState: res({ physicalId: 's-1' }) }] }],
    ['a failed op with a state-sourced id equal to its own', { failedOperations: [failedCreate({ logicalId: 'R', physicalId: 's-1' })] }],
    // That newer entry's replay, under its own DeletionPolicy, governs it.
    ['a newer proven orphan of the same id', { failedOperations: [failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: true })] }],
  ] as Array<[string, Seg]>)('demotes on a newer segment holding %s', (_label, newer) => {
    const op = proven();
    expect(demoteSupersededOrphans([{ failedOperations: [op] }, newer])).toBe(1);
    expect(op.physicalIdRecoveredFromError).toBe(false);
    expect(classifyFailedOp(op, {})).toBe('skip-failed-superseded');
  });

  it.each([
    ['a completed CREATE of another type', { operations: [{ logicalId: 'Q', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue', physicalId: 's-1' }] }],
    ['a completed UPDATE of its type with another id', { operations: [{ logicalId: 'R', changeType: 'UPDATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'other', previousState: res({ physicalId: 'other' }) }] }],
    ['a failed op with another id', { failedOperations: [failedCreate({ logicalId: 'R', physicalId: 'other' })] }],
  ] as Array<[string, Seg]>)('control: keeps it through a newer segment holding %s', (_label, newer) => {
    const op = proven();
    expect(demoteSupersededOrphans([{ failedOperations: [op] }, newer])).toBe(0);
  });

  it('control: an OLDER segment that would supersede it does not', () => {
    const op = proven();
    const segs: Seg[] = [
      { operations: [{ logicalId: 'S', changeType: 'CREATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 's-1' }], supersededLogicalIds: ['S'] },
      { operations: [], failedOperations: [op] },
    ];
    expect(demoteSupersededOrphans(segs)).toBe(0);
  });

  it("control: its own segment's supersededLogicalIds naming another id does not", () => {
    const op = proven();
    expect(demoteSupersededOrphans([{ failedOperations: [op], supersededLogicalIds: ['Other'] }])).toBe(0);
  });

  it('demotes on a supersededLogicalIds entry from its own segment on', () => {
    const op = proven();
    expect(demoteSupersededOrphans([{ failedOperations: [op], supersededLogicalIds: ['S'] }])).toBe(1);
  });

  // A later rollback RETAINED a re-created resource: state keeps it only as a
  // rollback-orphan record, never as a resource row.
  it.each([
    ['its logical id', { logicalId: 'S', state: res({ physicalId: 'other' }) }],
    ['its physical id under another logical id', { logicalId: 'Renamed', state: res({ physicalId: 's-1' }) }],
  ])('demotes when a rollback-orphan record holds %s', (_label, orphan) => {
    const op = proven();
    expect(demoteSupersededOrphans([{ failedOperations: [op] }], [orphan])).toBe(1);
  });

  it('control: a same-id rollback-orphan record of another type does not demote', () => {
    const op = proven();
    expect(
      demoteSupersededOrphans(
        [{ failedOperations: [op] }],
        [{ logicalId: 'X', state: res({ physicalId: 's-1', resourceType: 'AWS::SQS::Queue' }) }]
      )
    ).toBe(0);
  });

  it('control: an unrelated rollback-orphan record does not demote', () => {
    const op = proven();
    expect(
      demoteSupersededOrphans([{ failedOperations: [op] }], [{ logicalId: 'X', state: res({ physicalId: 'x' }) }])
    ).toBe(0);
  });

  it('leaves an unflagged op alone', () => {
    const op = failedCreate({ physicalId: 's-1' });
    demoteSupersededOrphans([
      { failedOperations: [op] },
      { operations: [{ logicalId: 'S', changeType: 'CREATE', resourceType: 'AWS::Kinesis::Stream' }] },
    ]);
    expect(op).not.toHaveProperty('physicalIdRecoveredFromError');
  });
});

describe('replayFailedOperations: a demoted orphan is warned about, not deleted (go-to-k/cdkd#1710)', () => {
  it('names the masked id in a warning and records a skip', async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), setLevel: vi.fn(), child: () => logger };
    const del = vi.fn();
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger: logger as unknown as RollbackExecutorContext['logger'],
      providerRegistry: { getProviderFor: () => ({ provider: { delete: del } }) } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    const op = failedCreate({ physicalId: 's-1', physicalIdRecoveredFromError: false });
    const result = await replayFailedOperations([op], {}, 'Stack', ctx, {});
    expect(del).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes('it created s-1 before failing'))).toBe(true);
    expect(result.warnings).toBeGreaterThan(0);
    expect(result.remainingFailedOps).toEqual([]);
  });
});
