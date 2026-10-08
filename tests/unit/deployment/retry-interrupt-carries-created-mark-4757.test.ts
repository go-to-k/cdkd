import { describe, it, expect } from 'vite-plus/test';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  createdBeforeFailure,
  markCreatedBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';

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

async function interruptedAfter(first: unknown, onInterrupted?: () => Error): Promise<unknown> {
  let attempts = 0;
  let interrupted = false;
  const error = await withRetry(
    () => {
      attempts++;
      interrupted = true;
      return Promise.reject(first);
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
  // Premise: one attempt, then the interrupt during the wait.
  expect(attempts).toBe(1);
  return error;
}

describe('withRetry interrupt keeps the created-before-failure mark (go-to-k/cdkd#4757)', () => {
  it.each([
    ['the caller-supplied interrupt error', () => new Error('Deployment aborted after another resource failed')],
    ['the default interrupt error', undefined],
  ] as const)('on %s', async (_l, onInterrupted) => {
    const error = await interruptedAfter(
      markCreatedBeforeFailure(new Error(RETRYABLE), ID, TYPE, 'bucket-1', 'bucket-1|us-west-2|t'),
      onInterrupted
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('not authorized');
    expect(createdBeforeFailure(error, ID, TYPE)).toBe('bucket-1');
  });

  it('adds none when the attempt made nothing', async () => {
    const error = await interruptedAfter(new Error(RETRYABLE));
    expect(createdBeforeFailure(error, ID, TYPE)).toBeUndefined();
  });
});
