import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableBucketCommand,
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

// TableBucket's physicalId IS the bucket ARN — no compound id, no
// GetTableBucket lookup hop needed (unlike Table's compound case).
const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket';
const BUCKET_NAME = 'my-bucket';

describe('S3TablesProvider — AWS::S3Tables::TableBucket Tags wire (#609 backfill)', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3TablesProvider();
  });

  describe('create', () => {
    it('forwards CFn Tags array → SDK tags Record on CreateTableBucketCommand', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });

      await provider.create('L', 'AWS::S3Tables::TableBucket', {
        TableBucketName: BUCKET_NAME,
        Tags: [
          { Key: 'env', Value: 'cdkd-integ' },
          { Key: 'team', Value: 'platform' },
        ],
      });

      const call = mockSend.mock.calls[0][0];
      expect(call).toBeInstanceOf(CreateTableBucketCommand);
      // S3Tables uses flat `Record<string, string>`, NOT the
      // `{ Key, Value }[]` shape CFn carries — wire flip verified.
      expect(call.input.tags).toEqual({ env: 'cdkd-integ', team: 'platform' });
    });

    it('omits tags field entirely when CFn Tags is absent or empty', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      await provider.create('L', 'AWS::S3Tables::TableBucket', {
        TableBucketName: BUCKET_NAME,
      });
      expect(mockSend.mock.calls[0][0].input.tags).toBeUndefined();

      vi.clearAllMocks();
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      await provider.create('L', 'AWS::S3Tables::TableBucket', {
        TableBucketName: BUCKET_NAME,
        Tags: [],
      });
      // Empty array also omits — S3Tables CreateTableBucket rejects
      // empty `tags: {}` with InvalidRequestException.
      expect(mockSend.mock.calls[0][0].input.tags).toBeUndefined();
    });
  });

  describe('update — tag-diff dispatch (physicalId IS the bucket ARN)', () => {
    it('no tag change → zero SDK calls', async () => {
      await provider.update(
        'L',
        BUCKET_ARN,
        'AWS::S3Tables::TableBucket',
        { Tags: [{ Key: 'k', Value: 'v' }] },
        { Tags: [{ Key: 'k', Value: 'v' }] }
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('add-only → TagResource (only, no GetTableBucket lookup needed)', async () => {
      // TableBucket physicalId IS the bucket ARN → tag ops use it
      // directly. No GetTableBucket lookup hop (unlike Table's compound id).
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'L',
        BUCKET_ARN,
        'AWS::S3Tables::TableBucket',
        { Tags: [{ Key: 'env', Value: 'prod' }] },
        {}
      );
      // 1 send: TagResource. NO GetTableBucket lookup.
      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call).toBeInstanceOf(TagResourceCommand);
      expect(call.input.resourceArn).toBe(BUCKET_ARN);
      expect(call.input.tags).toEqual({ env: 'prod' });
    });

    it('removal-only → UntagResource (only, no lookup)', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'L',
        BUCKET_ARN,
        'AWS::S3Tables::TableBucket',
        {},
        { Tags: [{ Key: 'gone', Value: 'x' }] }
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call).toBeInstanceOf(UntagResourceCommand);
      expect(call.input.resourceArn).toBe(BUCKET_ARN);
      expect(call.input.tagKeys).toEqual(['gone']);
    });

    it('value-rewrite on same key → TagResource (only, not Untag)', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'L',
        BUCKET_ARN,
        'AWS::S3Tables::TableBucket',
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
        BUCKET_ARN,
        'AWS::S3Tables::TableBucket',
        { Tags: [{ Key: 'env', Value: 'prod' }, { Key: 'team', Value: 'platform' }] },
        { Tags: [{ Key: 'env', Value: 'dev' }, { Key: 'owner', Value: 'alice' }] }
      );

      // 2 sends: Untag + Tag (no GetTableBucket lookup).
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(UntagResourceCommand);
      expect(mockSend.mock.calls[0][0].input.tagKeys).toEqual(['owner']);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(TagResourceCommand);
      // env value-rewrite + team add — owner is in the Untag pass only.
      expect(mockSend.mock.calls[1][0].input.tags).toEqual({ env: 'prod', team: 'platform' });
    });

    it('tag-side AWS failure THROWS ProvisioningError (issue #740 fix pattern)', async () => {
      // Matches PR #741 throw-instead-of-warn-swallow contract: state is
      // NOT written on throw, so the next deploy retries the tag-diff
      // against the still-old state. For TableBucket update() is
      // otherwise a no-op (the bucket is immutable), so a tag-side
      // throw cleanly turns the whole update into a clean retry with
      // no side-effects.
      mockSend.mockRejectedValueOnce(new Error('throttled'));

      await expect(
        provider.update(
          'L',
          BUCKET_ARN,
          'AWS::S3Tables::TableBucket',
          { Tags: [{ Key: 'env', Value: 'prod' }] },
          {}
        )
      ).rejects.toThrow(/TagResource failed.*throttled/s);

      // TagResource attempted; throw fires after it fails.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });
});
