import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  InsightNotEnabledException,
  ResourceNotFoundException as CloudTrailResourceNotFound,
  TrailNotFoundException,
} from '@aws-sdk/client-cloudtrail';
import {
  NotFoundException as KmsNotFound,
  UnsupportedOperationException as KmsUnsupported,
} from '@aws-sdk/client-kms';
import { FileSystemNotFound, MountTargetNotFound } from '@aws-sdk/client-efs';
import { ResourceNotFoundException as LogsResourceNotFound } from '@aws-sdk/client-cloudwatch-logs';
import { ResourceNotFoundException as LambdaResourceNotFound } from '@aws-sdk/client-lambda';

/**
 * Issue #6759 (part a): a SUB-read inside `readCurrentState` (a second AWS
 * call for one property) that fails with anything but its own not-found /
 * not-configured code makes the read reject, so `cdkd drift` reports the
 * resource `readFailed` instead of silently never comparing (or defaulting)
 * the property. The not-found code keeps the answer it gave before.
 *
 * Every client of every provider is one `send` stub that answers by command
 * name, so a case names only the calls it shapes.
 */

type Answer = unknown;
const answers = new Map<string, Answer>();
const send = vi.fn(async (command: { constructor: { name: string } }) => {
  const answer = answers.get(command.constructor.name);
  if (answer instanceof Error) throw answer;
  return answer ?? {};
});
const client = { send, config: { region: () => Promise.resolve('us-east-1') } };

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : client) }),
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

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

function named(name: string, message = `${name} raised`): Error {
  return Object.assign(new Error(message), { name });
}
/** A modeled SDK exception (`instanceof` its class), whatever members its options require. */
const sdk = <T>(Ctor: new (opts: never) => T): T =>
  new (Ctor as unknown as new (opts: object) => T)({
    message: 'not found',
    $metadata: {},
    ErrorCode: 'NotFound',
  });
const accessDenied = (): Error =>
  named('AccessDeniedException', 'User is not authorized to perform this operation');

interface Reader {
  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<unknown>;
}

/** A provider whose `getClient()` returns the shared stub. */
function withClient<T extends object>(provider: T): T {
  if ('getClient' in provider) {
    (provider as { getClient: () => unknown }).getClient = () => client;
  }
  return provider;
}

interface Site {
  name: string;
  make: () => Reader;
  type: string;
  physicalId: string;
  properties?: Record<string, unknown>;
  /** The calls the resource read needs before any sub-read. */
  primary: Record<string, Answer>;
  /** The sub-read under test. */
  sub: string;
  /** Its not-found / not-configured answer. */
  notFound: () => Error;
  /** What the read answers on `notFound`, as before #6759. */
  onNotFound: (read: unknown) => void;
}

const bag = (read: unknown): Record<string, unknown> => {
  expect(read).not.toBe(RESOURCE_NOT_FOUND);
  expect(read).toBeTypeOf('object');
  return read as Record<string, unknown>;
};

const TRAIL = {
  GetTrailCommand: {
    Trail: {
      Name: 'trail',
      S3BucketName: 'b',
      TrailARN: 'arn:aws:cloudtrail:us-east-1:111111111111:trail/trail',
    },
  },
};
const KEY = {
  DescribeKeyCommand: { KeyMetadata: { KeyId: 'key-1', KeySpec: 'SYMMETRIC_DEFAULT' } },
  GetKeyPolicyCommand: { Policy: '{"Version":"2012-10-17","Statement":[]}' },
};
const FS = { DescribeFileSystemsCommand: { FileSystems: [{ FileSystemId: 'fs-1' }] } };
const PARAM = { GetParameterCommand: { Parameter: { Type: 'String', Value: 'v' } } };
const LOG_GROUP = {
  DescribeLogGroupsCommand: {
    logGroups: [{ logGroupName: 'lg', arn: 'arn:aws:logs:us-east-1:111111111111:log-group:lg:*' }],
  },
};
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/app/lb/1';
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/tg/1';
const LISTENER_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111111111111:listener/app/lb/1/2';
const LB = (type: string) => ({
  DescribeLoadBalancersCommand: { LoadBalancers: [{ LoadBalancerArn: LB_ARN, Type: type }] },
});
const TG = { DescribeTargetGroupsCommand: { TargetGroups: [{ TargetGroupArn: TG_ARN }] } };
const LISTENER = {
  DescribeListenersCommand: { Listeners: [{ ListenerArn: LISTENER_ARN, Port: 80 }] },
};
const INSTANCE = {
  DescribeInstancesCommand: {
    Reservations: [
      {
        Instances: [
          {
            InstanceId: 'i-1',
            State: { Name: 'running' },
            BlockDeviceMappings: [
              { DeviceName: '/dev/xvda', Ebs: { VolumeId: 'vol-1', DeleteOnTermination: true } },
            ],
          },
        ],
      },
    ],
  },
};
const GROUP = {
  DescribeAutoScalingGroupsCommand: {
    AutoScalingGroups: [{ AutoScalingGroupName: 'asg', MinSize: 0, MaxSize: 1 }],
  },
};
const ASG_NOT_FOUND = (): Error => named('ValidationError', 'AutoScalingGroup name not found - asg');

const SITES: Site[] = [
  // CloudTrail
  ...(
    [
      ['GetTrailStatusCommand', 'IsLogging'],
      ['GetEventSelectorsCommand', 'EventSelectors'],
      ['GetEventConfigurationCommand', 'AggregationConfigurations'],
    ] as const
  ).map(
    ([sub, key]): Site => ({
      name: `CloudTrail ${sub}`,
      make: () => withClient(new CloudTrailProvider()),
      type: 'AWS::CloudTrail::Trail',
      physicalId: 'trail',
      primary: TRAIL,
      sub,
      notFound: () => sdk(TrailNotFoundException),
      onNotFound: (read) => expect(bag(read)).not.toHaveProperty(key),
    })
  ),
  {
    name: 'CloudTrail GetInsightSelectorsCommand',
    make: () => withClient(new CloudTrailProvider()),
    type: 'AWS::CloudTrail::Trail',
    physicalId: 'trail',
    primary: TRAIL,
    sub: 'GetInsightSelectorsCommand',
    notFound: () => sdk(InsightNotEnabledException),
    onNotFound: (read) => expect(bag(read)['InsightSelectors']).toEqual([]),
  },
  {
    name: 'CloudTrail ListTagsCommand',
    make: () => withClient(new CloudTrailProvider()),
    type: 'AWS::CloudTrail::Trail',
    physicalId: 'trail',
    primary: TRAIL,
    sub: 'ListTagsCommand',
    notFound: () => sdk(CloudTrailResourceNotFound),
    onNotFound: (read) => expect(bag(read)['Tags']).toEqual([]),
  },
  // KMS
  {
    name: 'KMS GetKeyPolicyCommand',
    make: () => withClient(new KMSProvider()),
    type: 'AWS::KMS::Key',
    physicalId: 'key-1',
    primary: KEY,
    sub: 'GetKeyPolicyCommand',
    notFound: () => sdk(KmsNotFound),
    onNotFound: (read) => expect(read).toBe(RESOURCE_NOT_FOUND),
  },
  {
    name: 'KMS GetKeyRotationStatusCommand',
    make: () => withClient(new KMSProvider()),
    type: 'AWS::KMS::Key',
    physicalId: 'key-1',
    primary: KEY,
    sub: 'GetKeyRotationStatusCommand',
    notFound: () => sdk(KmsUnsupported),
    onNotFound: (read) => expect(bag(read)).not.toHaveProperty('EnableKeyRotation'),
  },
  {
    name: 'KMS ListResourceTagsCommand',
    make: () => withClient(new KMSProvider()),
    type: 'AWS::KMS::Key',
    physicalId: 'key-1',
    primary: KEY,
    sub: 'ListResourceTagsCommand',
    notFound: () => sdk(KmsNotFound),
    onNotFound: (read) => expect(read).toBe(RESOURCE_NOT_FOUND),
  },
  // EFS
  {
    name: 'EFS DescribeLifecycleConfigurationCommand',
    make: () => withClient(new EFSProvider()),
    type: 'AWS::EFS::FileSystem',
    physicalId: 'fs-1',
    primary: FS,
    sub: 'DescribeLifecycleConfigurationCommand',
    notFound: () => named('PolicyNotFound'),
    onNotFound: (read) => expect(bag(read)).not.toHaveProperty('LifecyclePolicies'),
  },
  {
    name: 'EFS DescribeBackupPolicyCommand',
    make: () => withClient(new EFSProvider()),
    type: 'AWS::EFS::FileSystem',
    physicalId: 'fs-1',
    primary: FS,
    sub: 'DescribeBackupPolicyCommand',
    notFound: () => named('PolicyNotFound'),
    onNotFound: (read) => expect(bag(read)).not.toHaveProperty('BackupPolicy'),
  },
  {
    name: 'EFS DescribeBackupPolicyCommand (Backup not in the Region)',
    make: () => withClient(new EFSProvider()),
    type: 'AWS::EFS::FileSystem',
    physicalId: 'fs-1',
    primary: FS,
    sub: 'DescribeBackupPolicyCommand',
    notFound: () => named('ValidationException'),
    onNotFound: (read) => expect(bag(read)).not.toHaveProperty('BackupPolicy'),
  },
  {
    name: 'EFS DescribeFileSystemPolicyCommand',
    make: () => withClient(new EFSProvider()),
    type: 'AWS::EFS::FileSystem',
    physicalId: 'fs-1',
    primary: FS,
    sub: 'DescribeFileSystemPolicyCommand',
    notFound: () => named('PolicyNotFound'),
    onNotFound: (read) => expect(bag(read)).not.toHaveProperty('FileSystemPolicy'),
  },
  {
    name: 'EFS DescribeMountTargetSecurityGroupsCommand',
    make: () => withClient(new EFSProvider()),
    type: 'AWS::EFS::MountTarget',
    physicalId: 'fsmt-1',
    primary: {
      DescribeMountTargetsCommand: {
        MountTargets: [{ MountTargetId: 'fsmt-1', FileSystemId: 'fs-1', SubnetId: 'subnet-1' }],
      },
    },
    sub: 'DescribeMountTargetSecurityGroupsCommand',
    notFound: () => sdk(MountTargetNotFound),
    onNotFound: (read) => expect(bag(read)['SecurityGroups']).toEqual([]),
  },
  // SSM Parameter
  {
    name: 'SSM DescribeParametersCommand',
    make: () => new SSMParameterProvider(),
    type: 'AWS::SSM::Parameter',
    physicalId: 'p',
    primary: PARAM,
    sub: 'DescribeParametersCommand',
    // No not-found code: a gone parameter is an empty list.
    notFound: () => accessDenied(),
    onNotFound: () => undefined,
  },
  {
    name: 'SSM ListTagsForResourceCommand',
    make: () => new SSMParameterProvider(),
    type: 'AWS::SSM::Parameter',
    physicalId: 'p',
    primary: PARAM,
    sub: 'ListTagsForResourceCommand',
    notFound: () => named('InvalidResourceId'),
    onNotFound: (read) => expect(bag(read)).not.toHaveProperty('Tags'),
  },
  // Logs
  {
    name: 'Logs GetDataProtectionPolicyCommand',
    make: () => new LogsLogGroupProvider(),
    type: 'AWS::Logs::LogGroup',
    physicalId: 'lg',
    primary: LOG_GROUP,
    sub: 'GetDataProtectionPolicyCommand',
    notFound: () => sdk(LogsResourceNotFound),
    onNotFound: (read) => expect(bag(read)['DataProtectionPolicy']).toBe(''),
  },
  {
    name: 'Logs DescribeIndexPoliciesCommand',
    make: () => new LogsLogGroupProvider(),
    type: 'AWS::Logs::LogGroup',
    physicalId: 'lg',
    primary: LOG_GROUP,
    sub: 'DescribeIndexPoliciesCommand',
    notFound: () => sdk(LogsResourceNotFound),
    onNotFound: (read) => expect(bag(read)['FieldIndexPolicies']).toEqual([]),
  },
  // Lambda event source mapping
  {
    name: 'Lambda ESM ListTagsCommand',
    make: () => new LambdaEventSourceMappingProvider(),
    type: 'AWS::Lambda::EventSourceMapping',
    physicalId: 'uuid-1',
    primary: {
      GetEventSourceMappingCommand: {
        UUID: 'uuid-1',
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:111111111111:event-source-mapping:uuid-1',
      },
    },
    sub: 'ListTagsCommand',
    notFound: () => sdk(LambdaResourceNotFound),
    onNotFound: (read) => expect(read).toBe(RESOURCE_NOT_FOUND),
  },
  // ELBv2
  ...(
    [
      ['DescribeCapacityReservationCommand', 'MinimumLoadBalancerCapacity'],
      ['DescribeLoadBalancerAttributesCommand', 'LoadBalancerAttributes'],
      ['DescribeTagsCommand', 'Tags'],
    ] as const
  ).map(
    ([sub, key]): Site => ({
      name: `ELBv2 LoadBalancer ${sub}`,
      make: () => withClient(new ELBv2Provider()),
      type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      physicalId: LB_ARN,
      primary: LB('application'),
      sub,
      notFound: () => named('LoadBalancerNotFoundException'),
      onNotFound: (read) =>
        sub === 'DescribeTagsCommand'
          ? expect(bag(read)).not.toHaveProperty(key)
          : expect(read).toBe(RESOURCE_NOT_FOUND),
    })
  ),
  ...(
    [
      ['DescribeTargetGroupAttributesCommand', 'TargetGroupAttributes'],
      ['DescribeTargetHealthCommand', 'Targets'],
    ] as const
  ).map(
    ([sub, key]): Site => ({
      name: `ELBv2 TargetGroup ${sub}`,
      make: () => withClient(new ELBv2Provider()),
      type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      physicalId: TG_ARN,
      primary: TG,
      sub,
      notFound: () => named('TargetGroupNotFoundException'),
      onNotFound: (read) =>
        sub === 'DescribeTargetHealthCommand'
          ? expect(bag(read)).not.toHaveProperty(key)
          : expect(read).toBe(RESOURCE_NOT_FOUND),
    })
  ),
  {
    name: 'ELBv2 Listener DescribeListenerAttributesCommand',
    make: () => withClient(new ELBv2Provider()),
    type: 'AWS::ElasticLoadBalancingV2::Listener',
    physicalId: LISTENER_ARN,
    primary: LISTENER,
    sub: 'DescribeListenerAttributesCommand',
    notFound: () => named('ListenerNotFoundException'),
    onNotFound: (read) => expect(read).toBe(RESOURCE_NOT_FOUND),
  },
  // EC2 Instance
  {
    name: 'EC2 Instance DescribeVolumesCommand',
    make: () => new EC2Provider(),
    type: 'AWS::EC2::Instance',
    physicalId: 'i-1',
    primary: INSTANCE,
    sub: 'DescribeVolumesCommand',
    notFound: () => named('InvalidVolume.NotFound'),
    onNotFound: (read) =>
      expect(bag(read)['BlockDeviceMappings']).toEqual([
        { DeviceName: '/dev/xvda', Ebs: { DeleteOnTermination: true } },
      ]),
  },
  {
    name: 'EC2 Instance DescribeInstanceAttributeCommand',
    make: () => new EC2Provider(),
    type: 'AWS::EC2::Instance',
    physicalId: 'i-1',
    properties: { InstanceInitiatedShutdownBehavior: 'stop' },
    primary: INSTANCE,
    sub: 'DescribeInstanceAttributeCommand',
    notFound: () => named('InvalidInstanceID.NotFound'),
    onNotFound: (read) => {
      expect(bag(read)).not.toHaveProperty('DisableApiTermination');
      expect(bag(read)).not.toHaveProperty('InstanceInitiatedShutdownBehavior');
    },
  },
  {
    name: 'EC2 Instance DescribeInstanceCreditSpecificationsCommand',
    make: () => new EC2Provider(),
    type: 'AWS::EC2::Instance',
    physicalId: 'i-1',
    primary: INSTANCE,
    sub: 'DescribeInstanceCreditSpecificationsCommand',
    notFound: () => named('UnsupportedOperation'),
    onNotFound: (read) => expect(bag(read)).not.toHaveProperty('CreditSpecification'),
  },
  {
    name: 'EC2 Instance ListAssociationsCommand (SsmAssociations)',
    make: () => new EC2Provider(),
    type: 'AWS::EC2::Instance',
    physicalId: 'i-1',
    properties: { SsmAssociations: [{ DocumentName: 'AWS-RunShellScript' }] },
    primary: INSTANCE,
    sub: 'ListAssociationsCommand',
    // No not-found code: an instance without associations is an empty list.
    notFound: () => accessDenied(),
    onNotFound: () => undefined,
  },
  {
    name: 'EC2 Instance DescribeInstanceCreditSpecificationsCommand (instance gone)',
    make: () => new EC2Provider(),
    type: 'AWS::EC2::Instance',
    physicalId: 'i-1',
    primary: INSTANCE,
    sub: 'DescribeInstanceCreditSpecificationsCommand',
    notFound: () => named('InvalidInstanceID.NotFound'),
    onNotFound: (read) => expect(bag(read)).not.toHaveProperty('CreditSpecification'),
  },
  // Auto Scaling group
  ...(
    [
      ['DescribeLifecycleHooksCommand', 'LifecycleHookSpecificationList'],
      ['DescribeTrafficSourcesCommand', 'TrafficSources'],
      ['DescribeNotificationConfigurationsCommand', 'NotificationConfigurations'],
    ] as const
  ).map(
    ([sub, key]): Site => ({
      name: `ASG ${sub}`,
      make: () => withClient(new ASGProvider()),
      type: 'AWS::AutoScaling::AutoScalingGroup',
      physicalId: 'asg',
      primary: GROUP,
      sub,
      notFound: ASG_NOT_FOUND,
      onNotFound: (read) => expect(bag(read)[key]).toEqual([]),
    })
  ),
];

describe('issue #6759: a failed sub-read rejects readCurrentState', () => {
  beforeEach(() => {
    answers.clear();
    send.mockClear();
  });

  function arm(site: Site, subAnswer: Error): void {
    for (const [name, answer] of Object.entries(site.primary)) answers.set(name, answer);
    answers.set(site.sub, subAnswer);
  }

  it.each(SITES.map((s) => [s.name, s] as const))(
    '%s: AccessDenied rejects the read with that error',
    async (_name, site) => {
      const denied = accessDenied();
      arm(site, denied);
      await expect(
        site.make().readCurrentState(site.physicalId, 'Logical', site.type, site.properties)
      ).rejects.toBe(denied);
      // The sub-read was actually made (the error came from it).
      expect(send.mock.calls.some(([c]) => c.constructor.name === site.sub)).toBe(true);
    }
  );

  it.each(
    SITES.filter((s) => s.notFound().name !== 'AccessDeniedException').map(
      (s) => [s.name, s] as const
    )
  )('%s: its not-found / not-configured code keeps the earlier answer', async (_name, site) => {
    arm(site, site.notFound());
    const read = await site
      .make()
      .readCurrentState(site.physicalId, 'Logical', site.type, site.properties);
    site.onNotFound(read);
  });

  it('a throttle on a sub-read rejects too (not only AccessDenied)', async () => {
    const throttled = named('ThrottlingException', 'Rate exceeded');
    for (const [name, answer] of Object.entries(TRAIL)) answers.set(name, answer);
    answers.set('GetTrailStatusCommand', throttled);
    await expect(
      withClient(new CloudTrailProvider()).readCurrentState('trail', 'L', 'AWS::CloudTrail::Trail')
    ).rejects.toBe(throttled);
  });

  it('a Gateway Load Balancer keeps the best-effort capacity read', async () => {
    for (const [name, answer] of Object.entries(LB('gateway'))) answers.set(name, answer);
    answers.set('DescribeCapacityReservationCommand', accessDenied());
    const read = await withClient(new ELBv2Provider()).readCurrentState(
      LB_ARN,
      'L',
      'AWS::ElasticLoadBalancingV2::LoadBalancer'
    );
    expect(bag(read)).not.toHaveProperty('MinimumLoadBalancerCapacity');
  });

  it('the EC2 --no-wait IamInstanceProfile backfill rejects on a failed read', async () => {
    const prev = process.env['CDKD_NO_WAIT'];
    process.env['CDKD_NO_WAIT'] = 'true';
    try {
      answers.set('DescribeInstancesCommand', {
        Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'pending' } }] }],
      });
      const denied = accessDenied();
      answers.set('DescribeIamInstanceProfileAssociationsCommand', denied);
      await expect(
        new EC2Provider().readCurrentState('i-1', 'L', 'AWS::EC2::Instance')
      ).rejects.toBe(denied);
    } finally {
      if (prev === undefined) delete process.env['CDKD_NO_WAIT'];
      else process.env['CDKD_NO_WAIT'] = prev;
    }
  });

  it('a KMS key policy failure on the post-write capture throws only after no re-read answered', async () => {
    const provider = withClient(new KMSProvider());
    (provider as unknown as { ownWriteRereadDelaysMs: number[] }).ownWriteRereadDelaysMs = [0];
    for (const [name, answer] of Object.entries(KEY)) answers.set(name, answer);
    const throttled = named('ThrottlingException', 'Rate exceeded');
    let policyReads = 0;
    const policy = { Version: '2012-10-17', Statement: [{ Sid: 'declared' }] };
    send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetKeyPolicyCommand') {
        policyReads += 1;
        if (policyReads === 1) throw throttled;
        return { Policy: JSON.stringify(policy) };
      }
      const answer = answers.get(command.constructor.name);
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    });
    try {
      const read = await (
        provider as unknown as {
          readCurrentState: (...a: unknown[]) => Promise<unknown>;
        }
      ).readCurrentState('key-1', 'L', 'AWS::KMS::Key', { KeyPolicy: policy }, {
        afterOwnWrite: true,
      });
      expect(bag(read)['KeyPolicy']).toEqual(policy);
      expect(policyReads).toBe(2);
    } finally {
      send.mockImplementation(async (command: { constructor: { name: string } }) => {
        const answer = answers.get(command.constructor.name);
        if (answer instanceof Error) throw answer;
        return answer ?? {};
      });
    }
  });
  describe('EC2 SsmAssociations', () => {
    const SSM_PROPS = { SsmAssociations: [{ DocumentName: 'AWS-RunShellScript' }] };
    const LISTED = {
      Associations: [{ InstanceId: 'i-1', AssociationId: 'assoc-1', Name: 'AWS-RunShellScript' }],
    };

    it('a DescribeAssociation failure other than the association gone rejects', async () => {
      for (const [name, answer] of Object.entries(INSTANCE)) answers.set(name, answer);
      answers.set('ListAssociationsCommand', LISTED);
      const denied = accessDenied();
      answers.set('DescribeAssociationCommand', denied);
      await expect(
        new EC2Provider().readCurrentState('i-1', 'L', 'AWS::EC2::Instance', SSM_PROPS)
      ).rejects.toBe(denied);
    });

    it('an SSM error saying "does not exist" rejects with its own text, not read as the instance gone', async () => {
      for (const [name, answer] of Object.entries(INSTANCE)) answers.set(name, answer);
      answers.set('ListAssociationsCommand', LISTED);
      const invalid = named('InvalidDocument', 'The document AWS-RunShellScript does not exist');
      answers.set('DescribeAssociationCommand', invalid);
      await expect(
        new EC2Provider().readCurrentState('i-1', 'L', 'AWS::EC2::Instance', SSM_PROPS)
      ).rejects.toBe(invalid);
    });

    it('a DescribeInstances failure with "does not exist" text still reads as cannot-tell', async () => {
      answers.set(
        'DescribeInstancesCommand',
        named('InvalidParameterValue', 'The instance ID i-1 does not exist')
      );
      expect(
        await new EC2Provider().readCurrentState('i-1', 'L', 'AWS::EC2::Instance', SSM_PROPS)
      ).toBeUndefined();
    });

    it('an instance gone before its UserData read still reads as gone', async () => {
      for (const [name, answer] of Object.entries(INSTANCE)) answers.set(name, answer);
      send.mockImplementation(async (command: { constructor: { name: string }; input?: unknown }) => {
        const input = command.input as { Attribute?: string } | undefined;
        if (command.constructor.name === 'DescribeInstanceAttributeCommand' && input?.Attribute === 'userData') {
          throw named('InvalidInstanceID.NotFound');
        }
        const answer = answers.get(command.constructor.name);
        if (answer instanceof Error) throw answer;
        return answer ?? {};
      });
      try {
        expect(
          await new EC2Provider().readCurrentState('i-1', 'L', 'AWS::EC2::Instance', {
            UserData: 'IyEvYmluL2Jhc2g=',
          })
        ).toBe(RESOURCE_NOT_FOUND);
      } finally {
        send.mockImplementation(async (command: { constructor: { name: string } }) => {
          const answer = answers.get(command.constructor.name);
          if (answer instanceof Error) throw answer;
          return answer ?? {};
        });
      }
    });

    it('a DescribeInstances *.NotFound still reads as gone', async () => {
      answers.set('DescribeInstancesCommand', named('InvalidInstanceID.NotFound'));
      expect(
        await new EC2Provider().readCurrentState('i-1', 'L', 'AWS::EC2::Instance', SSM_PROPS)
      ).toBe(RESOURCE_NOT_FOUND);
    });
  });

  describe('Auto Scaling group', () => {
    it('a ValidationError that is not the not-found rejects', async () => {
      for (const [name, answer] of Object.entries(GROUP)) answers.set(name, answer);
      const invalid = named('ValidationError', 'Invalid parameter');
      answers.set('DescribeTrafficSourcesCommand', invalid);
      await expect(
        withClient(new ASGProvider()).readCurrentState(
          'asg',
          'L',
          'AWS::AutoScaling::AutoScalingGroup'
        )
      ).rejects.toBe(invalid);
    });

    it('a gone group is RESOURCE_NOT_FOUND even when a sub-read failed beside it', async () => {
      answers.set('DescribeAutoScalingGroupsCommand', { AutoScalingGroups: [] });
      answers.set('DescribeLifecycleHooksCommand', accessDenied());
      expect(
        await withClient(new ASGProvider()).readCurrentState(
          'asg',
          'L',
          'AWS::AutoScaling::AutoScalingGroup'
        )
      ).toBe(RESOURCE_NOT_FOUND);
    });
  });

  describe('Logs log group class', () => {
    const group = (logGroupClass: string) => ({
      DescribeLogGroupsCommand: {
        logGroups: [{ ...LOG_GROUP.DescribeLogGroupsCommand.logGroups[0], logGroupClass }],
      },
    });
    // The answer measured on an INFREQUENT_ACCESS log group.
    const standardOnly = () =>
      named('ValidationException', 'This operation is only supported on the Standard log class.');

    it('an INFREQUENT_ACCESS group keeps FieldIndexPolicies: [] on the Standard-only ValidationException', async () => {
      for (const [name, answer] of Object.entries(group('INFREQUENT_ACCESS'))) {
        answers.set(name, answer);
      }
      answers.set('DescribeIndexPoliciesCommand', standardOnly());
      const read = bag(
        await new LogsLogGroupProvider().readCurrentState('lg', 'L', 'AWS::Logs::LogGroup')
      );
      expect(read['FieldIndexPolicies']).toEqual([]);
      expect(read['DataProtectionPolicy']).toBe('');
    });

    it('a STANDARD group rejects on that ValidationException', async () => {
      for (const [name, answer] of Object.entries(group('STANDARD'))) answers.set(name, answer);
      const error = standardOnly();
      answers.set('DescribeIndexPoliciesCommand', error);
      await expect(
        new LogsLogGroupProvider().readCurrentState('lg', 'L', 'AWS::Logs::LogGroup')
      ).rejects.toBe(error);
    });

    it('a DELIVERY group keeps both placeholders on the Standard-only ValidationException from both calls', async () => {
      for (const [name, answer] of Object.entries(group('DELIVERY'))) answers.set(name, answer);
      answers.set('GetDataProtectionPolicyCommand', standardOnly());
      answers.set('DescribeIndexPoliciesCommand', standardOnly());
      const read = bag(
        await new LogsLogGroupProvider().readCurrentState('lg', 'L', 'AWS::Logs::LogGroup')
      );
      expect(read['DataProtectionPolicy']).toBe('');
      expect(read['FieldIndexPolicies']).toEqual([]);
    });

    it('a DELIVERY group rejects on another ValidationException', async () => {
      for (const [name, answer] of Object.entries(group('DELIVERY'))) answers.set(name, answer);
      const other = named('ValidationException', 'Invalid log group name');
      answers.set('GetDataProtectionPolicyCommand', other);
      await expect(
        new LogsLogGroupProvider().readCurrentState('lg', 'L', 'AWS::Logs::LogGroup')
      ).rejects.toBe(other);
    });

    it('an INFREQUENT_ACCESS group rejects on another ValidationException from DescribeIndexPolicies', async () => {
      for (const [name, answer] of Object.entries(group('INFREQUENT_ACCESS'))) {
        answers.set(name, answer);
      }
      const other = named('ValidationException', 'Invalid log group name');
      answers.set('DescribeIndexPoliciesCommand', other);
      await expect(
        new LogsLogGroupProvider().readCurrentState('lg', 'L', 'AWS::Logs::LogGroup')
      ).rejects.toBe(other);
    });

    it('a STANDARD group rejects on the Standard-only ValidationException from GetDataProtectionPolicy', async () => {
      for (const [name, answer] of Object.entries(group('STANDARD'))) answers.set(name, answer);
      const error = standardOnly();
      answers.set('GetDataProtectionPolicyCommand', error);
      await expect(
        new LogsLogGroupProvider().readCurrentState('lg', 'L', 'AWS::Logs::LogGroup')
      ).rejects.toBe(error);
    });

    it('an INFREQUENT_ACCESS group still rejects on a failed GetDataProtectionPolicy', async () => {
      for (const [name, answer] of Object.entries(group('INFREQUENT_ACCESS'))) {
        answers.set(name, answer);
      }
      const denied = accessDenied();
      answers.set('GetDataProtectionPolicyCommand', denied);
      await expect(
        new LogsLogGroupProvider().readCurrentState('lg', 'L', 'AWS::Logs::LogGroup')
      ).rejects.toBe(denied);
    });
  });
});
