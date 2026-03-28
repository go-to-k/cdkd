import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-cloudtrail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudtrail')>();
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
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

import { CloudTrailProvider } from '../../../../src/provisioning/providers/cloudtrail-provider.js';
import {
  CreateTrailCommand,
  DeleteTrailCommand,
  UpdateTrailCommand,
  StartLoggingCommand,
  StopLoggingCommand,
  TrailNotFoundException,
} from '@aws-sdk/client-cloudtrail';

describe('CloudTrailProvider', () => {
  let provider: CloudTrailProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudTrailProvider();
  });

  // ─── create ─────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create trail and start logging by default', async () => {
      mockSend.mockResolvedValue({
        TrailARN: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail',
        Name: 'test-trail',
      });

      const result = await provider.create('MyTrail', 'AWS::CloudTrail::Trail', {
        TrailName: 'test-trail',
        S3BucketName: 'my-bucket',
      });

      expect(result.physicalId).toBe(
        'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail'
      );
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail',
      });
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CreateTrailCommand);
      expect(mockSend.mock.calls[0][0].input).toEqual({
        Name: 'test-trail',
        S3BucketName: 'my-bucket',
        S3KeyPrefix: undefined,
        IsMultiRegionTrail: undefined,
        IncludeGlobalServiceEvents: undefined,
        EnableLogFileValidation: undefined,
        TagsList: undefined,
      });
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(StartLoggingCommand);
      expect(mockSend.mock.calls[1][0].input).toEqual({
        Name: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail',
      });
    });

    it('should not start logging when IsLogging is false', async () => {
      mockSend.mockResolvedValue({
        TrailARN: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail',
        Name: 'test-trail',
      });

      const result = await provider.create('MyTrail', 'AWS::CloudTrail::Trail', {
        TrailName: 'test-trail',
        S3BucketName: 'my-bucket',
        IsLogging: false,
      });

      expect(result.physicalId).toBe(
        'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail'
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CreateTrailCommand);
    });

    it('should pass tags to CreateTrailCommand', async () => {
      mockSend.mockResolvedValue({
        TrailARN: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail',
        Name: 'test-trail',
      });

      await provider.create('MyTrail', 'AWS::CloudTrail::Trail', {
        TrailName: 'test-trail',
        S3BucketName: 'my-bucket',
        Tags: [
          { Key: 'Env', Value: 'dev' },
          { Key: 'Project', Value: 'test' },
        ],
      });

      expect(mockSend).toHaveBeenCalledTimes(2);
      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(CreateTrailCommand);
      expect(command.input.TagsList).toEqual([
        { Key: 'Env', Value: 'dev' },
        { Key: 'Project', Value: 'test' },
      ]);
    });

    it('should ignore EventSelectors property', async () => {
      mockSend.mockResolvedValue({
        TrailARN: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail',
        Name: 'test-trail',
      });

      const result = await provider.create('MyTrail', 'AWS::CloudTrail::Trail', {
        TrailName: 'test-trail',
        S3BucketName: 'my-bucket',
        EventSelectors: [
          {
            ReadWriteType: 'All',
            IncludeManagementEvents: true,
          },
        ],
      });

      expect(result.physicalId).toBe(
        'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail'
      );
      // CreateTrailCommand should not include EventSelectors
      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(CreateTrailCommand);
      expect(command.input).not.toHaveProperty('EventSelectors');
    });
  });

  // ─── update ─────────────────────────────────────────────────────────

  describe('update', () => {
    it('should update trail properties', async () => {
      mockSend.mockResolvedValue({});

      const trailArn = 'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail';

      const result = await provider.update(
        'MyTrail',
        trailArn,
        'AWS::CloudTrail::Trail',
        {
          S3BucketName: 'new-bucket',
          IsMultiRegionTrail: true,
          IsLogging: true,
        },
        {
          S3BucketName: 'old-bucket',
          IsMultiRegionTrail: false,
          IsLogging: true,
        }
      );

      expect(result.physicalId).toBe(trailArn);
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(UpdateTrailCommand);
      expect(command.input).toEqual({
        Name: trailArn,
        S3BucketName: 'new-bucket',
        S3KeyPrefix: undefined,
        IsMultiRegionTrail: true,
        IncludeGlobalServiceEvents: undefined,
        EnableLogFileValidation: undefined,
      });
    });

    it('should stop and start logging when IsLogging changes', async () => {
      mockSend.mockResolvedValue({});

      const trailArn = 'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail';

      await provider.update(
        'MyTrail',
        trailArn,
        'AWS::CloudTrail::Trail',
        {
          S3BucketName: 'my-bucket',
          IsLogging: false,
        },
        {
          S3BucketName: 'my-bucket',
          IsLogging: true,
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(UpdateTrailCommand);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(StopLoggingCommand);
      expect(mockSend.mock.calls[1][0].input).toEqual({ Name: trailArn });
    });
  });

  // ─── delete ─────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should stop logging then delete trail', async () => {
      mockSend.mockResolvedValue({});

      const trailArn = 'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail';

      await provider.delete('MyTrail', trailArn, 'AWS::CloudTrail::Trail');

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(StopLoggingCommand);
      expect(mockSend.mock.calls[0][0].input).toEqual({ Name: trailArn });
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(DeleteTrailCommand);
      expect(mockSend.mock.calls[1][0].input).toEqual({ Name: trailArn });
    });

    it('should not throw when trail is not found', async () => {
      mockSend.mockRejectedValue(
        new TrailNotFoundException({ $metadata: {}, message: 'not found' })
      );

      await expect(
        provider.delete(
          'MyTrail',
          'arn:aws:cloudtrail:us-east-1:123456789012:trail/test-trail',
          'AWS::CloudTrail::Trail'
        )
      ).resolves.not.toThrow();
    });
  });
});
