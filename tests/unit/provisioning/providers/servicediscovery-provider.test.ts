import { describe, it, expect, vi, beforeEach } from 'vitest';

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
            // ns-mine first so the Name match short-circuits before cdk:path
            // tag lookup of ns-other (which would need its own ListTags mock).
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

    it('returns null when no service has matching cdk:path tag', async () => {
      mockSend
        .mockResolvedValueOnce({
          Services: [{ Id: 'svc-other', Arn: 'arn:svc-other' }],
          NextToken: undefined,
        })
        .mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Y' }] });
      const result = await provider.import!(makeServiceInput());
      expect(result).toBeNull();
    });
  });

  it('returns null for unsupported resource types', async () => {
    const result = await provider.import!(
      makeServiceInput({ resourceType: 'AWS::ServiceDiscovery::HttpNamespace' })
    );
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
