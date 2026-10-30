import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

/**
 * go-to-k/cdkd#2319: the reverse replacement's failure texts are persisted to
 * `deployments/{runId}.jsonl` -- the re-create wrap as the failed op's error,
 * the untracked new resource's note as its event's `reason` -- and an SDK
 * error a provider let escape names the caller's ARN on an access denial. Each
 * names such a failure by its class plus the `--verbose` pointer, and the
 * re-create's AWS text goes to `debug`. (The collision refusals' quoted line
 * is pinned in `rollback-executor-retain-new-resource.test.ts`.)
 */

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const QUEUE = 'AWS::SQS::Queue';
const CALLER = 'arn:aws:sts::123456789012:assumed-role/Deployer/session';
const POINTER = "Re-run with verbose logging for AWS's own message.";

const denied = (): Error =>
  awsSdkError(`User: ${CALLER} is not authorized to perform: sqs:DeleteQueue`, 'AccessDenied');

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn() };
const lines = (fn: typeof logger.debug): string[] => fn.mock.calls.map((c) => String(c[0]));

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: QUEUE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

interface Recorded {
  eventType: string;
  reason?: string;
  message?: string;
}

function makeCtx(provider: { create?: unknown; delete?: unknown }): {
  ctx: RollbackExecutorContext;
  events: Recorded[];
} {
  const events: Recorded[] = [];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) =>
      events.push({
        eventType: e.eventType,
        ...(e.reason !== undefined && { reason: e.reason }),
        ...(e.error?.message !== undefined && { message: e.error.message }),
      }),
  };
  return { ctx, events };
}

function replacement(oldProps: Record<string, unknown> = { a: 1 }): {
  ops: CompletedOperation[];
  state: Record<string, ResourceState>;
} {
  return {
    ops: [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: QUEUE,
        physicalId: 'phys-new',
        previousState: res({ physicalId: 'phys-old', properties: oldProps }),
      },
    ],
    state: { B: res({ physicalId: 'phys-new', properties: { ...oldProps, a: 2 } }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reverse replacement failure texts name an AWS failure by its class (#2319)', () => {
  it('the re-create after the new resource was deleted first', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(awsSdkError('Queue already exists'))
      .mockRejectedValueOnce(denied());
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ create, delete: del });
    const { ops, state } = replacement({ QueueName: 'q', a: 1 });

    const result = await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    // The path really was taken: collide, delete-new, retry, fail.
    expect(create).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledTimes(1);
    expect(result.failures).toBe(1);
    const failed = events
      .filter((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED')
      .map((e) => e.message ?? '')
      .join('\n');
    expect(failed).toContain(
      `was already deleted: AccessDenied. ${POINTER} The resource is now absent`
    );
    expect(failed).not.toContain(CALLER);
    expect(lines(logger.debug).some((l) => l.includes(CALLER))).toBe(true);
  });

  it("the new resource's failed delete after the re-create (an event reason)", async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' });
    const del = vi.fn().mockRejectedValue(denied());
    const { ctx, events } = makeCtx({ create, delete: del });
    const { ops, state } = replacement();

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.warnings).toBe(1);
    const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded?.reason).toContain(
      `re-created: AccessDenied. ${POINTER} It is live, still billing`
    );
    expect(succeeded?.reason).not.toContain(CALLER);
  });

  it('a first re-create failing with an escaped SDK error (not a collision)', async () => {
    const cause = denied();
    const create = vi.fn().mockRejectedValue(cause);
    const del = vi.fn();
    const { ctx, events } = makeCtx({ create, delete: del });
    const { ops, state } = replacement();

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(create).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    const failed = events
      .filter((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED')
      .map((e) => e.message ?? '')
      .join('\n');
    expect(failed).toContain(`Failed to re-create the old B: AccessDenied. ${POINTER}`);
    expect(failed).not.toContain(CALLER);
    expect(lines(logger.debug).some((l) => l.includes(CALLER))).toBe(true);
  });

  it("a first re-create failing with a provider's own wrap rethrows it as-is (negative control)", async () => {
    const wrap = new Error('Failed to create SQS Queue B: boom');
    const create = vi.fn().mockRejectedValue(wrap);
    const { ctx, events } = makeCtx({ create, delete: vi.fn() });
    const { ops, state } = replacement();

    await replayRollback(ops, state, 'S', ctx);

    const failed = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(failed?.message).toBe('Failed to create SQS Queue B: boom');
  });

  it("a provider wrap already carrying the --verbose pointer is shown flag-free (#3950)", async () => {
    const wrap = new Error(
      "Failed to delete SQS Queue B: AccessDenied. Re-run with --verbose for AWS's own message."
    );
    const create = vi
      .fn()
      .mockRejectedValueOnce(awsSdkError('Queue already exists'))
      .mockRejectedValueOnce(wrap);
    const { ctx, events } = makeCtx({ create, delete: vi.fn().mockResolvedValue(undefined) });
    const { ops, state } = replacement({ QueueName: 'q', a: 1 });
    await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    const failed = events
      .filter((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED')
      .map((e) => e.message ?? '')
      .join('\n');
    expect(failed).toContain(`was already deleted: Failed to delete SQS Queue B: AccessDenied. ${POINTER}`);
    expect(failed).not.toContain('--verbose');

    vi.clearAllMocks();
    const { ctx: ctx2, events: events2 } = makeCtx({
      create: vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' }),
      delete: vi.fn().mockRejectedValue(wrap),
    });
    const second = replacement();
    await replayRollback(second.ops, second.state, 'S', ctx2);
    const reason = events2.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')?.reason;
    expect(reason).toContain(`AccessDenied. ${POINTER}`);
    expect(reason).not.toContain('--verbose');
  });

  it('a cdkd-authored failure keeps its text (negative control)', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' });
    const del = vi.fn().mockRejectedValue(new Error('Failed to delete SQS Queue B: boom'));
    const { ctx, events } = makeCtx({ create, delete: del });
    const { ops, state } = replacement();

    await replayRollback(ops, state, 'S', ctx);

    const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded?.reason).toContain('re-created: Failed to delete SQS Queue B: boom. It is live');
  });
});
