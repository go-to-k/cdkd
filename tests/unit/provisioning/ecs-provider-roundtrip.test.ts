import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// These cases pin the wire shape, not the steady-state wait the default runs
// (go-to-k/cdkd#5571; ecs-service-full-wait.test.ts owns the wait): --no-wait
// keeps the waiter and the pre-create name probe out of them.
beforeEach(() => {
  process.env['CDKD_NO_WAIT'] = 'true';
});
afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
});
import {
  PutClusterCapacityProvidersCommand,
  UpdateClusterCommand,
  UpdateServiceCommand,
  RegisterTaskDefinitionCommand,
  DeregisterTaskDefinitionCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-ecs';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ECSClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';

const CLUSTER_NAME = 'my-cluster';
const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123:cluster/my-cluster';
const SERVICE_PHYSICAL_ID = `${CLUSTER_ARN}|my-svc`;
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123:service/my-cluster/my-svc';
const TD_ARN = 'arn:aws:ecs:us-east-1:123:task-definition/my-td:1';

/** Mutating commands we want to assert never fire on a no-drift round-trip. */
function mutatingSends(): unknown[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter(
      (cmd) =>
        cmd instanceof PutClusterCapacityProvidersCommand ||
        cmd instanceof UpdateClusterCommand ||
        cmd instanceof UpdateServiceCommand ||
        cmd instanceof RegisterTaskDefinitionCommand ||
        cmd instanceof DeregisterTaskDefinitionCommand ||
        cmd instanceof TagResourceCommand ||
        cmd instanceof UntagResourceCommand
    );
}

describe('ECSProvider read-update round-trip', () => {
  let provider: ECSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECSProvider();
  });

  // ─── AWS::ECS::Cluster ─────────────────────────────────────────

  it('Cluster: no-drift round-trip is a logical no-op (no PutClusterCapacityProviders, no Tag* mutation)', async () => {
    // Diff-based providers must produce zero AWS-side mutations when
    // state == AWS: PutClusterCapacityProviders is sent only when the
    // providers or the default strategy changed (go-to-k/cdkd#6562).
    const observed = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: ['FARGATE'],
      DefaultCapacityProviderStrategy: [
        { capacityProvider: 'FARGATE', weight: 1, base: 0 },
      ] as Array<Record<string, unknown>>,
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
      Tags: [{ Key: 'env', Value: 'prod' }],
    };

    // Mock: DescribeClusters (for ARN) — no Put: the providers are unchanged (#6562).
    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN, clusterName: CLUSTER_NAME }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', observed, observed);

    // Tag* must NOT fire — old/new tags identical (no diff).
    const tagSends = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagSends).toHaveLength(0);
    expect(mutatingSends()).toHaveLength(0);
  });

  it('Cluster: ClusterSettings change fires UpdateClusterCommand with new settings', async () => {
    // Console-side enable of containerInsights → cdkd drift --revert
    // must round-trip via UpdateClusterCommand. Pre-PR the update path
    // ignored ClusterSettings entirely.
    const prev = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: ['FARGATE'],
      DefaultCapacityProviderStrategy: [
        { capacityProvider: 'FARGATE', weight: 1, base: 0 },
      ] as Array<Record<string, unknown>>,
      ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
      Tags: [],
    };
    const next = {
      ...prev,
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enhanced' }],
    };

    // Mock: UpdateCluster → DescribeClusters (no Put: providers unchanged, #6562).
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN, clusterName: CLUSTER_NAME }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', next, prev);

    const updates = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateClusterCommand
    );
    expect(updates).toHaveLength(1);
    const input = updates[0]![0].input as {
      cluster?: string;
      settings?: Array<{ name: string; value?: string }>;
      configuration?: unknown;
    };
    expect(input.cluster).toBe(CLUSTER_NAME);
    expect(input.settings).toEqual([{ name: 'containerInsights', value: 'enhanced' }]);
    // configuration is omitted (unchanged) — must NOT appear in input.
    expect(input.configuration).toBeUndefined();
  });

  it('Cluster: Configuration change fires UpdateClusterCommand with new configuration', async () => {
    // Nested config change (e.g. ExecuteCommandConfiguration.Logging) on
    // an otherwise unchanged cluster. Mirrors how a console-side enable
    // of execute-command logging round-trips.
    const prev = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: [],
      DefaultCapacityProviderStrategy: [],
      ClusterSettings: [],
      Tags: [],
    };
    const next = {
      ...prev,
      Configuration: {
        executeCommandConfiguration: {
          logging: 'OVERRIDE',
          logConfiguration: {
            cloudWatchLogGroupName: '/aws/ecs/cluster',
            cloudWatchEncryptionEnabled: true,
          },
        },
      },
    };

    mockSend.mockResolvedValueOnce({}); // UpdateClusterCommand
    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN, clusterName: CLUSTER_NAME }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', next, prev);

    const updates = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateClusterCommand
    );
    expect(updates).toHaveLength(1);
    const input = updates[0]![0].input as {
      configuration?: { executeCommandConfiguration?: { logging?: string } };
      settings?: unknown;
    };
    expect(input.configuration?.executeCommandConfiguration?.logging).toBe('OVERRIDE');
    // settings is omitted (unchanged) — must NOT appear in input.
    expect(input.settings).toBeUndefined();
  });

  it('Cluster: ServiceConnectDefaults change fires UpdateClusterCommand with new namespace', async () => {
    const prev = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: [],
      DefaultCapacityProviderStrategy: [],
      ClusterSettings: [],
      Tags: [],
    };
    const next = {
      ...prev,
      ServiceConnectDefaults: {
        Namespace: 'arn:aws:servicediscovery:us-east-1:0:namespace/ns-foo',
      },
    };

    mockSend.mockResolvedValueOnce({}); // UpdateClusterCommand
    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN, clusterName: CLUSTER_NAME }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', next, prev);

    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateClusterCommand);
    expect(updates).toHaveLength(1);
    const input = updates[0]![0].input as {
      serviceConnectDefaults?: { namespace?: string };
      settings?: unknown;
      configuration?: unknown;
    };
    expect(input.serviceConnectDefaults).toEqual({
      namespace: 'arn:aws:servicediscovery:us-east-1:0:namespace/ns-foo',
    });
    expect(input.settings).toBeUndefined();
    expect(input.configuration).toBeUndefined();
  });

  it('Cluster: ServiceConnectDefaults removal sends namespace="" sentinel to clear', async () => {
    // AWS UpdateCluster docs: passing `serviceConnectDefaults: { namespace: '' }`
    // is the sentinel that clears the cluster's default Service Connect
    // namespace. When the user removes the property from their template,
    // the diff must trigger that clear (otherwise "absent" is silently
    // treated as no-op and the cluster keeps the old default).
    const prev = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: [],
      DefaultCapacityProviderStrategy: [],
      ClusterSettings: [],
      ServiceConnectDefaults: {
        Namespace: 'arn:aws:servicediscovery:us-east-1:0:namespace/ns-foo',
      },
      Tags: [],
    };
    const next = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: [],
      DefaultCapacityProviderStrategy: [],
      ClusterSettings: [],
      Tags: [],
    };

    mockSend.mockResolvedValueOnce({}); // UpdateClusterCommand
    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN, clusterName: CLUSTER_NAME }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', next, prev);

    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateClusterCommand);
    expect(updates).toHaveLength(1);
    const input = updates[0]![0].input as { serviceConnectDefaults?: { namespace?: string } };
    expect(input.serviceConnectDefaults).toEqual({ namespace: '' });
  });

  it('Cluster: no ServiceConnectDefaults diff → not in UpdateClusterCommand input', async () => {
    const observed = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: [],
      DefaultCapacityProviderStrategy: [],
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
      ServiceConnectDefaults: {
        Namespace: 'arn:aws:servicediscovery:us-east-1:0:namespace/ns-foo',
      },
      Tags: [],
    };
    const next = {
      ...observed,
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enhanced' }],
    };

    mockSend.mockResolvedValueOnce({}); // UpdateClusterCommand
    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN, clusterName: CLUSTER_NAME }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', next, observed);

    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateClusterCommand);
    expect(updates).toHaveLength(1);
    const input = updates[0]![0].input as {
      serviceConnectDefaults?: unknown;
      settings?: unknown;
    };
    // settings did change → present; serviceConnectDefaults did not change → absent.
    expect(input.settings).toBeDefined();
    expect(input.serviceConnectDefaults).toBeUndefined();
  });

  it('Cluster: no Settings/Configuration diff → no UpdateClusterCommand', async () => {
    // No-diff no-op guard for the new code path. State == AWS for
    // ClusterSettings + Configuration must NOT issue UpdateClusterCommand
    // and, since go-to-k/cdkd#6562, no PutClusterCapacityProviders either.
    const observed = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: ['FARGATE'],
      DefaultCapacityProviderStrategy: [
        { capacityProvider: 'FARGATE', weight: 1, base: 0 },
      ] as Array<Record<string, unknown>>,
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
      Configuration: {
        executeCommandConfiguration: { logging: 'DEFAULT' },
      },
      Tags: [],
    };

    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN, clusterName: CLUSTER_NAME }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', observed, observed);

    const updates = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateClusterCommand
    );
    expect(updates).toHaveLength(0);
  });

  // ─── AWS::ECS::Service (Fargate) ───────────────────────────────

  it('Service Fargate: round-trip preserves PlatformVersion; no Class 1 PlacementStrategy / CapacityProviderStrategy in update input', async () => {
    // Class 1 round-trip guard. On a Fargate service:
    //   - PlacementStrategy is EC2-only — AWS rejects
    //     `placementStrategy: []` with "Placement strategies are not
    //     valid for tasks using the Fargate launch type."
    //   - CapacityProviderStrategy is mutually exclusive with
    //     LaunchType — AWS rejects when both are set.
    // readCurrentState must NOT emit those placeholders, so the
    // round-trip update() input must not carry them either.
    const observed = {
      ServiceName: 'my-svc',
      Cluster: CLUSTER_ARN,
      TaskDefinition: TD_ARN,
      DesiredCount: 2,
      LaunchType: 'FARGATE',
      PlatformVersion: '1.4.0',
      EnableExecuteCommand: true,
      LoadBalancers: [],
      PlacementConstraints: [],
      ServiceRegistries: [],
      Tags: [{ Key: 'env', Value: 'prod' }],
    };

    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-svc' },
    });

    await provider.update(
      'L',
      SERVICE_PHYSICAL_ID,
      'AWS::ECS::Service',
      observed,
      observed
    );

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateServiceCommand
    );
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0]![0].input as {
      placementStrategy?: unknown;
      capacityProviderStrategy?: unknown;
      platformVersion?: unknown;
    };
    // PlatformVersion must be preserved (Fargate-only field that the
    // round-trip should NOT silently drop).
    expect(input.platformVersion).toBe('1.4.0');
    // Class 1: omitted on Fargate via discriminator-gated readCurrentState
    // (so observed snapshot has no PlacementStrategy / CapacityProviderStrategy
    // key, and update() forwards undefined).
    expect(input.placementStrategy).toBeUndefined();
    expect(input.capacityProviderStrategy).toBeUndefined();
  });

  it('Service Fargate readCurrentState: PlacementStrategy / CapacityProviderStrategy not emitted', async () => {
    // Read-side assertion for Class 1 discriminator gate. Mirrors
    // ecs-provider-readcurrentstate.test.ts but specifically guards the
    // Fargate-discriminator behavior we rely on for the round-trip
    // safety above.
    mockSend.mockResolvedValueOnce({
      services: [
        {
          serviceName: 'my-svc',
          clusterArn: CLUSTER_ARN,
          taskDefinition: TD_ARN,
          launchType: 'FARGATE',
          platformVersion: '1.4.0',
        },
      ],
    });

    const result = (await provider.readCurrentState(
      SERVICE_PHYSICAL_ID,
      'L',
      'AWS::ECS::Service'
    )) as Record<string, unknown> | undefined;

    expect(result).not.toBeUndefined();
    expect(Object.keys(result!)).not.toContain('PlacementStrategy');
    expect(Object.keys(result!)).not.toContain('CapacityProviderStrategy');
    expect(result!['PlatformVersion']).toBe('1.4.0');
  });

  // ─── AWS::ECS::Service (EC2) ───────────────────────────────────

  it('Service EC2 readCurrentState: PlacementStrategy emitted, PlatformVersion absent', async () => {
    // Complement of the Fargate gate. On EC2, PlacementStrategy IS
    // valid input — readCurrentState should surface it (defaulting to
    // []) so a console-side change to placement strategies fires
    // drift. PlatformVersion is Fargate-only; AWS won't return it for
    // EC2 services.
    mockSend.mockResolvedValueOnce({
      services: [
        {
          serviceName: 'my-svc',
          clusterArn: CLUSTER_ARN,
          taskDefinition: TD_ARN,
          launchType: 'EC2',
          placementStrategy: [{ type: 'spread', field: 'instanceId' }],
        },
      ],
    });

    const result = (await provider.readCurrentState(
      SERVICE_PHYSICAL_ID,
      'L',
      'AWS::ECS::Service'
    )) as Record<string, unknown> | undefined;

    expect(result).not.toBeUndefined();
    // issue #1167: readCurrentState reverse-maps SDK camelCase -> CFn PascalCase
    // so the drift baseline (state properties, PascalCase) compares cleanly.
    expect(result!['PlacementStrategy']).toEqual([
      { Type: 'spread', Field: 'instanceId' },
    ]);
    expect(Object.keys(result!)).not.toContain('PlatformVersion');
  });

  it('Service EC2 round-trip preserves PlacementStrategy in UpdateService input', async () => {
    // The complement of the Fargate test: an EC2 service legitimately
    // has PlacementStrategy (legacy state key) and round-tripping should
    // NOT drop it. update() reads both `PlacementStrategies` (the new
    // CFn-canonical name; see #613 B-bucket fix) and `PlacementStrategy`
    // (the legacy state-file key emitted by readCurrentState).
    const observed = {
      ServiceName: 'my-svc',
      Cluster: CLUSTER_ARN,
      TaskDefinition: TD_ARN,
      DesiredCount: 2,
      LaunchType: 'EC2',
      // issue #1167: readCurrentState now emits PascalCase; update() converts
      // it back to the SDK camelCase shape (asserted below).
      PlacementStrategy: [{ Type: 'spread', Field: 'instanceId' }],
      EnableExecuteCommand: false,
      LoadBalancers: [],
      PlacementConstraints: [],
      ServiceRegistries: [],
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-svc' },
    });

    await provider.update(
      'L',
      SERVICE_PHYSICAL_ID,
      'AWS::ECS::Service',
      observed,
      observed
    );

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateServiceCommand
    );
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0]![0].input as { placementStrategy?: unknown };
    expect(input.placementStrategy).toEqual([
      { type: 'spread', field: 'instanceId' },
    ]);
  });

  // ─── AWS::ECS::TaskDefinition ──────────────────────────────────

  it('TaskDefinition no-drift round-trip: resolves with zero mutating SDK calls', async () => {
    // Only Tags is updatable in place (issue #5392); with nothing moved
    // the update resolves on the recorded revision and sends nothing.
    const observed = {
      Family: 'my-td',
      Cpu: '256',
      Memory: '512',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
      ContainerDefinitions: [{ Name: 'app', Image: 'nginx:latest' }],
      Volumes: [],
      PlacementConstraints: [],
      Tags: [],
    };

    await expect(
      provider.update('L', TD_ARN, 'AWS::ECS::TaskDefinition', observed, observed)
    ).resolves.toMatchObject({ physicalId: TD_ARN, wasReplaced: false });

    expect(mutatingSends()).toHaveLength(0);
  });

  it('TaskDefinition.update refuses a drift outside Tags (revisions are immutable); no AWS calls', async () => {
    // Every other property change registers a new revision whose ARN
    // differs from cdkd state's physicalId. Routing through
    // `cdkd drift --revert` would silently swap physicalId for a
    // freshly-registered revision and deregister the previous one, so
    // the only safe outcome is a clear error.
    const observed = {
      Family: 'my-td',
      Cpu: '256',
      Memory: '512',
      ContainerDefinitions: [{ Name: 'app', Image: 'nginx:latest' }],
      Tags: [],
    };

    await expect(
      provider.update(
        'L',
        TD_ARN,
        'AWS::ECS::TaskDefinition',
        { ...observed, Memory: '1024' },
        observed
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    expect(mutatingSends()).toHaveLength(0);
  });

  // go-to-k/cdkd#6301: TrustedExecutionConfiguration on the SDK route.
  const TEC_TEMPLATE = {
    Family: 'my-td',
    Memory: '512',
    NetworkMode: 'awsvpc',
    RequiresCompatibilities: ['MANAGED_INSTANCES'],
    ContainerDefinitions: [{ Name: 'app', Image: 'nginx:latest' }],
    TrustedExecutionConfiguration: {
      IsolationMode: 'CONFIDENTIAL_SANDBOX',
      AttestationPolicy: 'eyJwb2xpY3kiOiJ4In0=',
    },
  };

  it('TaskDefinition.create sends TrustedExecutionConfiguration in the SDK camelCase shape', async () => {
    mockSend.mockResolvedValueOnce({ taskDefinition: { taskDefinitionArn: TD_ARN } });

    await provider.create('L', 'AWS::ECS::TaskDefinition', TEC_TEMPLATE);

    const register = mockSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd instanceof RegisterTaskDefinitionCommand);
    expect(register).toHaveLength(1);
    expect(register[0].input.trustedExecutionConfiguration).toEqual({
      isolationMode: 'CONFIDENTIAL_SANDBOX',
      attestationPolicy: 'eyJwb2xpY3kiOiJ4In0=',
    });
  });

  it('TaskDefinition.create omits trustedExecutionConfiguration when the template does not declare it', async () => {
    mockSend.mockResolvedValueOnce({ taskDefinition: { taskDefinitionArn: TD_ARN } });
    const { TrustedExecutionConfiguration: _omitted, ...withoutTec } = TEC_TEMPLATE;

    await provider.create('L', 'AWS::ECS::TaskDefinition', withoutTec);

    const register = mockSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd instanceof RegisterTaskDefinitionCommand);
    expect(register).toHaveLength(1);
    expect(register[0].input.trustedExecutionConfiguration).toBeUndefined();
  });

  it.each([
    ['a string', 'ISOLATED_SANDBOX', 'string'],
    ['an array', [{ IsolationMode: 'SHARED' }], 'an array'],
  ])(
    'TaskDefinition.create refuses %s TrustedExecutionConfiguration before any AWS call',
    async (_label, value, named) => {
      await expect(
        provider.create('L', 'AWS::ECS::TaskDefinition', {
          ...TEC_TEMPLATE,
          TrustedExecutionConfiguration: value,
        })
      ).rejects.toThrow(`TrustedExecutionConfiguration must be an object, got ${named}`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('TaskDefinition.update refuses a plain IsolationMode change; no mutating call', async () => {
    const recorded = { ...TEC_TEMPLATE, Tags: [{ Key: 'k', Value: 'v1' }] };
    await expect(
      provider.update(
        'L',
        TD_ARN,
        'AWS::ECS::TaskDefinition',
        {
          ...recorded,
          TrustedExecutionConfiguration: {
            ...TEC_TEMPLATE.TrustedExecutionConfiguration,
            IsolationMode: 'ISOLATED_SANDBOX',
          },
        },
        recorded
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mutatingSends()).toHaveLength(0);
  });

  it('TaskDefinition.update with an unchanged TrustedExecutionConfiguration tags in place only', async () => {
    const recorded = {
      ...TEC_TEMPLATE,
      Tags: [
        { Key: 'k', Value: 'v1' },
        { Key: 'gone', Value: 'x' },
      ],
    };
    await expect(
      provider.update(
        'L',
        TD_ARN,
        'AWS::ECS::TaskDefinition',
        { ...TEC_TEMPLATE, Tags: [{ Key: 'k', Value: 'v2' }] },
        recorded
      )
    ).resolves.toMatchObject({ physicalId: TD_ARN, wasReplaced: false });
    const sent = mutatingSends();
    expect(sent.length).toBeGreaterThan(0);
    expect(
      sent.every((cmd) => cmd instanceof TagResourceCommand || cmd instanceof UntagResourceCommand)
    ).toBe(true);
    expect(sent.some((cmd) => cmd instanceof TagResourceCommand)).toBe(true);
    expect(sent.some((cmd) => cmd instanceof UntagResourceCommand)).toBe(true);
  });

  describe('TaskDefinition.update with a secret-derived AttestationPolicy', () => {
    // The desired side arrives RESOLVED, so a masker comparison cannot tell an
    // unchanged reference from a move to another one: both are refused.
    const PLAIN_A = 'eyJwb2xpY3kiOiJhIn0=';
    const PLAIN_B = 'eyJwb2xpY3kiOiJiIn0=';
    const recorded = {
      ...TEC_TEMPLATE,
      TrustedExecutionConfiguration: {
        IsolationMode: 'CONFIDENTIAL_SANDBOX',
        AttestationPolicy: '{{resolve:secretsmanager:policy-a}}',
      },
      Tags: [{ Key: 'k', Value: 'v1' }],
    };
    const desired = (plain: string) => ({
      ...TEC_TEMPLATE,
      TrustedExecutionConfiguration: { IsolationMode: 'CONFIDENTIAL_SANDBOX', AttestationPolicy: plain },
      Tags: [{ Key: 'k', Value: 'v2' }],
    });
    const maskSecrets = (t: string) => t.replaceAll(PLAIN_A, '***').replaceAll(PLAIN_B, '***');

    it.each([
      ['the same reference (a Tags-only change)', PLAIN_A],
      ['a move to another reference', PLAIN_B],
    ])('%s is refused with no mutating call', async (_label, plain) => {
      await expect(
        provider.update('L', TD_ARN, 'AWS::ECS::TaskDefinition', desired(plain), recorded, {
          maskSecrets,
        })
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(mutatingSends()).toHaveLength(0);
    });
  });

  it('TaskDefinition readCurrentState: a TrustedExecutionConfiguration AWS returns reads back in the template shape', async () => {
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'my-td',
        status: 'ACTIVE',
        memory: '512',
        networkMode: 'awsvpc',
        requiresCompatibilities: ['MANAGED_INSTANCES'],
        containerDefinitions: [{ name: 'app', image: 'nginx:latest' }],
        trustedExecutionConfiguration: {
          isolationMode: 'CONFIDENTIAL_SANDBOX',
          attestationPolicy: 'eyJwb2xpY3kiOiJ4In0=',
        },
      },
      tags: [],
    });

    const result = (await provider.readCurrentState(
      TD_ARN,
      'L',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown>;

    expect(result['TrustedExecutionConfiguration']).toEqual(
      TEC_TEMPLATE.TrustedExecutionConfiguration
    );
  });

  it('TaskDefinition readCurrentState: no TrustedExecutionConfiguration key when AWS returns none', async () => {
    // Measured: a registration that omits the block reads back without it.
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'my-td',
        status: 'ACTIVE',
        requiresCompatibilities: ['MANAGED_INSTANCES'],
        containerDefinitions: [{ name: 'app', image: 'nginx:latest' }],
      },
      tags: [],
    });

    const result = (await provider.readCurrentState(
      TD_ARN,
      'L',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown>;

    expect(result).toBeDefined();
    expect(Object.keys(result)).not.toContain('TrustedExecutionConfiguration');
  });

  // ─── State == AWS produces zero mutating calls ─────────────────

  it('Cluster no-drift round-trip: zero mutating SDK calls', async () => {
    // Stronger structural guard: on a no-drift round-trip, the only
    // SDK calls allowed are reads. Since go-to-k/cdkd#6562 that includes
    // PutClusterCapacityProviders: unchanged providers send none.
    const observed = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: [],
      DefaultCapacityProviderStrategy: [],
      ClusterSettings: [],
      Tags: [{ Key: 'env', Value: 'prod' }],
    };

    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', observed, observed);

    // No Tag* mutation on a no-drift run.
    const tagMutations = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagMutations).toHaveLength(0);

    // Sanity: only the ARN Describe was issued.
    expect(mockSend.mock.calls.length).toBe(1);
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DescribeClustersCommand);
  });

  it('Service no-drift round-trip: no Tag* mutation, single UpdateService + Describe', async () => {
    const observed = {
      ServiceName: 'my-svc',
      Cluster: CLUSTER_ARN,
      TaskDefinition: TD_ARN,
      DesiredCount: 1,
      LaunchType: 'FARGATE',
      PlatformVersion: 'LATEST',
      LoadBalancers: [],
      PlacementConstraints: [],
      ServiceRegistries: [],
      Tags: [{ Key: 'env', Value: 'prod' }],
    };

    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-svc' },
    });

    await provider.update(
      'L',
      SERVICE_PHYSICAL_ID,
      'AWS::ECS::Service',
      observed,
      observed
    );

    const tagMutations = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagMutations).toHaveLength(0);

    // Update path issues a single UpdateServiceCommand. The provider
    // does NOT issue a separate DescribeServices on update — it reads
    // the ARN from the UpdateService response.
    const updates = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateServiceCommand
    );
    expect(updates).toHaveLength(1);
    const describes = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DescribeServicesCommand
    );
    expect(describes).toHaveLength(0);
  });

  it('Service no-drift round-trip with the #609 read-back additions: none of the new members re-sent', async () => {
    // Shape of a readCurrentState snapshot after issue #609: the reader emits
    // AvailabilityZoneRebalancing verbatim and DeploymentController always
    // ({Type: 'ECS'} fallback when DescribeServices omits it for the default
    // controller). Feeding it back as both sides must NOT send any of the
    // change-gated new members — a spurious re-send of a
    // deployment-triggering blob would start a rollout on a no-op update.
    const observed = {
      ServiceName: 'my-svc',
      Cluster: CLUSTER_ARN,
      TaskDefinition: TD_ARN,
      DesiredCount: 1,
      LaunchType: 'FARGATE',
      AvailabilityZoneRebalancing: 'ENABLED',
      DeploymentController: { Type: 'ECS' },
      LoadBalancers: [],
      PlacementConstraints: [],
      ServiceRegistries: [],
      Tags: [],
    };

    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-svc' },
    });

    await provider.update('L', SERVICE_PHYSICAL_ID, 'AWS::ECS::Service', observed, observed);

    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateServiceCommand);
    expect(updates).toHaveLength(1);
    const input = updates[0]![0].input as Record<string, unknown>;
    expect(input['availabilityZoneRebalancing']).toBeUndefined();
    expect(input['deploymentController']).toBeUndefined();
    expect(input['serviceConnectConfiguration']).toBeUndefined();
    expect(input['volumeConfigurations']).toBeUndefined();
    expect(input['vpcLatticeConfigurations']).toBeUndefined();
    expect(input['monitoring']).toBeUndefined();
    expect(input['forceNewDeployment']).toBeUndefined();
  });
});
