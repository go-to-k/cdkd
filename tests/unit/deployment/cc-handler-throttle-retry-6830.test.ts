import { describe, expect, it, vi } from 'vite-plus/test';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  isCcHandlerThrottlingError,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors/transient.js';
import {
  hasReplayMayCollide,
  isNameCollisionErrorFrom,
} from '../../../src/deployment/retryable-errors/name-collision.js';
import { CloudControlOperationFailedError } from '../../../src/provisioning/cloud-control/shared.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * go-to-k/cdkd#6830: a Cloud Control handler that ran out of its own SDK
 * retries against a rate limit fails the operation with `ErrorCode:
 * Throttling` and the service's text, which for Lightsail's `PutAlarm` matches
 * no message pattern. The code itself must make the outer retry engage.
 */
const LIGHTSAIL_TEXT =
  'CREATE failed for AlarmB: The maximum API request rate has been exceeded for your account. ' +
  'Please try your request again shortly. For best results using the Lightsail API, use an ' +
  'increased time interval between requests. (Service: Lightsail, Status Code: 400, Request ID: ' +
  'a1b2c3d4-0000-0000-0000-000000000000) (SDK Attempt Count: 3)';

function handlerFailure(code: string | undefined): CloudControlOperationFailedError {
  return new CloudControlOperationFailedError(
    LIGHTSAIL_TEXT,
    'AWS::Lightsail::Alarm',
    'AlarmB',
    undefined,
    code,
    'CREATE'
  );
}

describe('Cloud Control handler Throttling is retried (#6830)', () => {
  it('classifies the Lightsail handler throttle as retryable', () => {
    const error = handlerFailure('Throttling');
    expect(isCcHandlerThrottlingError(error)).toBe(true);
    expect(isRetryableTransientError(error, error.message)).toBe(true);
  });

  it('reads the code through a wrapping cause', () => {
    const wrapped = new ProvisioningError(
      'Failed to create AlarmB',
      'AWS::Lightsail::Alarm',
      'AlarmB',
      undefined,
      handlerFailure('Throttling')
    );
    expect(isRetryableTransientError(wrapped, wrapped.message)).toBe(true);
  });

  it('keeps the same text under another handler code non-retryable', () => {
    for (const code of ['InvalidRequest', 'AlreadyExists', undefined]) {
      const error = handlerFailure(code);
      expect(isCcHandlerThrottlingError(error)).toBe(false);
      expect(isRetryableTransientError(error, error.message)).toBe(false);
    }
  });

  it('withRetry replays the create until the handler stops throttling', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(handlerFailure('Throttling'))
      .mockRejectedValueOnce(handlerFailure('Throttling'))
      .mockResolvedValue('created');
    await expect(withRetry(op, 'AlarmB', { sleep: () => Promise.resolve() })).resolves.toBe(
      'created'
    );
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('a replay meeting AlreadyExists after a throttle is never credited as a name collision', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(handlerFailure('Throttling'))
      .mockRejectedValueOnce(handlerFailure('AlreadyExists'));
    const thrown = await withRetry(op, 'AlarmB', { sleep: () => Promise.resolve() }).catch(
      (error: unknown) => error
    );
    expect(op).toHaveBeenCalledTimes(2);
    expect(hasReplayMayCollide(thrown)).toBe(true);
    expect(isNameCollisionErrorFrom(thrown, 'AlarmB')).toBe(false);
  });
});
