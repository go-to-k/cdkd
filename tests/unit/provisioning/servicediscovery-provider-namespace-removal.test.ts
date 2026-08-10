import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  UpdateHttpNamespaceCommand,
  UpdatePrivateDnsNamespaceCommand,
  UpdatePublicDnsNamespaceCommand,
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
 * Issue #1160 (servicediscovery batch): removal resets for the namespace
 * `Description` (all 3 kinds) and `Properties.DnsProperties.SOA.TTL`
 * (private + public DNS kinds).
 *
 * The Update*Namespace change objects MERGE (an absent field keeps the live
 * value), while CloudFormation RESETS a property removed from the template —
 * live CFn A/B 2026-08-11 on PublicDnsNamespace + HttpNamespace: a removed
 * Description was cleared entirely and a removed SOA TTL went from the
 * customized 300 back to the Cloud Map default 60. The provider mirrors
 * that: Description resets via the `''` clear sentinel, TTL to 60.
 */
function mockUpdateAndOperationSuccess() {
  mockSend.mockResolvedValueOnce({ OperationId: 'op-1' }).mockResolvedValueOnce({
    Operation: { Status: 'SUCCESS', Targets: { NAMESPACE: 'ns-1' } },
  });
}

function findCall(cmd: new (...args: never[]) => unknown) {
  return mockSend.mock.calls.find((c) => c[0] instanceof cmd);
}

type NamespaceChangeInput = {
  Id: string;
  Namespace: {
    Description?: string;
    Properties?: { DnsProperties?: { SOA?: { TTL?: number } } };
  };
};

describe('ServiceDiscoveryProvider namespace removal resets (#1160)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  // ─── PrivateDnsNamespace ──────────────────────────────────────────

  it('PrivateDnsNamespace — removed Description resets via the empty-string sentinel', async () => {
    mockUpdateAndOperationSuccess();

    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      { Name: 'ns.local', Vpc: 'vpc-1' },
      { Name: 'ns.local', Vpc: 'vpc-1', Description: 'old description' }
    );

    const call = findCall(UpdatePrivateDnsNamespaceCommand);
    expect(call).toBeDefined();
    const input = call![0].input as NamespaceChangeInput;
    expect(input.Namespace.Description).toBe('');
  });

  it('PrivateDnsNamespace — removed SOA TTL resets to the Cloud Map default 60', async () => {
    mockUpdateAndOperationSuccess();

    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      { Name: 'ns.local', Vpc: 'vpc-1' },
      {
        Name: 'ns.local',
        Vpc: 'vpc-1',
        Properties: { DnsProperties: { SOA: { TTL: 300 } } },
      }
    );

    const call = findCall(UpdatePrivateDnsNamespaceCommand);
    expect(call).toBeDefined();
    const input = call![0].input as NamespaceChangeInput;
    expect(input.Namespace.Properties?.DnsProperties?.SOA?.TTL).toBe(60);
  });

  it('PrivateDnsNamespace — never-present Description/SOA stays absent (no update call)', async () => {
    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      { Name: 'ns.local', Vpc: 'vpc-1' },
      { Name: 'ns.local', Vpc: 'vpc-1' }
    );

    expect(findCall(UpdatePrivateDnsNamespaceCommand)).toBeUndefined();
  });

  it('PrivateDnsNamespace — kept Description + TTL pass through unchanged (true-path polarity)', async () => {
    mockUpdateAndOperationSuccess();

    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      {
        Name: 'ns.local',
        Vpc: 'vpc-1',
        Description: 'kept',
        Properties: { DnsProperties: { SOA: { TTL: 300 } } },
      },
      {
        Name: 'ns.local',
        Vpc: 'vpc-1',
        Description: 'old',
        Properties: { DnsProperties: { SOA: { TTL: 90 } } },
      }
    );

    const input = findCall(UpdatePrivateDnsNamespaceCommand)![0].input as NamespaceChangeInput;
    expect(input.Namespace.Description).toBe('kept');
    expect(input.Namespace.Properties?.DnsProperties?.SOA?.TTL).toBe(300);
  });

  // ─── PublicDnsNamespace ───────────────────────────────────────────

  it('PublicDnsNamespace — removed Description + SOA TTL reset together', async () => {
    mockUpdateAndOperationSuccess();

    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::PublicDnsNamespace',
      { Name: 'ns.example.test' },
      {
        Name: 'ns.example.test',
        Description: 'old description',
        Properties: { DnsProperties: { SOA: { TTL: 90 } } },
      }
    );

    const call = findCall(UpdatePublicDnsNamespaceCommand);
    expect(call).toBeDefined();
    const input = call![0].input as NamespaceChangeInput;
    expect(input.Namespace.Description).toBe('');
    expect(input.Namespace.Properties?.DnsProperties?.SOA?.TTL).toBe(60);
  });

  it('PublicDnsNamespace — never-present Description/SOA stays absent (no update call)', async () => {
    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::PublicDnsNamespace',
      { Name: 'ns.example.test' },
      { Name: 'ns.example.test' }
    );

    expect(findCall(UpdatePublicDnsNamespaceCommand)).toBeUndefined();
  });

  // ─── HttpNamespace ────────────────────────────────────────────────

  it('HttpNamespace — removed Description resets via the empty-string sentinel', async () => {
    mockUpdateAndOperationSuccess();

    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::HttpNamespace',
      { Name: 'http-ns' },
      { Name: 'http-ns', Description: 'old http description' }
    );

    const call = findCall(UpdateHttpNamespaceCommand);
    expect(call).toBeDefined();
    const input = call![0].input as NamespaceChangeInput;
    expect(input.Namespace.Description).toBe('');
  });

  it('HttpNamespace — never-present Description stays absent (no update call)', async () => {
    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::HttpNamespace',
      { Name: 'http-ns' },
      { Name: 'http-ns' }
    );

    expect(findCall(UpdateHttpNamespaceCommand)).toBeUndefined();
  });

  it('HttpNamespace — kept Description passes through unchanged (true-path polarity)', async () => {
    mockUpdateAndOperationSuccess();

    await provider.update(
      'L',
      'ns-1',
      'AWS::ServiceDiscovery::HttpNamespace',
      { Name: 'http-ns', Description: 'kept' },
      { Name: 'http-ns', Description: 'old' }
    );

    const input = findCall(UpdateHttpNamespaceCommand)![0].input as NamespaceChangeInput;
    expect(input.Namespace.Description).toBe('kept');
  });
});
