import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetWebACLCommand,
  ListTagsForResourceCommand,
  WAFNonexistentItemException,
} from '@aws-sdk/client-wafv2';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-wafv2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-wafv2')>(
    '@aws-sdk/client-wafv2'
  );
  return {
    ...actual,
    WAFV2Client: vi.fn().mockImplementation(() => ({
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

import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';

const ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123';

describe('WAFv2WebACLProvider.readCurrentState', () => {
  let provider: WAFv2WebACLProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new WAFv2WebACLProvider();
  });

  it('returns CFn-shaped properties from GetWebACL (happy path)', async () => {
    mockSend
      .mockResolvedValueOnce({
        WebACL: {
          Id: 'abc-123',
          Name: 'my-acl',
          Description: 'a test acl',
          DefaultAction: { Allow: {} },
          Rules: [{ Name: 'r1' }],
          VisibilityConfig: {
            SampledRequestsEnabled: true,
            CloudWatchMetricsEnabled: true,
            MetricName: 'm',
          },
          TokenDomains: ['example.com'],
        },
        LockToken: 'lt',
      })
      .mockResolvedValueOnce({ TagInfoForResource: { ResourceARN: ARN, TagList: [] } });

    const result = await provider.readCurrentState(ARN, 'L', 'AWS::WAFv2::WebACL');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetWebACLCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      Name: 'my-acl',
      Scope: 'REGIONAL',
      Description: 'a test acl',
      DefaultAction: { Allow: {} },
      Rules: [{ Name: 'r1' }],
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'm',
      },
      TokenDomains: ['example.com'],
      Tags: [],
    });
  });

  it('parses CLOUDFRONT scope from a global ARN', async () => {
    const cfArn = 'arn:aws:wafv2:us-east-1:123:global/webacl/cf-acl/xyz';
    mockSend
      .mockResolvedValueOnce({
        WebACL: { Id: 'xyz', Name: 'cf-acl', DefaultAction: { Block: {} } },
      })
      .mockResolvedValueOnce({ TagInfoForResource: { ResourceARN: cfArn, TagList: [] } });

    const result = await provider.readCurrentState(cfArn, 'L', 'AWS::WAFv2::WebACL');

    expect(result).toMatchObject({ Name: 'cf-acl', Scope: 'CLOUDFRONT' });
  });

  it('returns undefined when WebACL is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new WAFNonexistentItemException({ message: 'gone', $metadata: {} })
    );
    const result = await provider.readCurrentState(ARN, 'L', 'AWS::WAFv2::WebACL');
    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({
        WebACL: { Id: 'abc-123', Name: 'my-acl', DefaultAction: { Allow: {} } },
      })
      .mockResolvedValueOnce({
        TagInfoForResource: {
          ResourceARN: ARN,
          TagList: [
            { Key: 'Foo', Value: 'Bar' },
            { Key: 'aws:cdk:path', Value: 'MyStack/MyACL/Resource' },
          ],
        },
      });

    const result = await provider.readCurrentState(ARN, 'L', 'AWS::WAFv2::WebACL');
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        WebACL: { Id: 'abc-123', Name: 'my-acl', DefaultAction: { Allow: {} } },
      })
      .mockResolvedValueOnce({
        TagInfoForResource: {
          ResourceARN: ARN,
          TagList: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyACL/Resource' }],
        },
      });

    const result = await provider.readCurrentState(ARN, 'L', 'AWS::WAFv2::WebACL');
    expect(result?.Tags).toEqual([]);
  });
});
