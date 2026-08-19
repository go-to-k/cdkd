import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';
import type { ResourceState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

// Issues #2038 (the `withRetry` give-up summary) and #2031 (the direct
// `logger.warn` + the DURABLE deployment-events record).
//
// `resolveReplayProps` re-resolves every redacted `{{resolve:...}}` expression
// back to PLAINTEXT before handing the bag to a provider, so the rollback replay
// is the one path where the payload is GUARANTEED to carry the concrete secret.
// AWS validation errors routinely quote the offending property VALUE back, and
// every one of those readers echoed the AWS message verbatim.
//
// The retry mock deliberately keeps the REAL `withRetry` and only makes its
// sleeps instant: the assertion is on what production actually emits (the real
// give-up summary string), not on a stand-in that would share the fix's blind
// spot.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    withRetry: (
      fn: Parameters<typeof actual.withRetry>[0],
      logicalId: string,
      opts: Parameters<typeof actual.withRetry>[2] = {}
    ) => actual.withRetry(fn, logicalId, { ...opts, sleep: async () => {} }),
  };
});

const SECRET_PLAINTEXT = 'rotated-db-password-9f3a1c';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';

const mockSMSend = vi.fn(async () => ({
  SecretString: JSON.stringify({ password: SECRET_PLAINTEXT }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: mockSMSend }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const IDP_TYPE = 'AWS::Cognito::UserPoolIdentityProvider';

/**
 * The feared shape (#2038): an AWS error that QUOTES the offending value back,
 * carrying a transient 5xx so the real retry loop exhausts its budget and emits
 * the give-up summary at `warn` — DEFAULT verbosity.
 */
function transientAwsErrorQuotingSecret(): Error {
  return Object.assign(
    new Error(`Value '${SECRET_PLAINTEXT}' at 'password' failed to satisfy constraint`),
    { name: 'InternalFailure', $metadata: { httpStatusCode: 500, requestId: 'req-abc' } }
  );
}

/** The same quote on a TERMINAL error, so the catch's warn is what reports it. */
function terminalAwsErrorQuotingSecret(): Error {
  return new Error(`Value '${SECRET_PLAINTEXT}' at 'password' failed to satisfy constraint`);
}

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: IDP_TYPE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: { update?: unknown; create?: unknown; delete?: unknown }): {
  ctx: RollbackExecutorContext;
  warns: string[];
  debugs: string[];
  events: Array<Omit<DeploymentEvent, 'timestamp'>>;
} {
  const warns: string[] = [];
  const debugs: string[] = [];
  const events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
  const logger = {
    debug: (m: string) => debugs.push(m),
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  return {
    warns,
    debugs,
    events,
    ctx: {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: (e) => events.push(e),
    },
  };
}

function secretBearingRevertOp(): {
  ops: CompletedOperation[];
  state: Record<string, ResourceState>;
} {
  const prev = res({
    physicalId: 'phys-B',
    properties: { ProviderDetails: { client_id: 'pub', password: SECRET_EXPR } },
  });
  return {
    ops: [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: prev,
      },
    ],
    state: {
      Idp: res({
        physicalId: 'phys-B',
        properties: { ProviderDetails: { client_id: 'pub-CHANGED', password: SECRET_EXPR } },
      }),
    },
  };
}

beforeEach(() => {
  mockSMSend.mockClear();
  resetAccountInfoCache();
});

describe('rollback replay - the retry give-up summary is masked (issue #2038)', () => {
  it('an exhausting retry on the revert arm does not print the resolved secret', async () => {
    const update = vi.fn().mockRejectedValue(transientAwsErrorQuotingSecret());
    const { ctx, warns } = makeCtx({ update });
    const { ops, state } = secretBearingRevertOp();

    await replayRollback(ops, state, 'S', ctx);

    // Non-vacuity: the replay really did re-resolve the secret to plaintext,
    // and the real retry loop really did exhaust (9 attempts = 1 + 8 retries).
    expect(mockSMSend).toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(9);

    // The FEARED SHAPE: production's own give-up summary line, not a proxy.
    const summary = warns.find((m) => m.includes('gave up after'));
    expect(summary).toBeDefined();
    expect(summary).toContain('transient server-error');
    expect(summary).not.toContain(SECRET_PLAINTEXT);
    expect(summary).toContain(SECRET_MASK);

    // And nothing else on the path printed it either.
    expect(warns.join('\n')).not.toContain(SECRET_PLAINTEXT);
  });

  it('the per-attempt retry debug line does not print the resolved secret', async () => {
    const update = vi.fn().mockRejectedValue(transientAwsErrorQuotingSecret());
    const { ctx, debugs } = makeCtx({ update });
    const { ops, state } = secretBearingRevertOp();

    await replayRollback(ops, state, 'S', ctx);

    const attemptLine = debugs.find((m) => m.includes('Retrying Idp in'));
    expect(attemptLine).toBeDefined();
    expect(attemptLine).not.toContain(SECRET_PLAINTEXT);
    expect(attemptLine).toContain(SECRET_MASK);
  });

  it('leaves a non-secret AWS message untouched (the mask is not blanket redaction)', async () => {
    const update = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error(`Value 'PLAINCONFIG' at 'password' failed to satisfy constraint`), {
          name: 'InternalFailure',
          $metadata: { httpStatusCode: 500 },
        })
      );
    const { ctx, warns } = makeCtx({ update });
    const { ops, state } = secretBearingRevertOp();

    await replayRollback(ops, state, 'S', ctx);

    const summary = warns.find((m) => m.includes('gave up after'));
    expect(summary).toContain('PLAINCONFIG');
  });
});

describe('rollback replay - the failure warn + the events record are masked (issue #2031)', () => {
  it('the "Rollback failed for" line does not print the resolved secret', async () => {
    const update = vi.fn().mockRejectedValue(terminalAwsErrorQuotingSecret());
    const { ctx, warns } = makeCtx({ update });
    const { ops, state } = secretBearingRevertOp();

    await replayRollback(ops, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    // Terminal error: no retry, so the catch's warn is the reporter.
    expect(update).toHaveBeenCalledTimes(1);

    const failLine = warns.find((m) => m.includes('Rollback failed for Idp'));
    expect(failLine).toBeDefined();
    expect(failLine).not.toContain(SECRET_PLAINTEXT);
    expect(failLine).toContain(SECRET_MASK);
  });

  it('the DURABLE ROLLBACK_RESOURCE_FAILED event message does not carry the plaintext', async () => {
    const update = vi.fn().mockRejectedValue(terminalAwsErrorQuotingSecret());
    const { ctx, events } = makeCtx({ update });
    const { ops, state } = secretBearingRevertOp();

    await replayRollback(ops, state, 'S', ctx);

    const failed = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED') as
      | { error?: { message?: string; name?: string } }
      | undefined;
    expect(failed).toBeDefined();
    expect(failed!.error?.message).toBeDefined();
    expect(failed!.error?.message).not.toContain(SECRET_PLAINTEXT);
    expect(failed!.error?.message).toContain(SECRET_MASK);
    // The AWS-authored identifier is NOT masked (traced non-sensitive).
    expect(failed!.error?.name).toBe('Error');
  });

  it('the --revert-failed arm masks both its warn and its event', async () => {
    const update = vi.fn().mockRejectedValue(terminalAwsErrorQuotingSecret());
    const { ctx, warns, events } = makeCtx({ update });
    const prev = res({
      physicalId: 'phys-B',
      properties: { ProviderDetails: { password: SECRET_EXPR } },
    });
    const failedOps: FailedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: prev,
        attemptedProperties: { ProviderDetails: { password: SECRET_EXPR } },
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'phys-B',
        properties: { ProviderDetails: { password: SECRET_EXPR } },
      }),
    };

    await replayFailedOperations(failedOps, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    const failLine = warns.find((m) => m.includes('Rollback failed for failed-op Idp'));
    expect(failLine).toBeDefined();
    expect(failLine).not.toContain(SECRET_PLAINTEXT);
    expect(failLine).toContain(SECRET_MASK);

    const failed = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED') as
      | { error?: { message?: string } }
      | undefined;
    expect(failed?.error?.message).not.toContain(SECRET_PLAINTEXT);
    expect(failed?.error?.message).toContain(SECRET_MASK);
  });
});
