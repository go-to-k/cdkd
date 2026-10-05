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
  warns: string[];
} {
  const events: Recorded[] = [];
  const warns: string[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((m: string) => warns.push(m)),
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
    warns,
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
    const { ctx, events, warns } = makeCtx({ update });
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
    // The arm's own consequence: a re-classification to another arm reds.
    expect(warns.join('\n')).toContain('a patch provider removes every property');
  });

  it('reverse-replacement whose recorded previous state has no properties bag (issue #3203)', async () => {
    const create = vi.fn();
    const del = vi.fn();
    const { ctx, events, warns } = makeCtx({ create, delete: del });
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
    // The arm's own consequence: a re-classification to another arm reds.
    expect(warns.join('\n')).toContain('create a default-configured resource and then delete the live one');
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
    const { ctx, events, warns } = makeCtx({ update });
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
    // The arm's own remedy: a re-classification to another arm reds.
    expect(warns.join('\n')).toContain('this op died mid-flight');
  });

  it('skip-failed-mismatch: a failed CREATE whose recorded id state no longer names (go-to-k/cdkd#4552)', async () => {
    // No import mark: the CLI hands such an op to this replay. State names
    // another resource under the id, so the recorded one may be live and
    // untracked: warned and counted (exit 2), nothing deleted, record kept.
    const del = vi.fn();
    const { ctx, events, warns } = makeCtx({ delete: del });
    const op: FailedOperation = {
      logicalId: 'F',
      changeType: 'CREATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-recorded',
    };
    const record = res({ physicalId: 'phys-imported' });
    const state = { F: record };
    const result = await replayFailedOperations([op], state, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(state.F).toBe(record);
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expect(result.remainingFailedOps).toEqual([]);
    expectOneSkip(events, 'F', 'CREATE', 'other than the one state now tracks');
    // The event carries no physical id; the warn line names the recorded one.
    expect(JSON.stringify(skips(events))).not.toContain('phys-recorded');
    expect(warns.join('\n')).toContain('it recorded phys-recorded');
  });

  it('skip-failed-superseded: a proven orphan later activity may own (go-to-k/cdkd#1710)', async () => {
    const del = vi.fn();
    const { ctx, events, warns } = makeCtx({ delete: del });
    const op: FailedOperation = {
      logicalId: 'F',
      changeType: 'CREATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-orphan',
      physicalIdRecoveredFromError: false,
    };
    const result = await replayFailedOperations([op], {}, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 1 });
    expect(result.remainingFailedOps).toEqual([]);
    expectOneSkip(events, 'F', 'CREATE', 'may own a resource under that id now');
    expect(JSON.stringify(skips(events))).not.toContain('phys-orphan');
    expect(warns.join('\n')).toContain('it created phys-orphan before failing');
  });

  it('control: a failed CREATE whose record is already gone stays a silent no-op', async () => {
    // The re-run case `skip-failed-mismatch` was split from: no record at all.
    const del = vi.fn();
    const { ctx, events, warns } = makeCtx({ delete: del });
    const op: FailedOperation = {
      logicalId: 'F',
      changeType: 'CREATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-recorded',
    };
    const result = await replayFailedOperations([op], {}, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failures: 0, warnings: 0, skipped: 0 });
    expect(skips(events)).toEqual([]);
    expect(warns).toEqual([]);
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

describe('a reverse-replacement whose re-create adopted the live new resource', () => {
  it('gives its SUCCEEDED event a reason, and no survivor id', async () => {
    // A name-idempotent Create API hands the live NEW resource back, so the
    // replacement is not fully reversed; the warn line was the only trace.
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-new', attributes: {} });
    const del = vi.fn();
    const { ctx, events } = makeCtx({ create, delete: del });
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-new',
      previousState: res({ physicalId: 'phys-old', properties: { QueueName: 'q', a: 1 } }),
    };
    const state = { R: res({ physicalId: 'phys-new', properties: { QueueName: 'q', a: 2 } }) };
    const result = await replayRollback([op], state, 'S', ctx);
    expect(create).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    // Reverted with a warning, not skipped: the journal may still settle.
    expect(result).toMatchObject({ failures: 0, warnings: 1, skipped: 0 });
    expect(skips(events)).toEqual([]);
    const succeeded = events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.reason).toContain('NOT fully reversed');
    expect(succeeded[0]).not.toHaveProperty('physicalId');
  });

  it('masks that reason with the op masker', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-new', attributes: {} });
    const { ctx, events } = makeCtx({ create, delete: vi.fn() });
    const needle = 'name-idempotent), so the replacement';
    const needles: RecordedSecretValues = new Map();
    recordLogOnlyValue(needles, needle);
    ctx.logOnlyNeedlesFor = () => needles;
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      physicalId: 'phys-new',
      previousState: res({ physicalId: 'phys-old', properties: { QueueName: 'q', a: 1 } }),
    };
    const state = { R: res({ physicalId: 'phys-new', properties: { QueueName: 'q', a: 2 } }) };
    await replayRollback([op], state, 'S', ctx);
    const reason = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')!.reason!;
    expect(reason).toContain('NOT fully reversed');
    expect(reason).not.toContain(needle);
  });
});
