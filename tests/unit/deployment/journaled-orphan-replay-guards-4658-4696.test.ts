/**
 * go-to-k/cdkd#4696 / #4658: a replay of an earlier run's journal (`cdkd
 * rollback`, `cdkd destroy`: a `foreignHolder` is supplied) deletes a
 * journaled proven failed-CREATE orphan only as the success settle would.
 * Another stack's record must not hold it (nor be unreadable), then a
 * name-keyed type's live identity must equal the journaled one. A kept orphan
 * is a warned skip naming its physical id; a gone one settles with no delete.
 * The automatic rollback (no `foreignHolder`) asks neither, and an orphan the
 * success settle already proved is not asked again.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

import {
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  makeForeignHolderScan,
  settleJournaledOrphansOnSuccess,
} from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import { rollbackExecutorContext } from '../../../src/deployment/deploy-engine/rollback.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const REGION = 'us-east-1';
const TOKEN = 'arn:aws:kinesis:us-east-1:123456789012:stream/orders@1700000000';

const stream = (over: Partial<FailedOperation> = {}): FailedOperation => ({
  logicalId: 'Orders',
  changeType: 'CREATE',
  resourceType: 'AWS::Kinesis::Stream',
  physicalId: 'orders-stream',
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  createdResourceIdentity: TOKEN,
  attemptedProperties: {},
  ...over,
});

const record = (physicalId: string, resourceType: string): ResourceState => ({
  physicalId,
  resourceType,
  provisionedBy: 'sdk',
  properties: {},
  attributes: {},
  dependencies: [],
});

function harness(opts: { live?: unknown; holding?: unknown; foreignHolder?: unknown } = {}) {
  const del = vi.fn().mockResolvedValue(undefined);
  const resourceIdentity = vi.fn(async () => ('live' in opts ? opts.live : TOKEN));
  const foreignHolder =
    'foreignHolder' in opts ? opts.foreignHolder : vi.fn(async () => opts.holding);
  const warn = vi.fn();
  const info = vi.fn();
  const events: Array<Record<string, unknown>> = [];
  const ctx = {
    region: REGION,
    logger: { debug: vi.fn(), info, warn, error: vi.fn() },
    providerRegistry: {
      getProviderFor: () => ({ provider: { delete: del, resourceIdentity }, provisionedBy: 'sdk' }),
    },
    recordEvent: (e: Record<string, unknown>) => void events.push(e),
    ...(foreignHolder !== undefined && { foreignHolder }),
  } as unknown as RollbackExecutorContext;
  const warned = (): string => warn.mock.calls.map((c) => String(c[0])).join('\n');
  const informed = (): string => info.mock.calls.map((c) => String(c[0])).join('\n');
  return { ctx, del, resourceIdentity, foreignHolder, warned, informed, events };
}

describe('the replay keeps a journaled orphan another stack holds (go-to-k/cdkd#4696)', () => {
  it('sends no delete and asks no identity; a warned skip naming its physical id', async () => {
    const h = harness({ holding: { kind: 'held', by: 'the state record of stack B (us-east-1)' } });
    const result = await replayFailedOperations([stream()], {}, 'A', h.ctx, {});
    expect(h.foreignHolder).toHaveBeenCalledWith('AWS::Kinesis::Stream', 'orders-stream');
    expect(h.del).not.toHaveBeenCalled();
    expect(h.resourceIdentity).not.toHaveBeenCalled();
    expect(h.warned()).toContain('Skipping failed CREATE of Orders');
    expect(h.warned()).toContain('orders-stream');
    expect(h.warned()).toContain('the state record of stack B (us-east-1) holds a resource');
    // As every other warned skip: counted, handled (out of the journal).
    expect(result.skipped).toBe(1);
    expect(result.warnings).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.remainingFailedOps).toEqual([]);
    expect(h.events.map((e) => e['eventType'])).toEqual(['ROLLBACK_RESOURCE_SKIPPED']);
  });

  // No verdict, unlike `held`: the journal keeps the op for a re-run, as the
  // success settle keeps it (a failure, so destroy keeps the state too).
  it('keeps it in the journal, as a failure, when a record cannot be read', async () => {
    const h = harness({ holding: { kind: 'unreadable', what: 'the state record of stack C' } });
    const op = stream();
    const result = await replayFailedOperations([op], {}, 'A', h.ctx, {});
    expect(h.del).not.toHaveBeenCalled();
    expect(h.resourceIdentity).not.toHaveBeenCalled();
    expect(h.warned()).toContain('orders-stream is not deleted');
    expect(h.warned()).toContain('the state record of stack C leaves open whether');
    expect(result).toMatchObject({ failures: 1, skipped: 0, remainingFailedOps: [op] });
    expect(h.events.map((e) => e['eventType'])).toEqual(['ROLLBACK_RESOURCE_FAILED']);
  });

  it('keeps it in the journal, as a failure, when the scan throws', async () => {
    const foreignHolder = vi.fn().mockRejectedValue(new Error('boom'));
    const h = harness({ foreignHolder });
    const op = stream();
    const result = await replayFailedOperations([op], {}, 'A', h.ctx, {});
    expect(h.del).not.toHaveBeenCalled();
    expect(h.warned()).toContain('the scan failed');
    expect(result).toMatchObject({ failures: 1, skipped: 0, remainingFailedOps: [op] });
  });

  // RDS identifiers are case-insensitive (go-to-k/cdkd#4692): `mycluster`
  // held by B is the cluster the journal names `MyCluster`.
  it.each([
    ['keeps', 'mycluster', 0],
    ['control: deletes', 'othercluster', 1],
  ])('%s a cluster another stack holds as %s, through the real scan', async (_l, held, deletes) => {
    const backend = {
      listStacks: vi.fn(async () => [
        { stackName: 'A', region: REGION },
        { stackName: 'B', region: REGION },
      ]),
      getState: vi.fn(async (stackName: string) => ({
        state: {
          version: 10,
          stackName,
          region: REGION,
          resources: stackName === 'B' ? { C: record(held, 'AWS::RDS::DBCluster') } : {},
          outputs: {},
        },
      })),
    };
    const h = harness({
      foreignHolder: makeForeignHolderScan(backend as never)({ stackName: 'A', region: REGION }),
      live: 'cluster-TOKEN',
    });
    const op = stream({
      logicalId: 'Cluster',
      resourceType: 'AWS::RDS::DBCluster',
      physicalId: 'MyCluster',
      createdResourceIdentity: 'cluster-TOKEN',
    });
    await replayFailedOperations([op], {}, 'A', h.ctx, {});
    expect(h.del).toHaveBeenCalledTimes(deletes);
  });
});

describe('the replay keeps a name-keyed orphan whose identity is not proven (go-to-k/cdkd#4658)', () => {
  it('control: deletes it when the live identity equals the journaled one, after both checks', async () => {
    const h = harness();
    const result = await replayFailedOperations([stream()], {}, 'A', h.ctx, {});
    expect(h.foreignHolder).toHaveBeenCalledOnce();
    expect(h.resourceIdentity).toHaveBeenCalledOnce();
    expect(h.del).toHaveBeenCalledOnce();
    expect(h.del.mock.calls[0]![1]).toBe('orders-stream');
    expect(result.skipped).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it('keeps a stream recreated under the orphan’s name (another identity)', async () => {
    const h = harness({ live: `${TOKEN}-recreated` });
    const result = await replayFailedOperations([stream()], {}, 'A', h.ctx, {});
    expect(h.del).not.toHaveBeenCalled();
    expect(h.warned()).toContain('Skipping failed CREATE of Orders');
    expect(h.warned()).toContain('orders-stream');
    expect(h.warned()).toContain('its name was reused');
    expect(result.skipped).toBe(1);
    expect(result.remainingFailedOps).toEqual([]);
  });

  it('keeps one whose journal carries no identity', async () => {
    const h = harness();
    const { createdResourceIdentity: _drop, ...legacy } = stream();
    const result = await replayFailedOperations([legacy], {}, 'A', h.ctx, {});
    expect(h.del).not.toHaveBeenCalled();
    expect(h.warned()).toContain('nothing proves the resource now under that id');
    expect(result.skipped).toBe(1);
  });

  // A token was journaled but the read gave no answer (a throttle, a denied
  // describe): retried, never settled.
  it('keeps one whose live identity cannot be read in the journal, as a failure', async () => {
    const h = harness({ live: undefined });
    const op = stream();
    const result = await replayFailedOperations([op], {}, 'A', h.ctx, {});
    expect(h.del).not.toHaveBeenCalled();
    expect(h.warned()).toContain('its live identity could not be read');
    expect(result).toMatchObject({ failures: 1, skipped: 0, remainingFailedOps: [op] });
  });

  it('settles one AWS reports gone with no delete and no warning', async () => {
    const h = harness({ live: RESOURCE_NOT_FOUND });
    const afterOp = vi.fn();
    const result = await replayFailedOperations([stream()], {}, 'A', h.ctx, { afterOp });
    expect(h.del).not.toHaveBeenCalled();
    expect(afterOp).toHaveBeenCalledWith('Orders');
    expect(h.warned()).toBe('');
    expect(h.informed()).toContain('Orders (AWS::Kinesis::Stream) is already gone');
    expect(result).toMatchObject({ skipped: 0, warnings: 0, failures: 0, remainingFailedOps: [] });
    expect(h.events.map((e) => e['eventType'])).toEqual(['ROLLBACK_RESOURCE_SUCCEEDED']);
  });

  // go-to-k/cdkd#4604: a replacement orphan's logical id holds the resource
  // it was replacing; settling the gone orphan must leave that record.
  it('keeps the record a gone replacement orphan was replacing', async () => {
    const h = harness({ live: RESOURCE_NOT_FOUND });
    const state: Record<string, ResourceState> = {
      Orders: record('old-stream', 'AWS::Kinesis::Stream'),
    };
    const op = stream({
      replacedPhysicalId: 'old-stream',
      replacedResourceType: 'AWS::Kinesis::Stream',
    });
    const result = await replayFailedOperations([op], state, 'A', h.ctx, {});
    expect(h.resourceIdentity).toHaveBeenCalledOnce();
    expect(h.del).not.toHaveBeenCalled();
    expect(result.remainingFailedOps).toEqual([]);
    expect(state['Orders']?.physicalId).toBe('old-stream');
  });

  // A VPC id is generated by AWS and never reused: no identity is needed.
  it('deletes a unique-id type with no identity read', async () => {
    const h = harness();
    const op = stream({
      logicalId: 'Vpc',
      resourceType: 'AWS::EC2::VPC',
      physicalId: 'vpc-0123456789abcdef0',
      createdResourceIdentity: undefined,
    });
    await replayFailedOperations([op], {}, 'A', h.ctx, {});
    expect(h.foreignHolder).toHaveBeenCalledOnce();
    expect(h.resourceIdentity).not.toHaveBeenCalled();
    expect(h.del).toHaveBeenCalledOnce();
  });

  it('still asks the holder scan of a unique-id type, and keeps one another stack holds', async () => {
    const h = harness({ holding: { kind: 'held', by: 'stack B' } });
    const op = stream({ resourceType: 'AWS::EC2::VPC', physicalId: 'vpc-0123456789abcdef0' });
    await replayFailedOperations([op], {}, 'A', h.ctx, {});
    expect(h.foreignHolder).toHaveBeenCalledWith('AWS::EC2::VPC', 'vpc-0123456789abcdef0');
    expect(h.del).not.toHaveBeenCalled();
  });

  it('keeps a Retain orphan with no read and no scan', async () => {
    const h = harness({ live: 'another' });
    const result = await replayFailedOperations(
      [stream({ deletionPolicy: 'Retain' })],
      {},
      'A',
      h.ctx,
      {}
    );
    expect(h.del).not.toHaveBeenCalled();
    expect(h.foreignHolder).not.toHaveBeenCalled();
    expect(h.resourceIdentity).not.toHaveBeenCalled();
    expect(h.informed()).toContain('DeletionPolicy: Retain');
    expect(result.skipped).toBe(0);
  });

  it('asks nothing for a failed CREATE a state record holds (not a journaled orphan)', async () => {
    const h = harness({ live: 'another', holding: { kind: 'held', by: 'stack B' } });
    await replayFailedOperations(
      [stream({ physicalIdRecoveredFromError: undefined })],
      { Orders: record('orders-stream', 'AWS::Kinesis::Stream') },
      'A',
      h.ctx,
      {}
    );
    expect(h.foreignHolder).not.toHaveBeenCalled();
    expect(h.resourceIdentity).not.toHaveBeenCalled();
    expect(h.del).toHaveBeenCalledOnce();
  });
});

describe('the automatic rollback asks neither check (go-to-k/cdkd#4658 / #4696)', () => {
  // Seconds after the failure: no name was freed and reused, and no stack
  // imported the resource. Its in-process identity is best-effort, so a check
  // would keep orphans a provider without `resourceIdentity` could not prove.
  it('deletes a name-keyed orphan with no identity read when no foreignHolder is supplied', async () => {
    const h = harness({ foreignHolder: undefined, live: 'another' });
    const { createdResourceIdentity: _drop, ...noToken } = stream();
    const result = await replayFailedOperations([noToken], {}, 'A', h.ctx, {});
    expect(h.resourceIdentity).not.toHaveBeenCalled();
    expect(h.del).toHaveBeenCalledOnce();
    expect(result.skipped).toBe(0);
  });

  it('its context supplies no foreignHolder', () => {
    const engine = {
      producerRegionEvidence: () => ({ regions: [], complete: true }),
      providerRegistry: {},
      stackRegion: REGION,
      logger: { child: () => ({}) },
      recordEvent: vi.fn(),
      options: {},
      perResourceSecrets: new Map(),
    } as unknown as DeployEngine;
    const state = { version: 10, stackName: 'A', region: REGION, resources: {}, outputs: {} };
    const ctx = rollbackExecutorContext.call(engine, state as unknown as StackState, 'A');
    expect(ctx.region).toBe(REGION);
    expect(ctx).not.toHaveProperty('foreignHolder');
  });
});

describe('the success settle proves an orphan once (go-to-k/cdkd#4655 / #4658)', () => {
  async function settle() {
    const del = vi.fn().mockResolvedValue(undefined);
    const resourceIdentity = vi.fn(async () => TOKEN);
    const provider = { delete: del, resourceIdentity };
    const journal = {
      journalVersion: 1,
      stackName: 'A',
      region: REGION,
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [stream({ deletionPolicy: 'Delete' })],
        },
      ],
    };
    const foreignHolder = vi.fn(async () => undefined);
    const stateBackend = {
      loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
      reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      providerRegistry: { getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })) },
      region: REGION,
      logger,
    } as unknown as RollbackExecutorContext;
    const out = await settleJournaledOrphansOnSuccess({
      stateBackend: stateBackend as never,
      stackName: 'A',
      region: REGION,
      stateResources: {},
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder,
      ctx,
      logger: logger as never,
    });
    return { out, del, resourceIdentity, foreignHolder };
  }

  it('reads the identity once and asks the scan once before its delete', async () => {
    const r = await settle();
    expect(r.del).toHaveBeenCalledOnce();
    expect(r.resourceIdentity).toHaveBeenCalledOnce();
    expect(r.foreignHolder).toHaveBeenCalledOnce();
    expect(r.out.unaddressed).toBe(0);
  });
});
