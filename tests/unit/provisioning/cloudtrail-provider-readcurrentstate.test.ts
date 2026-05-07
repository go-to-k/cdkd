import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetTrailCommand,
  GetTrailStatusCommand,
  GetEventSelectorsCommand,
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

  it('returns CFn-shaped properties from GetTrail + Status + Selectors (happy path)', async () => {
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
      .mockResolvedValueOnce({ ResourceTagList: [] });

    const result = await provider.readCurrentState('mytrail', 'L', 'AWS::CloudTrail::Trail');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetTrailCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetTrailStatusCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(GetEventSelectorsCommand);
    expect(mockSend.mock.calls[3]?.[0]).toBeInstanceOf(ListTagsCommand);
    expect(result).toEqual({
      TrailName: 'mytrail',
      S3BucketName: 'mybucket',
      S3KeyPrefix: 'prefix/',
      IsMultiRegionTrail: true,
      IncludeGlobalServiceEvents: true,
      EnableLogFileValidation: true,
      KMSKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
      IsLogging: true,
      EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true }],
      Tags: [],
    });
  });

  it('omits IsLogging / EventSelectors on transient secondary errors', async () => {
    mockSend
      .mockResolvedValueOnce({
        Trail: { Name: 'mytrail', S3BucketName: 'mybucket' },
      })
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockRejectedValueOnce(new Error('AccessDenied'));

    const result = await provider.readCurrentState('mytrail', 'L', 'AWS::CloudTrail::Trail');

    expect(result).toEqual({
      TrailName: 'mytrail',
      S3BucketName: 'mybucket',
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

  it('omits Tags when ListTags returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        Trail: { Name: 'mytrail', TrailARN: 'arn:aws:cloudtrail:us-east-1:1:trail/mytrail' },
      })
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockRejectedValueOnce(new Error('AccessDenied'))
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
