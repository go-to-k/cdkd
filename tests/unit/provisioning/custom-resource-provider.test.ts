import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
  }),
}));

// Hoisted so the issue-#804 delete fail-fast tests can assert on the
// provider's child-logger warn output.
const childWarnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: childWarnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

describe('CustomResourceProvider', () => {
  let provider: CustomResourceProvider;

  beforeEach(() => {
    // mockReset (not clearAllMocks) so any unconsumed `mockResolvedValueOnce`
    // queue items from a failing earlier test do not leak into the next test.
    // (CR sendRequest now does `waitUntilFunctionActiveV2` + `waitUntilFunctionUpdatedV2`
    // before every Lambda Invoke; tests that forget those mocks would otherwise
    // pollute later tests with stale queued responses.)
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    childWarnSpy.mockReset();
    provider = new CustomResourceProvider({
      responseBucket: 'test-bucket',
    });
  });

  // Helper: prepend the two GetFunction responses the SDK waiters consume
  // before every Lambda Invoke. Use this at the start of any Lambda-path
  // test so the post-PR-#121 follow-up `waitForBackingLambdaReady` resolves
  // immediately on the first poll.
  const mockLambdaReady = (): void => {
    mockLambdaSend
      .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
      .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } });
  };

  describe('engine integration flags', () => {
    it('exposes disableOuterRetry=true so the deploy engine never re-invokes create()', () => {
      // CR's create derives a fresh pre-signed S3 URL + RequestId per call.
      // An outer retry would strand the first attempt's Lambda response at
      // an S3 key nobody polls. The flag is structural protection.
      expect(provider.disableOuterRetry).toBe(true);
    });

    it('self-reports the async polling cap as the per-resource min timeout', () => {
      // Default polling cap is 1 hour (matches CDK's `totalTimeout`).
      expect(provider.getMinResourceTimeoutMs()).toBe(3_600_000);
    });

    it('honours a custom asyncResponseTimeoutMs in the self-report', () => {
      const custom = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 90 * 60_000,
      });
      expect(custom.getMinResourceTimeoutMs()).toBe(90 * 60_000);
    });
  });

  describe('isSnsServiceToken', () => {
    it('should return true for SNS topic ARNs', () => {
      expect(
        provider.isSnsServiceToken('arn:aws:sns:us-east-1:123456789012:my-topic')
      ).toBe(true);
    });

    it('should return true for SNS ARNs in different regions', () => {
      expect(
        provider.isSnsServiceToken('arn:aws:sns:ap-northeast-1:123456789012:custom-resource-topic')
      ).toBe(true);
    });

    it('should return false for Lambda function ARNs', () => {
      expect(
        provider.isSnsServiceToken(
          'arn:aws:lambda:us-east-1:123456789012:function:my-function'
        )
      ).toBe(false);
    });

    it('should return false for Lambda function names', () => {
      expect(provider.isSnsServiceToken('my-function-name')).toBe(false);
    });

    it('should return false for partial Lambda ARNs', () => {
      expect(
        provider.isSnsServiceToken('arn:aws:lambda:us-east-1:123456789012:function:handler')
      ).toBe(false);
    });
  });

  describe('create with Lambda ServiceToken', () => {
    it('should invoke Lambda and return result from direct payload', async () => {
      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // CR's sendRequest waits for the backing Lambda to be Active +
      // last-update-Successful before Invoke (post-PR-#121 follow-up:
      // wait moved out of LambdaFunctionProvider.create and gated to the
      // one consumer that breaks against Pending). Two GetFunction polls
      // are consumed before the Invoke.
      mockLambdaReady();

      // Lambda invoke returns direct response
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from(
          JSON.stringify({
            PhysicalResourceId: 'custom-phys-id-123',
            Data: { Attr1: 'value1' },
          })
        ),
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await provider.create('MyCustom', 'Custom::MyResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
      });

      expect(result.physicalId).toBe('custom-phys-id-123');
      expect(result.attributes).toEqual({ Attr1: 'value1' });
      // 2 GetFunction (waiter) + 1 Invoke = 3 Lambda SDK calls.
      expect(mockLambdaSend).toHaveBeenCalledTimes(3);
      expect(mockSnsSend).not.toHaveBeenCalled();
    });

    it('waits for Configuration.State === Active before invoking the backing Lambda', async () => {
      // Reproduces PR #121's bug at the new layer: when the backing
      // Lambda is Pending (e.g. just CREATEd, ENI attaching), the SDK
      // waiter blocks until the GetFunction poll observes Active. Only
      // THEN does the Invoke fire.
      mockS3Send.mockResolvedValueOnce({}); // placeholder

      mockLambdaSend
        .mockResolvedValueOnce({ Configuration: { State: 'Pending' } })
        .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
        .mockResolvedValueOnce({
          Payload: Buffer.from(
            JSON.stringify({ PhysicalResourceId: 'phys-after-wait', Data: {} })
          ),
        });

      mockS3Send.mockResolvedValueOnce({}); // cleanup

      const result = await provider.create('MyCustom', 'Custom::MyResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:not-yet-active',
      });

      expect(result.physicalId).toBe('phys-after-wait');
      // 2 GetFunction polls for Active waiter (Pending then Active),
      // 1 GetFunction poll for Updated waiter (Successful), 1 Invoke.
      expect(mockLambdaSend).toHaveBeenCalledTimes(4);
    });

    it('throws when the backing Lambda never becomes ready', async () => {
      mockS3Send.mockResolvedValueOnce({}); // placeholder

      // Active waiter sees Failed → SDK throws → wait helper rewraps as
      // a clear "Lambda backing custom resource ... did not reach a
      // ready state for Invoke" message.
      mockLambdaSend.mockResolvedValueOnce({ Configuration: { State: 'Failed' } });

      mockS3Send.mockResolvedValueOnce({}); // cleanup attempt

      await expect(
        provider.create('MyCustom', 'Custom::MyResource', {
          ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:doomed',
        })
      ).rejects.toThrow(/did not reach a ready state for Invoke/);
    });
  });

  describe('create with SNS ServiceToken', () => {
    it('should publish to SNS topic and poll S3 for response', async () => {
      const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-custom-resource-topic';

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // SNS publish succeeds
      mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-123' });

      // S3 GetObject returns response on first poll
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'sns-custom-id-456',
                Data: { Output1: 'result' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await provider.create('MySnsCustom', 'Custom::SnsResource', {
        ServiceToken: snsTopicArn,
      });

      expect(result.physicalId).toBe('sns-custom-id-456');
      expect(result.attributes).toEqual({ Output1: 'result' });
      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });

    it('should throw ProvisioningError when SNS-backed custom resource fails', async () => {
      const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // SNS publish succeeds
      mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-456' });

      // S3 GetObject returns FAILED response
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'FAILED',
                Reason: 'Something went wrong',
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      await expect(
        provider.create('MyFailingSns', 'Custom::SnsResource', {
          ServiceToken: snsTopicArn,
        })
      ).rejects.toThrow('Failed to create custom resource MyFailingSns');
    });
  });

  describe('delete with SNS ServiceToken', () => {
    it('should publish delete request to SNS topic', async () => {
      const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // SNS publish succeeds
      mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-789' });

      // S3 GetObject returns success response
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'sns-custom-id-456',
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      await provider.delete('MySnsCustom', 'sns-custom-id-456', 'Custom::SnsResource', {
        ServiceToken: snsTopicArn,
      });

      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });
  });

  // Regression tests for https://github.com/go-to-k/cdkd/issues/804
  //
  // After an interrupted / partially-failed destroy, the preserved state can
  // still list a Custom Resource whose backing Lambda was ALSO deleted in
  // the first run. On re-run, the delete used to enter
  // `waitForBackingLambdaReady`, whose SDK waiters classify
  // ResourceNotFoundException as RETRY and poll GetFunction for the full
  // 10-minute maxWaitTime. The fail-fast pre-check turns that stall into an
  // instant warn-and-continue.
  describe('issue #804: delete fail-fast when backing Lambda is already gone', () => {
    const lambdaToken = 'arn:aws:lambda:us-east-1:123456789012:function:deleted-handler';

    const resourceNotFound = (): Error =>
      Object.assign(new Error(`Function not found: ${lambdaToken}`), {
        name: 'ResourceNotFoundException',
      });

    it('treats the custom resource as already deleted without entering the waiters', async () => {
      // Single GetFunction pre-check rejects with ResourceNotFoundException.
      mockLambdaSend.mockRejectedValueOnce(resourceNotFound());

      await provider.delete('MyCustom', 'cr-physical-id', 'Custom::MyResource', {
        ServiceToken: lambdaToken,
      });

      // Exactly ONE Lambda SDK call: the GetFunction pre-check. No waiter
      // polls (waitUntilFunctionActiveV2 would issue more GetFunction
      // calls) and no Invoke.
      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
      expect(
        (mockLambdaSend.mock.calls[0]![0] as { constructor: { name: string } }).constructor.name
      ).toBe('GetFunctionCommand');
      // No pre-signed URL machinery either — the invocation is never prepared.
      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockSnsSend).not.toHaveBeenCalled();
      // The skip is surfaced as a warning (warn-and-continue is the
      // provider's delete policy).
      expect(childWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no longer exists')
      );
    });

    it('proceeds with the normal delete invoke when the backing Lambda exists', async () => {
      // GetFunction pre-check succeeds → normal path.
      mockLambdaSend.mockResolvedValueOnce({ Configuration: { State: 'Active' } });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Backing-Lambda readiness waiters (2 GetFunction polls).
      mockLambdaReady();

      // Lambda invoke returns direct cfn-response
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from(
          JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'cr-physical-id' })
        ),
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      await provider.delete('MyCustom', 'cr-physical-id', 'Custom::MyResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:live-handler',
      });

      // 1 pre-check + 2 waiter polls + 1 Invoke = 4 Lambda SDK calls.
      expect(mockLambdaSend).toHaveBeenCalledTimes(4);
      expect(childWarnSpy).not.toHaveBeenCalled();
    });

    it('falls through to the normal delete path on an inconclusive pre-check error', async () => {
      // Pre-check fails with a throttle — NOT proof the function is gone.
      mockLambdaSend.mockRejectedValueOnce(
        Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
      );

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Backing-Lambda readiness waiters.
      mockLambdaReady();

      // Lambda invoke returns direct cfn-response
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from(
          JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'cr-physical-id' })
        ),
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      await provider.delete('MyCustom', 'cr-physical-id', 'Custom::MyResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:throttled-handler',
      });

      // 1 pre-check + 2 waiter polls + 1 Invoke = 4 Lambda SDK calls — the
      // delete still ran normally.
      expect(mockLambdaSend).toHaveBeenCalledTimes(4);
    });

    // Gap 1: only ResourceNotFoundException is "definitively gone". Every
    // other pre-check failure class (IAM AccessDenied, a generic 5xx) is
    // INCONCLUSIVE and must fall through to the normal invoke path — we
    // must never skip a real delete just because the probe couldn't read
    // the function.
    it.each([
      ['AccessDeniedException', 'User is not authorized to perform: lambda:GetFunction'],
      ['ServiceException', 'Internal server error'],
    ])(
      'falls through to the normal delete path on an inconclusive %s pre-check error',
      async (errorName, message) => {
        mockLambdaSend.mockRejectedValueOnce(
          Object.assign(new Error(message), { name: errorName })
        );

        // S3 PutObject for placeholder
        mockS3Send.mockResolvedValueOnce({});
        // Backing-Lambda readiness waiters.
        mockLambdaReady();
        // Lambda invoke returns direct cfn-response
        mockLambdaSend.mockResolvedValueOnce({
          Payload: Buffer.from(
            JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'cr-physical-id' })
          ),
        });
        // S3 DeleteObject for cleanup
        mockS3Send.mockResolvedValueOnce({});

        await provider.delete('MyCustom', 'cr-physical-id', 'Custom::MyResource', {
          ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:inconclusive-handler',
        });

        // 1 pre-check + 2 waiter polls + 1 Invoke = 4 Lambda SDK calls — the
        // delete still ran normally; the custom resource was NOT skipped.
        expect(mockLambdaSend).toHaveBeenCalledTimes(4);
        expect(childWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
      }
    );

    // Gap 2: an SNS-backed ServiceToken has no backing Lambda to probe —
    // the `!isSnsServiceToken` short-circuit must skip the GetFunction
    // pre-check entirely (issuing one against an SNS ARN would error
    // spuriously / waste a call). Regression guard for that short-circuit.
    it('does NOT issue a GetFunction pre-check for an SNS ServiceToken', async () => {
      const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});
      // SNS publish succeeds
      mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-789' });
      // S3 GetObject returns success response
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'sns-custom-id-456' })
            ),
        },
      });
      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      await provider.delete('MySnsCustom', 'sns-custom-id-456', 'Custom::SnsResource', {
        ServiceToken: snsTopicArn,
      });

      // The SNS delete path runs; the Lambda client is NEVER touched, so the
      // GetFunction pre-check did not fire.
      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });
  });

  describe('update with SNS ServiceToken', () => {
    it('should publish update request to SNS topic', async () => {
      const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // SNS publish succeeds
      mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-update' });

      // S3 GetObject returns success response with same physical ID
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'sns-custom-id-456',
                Data: { UpdatedAttr: 'new-value' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await provider.update(
        'MySnsCustom',
        'sns-custom-id-456',
        'Custom::SnsResource',
        { ServiceToken: snsTopicArn, Prop1: 'new' },
        { ServiceToken: snsTopicArn, Prop1: 'old' }
      );

      expect(result.physicalId).toBe('sns-custom-id-456');
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({ UpdatedAttr: 'new-value' });
      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });
  });

  describe('async Provider framework (isCompleteHandler pattern)', () => {
    it('should detect async pattern when Lambda returns null payload and poll S3 with longer timeout', async () => {
      // Use a short async timeout for testing
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Backing-Lambda readiness check (post-PR-#121 follow-up).
      mockLambdaReady();

      // Lambda invoke returns null (CDK Provider framework starts Step Functions and returns nothing)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from('null'),
      });

      // S3 GetObject: first poll returns empty (Step Functions still running)
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () => Promise.resolve(''),
        },
      });

      // S3 GetObject: second poll returns the response (Step Functions completed)
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'async-resource-123',
                Data: { AsyncResult: 'completed' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await asyncProvider.create('MyAsyncCustom', 'Custom::AsyncResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
      });

      expect(result.physicalId).toBe('async-resource-123');
      expect(result.attributes).toEqual({ AsyncResult: 'completed' });
      // 2 GetFunction (waiter readiness) + 1 Invoke = 3 Lambda SDK calls.
      expect(mockLambdaSend).toHaveBeenCalledTimes(3);
    });

    it('should detect async pattern when Lambda returns empty object', async () => {
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Backing-Lambda readiness check (post-PR-#121 follow-up).
      mockLambdaReady();

      // Lambda invoke returns empty object (no PhysicalResourceId, no Status, no Data)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from(JSON.stringify({})),
      });

      // S3 GetObject returns response immediately
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'async-resource-456',
                Data: { Output: 'done' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await asyncProvider.create('MyAsyncCustom2', 'Custom::AsyncResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
      });

      expect(result.physicalId).toBe('async-resource-456');
      expect(result.attributes).toEqual({ Output: 'done' });
    });

    it('should handle async FAILED response from Step Functions', async () => {
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Backing-Lambda readiness check (post-PR-#121 follow-up).
      mockLambdaReady();

      // Lambda invoke returns null (async pattern)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from('null'),
      });

      // S3 GetObject returns FAILED (Step Functions timed out or isComplete failed)
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'FAILED',
                Reason: 'Operation timed out',
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      await expect(
        asyncProvider.create('MyFailingAsync', 'Custom::AsyncResource', {
          ServiceToken:
            'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
        })
      ).rejects.toThrow('Custom resource handler returned FAILED: Operation timed out');
    });

    it('should use configurable async timeout', async () => {
      // Very short timeout to trigger timeout quickly
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 100,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Backing-Lambda readiness check (post-PR-#121 follow-up).
      mockLambdaReady();

      // Lambda invoke returns null (async pattern)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from('null'),
      });

      // S3 GetObject keeps returning empty (Step Functions never completes)
      mockS3Send.mockImplementation(() =>
        Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(''),
          },
        })
      );

      await expect(
        asyncProvider.create('MyTimedOutAsync', 'Custom::AsyncResource', {
          ServiceToken:
            'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
        })
      ).rejects.toThrow(
        /Timeout waiting for custom resource response.*Provider framework with isCompleteHandler/
      );
    });

    it('should handle update with async Provider framework', async () => {
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Backing-Lambda readiness check (post-PR-#121 follow-up).
      mockLambdaReady();

      // Lambda invoke returns null (async pattern)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from('null'),
      });

      // S3 GetObject returns success response
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'async-resource-123',
                Data: { UpdatedOutput: 'new-value' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await asyncProvider.update(
        'MyAsyncCustom',
        'async-resource-123',
        'Custom::AsyncResource',
        {
          ServiceToken:
            'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
          Prop: 'new',
        },
        {
          ServiceToken:
            'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
          Prop: 'old',
        }
      );

      expect(result.physicalId).toBe('async-resource-123');
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({ UpdatedOutput: 'new-value' });
    });
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MyCustom',
        resourceType: 'Custom::MyResource',
        cdkPath: 'MyStack/MyCustom',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
        },
        ...overrides,
      };
    }

    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const result = await provider.import(
        makeInput({ knownPhysicalId: 'cr-physical-id-42' })
      );

      expect(result).toEqual({ physicalId: 'cr-physical-id-42', attributes: {} });
      expect(mockLambdaSend).not.toHaveBeenCalled();
      expect(mockSnsSend).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockLambdaSend).not.toHaveBeenCalled();
      expect(mockSnsSend).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });

  // Regression test for https://github.com/go-to-k/cdkd/issues/90
  //
  // The S3 key used to sign the pre-signed ResponseURL given to the Lambda
  // MUST match the S3 key cdkd polls afterwards. If the two are generated
  // separately, the Lambda writes its cfn-response to one key while cdkd
  // polls a different one and the deploy hangs for up to 1 hour (the
  // polling timeout).
  describe('issue #90: ResponseURL key consistency', () => {
    it('uses the same S3 key for the placeholder put, the request payload, and the polling read', async () => {
      // Async pattern — Lambda returns null so cdkd falls into the S3 polling loop.
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });

      // Capture every S3 command in order so we can compare keys across
      // the placeholder PutObject, the polling GetObject, and the cleanup
      // DeleteObject.
      const s3Commands: Array<{ name: string; key: string | undefined }> = [];
      mockS3Send.mockImplementation((cmd: { constructor: { name: string }; input: { Key?: string } }) => {
        s3Commands.push({ name: cmd.constructor.name, key: cmd.input.Key });
        if (cmd.constructor.name === 'GetObjectCommand') {
          return Promise.resolve({
            Body: {
              transformToString: () =>
                Promise.resolve(
                  JSON.stringify({
                    Status: 'SUCCESS',
                    PhysicalResourceId: 'cr-physical-id',
                  })
                ),
            },
          });
        }
        return Promise.resolve({});
      });

      // Backing-Lambda readiness check (post-PR-#121 follow-up): the SDK
      // waiters consume two GetFunction polls before sendRequest reaches
      // the actual Invoke. mockImplementationOnce is queued — these run
      // BEFORE the Invoke handler below.
      mockLambdaReady();

      // Capture the Lambda invocation so we can extract the RequestId
      // baked into the payload — the polling key must derive from it.
      let invokedRequestId: string | undefined;
      mockLambdaSend.mockImplementationOnce((cmd: { input: { Payload: Uint8Array } }) => {
        const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString()) as {
          RequestId: string;
          ResponseURL: string;
        };
        invokedRequestId = payload.RequestId;
        // null payload triggers the async polling path.
        return Promise.resolve({ Payload: Buffer.from('null') });
      });

      const result = await asyncProvider.create('MyCustom', 'Custom::MyResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
      });

      expect(result.physicalId).toBe('cr-physical-id');

      // S3 command sequence: PutObject (placeholder) -> GetObject (poll) -> DeleteObject (cleanup).
      const putKey = s3Commands.find((c) => c.name === 'PutObjectCommand')?.key;
      const getKey = s3Commands.find((c) => c.name === 'GetObjectCommand')?.key;
      const deleteKey = s3Commands.find((c) => c.name === 'DeleteObjectCommand')?.key;

      expect(putKey).toBeDefined();
      expect(getKey).toBeDefined();
      expect(deleteKey).toBeDefined();

      // The load-bearing assertion: the URL the Lambda was handed (via the
      // placeholder put) and the key cdkd polls must be the same key.
      expect(getKey).toBe(putKey);
      expect(deleteKey).toBe(putKey);

      // And the Lambda's RequestId must be the one embedded in that key.
      expect(invokedRequestId).toBeDefined();
      expect(getKey).toContain(invokedRequestId!);
    });
  });

  describe('ServiceToken type guard (defensive against unresolved intrinsics)', () => {
    // Companion to the cdkd-import intrinsic-resolution fix (separate PR).
    // Even if a raw {Fn::GetAtt: [...]} object ever leaks into state.properties
    // (corrupted state, partial migration, pre-fix import), each entrypoint
    // must surface a typed ProvisioningError naming the problem, NOT the
    // unhelpful "TypeError: serviceToken.startsWith is not a function".
    const rawIntrinsic = { 'Fn::GetAtt': ['MyHandlerFn', 'Arn'] };

    it('create() rejects an object-shaped ServiceToken with a typed error', async () => {
      await expect(
        provider.create('MyCustomResource', 'Custom::MyType', {
          ServiceToken: rawIntrinsic,
        })
      ).rejects.toThrow(/Custom Resource MyCustomResource: ServiceToken is not a resolved string ARN \(got object\)/);
    });

    it('update() rejects an object-shaped ServiceToken with a typed error', async () => {
      await expect(
        provider.update(
          'MyCustomResource',
          'existing-physical-id',
          'Custom::MyType',
          { ServiceToken: rawIntrinsic },
          { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:old' }
        )
      ).rejects.toThrow(/Custom Resource MyCustomResource: ServiceToken is not a resolved string ARN \(got object\)/);
    });

    it('delete() rejects an object-shaped ServiceToken with a typed error', async () => {
      await expect(
        provider.delete(
          'MyCustomResource',
          'existing-physical-id',
          'Custom::MyType',
          { ServiceToken: rawIntrinsic }
        )
      ).rejects.toThrow(/Custom Resource MyCustomResource: ServiceToken is not a resolved string ARN \(got object\)/);
    });

    it('error message mentions the recovery path so users know the fix', async () => {
      // The whole point of the typed error is to make the bug class
      // actionable. Verify the suggested-action sentence is there.
      await expect(
        provider.delete('MyCustomResource', 'physical-id', 'Custom::MyType', {
          ServiceToken: rawIntrinsic,
        })
      ).rejects.toThrow(/re-run.*cdkd import.*cdkd state orphan/s);
    });
  });
});
