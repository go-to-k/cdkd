import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetAgentRuntimeCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-bedrock-agentcore-control';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    bedrockAgentCoreControl: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
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

describe('AgentCoreRuntimeProvider.readCurrentState', () => {
  let provider: AgentCoreRuntimeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentCoreRuntimeProvider();
  });

  it('returns CFn-shaped properties (camelCase → PascalCase re-shape)', async () => {
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: 'runtime-1',
      agentRuntimeName: 'my-runtime',
      roleArn: 'arn:aws:iam::123:role/runtime',
      description: 'my agent',
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest' },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: { serverProtocol: 'HTTP' },
      environmentVariables: { LOG_LEVEL: 'debug' },
    });

    const result = await provider.readCurrentState(
      'runtime-1',
      'Logical',
      'AWS::BedrockAgentCore::Runtime'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetAgentRuntimeCommand);
    expect(result).toEqual({
      AgentRuntimeName: 'my-runtime',
      RoleArn: 'arn:aws:iam::123:role/runtime',
      Description: 'my agent',
      AgentRuntimeArtifact: {
        ContainerConfiguration: {
          ContainerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest',
        },
      },
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      ProtocolConfiguration: { ServerProtocol: 'HTTP' },
      EnvironmentVariables: { LOG_LEVEL: 'debug' },
    });
  });

  it('returns undefined when runtime gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'runtime-1',
      'Logical',
      'AWS::BedrockAgentCore::Runtime'
    );
    expect(result).toBeUndefined();
  });

  it('omits empty Description', async () => {
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: 'runtime-1',
      agentRuntimeName: 'my-runtime',
      roleArn: 'arn:aws:iam::123:role/runtime',
      description: '',
    });
    const result = await provider.readCurrentState(
      'runtime-1',
      'Logical',
      'AWS::BedrockAgentCore::Runtime'
    );
    expect(result).not.toHaveProperty('Description');
  });
});
