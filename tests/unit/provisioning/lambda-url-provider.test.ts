import { describe, it, expect, vi, beforeEach } from 'vitest';
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
        cdkPath: 'MyStack/MyUrl',
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
});
