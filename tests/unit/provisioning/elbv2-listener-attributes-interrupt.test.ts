import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateListenerCommand,
  DeleteListenerCommand,
  ModifyListenerCommand,
  ModifyListenerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { isTransientServerError } from '../../../src/deployment/retryable-errors.js';

/**
 * Issue #2053, ELBv2 half — the two `ModifyListenerAttributes` retries must
 * abort on Ctrl-C instead of sitting out their backoff schedule.
 *
 * `withRetry` is the ONLY wait in cdkd that consults an interrupt DURING a
 * backoff (it probes once a second while sleeping); the deploy engine and
 * `destroy-runner.ts` poll only BETWEEN operations. So an un-threaded call is
 * dead to Ctrl-C for its whole schedule, which on the dense IAM-propagation
 * grid these sites take is 47.75s per call.
 *
 * THE DISCRIMINATOR IS THE ATTEMPT COUNT, not "it eventually threw". An
 * un-threaded site also throws — after nine attempts — so a test asserting only
 * on the rejection passes with the fix deleted. Every case below fires the
 * signal during a NAMED attempt and pins how many attempts actually ran.
 *
 * No sleep seam is stubbed on purpose. In the fixed code the interrupt is seen
 * at the TOP of the first one-second sleep slice, so the passing run sleeps
 * zero milliseconds; it is the BROKEN one that would take 47s. Collapsing the
 * sleep would have hidden exactly that difference.
 */

const mockSend = vi.fn();

// One logger object for the whole module: the interrupt warn carries the ARN
// and the manual-delete command, and that text is the contract.
vi.mock('../../../src/utils/logger.js', () => {
  const shared: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  shared['child'] = () => shared;
  return { getLogger: () => shared };
});

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

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { getLogger } from '../../../src/utils/logger.js';

const logger = getLogger() as unknown as { warn: ReturnType<typeof vi.fn> };
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../src/provisioning/interrupt-watch.js';

const LISTENER_TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1';
const LISTENER_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/abc/def';
const ATTR = [{ Key: 'routing.http.response.server.enabled', Value: 'false' }];

/** Baseline SIGINT listeners, so a test only ever fires the ones IT caused. */

/**
 * Stand in for the SIGINT handler every real command installs before it reaches
 * a provider (`forwardSigtermToSigint`, the engine's, `destroy-runner.ts`'s).
 *
 * The watch deliberately refuses to install the FIRST SIGINT listener — that
 * would disable Node's default terminate for a command that has no interrupt
 * handling of its own — and a vitest worker registers none, so without this the
 * watch would never arm and every case below would exercise the UNARMED path
 * while appearing to test the armed one.
 *
 * The disarm is because arming is a one-way door in production (the listener is
 * installed once and never removed, so a signal landing between two sequential
 * waits is still recorded), which makes a per-test cold start a test concern
 * rather than a production one. The latch is sticky for the same reason and
 * would otherwise leak a simulated Ctrl-C into every later test in the file.
 */
function armInterruptWatchForSuite(): void {
  disarmInterruptWatchForTests();
  interruptWatchTestSeam.commandOwnsInterrupts = () => true;
}

let baseline: readonly unknown[] = [];

/**
 * An AWS-shaped transient 5xx, so `withRetry` really retries it. Asserted
 * against the real classifier below rather than assumed: a fixture the retry
 * loop treats as terminal would make every attempt-count assertion here read
 * `1` for the wrong reason.
 */
function transientAwsError(): Error {
  const err = new Error('ServiceUnavailable: try again');
  err.name = 'ServiceUnavailable';
  (err as unknown as Record<string, unknown>)['$metadata'] = { httpStatusCode: 503 };
  return err;
}

/**
 * Fire ONLY the listeners this call installed, so the harness's own SIGINT
 * handling is untouched. The length assertion is a claim in its own right: the
 * watch shares ONE process listener however many resources are in flight, which
 * is what keeps a `--concurrency 10` run under Node's ten-listener warning
 * ceiling (only `destroy-runner.ts` raises it).
 */
let watchersSeenAtFire = -1;

function fireInterrupt(): void {
  const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
  // RECORDED rather than asserted here: an assertion thrown from inside the SDK
  // mock becomes the operation's rejection, which then masks the attempt-count
  // discriminator this suite is actually about. The count is asserted in the
  // test body instead.
  watchersSeenAtFire = ours.length;
  for (const listener of ours) (listener as unknown as () => void)();
}

describe('ELBv2 ModifyListenerAttributes aborts on Ctrl-C (#2053)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    armInterruptWatchForSuite();
    baseline = process.listeners('SIGINT');
    watchersSeenAtFire = -1;
    provider = new ELBv2Provider();
  });

  afterEach(() => {
    // At most ONE listener beyond the baseline, ever — the shared one. It is
    // deliberately NOT removed when the last watch disposes: a listener torn
    // down between two sequential waits cannot record a signal landing in the
    // gap, which is the bug the sticky latch exists to prevent one layer down.
    expect(process.listeners('SIGINT').length).toBeLessThanOrEqual(baseline.length + 1);
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('the fixture really is retryable (non-vacuity)', () => {
    expect(isTransientServerError(transientAwsError())).toBe(true);
  });

  it('CREATE: stops at the attempt the signal landed in, not after the whole schedule', async () => {
    let attrAttempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateListenerCommand) {
        return Promise.resolve({ Listeners: [{ ListenerArn: LISTENER_ARN }] });
      }
      if (command instanceof ModifyListenerAttributesCommand) {
        attrAttempts += 1;
        // Fire on the SECOND attempt, never the first: landing on attempt 1
        // would leave "did it retry at all?" unanswered, and an attempt count
        // of 1 is also what a non-retryable fixture produces.
        if (attrAttempts === 2) fireInterrupt();
        return Promise.reject(transientAwsError());
      }
      if (command instanceof DeleteListenerCommand) return Promise.resolve({});
      return Promise.resolve({});
    });

    await expect(
      provider.create('Listener', LISTENER_TYPE, {
        LoadBalancerArn: LB_ARN,
        Port: 443,
        Protocol: 'HTTPS',
        DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '200' } }],
        ListenerAttributes: ATTR,
      })
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    // THE discriminator. Un-threaded this is 9 (one attempt plus `withRetry`'s
    // default eight retries) and the run takes 47.75s.
    expect(attrAttempts).toBe(2);
    // The site really went through a shared watch. Deliberately NOT read as the
    // concurrency claim: only one watch is ever live here, so a per-watch
    // listener would score 1 too. `tests/unit/provisioning/interrupt-watch.test.ts`
    // pins the concurrency property with TEN overlapping watches.
    expect(watchersSeenAtFire).toBe(1);
    // ...and the partial-create cleanup DOES fire, on an interrupt exactly as
    // on any other attributes-wiring failure. The tempting opposite — "Ctrl-C
    // must not delete what you just made" — assumes this listener is tracked,
    // and it is not: `create()` throws, so `newResources[logicalId]` is never
    // set, the journal records `physicalId: undefined`, and the rollback
    // executor classifies it `skip-failed-unknown`. Nothing holds the ARN, so
    // the choice is "delete vs ORPHAN FOREVER": left behind it fails the next
    // deploy with `DuplicateListener`, permanently, while rollback skips it and
    // destroy has no record of it.
    expect(mockSend.mock.calls.filter((c) => c[0] instanceof DeleteListenerCommand)).toHaveLength(
      1
    );
    // The handle is printed at DEFAULT verbosity BEFORE the delete is
    // attempted, so a process killed mid-cleanup still leaves the user
    // something to act on. Silent orphan is the one unacceptable outcome.
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('Interrupted after creating Listener');
    expect(warned).toContain(LISTENER_ARN);
    expect(warned).toContain('aws elbv2 delete-listener --listener-arn');
  }, 120_000);

  it('UPDATE: stops at the attempt the signal landed in', async () => {
    let attrAttempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof ModifyListenerCommand) return Promise.resolve({});
      if (command instanceof ModifyListenerAttributesCommand) {
        attrAttempts += 1;
        if (attrAttempts === 2) fireInterrupt();
        return Promise.reject(transientAwsError());
      }
      return Promise.resolve({});
    });

    await expect(
      provider.update(
        'Listener',
        LISTENER_ARN,
        LISTENER_TYPE,
        { Port: 443, Protocol: 'HTTPS', ListenerAttributes: ATTR },
        { Port: 443, Protocol: 'HTTPS', ListenerAttributes: [] }
      )
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    expect(attrAttempts).toBe(2);
    expect(watchersSeenAtFire).toBe(1);
  }, 120_000);

  it('retries normally when nothing interrupts — the abort is the SIGNAL, not the wiring', async () => {
    // The other polarity. Without it, a watch stuck reporting "interrupted"
    // would pass every case above while breaking every ordinary retry.
    let attrAttempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof ModifyListenerCommand) return Promise.resolve({});
      if (command instanceof ModifyListenerAttributesCommand) {
        attrAttempts += 1;
        return attrAttempts < 3 ? Promise.reject(transientAwsError()) : Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await provider.update(
      'Listener',
      LISTENER_ARN,
      LISTENER_TYPE,
      { Port: 443, Protocol: 'HTTPS', ListenerAttributes: ATTR },
      { Port: 443, Protocol: 'HTTPS', ListenerAttributes: [] }
    );

    expect(attrAttempts).toBe(3);
    // Explicit rather than the 5s default: this case sleeps two real backoffs
    // (~3s) and a 5s ceiling is the flake shape already filed as issue #2002.
  }, 60_000);
});
