import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateServiceCommand,
  InvalidInput,
  NamespaceNotFound,
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

// One logger object for the whole module, reachable from the test body.
vi.mock('../../../src/utils/logger.js', () => {
  const logger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger['child'] = () => logger;
  return { getLogger: () => logger };
});

// Record the backoff instead of sleeping it, so the ~30s budget runs
// instantly and its LENGTH is still asserted.
const slept: number[] = [];
vi.mock('../../../src/deployment/retry.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../src/deployment/retry.js')>(
      '../../../src/deployment/retry.js'
    );
  return {
    ...actual,
    withRetry: (<T>(
      operation: () => Promise<T>,
      logicalId: string,
      opts: Record<string, unknown> = {}
    ) =>
      actual.withRetry(operation, logicalId, {
        ...opts,
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
      })) as typeof actual.withRetry,
  };
});

import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { getLogger } from '../../../src/utils/logger.js';
import { SECRET_MASK, createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../src/provisioning/interrupt-watch.js';

const logger = getLogger() as unknown as {
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

const NAMESPACE_ID = 'ns-abcdefghijklmnop';

function namespaceNotFound(): NamespaceNotFound {
  // Cloud Map's message is the bare namespace id.
  return new NamespaceNotFound({ message: NAMESPACE_ID, $metadata: { httpStatusCode: 400 } });
}

function createServiceCalls(): CreateServiceCommand[] {
  return mockSend.mock.calls
    .map(([cmd]) => cmd as unknown)
    .filter((cmd): cmd is CreateServiceCommand => cmd instanceof CreateServiceCommand);
}

/**
 * Issue #5113: right after a namespace's create operation reports SUCCESS,
 * Cloud Map can answer `CreateService` with `NamespaceNotFound` (observed live
 * on the servicediscovery fixture, one of four parallel creates). The provider
 * retries THAT error only, for a bounded ~30s, and fails fast on every other.
 */
describe('ServiceDiscoveryProvider createService NamespaceNotFound retry (#5113)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    mockSend.mockReset();
    logger.debug.mockClear();
    logger.warn.mockClear();
    slept.length = 0;
    provider = new ServiceDiscoveryProvider();
  });

  const properties = {
    Name: 'ttl-service',
    NamespaceId: NAMESPACE_ID,
    DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] },
  };

  it('retries CreateService while the fresh namespace is not yet visible, then creates the service', async () => {
    mockSend
      .mockRejectedValueOnce(namespaceNotFound())
      .mockRejectedValueOnce(namespaceNotFound())
      .mockResolvedValueOnce({
        Service: {
          Id: 'srv-abcdefghijklmnop',
          Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abcdefghijklmnop',
          Name: 'ttl-service',
        },
      });

    const result = await provider.create(
      'TtlService',
      'AWS::ServiceDiscovery::Service',
      properties
    );

    expect(result.physicalId).toBe('srv-abcdefghijklmnop');
    const calls = createServiceCalls();
    expect(calls).toHaveLength(3);
    // Every attempt sends the same request against the same namespace.
    for (const cmd of calls) {
      expect(cmd.input.NamespaceId).toBe(NAMESPACE_ID);
      expect(cmd.input.Name).toBe('ttl-service');
    }
    // No other call is made: nothing was created by the rejected attempts, so
    // there is nothing to clean up.
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(1_500);
  });

  it('gives up after the bounded budget when the namespace never becomes visible', async () => {
    mockSend.mockRejectedValue(namespaceNotFound());

    const error = await provider
      .create('TtlService', 'AWS::ServiceDiscovery::Service', properties)
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(ProvisioningError);
    // go-to-k/cdkd#2319: AWS's text is withheld, the class named instead.
    expect((error as Error).message).toBe(
      `Failed to create service discovery service TtlService (Cloud Map still rejected the ` +
        `namespace after 27.5s of retries): NamespaceNotFound. ${VERBOSE_POINTER}`
    );
    // The note must not hand the substring classifiers a not-found phrase,
    // and the class name matches none of their (case-sensitive) needles.
    expect((error as Error).message).not.toContain(NAMESPACE_ID);
    for (const needle of ['does not exist', 'was not found', 'not found', 'NotFoundException']) {
      expect((error as Error).message).not.toContain(needle);
    }
    expect((error as Error).cause).toBeInstanceOf(NamespaceNotFound);
    // 1 initial attempt + 9 retries.
    expect(createServiceCalls()).toHaveLength(10);
    // 0.5s -> 1s -> 2s -> 4s x6: 27.5s of backoff, ~30s with the calls.
    expect(slept.reduce((a, b) => a + b, 0)).toBe(27_500);
  });

  it('does NOT retry any other error', async () => {
    mockSend.mockRejectedValueOnce(
      new InvalidInput({ message: 'Invalid DnsConfig', $metadata: { httpStatusCode: 400 } })
    );

    await expect(
      provider.create('TtlService', 'AWS::ServiceDiscovery::Service', properties)
    ).rejects.toThrow(
      `Failed to create service discovery service TtlService: InvalidInput. ${VERBOSE_POINTER}`
    );

    expect(createServiceCalls()).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('masks a secret-derived NamespaceId in the per-retry lines (issue #2050)', async () => {
    // AWS's NamespaceNotFound message quotes the RESOLVED id back, and
    // `withRetry` prints that message on every retry line.
    const secret = 'sd-namespace-plaintext-5113-9c1f';
    const maskSecrets = createSecretMasker(
      new Map([[secret, '{{resolve:secretsmanager:ns:SecretString:id::}}']])
    );
    mockSend
      .mockRejectedValueOnce(
        new NamespaceNotFound({ message: secret, $metadata: { httpStatusCode: 400 } })
      )
      .mockResolvedValueOnce({ Service: { Id: 'srv-abcdefghijklmnop', Name: 'ttl-service' } });

    await provider.create(
      'TtlService',
      'AWS::ServiceDiscovery::Service',
      { ...properties, NamespaceId: secret },
      { maskSecrets }
    );

    const retryLines = logger.debug.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('Retrying TtlService'));
    expect(retryLines).toHaveLength(1);
    expect(retryLines[0]).toContain(SECRET_MASK);
    expect(retryLines[0]).not.toContain(secret);
  });

  it('does NOT retry a throttle either — the outer deploy retry owns that class', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    });
    mockSend.mockRejectedValueOnce(throttle);

    await expect(
      provider.create('TtlService', 'AWS::ServiceDiscovery::Service', properties)
    ).rejects.toThrow(ProvisioningError);

    expect(createServiceCalls()).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});

/**
 * Issue #2053: the ~30s retry is a bounded wait, so a Ctrl-C ends it at the
 * attempt the signal landed in. The discriminator is the ATTEMPT COUNT: an
 * unwatched loop also rejects, after all ten.
 */
describe('ServiceDiscoveryProvider createService NamespaceNotFound retry aborts on Ctrl-C (#5113)', () => {
  let baseline: readonly unknown[] = [];

  beforeEach(() => {
    mockSend.mockReset();
    slept.length = 0;
    // Stand in for the SIGINT handler a real command installs; see
    // servicediscovery-interrupt.test.ts for why the watch needs it to arm.
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    baseline = process.listeners('SIGINT');
  });

  afterEach(() => {
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('stops at the attempt the signal landed in, not after the whole budget', async () => {
    let attempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateServiceCommand) {
        attempts += 1;
        if (attempts === 2) {
          for (const listener of process.listeners('SIGINT').filter((l) => !baseline.includes(l))) {
            (listener as unknown as () => void)();
          }
        }
        return Promise.reject(namespaceNotFound());
      }
      return Promise.resolve({});
    });

    await expect(
      new ServiceDiscoveryProvider().create('TtlService', 'AWS::ServiceDiscovery::Service', {
        Name: 'ttl-service',
        NamespaceId: NAMESPACE_ID,
      })
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    expect(attempts).toBe(2);
  });
});
