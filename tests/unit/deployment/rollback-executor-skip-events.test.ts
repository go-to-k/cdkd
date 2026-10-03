/**
 * go-to-k/cdkd#3338: every rollback op the replay DECLINES — leaving the
 * resource exactly as the failed deploy left it — records a durable
 * `ROLLBACK_RESOURCE_SKIPPED` event and counts in `skipped`. Before it, a skip
 * left only a warn line, and the automatic rollback then dropped the journal.
 *
 * One case per skip arm, so dropping any one arm's record reds its own case.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { replayRevert } from '../../../src/deployment/rollback-executor/replay-revert.js';
import type { ReplayOpScope } from '../../../src/deployment/rollback-executor/replay-scope.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

type Recorded = Omit<DeploymentEvent, 'timestamp'>;

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::SQS::Queue',
    properties: { a: 1 },
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: Record<string, unknown> = {}): {
  ctx: RollbackExecutorContext;
  events: Recorded[];
} {
  const events: Recorded[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  return {
    ctx: {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: (e) => events.push(e),
    },
    events,
  };
}

function skips(events: Recorded[]): Recorded[] {
  return events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_SKIPPED');
}

/** The one SKIPPED event, with the fields every arm must carry. */
function expectOneSkip(
  events: Recorded[],
  logicalId: string,
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  reasonNeedle: string
): void {
  const skipped = skips(events);
  expect(skipped).toHaveLength(1);
  expect(skipped[0]).toMatchObject({
    stackName: 'S',
    logicalId,
    operation,
    resourceType: 'AWS::SQS::Queue',
    provisionedBy: 'sdk',
  });
  expect(skipped[0]!.reason).toContain(reasonNeedle);
  // Nothing FAILED: the cause is the reason, and no id points a cleanup pass
  // at anything.
  expect(skipped[0]).not.toHaveProperty('error');
  expect(skipped[0]).not.toHaveProperty('physicalId');
}

describe('replayRollback records a ROLLBACK_RESOURCE_SKIPPED event per declined op', () => {
  it('unrecoverable-delete', async () => {
    const { ctx, events } = makeCtx();
    const op: CompletedOperation = {
      logicalId: 'D',
      changeType: 'DELETE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      previousState: res({ physicalId: 'phys-D' }),
    };
    const result = await replayRollback([op], {}, 'S', ctx);
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'D', 'DELETE', 'cannot re-create a deleted resource');
  });

  it('skip-mismatch', async () => {
    const { ctx, events } = makeCtx();
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-B',
    };
    const result = await replayRollback([op], { B: res({ physicalId: 'phys-later' }) }, 'S', ctx);
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'B', 'CREATE', 'physical id changed');
  });

  it('skip-absent', async () => {
    const { ctx, events } = makeCtx();
    const op: CompletedOperation = {
      logicalId: 'U',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-U',
      previousState: res({ physicalId: 'phys-U' }),
    };
    const result = await replayRollback([op], {}, 'S', ctx);
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'U', 'UPDATE', 'no longer in state');
  });

  it('revert with no previous state', async () => {
    const update = vi.fn();
    const { ctx, events } = makeCtx({ update });
    const op: CompletedOperation = {
      logicalId: 'U',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-U',
    };
    const result = await replayRollback([op], { U: res({ physicalId: 'phys-U' }) }, 'S', ctx);
    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'U', 'UPDATE', 'No previous state is recorded');
  });

  it('revert whose recorded previous state has no properties bag (issue #3203)', async () => {
    const update = vi.fn();
    const { ctx, events } = makeCtx({ update });
    const op: CompletedOperation = {
      logicalId: 'U',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-U',
      previousState: res({ physicalId: 'phys-U', properties: undefined as never }),
    };
    const result = await replayRollback([op], { U: res({ physicalId: 'phys-U' }) }, 'S', ctx);
    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'U', 'UPDATE', 'no `properties` bag');
  });

  it('reverse-replacement whose recorded previous state has no properties bag (issue #3203)', async () => {
    const create = vi.fn();
    const del = vi.fn();
    const { ctx, events } = makeCtx({ create, delete: del });
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-new',
      previousState: res({ physicalId: 'phys-old', properties: undefined as never }),
    };
    const result = await replayRollback([op], { R: res({ physicalId: 'phys-new' }) }, 'S', ctx);
    expect(create).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'R', 'UPDATE', 'no `properties` bag');
  });

  it('delete of a rolled-back CREATE that recorded no physical id', async () => {
    const del = vi.fn();
    const { ctx, events } = makeCtx({ delete: del });
    const op: CompletedOperation = {
      logicalId: 'C',
      changeType: 'CREATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
    };
    const result = await replayRollback([op], { C: res({ physicalId: 'phys-C' }) }, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'C', 'CREATE', 'No physical id is recorded');
  });

  it('control: a reverted op records SUCCEEDED and no skip', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-U', wasReplaced: false });
    const { ctx, events } = makeCtx({ update });
    const op: CompletedOperation = {
      logicalId: 'U',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-U',
      previousState: res({ physicalId: 'phys-U', properties: { a: 1 } }),
    };
    const state = { U: res({ physicalId: 'phys-U', properties: { a: 2 } }) };
    const result = await replayRollback([op], state, 'S', ctx);
    expect(update).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failures: 0, warnings: 0, skipped: 0 });
    expect(skips(events)).toEqual([]);
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });
});

describe("the 'revert' arm's record-not-in-state guard", () => {
  // `classifyRollbackOp` sends an UPDATE with no record to `skip-absent`, so
  // this guard is reached only by calling the arm directly; it records the
  // same event so the two cannot drift apart.
  it('records a skip when the live record is gone', async () => {
    const { ctx, events } = makeCtx();
    const op: CompletedOperation = {
      logicalId: 'U',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-U',
      previousState: res({ physicalId: 'phys-U' }),
    };
    const result = { failures: 0, warnings: 0, skipped: 0, interrupted: false, orphaned: [] };
    await replayRevert({
      op,
      stateResources: {},
      stackName: 'S',
      ctx,
      result,
      logger: ctx.logger,
      mask: (text: string) => text,
    } as unknown as ReplayOpScope);
    expect(result).toMatchObject({ warnings: 1, skipped: 1 });
    expectOneSkip(events, 'U', 'UPDATE', 'not in the current state');
  });
});

describe('replayFailedOperations records a ROLLBACK_RESOURCE_SKIPPED event per declined op', () => {
  it('skip-failed-unknown', async () => {
    const { ctx, events } = makeCtx();
    const op: FailedOperation = {
      logicalId: 'F',
      changeType: 'CREATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
    };
    const result = await replayFailedOperations([op], {}, 'S', ctx);
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'F', 'CREATE', 'recorded no physical id');
  });

  it('skip-failed-absent', async () => {
    const { ctx, events } = makeCtx();
    const op: FailedOperation = {
      logicalId: 'F',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-F',
    };
    const result = await replayFailedOperations([op], { F: res({ physicalId: 'phys-F' }) }, 'S', ctx);
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'F', 'UPDATE', 'No previous state is available');
  });

  it('skip-failed-type-change', async () => {
    const update = vi.fn();
    const { ctx, events } = makeCtx({ update });
    const op: FailedOperation = {
      logicalId: 'F',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-F',
      previousState: res({ physicalId: 'phys-F', resourceType: 'AWS::SNS::Topic' }),
    };
    const result = await replayFailedOperations([op], { F: res({ physicalId: 'phys-F' }) }, 'S', ctx);
    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'F', 'UPDATE', 'Type change (AWS::SNS::Topic -> AWS::SQS::Queue)');
  });

  it('revert-failed-update whose recorded previous state has no properties bag (issue #3203)', async () => {
    const update = vi.fn();
    const { ctx, events } = makeCtx({ update });
    const op: FailedOperation = {
      logicalId: 'F',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-F',
      previousState: res({ physicalId: 'phys-F', properties: undefined as never }),
    };
    const result = await replayFailedOperations([op], { F: res({ physicalId: 'phys-F' }) }, 'S', ctx);
    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expectOneSkip(events, 'F', 'UPDATE', 'no `properties` bag');
  });

  it('control: a failed op with nothing to revert is neither a warning nor a skip', async () => {
    const { ctx, events } = makeCtx();
    const op: FailedOperation = {
      logicalId: 'F',
      changeType: 'DELETE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-F',
    };
    const result = await replayFailedOperations([op], { F: res({ physicalId: 'phys-F' }) }, 'S', ctx);
    expect(result).toMatchObject({ failures: 0, warnings: 0, skipped: 0 });
    expect(skips(events)).toEqual([]);
  });
});

describe('the skip reason goes through the op masker', () => {
  it('a recorded needle in the reason is masked before the event is stored', async () => {
    // The reasons are fixed prose today; a needle spelling part of one proves
    // the text reached `mask` rather than the store raw, so a reason that
    // later interpolates a value cannot leak it.
    const { ctx, events } = makeCtx();
    const needle = 'cannot re-create a deleted resource';
    const needles: RecordedSecretValues = new Map();
    recordLogOnlyValue(needles, needle);
    ctx.logOnlyNeedlesFor = (logicalId) => (logicalId === 'D' ? needles : undefined);
    const op: CompletedOperation = {
      logicalId: 'D',
      changeType: 'DELETE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      previousState: res({ physicalId: 'phys-D' }),
    };
    await replayRollback([op], {}, 'S', ctx);
    const reason = skips(events)[0]!.reason!;
    expect(reason).toContain('The failed deploy deleted this resource');
    expect(reason).not.toContain(needle);
  });
});
