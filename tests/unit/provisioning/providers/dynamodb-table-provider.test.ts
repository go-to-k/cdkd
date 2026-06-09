import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  PutResourcePolicyCommand,
  DeleteResourcePolicyCommand,
  GetResourcePolicyCommand,
  EnableKinesisStreamingDestinationCommand,
  DisableKinesisStreamingDestinationCommand,
  DescribeKinesisStreamingDestinationCommand,
  UpdateContributorInsightsCommand,
  DescribeContributorInsightsCommand,
  DescribeContinuousBackupsCommand,
  DescribeTimeToLiveCommand,
  ListTagsOfResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
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

import { DynamoDBTableProvider } from '../../../../src/provisioning/providers/dynamodb-table-provider.js';

// Helper: a minimal ACTIVE DescribeTable response.
const activeTable = (overrides: Record<string, unknown> = {}) => ({
  Table: {
    TableStatus: 'ACTIVE',
    TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/MyTable',
    TableId: 'id-1',
    ...overrides,
  },
});

const baseCreateProps = {
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
};

// Pull the input object out of the Nth send() call matching a command class.
const inputOfCommand = (Command: new (input: never) => unknown): unknown => {
  for (const call of mockSend.mock.calls) {
    if (call[0] instanceof Command) return (call[0] as { input: unknown }).input;
  }
  return undefined;
};

const commandSent = (Command: new (input: never) => unknown): boolean =>
  mockSend.mock.calls.some((call) => call[0] instanceof Command);

describe('DynamoDBTableProvider backfill (#609)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  describe('handledProperties / unhandledByDesign', () => {
    it('declares the three wired props as handled', () => {
      const handled = provider.handledProperties.get('AWS::DynamoDB::Table');
      expect(handled?.has('ResourcePolicy')).toBe(true);
      expect(handled?.has('KinesisStreamSpecification')).toBe(true);
      expect(handled?.has('ContributorInsightsSpecification')).toBe(true);
    });

    it('declares ImportSourceSpecification as unhandledByDesign with a rationale', () => {
      const unhandled = provider.unhandledByDesign.get('AWS::DynamoDB::Table');
      expect(unhandled?.has('ImportSourceSpecification')).toBe(true);
      expect(unhandled?.get('ImportSourceSpecification')).toMatch(/ImportTable API/);
    });
  });

  describe('ResourcePolicy', () => {
    it('rides on CreateTable as a serialized JSON string', async () => {
      const doc = { Version: '2012-10-17', Statement: [] };
      mockSend
        .mockResolvedValueOnce({}) // CreateTable
        .mockResolvedValueOnce(activeTable()); // waitForTableActive

      await provider.create('MyTable', 'AWS::DynamoDB::Table', {
        ...baseCreateProps,
        ResourcePolicy: { PolicyDocument: doc },
      });

      const input = inputOfCommand(CreateTableCommand) as { ResourcePolicy?: string };
      expect(input.ResourcePolicy).toBe(JSON.stringify(doc));
    });

    it('passes a string PolicyDocument through verbatim on create', async () => {
      const docStr = '{"Version":"2012-10-17","Statement":[]}';
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(activeTable());

      await provider.create('MyTable', 'AWS::DynamoDB::Table', {
        ...baseCreateProps,
        ResourcePolicy: { PolicyDocument: docStr },
      });

      const input = inputOfCommand(CreateTableCommand) as { ResourcePolicy?: string };
      expect(input.ResourcePolicy).toBe(docStr);
    });

    it('uses PutResourcePolicy on update when the policy changes', async () => {
      const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Allow' }] };
      mockSend
        .mockResolvedValueOnce(activeTable()) // DescribeTable
        .mockResolvedValueOnce({}); // PutResourcePolicy

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, ResourcePolicy: { PolicyDocument: doc } },
        { ...baseCreateProps }
      );

      const input = inputOfCommand(PutResourcePolicyCommand) as {
        ResourceArn?: string;
        Policy?: string;
      };
      expect(input.Policy).toBe(JSON.stringify(doc));
      expect(input.ResourceArn).toBe('arn:aws:dynamodb:us-east-1:123456789012:table/MyTable');
    });

    it('uses DeleteResourcePolicy on update when the policy is removed', async () => {
      const doc = { Version: '2012-10-17', Statement: [] };
      mockSend
        .mockResolvedValueOnce(activeTable()) // DescribeTable
        .mockResolvedValueOnce({}); // DeleteResourcePolicy

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps },
        { ...baseCreateProps, ResourcePolicy: { PolicyDocument: doc } }
      );

      expect(commandSent(DeleteResourcePolicyCommand)).toBe(true);
    });

    it('does not touch the policy on update when unchanged', async () => {
      const doc = { Version: '2012-10-17', Statement: [] };
      mockSend.mockResolvedValueOnce(activeTable());

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, ResourcePolicy: { PolicyDocument: doc } },
        { ...baseCreateProps, ResourcePolicy: { PolicyDocument: doc } }
      );

      expect(commandSent(PutResourcePolicyCommand)).toBe(false);
      expect(commandSent(DeleteResourcePolicyCommand)).toBe(false);
    });
  });

  describe('KinesisStreamSpecification', () => {
    it('enables streaming as a post-ACTIVE control-plane call on create', async () => {
      mockSend
        .mockResolvedValueOnce({}) // CreateTable
        .mockResolvedValueOnce(activeTable()) // waitForTableActive
        .mockResolvedValueOnce({}); // EnableKinesisStreamingDestination

      await provider.create('MyTable', 'AWS::DynamoDB::Table', {
        ...baseCreateProps,
        KinesisStreamSpecification: {
          StreamArn: 'arn:aws:kinesis:us-east-1:123456789012:stream/s1',
          ApproximateCreationDateTimePrecision: 'MICROSECOND',
        },
      });

      // Kinesis enable must NOT ride on CreateTable.
      const createInput = inputOfCommand(CreateTableCommand) as Record<string, unknown>;
      expect(createInput['KinesisStreamSpecification']).toBeUndefined();

      const input = inputOfCommand(EnableKinesisStreamingDestinationCommand) as {
        StreamArn?: string;
        EnableKinesisStreamingConfiguration?: { ApproximateCreationDateTimePrecision?: string };
      };
      expect(input.StreamArn).toBe('arn:aws:kinesis:us-east-1:123456789012:stream/s1');
      expect(input.EnableKinesisStreamingConfiguration?.ApproximateCreationDateTimePrecision).toBe(
        'MICROSECOND'
      );
    });

    it('disables the previous stream and enables the new one when the ARN changes on update', async () => {
      mockSend
        .mockResolvedValueOnce(activeTable()) // DescribeTable
        .mockResolvedValueOnce({}) // Disable
        .mockResolvedValueOnce({}); // Enable

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, KinesisStreamSpecification: { StreamArn: 'arn:new' } },
        { ...baseCreateProps, KinesisStreamSpecification: { StreamArn: 'arn:old' } }
      );

      const disable = inputOfCommand(DisableKinesisStreamingDestinationCommand) as {
        StreamArn?: string;
      };
      const enable = inputOfCommand(EnableKinesisStreamingDestinationCommand) as {
        StreamArn?: string;
      };
      expect(disable.StreamArn).toBe('arn:old');
      expect(enable.StreamArn).toBe('arn:new');
    });

    it('disables streaming on update when the spec is removed', async () => {
      mockSend
        .mockResolvedValueOnce(activeTable()) // DescribeTable
        .mockResolvedValueOnce({}); // Disable

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps },
        { ...baseCreateProps, KinesisStreamSpecification: { StreamArn: 'arn:old' } }
      );

      expect(commandSent(DisableKinesisStreamingDestinationCommand)).toBe(true);
      expect(commandSent(EnableKinesisStreamingDestinationCommand)).toBe(false);
    });

    it('is a no-op on update when the stream ARN is unchanged', async () => {
      mockSend.mockResolvedValueOnce(activeTable());

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, KinesisStreamSpecification: { StreamArn: 'arn:same' } },
        { ...baseCreateProps, KinesisStreamSpecification: { StreamArn: 'arn:same' } }
      );

      expect(commandSent(EnableKinesisStreamingDestinationCommand)).toBe(false);
      expect(commandSent(DisableKinesisStreamingDestinationCommand)).toBe(false);
    });
  });

  describe('ContributorInsightsSpecification', () => {
    it('enables contributor insights with the mode on create', async () => {
      mockSend
        .mockResolvedValueOnce({}) // CreateTable
        .mockResolvedValueOnce(activeTable()) // waitForTableActive
        .mockResolvedValueOnce({}); // UpdateContributorInsights

      await provider.create('MyTable', 'AWS::DynamoDB::Table', {
        ...baseCreateProps,
        ContributorInsightsSpecification: { Enabled: true, Mode: 'ACCESSED_AND_THROTTLED_KEYS' },
      });

      const input = inputOfCommand(UpdateContributorInsightsCommand) as {
        ContributorInsightsAction?: string;
        ContributorInsightsMode?: string;
      };
      expect(input.ContributorInsightsAction).toBe('ENABLE');
      expect(input.ContributorInsightsMode).toBe('ACCESSED_AND_THROTTLED_KEYS');
    });

    it('omits Mode and sends DISABLE when Enabled is false', async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(activeTable()).mockResolvedValueOnce({});

      await provider.create('MyTable', 'AWS::DynamoDB::Table', {
        ...baseCreateProps,
        ContributorInsightsSpecification: { Enabled: false, Mode: 'THROTTLED_KEYS' },
      });

      const input = inputOfCommand(UpdateContributorInsightsCommand) as {
        ContributorInsightsAction?: string;
        ContributorInsightsMode?: string;
      };
      expect(input.ContributorInsightsAction).toBe('DISABLE');
      expect(input.ContributorInsightsMode).toBeUndefined();
    });

    it('disables insights on update when the spec is removed', async () => {
      mockSend.mockResolvedValueOnce(activeTable()).mockResolvedValueOnce({});

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps },
        { ...baseCreateProps, ContributorInsightsSpecification: { Enabled: true } }
      );

      const input = inputOfCommand(UpdateContributorInsightsCommand) as {
        ContributorInsightsAction?: string;
      };
      expect(input.ContributorInsightsAction).toBe('DISABLE');
    });
  });

  describe('readCurrentState emit-when-present', () => {
    // readCurrentState issues: DescribeTable, ListTagsOfResource,
    // DescribeContinuousBackups, DescribeTimeToLive, GetResourcePolicy,
    // DescribeKinesisStreamingDestination, DescribeContributorInsights.
    // We resolve each by command class so ordering changes don't break the test.
    const wireReadbacks = (opts: {
      policy?: string;
      kinesis?: Array<Record<string, unknown>>;
      ciStatus?: string;
      ciMode?: string;
    }) => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeTableCommand) return Promise.resolve(activeTable());
        if (cmd instanceof ListTagsOfResourceCommand) return Promise.resolve({ Tags: [] });
        if (cmd instanceof DescribeContinuousBackupsCommand) return Promise.resolve({});
        if (cmd instanceof DescribeTimeToLiveCommand) return Promise.resolve({});
        if (cmd instanceof GetResourcePolicyCommand) {
          if (opts.policy) return Promise.resolve({ Policy: opts.policy });
          return Promise.reject(new ResourceNotFoundException({ message: 'no policy', $metadata: {} }));
        }
        if (cmd instanceof DescribeKinesisStreamingDestinationCommand) {
          return Promise.resolve({ KinesisDataStreamDestinations: opts.kinesis ?? [] });
        }
        if (cmd instanceof DescribeContributorInsightsCommand) {
          return Promise.resolve({
            ContributorInsightsStatus: opts.ciStatus,
            ContributorInsightsMode: opts.ciMode,
          });
        }
        return Promise.resolve({});
      });
    };

    it('surfaces ResourcePolicy as a parsed PolicyDocument when attached', async () => {
      const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Allow' }] };
      wireReadbacks({ policy: JSON.stringify(doc) });

      const state = await provider.readCurrentState('MyTable', 'MyTable', 'AWS::DynamoDB::Table');
      expect(state?.['ResourcePolicy']).toEqual({ PolicyDocument: doc });
    });

    it('omits ResourcePolicy when no policy is attached', async () => {
      wireReadbacks({});
      const state = await provider.readCurrentState('MyTable', 'MyTable', 'AWS::DynamoDB::Table');
      expect(state).not.toHaveProperty('ResourcePolicy');
    });

    it('surfaces KinesisStreamSpecification only for an ACTIVE destination', async () => {
      wireReadbacks({
        kinesis: [
          { StreamArn: 'arn:disabled', DestinationStatus: 'DISABLED' },
          {
            StreamArn: 'arn:active',
            DestinationStatus: 'ACTIVE',
            ApproximateCreationDateTimePrecision: 'MILLISECOND',
          },
        ],
      });

      const state = await provider.readCurrentState('MyTable', 'MyTable', 'AWS::DynamoDB::Table');
      expect(state?.['KinesisStreamSpecification']).toEqual({
        StreamArn: 'arn:active',
        ApproximateCreationDateTimePrecision: 'MILLISECOND',
      });
    });

    it('omits KinesisStreamSpecification when no ACTIVE destination exists', async () => {
      wireReadbacks({ kinesis: [{ StreamArn: 'arn:x', DestinationStatus: 'DISABLED' }] });
      const state = await provider.readCurrentState('MyTable', 'MyTable', 'AWS::DynamoDB::Table');
      expect(state).not.toHaveProperty('KinesisStreamSpecification');
    });

    it('surfaces ContributorInsightsSpecification with Mode when ENABLED', async () => {
      wireReadbacks({ ciStatus: 'ENABLED', ciMode: 'THROTTLED_KEYS' });
      const state = await provider.readCurrentState('MyTable', 'MyTable', 'AWS::DynamoDB::Table');
      expect(state?.['ContributorInsightsSpecification']).toEqual({
        Enabled: true,
        Mode: 'THROTTLED_KEYS',
      });
    });

    it('surfaces ContributorInsightsSpecification without Mode when DISABLED', async () => {
      wireReadbacks({ ciStatus: 'DISABLED', ciMode: 'THROTTLED_KEYS' });
      const state = await provider.readCurrentState('MyTable', 'MyTable', 'AWS::DynamoDB::Table');
      expect(state?.['ContributorInsightsSpecification']).toEqual({ Enabled: false });
    });

    it('omits ContributorInsightsSpecification while ENABLING (transient)', async () => {
      wireReadbacks({ ciStatus: 'ENABLING' });
      const state = await provider.readCurrentState('MyTable', 'MyTable', 'AWS::DynamoDB::Table');
      expect(state).not.toHaveProperty('ContributorInsightsSpecification');
    });
  });
});
