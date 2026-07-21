import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-servicediscovery')>();
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  };
});
vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
});

import {
  GetNamespaceCommand,
  GetServiceCommand,
  ListNamespacesCommand,
} from '@aws-sdk/client-servicediscovery';
import { ServiceDiscoveryProvider } from '../../../../src/provisioning/providers/servicediscovery-provider.js';

describe('ServiceDiscoveryProvider — import', () => {
  let provider: ServiceDiscoveryProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  function makeNamespaceInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyNs',
      resourceType: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
      cdkPath: 'MyStack/MyNs',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { Name: 'example.local' } as Record<string, unknown>,
      ...overrides,
    };
  }

  function makeServiceInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MySvc',
      resourceType: 'AWS::ServiceDiscovery::Service',
      cdkPath: 'MyStack/MySvc',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {} as Record<string, unknown>,
      ...overrides,
    };
  }

  describe('PrivateDnsNamespace', () => {
    it('verifies explicit Id via GetNamespace', async () => {
      mockSend.mockResolvedValueOnce({ Namespace: { Id: 'ns-abc' } });
      const result = await provider.import!(
        makeNamespaceInput({ knownPhysicalId: 'ns-abc' })
      );
      expect(result).toEqual({ physicalId: 'ns-abc', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetNamespaceCommand);
    });

    it('finds namespace by Name property when listing', async () => {
      mockSend
        .mockResolvedValueOnce({
          Namespaces: [
            { Id: 'ns-mine', Arn: 'arn:mine', Name: 'example.local' },
            { Id: 'ns-other', Arn: 'arn:other', Name: 'other.local' },
          ],
          NextToken: undefined,
        });
      const result = await provider.import!(makeNamespaceInput());
      expect(result?.physicalId).toBe('ns-mine');
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListNamespacesCommand);
    });
  });

  describe('Service', () => {
    it('verifies explicit Id via GetService', async () => {
      mockSend.mockResolvedValueOnce({ Service: { Id: 'svc-abc' } });
      const result = await provider.import!(
        makeServiceInput({ knownPhysicalId: 'svc-abc' })
      );
      expect(result).toEqual({ physicalId: 'svc-abc', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetServiceCommand);
    });

    // Issue #1134: the `aws:cdk:path` tag walk was removed. AWS rejects
    // `aws:`-prefixed tag writes, so that tag never exists on a real service
    // and the walk could never match. A service without an explicit id now
    // returns null without listing anything.
    it('returns null without listing when no explicit id is supplied', async () => {
      const result = await provider.import!(makeServiceInput());
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  it('returns null for unsupported resource types', async () => {
    // Instance is the one ServiceDiscovery type this provider does NOT
    // handle (HttpNamespace / PublicDnsNamespace gained support in #1044).
    const result = await provider.import!(
      makeServiceInput({ resourceType: 'AWS::ServiceDiscovery::Instance' })
    );
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe('HttpNamespace / PublicDnsNamespace', () => {
    it.each([
      ['AWS::ServiceDiscovery::HttpNamespace'],
      ['AWS::ServiceDiscovery::PublicDnsNamespace'],
    ])('verifies explicit Id via GetNamespace for %s', async (resourceType) => {
      mockSend.mockResolvedValueOnce({ Namespace: { Id: 'ns-abc' } });
      const result = await provider.import!(
        makeNamespaceInput({ resourceType, knownPhysicalId: 'ns-abc' })
      );
      expect(result).toEqual({ physicalId: 'ns-abc', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetNamespaceCommand);
    });
  });
});

describe('ServiceDiscoveryProvider — update', () => {
  let provider: ServiceDiscoveryProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  it.each([
    ['AWS::ServiceDiscovery::PrivateDnsNamespace'],
    ['AWS::ServiceDiscovery::HttpNamespace'],
    ['AWS::ServiceDiscovery::PublicDnsNamespace'],
    ['AWS::ServiceDiscovery::Service'],
  ])(
    'no-op silent success for %s when properties carry no mutable fields',
    async (resourceType) => {
      // When the diff is purely on immutable fields, the
      // replacement-detection layer routes through DELETE+CREATE.
      // If `update()` is somehow called with no mutable fields, it
      // returns silently rather than firing a destructive empty
      // UpdateService (which AWS interprets as "delete this config").
      const result = await provider.update('MyId', 'phys-id', resourceType, {}, {});
      expect(result).toEqual({ physicalId: 'phys-id', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});
