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
      // No handled property changed, so update() returns without sending —
      // the wrap must not turn a legitimate no-op into an error.
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
  });
});
