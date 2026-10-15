import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier Cloud Map namespace or service. Only
// `'different'` lets it delete.

const { mockSend, clientRegion } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
}));

vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-servicediscovery')>();
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
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
  return { getLogger: () => ({ ...childLogger, child: () => childLogger }) };
});

import {
  GetNamespaceCommand,
  GetServiceCommand,
  NamespaceNotFound,
  ServiceNotFound,
} from '@aws-sdk/client-servicediscovery';
import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';

const CTX = { expectedRegion: 'us-east-1' };
const NS_A = 'ns-aaaaaaaaaaaaaaa1';
const NS_B = 'ns-bbbbbbbbbbbbbbb2';
const SRV_A = 'srv-aaaaaaaaaaaaaaa1';
const SRV_B = 'srv-bbbbbbbbbbbbbbb2';

const NAMESPACE_KINDS = [
  ['AWS::ServiceDiscovery::PrivateDnsNamespace', 'DNS_PRIVATE'],
  ['AWS::ServiceDiscovery::PublicDnsNamespace', 'DNS_PUBLIC'],
  ['AWS::ServiceDiscovery::HttpNamespace', 'HTTP'],
] as const;
const SERVICE_TYPE = 'AWS::ServiceDiscovery::Service';

const awsError = (name: string, message = name): Error =>
  Object.assign(new Error(message), { name });

/** `GetNamespace` answers per id: its `Type`, gone, or an error. */
function namespaces(live: Record<string, string | 'gone' | Error>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof GetNamespaceCommand)) throw new Error('unexpected command');
    const id = cmd.input.Id!;
    const entry = live[id];
    if (entry === undefined || entry === 'gone') {
      throw new NamespaceNotFound({ message: 'Namespace not found', $metadata: {} });
    }
    if (entry instanceof Error) throw entry;
    return { Namespace: { Id: id, Type: entry } };
  });
}

/** `GetService` answers per id: live, gone, or an error. */
function services(live: Record<string, 'live' | 'gone' | Error>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof GetServiceCommand)) throw new Error('unexpected command');
    const id = cmd.input.Id!;
    const entry = live[id];
    if (entry === undefined || entry === 'gone') {
      throw new ServiceNotFound({ message: 'Service not found', $metadata: {} });
    }
    if (entry instanceof Error) throw entry;
    return { Service: { Id: id } };
  });
}

const readIds = (): unknown[] =>
  mockSend.mock.calls.map(([c]) => (c as GetNamespaceCommand | GetServiceCommand).input.Id);

let provider: ServiceDiscoveryProvider;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  clientRegion.value = 'us-east-1';
  provider = new ServiceDiscoveryProvider();
});

describe.each(NAMESPACE_KINDS)(
  'ServiceDiscoveryProvider.isSameResource for %s (go-to-k/cdkd#4606)',
  (type, kind) => {
    it('another live namespace is different, after reading the record first, then the journaled one', async () => {
      namespaces({ [NS_A]: kind, [NS_B]: kind });
      expect(await provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).toBe(
        'different'
      );
      expect(readIds()).toEqual([NS_B, NS_A]);
    });

    it('a journaled namespace Cloud Map reports gone is different once the record reads back', async () => {
      namespaces({ [NS_B]: kind });
      expect(await provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).toBe(
        'different'
      );
    });

    it('the record namespace gone is unknown, and the journaled one is not read', async () => {
      namespaces({ [NS_A]: kind });
      expect(await provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).toBe('unknown');
      expect(readIds()).toEqual([NS_B]);
    });

    it('a record namespace of another kind throws (the caller reads it as unknown)', async () => {
      const other = kind === 'HTTP' ? 'DNS_PRIVATE' : 'HTTP';
      namespaces({ [NS_A]: kind, [NS_B]: other });
      await expect(provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).rejects.toThrow(
        'kind asked for'
      );
      expect(readIds()).toEqual([NS_B]);
    });

    it('a journaled namespace of another kind throws, after the record read', async () => {
      const other = kind === 'HTTP' ? 'DNS_PRIVATE' : 'HTTP';
      namespaces({ [NS_A]: other, [NS_B]: kind });
      await expect(provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).rejects.toThrow(
        'kind asked for'
      );
      expect(readIds()).toEqual([NS_B, NS_A]);
    });

    it('equal ids are the same without a read', async () => {
      namespaces({});
      expect(await provider.isSameResource(NS_A, { physicalId: NS_A }, type, CTX)).toBe('same');
      expect(mockSend).not.toHaveBeenCalled();
    });
  }
);

describe('ServiceDiscoveryProvider.isSameResource for namespaces: reads', () => {
  const type = 'AWS::ServiceDiscovery::HttpNamespace';

  it('a record read answering another id is unknown, and the journaled one is not read', async () => {
    mockSend.mockResolvedValue({ Namespace: { Id: NS_A, Type: 'HTTP' } });
    expect(await provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).toBe('unknown');
    expect(readIds()).toEqual([NS_B]);
  });

  // Cloud Map cannot answer one id with another; if it ever does, the entry
  // is kept with a warning, never dropped as tracked ('same') nor deleted.
  it('a journaled id reading back as the record namespace is unknown', async () => {
    mockSend.mockResolvedValue({ Namespace: { Id: NS_B, Type: 'HTTP' } });
    expect(await provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).toBe('unknown');
  });

  it('a journaled read answering a third id is unknown', async () => {
    mockSend.mockImplementation(async (cmd: GetNamespaceCommand) => ({
      Namespace: { Id: cmd.input.Id === NS_B ? NS_B : 'ns-ccccccccccccccc3', Type: 'HTTP' },
    }));
    expect(await provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).toBe('unknown');
  });

  it('a response naming no namespace throws', async () => {
    mockSend.mockResolvedValue({});
    await expect(provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).rejects.toThrow(
      'GetNamespace did not return'
    );
  });

  it('a read that fails other than not-found throws (the caller reads it as unknown)', async () => {
    namespaces({ [NS_A]: awsError('AccessDeniedException', 'denied'), [NS_B]: 'HTTP' });
    await expect(provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).rejects.toThrow(
      'denied'
    );
  });

  it('a client in another region is unknown before any read', async () => {
    clientRegion.value = 'eu-west-1';
    namespaces({ [NS_A]: 'HTTP', [NS_B]: 'HTTP' });
    expect(await provider.isSameResource(NS_A, { physicalId: NS_B }, type, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a short id', 'ns-1', NS_B],
    ['an id one character too long', `${NS_A}x`, NS_B],
    ['a service id', SRV_A, NS_B],
    ['an uppercase id', NS_A.toUpperCase(), NS_B],
    ['an ARN', `arn:aws:servicediscovery:us-east-1:123456789012:namespace/${NS_A}`, NS_B],
    ['an empty record id', NS_A, ''],
  ])('%s is unknown without a read', async (_label, journaled, recorded) => {
    namespaces({ [NS_A]: 'HTTP', [NS_B]: 'HTTP' });
    expect(await provider.isSameResource(journaled, { physicalId: recorded }, type, CTX)).toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('ServiceDiscoveryProvider.isSameResource for AWS::ServiceDiscovery::Service (go-to-k/cdkd#4606)', () => {
  it('another live service is different, after reading the record first, then the journaled one', async () => {
    services({ [SRV_A]: 'live', [SRV_B]: 'live' });
    expect(await provider.isSameResource(SRV_A, { physicalId: SRV_B }, SERVICE_TYPE, CTX)).toBe(
      'different'
    );
    expect(readIds()).toEqual([SRV_B, SRV_A]);
  });

  it('a journaled service Cloud Map reports gone is different once the record reads back', async () => {
    services({ [SRV_B]: 'live' });
    expect(await provider.isSameResource(SRV_A, { physicalId: SRV_B }, SERVICE_TYPE, CTX)).toBe(
      'different'
    );
  });

  it('the record service gone is unknown, and the journaled one is not read', async () => {
    services({ [SRV_A]: 'live' });
    expect(await provider.isSameResource(SRV_A, { physicalId: SRV_B }, SERVICE_TYPE, CTX)).toBe(
      'unknown'
    );
    expect(readIds()).toEqual([SRV_B]);
  });

  it('a record read answering another id is unknown', async () => {
    mockSend.mockResolvedValue({ Service: { Id: SRV_A } });
    expect(await provider.isSameResource(SRV_A, { physicalId: SRV_B }, SERVICE_TYPE, CTX)).toBe(
      'unknown'
    );
    expect(readIds()).toEqual([SRV_B]);
  });

  it('a journaled id reading back as the record service is unknown', async () => {
    mockSend.mockResolvedValue({ Service: { Id: SRV_B } });
    expect(await provider.isSameResource(SRV_A, { physicalId: SRV_B }, SERVICE_TYPE, CTX)).toBe(
      'unknown'
    );
  });

  it('a response naming no service throws', async () => {
    mockSend.mockResolvedValue({});
    await expect(
      provider.isSameResource(SRV_A, { physicalId: SRV_B }, SERVICE_TYPE, CTX)
    ).rejects.toThrow('GetService did not return');
  });

  it('a read that fails other than not-found throws', async () => {
    services({ [SRV_A]: awsError('ThrottlingException', 'slow down'), [SRV_B]: 'live' });
    await expect(
      provider.isSameResource(SRV_A, { physicalId: SRV_B }, SERVICE_TYPE, CTX)
    ).rejects.toThrow('slow down');
  });

  it('equal ids are the same without a read', async () => {
    services({});
    expect(await provider.isSameResource(SRV_A, { physicalId: SRV_A }, SERVICE_TYPE, CTX)).toBe(
      'same'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a client in another region is unknown before any read', async () => {
    clientRegion.value = 'eu-west-1';
    services({ [SRV_A]: 'live', [SRV_B]: 'live' });
    expect(await provider.isSameResource(SRV_A, { physicalId: SRV_B }, SERVICE_TYPE, CTX)).toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a namespace id', NS_A, SRV_B],
    ['a short id', 'srv-1', SRV_B],
    ['an id one character too long', `${SRV_A}x`, SRV_B],
    ['an empty record id', SRV_A, ''],
  ])('%s is unknown without a read', async (_label, journaled, recorded) => {
    services({ [SRV_A]: 'live', [SRV_B]: 'live' });
    expect(
      await provider.isSameResource(journaled, { physicalId: recorded }, SERVICE_TYPE, CTX)
    ).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('ServiceDiscoveryProvider.isSameResource for another type', () => {
  it('is unknown without a read', async () => {
    services({ [SRV_A]: 'live', [SRV_B]: 'live' });
    expect(
      await provider.isSameResource(SRV_A, { physicalId: SRV_B }, 'AWS::ServiceDiscovery::Instance', CTX)
    ).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });
});
