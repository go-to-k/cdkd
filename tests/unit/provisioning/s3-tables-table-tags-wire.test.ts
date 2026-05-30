import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-s3tables';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3tables', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-s3tables')>('@aws-sdk/client-s3tables');
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

const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket';
const NAMESPACE = 'my-namespace';
const TABLE_NAME = 'my-table';
const PHYSICAL_ID = `${BUCKET_ARN}|${NAMESPACE}|${TABLE_NAME}`;
const TABLE_ARN = `${BUCKET_ARN}/table/${NAMESPACE}/${TABLE_NAME}`;

describe('S3TablesProvider — AWS::S3Tables::Table Tags wire (#609 backfill)', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3TablesProvider();
  });

  describe('create', () => {
    it('forwards CFn Tags array → SDK tags Record on CreateTableCommand', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });

      await provider.create('L', 'AWS::S3Tables::Table', {
        TableBucketARN: BUCKET_ARN,
        Namespace: NAMESPACE,
        Name: TABLE_NAME,
        Format: 'ICEBERG',
        Tags: [
          { Key: 'env', Value: 'cdkd-integ' },
          { Key: 'team', Value: 'platform' },
        ],
      });

      const call = mockSend.mock.calls[0][0];
      expect(call).toBeInstanceOf(CreateTableCommand);
      // S3Tables uses flat `Record<string, string>`, NOT the
      // `{ Key, Value }[]` shape CFn carries — wire flip verified.
      expect(call.input.tags).toEqual({ env: 'cdkd-integ', team: 'platform' });
    });

    it('omits tags field entirely when CFn Tags is absent or empty', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });
      await provider.create('L', 'AWS::S3Tables::Table', {
        TableBucketARN: BUCKET_ARN,
        Namespace: NAMESPACE,
        Name: TABLE_NAME,
        Format: 'ICEBERG',
      });
      expect(mockSend.mock.calls[0][0].input.tags).toBeUndefined();

      vi.clearAllMocks();
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });
      await provider.create('L', 'AWS::S3Tables::Table', {
        TableBucketARN: BUCKET_ARN,
        Namespace: NAMESPACE,
        Name: TABLE_NAME,
        Format: 'ICEBERG',
        Tags: [],
      });
      // Empty array also omits — S3Tables CreateTable rejects empty
      // `tags: {}` with InvalidRequestException.
      expect(mockSend.mock.calls[0][0].input.tags).toBeUndefined();
    });

    it('drops Tags entries with missing or non-string Key (defensive)', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });
      await provider.create('L', 'AWS::S3Tables::Table', {
        TableBucketARN: BUCKET_ARN,
        Namespace: NAMESPACE,
        Name: TABLE_NAME,
        Format: 'ICEBERG',
        Tags: [
          { Key: 'good', Value: 'yes' },
          { Value: 'no-key' },
          { Key: 'no-value' },
          { Key: 'numeric', Value: 42 as unknown as string },
          { Key: 'bool', Value: true as unknown as string },
        ],
      });
      const tags = mockSend.mock.calls[0][0].input.tags;
      expect(tags).toEqual({ good: 'yes', 'no-value': '', numeric: '42', bool: 'true' });
    });
  });

  describe('update — tag-diff dispatch', () => {
    it('no tag change → zero SDK calls', async () => {
      await provider.update(
        'L',
        PHYSICAL_ID,
        'AWS::S3Tables::Table',
        { Tags: [{ Key: 'k', Value: 'v' }] },
        { Tags: [{ Key: 'k', Value: 'v' }] }
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('add-only → TagResource (only)', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'L',
        PHYSICAL_ID,
        'AWS::S3Tables::Table',
        { Tags: [{ Key: 'env', Value: 'prod' }] },
        {}
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call).toBeInstanceOf(TagResourceCommand);
      expect(call.input.resourceArn).toBe(TABLE_ARN);
      expect(call.input.tags).toEqual({ env: 'prod' });
    });

    it('removal-only → UntagResource (only)', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'L',
        PHYSICAL_ID,
        'AWS::S3Tables::Table',
        {},
        { Tags: [{ Key: 'gone', Value: 'x' }] }
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call).toBeInstanceOf(UntagResourceCommand);
      expect(call.input.resourceArn).toBe(TABLE_ARN);
      expect(call.input.tagKeys).toEqual(['gone']);
    });

    it('value-rewrite on same key → TagResource (only, not Untag)', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'L',
        PHYSICAL_ID,
        'AWS::S3Tables::Table',
        { Tags: [{ Key: 'env', Value: 'staging' }] },
        { Tags: [{ Key: 'env', Value: 'dev' }] }
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(TagResourceCommand);
      expect(mockSend.mock.calls[0][0].input.tags).toEqual({ env: 'staging' });
    });

    it('mixed adds + removes → Untag THEN Tag in that order (rename safety)', async () => {
      mockSend.mockResolvedValueOnce({}); // Untag
      mockSend.mockResolvedValueOnce({}); // Tag

      await provider.update(
        'L',
        PHYSICAL_ID,
        'AWS::S3Tables::Table',
        { Tags: [{ Key: 'env', Value: 'prod' }, { Key: 'team', Value: 'platform' }] },
        { Tags: [{ Key: 'env', Value: 'dev' }, { Key: 'owner', Value: 'alice' }] }
      );

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(UntagResourceCommand);
      expect(mockSend.mock.calls[0][0].input.tagKeys).toEqual(['owner']);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(TagResourceCommand);
      // env value-rewrite + team add — owner is in the Untag pass only.
      expect(mockSend.mock.calls[1][0].input.tags).toEqual({ env: 'prod', team: 'platform' });
    });

    it('tag-side AWS failure is best-effort — does NOT throw (deploy progresses)', async () => {
      mockSend.mockRejectedValueOnce(new Error('throttled'));

      // Must not throw — the deploy engine's outer retry would otherwise
      // re-issue the no-op update() body unnecessarily.
      await expect(
        provider.update(
          'L',
          PHYSICAL_ID,
          'AWS::S3Tables::Table',
          { Tags: [{ Key: 'env', Value: 'prod' }] },
          {}
        )
      ).resolves.toEqual({ physicalId: PHYSICAL_ID, wasReplaced: false });
    });

    it('TableBucket / Namespace types stay no-op (tag-diff is Table-only in this PR)', async () => {
      await provider.update(
        'L',
        BUCKET_ARN,
        'AWS::S3Tables::TableBucket',
        { Tags: [{ Key: 'env', Value: 'prod' }] },
        {}
      );
      expect(mockSend).not.toHaveBeenCalled();

      await provider.update(
        'L',
        `${BUCKET_ARN}|ns`,
        'AWS::S3Tables::Namespace',
        {},
        {}
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
