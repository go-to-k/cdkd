import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateServiceCommand,
  DeleteNamespaceCommand,
  DeleteServiceCommand,
  DeleteServiceAttributesCommand,
  ResourceInUse,
  UpdateServiceAttributesCommand,
} from '@aws-sdk/client-servicediscovery';

/**
 * Issue #2053, ServiceDiscovery half — all FOUR `withRetry` sites must abort on
 * Ctrl-C instead of sitting out their backoff.
 *
 * The `DeleteNamespace` one is the worst of the ten the issue enumerated: 24
 * retries on a 3s -> 15s grid is ~5.5 minutes during which a Ctrl-C did
 * nothing, on the DESTROY path where `destroy-runner.ts` has already abandoned
 * the promise — so the loop kept issuing deletes behind a run the user was told
 * had ended.
 *
 * THE DISCRIMINATOR IS THE ATTEMPT COUNT. An un-threaded site also rejects
 * eventually, so "it threw" is satisfied by the code this issue is about. Each
 * case fires the signal during a NAMED attempt and pins how many ran.
 *
 * The backoff is collapsed here (unlike the ELBv2 suite, which keeps real
 * sleeps): 24 retries at up to 15s is 5.5 minutes of wall clock for a REGRESSED
 * run, and a test that fails by timing out reports "timed out" rather than
 * "25 attempts instead of 2". Collapsing costs the count nothing — `withRetry`
 * consults the interrupt at the top of each sleep slice whatever the slice is
 * worth.
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

import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../src/provisioning/interrupt-watch.js';

const NAMESPACE_TYPE = 'AWS::ServiceDiscovery::PrivateDnsNamespace';
const SERVICE_TYPE = 'AWS::ServiceDiscovery::Service';


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
let watchersSeenAtFire = -1;

/**
 * Fire ONLY the listeners this call installed. The count is RECORDED rather
 * than asserted, because an assertion thrown from inside the SDK mock becomes
 * the operation's rejection and masks the attempt-count discriminator.
 */
function fireInterrupt(): void {
  const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
  watchersSeenAtFire = ours.length;
  for (const listener of ours) (listener as unknown as () => void)();
}

/** The signal `deleteNamespace`'s classifier actually retries. */
function inUseError(): Error {
  return new ResourceInUse({
    message: 'Namespace has associated services',
    $metadata: {},
  });
}

/** A transient 5xx, which the default classifier retries at the attribute sites. */
function transientAwsError(): Error {
  const err = new Error('ServiceUnavailable: try again');
  err.name = 'ServiceUnavailable';
  (err as unknown as Record<string, unknown>)['$metadata'] = { httpStatusCode: 503 };
  return err;
}

describe('ServiceDiscovery withRetry sites abort on Ctrl-C (#2053)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    mockSend.mockReset();
    armInterruptWatchForSuite();
    baseline = process.listeners('SIGINT');
    watchersSeenAtFire = -1;
    provider = new ServiceDiscoveryProvider();
  });

  afterEach(() => {
    expect(process.listeners('SIGINT').length).toBeLessThanOrEqual(baseline.length + 1);
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('DeleteNamespace: stops at the attempt the signal landed in, not after 24 retries', async () => {
    let attempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteNamespaceCommand) {
        attempts += 1;
        // The SECOND attempt, so the case also proves the loop retried at all —
        // an attempt count of 1 is what a terminal error produces too.
        if (attempts === 2) fireInterrupt();
        return Promise.reject(inUseError());
      }
      return Promise.resolve({});
    });

    await expect(
      provider.delete('Ns', 'ns-123', NAMESPACE_TYPE, {})
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    // THE discriminator: 25 un-threaded (one attempt plus 24 retries), ~5.5 min.
    expect(attempts).toBe(2);
    // ONE shared process listener however many resources are in flight.
    expect(watchersSeenAtFire).toBe(1);
  });

  it('CREATE service attributes: stops at the attempt the signal landed in', async () => {
    let attrAttempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateServiceCommand) {
        return Promise.resolve({ Service: { Id: 'srv-1', Arn: 'arn:aws:servicediscovery:::x' } });
      }
      if (command instanceof UpdateServiceAttributesCommand) {
        attrAttempts += 1;
        if (attrAttempts === 2) fireInterrupt();
        return Promise.reject(transientAwsError());
      }
      if (command instanceof DeleteServiceCommand) return Promise.resolve({});
      return Promise.resolve({});
    });

    await expect(
      provider.create('Svc', SERVICE_TYPE, {
        Name: 'svc',
        NamespaceId: 'ns-123',
        ServiceAttributes: { key: 'value' },
      })
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    expect(attrAttempts).toBe(2);
    expect(watchersSeenAtFire).toBe(1);
    // The partial-create cleanup DOES fire — see the ELBv2 twin for the full
    // argument. The Cloud Map case is the worse of the two: an orphaned service
    // also blocks `DeleteServiceDiscoveryNamespace` with `ResourceInUse`, so an
    // untracked leftover makes the enclosing NAMESPACE undestroyable as well.
    expect(mockSend.mock.calls.filter((c) => c[0] instanceof DeleteServiceCommand)).toHaveLength(1);
  });

  it('UPDATE attribute upsert: stops at the attempt the signal landed in', async () => {
    let attrAttempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof UpdateServiceAttributesCommand) {
        attrAttempts += 1;
        if (attrAttempts === 2) fireInterrupt();
        return Promise.reject(transientAwsError());
      }
      return Promise.resolve({});
    });

    await expect(
      provider.update(
        'Svc',
        'srv-1',
        SERVICE_TYPE,
        { Name: 'svc', NamespaceId: 'ns-123', ServiceAttributes: { key: 'new' } },
        { Name: 'svc', NamespaceId: 'ns-123', ServiceAttributes: { key: 'old' } }
      )
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    expect(attrAttempts).toBe(2);
    expect(watchersSeenAtFire).toBe(1);
  });

  it('UPDATE attribute removal: shares the upsert`s watch, so one Ctrl-C covers both', async () => {
    // The two update-path calls run back to back on the same resource and take
    // ONE watch. The signal is fired during the UPSERT and the removal — which
    // starts afterwards — must inherit it rather than beginning a fresh
    // schedule; that latch is what stops "Ctrl-C appears ignored" simply moving
    // one call to the right.
    let upsertAttempts = 0;
    let removeAttempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof UpdateServiceAttributesCommand) {
        upsertAttempts += 1;
        if (upsertAttempts === 2) fireInterrupt();
        // Succeed after the signal so control REACHES the removal call.
        return upsertAttempts >= 2 ? Promise.resolve({}) : Promise.reject(transientAwsError());
      }
      if (command instanceof DeleteServiceAttributesCommand) {
        removeAttempts += 1;
        return Promise.reject(transientAwsError());
      }
      return Promise.resolve({});
    });

    await expect(
      provider.update(
        'Svc',
        'srv-1',
        SERVICE_TYPE,
        { Name: 'svc', NamespaceId: 'ns-123', ServiceAttributes: { keep: 'new' } },
        { Name: 'svc', NamespaceId: 'ns-123', ServiceAttributes: { keep: 'old', gone: 'x' } }
      )
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    expect(upsertAttempts).toBe(2);
    // ONE attempt, aborted in its first backoff, rather than a fresh nine.
    expect(removeAttempts).toBe(1);
  });

  it('retries normally when nothing interrupts — the abort is the SIGNAL, not the wiring', async () => {
    let attempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteNamespaceCommand) {
        attempts += 1;
        return attempts < 4 ? Promise.reject(inUseError()) : Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await provider.delete('Ns', 'ns-123', NAMESPACE_TYPE, {});

    expect(attempts).toBe(4);
  });
});
