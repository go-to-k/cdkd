import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#6940: the opt-in sites beyond deferred-readiness-providers-6940
// (RDS / ElastiCache / ACM / ECS): EC2 instance update, DocDB, Neptune, ELBv2
// LoadBalancer, Lambda MicroVM image, BedrockAgentCore Runtime, EventBridge
// Archive and Connect Instance. Under `--no-wait` the provider skips its wait
// and hands the same wait to the deploy (`deferReadiness`), which runs it with
// an abort signal only if it needs the resource. The default mode waits during
// the operation and defers nothing.

const { mockSend, waitUntilLoadBalancerAvailableMock, waitForRuntimeReadyMock } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  waitUntilLoadBalancerAvailableMock: vi.fn(),
  waitForRuntimeReadyMock: vi.fn(),
}));

const regionConfig = { region: () => Promise.resolve('us-east-1') };

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: regionConfig },
    eventBridge: { send: mockSend, config: regionConfig },
    lambdaMicrovms: { send: mockSend, config: regionConfig },
    bedrockAgentCoreControl: { send: mockSend, config: regionConfig },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger: Record<string, unknown> = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  childLogger['child'] = () => childLogger;
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  };
});

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  DocDBClient: vi.fn(() => ({ send: mockSend, config: regionConfig })),
}));

vi.mock('@aws-sdk/client-neptune', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  NeptuneClient: vi.fn(() => ({ send: mockSend, config: regionConfig })),
}));

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  EC2Client: vi.fn(() => ({ send: mockSend, config: regionConfig })),
}));

vi.mock('@aws-sdk/client-connect', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  ConnectClient: vi.fn(() => ({ send: mockSend, config: regionConfig })),
}));

vi.mock('@aws-sdk/client-eventbridge', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  EventBridgeClient: vi.fn(() => ({ send: mockSend, config: regionConfig })),
}));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  ElasticLoadBalancingV2Client: vi.fn(() => ({ send: mockSend, config: regionConfig })),
  waitUntilLoadBalancerAvailable: waitUntilLoadBalancerAvailableMock,
}));

vi.mock('../../../src/provisioning/providers/agentcore-runtime/wait.js', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  waitForRuntimeReady: waitForRuntimeReadyMock,
}));

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { LambdaMicrovmImageProvider } from '../../../src/provisioning/providers/lambda-microvm-image-provider.js';
import { AgentCoreRuntimeProvider } from '../../../src/provisioning/providers/agentcore-runtime-provider.js';
import { EventBridgeArchiveProvider } from '../../../src/provisioning/providers/eventbridge-archive-provider.js';
import { ConnectInstanceProvider } from '../../../src/provisioning/providers/connect-instance-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import {
  withDeferredReadinessScope,
  type DeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';

function scopeFor(logicalId: string, resourceType: string): DeferredReadinessScope {
  return {
    logicalId,
    resourceType,
    deferred: new Map(),
    awaitUpstreamReadiness: async () => undefined,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource: () => undefined,
  } as DeferredReadinessScope;
}

/** Route each SDK command by class name; anything unlisted answers `{}`. */
function respond(table: Record<string, unknown>): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) =>
    Promise.resolve(table[command.constructor.name] ?? {})
  );
}

const spyOnWait = (provider: object, method: string, result: unknown = undefined) =>
  vi.spyOn(provider as Record<string, (...args: unknown[]) => Promise<unknown>>, method)
    .mockResolvedValue(result);

type WaitCall = readonly unknown[];

interface Case {
  label: string;
  logicalId: string;
  type: string;
  id: string;
  /** Build the provider with the wait replaced by a spy (or a mock of the waiter). */
  setup: () => {
    run: () => Promise<unknown>;
    /** The calls of the wait the opt-in site skips. */
    waitCalls: () => WaitCall[];
    /** Whether `call` hands `signal` to the wait. */
    carriesSignal: (call: WaitCall, signal: AbortSignal) => boolean;
  };
}

const inArgs = (call: WaitCall, signal: AbortSignal): boolean => call.includes(signal);

const DOCDB_INSTANCE_PROPS = {
  DBInstanceIdentifier: 'my-db',
  DBInstanceClass: 'db.t3.medium',
  DBClusterIdentifier: 'my-cluster',
};

const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-lb/1234567890abcdef';
const IMAGE_ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:my-image';
const CONNECT_ID = '11111111-2222-3333-4444-555555555555';
const CONNECT_ARN = `arn:aws:connect:us-east-1:123456789012:instance/${CONNECT_ID}`;

const microvmProps = {
  Name: 'my-image',
  BaseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
  BuildRoleArn: 'arn:aws:iam::123456789012:role/MicrovmBuildRole',
  CodeArtifact: { Uri: 's3://my-bucket/app.zip' },
};

const cases: Case[] = [
  {
    label: 'EC2 Instance update (stop, modify, start)',
    logicalId: 'Host',
    type: 'AWS::EC2::Instance',
    id: 'i-0123456789abcdef0',
    setup: () => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        Promise.resolve(
          command.constructor.name === 'DescribeInstancesCommand'
            ? {
                Reservations: [
                  {
                    Instances: [
                      {
                        InstanceId: 'i-0123456789abcdef0',
                        State: { Name: 'running' },
                        RootDeviceType: 'ebs',
                        VpcId: 'vpc-1',
                      },
                    ],
                  },
                ],
              }
            : {}
        )
      );
      const provider = new EC2Provider();
      vi.spyOn(provider as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue(
        undefined
      );
      const spy = spyOnWait(provider, 'waitForInstanceState');
      const base = { ImageId: 'ami-1', InstanceType: 't3.nano', SubnetId: 'subnet-1' };
      return {
        run: () =>
          provider.update(
            'Host',
            'i-0123456789abcdef0',
            'AWS::EC2::Instance',
            { ...base, InstanceType: 't3.micro' },
            base
          ),
        // The stop wait is not the skipped one: only the `running` wait is.
        waitCalls: () => spy.mock.calls.filter((call) => call[3] === 'running'),
        carriesSignal: (call, signal) =>
          (call[4] as { signal?: AbortSignal; stoppedIsTerminal?: boolean }).signal === signal &&
          (call[4] as { stoppedIsTerminal?: boolean }).stoppedIsTerminal === true,
      };
    },
  },
  {
    label: 'DocDB DBInstance create',
    logicalId: 'Db',
    type: 'AWS::DocDB::DBInstance',
    id: 'my-db',
    setup: () => {
      respond({
        CreateDBInstanceCommand: { DBInstance: { DBInstanceIdentifier: 'my-db' } },
        DescribeDBInstancesCommand: { DBInstances: [{ DBInstanceStatus: 'available' }] },
      });
      const provider = new DocDBProvider();
      const spy = spyOnWait(provider, 'waitForInstanceAvailable');
      return {
        run: () => provider.create('Db', 'AWS::DocDB::DBInstance', DOCDB_INSTANCE_PROPS),
        waitCalls: () => spy.mock.calls,
        carriesSignal: inArgs,
      };
    },
  },
  {
    label: 'DocDB DBCluster create',
    logicalId: 'Cluster',
    type: 'AWS::DocDB::DBCluster',
    id: 'my-cluster',
    setup: () => {
      respond({
        CreateDBClusterCommand: { DBCluster: { DBClusterIdentifier: 'my-cluster' } },
        DescribeDBClustersCommand: { DBClusters: [{ Status: 'available' }] },
      });
      const provider = new DocDBProvider();
      const spy = spyOnWait(provider, 'waitForClusterAvailable');
      return {
        run: () =>
          provider.create('Cluster', 'AWS::DocDB::DBCluster', { DBClusterIdentifier: 'my-cluster' }),
        waitCalls: () => spy.mock.calls,
        carriesSignal: inArgs,
      };
    },
  },
  {
    label: 'Neptune DBInstance create',
    logicalId: 'Db',
    type: 'AWS::Neptune::DBInstance',
    id: 'my-db',
    setup: () => {
      respond({
        CreateDBInstanceCommand: { DBInstance: { DBInstanceIdentifier: 'my-db' } },
        DescribeDBInstancesCommand: { DBInstances: [{ DBInstanceStatus: 'available' }] },
      });
      const provider = new NeptuneProvider();
      const spy = spyOnWait(provider, 'waitForInstanceAvailable');
      return {
        run: () => provider.create('Db', 'AWS::Neptune::DBInstance', DOCDB_INSTANCE_PROPS),
        waitCalls: () => spy.mock.calls,
        carriesSignal: inArgs,
      };
    },
  },
  {
    label: 'Neptune DBCluster create',
    logicalId: 'Cluster',
    type: 'AWS::Neptune::DBCluster',
    id: 'my-cluster',
    setup: () => {
      respond({
        CreateDBClusterCommand: { DBCluster: { DBClusterIdentifier: 'my-cluster' } },
        DescribeDBClustersCommand: { DBClusters: [{ Status: 'available' }] },
      });
      const provider = new NeptuneProvider();
      const spy = spyOnWait(provider, 'waitForClusterAvailable');
      return {
        run: () =>
          provider.create('Cluster', 'AWS::Neptune::DBCluster', {
            DBClusterIdentifier: 'my-cluster',
          }),
        waitCalls: () => spy.mock.calls,
        carriesSignal: inArgs,
      };
    },
  },
  {
    label: 'ELBv2 LoadBalancer create',
    logicalId: 'Lb',
    type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    id: LB_ARN,
    setup: () => {
      waitUntilLoadBalancerAvailableMock.mockResolvedValue({ state: 'SUCCESS' });
      mockSend.mockImplementation((command: { constructor: { name: string }; input?: { Names?: unknown } }) =>
        // The by-name lookup before a create: the name is free.
        command.input?.Names !== undefined
          ? Promise.reject(
              Object.assign(new Error('not found'), { name: 'LoadBalancerNotFoundException' })
            )
          : Promise.resolve(
              command.constructor.name === 'CreateLoadBalancerCommand'
                ? {
                    LoadBalancers: [
                      {
                        LoadBalancerArn: LB_ARN,
                        LoadBalancerName: 'my-lb',
                        DNSName: 'my-lb-123.us-east-1.elb.amazonaws.com',
                        CanonicalHostedZoneId: 'Z35SXDOTRQ7X7K',
                        State: { Code: 'provisioning' },
                      },
                    ],
                  }
                : {}
            )
      );
      const provider = new ELBv2Provider();
      return {
        run: () =>
          provider.create('Lb', 'AWS::ElasticLoadBalancingV2::LoadBalancer', {
            Subnets: ['subnet-1', 'subnet-2'],
            Type: 'application',
          }),
        waitCalls: () => waitUntilLoadBalancerAvailableMock.mock.calls as unknown as WaitCall[],
        // The waiter's config carries the signal as `abortSignal`, for this LB's arn.
        carriesSignal: (call, signal) =>
          (call[0] as { abortSignal?: AbortSignal }).abortSignal === signal &&
          JSON.stringify(call[1]) === JSON.stringify({ LoadBalancerArns: [LB_ARN] }),
      };
    },
  },
  {
    label: 'Lambda MicroVM image create',
    logicalId: 'Image',
    type: 'AWS::Lambda::MicrovmImage',
    id: IMAGE_ARN,
    setup: () => {
      respond({ CreateMicrovmImageCommand: { imageArn: IMAGE_ARN, state: 'CREATING' } });
      const provider = new LambdaMicrovmImageProvider();
      const spy = spyOnWait(provider, 'waitForTerminalState', { state: 'CREATED' });
      return {
        run: () => provider.create('Image', 'AWS::Lambda::MicrovmImage', microvmProps),
        waitCalls: () => spy.mock.calls,
        carriesSignal: (call, signal) => call[3] === signal && call[2] === 'create',
      };
    },
  },
  {
    label: 'Lambda MicroVM image update',
    logicalId: 'Image',
    type: 'AWS::Lambda::MicrovmImage',
    id: IMAGE_ARN,
    setup: () => {
      respond({});
      const provider = new LambdaMicrovmImageProvider();
      const spy = spyOnWait(provider, 'waitForTerminalState', { state: 'UPDATED' });
      return {
        run: () =>
          provider.update(
            'Image',
            IMAGE_ARN,
            'AWS::Lambda::MicrovmImage',
            { ...microvmProps, Description: 'changed' },
            microvmProps
          ),
        waitCalls: () => spy.mock.calls,
        carriesSignal: (call, signal) => call[3] === signal && call[2] === 'update',
      };
    },
  },
  {
    label: 'EventBridge Archive create',
    logicalId: 'Arch',
    type: 'AWS::Events::Archive',
    id: 'my-archive',
    setup: () => {
      respond({ CreateArchiveCommand: { State: 'CREATING' } });
      const provider = new EventBridgeArchiveProvider();
      // The create call goes through its own client; keep it off the network.
      (provider as unknown as { createClient: unknown }).createClient = Promise.resolve({
        send: mockSend,
        config: regionConfig,
      });
      const spy = spyOnWait(provider, 'pollUntilSettled', 'arn:aws:events:us-east-1:1:archive/a');
      return {
        run: () =>
          provider.create('Arch', 'AWS::Events::Archive', {
            ArchiveName: 'my-archive',
            SourceArn: 'arn:aws:events:us-east-1:123456789012:event-bus/b',
          }),
        waitCalls: () => spy.mock.calls,
        carriesSignal: (call, signal) => call[4] === signal && call[2] === 'create',
      };
    },
  },
  {
    label: 'Connect Instance create (ACTIVE wait)',
    logicalId: 'Inst',
    type: 'AWS::Connect::Instance',
    id: CONNECT_ARN,
    setup: () => {
      respond({ CreateInstanceCommand: { Id: CONNECT_ID, Arn: CONNECT_ARN } });
      const provider = new ConnectInstanceProvider();
      (provider as unknown as { client: unknown }).client = {
        send: mockSend,
        config: regionConfig,
      };
      // Create waits once for readiness in either mode; only `active` is skipped.
      const spy = spyOnWait(provider, 'waitForInstance', {
        Id: CONNECT_ID,
        Arn: CONNECT_ARN,
        InstanceStatus: 'ACTIVE',
      });
      return {
        run: () =>
          provider.create('Inst', 'AWS::Connect::Instance', {
            IdentityManagementType: 'CONNECT_MANAGED',
            InstanceAlias: 'my-alias',
            Attributes: { InboundCalls: true, OutboundCalls: true },
          }),
        waitCalls: () => spy.mock.calls.filter((call) => call[2] === 'active'),
        carriesSignal: (call, signal) => call[5] === signal,
      };
    },
  },
  {
    label: 'BedrockAgentCore Runtime create',
    logicalId: 'Rt',
    type: 'AWS::BedrockAgentCore::Runtime',
    id: 'runtime-6940',
    setup: () => {
      respond({
        CreateAgentRuntimeCommand: {
          agentRuntimeId: 'runtime-6940',
          agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-6940',
          status: 'CREATING',
        },
      });
      waitForRuntimeReadyMock.mockResolvedValue({ status: 'READY' });
      const provider = new AgentCoreRuntimeProvider();
      return {
        run: () =>
          provider.create('Rt', 'AWS::BedrockAgentCore::Runtime', {
            AgentRuntimeName: 'my-runtime',
            RoleArn: 'arn:aws:iam::123456789012:role/my-role',
          }),
        waitCalls: () => waitForRuntimeReadyMock.mock.calls as unknown as WaitCall[],
        // The abort reaches the poll through the sleep the wait is given: an
        // aborted signal makes it reject at once instead of sleeping.
        carriesSignal: () => true,
      };
    },
  },
];

describe.each(cases)('$label readiness under --no-wait (#6940)', (c) => {
  beforeEach(() => {
    mockSend.mockReset();
    waitUntilLoadBalancerAvailableMock.mockReset();
    waitForRuntimeReadyMock.mockReset();
    resetIdempotencyTokensForTests();
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
    vi.restoreAllMocks();
  });

  it('defers the skipped wait, unstarted, and the deferred wait is the same wait with the signal', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    const { run, waitCalls, carriesSignal } = c.setup();
    const scope = scopeFor(c.logicalId, c.type);
    await withDeferredReadinessScope(scope, run);
    expect(waitCalls()).toHaveLength(0);
    expect([...scope.deferred.keys()]).toStrictEqual([c.id]);

    const controller = new AbortController();
    await scope.deferred.get(c.id)!.wait(controller.signal);
    expect(waitCalls()).toHaveLength(1);
    expect(carriesSignal(waitCalls()[0]!, controller.signal)).toBe(true);
  });

  it('the default mode waits during the operation and defers nothing', async () => {
    const { run, waitCalls } = c.setup();
    const scope = scopeFor(c.logicalId, c.type);
    await withDeferredReadinessScope(scope, run);
    expect(waitCalls()).toHaveLength(1);
    expect(scope.deferred.size).toBe(0);
  });
});

describe('BedrockAgentCore Runtime deferred wait stops at its next sleep on abort (#6940)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    waitForRuntimeReadyMock.mockReset();
    process.env['CDKD_NO_WAIT'] = 'true';
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  it('hands the wait a sleep that rejects once the signal aborts', async () => {
    respond({ CreateAgentRuntimeCommand: { agentRuntimeId: 'runtime-6940', status: 'CREATING' } });
    waitForRuntimeReadyMock.mockResolvedValue({ status: 'READY' });
    const scope = scopeFor('Rt', 'AWS::BedrockAgentCore::Runtime');
    await withDeferredReadinessScope(scope, () =>
      new AgentCoreRuntimeProvider().create('Rt', 'AWS::BedrockAgentCore::Runtime', {
        AgentRuntimeName: 'my-runtime',
        RoleArn: 'arn:aws:iam::123456789012:role/my-role',
      })
    );
    const controller = new AbortController();
    await scope.deferred.get('runtime-6940')!.wait(controller.signal);
    const deps = waitForRuntimeReadyMock.mock.calls[0]![0] as { sleep: (ms: number) => Promise<void> };
    controller.abort();
    await expect((async () => deps.sleep(10_000))()).rejects.toThrow(/aborted/);
  });
});
