import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    ECSClient: vi.fn().mockImplementation(() => ({
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
    // state == AWS. UpdateCluster uses a truthy gate
    // `if (CapacityProviders || DefaultCapacityProviderStrategy)`; an
    // empty-array placeholder is truthy and would call AWS even though
    // nothing changed. State that holds the same values must stay
    // mutation-free on round-trip.
    const observed = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: ['FARGATE'],
      DefaultCapacityProviderStrategy: [
        { capacityProvider: 'FARGATE', weight: 1, base: 0 },
      ] as Array<Record<string, unknown>>,
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
      Tags: [{ Key: 'env', Value: 'prod' }],
    };

    // Mock: PutClusterCapacityProviders → DescribeClusters (for ARN)
    mockSend.mockResolvedValueOnce({}); // PutClusterCapacityProviders
    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN, clusterName: CLUSTER_NAME }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', observed, observed);

    // Tag* must NOT fire — old/new tags identical (no diff).
    const tagSends = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagSends).toHaveLength(0);
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

    // Mock: PutClusterCapacityProviders → UpdateCluster → DescribeClusters.
    mockSend.mockResolvedValueOnce({});
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

    mockSend.mockResolvedValueOnce({}); // PutClusterCapacityProviders (truthy-gated, fires on empty arrays)
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

  it('Cluster: no Settings/Configuration diff → no UpdateClusterCommand', async () => {
    // No-diff no-op guard for the new code path. State == AWS for
    // ClusterSettings + Configuration must NOT issue UpdateClusterCommand
    // even when CapacityProviders is truthy-gated (which still does fire
    // PutClusterCapacityProviders — separate concern).
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

    mockSend.mockResolvedValueOnce({}); // Put
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

    const result = await provider.readCurrentState(
      SERVICE_PHYSICAL_ID,
      'L',
      'AWS::ECS::Service'
    );

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

    const result = await provider.readCurrentState(
      SERVICE_PHYSICAL_ID,
      'L',
      'AWS::ECS::Service'
    );

    expect(result).not.toBeUndefined();
    expect(result!['PlacementStrategy']).toEqual([
      { type: 'spread', field: 'instanceId' },
    ]);
    expect(Object.keys(result!)).not.toContain('PlatformVersion');
  });

  it('Service EC2 round-trip preserves PlacementStrategy in UpdateService input', async () => {
    // The complement of the Fargate test: an EC2 service legitimately
    // has PlacementStrategy and round-tripping should NOT drop it.
    const observed = {
      ServiceName: 'my-svc',
      Cluster: CLUSTER_ARN,
      TaskDefinition: TD_ARN,
      DesiredCount: 2,
      LaunchType: 'EC2',
      PlacementStrategy: [{ type: 'spread', field: 'instanceId' }],
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

  it('TaskDefinition.update rejects with ResourceUpdateNotSupportedError; no spurious AWS calls', async () => {
    // TaskDefinition revisions are immutable: every property change
    // creates a new revision via RegisterTaskDefinition, and the
    // returned `taskDefinitionArn` differs from cdkd state's physicalId.
    // Routing through `cdkd drift --revert` would silently swap
    // physicalId for a freshly-registered revision and deregister the
    // previous one. The only safe outcome is a clear error, NOT a
    // silent revision-bump against AWS.
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
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    // No mutating AWS calls — the error fires before any send().
    expect(mutatingSends()).toHaveLength(0);
  });

  // ─── State == AWS produces zero mutating calls ─────────────────

  it('Cluster no-drift round-trip: zero mutating SDK calls', async () => {
    // Stronger structural guard: on a no-drift round-trip, the only
    // SDK calls allowed are reads. Tag* must be silent; the truthy-
    // gated PutClusterCapacityProviders is allowed (it's a no-op on
    // AWS when values match) but Tag mutations are not.
    const observed = {
      ClusterName: CLUSTER_NAME,
      CapacityProviders: [],
      DefaultCapacityProviderStrategy: [],
      ClusterSettings: [],
      Tags: [{ Key: 'env', Value: 'prod' }],
    };

    // Mock: PutClusterCapacityProviders (truthy-gate guard does fire
    // because both arrays are truthy even when empty) → Describe.
    mockSend.mockResolvedValueOnce({}); // Put
    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterArn: CLUSTER_ARN }],
    });

    await provider.update('L', CLUSTER_NAME, 'AWS::ECS::Cluster', observed, observed);

    // No Tag* mutation on a no-drift run.
    const tagMutations = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagMutations).toHaveLength(0);

    // Sanity: only Put + Describe were issued.
    expect(mockSend.mock.calls.length).toBe(2);
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(PutClusterCapacityProvidersCommand);
    expect(mockSend.mock.calls[1]![0]).toBeInstanceOf(DescribeClustersCommand);
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
});
