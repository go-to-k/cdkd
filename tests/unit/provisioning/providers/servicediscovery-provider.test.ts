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
  GetOperationCommand,
  GetServiceCommand,
  ListNamespacesCommand,
  UpdateServiceCommand,
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
      const arn = 'arn:aws:servicediscovery:us-east-1:123456789012:service/svc-abc';
      mockSend.mockResolvedValueOnce({ Service: { Id: 'svc-abc', Arn: arn, Name: 'api' } });
      const result = await provider.import!(
        makeServiceInput({ knownPhysicalId: 'svc-abc' })
      );
      // Issue #3627: the same map `create()` records (`Name` resolved to the id).
      expect(result).toStrictEqual({
        physicalId: 'svc-abc',
        attributes: { Id: 'svc-abc', Arn: arn, Name: 'api' },
      });
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

// Issue #1160: CloudFormation KEEPS a Description / DnsConfig /
// HealthCheckConfig removed from the template (live A/B 2026-10-20), while
// UpdateService REPLACES its ServiceChange body — so the update echoes the
// live value for every field the template no longer declares.
describe('ServiceDiscoveryProvider — Service removal keeps the live value (#1160)', () => {
  let provider: ServiceDiscoveryProvider;
  const LIVE_HC = { Type: 'HTTP', ResourcePath: '/live', FailureThreshold: 4 };
  const LIVE_RECORDS = [{ Type: 'A', TTL: 300 }];
  const FULL = {
    Name: 'svc',
    NamespaceId: 'ns-abc',
    Description: 'template-desc',
    DnsConfig: { RoutingPolicy: 'WEIGHTED', DnsRecords: [{ Type: 'A', TTL: 120 }] },
    HealthCheckConfig: { Type: 'HTTP', ResourcePath: '/health', FailureThreshold: 3 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetServiceCommand) {
        return {
          Service: {
            Id: 'srv-1',
            Description: 'live-desc',
            DnsConfig: { NamespaceId: 'ns-abc', RoutingPolicy: 'WEIGHTED', DnsRecords: LIVE_RECORDS },
            HealthCheckConfig: LIVE_HC,
          },
        };
      }
      if (cmd instanceof UpdateServiceCommand) return { OperationId: 'op-1' };
      if (cmd instanceof GetOperationCommand) return { Operation: { Status: 'SUCCESS' } };
      throw new Error(`unexpected command ${(cmd as object).constructor.name}`);
    });
  });

  const sentChange = () => {
    const call = mockSend.mock.calls.find(([c]) => c instanceof UpdateServiceCommand);
    expect(call).toBeDefined();
    return (call![0] as UpdateServiceCommand).input.Service!;
  };
  const without = (key: keyof typeof FULL) => {
    const copy: Record<string, unknown> = { ...FULL };
    delete copy[key];
    return copy;
  };

  it('a removed Description is sent as its live value, not omitted (which clears it)', async () => {
    await provider.update('Svc', 'srv-1', 'AWS::ServiceDiscovery::Service', without('Description'), FULL);
    const change = sentChange();
    expect(change.Description).toBe('live-desc');
    expect(change.DnsConfig).toEqual({ DnsRecords: FULL.DnsConfig.DnsRecords });
    expect(change.HealthCheckConfig).toEqual(FULL.HealthCheckConfig);
  });

  it('a removed HealthCheckConfig is sent as its live value, not omitted (which deletes it)', async () => {
    await provider.update('Svc', 'srv-1', 'AWS::ServiceDiscovery::Service', without('HealthCheckConfig'), FULL);
    const change = sentChange();
    expect(change.HealthCheckConfig).toEqual(LIVE_HC);
    expect(change.Description).toBe('template-desc');
  });

  it('a removed DnsConfig is sent as the live DnsRecords, not omitted (which AWS refuses)', async () => {
    await provider.update('Svc', 'srv-1', 'AWS::ServiceDiscovery::Service', without('DnsConfig'), FULL);
    const change = sentChange();
    // DnsConfigChange carries DnsRecords only; RoutingPolicy / NamespaceId are not echoed.
    expect(change.DnsConfig).toEqual({ DnsRecords: LIVE_RECORDS });
    expect(change.HealthCheckConfig).toEqual(FULL.HealthCheckConfig);
  });

  it('spends no GetService when every ServiceChange field is declared', async () => {
    await provider.update(
      'Svc',
      'srv-1',
      'AWS::ServiceDiscovery::Service',
      { ...FULL, Description: 'changed' },
      FULL
    );
    expect(sentChange().Description).toBe('changed');
    expect(mockSend.mock.calls.some(([c]) => c instanceof GetServiceCommand)).toBe(false);
  });

  it('a live service without the field echoes nothing for it', async () => {
    mockSend.mockImplementationOnce(async () => ({
      Service: { Id: 'srv-1', DnsConfig: { DnsRecords: LIVE_RECORDS } },
    }));
    await provider.update('Svc', 'srv-1', 'AWS::ServiceDiscovery::Service', without('Description'), FULL);
    const change = sentChange();
    expect(Object.hasOwn(change, 'Description')).toBe(false);
  });

  it('an HTTP service whose only field was the removed Description makes no call (kept)', async () => {
    const prev = { Name: 'svc', NamespaceId: 'ns-http', Description: 'template-desc' };
    await provider.update(
      'Svc',
      'srv-1',
      'AWS::ServiceDiscovery::Service',
      { Name: 'svc', NamespaceId: 'ns-http' },
      prev
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('declares every handled Service property removal-handled, so no unhandled-removal warning fires', () => {
    const handled = provider.handledProperties.get('AWS::ServiceDiscovery::Service')!;
    const declared = provider.removalHandledInUpdate.get('AWS::ServiceDiscovery::Service')!;
    expect([...handled].filter((k) => !declared.has(k))).toEqual([]);
    expect(provider.removalDefaults.has('AWS::ServiceDiscovery::Service')).toBe(false);
  });
});
