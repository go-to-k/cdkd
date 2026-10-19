import { describe, it, expect, vi } from 'vite-plus/test';
import {
  isNameCollisionError,
  isNameCollisionErrorFrom,
  isNameCooldownError,
  isRecreateRetryableError,
  markRedactedCause,
  relayedNameCollision,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { describeAwsFailure } from '../../../src/utils/aws-failure-text.js';

// go-to-k/cdkd#5088: a #2319 wrap reduces an AWS failure to
// `<error.name>. Re-run with --verbose for AWS's own message.`. When the class
// itself spells `AlreadyExists` but AWS's prose is no name collision (Route 53's
// `HostedZoneAlreadyExists` is a caller-reference reuse), the reduced message
// matched the collision code pattern and the delete-then-re-create sites
// retried for ~64s. The verdict must equal that of the text the wrap withheld.

/** An SDK-shaped, AWS-authored failure (`$fault` + an HTTP status). */
function awsError(name: string, message: string): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 409 },
  });
}

/** A #2319 provider wrap, optionally re-wrapped the way `deploy-engine.ts` does. */
function redactedWrap(
  aws: Error,
  opts: { stamp?: boolean; relay?: boolean; outer?: boolean } = {}
): Error {
  const { stamp = true, relay = true, outer = true } = opts;
  const failure = describeAwsFailure(aws);
  const inner = new Error(
    `Failed to create Thing example: ${failure.summary}${relay ? relayedNameCollision(failure.detail) : ''}`,
    { cause: aws }
  );
  if (stamp) markRedactedCause(inner);
  return outer ? new Error(`Failed to create resource Res: ${inner.message}`, { cause: inner }) : inner;
}

const recreateRetryable = (error: Error): boolean =>
  isRecreateRetryableError(retryClassificationText(error), error);

const HOSTED_ZONE_REUSE = awsError(
  'HostedZoneAlreadyExists',
  'A hosted zone has already been created with the specified caller reference.'
);

describe('a redacted AlreadyExists class whose AWS text is no collision (#5088)', () => {
  it('Route 53 HostedZoneAlreadyExists is not re-create retryable', () => {
    const error = redactedWrap(HOSTED_ZONE_REUSE);
    expect(describeAwsFailure(HOSTED_ZONE_REUSE).redacted).toBe(true);
    // Non-vacuity: the class token IS in the classification text, and alone it
    // reads as a collision.
    expect(error.message).toContain('HostedZoneAlreadyExists. Re-run with --verbose');
    expect(isNameCollisionError(retryClassificationText(error))).toBe(true);
    expect(recreateRetryable(error)).toBe(false);
    // ...which is the verdict of the text it withheld.
    expect(isRecreateRetryableError(HOSTED_ZONE_REUSE.message)).toBe(false);
    expect(isNameCollisionErrorFrom(error, 'Res')).toBe(false);
  });

  it('S3 BucketAlreadyExists (another account holds the name) is not re-create retryable', () => {
    const error = redactedWrap(
      awsError(
        'BucketAlreadyExists',
        'The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.'
      ),
      { relay: false }
    );
    expect(recreateRetryable(error)).toBe(false);
  });

  it('withRetry hands the error to the classifier, so the wrap is not retried', async () => {
    const op = vi.fn(() => Promise.reject(redactedWrap(HOSTED_ZONE_REUSE)));
    await expect(
      withRetry(op, 'Res', {
        isRetryable: isRecreateRetryableError,
        maxRetries: 3,
        initialDelayMs: 1,
        maxDelayMs: 1,
      })
    ).rejects.toThrow('HostedZoneAlreadyExists');
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe('genuine collisions through a redacted wrap still classify (#5088)', () => {
  it('a restated ConflictException collision is re-create retryable and a collision', () => {
    const error = redactedWrap(awsError('ConflictException', 'Table bucket x already exists.'));
    expect(error.message).toContain('AWS reports that it already exists.');
    expect(recreateRetryable(error)).toBe(true);
    expect(isNameCollisionErrorFrom(error, 'Res')).toBe(true);
  });

  it('a class-only ResourceAlreadyExistsException (no relayed sentence) still classifies', () => {
    const error = redactedWrap(
      awsError('ResourceAlreadyExistsException', 'Event bus x already exists.'),
      { relay: false }
    );
    expect(error.message).not.toContain('AWS reports');
    expect(recreateRetryable(error)).toBe(true);
    expect(isNameCollisionErrorFrom(error, 'Res')).toBe(true);
  });

  it('an AWS message that itself spells the class still classifies', () => {
    const error = redactedWrap(
      awsError('AlreadyExistsException', 'AlreadyExistsException: alias/x'),
      { relay: false }
    );
    expect(recreateRetryable(error)).toBe(true);
  });

  it('a name cooldown is still retried through a redacted wrap', async () => {
    const make = (): Error =>
      redactedWrap(
        awsError(
          'QueueDeletedRecently',
          'You must wait 60 seconds after deleting a queue before you can create another with the same name.'
        )
      );
    expect(recreateRetryable(make())).toBe(true);
    const op = vi.fn(() => Promise.reject(make()));
    await expect(
      withRetry(op, 'Res', {
        isRetryable: isRecreateRetryableError,
        maxRetries: 2,
        initialDelayMs: 1,
        maxDelayMs: 1,
      })
    ).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(3);
  });
});

describe('un-redacted paths are unchanged (#5088)', () => {
  it('a message-only call keeps the class-token verdict', () => {
    expect(
      isRecreateRetryableError(
        "Failed: HostedZoneAlreadyExists. Re-run with --verbose for AWS's own message."
      )
    ).toBe(true);
  });

  it('an unstamped wrap keeps the class-token verdict (no withheld text to read)', () => {
    const error = redactedWrap(HOSTED_ZONE_REUSE, { stamp: false });
    expect(recreateRetryable(error)).toBe(true);
  });

  it('a stamped wrap whose class token is NOT in summary shape keeps it', () => {
    const error = markRedactedCause(
      new Error('Failed: TableAlreadyExists while creating', { cause: new Error('masked') })
    );
    expect(recreateRetryable(error)).toBe(true);
  });
});

/** `isRecreateRetryableError` as it was before #5088. */
const oldRecreate = (m: string): boolean => isNameCollisionError(m) || isNameCooldownError(m);

describe('enumerated walk against the pre-#5088 classifier', () => {
  const NAMES = [
    'HostedZoneAlreadyExists',
    'HealthCheckAlreadyExists',
    'BucketAlreadyExists',
    'ResourceAlreadyExistsException',
    'EntityAlreadyExists',
    'DBInstanceAlreadyExistsFault',
    'AlreadyExistsException',
    'ConflictException',
    'ResourceInUseException',
    'QueueDeletedRecently',
    'AccessDenied',
  ];
  const MESSAGES = [
    'A hosted zone has already been created with the specified caller reference.',
    'Event bus x already exists.',
    'Function already exist: f',
    'The requested bucket name is not available.',
    'You must wait 60 seconds after deleting a queue before you can create another with the same name.',
    'The destination bucket must already exist',
    'Rate exceeded',
    '',
  ];
  const BOOLS = [true, false];

  it('differs only for a stamped wrap, whose collision half equals the withheld text', () => {
    let cases = 0;
    let changed = 0;
    let stampedRetryable = 0;
    for (const name of NAMES)
      for (const message of MESSAGES)
        for (const stamp of BOOLS)
          for (const relay of BOOLS)
            for (const outer of BOOLS) {
              const aws = awsError(name, message);
              const error = redactedWrap(aws, { stamp, relay, outer });
              const text = retryClassificationText(error);
              const now = isRecreateRetryableError(text, error);
              const before = oldRecreate(text);
              cases++;
              if (now !== before) changed++;
              if (!stamp) {
                expect(now, `${name} / ${message}`).toBe(before);
              } else {
                // The collision half reads only the withheld text; the cooldown
                // half is untouched (its codes always mean a cooldown).
                expect(now, `${name} / ${message}`).toBe(
                  isNameCollisionError(aws.message) || isNameCooldownError(text)
                );
                if (now) stampedRetryable++;
              }
              // Message-only callers are untouched.
              expect(isRecreateRetryableError(text)).toBe(before);
            }
    expect(cases).toBe(NAMES.length * MESSAGES.length * 8);
    // Floors: the defect class is exercised, and genuine collisions survive.
    expect(changed).toBeGreaterThanOrEqual(20);
    expect(stampedRetryable).toBeGreaterThanOrEqual(40);
  });
});
