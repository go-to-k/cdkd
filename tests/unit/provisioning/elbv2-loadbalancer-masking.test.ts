import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand,
  ModifyLoadBalancerAttributesCommand,
  SetSubnetsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { SECRET_MASK, createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Issue #2063, ELBv2 LoadBalancer arm — the arm issue #2050's threading left
 * out. It runs no `withRetry`, so it has neither of that issue's two retry
 * sinks; what it has instead is the pair of surfaces that exist without one:
 *
 * 1. THE THROWN `ProvisioningError`. `deploy-engine.ts` prints it at ERROR —
 *    DEFAULT verbosity. On the CREATE path `createLoadBalancer` builds it; on
 *    the UPDATE path `updateLoadBalancer` has no try/catch at all, so the raw
 *    AWS rejection propagates to `update()`'s outer catch, which is where the
 *    masking has to happen. Two different frames, hence two sets of tests —
 *    fixing one and assuming the other follows is the "hole shaped like
 *    whichever path a given deploy takes" the issue names.
 * 2. THE PARTIAL-CREATE CLEANUP `warn`, also DEFAULT verbosity.
 *
 * The payload is `Name` / `Subnets` / `SecurityGroups` / `LoadBalancerAttributes`
 * values out of the RESOLVED `properties` bag — a `{{resolve:secretsmanager:...}}`
 * scalar is already plaintext by the time a provider sees it, and AWS quotes a
 * rejected value straight back into its message.
 *
 * Every assertion is on the STRING that escaped — the thrown error's `message`
 * or the logger's argument. Asserting that a masker was PASSED would be
 * satisfied by the very code this issue is about.
 */

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-elastic-load-balancing-v2')>(
      '@aws-sdk/client-elastic-load-balancing-v2'
    );
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilLoadBalancerAvailable: vi.fn().mockResolvedValue({ state: 'SUCCESS' }),
  };
});

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

import { getLogger } from '../../../src/utils/logger.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const logger = getLogger() as unknown as {
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

const LB_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/lb/abc123';

/**
 * A Secrets Manager JSON DOCUMENT, per issue #2063 acceptance item 4 — not a
 * scalar. A scalar passes under BOTH orderings of mask-vs-stringify and so
 * cannot tell them apart; a document contains `"` and `\` that `JSON.stringify`
 * escapes, which is what makes a mask applied AFTER stringification silently
 * miss. The literal is distinctive so it cannot collide with another suite's
 * "must not appear" needle and produce a false leak report.
 */
const SECRET_PLAINTEXT = '{"user":"elbv2-lb-2063","pass":"p\\x2fw#8f1c"}';
const SECRET_EXPR = '{{resolve:secretsmanager:elbv2-lb-2063:SecretString:doc::}}';

const maskSecrets = createSecretMasker(new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));

/**
 * An AWS validation rejection that quotes the offending value back — the shape
 * that makes these log lines a disclosure surface at all.
 */
function awsRejection(prefix: string): Error {
  const err = new Error(`ValidationError: ${prefix} ${SECRET_PLAINTEXT} was rejected`);
  err.name = 'ValidationError';
  (err as unknown as Record<string, unknown>)['$metadata'] = {
    httpStatusCode: 400,
    requestId: 'req-elbv2-2063',
  };
  return err;
}

function warnLines(): string {
  return logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

function loggedLines(): string {
  return [...logger.debug.mock.calls, ...logger.warn.mock.calls]
    .map((c) => String(c[0]))
    .join('\n');
}

/**
 * Does any string LEAF of the request payload equal the secret verbatim?
 *
 * Deliberately NOT `JSON.stringify(input).includes(...)`: the fixture secret is
 * a JSON document, so `stringify` escapes its `"` and `\` and the literal no
 * longer occurs in the serialized text — the exact gap acceptance item 4 of
 * issue #2063 is about, which this helper's first draft walked straight into.
 * Walking the leaves asks the question the non-vacuity check actually means:
 * did the plaintext reach AWS on the wire?
 */
function payloadHasSecretLeaf(value: unknown): boolean {
  if (typeof value === 'string') return value === SECRET_PLAINTEXT;
  if (Array.isArray(value)) return value.some(payloadHasSecretLeaf);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(payloadHasSecretLeaf);
  }
  return false;
}

function expectPayloadCarriedThePlaintext(cls: abstract new (...args: never[]) => object): void {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof cls);
  expect(call).toBeDefined();
  expect(payloadHasSecretLeaf((call![0] as { input: unknown }).input)).toBe(true);
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

/**
 * The resolved template bag. The secret rides in TWO members on purpose,
 * because the LoadBalancer create path splits across two AWS calls: `Tags` goes
 * out on `CreateLoadBalancer` itself, while `LoadBalancerAttributes` rides a
 * separate post-create `ModifyLoadBalancerAttributes`. A bag carrying only the
 * latter makes the CreateLoadBalancer-rejection test's non-vacuity check fail —
 * which is how this fixture was built, rather than assumed.
 */
const LB_PROPERTIES: Record<string, unknown> = {
  Name: 'my-lb',
  Subnets: ['subnet-1', 'subnet-2'],
  Tags: [{ Key: 'owner', Value: SECRET_PLAINTEXT }],
  LoadBalancerAttributes: [{ Key: 'access_logs.s3.prefix', Value: SECRET_PLAINTEXT }],
};

describe('ELBv2Provider LoadBalancer secret masking (#2063)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ELBv2Provider();
  });

  describe('create path — thrown ProvisioningError', () => {
    /** CreateLoadBalancer itself rejects: the outer catch is the only surface. */
    function primeCreateRejection(): void {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof CreateLoadBalancerCommand) {
          return Promise.reject(awsRejection('load balancer attribute'));
        }
        return Promise.resolve({});
      });
    }

    it('masks the AWS message the CreateLoadBalancer rejection carried', async () => {
      primeCreateRejection();

      const thrown = await captureThrow(() =>
        provider.create('Lb', LB_TYPE, LB_PROPERTIES, { maskSecrets })
      );

      // Non-vacuity: the request really did carry the plaintext, so a masked
      // message is the fix working rather than the value never arriving.
      expectPayloadCarriedThePlaintext(CreateLoadBalancerCommand);

      expect(thrown.message).toContain('Failed to create LoadBalancer Lb');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });

    it('preserves the ORIGINAL error as `cause` so retry classification is untouched', async () => {
      primeCreateRejection();

      const thrown = await captureThrow(() =>
        provider.create('Lb', LB_TYPE, LB_PROPERTIES, { maskSecrets })
      );

      const cause = thrown.cause as Error & { $metadata?: { httpStatusCode?: number } };
      expect(cause).toBeInstanceOf(Error);
      expect(cause.$metadata?.httpStatusCode).toBe(400);
      // Deliberate: the cause is the ORIGINAL object. Only rendered text is masked.
      expect(cause.message).toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeCreateRejection();

      const thrown = await captureThrow(() => provider.create('Lb', LB_TYPE, LB_PROPERTIES));

      // The back-compatible default the SecretMaskingContext contract mandates:
      // absent means unmasked, and the sentence still reaches the operator.
      expect(thrown.message).toContain('Failed to create LoadBalancer Lb');
      expect(thrown.message).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('create path — partial-create cleanup warn', () => {
    it('masks the DeleteLoadBalancer cleanup failure message', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof CreateLoadBalancerCommand) {
          return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN, DNSName: 'd' }] });
        }
        // The attributes wiring fails AFTER AWS committed the LB, which is what
        // sends the provider into its best-effort cleanup...
        if (command instanceof ModifyLoadBalancerAttributesCommand) {
          return Promise.reject(awsRejection('load balancer attribute'));
        }
        // ...and the cleanup itself then fails, which is the line under test.
        if (command instanceof DeleteLoadBalancerCommand) {
          return Promise.reject(awsRejection('delete request for'));
        }
        return Promise.resolve({});
      });

      await expect(
        provider.create('Lb', LB_TYPE, LB_PROPERTIES, { maskSecrets })
      ).rejects.toThrow();

      const warned = warnLines();
      // Non-vacuity: the cleanup-failure branch really did fire.
      expect(warned).toContain('Failed to clean up partially-created LoadBalancer Lb');
      expect(warned).toContain(SECRET_MASK);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(loggedLines()).not.toContain(SECRET_PLAINTEXT);
    });
  });

  describe('update path — thrown ProvisioningError from the outer catch in update()', () => {
    /**
     * `updateLoadBalancer` has NO try/catch: the raw AWS rejection propagates
     * out of it, so `update()`'s outer frame is the only masking site on this
     * path. A fix applied only to `createLoadBalancer` leaves this green-free.
     */
    function primeUpdateRejection(command: unknown): void {
      mockSend.mockImplementation((sent: unknown) => {
        if (
          (command === ModifyLoadBalancerAttributesCommand &&
            sent instanceof ModifyLoadBalancerAttributesCommand) ||
          (command === SetSubnetsCommand && sent instanceof SetSubnetsCommand)
        ) {
          return Promise.reject(awsRejection('load balancer property'));
        }
        return Promise.resolve({});
      });
    }

    it('masks the AWS message a ModifyLoadBalancerAttributes rejection carried', async () => {
      primeUpdateRejection(ModifyLoadBalancerAttributesCommand);

      const thrown = await captureThrow(() =>
        provider.update('Lb', LB_ARN, LB_TYPE, LB_PROPERTIES, { Name: 'my-lb' }, { maskSecrets })
      );

      expectPayloadCarriedThePlaintext(ModifyLoadBalancerAttributesCommand);

      // The sentence proves it came out of `update()`'s frame, not an arm's.
      expect(thrown.message).toContain('Failed to update ELBv2 resource Lb');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });

    it('masks a SetSubnets rejection too (a different call in the same arm)', async () => {
      primeUpdateRejection(SetSubnetsCommand);

      const thrown = await captureThrow(() =>
        provider.update(
          'Lb',
          LB_ARN,
          LB_TYPE,
          { Name: 'my-lb', Subnets: [SECRET_PLAINTEXT] },
          { Name: 'my-lb', Subnets: ['subnet-old'] },
          { maskSecrets }
        )
      );

      expectPayloadCarriedThePlaintext(SetSubnetsCommand);

      expect(thrown.message).toContain('Failed to update ELBv2 resource Lb');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the message untouched when the caller threads no masker', async () => {
      primeUpdateRejection(ModifyLoadBalancerAttributesCommand);

      const thrown = await captureThrow(() =>
        provider.update('Lb', LB_ARN, LB_TYPE, LB_PROPERTIES, { Name: 'my-lb' })
      );

      expect(thrown.message).toContain(SECRET_PLAINTEXT);
    });
  });

  /**
   * The SUCCESS-path debug lines (issue #2063 code + security review).
   *
   * Everything above fences a FAILURE surface. These two lines are the other
   * shape entirely: the AWS call SUCCEEDS and the provider then logs what it
   * sent. `update()`'s outer catch never runs, so nothing downstream can mask
   * them — a resolved property value reaches the terminal verbatim under
   * `--verbose`.
   *
   * Debug level is not an exemption here: issue #1997 shipped this exact
   * shape as a real leak (a resolved ASG name in a debug line), and
   * `--verbose` is the ordinary way to run a deploy that is misbehaving.
   *
   * The discriminating input is a secret that AWS ACCEPTS, or the call
   * rejects and the line is never reached: `CapacityUnits` is coerced with
   * `Number()`, so the fixture uses a numeric-looking secret. The coercion is
   * not a sanitizer — a number stringifies back to the same digits.
   */
  describe('success-path debug lines', () => {
    // Sub-MIN_NEEDLE_LENGTH on purpose (issue #2063 round-2 review). At 4+
    // characters the substring arm masks the ASSEMBLED sentence too, so a mask
    // relocated onto the finished line stays green and the "masked on the RAW
    // value" rationale is unfenced. Below the floor only the whole-value arm can
    // reach it, which is exactly what masking before interpolation buys.
    //
    // The LEADING ZERO fences the second property independently: the update arm
    // computes `Number(properties[...].CapacityUnits)`, and `'07'` does not
    // round-trip through it. So a masker applied to the COERCED number sees
    // `'7'`, matches nothing, and prints the value unmasked -- which is the
    // defect the round-2 review measured. One fixture, two discriminators.
    const NUMERIC_SECRET = '07';
    const numericMasker = createSecretMasker(
      new Map([[NUMERIC_SECRET, '{{resolve:secretsmanager:elbv2-cap:SecretString:units::}}']])
    );

    function debugLines(): string {
      return logger.debug.mock.calls.map((c) => String(c[0])).join('\n');
    }

    beforeEach(() => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof CreateLoadBalancerCommand) {
          return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
        }
        return Promise.resolve({});
      });
    });

    it('masks the capacity-reservation debug line on the CREATE path', async () => {
      await provider.create(
        'Lb',
        LB_TYPE,
        {
          Name: 'my-lb',
          Subnets: ['subnet-1'],
          MinimumLoadBalancerCapacity: { CapacityUnits: NUMERIC_SECRET },
        },
        { maskSecrets: numericMasker }
      );

      // Non-vacuity: the line must actually have been emitted, or a masked
      // assertion passes over silence.
      expect(debugLines()).toContain('Requested capacity reservation of');
      expect(debugLines()).toContain(SECRET_MASK);
      expect(debugLines()).not.toContain(`of ${NUMERIC_SECRET} LCU`);
    });

    it('leaves the CREATE-path capacity debug line raw when no masker is threaded', async () => {
      await provider.create('Lb', LB_TYPE, {
        Name: 'my-lb',
        Subnets: ['subnet-1'],
        MinimumLoadBalancerCapacity: { CapacityUnits: NUMERIC_SECRET },
      });

      expect(debugLines()).toContain(`of ${NUMERIC_SECRET} LCU`);
    });

    it('masks the capacity-reservation debug line on the UPDATE path', async () => {
      await provider.update(
        'Lb',
        LB_ARN,
        LB_TYPE,
        { Name: 'my-lb', MinimumLoadBalancerCapacity: { CapacityUnits: NUMERIC_SECRET } },
        { Name: 'my-lb' },
        { maskSecrets: numericMasker }
      );

      expect(debugLines()).toContain('Requested capacity reservation of');
      expect(debugLines()).toContain(SECRET_MASK);
      expect(debugLines()).not.toContain(`of ${NUMERIC_SECRET} LCU`);
    });

    it('leaves the UPDATE-path capacity debug line raw when no masker is threaded', async () => {
      await provider.update(
        'Lb',
        LB_ARN,
        LB_TYPE,
        { Name: 'my-lb', MinimumLoadBalancerCapacity: { CapacityUnits: NUMERIC_SECRET } },
        { Name: 'my-lb' }
      );

      expect(debugLines()).toContain(`of ${NUMERIC_SECRET} LCU`);
    });

    it('masks the EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic debug line', async () => {
      // `on` / `off` are the only values AWS accepts here, so a REACHABLE
      // secret at this site is necessarily sub-MIN_NEEDLE_LENGTH — the debug
      // line is only emitted once the SetSecurityGroups call succeeded. That
      // makes the whole-value arm the only one that can mask it, so this case
      // also fences masking on the RAW value rather than the assembled line.
      const flagSecret = 'on';
      const flagMasker = createSecretMasker(
        new Map([[flagSecret, '{{resolve:secretsmanager:elbv2-pl:SecretString:flag::}}']])
      );

      await provider.create(
        'Lb',
        LB_TYPE,
        {
          Name: 'my-lb',
          Subnets: ['subnet-1'],
          SecurityGroups: ['sg-1'],
          EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: flagSecret,
        },
        { maskSecrets: flagMasker }
      );

      expect(debugLines()).toContain(
        'Applied EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic='
      );
      expect(debugLines()).toContain(SECRET_MASK);
      expect(debugLines()).not.toContain(`=${flagSecret} for`);
    });
  });
});
