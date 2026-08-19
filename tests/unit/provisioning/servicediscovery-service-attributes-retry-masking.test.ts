import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateServiceCommand,
  DeleteServiceCommand,
  UpdateServiceAttributesCommand,
  DeleteServiceAttributesCommand,
} from '@aws-sdk/client-servicediscovery';
import { SECRET_MASK, createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import { isTransientServerError } from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Issue #2050, ServiceDiscovery half — the twin of
 * `elbv2-listener-attributes-retry-masking.test.ts`. Two disclosure surfaces:
 *
 * 1. THE RETRY LOGGER. `withRetry` interpolates the AWS message VERBATIM into
 *    its per-attempt `debug` line and into the give-up `warn` summary (issue
 *    #2018), which prints at DEFAULT verbosity.
 * 2. THE THROWN ERROR (review round 2). `withRetry` rethrows the RAW error and
 *    the provider interpolates `error.message` into its `ProvisioningError`,
 *    which the deploy engine prints at ERROR — DEFAULT verbosity again. Strictly
 *    WIDER: on a NON-RETRYABLE rejection `withRetry` logs nothing at all, so the
 *    throw is the only surface.
 *
 * The payload is `ServiceAttributes` keys and values from RESOLVED template
 * properties. The assertions are on the STRING that escaped, never on the mere
 * presence of a logger or a context.
 */

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

// Collapse the retry backoff so the real ~47s budget runs instantly. The retry
// COUNT, the classification, and the give-up summary are all still real.
vi.mock('../../../src/deployment/retry.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/deployment/retry.js')>(
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
        sleep: () => Promise.resolve(),
      })) as typeof actual.withRetry,
  };
});

import { getLogger } from '../../../src/utils/logger.js';
import {
  ServiceDiscoveryProvider,
} from '../../../src/provisioning/providers/servicediscovery-provider.js';

const logger = getLogger() as unknown as {
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

const SERVICE_TYPE = 'AWS::ServiceDiscovery::Service';

/**
 * Distinctive enough that no other assertion in the suite uses it as a "must
 * not appear" needle — a fixture literal colliding with someone else's needle
 * would produce a false leak report.
 */
const SECRET_PLAINTEXT = 'servicediscovery-attr-plaintext-4b7e2a';
const SECRET_EXPR = '{{resolve:secretsmanager:cloudmap-attrs:SecretString:token::}}';

const maskSecrets = createSecretMasker(new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));

/**
 * An AWS-shaped transient 5xx: drives the retry to exhaustion so `withRetry`
 * emits its give-up `warn` summary.
 */
function transientAwsError(): Error {
  const err = new Error(
    `ValidationException: service attribute "${SECRET_PLAINTEXT}" was rejected by the service`
  );
  err.name = 'ServiceUnavailable';
  (err as unknown as Record<string, unknown>)['$metadata'] = {
    httpStatusCode: 503,
    requestId: 'req-sd-2050',
  };
  return err;
}

/**
 * A NON-RETRYABLE AWS rejection: HTTP 400, a name outside the throttle set, and
 * a message matching no entry in `RETRYABLE_ERROR_MESSAGE_PATTERNS`. `withRetry`
 * rethrows on attempt 0 having logged NOTHING — the case the give-up summary
 * structurally cannot cover.
 */
function nonRetryableAwsError(): Error {
  const err = new Error(
    `InvalidInput: service attribute "${SECRET_PLAINTEXT}" is not permitted here`
  );
  err.name = 'InvalidInput';
  (err as unknown as Record<string, unknown>)['$metadata'] = {
    httpStatusCode: 400,
    requestId: 'req-sd-2050-nonretryable',
  };
  return err;
}

function loggedLines(): string {
  return [...logger.debug.mock.calls, ...logger.warn.mock.calls]
    .map((c) => String(c[0]))
    .join('\n');
}

function warnLines(): string {
  return logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

async function captureThrow(fn: () => Promise<unknown>): Promise<ProvisioningError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    return error as ProvisioningError;
  }
  throw new Error('expected the provider call to reject, but it resolved');
}

describe('ServiceDiscoveryProvider ServiceAttributes secret masking (#2050)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  /** CreateService succeeds; the post-create attributes call always fails. */
  function primeCreate(failure: () => Error): void {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateServiceCommand) {
        return Promise.resolve({ Service: { Id: 'srv-1', Arn: 'arn:srv-1', Name: 'mysvc' } });
      }
      if (command instanceof UpdateServiceAttributesCommand) return Promise.reject(failure());
      if (command instanceof DeleteServiceCommand) return Promise.resolve({});
      return Promise.resolve({});
    });
  }

  function primeUpsert(failure: () => Error): void {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof UpdateServiceAttributesCommand) return Promise.reject(failure());
      return Promise.resolve({});
    });
  }

  function primeRemoval(failure: () => Error): void {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteServiceAttributesCommand) return Promise.reject(failure());
      return Promise.resolve({});
    });
  }

  function createService(context?: { maskSecrets: typeof maskSecrets }): Promise<unknown> {
    return provider.create(
      'Svc',
      SERVICE_TYPE,
      { Name: 'mysvc', NamespaceId: 'ns-1', ServiceAttributes: { token: SECRET_PLAINTEXT } },
      context
    );
  }

  function upsertAttributes(context?: { maskSecrets: typeof maskSecrets }): Promise<unknown> {
    return provider.update(
      'Svc',
      'srv-1',
      SERVICE_TYPE,
      { ServiceAttributes: { token: SECRET_PLAINTEXT } },
      { ServiceAttributes: {} },
      context
    );
  }

  /**
   * A pure REMOVAL: the desired bag drops the key the previous one held, so the
   * upsert map is empty and `DeleteServiceAttributes` is the sole call. The KEY
   * is the secret here — AWS quotes a rejected key back the same way it quotes a
   * rejected value.
   */
  function removeAttributes(context?: { maskSecrets: typeof maskSecrets }): Promise<unknown> {
    return provider.update(
      'Svc',
      'srv-1',
      SERVICE_TYPE,
      { ServiceAttributes: {} },
      { ServiceAttributes: { [SECRET_PLAINTEXT]: 'v' } },
      context
    );
  }

  function expectPayloadCarriedThePlaintext(
    cls: typeof UpdateServiceAttributesCommand | typeof DeleteServiceAttributesCommand
  ): void {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof cls);
    expect(call).toBeDefined();
    expect(JSON.stringify((call![0] as { input: unknown }).input)).toContain(SECRET_PLAINTEXT);
  }

  describe('retry logger — create path (UpdateServiceAttributes)', () => {
    it('masks the give-up summary and every per-attempt line', async () => {
      primeCreate(transientAwsError);

      await expect(createService({ maskSecrets })).rejects.toThrow();

      expectPayloadCarriedThePlaintext(UpdateServiceAttributesCommand);

      const warned = warnLines();
      expect(warned).toContain('gave up after');
      expect(warned).toContain('transient server-error');
      expect(warned).toContain(SECRET_MASK);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(loggedLines()).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeCreate(transientAwsError);

      await expect(createService()).rejects.toThrow();

      // The identity fallback must keep the give-up summary flowing — a `warn`
      // silently dropped here would reopen the issue #2018 reporting hole.
      const warned = warnLines();
      expect(warned).toContain('gave up after');
      expect(warned).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('retry logger — update path (UpdateServiceAttributes)', () => {
    it('masks the give-up summary and every per-attempt line', async () => {
      primeUpsert(transientAwsError);

      await expect(upsertAttributes({ maskSecrets })).rejects.toThrow();

      expectPayloadCarriedThePlaintext(UpdateServiceAttributesCommand);

      const warned = warnLines();
      expect(warned).toContain('gave up after');
      expect(warned).toContain(SECRET_MASK);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(loggedLines()).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeUpsert(transientAwsError);

      await expect(upsertAttributes()).rejects.toThrow();

      const warned = warnLines();
      expect(warned).toContain('gave up after');
      expect(warned).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('retry logger — update path (DeleteServiceAttributes)', () => {
    it('masks the give-up summary for the key-removal call too', async () => {
      primeRemoval(transientAwsError);

      await expect(removeAttributes({ maskSecrets })).rejects.toThrow();

      expectPayloadCarriedThePlaintext(DeleteServiceAttributesCommand);
      // No upsert happened, so this test really does fence the removal site.
      expect(
        mockSend.mock.calls.some((c) => c[0] instanceof UpdateServiceAttributesCommand)
      ).toBe(false);

      const warned = warnLines();
      expect(warned).toContain('gave up after');
      expect(warned).toContain(SECRET_MASK);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(loggedLines()).not.toContain(SECRET_PLAINTEXT);
    });
  });

  describe('thrown ProvisioningError — create path (#2050 review round 2)', () => {
    it('masks the AWS message on a NON-RETRYABLE rejection', async () => {
      primeCreate(nonRetryableAwsError);

      const thrown = await captureThrow(() => createService({ maskSecrets }));

      expectPayloadCarriedThePlaintext(UpdateServiceAttributesCommand);

      // Non-vacuity, and why this is not a duplicate of the retry tests:
      // nothing was retried, so `withRetry` logged NOTHING and the throw is the
      // only surface the value could escape through.
      expect(warnLines()).not.toContain('gave up after');
      expect(mockSend.mock.calls.filter((c) => c[0] instanceof UpdateServiceAttributesCommand))
        .toHaveLength(1);

      expect(thrown.message).toContain('Failed to create service discovery service Svc');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeCreate(nonRetryableAwsError);

      const thrown = await captureThrow(() => createService());

      expect(thrown.message).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('thrown ProvisioningError — update path (#2050 review round 2)', () => {
    it('masks the AWS message on a NON-RETRYABLE upsert rejection', async () => {
      primeUpsert(nonRetryableAwsError);

      const thrown = await captureThrow(() => upsertAttributes({ maskSecrets }));

      expectPayloadCarriedThePlaintext(UpdateServiceAttributesCommand);
      expect(warnLines()).not.toContain('gave up after');

      expect(thrown.message).toContain('Failed to update service discovery service Svc');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });

    it('masks the AWS message on a NON-RETRYABLE removal rejection', async () => {
      primeRemoval(nonRetryableAwsError);

      const thrown = await captureThrow(() => removeAttributes({ maskSecrets }));

      expectPayloadCarriedThePlaintext(DeleteServiceAttributesCommand);

      expect(thrown.message).toContain('Failed to update service discovery service Svc');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeUpsert(nonRetryableAwsError);

      const thrown = await captureThrow(() => upsertAttributes());

      expect(thrown.message).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('masking the message must not disturb retry classification', () => {
    it('preserves the original error as `cause`, $metadata walk intact', async () => {
      primeUpsert(transientAwsError);

      const thrown = await captureThrow(() => upsertAttributes({ maskSecrets }));

      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
      const cause = thrown.cause as Error & { $metadata?: { httpStatusCode?: number } };
      expect(cause).toBeInstanceOf(Error);
      expect(cause.$metadata?.httpStatusCode).toBe(503);
      expect(isTransientServerError(thrown)).toBe(true);
      // The cause deliberately still carries the plaintext: it is the ORIGINAL
      // error object. Only rendered text is masked.
      expect(cause.message).toContain(SECRET_PLAINTEXT);
    });
  });
});
