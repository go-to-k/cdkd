import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateServiceCommand,
  DeleteServiceCommand,
  UpdateServiceAttributesCommand,
  DeleteServiceAttributesCommand,
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

const TYPE = 'AWS::ServiceDiscovery::Service';

/** Find the first send() call whose argument is an instance of `cls`. */
function callOf<T>(cls: new (...args: never[]) => T): T | undefined {
  const hit = mockSend.mock.calls.find((c) => c[0] instanceof cls);
  return hit?.[0] as T | undefined;
}

describe('ServiceDiscoveryProvider — ServiceAttributes backfill (#609)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  describe('create', () => {
    it('applies ServiceAttributes via a post-create UpdateServiceAttributes call', async () => {
      mockSend
        .mockResolvedValueOnce({ Service: { Id: 'srv-1', Arn: 'arn:srv-1', Name: 'mysvc' } })
        .mockResolvedValueOnce({}); // UpdateServiceAttributes

      const result = await provider.create('Svc', TYPE, {
        Name: 'mysvc',
        NamespaceId: 'ns-1',
        ServiceAttributes: { team: 'cdkd', tier: 'backend' },
      });

      expect(result.physicalId).toBe('srv-1');
      const created = callOf(CreateServiceCommand);
      expect(created).toBeDefined();
      // ServiceAttributes is NOT forwarded to CreateService.
      expect((created!.input as Record<string, unknown>)['ServiceAttributes']).toBeUndefined();

      const updateAttrs = callOf(UpdateServiceAttributesCommand);
      expect(updateAttrs).toBeDefined();
      expect(updateAttrs!.input).toEqual({
        ServiceId: 'srv-1',
        Attributes: { team: 'cdkd', tier: 'backend' },
      });
    });

    it('does NOT call UpdateServiceAttributes when ServiceAttributes is absent', async () => {
      mockSend.mockResolvedValueOnce({ Service: { Id: 'srv-1', Arn: 'arn:srv-1', Name: 'mysvc' } });

      await provider.create('Svc', TYPE, { Name: 'mysvc', NamespaceId: 'ns-1' });

      expect(callOf(UpdateServiceAttributesCommand)).toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('deletes the service (atomicity) and rethrows when post-create attributes wiring fails', async () => {
      mockSend
        .mockResolvedValueOnce({ Service: { Id: 'srv-1', Arn: 'arn:srv-1', Name: 'mysvc' } })
        .mockRejectedValueOnce(new Error('attributes boom')) // UpdateServiceAttributes (non-retryable)
        .mockResolvedValueOnce({}); // DeleteService cleanup

      await expect(
        provider.create('Svc', TYPE, {
          Name: 'mysvc',
          NamespaceId: 'ns-1',
          ServiceAttributes: { team: 'cdkd' },
        })
      ).rejects.toThrow();

      const del = callOf(DeleteServiceCommand);
      expect(del).toBeDefined();
      expect((del!.input as Record<string, unknown>)['Id']).toBe('srv-1');
    });
  });

  describe('update', () => {
    it('upserts only changed/added attribute keys via UpdateServiceAttributes', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateServiceAttributes

      await provider.update(
        'Svc',
        'srv-1',
        TYPE,
        { ServiceAttributes: { team: 'cdkd', tier: 'frontend', extra: 'x' } },
        { ServiceAttributes: { team: 'cdkd', tier: 'backend' } }
      );

      const upsert = callOf(UpdateServiceAttributesCommand);
      expect(upsert).toBeDefined();
      // `team` unchanged → excluded; `tier` changed + `extra` new → included.
      expect(upsert!.input).toEqual({
        ServiceId: 'srv-1',
        Attributes: { tier: 'frontend', extra: 'x' },
      });
      expect(callOf(DeleteServiceAttributesCommand)).toBeUndefined();
    });

    it('removes attribute keys present only in the previous state via DeleteServiceAttributes', async () => {
      mockSend.mockResolvedValueOnce({}); // DeleteServiceAttributes

      await provider.update(
        'Svc',
        'srv-1',
        TYPE,
        { ServiceAttributes: { team: 'cdkd' } },
        { ServiceAttributes: { team: 'cdkd', tier: 'backend' } }
      );

      const del = callOf(DeleteServiceAttributesCommand);
      expect(del).toBeDefined();
      expect(del!.input).toEqual({ ServiceId: 'srv-1', Attributes: ['tier'] });
      expect(callOf(UpdateServiceAttributesCommand)).toBeUndefined();
    });

    it('is a no-op (zero SDK calls) when ServiceAttributes is unchanged', async () => {
      const result = await provider.update(
        'Svc',
        'srv-1',
        TYPE,
        { ServiceAttributes: { team: 'cdkd' } },
        { ServiceAttributes: { team: 'cdkd' } }
      );
      expect(result).toEqual({ physicalId: 'srv-1', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('throws (state not written) when UpdateServiceAttributes fails on update', async () => {
      mockSend.mockRejectedValueOnce(new Error('attributes boom'));

      await expect(
        provider.update(
          'Svc',
          'srv-1',
          TYPE,
          { ServiceAttributes: { team: 'changed' } },
          { ServiceAttributes: { team: 'cdkd' } }
        )
      ).rejects.toThrow();
    });
  });
});
