import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
