import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { CreateContext, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

// Issue #1932 item 3, rollback half. The rollback path needs the masker MORE
// than the forward deploy does: `resolveReplayProps` deliberately re-resolves
// every redacted `{{resolve:...}}` expression back to PLAINTEXT before handing
// the bag to a provider, so a replayed bag is guaranteed to carry the concrete
// secret whenever the resource has one. Threading the capability on the deploy
// engine alone would have left the contract applied at one caller and absent
// at the one whose bag is provably plaintext.

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

const SECRET_PLAINTEXT = 'super-secret-rotated-value';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:client_secret::}}';

const mockSMSend = vi.fn(async () => ({
  SecretString: JSON.stringify({ client_secret: SECRET_PLAINTEXT }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: mockSMSend }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const IDP_TYPE = 'AWS::Cognito::UserPoolIdentityProvider';

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

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function makeCtx(provider: { update?: unknown; create?: unknown; delete?: unknown }): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
}

/**
 * The masker must be present AND bound to the bag this replay re-resolved into
 * — a presence-only assertion would pass for one bound to an empty map, which
 * is exactly what a bind-time short-circuit would produce here (the rollback
 * arms build the map EMPTY and let `resolveReplayProps` fill it).
 */
function expectWorkingMasker(context: CreateContext | UpdateContext | undefined): void {
  expect(context).toBeDefined();
  expect(typeof context!.maskSecrets).toBe('function');
  expect(context!.maskSecrets!(`rejected "${SECRET_PLAINTEXT}"`)).toBe(`rejected "${SECRET_MASK}"`);
  expect(context!.maskSecrets!('rejected "PLAIN"')).toBe('rejected "PLAIN"');
}

beforeEach(() => {
  mockSMSend.mockClear();
  resetAccountInfoCache();
});

describe('rollback replay - provider calls carry a working secret masker (issue #1932 item 3)', () => {
  it('revert UPDATE: passes a masker bound to this op re-resolved secrets', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update });
    const prev = res({
      physicalId: 'phys-B',
      properties: { ProviderDetails: { client_id: 'pub', client_secret: SECRET_EXPR } },
    });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'phys-B',
        properties: { ProviderDetails: { client_id: 'pub-CHANGED', client_secret: SECRET_EXPR } },
      }),
    };

    await replayRollback(ops, state, 'S', ctx);

    // Non-vacuity: the replay really did re-resolve a secret into plaintext.
    expect(mockSMSend).toHaveBeenCalled();
    expectWorkingMasker(update.mock.calls[0]![5] as UpdateContext | undefined);
  });

  it('revert UPDATE: the masker rides alongside, and does not become, the readback flag', async () => {
    // `desiredFromAwsReadback` must stay UNSET on a rollback arm: the desired
    // bag is `previousState.properties`, a TEMPLATE recorded earlier, and
    // setting the flag would make providers read an empty collection as
    // "delete the live configuration" during a rollback.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { Name: 'old' } });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({ physicalId: 'phys-B', properties: { Name: 'new' } }),
    };

    await replayRollback(ops, state, 'S', ctx);

    const context = update.mock.calls[0]![5] as UpdateContext | undefined;
    expect(typeof context?.maskSecrets).toBe('function');
    expect(context?.desiredFromAwsReadback).toBeUndefined();
  });

  it('reverse-replacement CREATE: passes a masker AND keeps replayingState', async () => {
    // The re-create arm shares a module-level `CreateContext` constant. The
    // masker is per-op, so it must be spread onto a fresh object rather than
    // mutated in — and `replayingState` must survive that spread, or a
    // provider's pre-flight refusal stops downgrading to a warning and the old
    // resource becomes unrestorable.
    const create = vi.fn().mockResolvedValue({ physicalId: 'old-idp', attributes: {} });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const prev = res({
      physicalId: 'old-idp',
      properties: { ProviderDetails: { client_secret: SECRET_EXPR } },
    });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        // Differs from `prev.physicalId` -> reverse-replacement classification.
        physicalId: 'new-idp',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'new-idp',
        properties: { ProviderDetails: { client_secret: SECRET_EXPR } },
      }),
    };

    await replayRollback(ops, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    const context = create.mock.calls[0]![3] as CreateContext | undefined;
    expectWorkingMasker(context);
    expect(context?.replayingState).toBe(true);
  });

  it('reverse-replacement REFUSAL under Retain: fires, and puts no plaintext on the persisted event (issue #2598)', async () => {
    // `resolveReplayProps` has re-resolved this op's bag to PLAINTEXT by the
    // time the re-create runs, so the AWS rejection the refusal quotes back
    // can carry the secret. Found by the code reviewer on PR 2634: the first
    // draft of the refusal masked neither its message nor its cause, while
    // both siblings in the same `catch` mask at construction.
    //
    // WHAT THIS CASE DOES AND DOES NOT PIN, stated because the difference was
    // MEASURED. It pins that the refusal fires (not a raw rethrow) and that no
    // plaintext reaches the persisted event. It does NOT pin the
    // construction-time masking: removing `maskSecretsInText` from the message
    // OR `maskSecretsInError` from the cause leaves this case GREEN, because
    // every downstream reader masks independently and
    // `extractDeploymentEventError` takes `message` from the top level only,
    // so the cause's text never reaches an observable surface at all. That is
    // the same "MEASURED UNFENCEABLE" property `rollback-executor.ts` already
    // records for its two sibling wraps two arms down — kept as
    // defense-in-depth so the plaintext never exists inside a thrown `Error`
    // for a future reader of the chain to re-open, not because a test holds
    // it. Do not cite this case as coverage of the masking.
    const create = vi.fn().mockRejectedValue(
      // A collision rejection that ECHOES the resolved secret, which is what
      // makes this discriminate: a fixture whose rejection carries no secret
      // passes with the masking removed.
      new Error(`Idp already exists (client_secret "${SECRET_PLAINTEXT}")`)
    );
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const errors: string[] = [];
    ctx.recordEvent = (e) => {
      if (e.error?.message) errors.push(e.error.message);
    };
    const prev = res({
      physicalId: 'old-idp',
      properties: { ProviderDetails: { client_secret: SECRET_EXPR } },
    });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'new-idp',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'new-idp',
        properties: { ProviderDetails: { client_secret: SECRET_EXPR } },
        // Pins the new copy in place, so the collision arm REFUSES instead of
        // deleting it to free the name.
        updateReplacePolicy: 'Retain',
      }),
    };

    const result = await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    expect(mockSMSend).toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    const text = errors.join('\n');
    // The refusal fired rather than a raw rethrow — the discriminator, since
    // "no delete, one failure" is also what a rethrow produces.
    expect(text).toContain('Cannot reverse the replacement of Idp');
    // The event surface carries no plaintext. True with or without the
    // construction-time masking (see above), so this is a property of the
    // whole path, not of the wrap.
    expect(text).not.toContain(SECRET_PLAINTEXT);
    expect(text).toContain(SECRET_MASK);
  });

  it('the DURABLE survivor reason carries no plaintext (issue #2598)', async () => {
    // Finding 4 of the security round. The retain arms now publish a `reason`
    // onto `ROLLBACK_RESOURCE_SUCCEEDED`, which OUTLIVES the terminal -- it
    // lands in `deployments/*.jsonl`. Unlike this file's other masking cases,
    // this one is genuinely fenceable: the event is a real observable surface,
    // not a swallowed throw, so removing the mask at the event site changes
    // what a reader sees.
    //
    // The delete-new-FAILED arm is the vehicle because its reason interpolates
    // a PROVIDER-authored message, which is where a resolved secret can be
    // echoed back; the two `Retain` reasons are cdkd-authored ids and prose.
    const create = vi.fn().mockResolvedValue({ physicalId: 'old-idp' });
    const del = vi
      .fn()
      .mockRejectedValue(new Error(`AccessDenied on client_secret "${SECRET_PLAINTEXT}"`));
    const ctx = makeCtx({ create, delete: del });
    const reasons: string[] = [];
    ctx.recordEvent = (e) => {
      if (e.reason) reasons.push(e.reason);
    };
    const prev = res({
      physicalId: 'old-idp',
      properties: { ProviderDetails: { client_secret: SECRET_EXPR } },
    });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'new-idp',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'new-idp',
        properties: { ProviderDetails: { client_secret: SECRET_EXPR } },
      }),
    };

    await replayRollback(ops, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    const text = reasons.join('\n');
    // The arm really was taken (not some other reason-bearing event)...
    expect(text).toContain('could not be deleted');
    // ...and the plaintext the provider echoed back does not reach the record.
    expect(text).not.toContain(SECRET_PLAINTEXT);
    expect(text).toContain(SECRET_MASK);
  });

  it('revert-failed UPDATE: passes a masker bound to this op re-resolved secrets', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update });
    const prev = res({
      physicalId: 'phys-B',
      properties: { ProviderDetails: { client_secret: SECRET_EXPR } },
    });
    const failed: FailedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: prev,
        attemptedProperties: { ProviderDetails: { client_secret: SECRET_EXPR } },
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'phys-B',
        properties: { ProviderDetails: { client_secret: SECRET_EXPR } },
      }),
    };

    await replayFailedOperations(failed, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    expectWorkingMasker(update.mock.calls[0]![5] as UpdateContext | undefined);
  });
});
