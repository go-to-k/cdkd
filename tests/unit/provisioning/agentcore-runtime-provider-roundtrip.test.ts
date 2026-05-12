import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';

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

const RUNTIME_ID = 'runtime-12345';
const RESOURCE_TYPE = 'AWS::BedrockAgentCore::Runtime';

describe('AgentCoreRuntimeProvider read-update round-trip', () => {
  let provider: AgentCoreRuntimeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentCoreRuntimeProvider();
  });

  it('round-trip: readCurrentState placeholders survive update() without AWS-invalid inputs', async () => {
    // Mechanical guard for the 3 latent bug classes documented in
    // docs/provider-development.md § 3b "Read-update round-trip test".
    //
    //   - Truthy gate: empty Description ('') from readCurrentState
    //     must reach UpdateAgentRuntime input (the field is optional,
    //     and AWS accepts '' as the clear-the-description form).
    //   - Class 1: agentcore has no top-level discriminator-dependent
    //     properties — every top-level CFn key is independent. The
    //     check below documents that intent: no FIFO-style
    //     discriminator-only attribute should sneak into update input.
    //   - Class 2: no top-level placeholder is an empty-object /
    //     empty-array shape AWS would structurally reject. The
    //     LifecycleConfiguration empty-object guard in update() (lines
    //     269-274) is verified explicitly below.

    // Step 1: produce an observed snapshot via readCurrentState.
    // AWS-minimum response: required fields only; optionals undefined
    // except Description which AWS surfaced as ''. This matches the
    // shape readCurrentState emits in `agentcore-runtime-provider-
    // readcurrentstate.test.ts`.
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: RUNTIME_ID,
      agentRuntimeName: 'my-runtime',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      description: '',
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest',
        },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
    });

    const observed = await provider.readCurrentState(RUNTIME_ID, 'L', RESOURCE_TYPE);

    // Spot-check Description placeholder reached observed (truthy-gate
    // contract: '' must NOT be dropped on the read side).
    expect(observed?.Description).toBe('');

    // Step 2: round-trip observed back through update().
    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: RUNTIME_ID,
      agentRuntimeArn: `arn:aws:bedrock-agentcore:us-east-1:123:runtime/${RUNTIME_ID}`,
      agentRuntimeVersion: '2',
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
      status: 'READY',
    });

    await provider.update('L', RUNTIME_ID, RESOURCE_TYPE, observed!, observed!);

    // Step 3: assertions.
    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateAgentRuntimeCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as Record<string, unknown>;

    // Truthy-gate: empty Description must reach AWS as '' (not dropped,
    // not coerced). Verifies `if (properties['Description'] !==
    // undefined)` in update() is honoured on the round-trip path.
    expect(input['description']).toBe('');

    // Class 1 sentinel: agentcore has no top-level discriminator-only
    // attributes. If a future PR adds one (mirroring SQS
    // DeduplicationScope or SNS FifoThroughputScope), this test will
    // need to be updated to assert that the discriminator-false
    // placeholder doesn't appear in update input. For now, document
    // the absence by asserting the input only contains keys the
    // provider's update() actually maps.
    const allowedKeys = new Set([
      'agentRuntimeId',
      'roleArn',
      'agentRuntimeArtifact',
      'networkConfiguration',
      'description',
      'authorizerConfiguration',
      'protocolConfiguration',
      'lifecycleConfiguration',
      'environmentVariables',
      'clientToken',
    ]);
    for (const key of Object.keys(input)) {
      expect(allowedKeys.has(key)).toBe(true);
    }

    // Class 2 sentinel: no empty-object placeholder should ride along.
    // The two structurally-rejecting candidates on agentcore are
    // LifecycleConfiguration ({} drops idleRuntimeSessionTimeout /
    // maxLifetime) and NetworkConfiguration ({} drops the required
    // networkMode). A clean snapshot with networkMode set must NOT
    // produce an empty-object NetworkConfiguration; LifecycleConfig
    // omitted from the snapshot must NOT appear as {} in input.
    if (input['lifecycleConfiguration'] !== undefined) {
      expect(
        Object.keys(input['lifecycleConfiguration'] as Record<string, unknown>).length
      ).toBeGreaterThan(0);
    }
    if (input['networkConfiguration'] !== undefined) {
      const nc = input['networkConfiguration'] as Record<string, unknown>;
      expect(nc['networkMode']).toBeDefined();
    }
  });

  it('Class 2 — empty LifecycleConfiguration ({}) is NOT forwarded to UpdateAgentRuntime', async () => {
    // Even if a downstream caller hands update() an empty
    // LifecycleConfiguration object (e.g. from a CFn template `{}`), the
    // update() guard at lines 269-274 must keep it out of input.
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: RUNTIME_ID,
      agentRuntimeArn: `arn:aws:bedrock-agentcore:us-east-1:123:runtime/${RUNTIME_ID}`,
      agentRuntimeVersion: '2',
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
      status: 'READY',
    });

    await provider.update(
      'L',
      RUNTIME_ID,
      RESOURCE_TYPE,
      {
        AgentRuntimeName: 'my-runtime',
        RoleArn: 'arn:aws:iam::123456789012:role/my-role',
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest',
          },
        },
        NetworkConfiguration: { NetworkMode: 'PUBLIC' },
        LifecycleConfiguration: {},
      },
      {}
    );

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateAgentRuntimeCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as Record<string, unknown>;
    expect(input['lifecycleConfiguration']).toBeUndefined();
  });

  it('truthy-gate — empty-string Description from observedProperties reaches UpdateAgentRuntime as ""', async () => {
    // Direct guard: the IAM-Role-style "use !== undefined, not truthy"
    // contract must hold so `cdkd drift --revert` can clear an
    // AWS-side description by pushing '' back.
    mockSend.mockResolvedValueOnce({
      agentRuntimeId: RUNTIME_ID,
      agentRuntimeArn: `arn:aws:bedrock-agentcore:us-east-1:123:runtime/${RUNTIME_ID}`,
      agentRuntimeVersion: '2',
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
      status: 'READY',
    });

    await provider.update(
      'L',
      RUNTIME_ID,
      RESOURCE_TYPE,
      {
        AgentRuntimeName: 'my-runtime',
        RoleArn: 'arn:aws:iam::123456789012:role/my-role',
        Description: '',
      },
      {
        AgentRuntimeName: 'my-runtime',
        RoleArn: 'arn:aws:iam::123456789012:role/my-role',
        Description: 'old description',
      }
    );

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateAgentRuntimeCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as Record<string, unknown>;
    expect(input['description']).toBe('');
  });
});
