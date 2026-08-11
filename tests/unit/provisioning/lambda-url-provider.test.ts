import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ResourceNotFoundException } from '@aws-sdk/client-lambda';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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

import { LambdaUrlProvider } from '../../../src/provisioning/providers/lambda-url-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

describe('LambdaUrlProvider', () => {
  let provider: LambdaUrlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaUrlProvider();
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MyUrl',
        resourceType: 'AWS::Lambda::Url',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          TargetFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function',
          AuthType: 'NONE',
        },
        ...overrides,
      };
    }

    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-function';
      const result = await provider.import(makeInput({ knownPhysicalId: arn }));

      expect(result).toEqual({ physicalId: arn, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('getAttribute', () => {
    it('returns FunctionUrl from GetFunctionUrlConfig', async () => {
      mockSend.mockResolvedValueOnce({
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-fn',
        FunctionUrl: 'https://abc123.lambda-url.us-east-1.on.aws/',
      });

      const result = await provider.getAttribute('my-fn', 'AWS::Lambda::Url', 'FunctionUrl');
      expect(result).toBe('https://abc123.lambda-url.us-east-1.on.aws/');
    });

    it('returns FunctionArn from GetFunctionUrlConfig', async () => {
      mockSend.mockResolvedValueOnce({
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-fn',
        FunctionUrl: 'https://abc123.lambda-url.us-east-1.on.aws/',
      });

      const result = await provider.getAttribute('my-fn', 'AWS::Lambda::Url', 'FunctionArn');
      expect(result).toBe('arn:aws:lambda:us-east-1:123:function:my-fn');
    });

    it('returns undefined for unknown attribute', async () => {
      mockSend.mockResolvedValueOnce({
        FunctionArn: 'arn',
        FunctionUrl: 'https://x',
      });

      const result = await provider.getAttribute('my-fn', 'AWS::Lambda::Url', 'Unknown');
      expect(result).toBeUndefined();
    });

    it('returns undefined when URL config not found', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );

      const result = await provider.getAttribute('missing-fn', 'AWS::Lambda::Url', 'FunctionUrl');
      expect(result).toBeUndefined();
    });
  });

  describe('update error wrapping', () => {
    // Issue #1263: the UpdateFunctionUrlConfig send was the one call in this
    // provider not wrapped in ProvisioningError, so an AWS SDK error surfaced
    // raw and bypassed cdkd's typed error formatting / exit-code handling.
    it('wraps an UpdateFunctionUrlConfig failure in ProvisioningError', async () => {
      const sdkError = new Error('The function URL config could not be updated');
      mockSend.mockRejectedValueOnce(sdkError);

      // AuthType differs from the previous side so the diff-based no-op gate
      // opens and the AWS call is actually attempted.
      const promise = provider.update(
        'MyUrl',
        'arn:aws:lambda:us-east-1:123456789012:function:my-fn',
        'AWS::Lambda::Url',
        { AuthType: 'AWS_IAM' },
        { AuthType: 'NONE' }
      );

      await expect(promise).rejects.toThrow(ProvisioningError);
      await expect(promise).rejects.toMatchObject({
        resourceType: 'AWS::Lambda::Url',
        logicalId: 'MyUrl',
        physicalId: 'arn:aws:lambda:us-east-1:123456789012:function:my-fn',
        cause: sdkError,
      });
      await expect(promise).rejects.toThrow(
        'Failed to update Lambda URL MyUrl: The function URL config could not be updated'
      );
    });

    it('does not wrap when the diff-based no-op gate skips the AWS call', async () => {
      // No handled property changed, so update() returns without sending.
      // The early return sits OUTSIDE the try, so this pins the pre-existing
      // no-op behavior rather than guarding the wrap itself — it is the
      // regression fence for anyone later widening the try to enclose it.
      const props = { AuthType: 'NONE' };
      const result = await provider.update(
        'MyUrl',
        'my-fn',
        'AWS::Lambda::Url',
        props,
        { ...props }
      );

      expect(result).toEqual({ physicalId: 'my-fn', wasReplaced: false, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('wraps a non-Error rejection with a stringified message and no cause', async () => {
      // The `error instanceof Error` narrowing has two arms; the non-Error arm
      // is reachable in principle (a middleware rejecting with a plain value)
      // and must still produce a well-formed ProvisioningError.
      mockSend.mockRejectedValueOnce('boom');

      const promise = provider.update(
        'MyUrl',
        'my-fn',
        'AWS::Lambda::Url',
        { AuthType: 'AWS_IAM' },
        { AuthType: 'NONE' }
      );

      await expect(promise).rejects.toThrow(ProvisioningError);
      await expect(promise).rejects.toThrow('Failed to update Lambda URL MyUrl: boom');
      await expect(promise).rejects.toMatchObject({
        resourceType: 'AWS::Lambda::Url',
        logicalId: 'MyUrl',
        physicalId: 'my-fn',
      });
      const caught = await promise.catch((e: unknown) => e);
      expect((caught as Error).cause).toBeUndefined();
    });
  });
  // The `||`-shaped residual the #1490 sweep missed (issue #1493): its grep
  // keyed on the `as string` cast, and this site casts to
  // `FunctionUrlAuthType`. A blank / null AuthType defaulted to 'NONE', i.e.
  // a PUBLIC function URL the template never asked for.
  describe('malformed AuthType (issue #1493)', () => {
    it('refuses a blank AuthType instead of creating a PUBLIC url', async () => {
      await expect(
        provider.create('MyUrl', 'AWS::Lambda::Url', {
          TargetFunctionArn: 'my-fn',
          AuthType: '',
        })
      ).rejects.toThrow(/AWS::Lambda::Url AuthType must be a non-empty string/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('keeps the PREVIOUS AuthType on update instead of opening the url up', async () => {
      // The refusal became a WARN in issue #1551 (the update path is a replay
      // path: `rollback-executor.ts` / `drift --revert` feed a cdkd STATE
      // record in as the desired bag). What the original assertion actually
      // protects — the url must not become PUBLIC — is unchanged and now
      // pinned on the value sent: the previous AWS_IAM, never the 'NONE'
      // default. The full matrix lives in
      // `lambda-url-provider-authtype-replay.test.ts`.
      mockSend.mockResolvedValue({
        FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/',
        FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-fn',
      });

      await provider.update(
        'MyUrl',
        'my-fn',
        'AWS::Lambda::Url',
        { TargetFunctionArn: 'my-fn', AuthType: null, InvokeMode: 'RESPONSE_STREAM' },
        { TargetFunctionArn: 'my-fn', AuthType: 'AWS_IAM', InvokeMode: 'BUFFERED' }
      );

      const updateCall = mockSend.mock.calls.find(
        (c) => c[0].constructor.name === 'UpdateFunctionUrlConfigCommand'
      );
      expect(updateCall?.[0].input.AuthType).toBe('AWS_IAM');
    });

    it('still defaults to NONE when AuthType is ABSENT, as CloudFormation does', async () => {
      mockSend.mockResolvedValueOnce({
        FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/',
        FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-fn',
      });

      await provider.create('MyUrl', 'AWS::Lambda::Url', { TargetFunctionArn: 'my-fn' });

      expect(mockSend.mock.calls[0][0].input.AuthType).toBe('NONE');
    });
  });
});
