import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableBucketCommand,
  GetTableBucketLoggingCommand,
  NotFoundException,
  PutTableBucketLoggingCommand,
  PutTableBucketReplicationCommand,
} from '@aws-sdk/client-s3tables';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3tables', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3tables')>(
    '@aws-sdk/client-s3tables'
  );
  class MockS3TablesClient {
    config = { region: () => Promise.resolve('us-east-1') };
    send = mockSend;
  }
  return { ...actual, S3TablesClient: MockS3TablesClient };
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

import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

/**
 * go-to-k/cdkd#6167: the TableBucket's `LoggingConfiguration`, written by
 * PutTableBucketLogging (it has no CreateTableBucket member) after the create
 * and on an update, turned off by the empty status on a removal, and read
 * back by GetTableBucketLogging only while logging is on.
 */

const BUCKET = 'AWS::S3Tables::TableBucket';
const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/tb';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/r';
const DEST_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/dest';

const LOGGING = {
  TargetBucket: 'log-bucket',
  TargetPrefix: 'logs/',
  TargetObjectKeyFormat: { PartitionedPrefix: { PartitionDateSource: 'EventTime' } },
};
const SDK_LOGGING = {
  loggingEnabled: {
    targetBucket: 'log-bucket',
    targetPrefix: 'logs/',
    targetObjectKeyFormat: { partitionedPrefix: { partitionDateSource: 'EventTime' } },
  },
};

const notFound = (): NotFoundException => new NotFoundException({ message: 'nf', $metadata: {} });

/** Every request sent, as `[command name, input]`. */
const sent = (): [string, unknown][] =>
  mockSend.mock.calls.map((c) => [c[0].constructor.name, c[0].input]);

/** Answer every command by its name; an unnamed one answers NotFound (unset). */
function answerByCommand(answers: Record<string, () => unknown>): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    const answer = answers[command.constructor.name];
    return answer ? Promise.resolve().then(answer) : Promise.reject(notFound());
  });
}

describe('AWS::S3Tables::TableBucket LoggingConfiguration (go-to-k/cdkd#6167)', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new S3TablesProvider();
  });

  it('is a handled property, so it no longer routes the bucket to Cloud Control', () => {
    expect(provider.handledProperties.get(BUCKET)?.has('LoggingConfiguration')).toBe(true);
  });

  describe('create', () => {
    it('sends it by PutTableBucketLogging after CreateTableBucket and the other configuration calls', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      mockSend.mockResolvedValue({});

      await provider.create('B', BUCKET, {
        TableBucketName: 'tb',
        ReplicationConfiguration: {
          Role: ROLE_ARN,
          Rules: [{ Destinations: [{ DestinationTableBucketARN: DEST_ARN }] }],
        },
        LoggingConfiguration: structuredClone(LOGGING),
      });

      expect(sent().map(([name]) => name)).toEqual([
        CreateTableBucketCommand.name,
        PutTableBucketReplicationCommand.name,
        PutTableBucketLoggingCommand.name,
      ]);
      expect(sent()[0]?.[1]).not.toHaveProperty('loggingConfiguration');
      expect(sent()[2]).toEqual([
        PutTableBucketLoggingCommand.name,
        { tableBucketARN: BUCKET_ARN, tableBucketLoggingStatus: SDK_LOGGING },
      ]);
    });

    it('sends no logging call when the template omits it', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });

      await provider.create('B', BUCKET, { TableBucketName: 'tb' });

      expect(sent().map(([name]) => name)).toEqual([CreateTableBucketCommand.name]);
    });

    it('marks the bucket created when PutTableBucketLogging fails', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      mockSend.mockRejectedValueOnce(new Error('logging refused'));

      const error = await provider
        .create('B', BUCKET, { TableBucketName: 'tb', LoggingConfiguration: LOGGING })
        .catch((e: unknown) => e);

      expect(String(error)).toContain('logging refused');
      expect(createdBeforeFailure(error, 'B', BUCKET)).toBe(BUCKET_ARN);
    });

    it.each([['a string', 'log-bucket'], ['a list', [LOGGING]], ['null', null]])(
      'refuses %s LoggingConfiguration before any call',
      async (_label, value) => {
        await expect(
          provider.create('B', BUCKET, { TableBucketName: 'tb', LoggingConfiguration: value })
        ).rejects.toThrow(/LoggingConfiguration .* must be an object; refusing before any call/);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );
  });

  describe('update', () => {
    it('sends nothing when it did not change', async () => {
      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        { TableBucketName: 'tb', LoggingConfiguration: structuredClone(LOGGING) },
        { TableBucketName: 'tb', LoggingConfiguration: LOGGING }
      );

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('writes a changed nested member, marking the key unsettled immediately before', async () => {
      const order: string[] = [];
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        order.push(command.constructor.name);
        return Promise.resolve({});
      });
      const changed = {
        ...LOGGING,
        TargetObjectKeyFormat: { PartitionedPrefix: { PartitionDateSource: 'DeliveryTime' } },
      };

      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        { TableBucketName: 'tb', LoggingConfiguration: changed },
        { TableBucketName: 'tb', LoggingConfiguration: LOGGING },
        { markUnsettled: (key: string) => order.push(`mark:${key}`) }
      );

      expect(order).toEqual(['mark:LoggingConfiguration', PutTableBucketLoggingCommand.name]);
      expect(sent()).toEqual([
        [
          PutTableBucketLoggingCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            tableBucketLoggingStatus: {
              loggingEnabled: {
                ...SDK_LOGGING.loggingEnabled,
                targetObjectKeyFormat: { partitionedPrefix: { partitionDateSource: 'DeliveryTime' } },
              },
            },
          },
        ],
      ]);
    });

    it('sends it when it is added', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        { TableBucketName: 'tb', LoggingConfiguration: LOGGING },
        { TableBucketName: 'tb' }
      );

      expect(sent()).toEqual([
        [
          PutTableBucketLoggingCommand.name,
          { tableBucketARN: BUCKET_ARN, tableBucketLoggingStatus: SDK_LOGGING },
        ],
      ]);
    });

    it('turns logging off on removal with the empty status, marking the key unsettled first', async () => {
      const order: string[] = [];
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        order.push(command.constructor.name);
        return Promise.resolve({});
      });

      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        { TableBucketName: 'tb' },
        { TableBucketName: 'tb', LoggingConfiguration: LOGGING },
        { markUnsettled: (key: string) => order.push(`mark:${key}`) }
      );

      expect(order).toEqual(['mark:LoggingConfiguration', PutTableBucketLoggingCommand.name]);
      expect(sent()).toEqual([
        [PutTableBucketLoggingCommand.name, { tableBucketARN: BUCKET_ARN, tableBucketLoggingStatus: {} }],
      ]);
    });

    it('surfaces a gone bucket on the removal instead of recording logging as off', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.update(
          'B',
          BUCKET_ARN,
          BUCKET,
          { TableBucketName: 'tb' },
          { TableBucketName: 'tb', LoggingConfiguration: LOGGING }
        )
      ).rejects.toThrow(/NotFoundException/);
    });

    it('refuses a non-object desired LoggingConfiguration before any call, a tag change included', async () => {
      await expect(
        provider.update(
          'B',
          BUCKET_ARN,
          BUCKET,
          {
            TableBucketName: 'tb',
            Tags: [{ Key: 'k', Value: 'v' }],
            LoggingConfiguration: 'log-bucket',
          },
          { TableBucketName: 'tb', LoggingConfiguration: LOGGING }
        )
      ).rejects.toThrow(/LoggingConfiguration .* must be an object; refusing before any call/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('names LoggingConfiguration as absent-means-default only while the template leaves it off', () => {
      expect(provider.getDriftAbsentMeansDefaultKeys(BUCKET, { TableBucketName: 'tb' })).toContain(
        'LoggingConfiguration'
      );
      expect(
        provider.getDriftAbsentMeansDefaultKeys(BUCKET, { LoggingConfiguration: LOGGING })
      ).not.toContain('LoggingConfiguration');
    });
  });

  describe('readCurrentState', () => {
    const base = {
      GetTableBucketCommand: () => ({ name: 'tb', arn: BUCKET_ARN }),
      ListTagsForResourceCommand: () => ({ tags: {} }),
    };

    it('reads an enabled logging configuration back in CFn shape', async () => {
      answerByCommand({
        ...base,
        GetTableBucketLoggingCommand: () => ({ tableBucketLoggingStatus: SDK_LOGGING }),
      });

      const result = await provider.readCurrentState(BUCKET_ARN, 'B', BUCKET);

      expect(sent().map(([name]) => name)).toContain(GetTableBucketLoggingCommand.name);
      expect(result).toHaveProperty('LoggingConfiguration', LOGGING);
    });

    it.each([
      ['an empty logging status', () => ({ tableBucketLoggingStatus: {} })],
      ['no logging status', () => ({})],
      [
        'NotFound',
        () => {
          throw notFound();
        },
      ],
    ])('emits no LoggingConfiguration for %s (logging off)', async (_label, answer) => {
      answerByCommand({ ...base, GetTableBucketLoggingCommand: answer });

      const result = await provider.readCurrentState(BUCKET_ARN, 'B', BUCKET);

      expect(result).toHaveProperty('TableBucketName', 'tb');
      expect(result).not.toHaveProperty('LoggingConfiguration');
    });

    it('leaves it out when the read fails for another reason', async () => {
      answerByCommand({
        ...base,
        GetTableBucketLoggingCommand: () => {
          throw new Error('AccessDenied');
        },
      });

      const result = await provider.readCurrentState(BUCKET_ARN, 'B', BUCKET);

      expect(result).not.toHaveProperty('LoggingConfiguration');
      expect(result).toHaveProperty('MetricsConfiguration', { Status: 'Disabled' });
    });

    it('readUnsettled reads it after confirming the bucket exists, and throws a failed read', async () => {
      answerByCommand({
        GetTableBucketCommand: () => ({ arn: BUCKET_ARN }),
        GetTableBucketLoggingCommand: () => ({ tableBucketLoggingStatus: SDK_LOGGING }),
      });
      await expect(
        provider.readUnsettled(BUCKET_ARN, 'B', BUCKET, new Set(['LoggingConfiguration']))
      ).resolves.toEqual({ LoggingConfiguration: LOGGING });

      answerByCommand({
        GetTableBucketCommand: () => ({ arn: BUCKET_ARN }),
        GetTableBucketLoggingCommand: () => {
          throw new Error('AccessDenied');
        },
      });
      await expect(
        provider.readUnsettled(BUCKET_ARN, 'B', BUCKET, new Set(['LoggingConfiguration']))
      ).rejects.toThrow('AccessDenied');
    });
  });
});
