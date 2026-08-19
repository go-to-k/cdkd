import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

// Pass-through retry so the reverse-replacement collision schedule does not
// sleep through its real backoff.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

// The rollback replay uses the REAL IntrinsicFunctionResolver to re-resolve the
// redacted secret expressions the journal / state store. The resolver fetches
// through getAwsClients() — mock the sends so each resolves to a known
// plaintext. Two clients are needed, and only two (no snapshot / no CC):
// `secretsManager` for `{{resolve:secretsmanager:...}}`, and — since issue
// #1901 — `ssm` for a `{{resolve:ssm:...}}` naming a SecureString parameter,
// which is now redacted into the journal too and therefore has to be
// re-resolved on replay exactly like a secretsmanager one.
const SECRET_PLAINTEXT = 'super-secret-rotated-value';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:client_secret::}}';
// A secret whose resolved plaintext is ITSELF a complete `{{resolve:...}}`
// string (issue #1917). Held in the same mock secret under its own JSON key, so
// no test has to override the shared mock implementation and risk leaking it.
const TOKEN_SHAPED_PLAINTEXT = '{{resolve:secretsmanager:decoy/other:SecretString:key}}';
const TOKEN_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:token_shaped::}}';
const TOKEN_EXPR_STAGED =
  '{{resolve:secretsmanager:my-secret:SecretString:token_shaped:AWSCURRENT}}';
const SECURE_PLAINTEXT = 'decrypted-securestring-value';
const SECURE_EXPR = '{{resolve:ssm:/prod/idp/client-secret}}';
const mockSMSend = vi.fn(async () => ({
  SecretString: JSON.stringify({
    client_secret: SECRET_PLAINTEXT,
    token_shaped: TOKEN_SHAPED_PLAINTEXT,
  }),
}));
// Declares the command parameter (unlike `mockSMSend`, which no assertion
// inspects) so the SecureString test can read back the `WithDecryption` flag.
const mockSSMSend = vi.fn(async (_command: unknown) => ({
  Parameter: { Value: SECURE_PLAINTEXT, Type: 'SecureString' },
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    secretsManager: { send: mockSMSend },
    ssm: { send: mockSSMSend },
  }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::Cognito::UserPoolIdentityProvider',
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

function makeCtx(provider: { update?: unknown; create?: unknown; delete?: unknown }): {
  ctx: RollbackExecutorContext;
} {
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
  return { ctx };
}

beforeEach(() => {
  mockSMSend.mockClear();
  // Reset the ssm spy for the same reason. Without it the SecureString test's
  // `mock.calls[0]` read and the no-secret test's `not.toHaveBeenCalled()` only
  // hold because of the order tests happen to run in today, so inserting any
  // ssm-using test above them would silently break both.
  mockSSMSend.mockClear();
  // Per-test isolation of the resolved-value cache no longer comes from this
  // call: since issue #1933 the cache lives on the RESOLVER INSTANCE, and
  // `replayRollback` / `replayFailedOperations` each build a fresh one per
  // replay — so every test starts with an empty cache by construction, which is
  // what keeps the per-test `mockSMSend` counts honest. The reset is still
  // wanted for the process-global SecureString VERDICT store (and the account /
  // AZ caches), where a verdict pinned by one test would otherwise decide
  // secret-ness in the next.
  resetAccountInfoCache();
});

const IDP_TYPE = 'AWS::Cognito::UserPoolIdentityProvider';

describe('rollback replay - secret re-resolution + state redaction (GHSA #1899)', () => {
  it('revert: provider.update gets the RESOLVED secret, but state keeps the {{resolve:...}} expression', async () => {
    // The provider echoes the resolved secret back in effectiveProperties (the
    // #1682 shape) — so without redactRollbackRecord the state would persist the
    // plaintext. This makes both halves non-vacuous.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'phys-B',
      effectiveProperties: { ProviderDetails: { client_id: 'pub', client_secret: SECRET_PLAINTEXT } },
    });
    const { ctx } = makeCtx({ update });
    const prev = res({
      physicalId: 'phys-B',
      resourceType: IDP_TYPE,
      properties: { ProviderDetails: { client_id: 'pub', client_secret: SECRET_EXPR } },
    });
    const ops: CompletedOperation[] = [
      { logicalId: 'Idp', changeType: 'UPDATE', resourceType: IDP_TYPE, physicalId: 'phys-B', previousState: prev },
    ];
    // current differs from prev (client_id changed) so the op is a real
    // 'revert', not 'skip-already-done'.
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'phys-B',
        resourceType: IDP_TYPE,
        properties: { ProviderDetails: { client_id: 'pub-CHANGED', client_secret: SECRET_EXPR } },
      }),
    };

    await replayRollback(ops, state, 'S', ctx);

    // The resolver actually fetched the secret (non-vacuity: else the arg below
    // would just be the raw expression and prove nothing).
    expect(mockSMSend).toHaveBeenCalled();
    // Provider received the concrete secret in the desired-props argument.
    const desiredArg = update.mock.calls[0]![3] as { ProviderDetails: { client_secret: string } };
    expect(desiredArg.ProviderDetails.client_secret).toBe(SECRET_PLAINTEXT);
    // BOTH diff sides are resolved — the PREVIOUS side (arg 4, current.properties)
    // must resolve too, else a patch-based provider diffs expression-vs-plaintext
    // and computes a spurious change / wrong no-op. Deleting the current-side
    // resolveReplayProps call must fail HERE, not pass silently.
    const prevArg = update.mock.calls[0]![4] as { ProviderDetails: { client_secret: string } };
    expect(prevArg.ProviderDetails.client_secret).toBe(SECRET_PLAINTEXT);
    // Persisted state holds the EXPRESSION (redacted out of the echoed
    // effectiveProperties), never the plaintext.
    const rec = state.Idp!;
    expect((rec.properties['ProviderDetails'] as Record<string, unknown>)['client_secret']).toBe(
      SECRET_EXPR
    );
    expect(JSON.stringify(state)).not.toContain(SECRET_PLAINTEXT);
  });

  // Issue #1910: the rollback WRITES state after re-resolving, so it is a
  // redaction site of its own, and it had no position source either. Two
  // expressions resolving to one value collapse in the value-keyed map, so the
  // state this replay persists disagrees with the template at one leaf and the
  // next deploy reports a change that never converges.
  it('revert: two references sharing one resolved value keep their OWN expressions', async () => {
    // Both stages of one secret resolve to the same plaintext — which they do
    // until the versions diverge, and at that point the replay would be
    // shipping the WRONG version to the live resource.
    const STAGED_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:client_secret:AWSCURRENT}}';
    const update = vi.fn().mockResolvedValue({
      physicalId: 'phys-B',
      // The provider echoes BOTH resolved leaves back, so without a position
      // source the redaction has only the collapsed map to work from.
      effectiveProperties: {
        ProviderDetails: {
          client_id: 'pub',
          client_secret: SECRET_PLAINTEXT,
          client_secret_staged: SECRET_PLAINTEXT,
        },
      },
    });
    const { ctx } = makeCtx({ update });
    const journaled = {
      ProviderDetails: {
        client_id: 'pub',
        client_secret: SECRET_EXPR,
        client_secret_staged: STAGED_EXPR,
      },
    };
    const prev = res({ physicalId: 'phys-B', resourceType: IDP_TYPE, properties: journaled });
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
        resourceType: IDP_TYPE,
        properties: {
          ProviderDetails: {
            client_id: 'pub-CHANGED',
            client_secret: SECRET_EXPR,
            client_secret_staged: STAGED_EXPR,
          },
        },
      }),
    };

    await replayRollback(ops, state, 'S', ctx);

    // Non-vacuity: the plaintext really was in hand on both leaves.
    expect(mockSMSend).toHaveBeenCalled();
    const desiredArg = update.mock.calls[0]![3] as {
      ProviderDetails: Record<string, string>;
    };
    expect(desiredArg.ProviderDetails['client_secret']).toBe(SECRET_PLAINTEXT);
    expect(desiredArg.ProviderDetails['client_secret_staged']).toBe(SECRET_PLAINTEXT);

    const details = state.Idp!.properties['ProviderDetails'] as Record<string, string>;
    expect(details['client_secret']).toBe(SECRET_EXPR);
    expect(details['client_secret_staged']).toBe(STAGED_EXPR);
    expect(JSON.stringify(state)).not.toContain(SECRET_PLAINTEXT);
  });

  // BINDING test for the CONSTANT this writer passes, not for what that constant
  // DOES (issue #1917 review). The rules matrix in
  // `secret-redaction-provenance.test.ts` pins each constant's behavior, but
  // nothing pinned `redactRollbackRecord`'s CHOICE — swapping it to any other
  // constant left the whole suite green while re-opening #1917 AND disabling
  // positional descent on the replay path.
  //
  // The fixture separates `STATE_DERIVED_RULES` from all four alternatives at
  // once, and each half of its shape is load-bearing:
  //
  //  - The list holds PLAIN STRINGS, so the order-independent keyed descent
  //    cannot pair them and only `descendArrays` can tell the two leaves apart.
  //    That kills the two `descendArrays: false` constants.
  //  - The resolved plaintext is TOKEN-SHAPED, so a constant without
  //    `sourceIsSameGeneration` refuses the source and falls to the value scan.
  //    That kills `TEMPLATE_DERIVED_RULES`, which shares `descendArrays: true`.
  //  - The two references COLLIDE on one plaintext, so the value scan's answer
  //    is visibly wrong (both leaves take whichever expression was recorded
  //    last) rather than merely different.
  it('binds the replay writer to STATE_DERIVED_RULES, not merely to its behavior', async () => {
    const update = vi.fn().mockResolvedValue({
      physicalId: 'phys-B',
      effectiveProperties: {
        Label: 'pub',
        Scopes: [TOKEN_SHAPED_PLAINTEXT, TOKEN_SHAPED_PLAINTEXT],
      },
    });
    const { ctx } = makeCtx({ update });
    // `Label` differs from the live record below so the revert is a REAL
    // change: `resolveReplayProps` short-circuits when the journaled bag already
    // equals what state holds, and a short-circuited replay resolves nothing at
    // all, which would make every assertion here vacuous.
    const journaled = { Label: 'pub', Scopes: [TOKEN_EXPR, TOKEN_EXPR_STAGED] };
    const prev = res({ physicalId: 'phys-B', resourceType: IDP_TYPE, properties: journaled });
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
        resourceType: IDP_TYPE,
        properties: { Label: 'pub-CHANGED', Scopes: [TOKEN_EXPR, TOKEN_EXPR_STAGED] },
      }),
    };

    await replayRollback(ops, state, 'S', ctx);

    // Non-vacuity: the replay really did resolve both leaves to the plaintext
    // and hand it to the provider. Without this the assertions below would also
    // pass on a replay that never resolved anything.
    expect(mockSMSend).toHaveBeenCalled();
    const desiredArg = update.mock.calls[0]![3] as { Scopes: string[] };
    expect(desiredArg.Scopes).toEqual([TOKEN_SHAPED_PLAINTEXT, TOKEN_SHAPED_PLAINTEXT]);

    const scopes = state.Idp!.properties['Scopes'] as string[];
    expect(scopes[0]).toBe(TOKEN_EXPR);
    expect(scopes[1]).toBe(TOKEN_EXPR_STAGED);
  });

  it('reverse-replacement: re-CREATE gets the resolved secret, state keeps the expression', async () => {
    const create = vi.fn().mockResolvedValue({
      physicalId: 'old-idp',
      attributes: {},
      effectiveProperties: { ProviderDetails: { client_secret: SECRET_PLAINTEXT } },
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({
      physicalId: 'old-idp',
      resourceType: IDP_TYPE,
      properties: { ProviderDetails: { client_secret: SECRET_EXPR } },
    });
    const ops: CompletedOperation[] = [
      { logicalId: 'Idp', changeType: 'UPDATE', resourceType: IDP_TYPE, physicalId: 'new-idp', previousState: prev },
    ];
    // current physicalId differs from prev → reverse-replacement classification.
    const state: Record<string, ResourceState> = {
      Idp: res({ physicalId: 'new-idp', resourceType: IDP_TYPE, properties: { ProviderDetails: { client_secret: SECRET_EXPR } } }),
    };

    await replayRollback(ops, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    const createProps = create.mock.calls[0]![2] as { ProviderDetails: { client_secret: string } };
    expect(createProps.ProviderDetails.client_secret).toBe(SECRET_PLAINTEXT);
    expect(JSON.stringify(state)).not.toContain(SECRET_PLAINTEXT);
    expect((state.Idp!.properties['ProviderDetails'] as Record<string, unknown>)['client_secret']).toBe(
      SECRET_EXPR
    );
  });

  it('revert-failed-update: provider.update gets the resolved secret, state keeps the expression', async () => {
    const update = vi.fn().mockResolvedValue({
      physicalId: 'phys-B',
      effectiveProperties: { ProviderDetails: { client_secret: SECRET_PLAINTEXT } },
    });
    const { ctx } = makeCtx({ update });
    const prev = res({
      physicalId: 'phys-B',
      resourceType: IDP_TYPE,
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
      Idp: res({ physicalId: 'phys-B', resourceType: IDP_TYPE, properties: { ProviderDetails: { client_secret: SECRET_EXPR } } }),
    };

    await replayFailedOperations(failed, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    const desiredArg = update.mock.calls[0]![3] as { ProviderDetails: { client_secret: string } };
    expect(desiredArg.ProviderDetails.client_secret).toBe(SECRET_PLAINTEXT);
    // The PREVIOUS side (arg 4, attemptedProperties) must resolve too — see the
    // revert test's note; deleting that resolveReplayProps call must fail here.
    const prevArg = update.mock.calls[0]![4] as { ProviderDetails: { client_secret: string } };
    expect(prevArg.ProviderDetails.client_secret).toBe(SECRET_PLAINTEXT);
    expect(JSON.stringify(state)).not.toContain(SECRET_PLAINTEXT);
    expect((state.Idp!.properties['ProviderDetails'] as Record<string, unknown>)['client_secret']).toBe(
      SECRET_EXPR
    );
  });

  // Test review, HIGH: only the revert-UPDATE site was fenced for the collision.
  // The other two `redactRollbackRecord` call sites are on paths that SHIP to
  // AWS, so an unfenced collapse there is the wrong-secret-version failure.
  const STAGED_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:client_secret:AWSCURRENT}}';
  const collidingDetails = {
    ProviderDetails: { client_secret: SECRET_EXPR, client_secret_staged: STAGED_EXPR },
  };
  const collidingEcho = {
    ProviderDetails: {
      client_secret: SECRET_PLAINTEXT,
      client_secret_staged: SECRET_PLAINTEXT,
    },
  };

  function expectUncollapsed(state: Record<string, ResourceState>): void {
    const details = state.Idp!.properties['ProviderDetails'] as Record<string, string>;
    expect(details['client_secret']).toBe(SECRET_EXPR);
    expect(details['client_secret_staged']).toBe(STAGED_EXPR);
    expect(JSON.stringify(state)).not.toContain(SECRET_PLAINTEXT);
  }

  it('reverse-replacement re-CREATE: a colliding pair keeps its OWN expressions', async () => {
    const create = vi.fn().mockResolvedValue({
      physicalId: 'old-idp',
      attributes: {},
      effectiveProperties: collidingEcho,
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({
      physicalId: 'old-idp',
      resourceType: IDP_TYPE,
      properties: collidingDetails,
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
      Idp: res({ physicalId: 'new-idp', resourceType: IDP_TYPE, properties: collidingDetails }),
    };

    await replayRollback(ops, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    expectUncollapsed(state);
  });

  it('revert-failed-update: a colliding pair keeps its OWN expressions', async () => {
    const update = vi.fn().mockResolvedValue({
      physicalId: 'phys-B',
      effectiveProperties: collidingEcho,
    });
    const { ctx } = makeCtx({ update });
    const prev = res({
      physicalId: 'phys-B',
      resourceType: IDP_TYPE,
      properties: collidingDetails,
    });
    const failed: FailedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: prev,
        attemptedProperties: collidingDetails,
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({ physicalId: 'phys-B', resourceType: IDP_TYPE, properties: collidingDetails }),
    };

    await replayFailedOperations(failed, state, 'S', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    expectUncollapsed(state);
  });

  it('does not fetch any secret when the reverted properties hold no {{resolve:...}} expression', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', resourceType: 'AWS::S3::Bucket', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-B', resourceType: 'AWS::S3::Bucket', properties: { a: 2 } }),
    };

    await replayRollback(ops, state, 'S', ctx);

    // No {{resolve:...}} anywhere → no live secret fetch of either kind, and the
    // provider still receives the (structurally-equal) previous props.
    expect(mockSMSend).not.toHaveBeenCalled();
    expect(mockSSMSend).not.toHaveBeenCalled();
    // The 6th argument is the `UpdateContext` issue #1932 item 3 added; it is
    // present even on a no-secret op (the masker is bound to an EMPTY bag and
    // is therefore an identity, which is what lets a provider use it
    // unconditionally). Matched by shape so this stays an assertion about the
    // first five arguments, which is what it was written to check.
    expect(update).toHaveBeenCalledWith(
      'B',
      'phys-B',
      'AWS::S3::Bucket',
      { a: 1 },
      { a: 2 },
      { maskSecrets: expect.any(Function) }
    );
    // The empty-bag masker really is an identity, so a provider warn on a
    // no-secret op is byte-identical to before this contract existed.
    const context = update.mock.calls[0]![5] as { maskSecrets: (t: string) => string };
    expect(context.maskSecrets('AWS rejected "some-plain-value"')).toBe(
      'AWS rejected "some-plain-value"'
    );
  });

  // Issue #1901 makes a SecureString `{{resolve:ssm:...}}` a SECOND value class
  // the journal / state store REDACTED, so the replay has to re-resolve it for
  // the provider exactly like a secretsmanager one. Without this the rollback
  // would ship the literal `{{resolve:ssm:...}}` token to AWS — the
  // "redacting a value breaks its replay consumer" class.
  it('revert: a SecureString ssm expression is re-resolved for the provider and re-redacted in state', async () => {
    // The provider echoes the decrypted value back in effectiveProperties, so
    // both halves are non-vacuous: without re-resolution the update arg would be
    // the raw expression, and without re-redaction state would keep the plaintext.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'phys-B',
      effectiveProperties: { ProviderDetails: { client_secret: SECURE_PLAINTEXT } },
    });
    const { ctx } = makeCtx({ update });
    const prev = res({
      physicalId: 'phys-B',
      resourceType: IDP_TYPE,
      properties: { ProviderDetails: { client_id: 'pub', client_secret: SECURE_EXPR } },
    });
    const ops: CompletedOperation[] = [
      { logicalId: 'Idp', changeType: 'UPDATE', resourceType: IDP_TYPE, physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'phys-B',
        resourceType: IDP_TYPE,
        properties: { ProviderDetails: { client_id: 'pub-CHANGED', client_secret: SECURE_EXPR } },
      }),
    };

    await replayRollback(ops, state, 'S', ctx);

    // The resolver really went to SSM (non-vacuity), and with decryption on —
    // the replay needs the concrete value, unlike the diff path.
    expect(mockSSMSend).toHaveBeenCalled();
    const ssmInput = (
      mockSSMSend.mock.calls[0]![0] as { input: { Name?: string; WithDecryption?: boolean } }
    ).input;
    expect(ssmInput.WithDecryption).toBe(true);
    // ...and fetched the parameter the EXPRESSION names. The mock answers any
    // name, so without this a replay resolving the wrong parameter passes.
    expect(ssmInput.Name).toBe('/prod/idp/client-secret');
    // Provider received the DECRYPTED value on both diff sides.
    const desiredArg = update.mock.calls[0]![3] as { ProviderDetails: { client_secret: string } };
    expect(desiredArg.ProviderDetails.client_secret).toBe(SECURE_PLAINTEXT);
    const prevArg = update.mock.calls[0]![4] as { ProviderDetails: { client_secret: string } };
    expect(prevArg.ProviderDetails.client_secret).toBe(SECURE_PLAINTEXT);
    // ...while the persisted record keeps the expression and no plaintext.
    const rec = state.Idp!;
    expect((rec.properties['ProviderDetails'] as Record<string, unknown>)['client_secret']).toBe(
      SECURE_EXPR
    );
    expect(JSON.stringify(state)).not.toContain(SECURE_PLAINTEXT);
  });
});

// The replay builds ONE resolver and shares it across every op (issue #1933).
// Before that hoist it built one per op, which was free while the resolved-value
// cache was module-global and became an N-times-per-expression refetch the
// moment the cache moved onto the instance. Both directions are pinned here:
// the dedupe the hoist exists for, and the per-op correctness it must not cost.
describe('rollback replay - one resolver per REPLAY, not per op (issue #1933)', () => {
  function opFor(logicalId: string, expr: string): CompletedOperation {
    return {
      logicalId,
      changeType: 'UPDATE',
      resourceType: IDP_TYPE,
      physicalId: `phys-${logicalId}`,
      previousState: res({
        physicalId: `phys-${logicalId}`,
        resourceType: IDP_TYPE,
        properties: { ProviderDetails: { client_id: 'pub', client_secret: expr } },
      }),
    };
  }

  function stateFor(logicalIds: string[], expr: string): Record<string, ResourceState> {
    const out: Record<string, ResourceState> = {};
    for (const logicalId of logicalIds) {
      out[logicalId] = res({
        physicalId: `phys-${logicalId}`,
        resourceType: IDP_TYPE,
        // Differs from `previousState` so the op is a real revert, not a
        // 'skip-already-done'.
        properties: { ProviderDetails: { client_id: 'pub-CHANGED', client_secret: expr } },
      });
    }
    return out;
  }

  it('fetches ONE expression once for a multi-op replay', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    const { ctx } = makeCtx({ update });
    const logicalIds = ['IdpA', 'IdpB', 'IdpC', 'IdpD'];
    const ops = logicalIds.map((id) => opFor(id, SECRET_EXPR));

    await replayRollback(ops, stateFor(logicalIds, SECRET_EXPR), 'S', ctx);

    // Non-vacuity: every op really ran and really re-resolved.
    expect(update).toHaveBeenCalledTimes(4);
    for (const call of update.mock.calls) {
      const desired = call[3] as { ProviderDetails: { client_secret: string } };
      expect(desired.ProviderDetails.client_secret).toBe(SECRET_PLAINTEXT);
    }
    // ...but the secret was fetched ONCE. Per-op resolvers make this 4 (8 in
    // fact — both diff sides resolve), which is the amplification the hoist
    // removes.
    expect(mockSMSend).toHaveBeenCalledTimes(1);
  });

  it('keeps DIFFERENT expressions apart across ops of the same replay', async () => {
    // The other polarity: sharing one resolver must not let one op's value
    // answer for another's. A cache keyed loosely enough to collide would ship
    // the WRONG secret to a live resource on replay.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    const { ctx } = makeCtx({ update });
    const ops = [opFor('IdpSecret', SECRET_EXPR), opFor('IdpSecure', SECURE_EXPR)];
    const state = {
      ...stateFor(['IdpSecret'], SECRET_EXPR),
      ...stateFor(['IdpSecure'], SECURE_EXPR),
    };

    await replayRollback(ops, state, 'S', ctx);

    const bySecret = new Map<string, string>();
    for (const call of update.mock.calls) {
      const logicalId = call[0] as string;
      const desired = call[3] as { ProviderDetails: { client_secret: string } };
      bySecret.set(logicalId, desired.ProviderDetails.client_secret);
    }
    expect(bySecret.get('IdpSecret')).toBe(SECRET_PLAINTEXT);
    expect(bySecret.get('IdpSecure')).toBe(SECURE_PLAINTEXT);
    // Each expression cost its own lookup, on its own service client.
    expect(mockSMSend).toHaveBeenCalledTimes(1);
    expect(mockSSMSend).toHaveBeenCalledTimes(1);
    // And neither plaintext leaked into the other record.
    expect(JSON.stringify(state['IdpSecret'])).not.toContain(SECURE_PLAINTEXT);
    expect(JSON.stringify(state['IdpSecure'])).not.toContain(SECRET_PLAINTEXT);
  });
});
