import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetNamespaceCommand,
  GetServiceCommand,
  NamespaceNotFound,
  ServiceNotFound,
} from '@aws-sdk/client-servicediscovery';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-servicediscovery', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-servicediscovery')>(
    '@aws-sdk/client-servicediscovery'
  );
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(() => ({
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

import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';

describe('ServiceDiscoveryProvider.readCurrentState', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  describe('AWS::ServiceDiscovery::PrivateDnsNamespace', () => {
    it('returns Name + Description (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        Namespace: { Id: 'ns-1', Name: 'mynamespace.local', Description: 'mine' },
      });

      const result = await provider.readCurrentState(
        'ns-1',
        'L',
        'AWS::ServiceDiscovery::PrivateDnsNamespace'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetNamespaceCommand);
      expect(result).toEqual({ Name: 'mynamespace.local', Description: 'mine' });
    });

    it('returns undefined when namespace is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new NamespaceNotFound({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(
        'ns-1',
        'L',
        'AWS::ServiceDiscovery::PrivateDnsNamespace'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::ServiceDiscovery::Service', () => {
    it('returns CFn-shaped Service properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        Service: {
          Id: 'srv-1',
          Name: 'mysvc',
          NamespaceId: 'ns-1',
          Type: 'DNS',
          DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] },
        },
      });

      const result = await provider.readCurrentState(
        'srv-1',
        'L',
        'AWS::ServiceDiscovery::Service'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetServiceCommand);
      expect(result).toEqual({
        Name: 'mysvc',
        NamespaceId: 'ns-1',
        Type: 'DNS',
        DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] },
      });
    });

    it('returns undefined when service is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new ServiceNotFound({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(
        'srv-1',
        'L',
        'AWS::ServiceDiscovery::Service'
      );
      expect(result).toBeUndefined();
    });
  });
});
