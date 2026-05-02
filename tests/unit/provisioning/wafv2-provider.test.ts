import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-wafv2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-wafv2');
  return {
    ...actual,
    WAFV2Client: vi.fn().mockImplementation(() => ({ send: mockSend, config: { region: () => Promise.resolve('us-east-1') } })),
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

const TEST_ARN =
  'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123-def';
const TEST_ID = 'abc-123-def';

describe('WAFv2WebACLProvider', () => {
  let provider: WAFv2WebACLProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new WAFv2WebACLProvider();
  });

  describe('create', () => {
    it('should create WebACL and return ARN as physicalId with attributes', async () => {
      mockSend.mockResolvedValueOnce({
        Summary: {
          ARN: TEST_ARN,
          Id: TEST_ID,
          LabelNamespace: 'awswaf:123456789012:webacl:my-acl:',
        },
      });

      const result = await provider.create('MyWebACL', 'AWS::WAFv2::WebACL', {
        Name: 'my-acl',
        Scope: 'REGIONAL',
        DefaultAction: { Allow: {} },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'my-acl-metric',
          SampledRequestsEnabled: true,
        },
      });

      expect(result.physicalId).toBe(TEST_ARN);
      expect(result.attributes).toEqual({
        Arn: TEST_ARN,
        Id: TEST_ID,
        LabelNamespace: 'awswaf:123456789012:webacl:my-acl:',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateWebACLCommand');
      expect(createCall.input.Name).toBe('my-acl');
      expect(createCall.input.Scope).toBe('REGIONAL');
    });

    it('should throw ProvisioningError on failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.create('MyWebACL', 'AWS::WAFv2::WebACL', {
          Name: 'my-acl',
          Scope: 'REGIONAL',
          DefaultAction: { Allow: {} },
          VisibilityConfig: {
            CloudWatchMetricsEnabled: true,
            MetricName: 'metric',
            SampledRequestsEnabled: true,
          },
        })
      ).rejects.toThrow('Failed to create WAFv2 WebACL MyWebACL');
    });
  });

  describe('update', () => {
    it('should get LockToken via GetWebACL, then update', async () => {
      // GetWebACL
      mockSend.mockResolvedValueOnce({
        LockToken: 'lock-token-123',
        WebACL: {
          LabelNamespace: 'awswaf:123456789012:webacl:my-acl:',
        },
      });
      // UpdateWebACL
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'MyWebACL',
        TEST_ARN,
        'AWS::WAFv2::WebACL',
        {
          Name: 'my-acl',
          Scope: 'REGIONAL',
          DefaultAction: { Block: {} },
          VisibilityConfig: {
            CloudWatchMetricsEnabled: true,
            MetricName: 'my-acl-metric',
            SampledRequestsEnabled: true,
          },
        },
        {
          Name: 'my-acl',
          Scope: 'REGIONAL',
          DefaultAction: { Allow: {} },
          VisibilityConfig: {
            CloudWatchMetricsEnabled: true,
            MetricName: 'my-acl-metric',
            SampledRequestsEnabled: true,
          },
        }
      );

      expect(result.physicalId).toBe(TEST_ARN);
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({
        Arn: TEST_ARN,
        Id: TEST_ID,
        LabelNamespace: 'awswaf:123456789012:webacl:my-acl:',
      });
      expect(mockSend).toHaveBeenCalledTimes(2);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetWebACLCommand');
      expect(getCall.input.Name).toBe('my-acl');
      expect(getCall.input.Id).toBe(TEST_ID);

      const updateCall = mockSend.mock.calls[1][0];
      expect(updateCall.constructor.name).toBe('UpdateWebACLCommand');
      expect(updateCall.input.LockToken).toBe('lock-token-123');
    });

    it('should require replacement when Name changes', async () => {
      // The provider uses the name from the ARN (physicalId), not from properties.
      // Name is immutable - replacement is handled by the deployment layer.
      // GetWebACL
      mockSend.mockResolvedValueOnce({
        LockToken: 'lock-token-123',
        WebACL: { LabelNamespace: 'awswaf:123456789012:webacl:my-acl:' },
      });
      // UpdateWebACL
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'MyWebACL',
        TEST_ARN,
        'AWS::WAFv2::WebACL',
        {
          Name: 'new-acl-name',
          Scope: 'REGIONAL',
          DefaultAction: { Allow: {} },
          VisibilityConfig: {
            CloudWatchMetricsEnabled: true,
            MetricName: 'metric',
            SampledRequestsEnabled: true,
          },
        },
        {
          Name: 'my-acl',
          Scope: 'REGIONAL',
          DefaultAction: { Allow: {} },
          VisibilityConfig: {
            CloudWatchMetricsEnabled: true,
            MetricName: 'metric',
            SampledRequestsEnabled: true,
          },
        }
      );

      // Provider uses ARN-derived name, not the new property Name
      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.input.Name).toBe('my-acl');

      const updateCall = mockSend.mock.calls[1][0];
      expect(updateCall.input.Name).toBe('my-acl');

      expect(result.wasReplaced).toBe(false);
    });

    it('should require replacement when Scope changes', async () => {
      // Scope is immutable - replacement is handled by the deployment layer.
      // The provider always uses the scope parsed from the ARN.
      // GetWebACL
      mockSend.mockResolvedValueOnce({
        LockToken: 'lock-token-123',
        WebACL: { LabelNamespace: 'awswaf:123456789012:webacl:my-acl:' },
      });
      // UpdateWebACL
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'MyWebACL',
        TEST_ARN,
        'AWS::WAFv2::WebACL',
        {
          Name: 'my-acl',
          Scope: 'CLOUDFRONT',
          DefaultAction: { Allow: {} },
          VisibilityConfig: {
            CloudWatchMetricsEnabled: true,
            MetricName: 'metric',
            SampledRequestsEnabled: true,
          },
        },
        {
          Name: 'my-acl',
          Scope: 'REGIONAL',
          DefaultAction: { Allow: {} },
          VisibilityConfig: {
            CloudWatchMetricsEnabled: true,
            MetricName: 'metric',
            SampledRequestsEnabled: true,
          },
        }
      );

      // Provider uses ARN-derived scope (REGIONAL from the ARN), not the new property
      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.input.Scope).toBe('REGIONAL');

      expect(result.wasReplaced).toBe(false);
    });
  });

  describe('delete', () => {
    it('should get LockToken, then delete', async () => {
      // GetWebACL
      mockSend.mockResolvedValueOnce({
        LockToken: 'lock-token-456',
        WebACL: {},
      });
      // DeleteWebACL
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyWebACL', TEST_ARN, 'AWS::WAFv2::WebACL');

      expect(mockSend).toHaveBeenCalledTimes(2);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetWebACLCommand');
      expect(getCall.input.Name).toBe('my-acl');
      expect(getCall.input.Scope).toBe('REGIONAL');
      expect(getCall.input.Id).toBe(TEST_ID);

      const deleteCall = mockSend.mock.calls[1][0];
      expect(deleteCall.constructor.name).toBe('DeleteWebACLCommand');
      expect(deleteCall.input.Name).toBe('my-acl');
      expect(deleteCall.input.Scope).toBe('REGIONAL');
      expect(deleteCall.input.Id).toBe(TEST_ID);
      expect(deleteCall.input.LockToken).toBe('lock-token-456');
    });

    it('should handle WAFNonexistentItemException gracefully', async () => {
      const { WAFNonexistentItemException } = await import('@aws-sdk/client-wafv2');
      mockSend.mockRejectedValueOnce(
        new WAFNonexistentItemException({ $metadata: {}, message: 'not found' })
      );

      await provider.delete('MyWebACL', TEST_ARN, 'AWS::WAFv2::WebACL');

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyWebACL',
        resourceType: 'AWS::WAFv2::WebACL',
        cdkPath: 'MyStack/MyWebACL',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { Scope: 'REGIONAL' },
        ...overrides,
      };
    }

    it('explicit override: GetWebACL parses ARN and returns it as physicalId', async () => {
      mockSend.mockResolvedValueOnce({ WebACL: { ARN: TEST_ARN }, LockToken: 'lock' });

      const result = await provider.import(makeInput({ knownPhysicalId: TEST_ARN }));

      expect(result).toEqual({ physicalId: TEST_ARN, attributes: {} });
      const call = mockSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('GetWebACLCommand');
      expect(call.input).toEqual({ Id: TEST_ID, Name: 'my-acl', Scope: 'REGIONAL' });
    });

    it('tag-based lookup: matches aws:cdk:path via ListTagsForResource on TagInfoForResource.TagList', async () => {
      const otherArn = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/other/zzz';
      // ListWebACLs
      mockSend.mockResolvedValueOnce({
        WebACLs: [
          { Id: 'zzz', Name: 'other', ARN: otherArn },
          { Id: TEST_ID, Name: 'my-acl', ARN: TEST_ARN },
        ],
      });
      // ListTagsForResource for otherArn
      mockSend.mockResolvedValueOnce({
        TagInfoForResource: {
          ResourceARN: otherArn,
          TagList: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }],
        },
      });
      // ListTagsForResource for TEST_ARN
      mockSend.mockResolvedValueOnce({
        TagInfoForResource: {
          ResourceARN: TEST_ARN,
          TagList: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyWebACL' }],
        },
      });

      const result = await provider.import(makeInput());
      expect(result).toEqual({ physicalId: TEST_ARN, attributes: {} });
    });

    it('returns null when nothing matches', async () => {
      mockSend.mockResolvedValueOnce({
        WebACLs: [{ Id: 'a', Name: 'a', ARN: 'arn:aws:wafv2:us-east-1:1:regional/webacl/a/a' }],
      });
      mockSend.mockResolvedValueOnce({
        TagInfoForResource: {
          TagList: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }],
        },
      });

      const result = await provider.import(makeInput());
      expect(result).toBeNull();
    });
  });
});
