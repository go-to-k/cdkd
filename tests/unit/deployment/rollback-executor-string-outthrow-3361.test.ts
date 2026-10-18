import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  loadJournaledOrphans,
  settleJournaledOrphansOnSuccess,
} from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import { backendErrorText } from '../../../src/cli/commands/rollback.js';
import { markCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/deployment/rollback-executor/` slice: each handler below rendered its
 * caught value with `x instanceof Error ? x.message : String(x)`.
 * `String(Object.create(null))` throws `TypeError: Cannot convert object to
 * primitive value`, so the handler itself threw and the degradation it exists
 * for (warn and keep the journal, warn and count the untracked new resource,
 * fail just this op) became a crash of the whole rollback.
 *
 * Every case rejects with exactly that value and asserts the DEGRADATION
 * still happens, plus the placeholder in the line the operator reads, so a fix
 * that swallowed the failure without reporting it would not pass.
 */

// Single attempt, no backoff sleeps (as in rollback-executor.test.ts).
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const PLACEHOLDER = 'a value that could not be converted to text';
const REGION = 'us-east-1';
const QUEUE = 'AWS::SQS::Queue';

const unconvertible = (): unknown => Object.create(null);

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn() };

const warnings = (): string[] => logger.warn.mock.calls.map((c) => String(c[0]));

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
    region: REGION,
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

/** A replacement UPDATE of `B`: state holds the new queue, the op the old one. */
function replacement(oldProps: Record<string, unknown> = { a: 1 }): {
  ops: CompletedOperation[];
  state: Record<string, ResourceState>;
} {
  const prev = res({ physicalId: 'phys-old', properties: oldProps });
  return {
    ops: [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: QUEUE,
        physicalId: 'phys-new',
        previousState: prev,
      },
    ],
    state: { B: res({ physicalId: 'phys-new', properties: { ...oldProps, a: 2 } }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reverse replacement with an unconvertible rejection (#3361)', () => {
  it('a failed delete of the new resource after the re-create still warns, counts it and keeps the re-created record', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' });
    const del = vi.fn().mockRejectedValue(unconvertible());
    const { ctx, events } = makeCtx({ create, delete: del });
    const { ops, state } = replacement();

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(1);
    expect(state.B?.physicalId).toBe('phys-old-2');
    const line = warnings().find((l) => l.includes('deleting the new resource'));
    expect(line).toContain(`failed: ${PLACEHOLDER}. Delete it manually`);
    const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded?.reason).toContain(`re-created: ${PLACEHOLDER}. It is live, still billing`);
  });

  it('a re-create failing after the new resource was deleted first fails only this op, naming the placeholder', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(awsSdkError('Queue already exists'))
      .mockRejectedValueOnce(unconvertible());
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ create, delete: del });
    const { ops, state } = replacement({ QueueName: 'q', a: 1 });

    const result = await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    // The path really was taken: collide, delete-new, retry, fail.
    expect(create).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledTimes(1);
    expect(result.failures).toBe(1);
    const failed = events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(failed.map((e) => e.message ?? '').join('\n')).toContain(
      `was already deleted: ${PLACEHOLDER}. The resource is now absent`
    );
  });

  it('a first re-create rejecting unconvertibly fails only this op and leaves the new resource alone', async () => {
    const create = vi.fn().mockRejectedValue(unconvertible());
    const del = vi.fn();
    const { ctx, events } = makeCtx({ create, delete: del });
    const { ops, state } = replacement();
    const current = state.B;

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(create).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect(state.B).toBe(current);
    expect(result.failures).toBe(1);
    // The per-op failure line renders the rethrown value too (`messages.ts`).
    const failedLine = logger.error.mock.calls
      .concat(logger.warn.mock.calls)
      .map((c) => String(c[0]))
      .find((l) => l.includes(PLACEHOLDER));
    expect(failedLine, 'the op failure never named the placeholder').toBeDefined();
    expect(events.some((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED')).toBe(true);
  });

  it('a failed delete of what a failed re-create made still warns it is left behind', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        markCreatedBeforeFailure(new Error('tagging failed'), 'B', QUEUE, 'made-by-recreate')
      );
    const del = vi.fn().mockRejectedValue(unconvertible());
    const { ctx } = makeCtx({ create, delete: del });
    const { ops, state } = replacement();

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(del).toHaveBeenCalledWith(
      'B',
      'made-by-recreate',
      QUEUE,
      expect.anything(),
      expect.anything()
    );
    expect(result.failures).toBe(1);
    const line = warnings().find((l) => l.includes('could not delete'));
    expect(line).toContain(`made before failing (${PLACEHOLDER}); no record holds it`);
  });
});

describe('journaled orphans with an unconvertible rejection (#3361)', () => {
  const orphan = {
    logicalId: 'Orphan',
    changeType: 'CREATE',
    resourceType: 'AWS::Kinesis::Stream',
    physicalId: 'orphan-stream',
    provisionedBy: 'sdk',
    physicalIdRecoveredFromError: true,
    createdResourceIdentity: 'created-token',
    attemptedProperties: {},
  };
  const journal = {
    journalVersion: 1,
    stackName: 'S',
    region: REGION,
    segments: [
      {
        timestamp: 1,
        reason: 'no-rollback-failure',
        initialDeploy: false,
        operations: [],
        failedOperations: [orphan],
      },
    ],
  };

  it('an unreadable journal is reported unreadable with a warning, not thrown', async () => {
    const stateBackend = { loadRollbackJournal: vi.fn().mockRejectedValue(unconvertible()) };

    const orphans = await loadJournaledOrphans(
      stateBackend as never,
      'S',
      REGION,
      undefined,
      logger as never
    );

    expect(orphans.unreadable).toBe(true);
    expect(orphans.count).toBe(0);
    expect(warnings().join('\n')).toContain(
      `Could not read the stack's rollback journal (${PLACEHOLDER}); no resource it records`
    );
  });

  it('a failed reduce on the success path keeps the whole journal and says so', async () => {
    const stateBackend = {
      loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
      reduceRollbackJournalToFailedOperations: vi.fn().mockRejectedValue(unconvertible()),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    };
    const { ctx } = makeCtx({ delete: vi.fn() });

    const outcome = await settleJournaledOrphansOnSuccess({
      stackInstanceId: undefined,
      stateBackend: stateBackend as never,
      stackName: 'S',
      region: REGION,
      stateResources: {},
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: vi.fn(async () => undefined),
      ctx,
      // Interrupted: nothing is deleted, so the orphan is kept and the reduce runs.
      isInterrupted: () => true,
      logger: logger as never,
    });

    expect(outcome).toEqual({ unaddressed: 1, keepJournal: true });
    expect(stateBackend.reduceRollbackJournalToFailedOperations).toHaveBeenCalledTimes(2);
    expect(stateBackend.markRollbackJournalSuperseded).toHaveBeenCalledTimes(1);
    expect(warnings().join('\n')).toContain(
      `to its undeleted resources: ${PLACEHOLDER}. The whole journal is kept.`
    );
  });
});

describe('cdkd rollback backendErrorText with an unconvertible value (#3361)', () => {
  // Every journal-backend catch of `cdkd rollback` (state persist, journal
  // strip, lock release, nested child record) renders its error through this.
  it('renders the placeholder instead of throwing, and an Error as its message', () => {
    expect(backendErrorText(unconvertible(), 'MyStack', REGION)).toBe(PLACEHOLDER);
    expect(backendErrorText(new Error('Access Denied'), 'MyStack', REGION)).toBe('Access Denied');
  });
});
