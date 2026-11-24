import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6610: a member a SIBLING resource of the stack writes into a
 * parent's property is not the parent's. Driven end to end through
 * `cdkd drift` / `--revert` and the real providers (readback AND `update()`),
 * over mocked AWS:
 *  - an `AWS::SNS::Subscription` on a topic that declares an inline
 *    `Subscription` list: `--revert` UNSUBSCRIBED it;
 *  - an `AWS::ECS::ClusterCapacityProviderAssociations` on a cluster:
 *    `--revert` sent the cluster's stale baseline through
 *    `PutClusterCapacityProviders`, detaching what the association attached.
 */

const mockSnsSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({
    get s3() {
      return {};
    },
    get sns() {
      return { send: mockSnsSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({ sns: { send: mockSnsSend }, sts: { send: mockStsSend } }),
}));

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: vi.fn(async () => '"etag-2"'),
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockRegistryGetProvider(input.resourceType),
      provisionedBy: 'sdk',
    }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:topic';
const CLUSTER = 'my-cluster';

interface Sub {
  Protocol: string;
  Endpoint: string;
}
const INLINE: Sub = { Protocol: 'email', Endpoint: 'ops@example.com' };
const SIB: Sub = { Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:123456789012:q' };
const STRANGER: Sub = { Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:123456789012:stranger' };

/** The topic's live subscriptions; the mocked SNS reads and writes them. */
let liveSubs: Sub[] = [];
const subscribed: string[] = [];
const unsubscribed: string[] = [];
const arnOf = (s: Sub): string => `${TOPIC}:${s.Protocol}:${s.Endpoint}`;

function routeSns(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
  switch (cmd.constructor.name) {
    case 'GetTopicAttributesCommand':
      return { Attributes: { TopicArn: TOPIC, DisplayName: '' } };
    case 'ListTagsForResourceCommand':
      return { Tags: [] };
    case 'ListSubscriptionsByTopicCommand':
      return { Subscriptions: liveSubs.map((s) => ({ ...s, SubscriptionArn: arnOf(s) })) };
    case 'SubscribeCommand': {
      const s = { Protocol: String(cmd.input['Protocol']), Endpoint: String(cmd.input['Endpoint']) };
      subscribed.push(s.Endpoint);
      liveSubs = [...liveSubs, s];
      return { SubscriptionArn: arnOf(s) };
    }
    case 'UnsubscribeCommand': {
      const arn = String(cmd.input['SubscriptionArn']);
      const s = liveSubs.find((x) => arnOf(x) === arn);
      unsubscribed.push(s?.Endpoint ?? arn);
      liveSubs = liveSubs.filter((x) => arnOf(x) !== arn);
      return {};
    }
    default:
      return {};
  }
}

/** The cluster's live capacity providers; the mocked ECS reads and writes them. */
let liveProviders: string[] = [];
let liveInsights = 'disabled';
const capacityPuts: string[][] = [];

function routeEcs(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
  switch (cmd.constructor.name) {
    case 'DescribeClustersCommand':
      return {
        clusters: [
          {
            clusterName: CLUSTER,
            status: 'ACTIVE',
            capacityProviders: liveProviders,
            defaultCapacityProviderStrategy: liveProviders.map((p) => ({
              capacityProvider: p,
              weight: 1,
              base: 0,
            })),
            settings: [{ name: 'containerInsights', value: liveInsights }],
            tags: [],
            attachments: [],
          },
        ],
      };
    case 'PutClusterCapacityProvidersCommand':
      capacityPuts.push(cmd.input['capacityProviders'] as string[]);
      liveProviders = cmd.input['capacityProviders'] as string[];
      return { cluster: { clusterName: CLUSTER, attachments: [] } };
    case 'UpdateClusterCommand':
    case 'UpdateClusterSettingsCommand': {
      const settings = cmd.input['settings'] as Array<{ name: string; value: string }> | undefined;
      const insights = settings?.find((s) => s.name === 'containerInsights');
      if (insights) liveInsights = insights.value;
      return { cluster: { clusterName: CLUSTER } };
    }
    default:
      return {};
  }
}

function stack(resources: Record<string, ResourceState>): { state: StackState; etag: string } {
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

let sns: SNSTopicProvider;
let ecs: ECSProvider;

/** A topic record whose baseline is the provider's own read of `baselineSubs`. */
async function topicRecord(declared: Sub[], baselineSubs: Sub[]): Promise<ResourceState> {
  const saved = liveSubs;
  liveSubs = baselineSubs;
  const properties = { Subscription: declared };
  const observed = (await sns.readCurrentState(
    TOPIC,
    'Topic',
    'AWS::SNS::Topic',
    properties
  )) as Record<string, unknown>;
  liveSubs = saved;
  return {
    physicalId: TOPIC,
    resourceType: 'AWS::SNS::Topic',
    properties,
    observedProperties: observed,
  } as ResourceState;
}

const subscriptionRecord: ResourceState = {
  physicalId: arnOf(SIB),
  resourceType: 'AWS::SNS::Subscription',
  properties: { TopicArn: TOPIC, ...SIB },
} as ResourceState;

/** A cluster record whose baseline is the provider's own read of `baselineProviders`. */
async function clusterRecord(baselineProviders: string[]): Promise<ResourceState> {
  const saved = liveProviders;
  const savedInsights = liveInsights;
  liveProviders = baselineProviders;
  liveInsights = 'disabled';
  const properties = { ClusterName: CLUSTER };
  const observed = (await ecs.readCurrentState(
    CLUSTER,
    'Cluster',
    'AWS::ECS::Cluster'
  )) as Record<string, unknown>;
  liveProviders = saved;
  liveInsights = savedInsights;
  return {
    physicalId: CLUSTER,
    resourceType: 'AWS::ECS::Cluster',
    properties,
    observedProperties: observed,
  } as ResourceState;
}

const associationRecord: ResourceState = {
  physicalId: 'assoc-id',
  resourceType: 'AWS::ECS::ClusterCapacityProviderAssociations',
  properties: {
    Cluster: CLUSTER,
    CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
    DefaultCapacityProviderStrategy: [
      { CapacityProvider: 'FARGATE', Weight: 1, Base: 0 },
      { CapacityProvider: 'FARGATE_SPOT', Weight: 1, Base: 0 },
    ],
  },
} as ResourceState;

let exitSpy: ReturnType<typeof vi.spyOn>;

/** Run `cdkd drift TestStack [...flags]`; returns the exit code it asked for, if any. */
async function runDrift(flags: string[]): Promise<number | undefined> {
  exitSpy.mockClear();
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', ...flags], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
  const calls = exitSpy.mock.calls;
  return calls.length === 0 ? undefined : (calls[calls.length - 1]![0] as number | undefined);
}

describe('cdkd drift on a parent a sibling resource writes into (go-to-k/cdkd#6610)', () => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockSnsSend.mockReset();
    mockSnsSend.mockImplementation(async (cmd) => routeSns(cmd));
    mockStsSend.mockReset();
    mockStsSend.mockResolvedValue({
      Account: '123456789012',
      Arn: 'arn:aws:iam::123456789012:user/u',
    });
    subscribed.length = 0;
    unsubscribed.length = 0;
    capacityPuts.length = 0;
    liveInsights = 'disabled';
    sns = new SNSTopicProvider();
    ecs = new ECSProvider();
    (ecs as unknown as { ecsClient: unknown }).ecsClient = {
      send: vi.fn(async (cmd) => routeEcs(cmd)),
    };
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::SNS::Topic'
        ? sns
        : type === 'AWS::ECS::Cluster'
          ? ecs
          : // The child resources read back exactly as recorded.
            {
              readCurrentState: async (
                _pid: string,
                _lid: string,
                _type: string,
                recorded: Record<string, unknown>
              ) => recorded,
            }
    );
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  describe('SNS topic <- AWS::SNS::Subscription', () => {
    it.each([
      ['captured before the sibling subscribed', [INLINE]],
      ['captured after the sibling subscribed', [INLINE, SIB]],
    ])('reports no drift (baseline %s)', async (_label, baseline) => {
      liveSubs = [INLINE, SIB];
      mockGetState.mockResolvedValue(
        stack({ Topic: await topicRecord([INLINE], baseline), Sub: subscriptionRecord })
      );

      expect((await runDrift([])) ?? 0).toBe(0);
    });

    it('a subscription nothing in the stack owns still reports drift', async () => {
      liveSubs = [INLINE, SIB];
      mockGetState.mockResolvedValue(stack({ Topic: await topicRecord([INLINE], [INLINE]) }));

      expect(await runDrift([])).toBe(1);
    });

    it.each([
      ['captured before the sibling subscribed', [INLINE]],
      ['captured after the sibling subscribed', [INLINE, SIB]],
    ])('--revert of an out-of-band subscription unsubscribes ONLY it, never the sibling (baseline %s)', async (_label, baseline) => {
      liveSubs = [INLINE, SIB, STRANGER];
      mockGetState.mockResolvedValue(
        stack({ Topic: await topicRecord([INLINE], baseline), Sub: subscriptionRecord })
      );

      await runDrift(['--revert', '--yes']);

      expect(unsubscribed).toEqual([STRANGER.Endpoint]);
      expect(subscribed).toEqual([]);
      expect(liveSubs).toEqual([INLINE, SIB]);
    });

    it.each([
      ['captured before the sibling subscribed', [INLINE]],
      ['captured after the sibling subscribed', [INLINE, SIB]],
    ])('--revert re-subscribes a removed inline subscription and leaves the sibling alone (baseline %s)', async (_label, baseline) => {
      liveSubs = [SIB];
      mockGetState.mockResolvedValue(
        stack({ Topic: await topicRecord([INLINE], baseline), Sub: subscriptionRecord })
      );

      await runDrift(['--revert', '--yes']);

      expect(subscribed).toEqual([INLINE.Endpoint]);
      expect(unsubscribed).toEqual([]);
    });
  });

  describe('ECS cluster <- ClusterCapacityProviderAssociations', () => {
    it('a baseline captured before the association changed reports no drift', async () => {
      liveProviders = ['FARGATE', 'FARGATE_SPOT'];
      mockGetState.mockResolvedValue(
        stack({ Cluster: await clusterRecord(['FARGATE']), Assoc: associationRecord })
      );

      expect((await runDrift([])) ?? 0).toBe(0);
    });

    it('without the association record, the same difference reports drift', async () => {
      liveProviders = ['FARGATE', 'FARGATE_SPOT'];
      mockGetState.mockResolvedValue(stack({ Cluster: await clusterRecord(['FARGATE']) }));

      expect(await runDrift([])).toBe(1);
    });

    it('--revert of another drifted key sends no capacity-provider change', async () => {
      liveProviders = ['FARGATE', 'FARGATE_SPOT'];
      liveInsights = 'enabled';
      mockGetState.mockResolvedValue(
        stack({ Cluster: await clusterRecord(['FARGATE']), Assoc: associationRecord })
      );

      expect(await runDrift([])).toBe(1);
      await runDrift(['--revert', '--yes']);

      expect(liveInsights).toBe('disabled');
      expect(capacityPuts).toEqual([]);
      expect(liveProviders).toEqual(['FARGATE', 'FARGATE_SPOT']);
    });
  });
});
