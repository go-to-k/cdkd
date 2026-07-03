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
  UpdateTimeToLiveCommand,
  ListTagsOfResourceCommand,
  ResourceNotFoundException,
  UpdateTableCommand,
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

import {
  DynamoDBTableProvider,
  mapSSESpecification,
} from '../../../../src/provisioning/providers/dynamodb-table-provider.js';

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

const countOfCommand = (Command: new (input: never) => unknown): number =>
  mockSend.mock.calls.filter((call) => call[0] instanceof Command).length;

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

    it('throws (does not silently skip) when a ResourcePolicy change is detected but DescribeTable returns no TableArn', async () => {
      const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Allow' }] };
      // DescribeTable response missing TableArn (transient/partial response).
      mockSend.mockResolvedValueOnce({ Table: {} });

      await expect(
        provider.update(
          'MyTable',
          'MyTable',
          'AWS::DynamoDB::Table',
          { ...baseCreateProps, ResourcePolicy: { PolicyDocument: doc } },
          { ...baseCreateProps }
        )
      ).rejects.toThrow(/no TableArn/);

      expect(commandSent(PutResourcePolicyCommand)).toBe(false);
    });
  });

  describe('TimeToLiveSpecification', () => {
    const ttl = (attr: string, enabled = true) => ({ AttributeName: attr, Enabled: enabled });

    it('throws an actionable error when the TTL AttributeName changes between two enabled specs', async () => {
      mockSend.mockResolvedValueOnce(activeTable()); // DescribeTable

      await expect(
        provider.update(
          'MyTable',
          'MyTable',
          'AWS::DynamoDB::Table',
          { ...baseCreateProps, TimeToLiveSpecification: ttl('newTtl') },
          { ...baseCreateProps, TimeToLiveSpecification: ttl('oldTtl') }
        )
      ).rejects.toThrow(/cannot change the TimeToLive AttributeName from 'oldTtl' to 'newTtl'/);

      // Must NOT have attempted the doomed UpdateTimeToLive call.
      expect(commandSent(UpdateTimeToLiveCommand)).toBe(false);
    });

    it('does not double-wrap the actionable error behind "Failed to update"', async () => {
      mockSend.mockResolvedValueOnce(activeTable()); // DescribeTable

      const err = await provider
        .update(
          'MyTable',
          'MyTable',
          'AWS::DynamoDB::Table',
          { ...baseCreateProps, TimeToLiveSpecification: ttl('newTtl') },
          { ...baseCreateProps, TimeToLiveSpecification: ttl('oldTtl') }
        )
        .catch((e: Error) => e);
      expect((err as Error).message).toMatch(/two deploys/);
      expect((err as Error).message).not.toMatch(/Failed to update DynamoDB table/);
    });

    it('allows enabling TTL when previously absent (passes through to UpdateTimeToLive)', async () => {
      mockSend
        .mockResolvedValueOnce(activeTable()) // DescribeTable
        .mockResolvedValueOnce({}); // UpdateTimeToLive

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, TimeToLiveSpecification: ttl('ttlAttr') },
        { ...baseCreateProps }
      );

      const input = inputOfCommand(UpdateTimeToLiveCommand) as {
        TimeToLiveSpecification?: { Enabled?: boolean; AttributeName?: string };
      };
      expect(input.TimeToLiveSpecification).toEqual({ Enabled: true, AttributeName: 'ttlAttr' });
    });

    it('allows enabling TTL on a new attribute when the previous spec was disabled', async () => {
      mockSend
        .mockResolvedValueOnce(activeTable()) // DescribeTable
        .mockResolvedValueOnce({}); // UpdateTimeToLive

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, TimeToLiveSpecification: ttl('newTtl') },
        { ...baseCreateProps, TimeToLiveSpecification: ttl('oldTtl', false) }
      );

      expect(commandSent(UpdateTimeToLiveCommand)).toBe(true);
    });

    it('treats a stringified Enabled:"false" as disabled (no spurious guard fire on a disable+rename)', async () => {
      mockSend
        .mockResolvedValueOnce(activeTable()) // DescribeTable
        .mockResolvedValueOnce({}); // UpdateTimeToLive (disable on ttlB)

      // New spec renames to ttlB but disables via the stringified "false"
      // (hand-written L1 shape). Since the new spec is DISABLED, the
      // attribute-name-change guard must NOT fire.
      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, TimeToLiveSpecification: { AttributeName: 'ttlB', Enabled: 'false' } },
        { ...baseCreateProps, TimeToLiveSpecification: ttl('ttlA') }
      );

      expect(commandSent(UpdateTimeToLiveCommand)).toBe(true);
    });

    it('allows disabling TTL (removal) without throwing', async () => {
      mockSend
        .mockResolvedValueOnce(activeTable()) // DescribeTable
        .mockResolvedValueOnce({}); // UpdateTimeToLive (disable)

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps },
        { ...baseCreateProps, TimeToLiveSpecification: ttl('oldTtl') }
      );

      const input = inputOfCommand(UpdateTimeToLiveCommand) as {
        TimeToLiveSpecification?: { Enabled?: boolean; AttributeName?: string };
      };
      expect(input.TimeToLiveSpecification).toEqual({ Enabled: false, AttributeName: 'oldTtl' });
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

  describe('SSESpecification (SSEEnabled -> Enabled mapping)', () => {
    it('maps CFn SSEEnabled to the SDK Enabled field on CreateTable', async () => {
      mockSend
        .mockResolvedValueOnce({}) // CreateTable
        .mockResolvedValueOnce(activeTable()); // waitForTableActive

      await provider.create('MyTable', 'AWS::DynamoDB::Table', {
        ...baseCreateProps,
        SSESpecification: { SSEEnabled: true },
      });

      const createInput = inputOfCommand(CreateTableCommand) as {
        SSESpecification?: Record<string, unknown>;
      };
      // The SDK field is `Enabled`, not `SSEEnabled` — passing the CFn shape
      // verbatim (the bug) would leave Enabled undefined and silently create an
      // AWS-owned-encrypted table.
      expect(createInput.SSESpecification).toEqual({ Enabled: true });
      expect(createInput.SSESpecification).not.toHaveProperty('SSEEnabled');
    });

    it('mapSSESpecification maps SSEEnabled/SSEType/KMSMasterKeyId and tolerates absent/non-object', () => {
      expect(mapSSESpecification({ SSEEnabled: true })).toEqual({ Enabled: true });
      expect(
        mapSSESpecification({
          SSEEnabled: true,
          SSEType: 'KMS',
          KMSMasterKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
        })
      ).toEqual({
        Enabled: true,
        SSEType: 'KMS',
        KMSMasterKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
      });
      // Stringified boolean tolerance.
      expect(mapSSESpecification({ SSEEnabled: 'true' })).toEqual({ Enabled: true });
      expect(mapSSESpecification({ SSEEnabled: 'false' })).toEqual({ Enabled: false });
      // Absent / non-object -> undefined (caller omits the field).
      expect(mapSSESpecification(undefined)).toBeUndefined();
      expect(mapSSESpecification(null)).toBeUndefined();
      expect(mapSSESpecification('nope')).toBeUndefined();
    });

    it('applies an SSESpecification change on update via its own UpdateTable (mapped Enabled)', async () => {
      mockSend
        .mockResolvedValueOnce(activeTable()) // DescribeTable (update reads current)
        .mockResolvedValueOnce({}) // UpdateTable (SSE)
        .mockResolvedValueOnce(activeTable()); // waitForTableActiveAfterUpdate

      // Only SSESpecification differs between prev and new, so only the SSE
      // branch fires (no billing/throughput/GSI UpdateTable).
      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        {
          ...baseCreateProps,
          SSESpecification: {
            SSEEnabled: true,
            SSEType: 'KMS',
            KMSMasterKeyId: 'arn:aws:kms:us-east-1:123456789012:key/new',
          },
        },
        { ...baseCreateProps, SSESpecification: { SSEEnabled: true } }
      );

      const sseUpdate = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (cmd) =>
            cmd instanceof UpdateTableCommand &&
            (cmd as { input?: { SSESpecification?: unknown } }).input?.SSESpecification
        ) as { input: { SSESpecification: Record<string, unknown> } } | undefined;
      expect(sseUpdate).toBeDefined();
      expect(sseUpdate!.input.SSESpecification).toEqual({
        Enabled: true,
        SSEType: 'KMS',
        KMSMasterKeyId: 'arn:aws:kms:us-east-1:123456789012:key/new',
      });
    });

    it('does NOT fire an UpdateTable when SSESpecification is unchanged', async () => {
      mockSend.mockResolvedValueOnce(activeTable()); // DescribeTable only

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, SSESpecification: { SSEEnabled: true } },
        { ...baseCreateProps, SSESpecification: { SSEEnabled: true } }
      );

      const sseUpdate = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (cmd) =>
            cmd instanceof UpdateTableCommand &&
            (cmd as { input?: { SSESpecification?: unknown } }).input?.SSESpecification
        );
      expect(sseUpdate).toBeUndefined();
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

  describe('TableClass update (silent-drop regression)', () => {
    beforeEach(() => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeTableCommand) return Promise.resolve(activeTable());
        return Promise.resolve({});
      });
    });

    it('sends TableClass via UpdateTable on a class-only change, without re-asserting throughput', async () => {
      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
        { ...baseCreateProps, TableClass: 'STANDARD' }
      );

      const input = inputOfCommand(UpdateTableCommand) as {
        TableClass?: string;
        BillingMode?: string;
        ProvisionedThroughput?: unknown;
      };
      expect(input.TableClass).toBe('STANDARD_INFREQUENT_ACCESS');
      // Class-only change: unchanged BillingMode / throughput must NOT ride
      // along (AWS rejects an UpdateTable re-asserting the current values).
      expect(input.BillingMode).toBeUndefined();
      expect(input.ProvisionedThroughput).toBeUndefined();
    });

    it('reverts to STANDARD when the TableClass property is removed', async () => {
      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps },
        { ...baseCreateProps, TableClass: 'STANDARD_INFREQUENT_ACCESS' }
      );

      const input = inputOfCommand(UpdateTableCommand) as {
        TableClass?: string;
        BillingMode?: string;
        ProvisionedThroughput?: unknown;
      };
      expect(input.TableClass).toBe('STANDARD');
      // The revert is a class-only change: unchanged BillingMode / throughput
      // must NOT ride along (AWS rejects an UpdateTable re-asserting current
      // values). Removing TableClass alone must not reopen the throughput path.
      expect(input.BillingMode).toBeUndefined();
      expect(input.ProvisionedThroughput).toBeUndefined();
    });

    it('does not send TableClass (or any UpdateTable) when the class is unchanged', async () => {
      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, TableClass: 'STANDARD' },
        { ...baseCreateProps, TableClass: 'STANDARD' }
      );

      expect(commandSent(UpdateTableCommand)).toBe(false);
    });

    it('treats an explicit-STANDARD <-> absent transition as no change (no doomed same-class UpdateTable)', async () => {
      // Both sides mean the DynamoDB default class; a template edit that
      // merely adds or removes the explicit STANDARD must not issue an
      // UpdateTable re-asserting the class AWS already has.
      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps },
        { ...baseCreateProps, TableClass: 'STANDARD' }
      );
      expect(commandSent(UpdateTableCommand)).toBe(false);

      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...baseCreateProps, TableClass: 'STANDARD' },
        { ...baseCreateProps }
      );
      expect(commandSent(UpdateTableCommand)).toBe(false);
    });

    it('does not re-assert unchanged PROVISIONED throughput on a class-only change', async () => {
      // The PT/billing fields are gated on their own change detection —
      // AWS rejects an UpdateTable whose requested throughput equals the
      // table's current value, so a class-only change must not carry them.
      const provisioned = {
        ...baseCreateProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
      };
      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        { ...provisioned, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
        { ...provisioned, TableClass: 'STANDARD' }
      );

      const input = inputOfCommand(UpdateTableCommand) as {
        TableClass?: string;
        BillingMode?: string;
        ProvisionedThroughput?: unknown;
      };
      expect(input.TableClass).toBe('STANDARD_INFREQUENT_ACCESS');
      expect(input.BillingMode).toBeUndefined();
      expect(input.ProvisionedThroughput).toBeUndefined();
    });

    it('combines TableClass with a real BillingMode switch in one UpdateTable', async () => {
      await provider.update(
        'MyTable',
        'MyTable',
        'AWS::DynamoDB::Table',
        {
          ...baseCreateProps,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
          TableClass: 'STANDARD_INFREQUENT_ACCESS',
        },
        { ...baseCreateProps, TableClass: 'STANDARD' }
      );

      const input = inputOfCommand(UpdateTableCommand) as {
        TableClass?: string;
        BillingMode?: string;
        ProvisionedThroughput?: { ReadCapacityUnits?: number };
      };
      expect(input.TableClass).toBe('STANDARD_INFREQUENT_ACCESS');
      expect(input.BillingMode).toBe('PROVISIONED');
      expect(input.ProvisionedThroughput?.ReadCapacityUnits).toBe(2);
      // The class change and the billing switch must be folded into a SINGLE
      // UpdateTable — DynamoDB rejects a second UpdateTable while the first is
      // still applying, so a two-call implementation would fail the deploy.
      expect(countOfCommand(UpdateTableCommand)).toBe(1);
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
