import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceNotFoundException } from '@aws-sdk/client-bedrock-agentcore-control';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    bedrockAgentCoreControl: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { AgentCoreRuntimeProvider } from '../../../src/provisioning/providers/agentcore-runtime-provider.js';

describe('AgentCoreRuntimeProvider', () => {
  let provider: AgentCoreRuntimeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentCoreRuntimeProvider();
  });

  describe('create', () => {
    it('should create a runtime with required properties', async () => {
      mockSend.mockResolvedValueOnce({
        agentRuntimeId: 'runtime-12345',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345',
        status: 'CREATING',
      });

      const result = await provider.create(
        'MyRuntime',
        'AWS::BedrockAgentCore::Runtime',
        {
          AgentRuntimeName: 'my-runtime',
          RoleArn: 'arn:aws:iam::123456789012:role/my-role',
        }
      );

      expect(result.physicalId).toBe('runtime-12345');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345',
        AgentRuntimeId: 'runtime-12345',
        AgentRuntimeName: 'my-runtime',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateAgentRuntimeCommand');
      expect(createCall.input.agentRuntimeName).toBe('my-runtime');
      expect(createCall.input.roleArn).toBe('arn:aws:iam::123456789012:role/my-role');
    });

    it('should pass optional properties to CreateAgentRuntimeCommand', async () => {
      mockSend.mockResolvedValueOnce({
        agentRuntimeId: 'runtime-12345',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345',
        status: 'CREATING',
      });

      await provider.create('MyRuntime', 'AWS::BedrockAgentCore::Runtime', {
        AgentRuntimeName: 'my-runtime',
        RoleArn: 'arn:aws:iam::123456789012:role/my-role',
        Description: 'Test runtime',
        NetworkConfiguration: { networkMode: 'PUBLIC' },
        ProtocolConfiguration: { serverProtocol: 'MCP' },
        EnvironmentVariables: { ENV_VAR: 'value' },
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.description).toBe('Test runtime');
      expect(createCall.input.networkConfiguration).toEqual({ networkMode: 'PUBLIC' });
      expect(createCall.input.protocolConfiguration).toEqual({ serverProtocol: 'MCP' });
      expect(createCall.input.environmentVariables).toEqual({ ENV_VAR: 'value' });
    });

    it('should throw ProvisioningError when AgentRuntimeName is missing', async () => {
      await expect(
        provider.create('MyRuntime', 'AWS::BedrockAgentCore::Runtime', {
          RoleArn: 'arn:aws:iam::123456789012:role/my-role',
        })
      ).rejects.toThrow('AgentRuntimeName is required for MyRuntime');
    });

    it('should throw ProvisioningError when RoleArn is missing', async () => {
      await expect(
        provider.create('MyRuntime', 'AWS::BedrockAgentCore::Runtime', {
          AgentRuntimeName: 'my-runtime',
        })
      ).rejects.toThrow('RoleArn is required for MyRuntime');
    });

    it('should throw ProvisioningError on SDK failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.create('MyRuntime', 'AWS::BedrockAgentCore::Runtime', {
          AgentRuntimeName: 'my-runtime',
          RoleArn: 'arn:aws:iam::123456789012:role/my-role',
        })
      ).rejects.toThrow('Failed to create BedrockAgentCore Runtime MyRuntime');
    });
  });

  describe('update', () => {
    it('should update a runtime', async () => {
      mockSend.mockResolvedValueOnce({
        agentRuntimeId: 'runtime-12345',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345',
        status: 'UPDATING',
      });

      const result = await provider.update(
        'MyRuntime',
        'runtime-12345',
        'AWS::BedrockAgentCore::Runtime',
        {
          AgentRuntimeName: 'my-runtime',
          RoleArn: 'arn:aws:iam::123456789012:role/my-role',
          Description: 'Updated description',
        },
        {
          AgentRuntimeName: 'my-runtime',
          RoleArn: 'arn:aws:iam::123456789012:role/my-role',
          Description: 'Old description',
        }
      );

      expect(result.physicalId).toBe('runtime-12345');
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345',
        AgentRuntimeId: 'runtime-12345',
        AgentRuntimeName: 'my-runtime',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const updateCall = mockSend.mock.calls[0][0];
      expect(updateCall.constructor.name).toBe('UpdateAgentRuntimeCommand');
      expect(updateCall.input.agentRuntimeId).toBe('runtime-12345');
      expect(updateCall.input.description).toBe('Updated description');
    });

    it('should throw ProvisioningError when RoleArn is missing', async () => {
      await expect(
        provider.update(
          'MyRuntime',
          'runtime-12345',
          'AWS::BedrockAgentCore::Runtime',
          { AgentRuntimeName: 'my-runtime' },
          { AgentRuntimeName: 'my-runtime' }
        )
      ).rejects.toThrow('RoleArn is required for MyRuntime');
    });

    it('should throw ProvisioningError on SDK failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Throttling'));

      await expect(
        provider.update(
          'MyRuntime',
          'runtime-12345',
          'AWS::BedrockAgentCore::Runtime',
          {
            AgentRuntimeName: 'my-runtime',
            RoleArn: 'arn:aws:iam::123456789012:role/my-role',
          },
          {
            AgentRuntimeName: 'my-runtime',
            RoleArn: 'arn:aws:iam::123456789012:role/my-role',
          }
        )
      ).rejects.toThrow('Failed to update BedrockAgentCore Runtime MyRuntime');
    });
  });

  describe('delete', () => {
    it('should delete a runtime', async () => {
      mockSend.mockResolvedValueOnce({
        agentRuntimeId: 'runtime-12345',
        status: 'DELETING',
      });

      await provider.delete(
        'MyRuntime',
        'runtime-12345',
        'AWS::BedrockAgentCore::Runtime'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);

      const deleteCall = mockSend.mock.calls[0][0];
      expect(deleteCall.constructor.name).toBe('DeleteAgentRuntimeCommand');
      expect(deleteCall.input.agentRuntimeId).toBe('runtime-12345');
    });

    it('should skip deletion when runtime does not exist (ResourceNotFoundException)', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ $metadata: {}, message: 'not found' })
      );

      await provider.delete(
        'MyRuntime',
        'runtime-12345',
        'AWS::BedrockAgentCore::Runtime'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should throw ProvisioningError on unexpected failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.delete(
          'MyRuntime',
          'runtime-12345',
          'AWS::BedrockAgentCore::Runtime'
        )
      ).rejects.toThrow('Failed to delete BedrockAgentCore Runtime MyRuntime');
    });
  });

  describe('getAttribute', () => {
    it('should return Arn from GetAgentRuntime', async () => {
      mockSend.mockResolvedValueOnce({
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345',
        agentRuntimeName: 'my-runtime',
      });

      const arn = await provider.getAttribute(
        'runtime-12345',
        'AWS::BedrockAgentCore::Runtime',
        'Arn'
      );

      expect(arn).toBe(
        'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345'
      );

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetAgentRuntimeCommand');
      expect(getCall.input.agentRuntimeId).toBe('runtime-12345');
    });

    it('should return AgentRuntimeArn from GetAgentRuntime', async () => {
      mockSend.mockResolvedValueOnce({
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345',
      });

      const arn = await provider.getAttribute(
        'runtime-12345',
        'AWS::BedrockAgentCore::Runtime',
        'AgentRuntimeArn'
      );

      expect(arn).toBe(
        'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345'
      );
    });

    it('should return AgentRuntimeId directly from physicalId', async () => {
      const id = await provider.getAttribute(
        'runtime-12345',
        'AWS::BedrockAgentCore::Runtime',
        'AgentRuntimeId'
      );

      expect(id).toBe('runtime-12345');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should return AgentRuntimeName from GetAgentRuntime', async () => {
      mockSend.mockResolvedValueOnce({
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-12345',
        agentRuntimeName: 'my-runtime',
      });

      const name = await provider.getAttribute(
        'runtime-12345',
        'AWS::BedrockAgentCore::Runtime',
        'AgentRuntimeName'
      );

      expect(name).toBe('my-runtime');
    });

    it('should throw for unsupported attribute', async () => {
      await expect(
        provider.getAttribute(
          'runtime-12345',
          'AWS::BedrockAgentCore::Runtime',
          'UnsupportedAttr'
        )
      ).rejects.toThrow('Unsupported attribute: UnsupportedAttr');
    });
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MyRuntime',
        resourceType: 'AWS::BedrockAgentCore::Runtime',
        cdkPath: 'MyStack/MyRuntime',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          AgentRuntimeName: 'my-runtime',
          RoleArn: 'arn:aws:iam::123456789012:role/my-role',
        },
        ...overrides,
      };
    }

    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const result = await provider.import(makeInput({ knownPhysicalId: 'runtime-12345' }));

      expect(result).toEqual({
        physicalId: 'runtime-12345',
        attributes: { AgentRuntimeId: 'runtime-12345' },
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
