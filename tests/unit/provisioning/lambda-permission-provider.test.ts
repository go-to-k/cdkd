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

import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';

describe('LambdaPermissionProvider', () => {
  let provider: LambdaPermissionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaPermissionProvider();
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MyPermission',
        resourceType: 'AWS::Lambda::Permission',
        cdkPath: 'MyStack/MyPermission',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          FunctionName: 'my-function',
          Action: 'lambda:InvokeFunction',
          Principal: 'apigateway.amazonaws.com',
        },
        ...overrides,
      };
    }

    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const result = await provider.import(makeInput({ knownPhysicalId: 'AllowApiGateway' }));

      expect(result).toEqual({
        physicalId: 'AllowApiGateway',
        attributes: { Id: 'AllowApiGateway' },
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
