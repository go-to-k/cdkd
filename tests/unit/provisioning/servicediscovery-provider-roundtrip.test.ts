import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetOperationCommand,
  UpdatePrivateDnsNamespaceCommand,
  UpdateServiceCommand,
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

/**
 * `pollOperation` calls `GetOperation` until SUCCESS. Set up the mock
 * to return the operation handle for the Update* call, then a SUCCESS
 * GetOperation response on the very next send().
 */
function mockUpdateAndOperationSuccess(targetKey: 'NAMESPACE' | 'SERVICE') {
  mockSend
    .mockResolvedValueOnce({ OperationId: 'op-1' })
    .mockResolvedValueOnce({
      Operation: {
        Status: 'SUCCESS',
        Targets: { [targetKey]: targetKey === 'NAMESPACE' ? 'ns-1' : 'srv-1' },
      },
    });
}

describe('ServiceDiscoveryProvider read-update round-trip', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  // ─── AWS::ServiceDiscovery::PrivateDnsNamespace ──────────────────

  it('PrivateDnsNamespace — Description-only diff sends Namespace.Description via UpdatePrivateDnsNamespace', async () => {
    mockUpdateAndOperationSuccess('NAMESPACE');

    const observed = {
      Name: 'mynamespace.local',
      Description: 'updated description',
    };

    const result = await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      observed,
      observed
    );
    expect(result).toEqual({ physicalId: 'ns-1', wasReplaced: false });

    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdatePrivateDnsNamespaceCommand
    );
    expect(call).toBeDefined();
    const input = call![0].input as {
      Id: string;
      Namespace: { Description?: string; Properties?: unknown };
    };
    expect(input.Id).toBe('ns-1');
    expect(input.Namespace.Description).toBe('updated description');
    // SOA.TTL not set in the snapshot — Properties must NOT appear.
    expect(input.Namespace.Properties).toBeUndefined();

    // pollOperation fired GetOperation once after UpdatePrivateDnsNamespace.
    expect(mockSend.mock.calls.some((c) => c[0] instanceof GetOperationCommand)).toBe(true);
  });

  it('PrivateDnsNamespace — empty-string Description reaches AWS (truthy-gate guard)', async () => {
    // `cdkd drift --revert` must clear a console-added Description.
    // An `!== undefined` gate (NOT truthy) is required — an empty
    // string MUST land in the request body.
    mockUpdateAndOperationSuccess('NAMESPACE');

    const observed = {
      Name: 'mynamespace.local',
      Description: '',
    };

    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      observed,
      observed
    );

    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdatePrivateDnsNamespaceCommand
    );
    const input = call![0].input as { Namespace: { Description?: string } };
    expect(input.Namespace.Description).toBe('');
  });

  it('PrivateDnsNamespace — SOA.TTL update sends Properties.DnsProperties.SOA.TTL', async () => {
    mockUpdateAndOperationSuccess('NAMESPACE');

    const observed = {
      Name: 'mynamespace.local',
      Description: '',
      Properties: {
        DnsProperties: {
          SOA: { TTL: 600 },
        },
      },
    };

    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      observed,
      observed
    );

    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdatePrivateDnsNamespaceCommand
    );
    const input = call![0].input as {
      Namespace: { Properties?: { DnsProperties?: { SOA?: { TTL?: number } } } };
    };
    expect(input.Namespace.Properties?.DnsProperties?.SOA?.TTL).toBe(600);
  });

  // ─── AWS::ServiceDiscovery::Service ───────────────────────────────

  it('Service — Description + DnsConfig.DnsRecords TTL change sends ServiceChange via UpdateService', async () => {
    mockUpdateAndOperationSuccess('SERVICE');

    const observed = {
      Name: 'mysvc',
      NamespaceId: 'ns-1',
      Description: 'updated svc desc',
      DnsConfig: {
        DnsRecords: [{ Type: 'A', TTL: 30 }],
        // RoutingPolicy is not part of UpdateService's DnsConfigChange shape
        // and must NOT appear in the request — verified below.
        RoutingPolicy: 'MULTIVALUE',
      },
      HealthCheckConfig: { Type: 'HTTP', ResourcePath: '/healthz', FailureThreshold: 3 },
    };

    const result = await provider.update(
      'L',
      'srv-1',
      'AWS::ServiceDiscovery::Service',
      observed,
      observed
    );
    expect(result).toEqual({ physicalId: 'srv-1', wasReplaced: false });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateServiceCommand);
    expect(call).toBeDefined();
    const input = call![0].input as {
      Id: string;
      Service: {
        Description?: string;
        DnsConfig?: { DnsRecords?: unknown; RoutingPolicy?: string };
        HealthCheckConfig?: unknown;
      };
    };
    expect(input.Id).toBe('srv-1');
    expect(input.Service.Description).toBe('updated svc desc');
    expect(input.Service.DnsConfig?.DnsRecords).toEqual([{ Type: 'A', TTL: 30 }]);
    // RoutingPolicy is NOT in DnsConfigChange — must be stripped.
    expect(input.Service.DnsConfig?.RoutingPolicy).toBeUndefined();
    expect(input.Service.HealthCheckConfig).toEqual({
      Type: 'HTTP',
      ResourcePath: '/healthz',
      FailureThreshold: 3,
    });
  });

  it('Service — empty-string Description reaches AWS (truthy-gate guard)', async () => {
    mockUpdateAndOperationSuccess('SERVICE');

    const observed = {
      Name: 'mysvc',
      Description: '',
    };

    await provider.update('L', 'srv-1', 'AWS::ServiceDiscovery::Service', observed, observed);

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateServiceCommand);
    const input = call![0].input as { Service: { Description?: string } };
    expect(input.Service.Description).toBe('');
  });

  it('Service — when only DnsConfig is supplied, HealthCheckConfig is NOT echoed (would delete the config per AWS docs)', async () => {
    mockUpdateAndOperationSuccess('SERVICE');

    const observed = {
      Name: 'mysvc',
      DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] },
    };

    await provider.update('L', 'srv-1', 'AWS::ServiceDiscovery::Service', observed, observed);

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateServiceCommand);
    const input = call![0].input as { Service: Record<string, unknown> };
    expect(input.Service.HealthCheckConfig).toBeUndefined();
  });

  describe('getDriftUnknownPaths', () => {
    it('declares Vpc as unreadable for PrivateDnsNamespace (GetNamespace does not return it)', () => {
      expect(
        provider.getDriftUnknownPaths('AWS::ServiceDiscovery::PrivateDnsNamespace')
      ).toEqual(['Vpc']);
    });

    it('returns empty array for Service (all read fields are AWS-readable)', () => {
      expect(provider.getDriftUnknownPaths('AWS::ServiceDiscovery::Service')).toEqual([]);
    });

    it('returns empty array for unrelated resource types', () => {
      expect(provider.getDriftUnknownPaths('AWS::S3::Bucket')).toEqual([]);
    });
  });
});
