import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

describe('ServiceDiscoveryProvider read-update round-trip', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  // ─── Class 1 / Class 2 / truthy-gate immunity ────────────────────
  // Both PrivateDnsNamespace.update and Service.update reject with
  // ResourceUpdateNotSupportedError. That uniformly precludes all
  // three failure modes:
  //   - Class 1 (discriminator-dependent placeholder pushed back)
  //   - Class 2 (structurally-incomplete empty placeholder pushed back)
  //   - Truthy-gate dropping `''` / `false` / `0`
  // The round-trip surface here is the rejection, not the wire layer.

  describe('Class 1: discriminator-dependent fields cannot leak via update()', () => {
    it('PrivateDnsNamespace update rejects with ResourceUpdateNotSupportedError', async () => {
      // Even if a future readCurrentState emitted Class 1 placeholders
      // (e.g. SOA.TTL only valid on certain DNS types), update() never
      // touches AWS — the rejection happens before any SDK call.
      const observed = {
        Name: 'mynamespace.local',
        Description: '',
        Tags: [] as Array<{ Key: string; Value: string }>,
      };

      await expect(
        provider.update(
          'L',
          'ns-1',
          'AWS::ServiceDiscovery::PrivateDnsNamespace',
          observed,
          observed
        )
      ).rejects.toThrow(ResourceUpdateNotSupportedError);

      // No AWS calls were made (the rejection is synchronous).
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('Service update rejects with ResourceUpdateNotSupportedError on TCP-typed service', async () => {
      // HealthCheckConfig.ResourcePath is HTTP/HTTPS-only (Class 1
      // candidate). Service is created with Type=TCP and no
      // ResourcePath — round-tripping must not somehow push
      // ResourcePath: '' to AWS and trigger "ResourcePath is only
      // valid when Type is HTTP/HTTPS". The rejection guarantees this.
      const observed = {
        Name: 'mysvc',
        NamespaceId: 'ns-1',
        Description: '',
        Type: 'DNS',
        DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] },
        HealthCheckConfig: { Type: 'TCP', FailureThreshold: 3 },
        Tags: [] as Array<{ Key: string; Value: string }>,
      };

      await expect(
        provider.update('L', 'srv-1', 'AWS::ServiceDiscovery::Service', observed, observed)
      ).rejects.toThrow(ResourceUpdateNotSupportedError);

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('Class 2: structurally-incomplete placeholders cannot reach AWS', () => {
    it('Service update rejects rather than shipping {} / [] placeholders', async () => {
      // If a hypothetical update() were implemented naively it could
      // round-trip empty-object placeholders (e.g. an empty
      // HealthCheckCustomConfig: {}) which AWS rejects as missing
      // mandatory fields. The hard-rejection in update() is the
      // structural guard.
      const observed = {
        Name: 'mysvc',
        NamespaceId: 'ns-1',
        Description: '',
        DnsConfig: {},
        HealthCheckConfig: {},
        HealthCheckCustomConfig: {},
        Tags: [] as Array<{ Key: string; Value: string }>,
      };

      await expect(
        provider.update('L', 'srv-1', 'AWS::ServiceDiscovery::Service', observed, observed)
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
    });
  });

  describe('Truthy-gate immunity: empty-string Description cannot be silently dropped', () => {
    it('PrivateDnsNamespace update rejects rather than silently no-op a Description: "" revert', async () => {
      // If a future update() forgot the `!== undefined` gate, an
      // empty-string Description revert would silently no-op and
      // `cdkd drift --revert` would falsely report success. The
      // rejection makes the silent-no-op state physically unreachable.
      const observed = {
        Name: 'mynamespace.local',
        Description: '',
        Tags: [] as Array<{ Key: string; Value: string }>,
      };

      const error = await provider
        .update(
          'L',
          'ns-1',
          'AWS::ServiceDiscovery::PrivateDnsNamespace',
          observed,
          observed
        )
        .catch((e) => e);

      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      // The rejection message points the user to deploy --replace /
      // destroy + redeploy — not a misleading "succeeded".
      expect((error as Error).message).toMatch(/cdkd deploy --replace|destroy \+ redeploy/i);
    });
  });

  describe('getDriftUnknownPaths', () => {
    it('declares Vpc as unreadable for PrivateDnsNamespace (GetNamespace does not return it)', () => {
      // Without this declaration the drift comparator would walk
      // state.Vpc (which cdkd stores from the template) against
      // observed.Vpc (which readCurrentState deliberately omits) and
      // report guaranteed false-positive drift on every clean run.
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
