import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetMethodCommand,
  GetAccountCommand,
  UpdateAccountCommand,
  PutMethodCommand,
} from '@aws-sdk/client-api-gateway';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * Read-update round-trip suite for ApiGatewayProvider.
 *
 * Mechanical guard for the three latent failure modes documented in
 * docs/provider-development.md § 3b — Class 1 (type-discriminator-
 * dependent fields), Class 2 (structurally-incomplete-when-empty
 * fields), and the truthy-gate `update()` bug — all of which only
 * surface on the `cdkd drift --revert` round-trip
 * (`observedProperties` → `provider.update`).
 */
describe('ApiGatewayProvider read-update round-trip', () => {
  let provider: ApiGatewayProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ApiGatewayProvider();
  });

  // ─── AWS::ApiGateway::Account ───────────────────────────────────────

  it('Account round-trip: empty CloudWatchRoleArn placeholder reaches AWS as a real clear-patch (truthy-gate fix)', async () => {
    // Truthy-gate guard. Before the fix, `updateAccountWithRetry` used
    // `cloudWatchRoleArn ? [...] : []` which silently dropped `''`,
    // so a `cdkd drift --revert` from "AWS-set CW role" → "state has
    // empty placeholder" would succeed with zero AWS-side change and
    // the next drift would re-detect the same drift forever.
    //
    // After the fix: `cloudWatchRoleArn !== undefined` ships
    // `replace /cloudwatchRoleArn ''` — the same patch shape
    // deleteAccount uses, which AWS documents as "clear this field".
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'AccountLogical',
      'ApiGatewayAccount',
      'AWS::ApiGateway::Account',
      { CloudWatchRoleArn: '' },
      { CloudWatchRoleArn: 'arn:aws:iam::123:role/cw' }
    );

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateAccountCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as {
      patchOperations: Array<{ op: string; path: string; value: string }>;
    };
    expect(input.patchOperations).toEqual([
      { op: 'replace', path: '/cloudwatchRoleArn', value: '' },
    ]);
  });

  it('Account round-trip: state == AWS produces zero AWS-side mutations', async () => {
    // readCurrentState produces `CloudWatchRoleArn: ''` placeholder on
    // an account that has no CloudWatch role configured. Round-tripping
    // that placeholder through update() with no drift must not change
    // AWS state — but the truthy-gate fix means an explicit `''` does
    // get pushed back. The AWS-side behavior is "replace with empty",
    // which is idempotent on an already-empty account; the SDK call
    // count below is the orthogonal "no call beyond the patch we sent"
    // assertion.
    mockSend.mockResolvedValueOnce({}); // UpdateAccount (idempotent)

    const observed = { CloudWatchRoleArn: '' };
    await provider.update(
      'AccountLogical',
      'ApiGatewayAccount',
      'AWS::ApiGateway::Account',
      observed,
      observed
    );

    // Exactly one UpdateAccount call (the idempotent clear). No other
    // commands.
    const updateCalls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateAccountCommand);
    expect(updateCalls).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('Account readCurrentState emits the CloudWatchRoleArn placeholder', async () => {
    // Always-emit contract for the user-controllable top-level key.
    mockSend.mockResolvedValueOnce({}); // GetAccount: no CW role configured

    const observed = await provider.readCurrentState(
      'ApiGatewayAccount',
      'AccountLogical',
      'AWS::ApiGateway::Account'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetAccountCommand);
    expect(observed).toEqual({ CloudWatchRoleArn: '' });
  });

  // ─── AWS::ApiGateway::Method ────────────────────────────────────────

  it('Method readCurrentState (NONE auth): AuthorizerId is NOT emitted (Class 1 guard)', async () => {
    // Class 1: AuthorizerId is only valid when AuthorizationType is
    // CUSTOM or COGNITO_USER_POOLS. Emitting `''` on a NONE method
    // would make `cdkd drift --revert`'s round-trip push an invalid
    // input back to PutMethod (AWS rejects with "Invalid authorizer
    // ID specified"). The guard prevents the placeholder from ever
    // landing in observedProperties.
    mockSend.mockResolvedValueOnce({
      httpMethod: 'GET',
      authorizationType: 'NONE',
      methodIntegration: { type: 'AWS_PROXY', uri: 'arn:aws:lambda:...' },
    });

    const observed = await provider.readCurrentState(
      'api-1|res-1|GET',
      'MethodLogical',
      'AWS::ApiGateway::Method'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetMethodCommand);
    expect(observed).toBeDefined();
    expect(observed).not.toHaveProperty('AuthorizerId');
    // Sanity: AuthorizationScopes (COGNITO_USER_POOLS-only Class 1
    // sibling) also not emitted.
    expect(observed).not.toHaveProperty('AuthorizationScopes');
  });

  it('Method readCurrentState (COGNITO auth): AuthorizerId IS emitted (Class 1 discriminator true)', async () => {
    // Complement of the NONE test: a COGNITO_USER_POOLS method
    // legitimately has AuthorizerId, and readCurrentState must emit
    // it so drift can detect a console-side change.
    mockSend.mockResolvedValueOnce({
      httpMethod: 'POST',
      authorizationType: 'COGNITO_USER_POOLS',
      authorizerId: 'auth-xyz',
      methodIntegration: { type: 'AWS_PROXY', uri: 'arn:aws:lambda:...' },
    });

    const observed = await provider.readCurrentState(
      'api-1|res-1|POST',
      'MethodLogical',
      'AWS::ApiGateway::Method'
    );

    expect(observed).toMatchObject({
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: 'auth-xyz',
    });
  });

  it('Method update() throws ResourceUpdateNotSupportedError cleanly (immutable type)', async () => {
    // Per CLAUDE.md (PR I): Method.update is intentionally
    // ResourceUpdateNotSupportedError — UpdateMethod's patch-operation
    // builder is not yet plumbed through. This test fails CI if a
    // future refactor accidentally turns it into a silent no-op
    // again. It also documents the round-trip safety guarantee for
    // Class 2 placeholders on Method (Integration: {} /
    // MethodResponses: {}): drift --revert never reaches AWS for this
    // type, so the structurally-invalid empty-object placeholders
    // can't surface as AWS rejections.
    const observed = {
      RestApiId: 'api-1',
      ResourceId: 'res-1',
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
      Integration: {} as Record<string, unknown>,
      MethodResponses: {} as Record<string, unknown>,
    };

    await expect(
      provider.update('MethodLogical', 'api-1|res-1|GET', 'AWS::ApiGateway::Method', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    // No PutMethod / UpdateMethod / Get* call should have happened.
    expect(mockSend).not.toHaveBeenCalled();
    const putMethodCalls = mockSend.mock.calls.filter((c) => c[0] instanceof PutMethodCommand);
    expect(putMethodCalls).toHaveLength(0);
  });

  // ─── Other immutable-update sub-resources (parity with Method) ──────

  it('Authorizer / Deployment update() throw ResourceUpdateNotSupportedError', async () => {
    // Same structural guarantee: drift --revert can never reach AWS
    // with a malformed input for these types because update() rejects
    // before any SDK call.
    await expect(
      provider.update('A', 'auth-1', 'AWS::ApiGateway::Authorizer', {}, {})
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    await expect(
      provider.update('D', 'dep-1', 'AWS::ApiGateway::Deployment', {}, {})
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    expect(mockSend).not.toHaveBeenCalled();
  });
});
