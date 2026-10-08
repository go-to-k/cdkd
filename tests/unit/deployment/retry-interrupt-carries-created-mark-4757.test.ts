import { describe, it, expect, vi } from 'vite-plus/test';
import { withRetry } from '../../../src/deployment/retry.js';
import { createWithRollbackRetry } from '../../../src/deployment/rollback-executor/replay-retry.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
  markCreatedBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

/**
 * go-to-k/cdkd#4757: an interrupt during `withRetry`'s wait replaces the
 * attempt's error. When that attempt made its resource before failing, the
 * interrupt's error must carry the created-before-failure mark, or the deploy
 * engine journals the failed CREATE with no id and the resource is untracked.
 */

const ID = 'Bucket';
const TYPE = 'AWS::S3::Bucket';
const RETRYABLE = 'User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: s3:PutBucketTagging';
const noSleep = (): Promise<void> => Promise.resolve();

async function interruptedAfter(
  errors: readonly unknown[],
  onInterrupted?: () => Error
): Promise<unknown> {
  let attempts = 0;
  let interrupted = false;
  const error = await withRetry(
    () => {
      const thrown = errors[attempts]!;
      attempts++;
      // Interrupted once the last error is thrown, so the wait after it stops.
      if (attempts === errors.length) interrupted = true;
      return Promise.reject(thrown);
    },
    ID,
    {
      sleep: noSleep,
      isInterrupted: () => interrupted,
      ...(onInterrupted && { onInterrupted }),
    }
  ).then(
    () => undefined,
    (e: unknown) => e
  );
  // Premise: every attempt ran, then the interrupt during the wait.
  expect(attempts).toBe(errors.length);
  return error;
}

describe('withRetry interrupt keeps the created-before-failure mark (go-to-k/cdkd#4757)', () => {
  it.each([
    ['the caller-supplied interrupt error', () => new Error('Deployment aborted after another resource failed')],
    ['the default interrupt error', undefined],
  ] as const)('on %s', async (_l, onInterrupted) => {
    const error = await interruptedAfter(
      [markCreatedBeforeFailure(new Error(RETRYABLE), ID, TYPE, 'bucket-1', 'bucket-1|us-west-2|t')],
      onInterrupted
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('not authorized');
    expect(createdBeforeFailure(error, ID, TYPE)).toBe('bucket-1');
    // go-to-k/cdkd#4655: the identity token travels with it.
    expect(createdResourceIdentityBeforeFailure(error, ID, TYPE)).toBe('bucket-1|us-west-2|t');
  });

  it("keeps an earlier attempt's mark when the last attempt's error could not take it", async () => {
    const error = await interruptedAfter([
      markCreatedBeforeFailure(new Error(RETRYABLE), ID, TYPE, 'bucket-1'),
      Object.freeze(new Error(RETRYABLE)),
    ]);
    expect(createdBeforeFailure(error, ID, TYPE)).toBe('bucket-1');
  });

  it('adds none when the attempt made nothing', async () => {
    const error = await interruptedAfter([new Error(RETRYABLE)]);
    expect(createdBeforeFailure(error, ID, TYPE)).toBeUndefined();
  });
});

// The rollback's replay re-create runs through the same loop: an interrupted
// `cdkd rollback` now hands `deleteMarkedRecreate` the resource the re-create
// made, which it deletes under its usual guards (state holds the id, Retain /
// Snapshot), instead of leaving it untracked.
describe('the rollback re-create retry keeps the mark on an interrupt (go-to-k/cdkd#4757)', () => {
  it('on the inner loop', async () => {
    let interrupted = false;
    const create = vi.fn(() => {
      interrupted = true;
      return Promise.reject(markCreatedBeforeFailure(new Error(RETRYABLE), ID, TYPE, 'bucket-1'));
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const error = await createWithRollbackRetry(
      {} as ResourceProvider,
      create,
      ID,
      logger as never,
      () => interrupted,
      (t: string) => t,
      { isRetryable: () => true, interruptedMessage: 'Rollback interrupted' }
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(create).toHaveBeenCalledOnce();
    expect(String((error as Error).message)).toContain('interrupted');
    expect(createdBeforeFailure(error, ID, TYPE)).toBe('bucket-1');
  });
});
