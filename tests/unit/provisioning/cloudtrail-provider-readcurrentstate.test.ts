import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetTrailCommand,
  GetTrailStatusCommand,
  GetEventSelectorsCommand,
  GetInsightSelectorsCommand,
  ListTagsCommand,
  TrailNotFoundException,
} from '@aws-sdk/client-cloudtrail';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudtrail')>(
    '@aws-sdk/client-cloudtrail'
  );
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
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

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';

describe('CloudTrailProvider.readCurrentState', () => {
  let provider: CloudTrailProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudTrailProvider();
  });

  it('returns CFn-shaped properties from GetTrail + Status + EventSelectors + InsightSelectors + Tags (happy path)', async () => {
    mockSend
      .mockResolvedValueOnce({
        Trail: {
          Name: 'mytrail',
          S3BucketName: 'mybucket',
          S3KeyPrefix: 'prefix/',
          IsMultiRegionTrail: true,
          IncludeGlobalServiceEvents: true,
          LogFileValidationEnabled: true,
          KmsKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
          TrailARN: 'arn:aws:cloudtrail:us-east-1:1:trail/mytrail',
        },
      })
      .mockResolvedValueOnce({ IsLogging: true })
      .mockResolvedValueOnce({
        EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true }],
      })
      .mockResolvedValueOnce({
        InsightSelectors: [{ InsightType: 'ApiCallRateInsight' }],
      })
      .mockResolvedValueOnce({ ResourceTagList: [] });

    const result = await provider.readCurrentState('mytrail', 'L', 'AWS::CloudTrail::Trail');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetTrailCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetTrailStatusCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(GetEventSelectorsCommand);
    expect(mockSend.mock.calls[3]?.[0]).toBeInstanceOf(GetInsightSelectorsCommand);
    expect(mockSend.mock.calls[4]?.[0]).toBeInstanceOf(ListTagsCommand);
    expect(result).toEqual({
      TrailName: 'mytrail',
      S3BucketName: 'mybucket',
      S3KeyPrefix: 'prefix/',
      IsMultiRegionTrail: true,
      IncludeGlobalServiceEvents: true,
      EnableLogFileValidation: true,
      KMSKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
      SnsTopicName: '',
      IsOrganizationTrail: false,
      IsLogging: true,
      EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true }],
      InsightSelectors: [{ InsightType: 'ApiCallRateInsight' }],
      Tags: [],
    });
  });

  it('emits empty InsightSelectors placeholder when AWS reports none (always-emit)', async () => {
    mockSend
      .mockResolvedValueOnce({
        Trail: {
          Name: 'mytrail',
          S3BucketName: 'mybucket',
          TrailARN: 'arn:aws:cloudtrail:us-east-1:1:trail/mytrail',
        },
      })
      .mockResolvedValueOnce({ IsLogging: false })
      .mockResolvedValueOnce({ EventSelectors: [] })
      .mockResolvedValueOnce({ InsightSelectors: [] })
      .mockResolvedValueOnce({ ResourceTagList: [] });

    const result = await provider.readCurrentState('mytrail', 'L', 'AWS::CloudTrail::Trail');
    expect(result?.InsightSelectors).toEqual([]);
  });

  it('omits IsLogging / EventSelectors on transient secondary errors but always-emits InsightSelectors and Tags placeholders', async () => {
    mockSend
      .mockResolvedValueOnce({
        Trail: { Name: 'mytrail', S3BucketName: 'mybucket' },
      })
      // GetTrailStatus failure — IsLogging key drops out
      .mockRejectedValueOnce(new Error('AccessDenied'))
      // GetEventSelectors failure — EventSelectors key drops out
      .mockRejectedValueOnce(new Error('AccessDenied'))
      // GetInsightSelectors failure — InsightSelectors falls back to []
      .mockRejectedValueOnce(new Error('AccessDenied'));

    const result = await provider.readCurrentState('mytrail', 'L', 'AWS::CloudTrail::Trail');

    // Always-emit placeholders survive even when secondary calls fail —
    // `IsLogging` (GetTrailStatus) and `EventSelectors`
    // (GetEventSelectors) drop out (no synthetic placeholders for those
    // since the call may be AccessDenied rather than "feature absent").
    // `InsightSelectors` falls back to `[]` (the AWS-default state when
    // not configured). Tags falls back to `[]` because TrailARN is
    // missing on this fixture.
    expect(result).toEqual({
      TrailName: 'mytrail',
      S3BucketName: 'mybucket',
      S3KeyPrefix: '',
      IsMultiRegionTrail: false,
      IncludeGlobalServiceEvents: true,
      EnableLogFileValidation: false,
      KMSKeyId: '',
      SnsTopicName: '',
      IsOrganizationTrail: false,
      InsightSelectors: [],
      Tags: [],
    });
  });

  it('returns undefined when trail is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new TrailNotFoundException({ message: 'gone', $metadata: {} })
    );
    const result = await provider.readCurrentState('mytrail', 'L', 'AWS::CloudTrail::Trail');
    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTags with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({
        Trail: { Name: 'mytrail', TrailARN: 'arn:aws:cloudtrail:us-east-1:1:trail/mytrail' },
      })
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValueOnce({ InsightSelectors: [] })
      .mockResolvedValueOnce({
        ResourceTagList: [
          {
            ResourceId: 'arn:aws:cloudtrail:us-east-1:1:trail/mytrail',
            TagsList: [
              { Key: 'Foo', Value: 'Bar' },
              { Key: 'aws:cdk:path', Value: 'MyStack/MyTrail/Resource' },
            ],
          },
        ],
      });

    const result = await provider.readCurrentState('mytrail', 'L', 'AWS::CloudTrail::Trail');
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('emits empty Tags array when ListTags returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        Trail: { Name: 'mytrail', TrailARN: 'arn:aws:cloudtrail:us-east-1:1:trail/mytrail' },
      })
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValueOnce({ InsightSelectors: [] })
      .mockResolvedValueOnce({
        ResourceTagList: [
          {
            ResourceId: 'arn:aws:cloudtrail:us-east-1:1:trail/mytrail',
            TagsList: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyTrail/Resource' }],
          },
        ],
      });

    const result = await provider.readCurrentState('mytrail', 'L', 'AWS::CloudTrail::Trail');
    expect(result?.Tags).toEqual([]);
  });
});
