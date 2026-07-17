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
  AgentCoreBrowserProvider,
  DEFAULT_BROWSER_ID,
} from '../../../../src/provisioning/providers/agentcore-browser-provider.js';

const DEFAULT_ARN = 'arn:aws:bedrock-agentcore:us-east-1:aws:browser/aws.browser.v1';

describe('AgentCoreBrowserProvider', () => {
  let provider: AgentCoreBrowserProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentCoreBrowserProvider();
  });

  describe('create (adopt)', () => {
    it('should adopt the AWS-managed default browser via GetBrowser', async () => {
      mockSend.mockResolvedValueOnce({
        browserId: DEFAULT_BROWSER_ID,
        browserArn: DEFAULT_ARN,
        name: 'AgentCore Browser Tool',
        status: 'READY',
      });

      const result = await provider.create('MyBrowser', 'AWS::BedrockAgentCore::Browser', {});

      expect(result.physicalId).toBe(DEFAULT_ARN);
      expect(result.attributes).toEqual({
        BrowserArn: DEFAULT_ARN,
        BrowserId: DEFAULT_BROWSER_ID,
        Name: 'AgentCore Browser Tool',
        Status: 'READY',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetBrowserCommand');
      expect(getCall.input.browserId).toBe(DEFAULT_BROWSER_ID);
    });

    it('should throw ProvisioningError when the default browser cannot be resolved', async () => {
      mockSend.mockRejectedValueOnce(new Error('Service unavailable'));

      await expect(
        provider.create('MyBrowser', 'AWS::BedrockAgentCore::Browser', {})
      ).rejects.toThrow('Failed to adopt the AWS-managed default browser for MyBrowser');
    });
  });

  describe('update', () => {
    it('should be a no-op (all properties are read-only)', async () => {
      const result = await provider.update(
        'MyBrowser',
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::Browser',
        {},
        {}
      );

      expect(result.physicalId).toBe(DEFAULT_ARN);
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should be a no-op (the default browser is AWS-owned)', async () => {
      await provider.delete('MyBrowser', DEFAULT_ARN, 'AWS::BedrockAgentCore::Browser');

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('getAttribute', () => {
    it('should return BrowserArn from the physical id without an AWS call', async () => {
      const arn = await provider.getAttribute(
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::Browser',
        'BrowserArn'
      );

      expect(arn).toBe(DEFAULT_ARN);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should return the fixed BrowserId without an AWS call', async () => {
      const id = await provider.getAttribute(
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::Browser',
        'BrowserId'
      );

      expect(id).toBe(DEFAULT_BROWSER_ID);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should fetch Name and Status live via GetBrowser', async () => {
      mockSend.mockResolvedValue({
        browserId: DEFAULT_BROWSER_ID,
        browserArn: DEFAULT_ARN,
        name: 'AgentCore Browser Tool',
        status: 'READY',
      });

      const name = await provider.getAttribute(
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::Browser',
        'Name'
      );
      const status = await provider.getAttribute(
        DEFAULT_ARN,
        'AWS::BedrockAgentCore::Browser',
        'Status'
      );

      expect(name).toBe('AgentCore Browser Tool');
      expect(status).toBe('READY');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should throw on unsupported attribute', async () => {
      await expect(
        provider.getAttribute(DEFAULT_ARN, 'AWS::BedrockAgentCore::Browser', 'Bogus')
      ).rejects.toThrow('Unsupported attribute: Bogus');
    });
  });

  describe('readCurrentState', () => {
    it('should return an empty object (no managed properties, nothing can drift)', async () => {
      await expect(provider.readCurrentState()).resolves.toEqual({});
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    it('should auto-adopt the default browser via live lookup', async () => {
      mockSend.mockResolvedValueOnce({
        browserId: DEFAULT_BROWSER_ID,
        browserArn: DEFAULT_ARN,
        name: 'AgentCore Browser Tool',
        status: 'READY',
      });

      const result = await provider.import({
        logicalId: 'MyBrowser',
        resourceType: 'AWS::BedrockAgentCore::Browser',
        cdkPath: 'MyStack/MyBrowser',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result).toEqual({
        physicalId: DEFAULT_ARN,
        attributes: {
          BrowserArn: DEFAULT_ARN,
          BrowserId: DEFAULT_BROWSER_ID,
          Name: 'AgentCore Browser Tool',
          Status: 'READY',
        },
      });
    });
  });
});
