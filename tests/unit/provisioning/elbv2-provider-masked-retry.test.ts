import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateListenerCommand,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  ModifyListenerCommand,
  ModifyTargetGroupCommand,
  SetSubnetsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

/**
 * Issue #4259, ELBv2 half: every `create()` / `update()` failure wrap masks
 * AWS's error text before joining it into its `Failed to create/update ...`
 * message (#2050, #2063). When a recorded secret spells part of the retry
 * table's wording, the mask cuts that wording out of the message, so the wrap
 * must be stamped (`markRedactedCause`) for the retry classifiers to read the
 * unmasked cause chain. One retryable case per wrap site, plus the unstamped
 * negative control.
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

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const LB = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/lb/abc123';
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/tg/0123456789abcdef';
const LISTENER_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:111122223333:listener/app/lb/abc123/0123456789abcdef';

/** A secret that spells part of the retry table's `does not exist` wording. */
const RETRY_WORD = 'exist';
const retryMasker = createSecretMasker(
  new Map([[RETRY_WORD, '{{resolve:secretsmanager:elbv2-4259:SecretString:k::}}']])
);
const TRANSIENT = 'Security group sg-0123456789abcdef does not exist';

/** An AWS-authored client rejection (400, so no transient-server arm fires). */
function awsRejection(message: string): Error {
  return Object.assign(new Error(message), {
    name: 'ValidationError',
    $fault: 'client',
    $metadata: { httpStatusCode: 400, requestId: 'req-elbv2-4259' },
  });
}

const retryable = (error: Error): boolean =>
  isRetryableTransientError(error, retryClassificationText(error));

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

type Masker = typeof retryMasker;

const SITES = [
  {
    site: 'create() LoadBalancer',
    command: CreateLoadBalancerCommand,
    wrap: 'Failed to create LoadBalancer Lb',
    run: (p: ELBv2Provider, m: Masker) =>
      p.create('Lb', LB, { Name: 'my-lb', Subnets: ['subnet-1', 'subnet-2'] }, { maskSecrets: m }),
  },
  {
    // `updateLoadBalancer` has no catch of its own: the raw rejection reaches
    // `update()`'s outer wrap.
    site: 'update() LoadBalancer (outer wrap)',
    command: SetSubnetsCommand,
    wrap: 'Failed to update ELBv2 resource Lb',
    run: (p: ELBv2Provider, m: Masker) =>
      p.update(
        'Lb',
        LB_ARN,
        LB,
        { Name: 'my-lb', Subnets: ['subnet-new'] },
        { Name: 'my-lb', Subnets: ['subnet-old'] },
        { maskSecrets: m }
      ),
  },
  {
    site: 'create() TargetGroup',
    command: CreateTargetGroupCommand,
    wrap: 'Failed to create TargetGroup Tg',
    run: (p: ELBv2Provider, m: Masker) =>
      p.create(
        'Tg',
        TG,
        { Name: 'my-tg', Protocol: 'HTTP', Port: 80, VpcId: 'vpc-1' },
        { maskSecrets: m }
      ),
  },
  {
    site: 'update() TargetGroup',
    command: ModifyTargetGroupCommand,
    wrap: 'Failed to update TargetGroup Tg',
    run: (p: ELBv2Provider, m: Masker) =>
      p.update(
        'Tg',
        TG_ARN,
        TG,
        { HealthCheckPath: '/healthz' },
        { HealthCheckPath: '/health' },
        { maskSecrets: m }
      ),
  },
  {
    site: 'create() Listener',
    command: CreateListenerCommand,
    wrap: 'Failed to create Listener Listener',
    run: (p: ELBv2Provider, m: Masker) =>
      p.create(
        'Listener',
        LISTENER,
        { LoadBalancerArn: LB_ARN, Port: 80, Protocol: 'HTTP' },
        { maskSecrets: m }
      ),
  },
  {
    site: 'update() Listener',
    command: ModifyListenerCommand,
    wrap: 'Failed to update Listener Listener',
    run: (p: ELBv2Provider, m: Masker) =>
      p.update('Listener', LISTENER_ARN, LISTENER, { Port: 8080 }, { Port: 80 }, { maskSecrets: m }),
  },
] as const;

/** Reject `command` with `error`; every other call succeeds. */
function rejectOn(command: abstract new (...args: never[]) => object, error: Error): void {
  mockSend.mockImplementation((sent: unknown) =>
    sent instanceof command ? Promise.reject(error) : Promise.resolve({})
  );
}

describe('ELBv2Provider: a masked failure still classifies as retryable (issue #4259)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ELBv2Provider();
  });

  it.each(SITES)('$site: the stamp keeps it retryable', async ({ command, wrap, run }) => {
    rejectOn(command, awsRejection(TRANSIENT));
    const failure = await thrown(run(provider, retryMasker));
    // Non-vacuity: the rejection came from the site's own command, and the
    // wrap that reached us is the site's own.
    expect(mockSend.mock.calls.some((c) => c[0] instanceof command)).toBe(true);
    expect(failure.message).toContain(wrap);
    // Premise: the mask cut the retry wording out of the message itself.
    expect(failure.message).not.toContain('does not exist');
    expect(isRetryableTransientError(failure, failure.message)).toBe(false);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(retryable(failure)).toBe(true);
  });

  it.each(SITES)(
    '$site: a failure the mask left unchanged is not stamped',
    async ({ command, wrap, run }) => {
      rejectOn(command, awsRejection('Bad request parameter'));
      const failure = await thrown(run(provider, retryMasker));
      expect(failure.message).toContain(wrap);
      expect(failure.message).toContain('Bad request parameter');
      expect(hasRedactedCause(failure)).toBe(false);
      expect(retryable(failure)).toBe(false);
    }
  );
});
