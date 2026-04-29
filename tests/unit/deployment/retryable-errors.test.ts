import { describe, it, expect } from 'vitest';
import { isRetryableTransientError } from '../../../src/deployment/retryable-errors.js';

describe('isRetryableTransientError', () => {
  describe('HTTP status code based retries', () => {
    it('retries on 429 (throttle) directly on the error', () => {
      const err = Object.assign(new Error('Throttled'), {
        $metadata: { httpStatusCode: 429 },
      });
      expect(isRetryableTransientError(err, 'Throttled')).toBe(true);
    });

    it('retries on 503 (service unavailable) directly on the error', () => {
      const err = Object.assign(new Error('Unavailable'), {
        $metadata: { httpStatusCode: 503 },
      });
      expect(isRetryableTransientError(err, 'Unavailable')).toBe(true);
    });

    it('retries on a wrapped cause carrying a 429', () => {
      const err = Object.assign(new Error('outer'), {
        cause: { $metadata: { httpStatusCode: 429 } },
      });
      expect(isRetryableTransientError(err, 'outer')).toBe(true);
    });

    it('does not retry on 400 (bad request) without a known message pattern', () => {
      const err = Object.assign(new Error('Bad input'), {
        $metadata: { httpStatusCode: 400 },
      });
      expect(isRetryableTransientError(err, 'Bad input')).toBe(false);
    });

    it('does not retry on 500 (internal error) without a known message pattern', () => {
      const err = Object.assign(new Error('Internal'), {
        $metadata: { httpStatusCode: 500 },
      });
      expect(isRetryableTransientError(err, 'Internal')).toBe(false);
    });
  });

  describe('message pattern based retries', () => {
    it.each([
      // IAM propagation
      ['cannot be assumed by Lambda', 'IAM propagation'],
      ['The execution role you provided does not have permission', 'execution role'],
      ['Role validation failed', 'Role validation failed'],
      // CW Logs SubscriptionFilter (the bug we are fixing)
      [
        'AWS::Logs::SubscriptionFilter. Could not deliver test message to specified Kinesis stream. Check if the given Kinesis stream is in ACTIVE state.',
        'CW Logs SubscriptionFilter probe',
      ],
      // DELETE race conditions
      ['DependencyViolation: resource has dependencies', 'DependencyViolation'],
      // KMS role propagation
      ['KMS key is invalid for CreateGrant', 'KMS CreateGrant'],
      // Eventual consistency
      ['Resource does not exist', 'eventual consistency'],
    ])('retries on %j (%s)', (message) => {
      expect(isRetryableTransientError(new Error(message), message)).toBe(true);
    });

    it('does not retry on a generic non-matching message', () => {
      const message = 'InvalidParameterValue: BucketName must be globally unique';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });

    it('does not retry on a syntactically wrong CloudFormation template error', () => {
      const message = 'Template format error: Unresolved resource dependencies';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });
  });

  describe('robustness', () => {
    it('handles non-Error inputs (string thrown) by falling back to message matching', () => {
      expect(
        isRetryableTransientError(
          'Could not deliver test message',
          'Could not deliver test message'
        )
      ).toBe(true);
    });

    it('handles plain objects without $metadata', () => {
      expect(isRetryableTransientError({}, 'unrelated')).toBe(false);
    });
  });
});
