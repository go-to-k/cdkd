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
// A SECOND secret, belonging to a SIBLING op. `replaySingle` gives each op its
// own bag and `replayFailedOperations` re-creates one per iteration; the
// multi-op case below is what fences that, since a shared bag would rewrite
// this value wherever it appears in the other op's text (issues #1912 / #1918).
const SIBLING_PLAINTEXT = 'sibling-op-secret-77c2';
const SIBLING_EXPR = '{{resolve:secretsmanager:other-secret:SecretString:password::}}';

const mockSMSend = vi.fn(async (cmd?: { input?: { SecretId?: string } }) => ({
  SecretString: JSON.stringify({
    password: cmd?.input?.SecretId === 'other-secret' ? SIBLING_PLAINTEXT : SECRET_PLAINTEXT,
  }),
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

/**
 * A TERMINAL error carrying the AWS-SDK metadata `extractDeploymentEventError`
 * reads. Issue #2038 review item 5: `maskedRollbackEventError` spreads the
 * extracted object, so `awsErrorCode` / `requestId` ride along — but the only
 * event assertions were `message` and `name`, so a mutation to
 * `{ name, message: masked }` dropped both and stayed green.
 */
function terminalAwsErrorWithMetadata(): Error {
  return Object.assign(
    new Error(`Value '${SECRET_PLAINTEXT}' at 'password' failed to satisfy constraint`),
    { name: 'ValidationException', $metadata: { httpStatusCode: 400, requestId: 'req-abc' } }
  );
}

/** A name-cooldown error (SQS's 60s window) that also quotes the secret. */
function cooldownErrorQuotingSecret(): Error {
  return new Error(
    `You must wait 60 seconds after deleting a queue before creating one with the same name. ` +
      `Value '${SECRET_PLAINTEXT}' at 'password' failed to satisfy constraint`
  );
}

/** A name-collision error that also quotes the secret. */
function collisionErrorQuotingSecret(): Error {
  return new Error(
    `Resource already exists. Value '${SECRET_PLAINTEXT}' at 'password' failed to satisfy constraint`
  );
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

  // Issue #2038 review item 5. The masking rebuilds the event error object, so
  // the OPTIONAL fields have to survive the rebuild — a `{ name, message }`
  // reconstruction silently drops the AWS error code and the request id, which
  // are the two fields an operator hands to AWS support, and the pre-review
  // assertions (message + name only) could not see it.
  it('the masked event error preserves awsErrorCode and requestId', async () => {
    const update = vi.fn().mockRejectedValue(terminalAwsErrorWithMetadata());
    const { ctx, events } = makeCtx({ update });
    const { ops, state } = secretBearingRevertOp();

    await replayRollback(ops, state, 'S', ctx);

    expect(update).toHaveBeenCalledTimes(1);
    const failed = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED') as
      | { error?: { message?: string; name?: string; awsErrorCode?: string; requestId?: string } }
      | undefined;
    expect(failed).toBeDefined();
    // Masking happened ...
    expect(failed!.error?.message).not.toContain(SECRET_PLAINTEXT);
    expect(failed!.error?.message).toContain(SECRET_MASK);
    // ... and nothing else was lost on the way through.
    expect(failed!.error?.name).toBe('ValidationException');
    expect(failed!.error?.awsErrorCode).toBe('ValidationException');
    expect(failed!.error?.requestId).toBe('req-abc');
  });
});

// Issue #2038 review item 4: the five mask sites added by the branch that no
// test reached. Each was mutated back to its pre-fix form with the whole
// `tests/unit/deployment` suite still GREEN.
describe('rollback replay - the reverse-replacement arms are masked (issue #2038)', () => {
  /**
   * A REPLACEMENT op: state points at the NEW physical id while `previousState`
   * carries the OLD one, so `classifyRollbackOp` returns `reverse-replacement`
   * — the arm that provably hands `resolvedPrevProps` PLAINTEXT to `create()`.
   */
  function secretBearingReplacementOp(): {
    ops: CompletedOperation[];
    state: Record<string, ResourceState>;
  } {
    const prev = res({
      physicalId: 'phys-OLD',
      properties: { ProviderDetails: { password: SECRET_EXPR } },
    });
    return {
      ops: [
        {
          logicalId: 'Idp',
          changeType: 'UPDATE',
          resourceType: IDP_TYPE,
          physicalId: 'phys-NEW',
          previousState: prev,
        },
      ],
      state: {
        Idp: res({
          physicalId: 'phys-NEW',
          properties: { ProviderDetails: { password: 'unrelated' } },
        }),
      },
    };
  }

  // The create-first attempt's retry logger. Its `isRetryable` is
  // `isNameCooldownError`, a custom classifier, so `retry.ts` emits NO give-up
  // summary for this loop (that line is gated on the propagation / 5xx counters,
  // both of which are inert under a caller-supplied classifier) — the
  // per-attempt DEBUG line is the sink that carries the AWS message here, and it
  // is what this pins.
  it('the create-first re-create retry line does not print the resolved secret', async () => {
    const create = vi.fn().mockRejectedValue(cooldownErrorQuotingSecret());
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, debugs, warns } = makeCtx({ create, delete: del });
    const { ops, state } = secretBearingReplacementOp();

    await replayRollback(ops, state, 'S', ctx);

    // Non-vacuity: the replay re-resolved the secret, handed the PLAINTEXT to
    // create(), and the cooldown loop really exhausted (1 + 8).
    expect(mockSMSend).toHaveBeenCalled();
    expect((create.mock.calls[0]![2] as Record<string, Record<string, unknown>>)['ProviderDetails'])
      .toEqual({ password: SECRET_PLAINTEXT });
    expect(create).toHaveBeenCalledTimes(9);
    // The collision fallback must NOT have run, or the line under test would be
    // attributable to the delete-new-first logger instead.
    expect(del).not.toHaveBeenCalled();

    const attemptLine = debugs.find((m) => m.includes('Retrying Idp in'));
    expect(attemptLine).toBeDefined();
    expect(attemptLine).not.toContain(SECRET_PLAINTEXT);
    expect(attemptLine).toContain(SECRET_MASK);
    expect(debugs.join('\n')).not.toContain(SECRET_PLAINTEXT);
    expect(warns.join('\n')).not.toContain(SECRET_PLAINTEXT);
  });

  // The delete-new-first fallback's retry logger. A COLLISION is not a cooldown,
  // so the create-first loop fails fast at attempt 0 and emits no line at all —
  // every `Retrying Idp` line here comes from the second loop.
  it('the delete-new-first re-create retry line does not print the resolved secret', async () => {
    const create = vi.fn().mockRejectedValue(collisionErrorQuotingSecret());
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, debugs, warns } = makeCtx({ create, delete: del });
    const { ops, state } = secretBearingReplacementOp();

    await replayRollback(ops, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    // 1 create-first (no retry) + the delete + 1 + 8 on the fallback loop.
    expect(del).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(10);

    const attemptLine = debugs.find((m) => m.includes('Retrying Idp in'));
    expect(attemptLine).toBeDefined();
    expect(attemptLine).not.toContain(SECRET_PLAINTEXT);
    expect(attemptLine).toContain(SECRET_MASK);
    expect(debugs.join('\n')).not.toContain(SECRET_PLAINTEXT);
    expect(warns.join('\n')).not.toContain(SECRET_PLAINTEXT);
  });

  // The delete-new-AFTER-recreate warn: the old resource is back, so this is a
  // best-effort warn rather than a failure — and the only place the new
  // resource's id is announced.
  it('the delete-new-after-recreate warn does not print the resolved secret', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-OLD-REBORN' });
    const del = vi.fn().mockRejectedValue(terminalAwsErrorQuotingSecret());
    const { ctx, warns } = makeCtx({ create, delete: del });
    const { ops, state } = secretBearingReplacementOp();

    await replayRollback(ops, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalled();

    const warnLine = warns.find((m) => m.includes('deleting the new resource'));
    expect(warnLine).toBeDefined();
    expect(warnLine).not.toContain(SECRET_PLAINTEXT);
    expect(warnLine).toContain(SECRET_MASK);
  });
});

describe('rollback replay - the partial-update advisories are masked (issues #2038 / #2031)', () => {
  const partialResult = {
    physicalId: 'phys-B',
    outcome: 'partial' as const,
    reason: `the old resource holding '${SECRET_PLAINTEXT}' survived — delete it manually`,
  };

  // `updatePartialMessage` renders PROVIDER-authored prose about a bag this
  // replay resolved to plaintext, and the event twin is DURABLE.
  it('the revert arm masks both the partial warn and the durable event reason', async () => {
    const update = vi.fn().mockResolvedValue(partialResult);
    const { ctx, warns, events } = makeCtx({ update });
    const { ops, state } = secretBearingRevertOp();

    await replayRollback(ops, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);

    const warnLine = warns.find((m) => m.includes('Idp restored, partial'));
    expect(warnLine).toBeDefined();
    expect(warnLine).not.toContain(SECRET_PLAINTEXT);
    expect(warnLine).toContain(SECRET_MASK);

    const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED') as
      | { reason?: string }
      | undefined;
    expect(succeeded?.reason).toBeDefined();
    expect(succeeded!.reason).not.toContain(SECRET_PLAINTEXT);
    expect(succeeded!.reason).toContain(SECRET_MASK);
  });

  it('the --revert-failed arm masks both the partial warn and the durable event reason', async () => {
    const update = vi.fn().mockResolvedValue(partialResult);
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
      Idp: res({ physicalId: 'phys-B', properties: { ProviderDetails: { password: SECRET_EXPR } } }),
    };

    await replayFailedOperations(failedOps, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    const warnLine = warns.find((m) => m.includes('Idp reverted, partial'));
    expect(warnLine).toBeDefined();
    expect(warnLine).not.toContain(SECRET_PLAINTEXT);
    expect(warnLine).toContain(SECRET_MASK);

    const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED') as
      | { reason?: string }
      | undefined;
    expect(succeeded?.reason).toBeDefined();
    expect(succeeded!.reason).not.toContain(SECRET_PLAINTEXT);
    expect(succeeded!.reason).toContain(SECRET_MASK);
  });
});

// Issue #2038 review item 6: the three coverage gaps the suite had no case for.
describe('rollback replay - masking scope and parity (issue #2038)', () => {
  it("one op's bag never masks a SIBLING op's ordinary literal", async () => {
    // Op A resolves `my-secret`; op B resolves `other-secret`. A's AWS error
    // quotes B's plaintext as an ordinary literal — the coincidence #1912 /
    // #1918 are about. Each op gets its OWN bag, so A's line must keep it.
    const update = vi.fn().mockImplementation((logicalId: string) => {
      if (logicalId === 'IdpA') {
        return Promise.reject(
          new Error(
            `Value '${SECRET_PLAINTEXT}' at 'password' and '${SIBLING_PLAINTEXT}' at ` +
              `'fallback' failed to satisfy constraint`
          )
        );
      }
      return Promise.reject(
        new Error(`Value '${SIBLING_PLAINTEXT}' at 'password' failed to satisfy constraint`)
      );
    });
    const { ctx, warns } = makeCtx({ update });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'IdpA',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-A',
        previousState: res({
          physicalId: 'phys-A',
          properties: { ProviderDetails: { password: SECRET_EXPR } },
        }),
      },
      {
        logicalId: 'IdpB',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: res({
          physicalId: 'phys-B',
          properties: { ProviderDetails: { password: SIBLING_EXPR } },
        }),
      },
    ];
    const state: Record<string, ResourceState> = {
      IdpA: res({ physicalId: 'phys-A', properties: { ProviderDetails: { password: 'x' } } }),
      IdpB: res({ physicalId: 'phys-B', properties: { ProviderDetails: { password: 'y' } } }),
    };

    await replayRollback(ops, state, 'S', ctx);

    const lineA = warns.find((m) => m.includes('Rollback failed for IdpA'));
    const lineB = warns.find((m) => m.includes('Rollback failed for IdpB'));
    expect(lineA).toBeDefined();
    expect(lineB).toBeDefined();
    // A masks its OWN secret ...
    expect(lineA).not.toContain(SECRET_PLAINTEXT);
    expect(lineA).toContain(SECRET_MASK);
    // ... and leaves B's value, an ordinary literal here, alone.
    expect(lineA).toContain(SIBLING_PLAINTEXT);
    // B masks its own, which is what proves B's bag was populated at all (an
    // empty one would satisfy the assertion above vacuously).
    expect(lineB).not.toContain(SIBLING_PLAINTEXT);
    expect(lineB).toContain(SECRET_MASK);
  });

  it('masks EVERY occurrence when one message quotes the same secret twice', async () => {
    const update = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `Value '${SECRET_PLAINTEXT}' at 'password' and '${SECRET_PLAINTEXT}' at 'confirm' ` +
            `failed to satisfy constraint`
        )
      );
    const { ctx, warns, events } = makeCtx({ update });
    const { ops, state } = secretBearingRevertOp();

    await replayRollback(ops, state, 'S', ctx);

    const failLine = warns.find((m) => m.includes('Rollback failed for Idp'))!;
    expect(failLine).not.toContain(SECRET_PLAINTEXT);
    expect(failLine.split(SECRET_MASK).length - 1).toBe(2);
    const failed = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED') as
      | { error?: { message?: string } }
      | undefined;
    expect(failed!.error!.message).not.toContain(SECRET_PLAINTEXT);
    expect(failed!.error!.message!.split(SECRET_MASK).length - 1).toBe(2);
  });

  it('an op that resolved NO secret logs byte-identically to before the fix', async () => {
    const update = vi.fn().mockRejectedValue(new Error('Bad Request: something ordinary failed'));
    const { ctx, warns, events } = makeCtx({ update });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: res({
          physicalId: 'phys-B',
          properties: { ProviderDetails: { client_id: 'pub' } },
        }),
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'phys-B',
        properties: { ProviderDetails: { client_id: 'pub-CHANGED' } },
      }),
    };

    await replayRollback(ops, state, 'S', ctx);

    // No secret was resolved, so nothing was looked up and nothing is rewritten.
    expect(mockSMSend).not.toHaveBeenCalled();
    expect(warns).toContain(
      '  Rollback failed for Idp (UPDATE): Bad Request: something ordinary failed'
    );
    const failed = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED') as
      | { error?: { message?: string } }
      | undefined;
    expect(failed!.error!.message).toBe('Bad Request: something ordinary failed');
  });
});
