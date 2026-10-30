import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockEc2Send = vi.hoisted(() => vi.fn());
const mockTrailSend = vi.hoisted(() => vi.fn());
const mockGlueSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());
const mockFirehoseSend = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: {
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('@aws-sdk/client-cloudtrail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudtrail')>();
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
      send: mockTrailSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockGlueSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
  };
});

vi.mock('@aws-sdk/client-firehose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-firehose')>();
  return {
    ...actual,
    FirehoseClient: vi.fn().mockImplementation(() => ({
      send: mockFirehoseSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { EC2Provider } from '../../../../src/provisioning/providers/ec2-provider.js';
import { CloudTrailProvider } from '../../../../src/provisioning/providers/cloudtrail-provider.js';
import {
  GlueJobProvider,
  GlueCrawlerProvider,
  GlueConnectionProvider,
  GlueTriggerProvider,
} from '../../../../src/provisioning/providers/glue-provider.js';
import { FirehoseProvider } from '../../../../src/provisioning/providers/firehose-provider.js';
import {
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  CreateTagsCommand,
} from '@aws-sdk/client-ec2';
import { CreateTrailCommand, UpdateTrailCommand } from '@aws-sdk/client-cloudtrail';
import {
  CreateJobCommand,
  UpdateJobCommand,
  CreateCrawlerCommand,
  UpdateCrawlerCommand,
  CreateConnectionCommand,
  UpdateConnectionCommand,
  CreateTriggerCommand,
  UpdateTriggerCommand,
  GetTriggerCommand,
} from '@aws-sdk/client-glue';
import {
  CreateDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  TagDeliveryStreamCommand,
} from '@aws-sdk/client-firehose';
import {
  applyDefaultNameForFallback,
  stackInstanceNameSuffix,
  withStackScope,
  withStackScopeBeforeStateRead,
} from '../../../../src/provisioning/resource-name.js';

/**
 * go-to-k/cdkd#5095: seven SDK providers used to send the BARE logical id as
 * the AWS-side name when the template left it undeclared. They now call
 * `generatedNameFor(type, logicalId)`: a legacy stack (no stack instance id)
 * keeps the bare logical id exactly as before; a stack WITH an instance id
 * gets the same generated name Cloud Control's `applyDefaultNameForFallback`
 * fills in, so the SDK and Cloud Control routes agree. This file pins both
 * routes' create() behavior and that update() still addresses the name/id
 * recorded under the OLD (bare-logical-id) behavior, never re-deriving one.
 */
const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('bare logical id -> generated name (#5095)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── AWS::EC2::SecurityGroup ──────────────────────────────────────

  describe('EC2Provider SecurityGroup', () => {
    const TYPE = 'AWS::EC2::SecurityGroup';
    const GROUP_ID = 'sg-0123456789abcdef0';
    const PROPS = { GroupDescription: 'test sg' };
    let provider: EC2Provider;

    beforeEach(() => {
      mockEc2Send.mockImplementation(async (command: unknown) => {
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: GROUP_ID };
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [{ VpcId: 'vpc-test' }] };
        }
        return {};
      });
      provider = new EC2Provider();
    });

    const sentName = (): unknown =>
      (mockEc2Send.mock.calls[0]![0] as CreateSecurityGroupCommand).input.GroupName;

    it('a legacy stack sends the bare logical id', async () => {
      const result = await withStackScope(
        { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: new Map() },
        () => provider.create('Group', TYPE, PROPS)
      );
      expect(sentName()).toBe('Group');
      expect(result.physicalId).toBe(GROUP_ID);
    });

    it('a stack with an instance id sends the suffixed name the Cloud Control rule fills', async () => {
      const scope = { stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map([['Group', 1]]) };
      await withStackScope(scope, () => provider.create('Group', TYPE, PROPS));
      expect(sentName()).toBe(`MyStack-Group-${stackInstanceNameSuffix(ID, 'Group', 1)}`);
      expect(sentName()).toBe(
        withStackScope(scope, () => applyDefaultNameForFallback('Group', TYPE, {}))['GroupName']
      );
    });

    it('a declared name is sent as declared', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() }, () =>
        provider.create('Group', TYPE, { ...PROPS, GroupName: 'mine' })
      );
      expect(sentName()).toBe('mine');
    });

    it('before the state read, refuses rather than send the bare logical id', async () => {
      await expect(
        withStackScopeBeforeStateRead('MyStack', () => provider.create('Group', TYPE, PROPS))
      ).rejects.toThrow(/derived before the state record/);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it('an update addresses the recorded group and derives no name', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: undefined }, () =>
        provider.update(
          'Group',
          GROUP_ID,
          TYPE,
          { ...PROPS, Tags: [{ Key: 'k', Value: 'v' }] },
          { ...PROPS, Tags: [] }
        )
      );
      const createCommands = mockEc2Send.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof CreateSecurityGroupCommand);
      expect(createCommands).toHaveLength(0);
      const tagCommand = mockEc2Send.mock.calls
        .map((c) => c[0] as CreateTagsCommand)
        .find((c) => c instanceof CreateTagsCommand)!;
      expect(tagCommand.input.Resources).toEqual([GROUP_ID]);
      const describeCommand = mockEc2Send.mock.calls
        .map((c) => c[0] as DescribeSecurityGroupsCommand)
        .find((c) => c instanceof DescribeSecurityGroupsCommand)!;
      expect(describeCommand.input.GroupIds).toEqual([GROUP_ID]);
    });
  });

  // ─── AWS::CloudTrail::Trail ────────────────────────────────────────

  describe('CloudTrailProvider', () => {
    const TYPE = 'AWS::CloudTrail::Trail';
    const PROPS = { S3BucketName: 'my-bucket', IsLogging: false };
    let provider: CloudTrailProvider;

    beforeEach(() => {
      mockTrailSend.mockImplementation(async (command: unknown) =>
        command instanceof CreateTrailCommand
          ? { TrailARN: `arn:aws:cloudtrail:us-east-1:123456789012:trail/${command.input.Name}` }
          : {}
      );
      provider = new CloudTrailProvider();
    });

    const sentName = (): unknown =>
      (mockTrailSend.mock.calls[0]![0] as CreateTrailCommand).input.Name;

    it('a legacy stack sends the bare logical id', async () => {
      const result = await withStackScope(
        { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: new Map() },
        () => provider.create('Trail', TYPE, PROPS)
      );
      expect(sentName()).toBe('Trail');
      expect(result.physicalId).toBe('arn:aws:cloudtrail:us-east-1:123456789012:trail/Trail');
    });

    it('a stack with an instance id sends the suffixed name the Cloud Control rule fills', async () => {
      const scope = { stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map([['Trail', 1]]) };
      await withStackScope(scope, () => provider.create('Trail', TYPE, PROPS));
      expect(sentName()).toBe(`MyStack-Trail-${stackInstanceNameSuffix(ID, 'Trail', 1)}`);
      expect(sentName()).toBe(
        withStackScope(scope, () => applyDefaultNameForFallback('Trail', TYPE, {}))['TrailName']
      );
    });

    it('a declared name is sent as declared', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() }, () =>
        provider.create('Trail', TYPE, { ...PROPS, TrailName: 'mine' })
      );
      expect(sentName()).toBe('mine');
    });

    it('before the state read, refuses rather than send the bare logical id', async () => {
      await expect(
        withStackScopeBeforeStateRead('MyStack', () => provider.create('Trail', TYPE, PROPS))
      ).rejects.toThrow(/derived before the state record/);
      expect(mockTrailSend).not.toHaveBeenCalled();
    });

    it('an update addresses the recorded trail ARN and derives no name', async () => {
      const arn = 'arn:aws:cloudtrail:us-east-1:123456789012:trail/Trail';
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: undefined }, () =>
        provider.update(
          'Trail',
          arn,
          TYPE,
          { ...PROPS, S3KeyPrefix: 'prefix/' },
          { ...PROPS, S3KeyPrefix: undefined }
        )
      );
      const createCommands = mockTrailSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof CreateTrailCommand);
      expect(createCommands).toHaveLength(0);
      const updateCommand = mockTrailSend.mock.calls
        .map((c) => c[0] as UpdateTrailCommand)
        .find((c) => c instanceof UpdateTrailCommand)!;
      expect(updateCommand.input.Name).toBe(arn);
    });
  });

  // ─── AWS::Glue::Job ─────────────────────────────────────────────────

  describe('GlueJobProvider', () => {
    const TYPE = 'AWS::Glue::Job';
    const PROPS = {
      Role: 'arn:aws:iam::123456789012:role/glue-role',
      Command: { Name: 'glueetl', ScriptLocation: 's3://bucket/script.py' },
    };
    let provider: GlueJobProvider;

    beforeEach(() => {
      mockGlueSend.mockImplementation(async () => ({}));
      provider = new GlueJobProvider();
    });

    const sentName = (): unknown =>
      (mockGlueSend.mock.calls[0]![0] as CreateJobCommand).input.Name;

    it('a legacy stack sends the bare logical id', async () => {
      const result = await withStackScope(
        { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: new Map() },
        () => provider.create('Job', TYPE, PROPS)
      );
      expect(sentName()).toBe('Job');
      expect(result.physicalId).toBe('Job');
    });

    it('a stack with an instance id sends the suffixed name the Cloud Control rule fills', async () => {
      const scope = { stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map([['Job', 1]]) };
      await withStackScope(scope, () => provider.create('Job', TYPE, PROPS));
      expect(sentName()).toBe(`MyStack-Job-${stackInstanceNameSuffix(ID, 'Job', 1)}`);
      expect(sentName()).toBe(
        withStackScope(scope, () => applyDefaultNameForFallback('Job', TYPE, {}))['Name']
      );
    });

    it('a declared name is sent as declared', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() }, () =>
        provider.create('Job', TYPE, { ...PROPS, Name: 'mine' })
      );
      expect(sentName()).toBe('mine');
    });

    it('before the state read, refuses rather than send the bare logical id', async () => {
      await expect(
        withStackScopeBeforeStateRead('MyStack', () => provider.create('Job', TYPE, PROPS))
      ).rejects.toThrow(/derived before the state record/);
      expect(mockGlueSend).not.toHaveBeenCalled();
    });

    it('an update addresses the recorded job name and derives no name', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: undefined }, () =>
        provider.update('Job', 'Job', TYPE, { ...PROPS, Description: 'new' }, PROPS)
      );
      const createCommands = mockGlueSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof CreateJobCommand);
      expect(createCommands).toHaveLength(0);
      const updateCommand = mockGlueSend.mock.calls
        .map((c) => c[0] as UpdateJobCommand)
        .find((c) => c instanceof UpdateJobCommand)!;
      expect(updateCommand.input.JobName).toBe('Job');
    });
  });

  // ─── AWS::Glue::Crawler ─────────────────────────────────────────────

  describe('GlueCrawlerProvider', () => {
    const TYPE = 'AWS::Glue::Crawler';
    const PROPS = {
      Role: 'arn:aws:iam::123456789012:role/glue-role',
      Targets: { S3Targets: [{ Path: 's3://bucket/data' }] },
    };
    let provider: GlueCrawlerProvider;

    beforeEach(() => {
      mockGlueSend.mockImplementation(async () => ({}));
      provider = new GlueCrawlerProvider();
    });

    const sentName = (): unknown =>
      (mockGlueSend.mock.calls[0]![0] as CreateCrawlerCommand).input.Name;

    it('a legacy stack sends the bare logical id', async () => {
      const result = await withStackScope(
        { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: new Map() },
        () => provider.create('Crawler', TYPE, PROPS)
      );
      expect(sentName()).toBe('Crawler');
      expect(result.physicalId).toBe('Crawler');
    });

    it('a stack with an instance id sends the suffixed name the Cloud Control rule fills', async () => {
      const scope = {
        stackName: 'MyStack',
        stackInstanceId: ID,
        nameGenerations: new Map([['Crawler', 1]]),
      };
      await withStackScope(scope, () => provider.create('Crawler', TYPE, PROPS));
      expect(sentName()).toBe(`MyStack-Crawler-${stackInstanceNameSuffix(ID, 'Crawler', 1)}`);
      expect(sentName()).toBe(
        withStackScope(scope, () => applyDefaultNameForFallback('Crawler', TYPE, {}))['Name']
      );
    });

    it('a declared name is sent as declared', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() }, () =>
        provider.create('Crawler', TYPE, { ...PROPS, Name: 'mine' })
      );
      expect(sentName()).toBe('mine');
    });

    it('before the state read, refuses rather than send the bare logical id', async () => {
      await expect(
        withStackScopeBeforeStateRead('MyStack', () => provider.create('Crawler', TYPE, PROPS))
      ).rejects.toThrow(/derived before the state record/);
      expect(mockGlueSend).not.toHaveBeenCalled();
    });

    it('an update addresses the recorded crawler name and derives no name', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: undefined }, () =>
        provider.update('Crawler', 'Crawler', TYPE, { ...PROPS, Description: 'new' }, PROPS)
      );
      const createCommands = mockGlueSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof CreateCrawlerCommand);
      expect(createCommands).toHaveLength(0);
      const updateCommand = mockGlueSend.mock.calls
        .map((c) => c[0] as UpdateCrawlerCommand)
        .find((c) => c instanceof UpdateCrawlerCommand)!;
      expect(updateCommand.input.Name).toBe('Crawler');
    });
  });

  // ─── AWS::Glue::Connection ──────────────────────────────────────────

  describe('GlueConnectionProvider', () => {
    const TYPE = 'AWS::Glue::Connection';
    const CC_PROPS = { ConnectionInput: { ConnectionType: 'JDBC' } };
    const PROPS = { ConnectionInput: { ConnectionType: 'JDBC' } };
    let provider: GlueConnectionProvider;

    beforeEach(() => {
      mockGlueSend.mockImplementation(async () => ({}));
      provider = new GlueConnectionProvider();
    });

    const sentName = (): unknown =>
      (mockGlueSend.mock.calls[0]![0] as CreateConnectionCommand).input.ConnectionInput?.Name;

    it('a legacy stack sends the bare logical id', async () => {
      const result = await withStackScope(
        { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: new Map() },
        () => provider.create('Conn', TYPE, PROPS)
      );
      expect(sentName()).toBe('Conn');
      expect(result.physicalId).toBe('Conn');
    });

    it('a stack with an instance id sends the suffixed name the Cloud Control rule fills', async () => {
      const scope = { stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map([['Conn', 1]]) };
      await withStackScope(scope, () => provider.create('Conn', TYPE, PROPS));
      expect(sentName()).toBe(`MyStack-Conn-${stackInstanceNameSuffix(ID, 'Conn', 1)}`);
      expect(sentName()).toBe(
        (
          withStackScope(scope, () => applyDefaultNameForFallback('Conn', TYPE, CC_PROPS))[
            'ConnectionInput'
          ] as Record<string, unknown>
        )['Name']
      );
    });

    it('a declared name is sent as declared', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() }, () =>
        provider.create('Conn', TYPE, {
          ConnectionInput: { ConnectionType: 'JDBC', Name: 'mine' },
        })
      );
      expect(sentName()).toBe('mine');
    });

    it('before the state read, refuses rather than send the bare logical id', async () => {
      await expect(
        withStackScopeBeforeStateRead('MyStack', () => provider.create('Conn', TYPE, PROPS))
      ).rejects.toThrow(/derived before the state record/);
      expect(mockGlueSend).not.toHaveBeenCalled();
    });

    it('an update addresses the recorded connection name and derives no name', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: undefined }, () =>
        provider.update(
          'Conn',
          'Conn',
          TYPE,
          { ConnectionInput: { ConnectionType: 'JDBC', Description: 'new' } },
          PROPS
        )
      );
      const createCommands = mockGlueSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof CreateConnectionCommand);
      expect(createCommands).toHaveLength(0);
      const updateCommand = mockGlueSend.mock.calls
        .map((c) => c[0] as UpdateConnectionCommand)
        .find((c) => c instanceof UpdateConnectionCommand)!;
      expect(updateCommand.input.Name).toBe('Conn');
      expect(updateCommand.input.ConnectionInput?.Name).toBe('Conn');
    });
  });

  // ─── AWS::Glue::Trigger ─────────────────────────────────────────────

  describe('GlueTriggerProvider', () => {
    const TYPE = 'AWS::Glue::Trigger';
    const PROPS = { Type: 'ON_DEMAND', Actions: [{ JobName: 'SomeJob' }] };
    let provider: GlueTriggerProvider;

    beforeEach(() => {
      mockGlueSend.mockImplementation(async (command: unknown) =>
        command instanceof GetTriggerCommand ? { Trigger: { State: 'CREATED' } } : {}
      );
      provider = new GlueTriggerProvider();
    });

    const sentName = (): unknown =>
      (mockGlueSend.mock.calls[0]![0] as CreateTriggerCommand).input.Name;

    it('a legacy stack sends the bare logical id', async () => {
      const result = await withStackScope(
        { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: new Map() },
        () => provider.create('Trigger', TYPE, PROPS)
      );
      expect(sentName()).toBe('Trigger');
      expect(result.physicalId).toBe('Trigger');
    });

    it('a stack with an instance id sends the suffixed name the Cloud Control rule fills', async () => {
      const scope = {
        stackName: 'MyStack',
        stackInstanceId: ID,
        nameGenerations: new Map([['Trigger', 1]]),
      };
      await withStackScope(scope, () => provider.create('Trigger', TYPE, PROPS));
      expect(sentName()).toBe(`MyStack-Trigger-${stackInstanceNameSuffix(ID, 'Trigger', 1)}`);
      expect(sentName()).toBe(
        withStackScope(scope, () => applyDefaultNameForFallback('Trigger', TYPE, {}))['Name']
      );
    });

    it('a declared name is sent as declared', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() }, () =>
        provider.create('Trigger', TYPE, { ...PROPS, Name: 'mine' })
      );
      expect(sentName()).toBe('mine');
    });

    it('before the state read, refuses rather than send the bare logical id', async () => {
      await expect(
        withStackScopeBeforeStateRead('MyStack', () => provider.create('Trigger', TYPE, PROPS))
      ).rejects.toThrow(/derived before the state record/);
      expect(mockGlueSend).not.toHaveBeenCalled();
    });

    it('an update addresses the recorded trigger name and derives no name', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: undefined }, () =>
        provider.update('Trigger', 'Trigger', TYPE, { ...PROPS, Description: 'new' }, PROPS)
      );
      const createCommands = mockGlueSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof CreateTriggerCommand);
      expect(createCommands).toHaveLength(0);
      const updateCommand = mockGlueSend.mock.calls
        .map((c) => c[0] as UpdateTriggerCommand)
        .find((c) => c instanceof UpdateTriggerCommand)!;
      expect(updateCommand.input.Name).toBe('Trigger');
    });
  });

  // ─── AWS::KinesisFirehose::DeliveryStream ──────────────────────────

  describe('FirehoseProvider', () => {
    const TYPE = 'AWS::KinesisFirehose::DeliveryStream';
    const PROPS = {};
    let provider: FirehoseProvider;

    beforeEach(() => {
      mockFirehoseSend.mockImplementation(async (command: unknown) =>
        command instanceof DescribeDeliveryStreamCommand
          ? { DeliveryStreamDescription: { DeliveryStreamStatus: 'ACTIVE' } }
          : {}
      );
      provider = new FirehoseProvider();
    });

    const sentName = (): unknown =>
      (mockFirehoseSend.mock.calls[0]![0] as CreateDeliveryStreamCommand).input.DeliveryStreamName;

    it('a legacy stack sends the bare logical id', async () => {
      const result = await withStackScope(
        { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: new Map() },
        () => provider.create('Stream', TYPE, PROPS)
      );
      expect(sentName()).toBe('Stream');
      expect(result.physicalId).toBe('Stream');
    });

    it('a legacy stack also falls back on an empty-string DeliveryStreamName', async () => {
      await withStackScope(
        { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: new Map() },
        () => provider.create('Stream', TYPE, { ...PROPS, DeliveryStreamName: '' })
      );
      expect(sentName()).toBe('Stream');
    });

    it('a stack with an instance id sends the suffixed name the Cloud Control rule fills', async () => {
      const scope = {
        stackName: 'MyStack',
        stackInstanceId: ID,
        nameGenerations: new Map([['Stream', 1]]),
      };
      await withStackScope(scope, () => provider.create('Stream', TYPE, PROPS));
      expect(sentName()).toBe(`MyStack-Stream-${stackInstanceNameSuffix(ID, 'Stream', 1)}`);
      expect(sentName()).toBe(
        withStackScope(scope, () => applyDefaultNameForFallback('Stream', TYPE, {}))[
          'DeliveryStreamName'
        ]
      );
    });

    it('a declared name is sent as declared', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() }, () =>
        provider.create('Stream', TYPE, { ...PROPS, DeliveryStreamName: 'mine' })
      );
      expect(sentName()).toBe('mine');
    });

    it('before the state read, refuses rather than send the bare logical id', async () => {
      await expect(
        withStackScopeBeforeStateRead('MyStack', () => provider.create('Stream', TYPE, PROPS))
      ).rejects.toThrow(/derived before the state record/);
      expect(mockFirehoseSend).not.toHaveBeenCalled();
    });

    it('an update addresses the recorded stream name and derives no name', async () => {
      await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: undefined }, () =>
        provider.update(
          'Stream',
          'Stream',
          TYPE,
          { ...PROPS, Tags: [{ Key: 'k', Value: 'v' }] },
          { ...PROPS, Tags: [] }
        )
      );
      const createCommands = mockFirehoseSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof CreateDeliveryStreamCommand);
      expect(createCommands).toHaveLength(0);
      const tagCommand = mockFirehoseSend.mock.calls
        .map((c) => c[0] as TagDeliveryStreamCommand)
        .find((c) => c instanceof TagDeliveryStreamCommand)!;
      expect(tagCommand.input.DeliveryStreamName).toBe('Stream');
    });
  });
});
