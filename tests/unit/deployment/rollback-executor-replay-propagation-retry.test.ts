/**
 * The reverse-replacement replay-CREATE retries an IAM-propagation error
 * (issue https://github.com/go-to-k/cdkd/issues/2032).
 *
 * Both replay-CREATE arms pass an explicit schedule AND an explicit
 * `isRetryable`, and `retry.ts` gates the dense IAM-propagation path on
 * `defaultSchedule` (every knob unset) while a caller-supplied classifier
 * REPLACES `isRetryableTransientError` outright. So a propagation error raised
 * by the re-create was non-retryable on attempt 0 and rethrown raw, leaving the
 * resource absent from BOTH AWS and state. The fix nests an inner
 * default-schedule `withRetry` inside each outer one, mirroring the deploy
 * engine's two delete-then-re-create twins.
 *
 * Both arms are pinned, and so is the name-collision fallback the inner
 * wrapper must NOT swallow (acceptance item 2): the delete-new-first path has
 * to keep firing on the FIRST outer attempt.
 *
 * `withRetry` is the REAL implementation here — only its `sleep` is zeroed —
 * because the classification and the schedule ARE the subject.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  isNameCollisionError,
  isNameCooldownError,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import { IAM_PROPAGATION_INITIAL_DELAY_MS } from '../../../src/deployment/retry.js';

/**
 * One record per `withRetry` invocation, tagged by which loop it is and
 * carrying every millisecond that loop asked `sleep` for.
 *
 * The delays are what fence the SCHEDULE (issue #2032 acceptance item 1). Call
 * COUNTS cannot: mutating the inner call to `{ maxRetries: 26 }` produces the
 * identical number of attempts on the generic 1s/2s/4s/8s schedule, so every
 * count assertion in this file stays green while the dense 250ms propagation
 * cadence — the actual subject of the issue — is gone.
 */
type RetryCallRecord = { outer: boolean; delays: number[] };

const { retryCalls } = vi.hoisted(() => ({ retryCalls: [] as RetryCallRecord[] }));

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    // The REAL loop (classification, both schedules, the attempt ceiling) with
    // its waits removed — a stubbed pass-through would make every assertion
    // below vacuous. `sleep` is not merely zeroed but RECORDED, so the cadence
    // is observable.
    withRetry: (
      operation: () => Promise<unknown>,
      logicalId: string,
      opts: Record<string, unknown> = {}
    ) => {
      // The OUTER loop is the one carrying a custom classifier; the inner one
      // passes no knobs at all, which is precisely what re-arms `retry.ts`'s
      // `defaultSchedule` gate.
      const record: RetryCallRecord = { outer: opts['isRetryable'] !== undefined, delays: [] };
      retryCalls.push(record);
      return actual.withRetry(operation, logicalId, {
        ...opts,
        sleep: async (ms: number) => {
          record.delays.push(ms);
        },
      });
    },
  };
});

/** The delays of the first INNER (default-schedule) loop of the run. */
function firstInnerDelays(): number[] {
  return retryCalls.find((c) => !c.outer)?.delays ?? [];
}

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

/** The exact AWS sentence issue #2032 was filed for. */
const PROPAGATION_MESSAGE =
  'InvalidParameterValueException: The role defined for the function cannot be assumed by Lambda.';
/** `isNameCollisionError` signature — the delete-new-first trigger. */
const COLLISION_MESSAGE = "Resource of type 'AWS::S3::Bucket' already exists.";
/** `isNameCooldownError` signature — the SQS 60s same-name cooldown. */
const COOLDOWN_MESSAGE =
  'AWS.SimpleQueueService.QueueDeletedRecently: You must wait 60 seconds after deleting a queue before you can create another with the same name.';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::Lambda::Function',
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

/**
 * A reverse-replacement op: the state record's physicalId differs from the
 * journaled previousState's, which is what `classifyRollbackOp` keys on.
 */
function reverseReplacementOp(resourceType = 'AWS::Lambda::Function'): CompletedOperation {
  return {
    logicalId: 'Fn',
    changeType: 'UPDATE',
    resourceType,
    physicalId: 'new-fn',
    previousState: res({ physicalId: 'old-fn', resourceType, properties: { Role: 'arn:role' } }),
  };
}

/**
 * `disableOuterRetry` is typed as the real `ResourceProvider` declares it — an
 * optional boolean, not another `unknown` — because the opt-out case below
 * turns on its VALUE. The two stub members stay `unknown` only to keep the
 * `vi.fn()` shapes assignable.
 */
function makeCtx(provider: {
  delete?: unknown;
  create?: unknown;
  disableOuterRetry?: boolean;
}): {
  ctx: RollbackExecutorContext;
  events: string[];
} {
  const events: string[] = [];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) => events.push(e.eventType),
  };
  return { ctx, events };
}

/** A create stub that rejects `failures` times, then resolves. */
function createFailingTimes(failures: number, message: string, physicalId = 'old-fn') {
  let seen = 0;
  return vi.fn(async () => {
    if (seen++ < failures) throw new Error(message);
    return { physicalId, attributes: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  retryCalls.length = 0;
});

describe('acceptance item 2 — MEASURED: what the inner default classifier matches', () => {
  // Measured rather than assumed, because the answer decides whether the naive
  // nest is correct: an inner classifier that matched the COLLISION would burn
  // its budget before the delete-new-first fallback could fire.
  it('the inner classifier does NOT match a name collision, so the fallback is untouched', () => {
    expect(isNameCollisionError(COLLISION_MESSAGE)).toBe(true);
    expect(isRetryableTransientError(new Error(COLLISION_MESSAGE), COLLISION_MESSAGE)).toBe(false);
  });

  it('the inner classifier DOES match the SQS cooldown (the generic table carries "wait 60 seconds")', () => {
    expect(isNameCooldownError(COOLDOWN_MESSAGE)).toBe(true);
    // Same division of labour the deploy engine's named-replacement twin
    // documents: the inner retry absorbs most of the 60s window, the outer
    // ~64s budget covers the tail.
    expect(isRetryableTransientError(new Error(COOLDOWN_MESSAGE), COOLDOWN_MESSAGE)).toBe(true);
  });

  it('the propagation sentence is retryable but NOT matched by either custom classifier', () => {
    expect(isRetryableTransientError(new Error(PROPAGATION_MESSAGE), PROPAGATION_MESSAGE)).toBe(
      true
    );
    // This is the whole defect: both outer classifiers say "no" on attempt 0.
    expect(isNameCooldownError(PROPAGATION_MESSAGE)).toBe(false);
    expect(isNameCollisionError(PROPAGATION_MESSAGE)).toBe(false);
  });
});

describe('reverse-replacement replay-CREATE retries IAM propagation (#2032)', () => {
  it('create-first arm: a propagation error is retried instead of rethrown on attempt 0', async () => {
    const create = createFailingTimes(3, PROPAGATION_MESSAGE);
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Fn: res({ physicalId: 'new-fn' }) };

    const result = await replayRollback([reverseReplacementOp()], state, 'S', ctx);

    // THE DISCRIMINATOR: without the inner wrapper this is 1 (the raw rethrow).
    expect(create).toHaveBeenCalledTimes(4);
    expect(result.failures).toBe(0);
    expect(events).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
    // The old resource is back in state, and the new one was deleted after.
    expect(state['Fn']?.physicalId).toBe('old-fn');
    expect(del).toHaveBeenCalledOnce();
  });

  it('create-first arm: the dense budget is live, not the outer 8-retry one', async () => {
    // 9 failures exceeds the outer RECREATE_RETRY_SCHEDULE's maxRetries of 8,
    // so a fix that merely widened the outer schedule cannot produce this.
    const create = createFailingTimes(9, PROPAGATION_MESSAGE);
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Fn: res({ physicalId: 'new-fn' }) };

    const result = await replayRollback([reverseReplacementOp()], state, 'S', ctx);

    expect(create).toHaveBeenCalledTimes(10);
    expect(result.failures).toBe(0);
  });

  it('create-first arm: the inner CADENCE is the dense 250ms one, not the generic 1s', async () => {
    // Deliberately a separate case from the counts above, because a count
    // cannot see this: `{ maxRetries: 26 }` on the inner call produces exactly
    // the same number of attempts on the GENERIC schedule (1s/2s/4s/8s), so
    // every other assertion in this file stays green while the dense
    // propagation path — the actual subject of issue #2032 — is gone.
    const create = createFailingTimes(4, PROPAGATION_MESSAGE);
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Fn: res({ physicalId: 'new-fn' }) };

    const result = await replayRollback([reverseReplacementOp()], state, 'S', ctx);
    expect(result.failures).toBe(0);

    // `retry.ts` sleeps in <=1s chunks, so the dense schedule's 250 / 500 /
    // 1000 / 2000 steps record as [250, 500, 1000, 1000+1000] while the
    // generic 1000 / 2000 / 4000 / 8000 steps record as all-1000s. The first
    // TWO values are therefore unproducible by the generic schedule, which is
    // what makes this discriminate rather than merely describe.
    const delays = firstInnerDelays();
    expect(delays[0]).toBe(IAM_PROPAGATION_INITIAL_DELAY_MS);
    expect(delays.slice(0, 4)).toEqual([250, 500, 1000, 1000]);
    // Total slept over 4 retries: 250+500+1000+2000. The generic schedule
    // would have spent 15000 over the same four.
    expect(delays.reduce((a, b) => a + b, 0)).toBe(3750);
  });

  it('delete-new-first arm: a propagation error on the RETRY create is retried too', async () => {
    const calls: string[] = [];
    let seen = 0;
    const create = vi.fn(async () => {
      calls.push('create');
      seen++;
      if (seen === 1) throw new Error(COLLISION_MESSAGE);
      // Attempts 2-4 are the propagation window on the post-delete re-create.
      if (seen <= 4) throw new Error(PROPAGATION_MESSAGE);
      return { physicalId: 'old-fn', attributes: {} };
    });
    const del = vi.fn(async () => {
      calls.push('delete');
      return undefined;
    });
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Fn: res({ physicalId: 'new-fn' }) };

    const result = await replayRollback([reverseReplacementOp()], state, 'S', ctx);

    // THE DISCRIMINATOR for this arm: without the inner wrapper the second
    // create rethrows on its own attempt 0, so `create` is called twice and the
    // op FAILS with the new resource already gone.
    expect(create).toHaveBeenCalledTimes(5);
    expect(result.failures).toBe(0);
    expect(state['Fn']?.physicalId).toBe('old-fn');
    // Ordering pins that the retries are on the POST-delete create.
    expect(calls).toEqual(['create', 'delete', 'create', 'create', 'create', 'create']);
  });
});

describe('the inner wrapper must not swallow the name-collision fallback (#2032 item 2)', () => {
  it('a collision still reaches the delete-new-first fallback on the FIRST outer attempt', async () => {
    const calls: string[] = [];
    let seen = 0;
    const create = vi.fn(async () => {
      calls.push('create');
      if (seen++ === 0) throw new Error(COLLISION_MESSAGE);
      return { physicalId: 'old-fn', attributes: {} };
    });
    const del = vi.fn(async () => {
      calls.push('delete');
      return undefined;
    });
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Fn: res({ physicalId: 'new-fn' }) };

    const result = await replayRollback([reverseReplacementOp()], state, 'S', ctx);

    expect(result.failures).toBe(0);
    // EXACT call count, before and after: one colliding create, the delete that
    // releases the name, one succeeding create. An inner wrapper that retried
    // the collision would show extra creates BEFORE the first delete.
    expect(calls).toEqual(['create', 'delete', 'create']);
    expect(state['Fn']?.physicalId).toBe('old-fn');
  });

  it('a name cooldown is still retried, and the outer loop still owns that cadence', async () => {
    // 12 cooldown failures: past the inner default's 8-retry generic ceiling,
    // so clearing it requires the OUTER loop to keep re-entering — i.e. the
    // outer schedule is still doing its job through the nest.
    const create = createFailingTimes(12, COOLDOWN_MESSAGE);
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const op = reverseReplacementOp('AWS::SQS::Queue');
    const state: Record<string, ResourceState> = {
      Fn: res({ physicalId: 'new-fn', resourceType: 'AWS::SQS::Queue' }),
    };

    const result = await replayRollback([op], state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(create).toHaveBeenCalledTimes(13);
    // The cooldown never routes through the collision fallback — the delete of
    // the new resource happens AFTER the successful re-create, exactly once.
    expect(del).toHaveBeenCalledOnce();
  });
});

describe('a disableOuterRetry provider is single-shot on BOTH loops (#2032)', () => {
  const CR_TYPE = 'AWS::CloudFormation::CustomResource';

  function optOutCtx(provider: { create?: unknown; delete?: unknown }) {
    return makeCtx({ ...provider, disableOuterRetry: true });
  }

  function optOutOp(): { op: CompletedOperation; state: Record<string, ResourceState> } {
    return {
      op: reverseReplacementOp(CR_TYPE),
      state: { Fn: res({ physicalId: 'new-fn', resourceType: CR_TYPE }) },
    };
  }

  it('a propagation error yields exactly one create() call — no loop re-enters', async () => {
    const create = createFailingTimes(3, PROPAGATION_MESSAGE);
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = optOutCtx({ create, delete: del });
    const { op, state } = optOutOp();

    const result = await replayRollback([op], state, 'S', ctx);

    // THE DISCRIMINATOR: re-running such a create mints a fresh pre-signed S3
    // URL + RequestId and strands the previous attempt, which is precisely why
    // the propagation check cannot be hoisted into `retry.ts` (it never sees
    // the provider).
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.failures).toBe(1);
    // Neither loop was even constructed, which is the stronger statement: the
    // guard sits ahead of both, so an opt-out provider cannot be re-entered by
    // a classifier change later.
    expect(retryCalls).toHaveLength(0);
  });

  it('a COOLDOWN yields one create() call — the outer loop is guarded too', async () => {
    // The case the outer guard exists for. Before it, the outer schedule
    // re-entered on a cooldown regardless of the opt-out: 9 create() calls,
    // i.e. 9 pre-signed response URLs with 8 of them stranded.
    const create = createFailingTimes(12, COOLDOWN_MESSAGE);
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = optOutCtx({ create, delete: del });
    const { op, state } = optOutOp();

    const result = await replayRollback([op], state, 'S', ctx);

    expect(create).toHaveBeenCalledTimes(1);
    expect(retryCalls).toHaveLength(0);
    expect(result.failures).toBe(1);
  });

  it('a COLLISION still reaches the delete-new-first fallback on attempt 0', async () => {
    // The one thing a single-shot outer could have broken: the collision catch
    // sits OUTSIDE the helper, so the guard must let the error REACH it rather
    // than swallowing it. Before the guard this arm made 10 create() calls
    // (1 + delete + 1 + the outer schedule's 8 retries).
    const calls: string[] = [];
    let seen = 0;
    const create = vi.fn(async () => {
      calls.push('create');
      if (seen++ === 0) throw new Error(COLLISION_MESSAGE);
      return { physicalId: 'old-fn', attributes: {} };
    });
    const del = vi.fn(async () => {
      calls.push('delete');
      return undefined;
    });
    const { ctx } = optOutCtx({ create, delete: del });
    const { op, state } = optOutOp();

    const result = await replayRollback([op], state, 'S', ctx);

    expect(result.failures).toBe(0);
    // Byte-identical ORDER to the normal-provider collision case above, which
    // is the point: the opt-out changes the retry cadence, never the fallback.
    expect(calls).toEqual(['create', 'delete', 'create']);
    expect(state['Fn']?.physicalId).toBe('old-fn');
    expect(retryCalls).toHaveLength(0);
  });
});
