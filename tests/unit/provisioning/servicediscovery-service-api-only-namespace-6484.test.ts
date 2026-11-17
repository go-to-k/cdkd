import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  UpdateServiceCommand,
  UpdateServiceAttributesCommand,
} from '@aws-sdk/client-servicediscovery';

// go-to-k/cdkd#6484: AWS refuses UpdateService for a service in an HTTP
// (API-only) namespace, and CloudFormation reports that update as applied
// while changing nothing. cdkd lets the deploy go on, warns, and records what
// AWS still holds.

const mockSend = vi.fn();
const warn = vi.fn();

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
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => warn(...args),
      error: vi.fn(),
    }),
  };
});

const { ServiceDiscoveryProvider } = await import(
  '../../../src/provisioning/providers/servicediscovery-provider.js'
);
const { ProvisioningError } = await import('../../../src/utils/error-handler.js');

const TYPE = 'AWS::ServiceDiscovery::Service';

function apiOnlyRefusal(): Error {
  const err = new Error('Service in API-only namespace cannot be updated.');
  err.name = 'InvalidInput';
  return err;
}

beforeEach(() => {
  mockSend.mockReset();
  warn.mockReset();
});

describe('ServiceDiscovery Service update in an HTTP namespace (#6484)', () => {
  it('goes on, warns, and records the description AWS still holds', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateServiceCommand) throw apiOnlyRefusal();
      return {};
    });
    const result = await new ServiceDiscoveryProvider().update(
      'Svc',
      'srv-1',
      TYPE,
      { Name: 'svc', NamespaceId: 'ns-1', Description: 'new' },
      { Name: 'svc', NamespaceId: 'ns-1', Description: 'old' }
    );
    expect(result.wasReplaced).toBe(false);
    expect(result.effectiveProperties).toEqual({ Name: 'svc', NamespaceId: 'ns-1', Description: 'old' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('HTTP (API-only) namespace');
    expect(String(warn.mock.calls[0]![0])).toContain('Svc');
  });

  it('drops a ServiceChange key the record lacks, rather than recording the template value', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateServiceCommand) throw apiOnlyRefusal();
      return {};
    });
    const result = await new ServiceDiscoveryProvider().update(
      'Svc',
      'srv-1',
      TYPE,
      { Name: 'svc', NamespaceId: 'ns-1', Description: 'added' },
      { Name: 'svc', NamespaceId: 'ns-1' }
    );
    expect(result.effectiveProperties).toEqual({ Name: 'svc', NamespaceId: 'ns-1' });
  });

  it('still applies the ServiceAttributes change the same deploy carries', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateServiceCommand) throw apiOnlyRefusal();
      return {};
    });
    const result = await new ServiceDiscoveryProvider().update(
      'Svc',
      'srv-1',
      TYPE,
      { Name: 'svc', NamespaceId: 'ns-1', Description: 'new', ServiceAttributes: { k: 'v2' } },
      { Name: 'svc', NamespaceId: 'ns-1', Description: 'old', ServiceAttributes: { k: 'v1' } }
    );
    expect(mockSend.mock.calls.some((c) => c[0] instanceof UpdateServiceAttributesCommand)).toBe(true);
    expect(result.effectiveProperties).toEqual({
      Name: 'svc',
      NamespaceId: 'ns-1',
      Description: 'old',
      ServiceAttributes: { k: 'v2' },
    });
  });

  it('still fails on any other UpdateService refusal', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateServiceCommand) {
        const err = new Error('Service dns config cannot be null');
        err.name = 'InvalidInput';
        throw err;
      }
      return {};
    });
    await expect(
      new ServiceDiscoveryProvider().update(
        'Svc',
        'srv-1',
        TYPE,
        { Name: 'svc', NamespaceId: 'ns-1', Description: 'new' },
        { Name: 'svc', NamespaceId: 'ns-1', Description: 'old' }
      )
    ).rejects.toBeInstanceOf(ProvisioningError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records the desired bag as usual when the update is accepted', async () => {
    mockSend.mockResolvedValue({});
    const result = await new ServiceDiscoveryProvider().update(
      'Svc',
      'srv-1',
      TYPE,
      { Name: 'svc', NamespaceId: 'ns-1', Description: 'new' },
      { Name: 'svc', NamespaceId: 'ns-1', Description: 'old' }
    );
    expect(result.effectiveProperties).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
