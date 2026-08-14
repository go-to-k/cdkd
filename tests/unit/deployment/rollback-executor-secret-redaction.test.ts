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
const SECURE_PLAINTEXT = 'decrypted-securestring-value';
const SECURE_EXPR = '{{resolve:ssm:/prod/idp/client-secret}}';
const mockSMSend = vi.fn(async () => ({
  SecretString: JSON.stringify({ client_secret: SECRET_PLAINTEXT }),
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
  // The dynamic-reference cache is module-global; clear it so each test's
  // resolution is a real fetch (keeps the per-test mockSMSend assertion honest).
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
    expect(update).toHaveBeenCalledWith('B', 'phys-B', 'AWS::S3::Bucket', { a: 1 }, { a: 2 });
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
    const ssmInput = (mockSSMSend.mock.calls[0]![0] as { input: { WithDecryption?: boolean } }).input;
    expect(ssmInput.WithDecryption).toBe(true);
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
