import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { AddPermissionCommand } from '@aws-sdk/client-lambda';

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

  describe('create — InvokedViaFunctionUrl backfill (issue #609)', () => {
    const baseProperties = {
      FunctionName: 'my-function',
      Action: 'lambda:InvokeFunctionUrl',
      Principal: '*',
      FunctionUrlAuthType: 'NONE',
    };

    it('forwards InvokedViaFunctionUrl: true into AddPermissionCommand', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('MyPermission', 'AWS::Lambda::Permission', {
        ...baseProperties,
        InvokedViaFunctionUrl: true,
      });

      expect(mockSend).toHaveBeenCalledOnce();
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(AddPermissionCommand);
      const input = (cmd as AddPermissionCommand).input;
      expect(input.InvokedViaFunctionUrl).toBe(true);
      expect(input.FunctionUrlAuthType).toBe('NONE');
    });

    it('forwards InvokedViaFunctionUrl: false into AddPermissionCommand (explicit false is preserved)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('MyPermission', 'AWS::Lambda::Permission', {
        ...baseProperties,
        InvokedViaFunctionUrl: false,
      });

      const cmd = mockSend.mock.calls[0]?.[0] as AddPermissionCommand;
      expect(cmd.input.InvokedViaFunctionUrl).toBe(false);
    });

    it('omits InvokedViaFunctionUrl when absent from properties', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('MyPermission', 'AWS::Lambda::Permission', baseProperties);

      const cmd = mockSend.mock.calls[0]?.[0] as AddPermissionCommand;
      expect(cmd.input).not.toHaveProperty('InvokedViaFunctionUrl');
    });
  });
});
