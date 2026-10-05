/**
 * The rollback executor persists a delete's indeterminate guards (issue
 * https://github.com/go-to-k/cdkd/issues/2422).
 *
 * Every rollback delete arm routes its result through `throwIfDeleteSkipped`,
 * which now records one `RESOURCE_GUARD_INDETERMINATE` event per guard — the
 * SAME event type `cdkd destroy` and `cdkd deploy` record, with
 * `operation: 'DELETE'` — before it turns a `'skipped'` outcome into a throw.
 * Each arm is driven the way `rollback-executor-delete-skipped.test.ts` drives
 * it for the skip.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { throwIfDeleteSkipped } from '../../../src/deployment/rollback-executor/messages.js';
import type { ResourceState } from '../../../src/types/state.js';
import type { ResourceDeleteResult } from '../../../src/types/resource.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';
import { awsSdkError } from '../_aws-sdk-error.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const GUARD_ID = 'cc-delete-region-identity';

function guarded(physicalId: string): ResourceDeleteResult {
  return {
    outcome: 'deleted',
    indeterminateGuards: [
      { guard: GUARD_ID, reason: `s3:GetBucketLocation on ${physicalId} could not be answered` },
    ],
  };
}

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
    attributes: {},
    dependencies: [],
    provisionedBy: 'cc-api',
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

function makeCtx(
  provider: { delete?: unknown; create?: unknown },
  route: 'sdk' | 'cc-api' | undefined = 'cc-api'
): {
  ctx: RollbackExecutorContext;
  events: Array<Omit<DeploymentEvent, 'timestamp'>>;
} {
  const events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: route }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) => events.push(e),
  };
  return { ctx, events };
}

function guardRows(
  events: Array<Omit<DeploymentEvent, 'timestamp'>>
): Array<Omit<DeploymentEvent, 'timestamp'>> {
  return events.filter((e) => e.eventType === 'RESOURCE_GUARD_INDETERMINATE');
}

/** The destroy runner's payload, aimed at the resource the rollback deleted. */
function expectedRow(physicalId: string): Omit<DeploymentEvent, 'timestamp'> {
  return {
    eventType: 'RESOURCE_GUARD_INDETERMINATE',
    stackName: 'S',
    operation: 'DELETE',
    logicalId: 'B',
    resourceType: 'AWS::S3::Bucket',
    provisionedBy: 'cc-api',
    physicalId,
    guard: GUARD_ID,
    reason: `s3:GetBucketLocation on ${physicalId} could not be answered`,
  };
}

describe('rollback executor — indeterminate guards on rollback deletes (#2422)', () => {
  it('rollback-of-a-CREATE: one row, beside ROLLBACK_RESOURCE_SUCCEEDED', async () => {
    const del = vi.fn().mockResolvedValue(guarded('phys-B'));
    const { ctx, events } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B' },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'phys-B' }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(del).toHaveBeenCalledOnce();
    expect(result.failures).toBe(0);
    expect(guardRows(events)).toEqual([expectedRow('phys-B')]);
    const types = events.map((e) => e.eventType);
    expect(types.indexOf('ROLLBACK_RESOURCE_SUCCEEDED')).toBeGreaterThan(
      types.indexOf('RESOURCE_GUARD_INDETERMINATE')
    );
  });

  it('rollback-of-a-CREATE: a guard on a SKIPPED delete persists, and the skip still fails the op', async () => {
    const del = vi.fn().mockResolvedValue({
      ...guarded('phys-B'),
      outcome: 'skipped',
      reason: 'malformed physicalId in state — no delete issued',
    });
    const { ctx, events } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B' },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'phys-B' }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.failures).toBe(1);
    expect(state['B']).toBeDefined();
    expect(guardRows(events)).toEqual([expectedRow('phys-B')]);
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_FAILED');
  });

  it('reverse-replacement re-adopt', async () => {
    const del = vi.fn().mockResolvedValue(guarded('new-b'));
    const { ctx, events } = makeCtx({ delete: del });
    const prev = res({ physicalId: 'old-b', updateReplacePolicy: 'Retain' as const });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'new-b',
        previousState: prev,
        oldResourceRetained: true,
      },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'new-b' }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(del).toHaveBeenCalledOnce();
    expect(result.failures).toBe(0);
    expect(state['B']?.physicalId).toBe('old-b');
    expect(guardRows(events)).toEqual([expectedRow('new-b')]);
  });

  it('reverse-replacement delete-new-first (the collision path)', async () => {
    const del = vi.fn().mockResolvedValue(guarded('new-b'));
    const create = vi
      .fn()
      .mockRejectedValueOnce(awsSdkError("Resource of type 'AWS::S3::Bucket' already exists."))
      .mockResolvedValue({ physicalId: 'old-b', attributes: {} });
    const { ctx, events } = makeCtx({ delete: del, create });
    const prev = res({ physicalId: 'old-b', properties: { BucketName: 'b', a: 1 } });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'new-b',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'new-b', properties: { BucketName: 'b' } }),
    };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(del).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.failures).toBe(0);
    expect(guardRows(events)).toEqual([expectedRow('new-b')]);
  });

  it('reverse-replacement delete-new AFTER the re-create', async () => {
    const del = vi.fn().mockResolvedValue(guarded('new-b'));
    const create = vi.fn().mockResolvedValue({ physicalId: 'old-b', attributes: {} });
    const { ctx, events } = makeCtx({ delete: del, create });
    const prev = res({ physicalId: 'old-b', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'new-b',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'new-b' }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(create).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledOnce();
    expect(result.warnings).toBe(0);
    expect(guardRows(events)).toEqual([expectedRow('new-b')]);
  });

  it('--revert-failed partially-created delete', async () => {
    const del = vi.fn().mockResolvedValue(guarded('phys-B'));
    const { ctx, events } = makeCtx({ delete: del });
    const failed: FailedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'CREATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys-B',
        attemptedProperties: {},
      },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'phys-B' }) };

    const result = await replayFailedOperations(failed, state, 'S', ctx, {});

    expect(del).toHaveBeenCalledOnce();
    expect(result.failures).toBe(0);
    expect(guardRows(events)).toEqual([expectedRow('phys-B')]);
  });

  describe('a legacy record naming no layer: the row names the layer the delete was ROUTED to', () => {
    function legacy(physicalId: string): ResourceState {
      const record = res({ physicalId });
      delete (record as { provisionedBy?: unknown }).provisionedBy;
      return record;
    }

    it('reverse-replacement re-adopt', async () => {
      const del = vi.fn().mockResolvedValue(guarded('new-b'));
      const { ctx, events } = makeCtx({ delete: del });
      const ops: CompletedOperation[] = [
        {
          logicalId: 'B',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'new-b',
          previousState: legacy('old-b'),
          oldResourceRetained: true,
        },
      ];
      const state: Record<string, ResourceState> = { B: legacy('new-b') };

      await replayRollback(ops, state, 'S', ctx);

      expect(del).toHaveBeenCalledOnce();
      expect(guardRows(events)).toEqual([expectedRow('new-b')]);
    });

    it('reverse-replacement delete-new-first', async () => {
      const del = vi.fn().mockResolvedValue(guarded('new-b'));
      const create = vi
        .fn()
        .mockRejectedValueOnce(awsSdkError("Resource of type 'AWS::S3::Bucket' already exists."))
        .mockResolvedValue({ physicalId: 'old-b', attributes: {} });
      const { ctx, events } = makeCtx({ delete: del, create });
      const prev = { ...legacy('old-b'), properties: { BucketName: 'b', a: 1 } };
      const ops: CompletedOperation[] = [
        {
          logicalId: 'B',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'new-b',
          previousState: prev,
        },
      ];
      const state: Record<string, ResourceState> = {
        B: { ...legacy('new-b'), properties: { BucketName: 'b' } },
      };

      await replayRollback(ops, state, 'S', ctx);

      expect(del).toHaveBeenCalledOnce();
      expect(guardRows(events)).toEqual([expectedRow('new-b')]);
    });

    it('reverse-replacement delete-new AFTER the re-create', async () => {
      const del = vi.fn().mockResolvedValue(guarded('new-b'));
      const create = vi.fn().mockResolvedValue({ physicalId: 'old-b', attributes: {} });
      const { ctx, events } = makeCtx({ delete: del, create });
      const prev = { ...legacy('old-b'), properties: { a: 1 } };
      const ops: CompletedOperation[] = [
        {
          logicalId: 'B',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'new-b',
          previousState: prev,
        },
      ];
      const state: Record<string, ResourceState> = { B: legacy('new-b') };

      await replayRollback(ops, state, 'S', ctx);

      expect(del).toHaveBeenCalledOnce();
      expect(guardRows(events)).toEqual([expectedRow('new-b')]);
    });
  });

  it('control: a delete reporting no guard records no guard row', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B' },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'phys-B' }) };

    await replayRollback(ops, state, 'S', ctx);

    expect(del).toHaveBeenCalledOnce();
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
    expect(guardRows(events)).toEqual([]);
  });
});

describe('throwIfDeleteSkipped — the shared helper every arm routes through (#2422)', () => {
  function scope(events: Array<Omit<DeploymentEvent, 'timestamp'>>) {
    return {
      ctx: { recordEvent: (e: Omit<DeploymentEvent, 'timestamp'>) => events.push(e) },
      stackName: 'S',
      resourceType: 'AWS::S3::Bucket',
      provisionedBy: undefined,
      mask: (text: string) => text.replaceAll('secret-name', '***'),
    };
  }

  it("masks the row's physical id and reason with the op's masker", () => {
    const events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
    throwIfDeleteSkipped(guarded('secret-name'), 'B', 'secret-name', 'while testing', scope(events));
    expect(guardRows(events)).toEqual([
      {
        eventType: 'RESOURCE_GUARD_INDETERMINATE',
        stackName: 'S',
        operation: 'DELETE',
        logicalId: 'B',
        resourceType: 'AWS::S3::Bucket',
        physicalId: '***',
        guard: GUARD_ID,
        reason: 's3:GetBucketLocation on *** could not be answered',
      },
    ]);
  });

  it("still throws on a 'skipped' outcome, after recording the guard", () => {
    const events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
    expect(() =>
      throwIfDeleteSkipped(
        { ...guarded('p'), outcome: 'skipped', reason: 'no delete issued' },
        'B',
        'p',
        'while testing',
        scope(events)
      )
    ).toThrow('no delete issued');
    expect(guardRows(events)).toHaveLength(1);
  });

  it('records nothing and does not throw for a void result', () => {
    const events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
    throwIfDeleteSkipped(undefined, 'B', 'p', 'while testing', scope(events));
    expect(events).toEqual([]);
  });
});
