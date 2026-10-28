import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#5433: the PascalCase -> camelCase flip must stop at a
// user-keyed map. A `ManagedVpcResource.Tags` key `Env` went out as `env`, so
// the Lattice resource gateway was tagged with a key the template never
// declared; the readback flip upper-cased a lower-case key the other way.
// Every map key below is one a first-letter flip would change (or a hyphen /
// colon key that pins verbatim copying).

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

const RESOURCE_TYPE = 'AWS::BedrockAgentCore::Runtime';

const TAGS = { Env: 'prod', 'Cost-Center': '42', lowerKey: 'v', 'team:owner': 'x' };
const OVERRIDE_TAGS = { Name: 'override', 'aws-region': 'us-east-1' };
const SCOPE_MAP = { 'Read-Scope': 'agent:read', writeScope: 'agent:write' };
const ENV = { LOG_LEVEL: 'debug', lowerVar: 'a', 'Mixed-Var': 'b' };

/** The template shape (CFn PascalCase members, user-keyed map contents). */
const CFN_AUTHORIZER = {
  CustomJWTAuthorizer: {
    DiscoveryUrl: 'https://example.com/.well-known/openid-configuration',
    AllowedClients: ['c'],
    AdvertisedScopeMapping: SCOPE_MAP,
    PrivateEndpoint: {
      ManagedVpcResource: {
        VpcIdentifier: 'vpc-1',
        SubnetIds: ['subnet-1'],
        EndpointIpAddressType: 'IPV4',
        Tags: TAGS,
      },
    },
    PrivateEndpointOverrides: [
      {
        Domain: 'idp.example.com',
        PrivateEndpoint: {
          ManagedVpcResource: {
            VpcIdentifier: 'vpc-2',
            SubnetIds: ['subnet-2'],
            EndpointIpAddressType: 'IPV4',
            Tags: OVERRIDE_TAGS,
          },
        },
      },
    ],
  },
};

/** The SDK shape: every member camel-cased, every map key byte-identical. */
const SDK_AUTHORIZER = {
  customJWTAuthorizer: {
    discoveryUrl: 'https://example.com/.well-known/openid-configuration',
    allowedClients: ['c'],
    advertisedScopeMapping: SCOPE_MAP,
    privateEndpoint: {
      managedVpcResource: {
        vpcIdentifier: 'vpc-1',
        subnetIds: ['subnet-1'],
        endpointIpAddressType: 'IPV4',
        tags: TAGS,
      },
    },
    privateEndpointOverrides: [
      {
        domain: 'idp.example.com',
        privateEndpoint: {
          managedVpcResource: {
            vpcIdentifier: 'vpc-2',
            subnetIds: ['subnet-2'],
            endpointIpAddressType: 'IPV4',
            tags: OVERRIDE_TAGS,
          },
        },
      },
    ],
  },
};

const PROPERTIES = {
  AgentRuntimeName: 'my_runtime',
  RoleArn: 'arn:aws:iam::123456789012:role/my-role',
  AgentRuntimeArtifact: {
    ContainerConfiguration: { ContainerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest' },
  },
  NetworkConfiguration: { NetworkMode: 'PUBLIC' },
  AuthorizerConfiguration: CFN_AUTHORIZER,
  EnvironmentVariables: ENV,
};

describe('AgentCoreRuntimeProvider user-keyed map keys (issue #5433)', () => {
  let provider: AgentCoreRuntimeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentCoreRuntimeProvider();
  });

  it('create sends map keys verbatim while flipping the member names', async () => {
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: 'runtime-1',
      agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/runtime-1',
    });

    await provider.create('MyRuntime', RESOURCE_TYPE, PROPERTIES);

    const input = mockSend.mock.calls[0][0].input;
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateAgentRuntimeCommand');
    expect(input.authorizerConfiguration).toEqual(SDK_AUTHORIZER);
    expect(Object.keys(input.authorizerConfiguration.customJWTAuthorizer.privateEndpoint.managedVpcResource.tags)).toEqual(
      ['Env', 'Cost-Center', 'lowerKey', 'team:owner']
    );
    expect(input.environmentVariables).toEqual(ENV);
  });

  it('update sends map keys verbatim while flipping the member names', async () => {
    mockSend.mockResolvedValueOnce({ agentRuntimeId: 'runtime-1', status: 'UPDATING' });

    await provider.update('MyRuntime', 'runtime-1', RESOURCE_TYPE, PROPERTIES, PROPERTIES);

    const input = mockSend.mock.calls[0][0].input;
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('UpdateAgentRuntimeCommand');
    expect(input.authorizerConfiguration).toEqual(SDK_AUTHORIZER);
    expect(input.environmentVariables).toEqual(ENV);
  });

  it('readback returns map keys verbatim, so the template shape round-trips with no drift', async () => {
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: 'runtime-1',
      agentRuntimeName: 'my_runtime',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest' },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      authorizerConfiguration: SDK_AUTHORIZER,
      environmentVariables: ENV,
    });

    const result = (await provider.readCurrentState('runtime-1', 'MyRuntime', RESOURCE_TYPE)) as Record<
      string,
      unknown
    >;

    expect(result['AuthorizerConfiguration']).toEqual(CFN_AUTHORIZER);
    expect(result['EnvironmentVariables']).toEqual(ENV);
    expect(result['AgentRuntimeArtifact']).toEqual(PROPERTIES.AgentRuntimeArtifact);
    expect(result['NetworkConfiguration']).toEqual(PROPERTIES.NetworkConfiguration);
  });
});
