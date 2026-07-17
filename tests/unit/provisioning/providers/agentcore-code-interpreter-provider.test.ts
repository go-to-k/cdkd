import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    bedrockAgentCoreControl: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../../src/utils/logger.js', () => {
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

import {
  AgentCoreCodeInterpreterProvider,
  DEFAULT_CODE_INTERPRETER_ID,
} from '../../../../src/provisioning/providers/agentcore-code-interpreter-provider.js';

const DEFAULT_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:aws:code-interpreter/aws.codeinterpreter.v1';

describe('AgentCoreCodeInterpreterProvider', () => {
  let provider: AgentCoreCodeInterpreterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentCoreCodeInterpreterProvider();
  });

  describe('create (adopt)', () => {
    it('should adopt the AWS-managed default code interpreter via GetCodeInterpreter', async () => {
      mockSend.mockResolvedValueOnce({
        codeInterpreterId: DEFAULT_CODE_INTERPRETER_ID,
        codeInterpreterArn: DEFAULT_ARN,
        name: 'AgentCore Code Interpreter',
        status: 'READY',
      });

      const result = await provider.create(
        'MyInterpreter',
        'AWS::BedrockAgentCore::CodeInterpreter',
        {}
      );

      expect(result.physicalId).toBe(DEFAULT_ARN);
      expect(result.attributes).toEqual({
        CodeInterpreterArn: DEFAULT_ARN,
        CodeInterpreterId: DEFAULT_CODE_INTERPRETER_ID,
        Status: 'READY',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetCodeInterpreterCommand');
      expect(getCall.input.codeInterpreterId).toBe(DEFAULT_CODE_INTERPRETER_ID);
    });

    it('should throw ProvisioningError when the default code interpreter cannot be resolved', async () => {
      mockSend.mockRejectedValueOnce(new Error('Service unavailable'));

      await expect(
        provider.create('MyInterpreter', 'AWS::BedrockAgentCore::CodeInterpreter', {})
      ).rejects.toThrow(
        'Failed to adopt the AWS-managed default code interpreter for MyInterpreter'
      );
    });
  });

  describe('update', () => {
    it('should be a no-op (all properties are read-only)', async () => {
      const result = await provider.update(
        'MyInterpreter',
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::CodeInterpreter',
        {},
        {}
      );

      expect(result.physicalId).toBe(DEFAULT_ARN);
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should be a no-op (the default code interpreter is AWS-owned)', async () => {
      await provider.delete(
        'MyInterpreter',
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::CodeInterpreter'
      );

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('getAttribute', () => {
    it('should return CodeInterpreterArn from the physical id without an AWS call', async () => {
      const arn = await provider.getAttribute(
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::CodeInterpreter',
        'CodeInterpreterArn'
      );

      expect(arn).toBe(DEFAULT_ARN);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should return the fixed CodeInterpreterId without an AWS call', async () => {
      const id = await provider.getAttribute(
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::CodeInterpreter',
        'CodeInterpreterId'
      );

      expect(id).toBe(DEFAULT_CODE_INTERPRETER_ID);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should fetch Status live via GetCodeInterpreter', async () => {
      mockSend.mockResolvedValueOnce({
        codeInterpreterId: DEFAULT_CODE_INTERPRETER_ID,
        codeInterpreterArn: DEFAULT_ARN,
        status: 'READY',
      });

      const status = await provider.getAttribute(
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::CodeInterpreter',
        'Status'
      );

      expect(status).toBe('READY');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should throw on unsupported attribute', async () => {
      await expect(
        provider.getAttribute(DEFAULT_ARN, 'AWS::BedrockAgentCore::CodeInterpreter', 'Name')
      ).rejects.toThrow('Unsupported attribute: Name');
    });
  });

  describe('readCurrentState', () => {
    it('should return an empty object (no managed properties, nothing can drift)', async () => {
      await expect(provider.readCurrentState()).resolves.toEqual({});
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    it('should auto-adopt the default code interpreter via live lookup', async () => {
      mockSend.mockResolvedValueOnce({
        codeInterpreterId: DEFAULT_CODE_INTERPRETER_ID,
        codeInterpreterArn: DEFAULT_ARN,
        status: 'READY',
      });

      const result = await provider.import({
        logicalId: 'MyInterpreter',
        resourceType: 'AWS::BedrockAgentCore::CodeInterpreter',
        cdkPath: 'MyStack/MyInterpreter',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result).toEqual({
        physicalId: DEFAULT_ARN,
        attributes: {
          CodeInterpreterArn: DEFAULT_ARN,
          CodeInterpreterId: DEFAULT_CODE_INTERPRETER_ID,
          Status: 'READY',
        },
      });
    });
  });
});
