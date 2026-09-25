import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateServiceCommand,
  DeleteServiceCommand,
  UpdateServiceCommand,
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
import { InterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import {
  FORGED_CTRL,
  FORGED_QUOTE,
  expectQuotedAfter,
  expectWithheld,
} from './pasteable-aws-command-assert.js';
import { getLogger } from '../../../src/utils/logger.js';

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
    // clearAllMocks keeps implementations; restore vi.fn()'s default so a
    // case that routes via mockImplementation does not leak into the next.
    mockSend.mockImplementation(() => undefined);
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
      expect((created!.input as unknown as Record<string, unknown>)['ServiceAttributes']).toBeUndefined();

      const updateAttrs = callOf(UpdateServiceAttributesCommand);
      expect(updateAttrs).toBeDefined();
      expect(updateAttrs!.input).toEqual({
        ServiceId: 'srv-1',
        Attributes: { team: 'cdkd', tier: 'backend' },
      });
    });

    it('coerces number/boolean attribute values to strings and drops non-scalar values', async () => {
      mockSend
        .mockResolvedValueOnce({ Service: { Id: 'srv-1', Arn: 'arn:srv-1', Name: 'mysvc' } })
        .mockResolvedValueOnce({}); // UpdateServiceAttributes

      await provider.create('Svc', TYPE, {
        Name: 'mysvc',
        NamespaceId: 'ns-1',
        // CFn can surface stringly-typed numerics / booleans; a non-scalar
        // value is malformed and must be dropped (never String()'d into
        // "[object Object]") — the trap class from
        // feedback_ssm_parameter_tags_is_a_map / feedback_cfn_stringly_typed_numerics_need_coerce.
        ServiceAttributes: { count: 3, enabled: true, bad: { nested: 1 } },
      });

      const updateAttrs = callOf(UpdateServiceAttributesCommand);
      expect(updateAttrs).toBeDefined();
      expect(updateAttrs!.input).toEqual({
        ServiceId: 'srv-1',
        Attributes: { count: '3', enabled: 'true' },
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
      expect((del!.input as unknown as Record<string, unknown>)['Id']).toBe('srv-1');
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

    it('removes an attribute keyed `constructor` via DeleteServiceAttributes (#3515 — updateService removedAttrKeys own-key membership)', async () => {
      // #3515: `!(k in newAttrs)` saw `constructor` on Object.prototype, so the
      // removed attribute was never deleted and stayed live on AWS.
      // Route by command type (no `*Once` queue): pre-fix the path sends
      // nothing, so a sequential primer would leak into a later case.
      mockSend.mockImplementation((cmd: unknown) => {
        if (
          cmd instanceof DeleteServiceAttributesCommand ||
          cmd instanceof UpdateServiceAttributesCommand
        ) {
          return Promise.resolve({});
        }
        return Promise.reject(new Error(`Unexpected command: ${(cmd as object).constructor.name}`));
      });

      await provider.update(
        'Svc',
        'srv-1',
        TYPE,
        { ServiceAttributes: { keep: 'k' } },
        { ServiceAttributes: { keep: 'k', constructor: 'old' } }
      );

      const sent = mockSend.mock.calls.map((c) => c[0]);
      const deletes = sent.filter((c) => c instanceof DeleteServiceAttributesCommand);
      expect(deletes.map((c) => c.input)).toEqual([
        { ServiceId: 'srv-1', Attributes: ['constructor'] },
      ]);
      // `keep` is unchanged, so nothing is upserted.
      expect(sent.filter((c) => c instanceof UpdateServiceAttributesCommand)).toEqual([]);
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

    it('combines a ServiceChange + attribute upsert + attribute removal in one update', async () => {
      // The three mutation paths are independent and all fire in the same
      // update() call: UpdateService (ServiceChange body) then
      // UpdateServiceAttributes (upsert) then DeleteServiceAttributes (remove).
      mockSend
        .mockResolvedValueOnce({}) // UpdateService — no OperationId, polling skipped
        .mockResolvedValueOnce({}) // UpdateServiceAttributes
        .mockResolvedValueOnce({}); // DeleteServiceAttributes

      const result = await provider.update(
        'Svc',
        'srv-1',
        TYPE,
        {
          Description: 'new description',
          ServiceAttributes: { team: 'cdkd', tier: 'frontend' },
        },
        {
          Description: 'old description',
          ServiceAttributes: { team: 'cdkd', tier: 'backend', stale: 'gone' },
        }
      );

      expect(result).toEqual({ physicalId: 'srv-1', wasReplaced: false });

      // 1. ServiceChange carried Description via UpdateService.
      const svcChange = callOf(UpdateServiceCommand);
      expect(svcChange).toBeDefined();
      expect((svcChange!.input as { Service?: Record<string, unknown> }).Service).toEqual({
        Description: 'new description',
      });

      // 2. Only the changed attribute key (`tier`) is upserted (`team` unchanged).
      const upsert = callOf(UpdateServiceAttributesCommand);
      expect(upsert).toBeDefined();
      expect(upsert!.input).toEqual({ ServiceId: 'srv-1', Attributes: { tier: 'frontend' } });

      // 3. The key present only in the old state (`stale`) is removed.
      const del = callOf(DeleteServiceAttributesCommand);
      expect(del).toBeDefined();
      expect(del!.input).toEqual({ ServiceId: 'srv-1', Attributes: ['stale'] });

      expect(mockSend).toHaveBeenCalledTimes(3);
    });
  });
});

// Issue #3136: the service id is AWS-minted (off the CreateService response)
// and still routed through `pasteableAwsCommand` in BOTH manual-delete
// commands the attributes-wiring failure can print — the interrupt handle and
// the cleanup-failure warn.
describe('ServiceDiscoveryProvider manual delete-service commands (issue #3136)', () => {
  const warn = (getLogger().child('x') as unknown as { warn: ReturnType<typeof vi.fn> }).warn;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  async function warnsFor(
    serviceId: string,
    maskSecrets?: (t: string) => string
  ): Promise<{ interrupted: string; failed: string }> {
    mockSend
      .mockResolvedValueOnce({ Service: { Id: serviceId, Arn: 'arn:srv', Name: 'mysvc' } })
      .mockRejectedValueOnce(new InterruptedWaitError('Cloud Map service Svc attributes'))
      .mockRejectedValueOnce(new Error('DeleteService also failed'));
    await expect(
      new ServiceDiscoveryProvider().create(
        'Svc',
        TYPE,
        { Name: 'mysvc', NamespaceId: 'ns-1', ServiceAttributes: { team: 'cdkd' } },
        maskSecrets ? { maskSecrets } : undefined
      )
    ).rejects.toThrow();
    const lines = warn.mock.calls.map((c) => String(c[0]));
    return {
      interrupted: lines.find((m) => m.includes('Interrupted after creating ServiceDiscovery'))!,
      failed: lines.find((m) => m.includes('Failed to clean up partially-created ServiceDiscovery'))!,
    };
  }

  it('renders a clean id bare in both commands', async () => {
    const { interrupted, failed } = await warnsFor('srv-abc');
    for (const msg of [interrupted, failed]) {
      expect(msg).toContain('aws servicediscovery delete-service --id srv-abc');
    }
  });

  it('shell-quotes a forged id in both commands', async () => {
    const id = `srv-1${FORGED_QUOTE}`;
    const { interrupted, failed } = await warnsFor(id);
    for (const msg of [interrupted, failed]) {
      expectQuotedAfter(msg, 'aws servicediscovery delete-service --id ', id);
    }
  });

  it('withholds both commands for an id carrying a control byte', async () => {
    const { interrupted, failed } = await warnsFor(`srv-1${FORGED_CTRL}`);
    for (const msg of [interrupted, failed]) {
      expectWithheld(msg, 'aws servicediscovery delete-service');
    }
  });

  it('withholds both commands for an id the caller masker would change', async () => {
    const { interrupted, failed } = await warnsFor('srv-s3cr3t', (t) =>
      t.replaceAll('s3cr3t', '***')
    );
    for (const msg of [interrupted, failed]) {
      expectWithheld(msg, 'aws servicediscovery delete-service');
    }
  });
});

