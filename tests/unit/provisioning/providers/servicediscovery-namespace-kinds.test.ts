/**
 * Unit tests for the HttpNamespace / PublicDnsNamespace kinds of
 * ServiceDiscoveryProvider (issue #1044).
 *
 * Both types are async operation-based: Create* / DeleteNamespace return an
 * OperationId that must be polled via GetOperation until SUCCESS, with the
 * namespace id read from the operation's Targets.NAMESPACE. These tests
 * exercise the polling sequences (PENDING -> SUCCESS and FAIL), the
 * tag-diff update path (including full tag removal — the ECR #981
 * regression class), delete idempotency, and attribute resolution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-servicediscovery')>();
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('../../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  CreateHttpNamespaceCommand,
  CreatePublicDnsNamespaceCommand,
  UpdateHttpNamespaceCommand,
  UpdatePublicDnsNamespaceCommand,
  DeleteNamespaceCommand,
  GetNamespaceCommand,
  GetOperationCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NamespaceNotFound,
} from '@aws-sdk/client-servicediscovery';
import { ServiceDiscoveryProvider } from '../../../../src/provisioning/providers/servicediscovery-provider.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';

const HTTP_NS = 'AWS::ServiceDiscovery::HttpNamespace';
const PUBLIC_DNS_NS = 'AWS::ServiceDiscovery::PublicDnsNamespace';

describe('ServiceDiscoveryProvider — HttpNamespace / PublicDnsNamespace', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create — HttpNamespace', () => {
    it('creates via CreateHttpNamespace and polls PENDING -> SUCCESS', async () => {
      vi.useFakeTimers();
      mockSend
        .mockResolvedValueOnce({ OperationId: 'op-1' }) // CreateHttpNamespace
        .mockResolvedValueOnce({ Operation: { Status: 'PENDING' } }) // GetOperation #1
        .mockResolvedValueOnce({
          Operation: { Status: 'SUCCESS', Targets: { NAMESPACE: 'ns-http-1' } },
        }) // GetOperation #2
        .mockResolvedValueOnce({
          Namespace: { Id: 'ns-http-1', Arn: 'arn:aws:servicediscovery:us-east-1:123:namespace/ns-http-1' },
        }); // GetNamespace (ARN resolution)

      const promise = provider.create('MyHttpNs', HTTP_NS, {
        Name: 'my-http-ns',
        Description: 'desc',
        Tags: [{ Key: 'env', Value: 'test' }],
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.physicalId).toBe('ns-http-1');
      expect(result.attributes).toEqual({
        Id: 'ns-http-1',
        Arn: 'arn:aws:servicediscovery:us-east-1:123:namespace/ns-http-1',
      });

      const createCmd = mockSend.mock.calls[0][0];
      expect(createCmd).toBeInstanceOf(CreateHttpNamespaceCommand);
      expect(createCmd.input).toEqual({
        Name: 'my-http-ns',
        Description: 'desc',
        Tags: [{ Key: 'env', Value: 'test' }],
      });
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(GetOperationCommand);
      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(GetOperationCommand);
      expect(mockSend.mock.calls[3][0]).toBeInstanceOf(GetNamespaceCommand);
    });

    it('throws ProvisioningError when the operation reports FAIL', async () => {
      mockSend
        .mockResolvedValueOnce({ OperationId: 'op-1' })
        .mockResolvedValueOnce({
          Operation: { Status: 'FAIL', ErrorMessage: 'namespace already exists' },
        });

      await expect(
        provider.create('MyHttpNs', HTTP_NS, { Name: 'dup-ns' })
      ).rejects.toThrow(/namespace already exists/);
    });

    it('rejects when Name is missing', async () => {
      await expect(provider.create('MyHttpNs', HTTP_NS, {})).rejects.toThrow(
        ProvisioningError
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('falls back to the STS-built ARN when GetNamespace fails after create', async () => {
      const stsMockSend = vi.fn().mockResolvedValue({ Account: '123456789012' });
      const { STSClient } = await import('@aws-sdk/client-sts');
      vi.spyOn(STSClient.prototype, 'send').mockImplementation(stsMockSend);

      mockSend
        .mockResolvedValueOnce({ OperationId: 'op-1' })
        .mockResolvedValueOnce({
          Operation: { Status: 'SUCCESS', Targets: { NAMESPACE: 'ns-http-2' } },
        })
        .mockRejectedValueOnce(new Error('transient')); // GetNamespace

      const result = await provider.create('MyHttpNs', HTTP_NS, { Name: 'my-ns' });
      expect(result.physicalId).toBe('ns-http-2');
      expect(result.attributes['Arn']).toBe(
        'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-http-2'
      );
    });
  });

  describe('create — PublicDnsNamespace', () => {
    it('creates with SOA TTL passthrough and surfaces HostedZoneId', async () => {
      mockSend
        .mockResolvedValueOnce({ OperationId: 'op-1' }) // CreatePublicDnsNamespace
        .mockResolvedValueOnce({
          Operation: { Status: 'SUCCESS', Targets: { NAMESPACE: 'ns-pub-1' } },
        })
        .mockResolvedValueOnce({
          Namespace: {
            Id: 'ns-pub-1',
            Arn: 'arn:pub',
            Properties: { DnsProperties: { HostedZoneId: 'Z123', SOA: { TTL: 60 } } },
          },
        }); // GetNamespace

      const result = await provider.create('MyPubNs', PUBLIC_DNS_NS, {
        Name: 'example.com',
        Properties: { DnsProperties: { SOA: { TTL: 60 } } },
      });

      expect(result.physicalId).toBe('ns-pub-1');
      expect(result.attributes).toEqual({
        Id: 'ns-pub-1',
        Arn: 'arn:pub',
        HostedZoneId: 'Z123',
      });

      const createCmd = mockSend.mock.calls[0][0];
      expect(createCmd).toBeInstanceOf(CreatePublicDnsNamespaceCommand);
      expect(createCmd.input).toEqual({
        Name: 'example.com',
        Properties: { DnsProperties: { SOA: { TTL: 60 } } },
      });
    });

    it('throws ProvisioningError when the operation reports FAIL', async () => {
      mockSend
        .mockResolvedValueOnce({ OperationId: 'op-1' })
        .mockResolvedValueOnce({
          Operation: { Status: 'FAIL', ErrorMessage: 'hosted zone limit exceeded' },
        });

      await expect(
        provider.create('MyPubNs', PUBLIC_DNS_NS, { Name: 'example.com' })
      ).rejects.toThrow(/hosted zone limit exceeded/);
    });
  });

  describe('update — HttpNamespace', () => {
    it('updates Description via UpdateHttpNamespace and polls the operation', async () => {
      mockSend
        .mockResolvedValueOnce({ OperationId: 'op-upd' }) // UpdateHttpNamespace
        .mockResolvedValueOnce({ Operation: { Status: 'SUCCESS' } }); // GetOperation

      const result = await provider.update(
        'MyHttpNs',
        'ns-http-1',
        HTTP_NS,
        { Description: 'new desc' },
        { Description: 'old desc' }
      );

      expect(result).toEqual({ physicalId: 'ns-http-1', wasReplaced: false });
      const updateCmd = mockSend.mock.calls[0][0];
      expect(updateCmd).toBeInstanceOf(UpdateHttpNamespaceCommand);
      expect(updateCmd.input).toEqual({
        Id: 'ns-http-1',
        Namespace: { Description: 'new desc' },
      });
    });

    it('removes ALL tags via UntagResource when Tags property is dropped (full removal)', async () => {
      mockSend
        .mockResolvedValueOnce({ Namespace: { Id: 'ns-http-1', Arn: 'arn:http' } }) // GetNamespace (ARN)
        .mockResolvedValueOnce({}); // UntagResource

      const result = await provider.update(
        'MyHttpNs',
        'ns-http-1',
        HTTP_NS,
        {}, // Tags fully removed, no Description change
        {
          Tags: [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: '2' },
          ],
        }
      );

      expect(result).toEqual({ physicalId: 'ns-http-1', wasReplaced: false });
      const untagCmd = mockSend.mock.calls[1][0];
      expect(untagCmd).toBeInstanceOf(UntagResourceCommand);
      expect(untagCmd.input).toEqual({ ResourceARN: 'arn:http', TagKeys: ['a', 'b'] });
      // No TagResource call — a pure removal has nothing left to add.
      expect(
        mockSend.mock.calls.some((c) => c[0] instanceof TagResourceCommand)
      ).toBe(false);
    });

    it('applies added/changed tags via TagResource and untags removed keys', async () => {
      mockSend
        .mockResolvedValueOnce({ Namespace: { Id: 'ns-http-1', Arn: 'arn:http' } }) // GetNamespace (ARN)
        .mockResolvedValueOnce({}) // UntagResource
        .mockResolvedValueOnce({}); // TagResource

      await provider.update(
        'MyHttpNs',
        'ns-http-1',
        HTTP_NS,
        { Tags: [{ Key: 'keep', Value: 'v2' }] },
        {
          Tags: [
            { Key: 'keep', Value: 'v1' },
            { Key: 'drop', Value: 'x' },
          ],
        }
      );

      const untagCmd = mockSend.mock.calls[1][0];
      expect(untagCmd).toBeInstanceOf(UntagResourceCommand);
      expect(untagCmd.input).toEqual({ ResourceARN: 'arn:http', TagKeys: ['drop'] });
      const tagCmd = mockSend.mock.calls[2][0];
      expect(tagCmd).toBeInstanceOf(TagResourceCommand);
      expect(tagCmd.input).toEqual({
        ResourceARN: 'arn:http',
        Tags: [{ Key: 'keep', Value: 'v2' }],
      });
    });

    it('throws (does not swallow) when a tag API call fails', async () => {
      mockSend
        .mockResolvedValueOnce({ Namespace: { Id: 'ns-http-1', Arn: 'arn:http' } })
        .mockRejectedValueOnce(new Error('AccessDenied'));

      await expect(
        provider.update('MyHttpNs', 'ns-http-1', HTTP_NS, {}, { Tags: [{ Key: 'a', Value: '1' }] })
      ).rejects.toThrow(/AccessDenied/);
    });
  });

  describe('update — PublicDnsNamespace', () => {
    it('updates Description + SOA TTL via UpdatePublicDnsNamespace', async () => {
      mockSend
        .mockResolvedValueOnce({ OperationId: 'op-upd' })
        .mockResolvedValueOnce({ Operation: { Status: 'SUCCESS' } });

      await provider.update(
        'MyPubNs',
        'ns-pub-1',
        PUBLIC_DNS_NS,
        { Description: 'd2', Properties: { DnsProperties: { SOA: { TTL: 120 } } } },
        { Description: 'd1', Properties: { DnsProperties: { SOA: { TTL: 60 } } } }
      );

      const updateCmd = mockSend.mock.calls[0][0];
      expect(updateCmd).toBeInstanceOf(UpdatePublicDnsNamespaceCommand);
      expect(updateCmd.input).toEqual({
        Id: 'ns-pub-1',
        Namespace: {
          Description: 'd2',
          Properties: { DnsProperties: { SOA: { TTL: 120 } } },
        },
      });
    });

    it('skips UpdatePublicDnsNamespace when only tags changed', async () => {
      mockSend
        .mockResolvedValueOnce({ Namespace: { Id: 'ns-pub-1', Arn: 'arn:pub' } }) // GetNamespace (ARN)
        .mockResolvedValueOnce({}); // TagResource

      await provider.update(
        'MyPubNs',
        'ns-pub-1',
        PUBLIC_DNS_NS,
        { Tags: [{ Key: 'a', Value: '1' }] },
        {}
      );

      expect(
        mockSend.mock.calls.some((c) => c[0] instanceof UpdatePublicDnsNamespaceCommand)
      ).toBe(false);
      const tagCmd = mockSend.mock.calls[1][0];
      expect(tagCmd).toBeInstanceOf(TagResourceCommand);
      expect(tagCmd.input).toEqual({ ResourceARN: 'arn:pub', Tags: [{ Key: 'a', Value: '1' }] });
    });
  });

  describe('delete', () => {
    it.each([[HTTP_NS], [PUBLIC_DNS_NS]])(
      'deletes %s via DeleteNamespace and polls the operation',
      async (resourceType) => {
        mockSend
          .mockResolvedValueOnce({ OperationId: 'op-del' })
          .mockResolvedValueOnce({ Operation: { Status: 'SUCCESS' } });

        await provider.delete('MyNs', 'ns-1', resourceType);

        expect(mockSend.mock.calls[0][0]).toBeInstanceOf(DeleteNamespaceCommand);
        expect(mockSend.mock.calls[0][0].input).toEqual({ Id: 'ns-1' });
        expect(mockSend.mock.calls[1][0]).toBeInstanceOf(GetOperationCommand);
      }
    );

    it.each([[HTTP_NS], [PUBLIC_DNS_NS]])(
      'treats NamespaceNotFound as idempotent success for %s (region match)',
      async (resourceType) => {
        mockSend.mockRejectedValueOnce(
          new NamespaceNotFound({ $metadata: {}, message: 'gone' })
        );

        await expect(
          provider.delete('MyNs', 'ns-1', resourceType, undefined, {
            expectedRegion: 'us-east-1',
          })
        ).resolves.toBeUndefined();
      }
    );

    it('propagates a FAIL operation on delete as ProvisioningError', async () => {
      mockSend
        .mockResolvedValueOnce({ OperationId: 'op-del' })
        .mockResolvedValueOnce({
          Operation: { Status: 'FAIL', ErrorMessage: 'namespace contains services' },
        });

      await expect(provider.delete('MyNs', 'ns-1', HTTP_NS)).rejects.toThrow(
        /namespace contains services/
      );
    });
  });

  describe('getAttribute', () => {
    it('returns physicalId for Id without an AWS call', async () => {
      const result = await provider.getAttribute('ns-1', HTTP_NS, 'Id');
      expect(result).toBe('ns-1');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('resolves HostedZoneId for PublicDnsNamespace via GetNamespace', async () => {
      mockSend.mockResolvedValueOnce({
        Namespace: {
          Id: 'ns-pub-1',
          Arn: 'arn:pub',
          Properties: { DnsProperties: { HostedZoneId: 'Z456' } },
        },
      });
      const result = await provider.getAttribute('ns-pub-1', PUBLIC_DNS_NS, 'HostedZoneId');
      expect(result).toBe('Z456');
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetNamespaceCommand);
    });

    it('returns undefined for a gone namespace', async () => {
      mockSend.mockRejectedValueOnce(new NamespaceNotFound({ $metadata: {}, message: 'gone' }));
      const result = await provider.getAttribute('ns-1', HTTP_NS, 'Arn');
      expect(result).toBeUndefined();
    });

    it('returns undefined for unknown attributes', async () => {
      const result = await provider.getAttribute('ns-1', HTTP_NS, 'Nope');
      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('readCurrentState', () => {
    it('omits the Properties bag for HttpNamespace', async () => {
      mockSend
        .mockResolvedValueOnce({
          Namespace: { Id: 'ns-1', Arn: 'arn:http', Name: 'my-ns', Description: 'd' },
        })
        .mockResolvedValueOnce({ Tags: [] }); // ListTagsForResource

      const state = await provider.readCurrentState!('ns-1', 'MyNs', HTTP_NS);
      expect(state).toEqual({ Name: 'my-ns', Description: 'd', Tags: [] });
      expect(state).not.toHaveProperty('Properties');
    });

    it('surfaces SOA TTL under Properties for PublicDnsNamespace', async () => {
      mockSend
        .mockResolvedValueOnce({
          Namespace: {
            Id: 'ns-1',
            Arn: 'arn:pub',
            Name: 'example.com',
            Properties: { DnsProperties: { HostedZoneId: 'Z1', SOA: { TTL: 90 } } },
          },
        })
        .mockResolvedValueOnce({ Tags: [] });

      const state = await provider.readCurrentState!('ns-1', 'MyNs', PUBLIC_DNS_NS);
      expect(state).toMatchObject({
        Name: 'example.com',
        Properties: { DnsProperties: { SOA: { TTL: 90 } } },
      });
    });
  });
});
