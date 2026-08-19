import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateListenerCommand,
  CreateTargetGroupCommand,
  DeleteListenerCommand,
  ModifyListenerCommand,
  ModifyListenerAttributesCommand,
  RegisterTargetsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { SECRET_MASK, createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import { isTransientServerError } from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Issue #2050, ELBv2 half. Two distinct disclosure surfaces, both fixed here.
 *
 * 1. THE RETRY LOGGER. `withRetry` interpolates the AWS error message VERBATIM
 *    into its per-attempt `debug` line and into the give-up `warn` summary
 *    (issue #2018), and that summary prints at DEFAULT verbosity.
 * 2. THE THROWN ERROR (review round 2). `withRetry` rethrows the RAW error, and
 *    the provider interpolates `error.message` into the wrapping
 *    `ProvisioningError`, which `deploy-engine.ts` prints at ERROR — again
 *    DEFAULT verbosity. So a masked `warn` was followed one line later by the
 *    same text unmasked. This surface is strictly WIDER than (1): for a
 *    NON-RETRYABLE rejection `withRetry` emits nothing at all (its summary is
 *    gated on `propagationRetries > 0 || serverErrorRetries > 0`), so the throw
 *    is the ONLY place the value can escape.
 *
 * The payload in both cases is `ListenerAttributes` built from RESOLVED
 * template properties — a `{{resolve:secretsmanager:...}}` scalar is already
 * plaintext by the time a provider sees it.
 *
 * Every assertion below is on the STRING that escaped — the logger's argument,
 * or the thrown error's `message`. A presence-only assertion (a logger was
 * passed / a context was accepted) is satisfied by the very code this issue is
 * about.
 */

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-elastic-load-balancing-v2')
  >('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilLoadBalancerAvailable: vi.fn().mockResolvedValue({ state: 'SUCCESS' }),
  };
});

// One logger object for the whole module, reachable from the test body: the
// assertions are about the exact text this provider handed to it.
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
// COUNT, the classification, and the give-up summary are all still real — only
// the wall-clock sleep is removed.
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
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const logger = getLogger() as unknown as {
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

const LISTENER_TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1';
const LISTENER_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/abc/def';
const TG_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/0123456789abcdef';

/**
 * A value distinctive enough that no other assertion in the suite uses it as a
 * "must not appear" needle — a fixture literal that collided with someone
 * else's needle would produce a false leak report.
 */
const SECRET_PLAINTEXT = 'elbv2-listener-attr-plaintext-9c1d4e';
const SECRET_EXPR = '{{resolve:secretsmanager:alb-attrs:SecretString:token::}}';

/** The masker a real caller (deploy engine / rollback / drift) would thread. */
const maskSecrets = createSecretMasker(new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));

const ATTR_KEY = 'routing.http.request.x_amzn_mtls_clientcert.header_name';

/**
 * An AWS-shaped transient 5xx. `isTransientServerError` reads
 * `$metadata.httpStatusCode`, so this drives the retry to exhaustion and makes
 * `withRetry` emit its give-up `warn` summary — the line that prints without
 * `--verbose`, and the one that quotes the AWS message verbatim.
 */
function transientAwsError(): Error {
  const err = new Error(
    `ValidationError: attribute value "${SECRET_PLAINTEXT}" was rejected by the service`
  );
  err.name = 'ServiceUnavailable';
  (err as unknown as Record<string, unknown>)['$metadata'] = {
    httpStatusCode: 503,
    requestId: 'req-elbv2-2050',
  };
  return err;
}

/**
 * A NON-RETRYABLE AWS rejection: HTTP 400, a name outside the throttle set, and
 * a message matching no entry in `RETRYABLE_ERROR_MESSAGE_PATTERNS`. `withRetry`
 * therefore rethrows on attempt 0 having logged NOTHING, which is precisely the
 * case the give-up summary cannot cover and the thrown message is the only
 * surface for.
 */
function nonRetryableAwsError(): Error {
  const err = new Error(
    `ValidationException: attribute value "${SECRET_PLAINTEXT}" is not permitted here`
  );
  err.name = 'ValidationException';
  (err as unknown as Record<string, unknown>)['$metadata'] = {
    httpStatusCode: 400,
    requestId: 'req-elbv2-2050-nonretryable',
  };
  return err;
}

/** Every line the provider handed the logger, joined for substring assertions. */
function loggedLines(): string {
  return [...logger.debug.mock.calls, ...logger.warn.mock.calls]
    .map((c) => String(c[0]))
    .join('\n');
}

function warnLines(): string {
  return logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

/** Run `fn`, requiring it to reject, and hand back the ProvisioningError. */
async function captureThrow(fn: () => Promise<unknown>): Promise<ProvisioningError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    return error as ProvisioningError;
  }
  throw new Error('expected the provider call to reject, but it resolved');
}

const LISTENER_BASE_PROPS = {
  LoadBalancerArn: LB_ARN,
  Port: 443,
  Protocol: 'HTTPS',
  DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '200' } }],
};

describe('ELBv2Provider ModifyListenerAttributes retry logging is secret-masked (#2050)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ELBv2Provider();
  });

  /** CreateListener succeeds; the post-create attributes call always fails. */
  function primeCreate(failure: () => Error): void {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateListenerCommand) {
        return Promise.resolve({ Listeners: [{ ListenerArn: LISTENER_ARN }] });
      }
      if (command instanceof ModifyListenerAttributesCommand) {
        return Promise.reject(failure());
      }
      if (command instanceof DeleteListenerCommand) return Promise.resolve({});
      return Promise.resolve({});
    });
  }

  /** ModifyListener succeeds; the attributes call always fails. */
  function primeUpdate(failure: () => Error): void {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof ModifyListenerCommand) return Promise.resolve({});
      if (command instanceof ModifyListenerAttributesCommand) {
        return Promise.reject(failure());
      }
      return Promise.resolve({});
    });
  }

  function createListener(context?: { maskSecrets: typeof maskSecrets }): Promise<unknown> {
    return provider.create(
      'Listener',
      LISTENER_TYPE,
      {
        ...LISTENER_BASE_PROPS,
        ListenerAttributes: [{ Key: ATTR_KEY, Value: SECRET_PLAINTEXT }],
      },
      context
    );
  }

  function updateListener(context?: { maskSecrets: typeof maskSecrets }): Promise<unknown> {
    return provider.update(
      'Listener',
      LISTENER_ARN,
      LISTENER_TYPE,
      {
        Port: 443,
        Protocol: 'HTTPS',
        ListenerAttributes: [{ Key: ATTR_KEY, Value: SECRET_PLAINTEXT }],
      },
      { Port: 443, Protocol: 'HTTPS', ListenerAttributes: [] },
      context
    );
  }

  /** The submitted payload really carried the plaintext (fixture non-vacuity). */
  function expectPayloadCarriedThePlaintext(): void {
    const attrCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyListenerAttributesCommand
    );
    expect(attrCall).toBeDefined();
    expect(JSON.stringify((attrCall![0] as ModifyListenerAttributesCommand).input)).toContain(
      SECRET_PLAINTEXT
    );
  }

  describe('retry logger — create path', () => {
    it('masks the give-up summary and every per-attempt line', async () => {
      primeCreate(transientAwsError);

      await expect(createListener({ maskSecrets })).rejects.toThrow();

      expectPayloadCarriedThePlaintext();

      // Non-vacuity: the retry really did exhaust, so the give-up summary (the
      // DEFAULT-verbosity line) was actually emitted.
      const warned = warnLines();
      expect(warned).toContain('gave up after');
      expect(warned).toContain('transient server-error');

      expect(warned).toContain(SECRET_MASK);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(loggedLines()).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeCreate(transientAwsError);

      await expect(createListener()).rejects.toThrow();

      // No context at all: the identity fallback must keep the give-up summary
      // flowing (a `warn` silently dropped here would be the issue #2018
      // reporting hole reopened), unmasked exactly as before.
      const warned = warnLines();
      expect(warned).toContain('gave up after');
      expect(warned).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('retry logger — update path', () => {
    it('masks the give-up summary and every per-attempt line', async () => {
      primeUpdate(transientAwsError);

      await expect(updateListener({ maskSecrets })).rejects.toThrow();

      expectPayloadCarriedThePlaintext();

      const warned = warnLines();
      expect(warned).toContain('gave up after');
      expect(warned).toContain(SECRET_MASK);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(loggedLines()).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeUpdate(transientAwsError);

      await expect(updateListener()).rejects.toThrow();

      const warned = warnLines();
      expect(warned).toContain('gave up after');
      expect(warned).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('thrown ProvisioningError — create path (#2050 review round 2)', () => {
    it('masks the AWS message on a NON-RETRYABLE rejection', async () => {
      primeCreate(nonRetryableAwsError);

      const thrown = await captureThrow(() => createListener({ maskSecrets }));

      expectPayloadCarriedThePlaintext();

      // Non-vacuity, and the reason this case is not a duplicate of the retry
      // tests: nothing was retried, so `withRetry` logged NOTHING and the throw
      // is the only surface the value could escape through.
      expect(warnLines()).not.toContain('gave up after');
      expect(mockSend.mock.calls.filter((c) => c[0] instanceof ModifyListenerAttributesCommand))
        .toHaveLength(1);

      expect(thrown.message).toContain('Failed to create Listener Listener');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });

    it('masks the AWS message on an EXHAUSTED retry, where the warn is masked too', async () => {
      primeCreate(transientAwsError);

      const thrown = await captureThrow(() => createListener({ maskSecrets }));

      // The pair that made this a blocker: pre-fix the masked `warn` was
      // followed one line later by this same text unmasked, at the same
      // verbosity.
      expect(warnLines()).toContain(SECRET_MASK);
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeCreate(nonRetryableAwsError);

      const thrown = await captureThrow(() => createListener());

      expect(thrown.message).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('thrown ProvisioningError — update path (#2050 review round 2)', () => {
    it('masks the AWS message on a NON-RETRYABLE rejection', async () => {
      primeUpdate(nonRetryableAwsError);

      const thrown = await captureThrow(() => updateListener({ maskSecrets }));

      expectPayloadCarriedThePlaintext();
      expect(warnLines()).not.toContain('gave up after');

      expect(thrown.message).toContain('Failed to update Listener Listener');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeUpdate(nonRetryableAwsError);

      const thrown = await captureThrow(() => updateListener());

      expect(thrown.message).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('masking the message must not disturb retry classification', () => {
    it('preserves the original error as `cause`, $metadata walk intact', async () => {
      primeUpdate(transientAwsError);

      const thrown = await captureThrow(() => updateListener({ maskSecrets }));

      // The message was rewritten; the CAUSE chain was not. `withRetry`'s
      // classifier walks `cause` for `$metadata.httpStatusCode`, so rewriting or
      // dropping it would silently change what cdkd considers retryable.
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
      const cause = thrown.cause as Error & { $metadata?: { httpStatusCode?: number } };
      expect(cause).toBeInstanceOf(Error);
      expect(cause.$metadata?.httpStatusCode).toBe(503);
      expect(isTransientServerError(thrown)).toBe(true);
      // The cause deliberately still carries the plaintext: it is the ORIGINAL
      // error object, and masking it would be the "redacting a value breaks its
      // replay consumer" failure. Only rendered text is masked.
      expect(cause.message).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('malformed-Targets drop warning is secret-masked (#2050 review round 2)', () => {
    it('masks the stringified rejected entry on the create path', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof CreateTargetGroupCommand) {
          return Promise.resolve({ TargetGroups: [{ TargetGroupArn: TG_ARN }] });
        }
        if (command instanceof RegisterTargetsCommand) return Promise.resolve({});
        return Promise.resolve({});
      });

      // `Id` is a NUMBER, so the entry is dropped and the whole element is
      // stringified into a default-verbosity warn. The secret rides in a
      // sibling key, exactly as a resolved property would.
      await provider.create(
        'TG',
        TARGET_GROUP_TYPE,
        {
          Name: 'my-tg',
          Port: 80,
          Protocol: 'HTTP',
          VpcId: 'vpc-1',
          Targets: [{ Id: 12345, AvailabilityZone: SECRET_PLAINTEXT }],
        },
        { maskSecrets }
      );

      const warned = warnLines();
      // Non-vacuity: the drop branch really did fire.
      expect(warned).toContain('Dropping malformed TargetGroup Targets entry');
      expect(warned).toContain(SECRET_MASK);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the entry untouched when the caller threads no masker', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof CreateTargetGroupCommand) {
          return Promise.resolve({ TargetGroups: [{ TargetGroupArn: TG_ARN }] });
        }
        return Promise.resolve({});
      });

      await provider.create('TG', TARGET_GROUP_TYPE, {
        Name: 'my-tg',
        Port: 80,
        Protocol: 'HTTP',
        VpcId: 'vpc-1',
        Targets: [{ Id: 12345, AvailabilityZone: SECRET_PLAINTEXT }],
      });

      const warned = warnLines();
      expect(warned).toContain('Dropping malformed TargetGroup Targets entry');
      expect(warned).toContain(SECRET_PLAINTEXT);
    });
  });
});
