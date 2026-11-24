import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetAgentRuntimeCommand,
  ListTagsForResourceCommand,
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
    child: vi.fn(function (this: unknown) { return this; }),
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
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

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
      // SDK returns `{serverProtocol: 'HTTP'}`; we surface the bare
      // string form to match CFn's documented shape and the typical
      // post-CDK-synth state.
      ProtocolConfiguration: 'HTTP',
      EnvironmentVariables: { LOG_LEVEL: 'debug' },
      // Placeholders for the unset go-to-k/cdkd#2762 fields. No ARN in the
      // response, so no ListTagsForResource and no Tags key.
      RequestHeaderConfiguration: {},
      FilesystemConfigurations: [],
      CapacityProviderConfiguration: {},
      PlatformVersion: '',
      HooksConfiguration: {},
      ResourceConfigurations: [],
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('reads back HooksConfiguration and ResourceConfigurations PascalCased (PR #6630)', async () => {
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: 'runtime-1',
      agentRuntimeName: 'my-runtime',
      hooksConfiguration: {
        build: { warmup: { action: { httpPost: { path: '/warmup', port: 8080 } } } },
      },
      resourceConfigurations: [{ minimumMemoryInMiB: 2048 }],
    });
    const result = (await provider.readCurrentState(
      'runtime-1',
      'Logical',
      'AWS::BedrockAgentCore::Runtime'
    )) as Record<string, unknown>;
    expect(result['HooksConfiguration']).toEqual({
      Build: { Warmup: { Action: { HttpPost: { Path: '/warmup', Port: 8080 } } } },
    });
    expect(result['ResourceConfigurations']).toEqual([{ MinimumMemoryInMiB: 2048 }]);
    // The Port AWS fills in is no drift against a template that left it out.
    expect(
      calculateResourceDrift(
        { HooksConfiguration: { Build: { Warmup: { Action: { HttpPost: { Path: '/warmup' } } } } } },
        { HooksConfiguration: result['HooksConfiguration'] }
      )
    ).toEqual([]);
  });

  it('an observed baseline written before cdkd read the two fields reports nothing', () => {
    expect(
      calculateResourceDrift(
        { AgentRuntimeName: 'r' },
        { AgentRuntimeName: 'r', HooksConfiguration: {}, ResourceConfigurations: [] }
      )
    ).toEqual([]);
  });

  it('reads back the go-to-k/cdkd#2762 fields and Tags (a map, aws: keys left out)', async () => {
    const arn = 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/runtime-1';
    mockSend
      .mockResolvedValueOnce({
        agentRuntimeId: 'runtime-1',
        agentRuntimeArn: arn,
        agentRuntimeName: 'my-runtime',
        roleArn: 'arn:aws:iam::123:role/runtime',
        requestHeaderConfiguration: {
          requestHeaderAllowlist: ['X-Amzn-Bedrock-AgentCore-Runtime-Custom-A'],
        },
        filesystemConfigurations: [
          { sessionStorage: { mountPath: '/mnt/session' } },
          { efsAccessPoint: { accessPointArn: 'arn:efs', mountPath: '/mnt/efs' } },
        ],
        capacityProviderConfiguration: { capacityProviderArn: 'arn:cp' },
        platformVersion: '1.0',
      })
      .mockResolvedValueOnce({ tags: { Env: 'dev', lowerKey: 'v', 'aws:cloudformation:x': 'y' } });

    const result = (await provider.readCurrentState(
      'runtime-1',
      'Logical',
      'AWS::BedrockAgentCore::Runtime'
    )) as Record<string, unknown>;

    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(mockSend.mock.calls[1]?.[0].input).toEqual({ resourceArn: arn });
    expect(result['RequestHeaderConfiguration']).toEqual({
      RequestHeaderAllowlist: ['X-Amzn-Bedrock-AgentCore-Runtime-Custom-A'],
    });
    expect(result['FilesystemConfigurations']).toEqual([
      { SessionStorage: { MountPath: '/mnt/session' } },
      { EfsAccessPoint: { AccessPointArn: 'arn:efs', MountPath: '/mnt/efs' } },
    ]);
    expect(result['CapacityProviderConfiguration']).toEqual({ CapacityProviderArn: 'arn:cp' });
    expect(result['PlatformVersion']).toBe('1.0');
    // Tag keys verbatim (no case flip), in the template's map shape.
    expect(result['Tags']).toEqual({ Env: 'dev', lowerKey: 'v' });
  });

  it('emits an empty Tags map for an untagged runtime, and rejects when the tag read is denied (go-to-k/cdkd#6759)', async () => {
    const base = {
      agentRuntimeId: 'runtime-1',
      agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/runtime-1',
      agentRuntimeName: 'my-runtime',
      roleArn: 'arn:aws:iam::123:role/runtime',
    };
    mockSend.mockResolvedValueOnce(base).mockResolvedValueOnce({});
    const untagged = (await provider.readCurrentState(
      'runtime-1',
      'Logical',
      'AWS::BedrockAgentCore::Runtime'
    )) as Record<string, unknown>;
    expect(untagged['Tags']).toEqual({});

    mockSend
      .mockResolvedValueOnce(base)
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(
      provider.readCurrentState('runtime-1', 'Logical', 'AWS::BedrockAgentCore::Runtime')
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });

  it('returns RESOURCE_NOT_FOUND when runtime gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'runtime-1',
      'Logical',
      'AWS::BedrockAgentCore::Runtime'
    );
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('still rethrows a non-NotFound GetAgentRuntime error', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    );

    await expect(
      provider.readCurrentState('runtime-1', 'Logical', 'AWS::BedrockAgentCore::Runtime')
    ).rejects.toThrow('denied');
  });

  it('emits empty Description placeholder when AWS returns empty string', async () => {
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: 'runtime-1',
      agentRuntimeName: 'my-runtime',
      roleArn: 'arn:aws:iam::123:role/runtime',
      description: '',
    });
    const result = (await provider.readCurrentState(
      'runtime-1',
      'Logical',
      'AWS::BedrockAgentCore::Runtime'
    )) as Record<string, unknown> | undefined;
    expect(result?.Description).toBe('');
  });
});
