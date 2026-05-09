import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetMethodCommand,
  GetAccountCommand,
  UpdateAccountCommand,
  PutMethodCommand,
  UpdateAuthorizerCommand,
  UpdateMethodCommand,
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

  it('Method update() emits replace patches for changed primitive fields', async () => {
    // AuthorizationType / AuthorizerId / ApiKeyRequired / OperationName /
    // RequestValidatorId all change → one `replace` op each, only for
    // changed fields (no patch op for unchanged fields).
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'MethodLogical',
      'api-1|res-1|GET',
      'AWS::ApiGateway::Method',
      {
        RestApiId: 'api-1',
        ResourceId: 'res-1',
        HttpMethod: 'GET',
        AuthorizationType: 'COGNITO_USER_POOLS',
        AuthorizerId: 'auth-new',
        ApiKeyRequired: true,
        OperationName: 'getThing',
        RequestValidatorId: 'val-1',
      },
      {
        RestApiId: 'api-1',
        ResourceId: 'res-1',
        HttpMethod: 'GET',
        AuthorizationType: 'NONE',
        AuthorizerId: undefined,
        ApiKeyRequired: false,
        OperationName: undefined,
        RequestValidatorId: undefined,
      }
    );

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateMethodCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as {
      restApiId: string;
      resourceId: string;
      httpMethod: string;
      patchOperations: Array<{ op: string; path: string; value?: string }>;
    };
    expect(input.restApiId).toBe('api-1');
    expect(input.resourceId).toBe('res-1');
    expect(input.httpMethod).toBe('GET');
    expect(input.patchOperations).toEqual(
      expect.arrayContaining([
        { op: 'replace', path: '/authorizationType', value: 'COGNITO_USER_POOLS' },
        { op: 'replace', path: '/authorizerId', value: 'auth-new' },
        { op: 'replace', path: '/apiKeyRequired', value: 'true' },
        { op: 'replace', path: '/operationName', value: 'getThing' },
        { op: 'replace', path: '/requestValidatorId', value: 'val-1' },
      ])
    );
    expect(input.patchOperations).toHaveLength(5);
  });

  it('Method update() ApiKeyRequired=false reaches AWS as a real replace (not-truthy gate)', async () => {
    // The `!== undefined` gate is load-bearing: a console-side toggle
    // from `ApiKeyRequired: true` back to `false` MUST surface as
    // `replace /apiKeyRequired false` on revert, otherwise the
    // round-trip is a silent no-op and the next drift run re-detects
    // the same divergence forever.
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'MethodLogical',
      'api-1|res-1|GET',
      'AWS::ApiGateway::Method',
      { ApiKeyRequired: false },
      { ApiKeyRequired: true }
    );

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateMethodCommand);
    const input = updateCall![0].input as {
      patchOperations: Array<{ op: string; path: string; value?: string }>;
    };
    expect(input.patchOperations).toEqual([
      { op: 'replace', path: '/apiKeyRequired', value: 'false' },
    ]);
  });

  it('Method update() emits per-key add / remove / replace ops on RequestParameters', async () => {
    // Map-shaped property: each diffed key gets its own JSON Pointer
    // patch op. Unchanged keys produce no op.
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'MethodLogical',
      'api-1|res-1|GET',
      'AWS::ApiGateway::Method',
      {
        RequestParameters: {
          'method.request.querystring.foo': true, // added
          'method.request.querystring.bar': false, // changed (was true)
          'method.request.header.keep': true, // unchanged
        },
      },
      {
        RequestParameters: {
          'method.request.querystring.bar': true,
          'method.request.header.keep': true,
          'method.request.querystring.gone': true, // removed
        },
      }
    );

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateMethodCommand);
    const input = updateCall![0].input as {
      patchOperations: Array<{ op: string; path: string; value?: string }>;
    };
    expect(input.patchOperations).toEqual(
      expect.arrayContaining([
        { op: 'add', path: '/requestParameters/method.request.querystring.foo', value: 'true' },
        {
          op: 'replace',
          path: '/requestParameters/method.request.querystring.bar',
          value: 'false',
        },
        { op: 'remove', path: '/requestParameters/method.request.querystring.gone' },
      ])
    );
    expect(input.patchOperations).toHaveLength(3);
  });

  it('Method update() escapes "/" in RequestModels content-type keys per RFC 6901', async () => {
    // The `application/json` content-type key MUST be escaped to
    // `application~1json` in the JSON Pointer path or AWS rejects the
    // patch op as a malformed path.
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'MethodLogical',
      'api-1|res-1|POST',
      'AWS::ApiGateway::Method',
      { RequestModels: { 'application/json': 'MyModel' } },
      {}
    );

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateMethodCommand);
    const input = updateCall![0].input as {
      patchOperations: Array<{ op: string; path: string; value?: string }>;
    };
    expect(input.patchOperations).toEqual([
      { op: 'add', path: '/requestModels/application~1json', value: 'MyModel' },
    ]);
  });

  it('Method update() with no diff sends no UpdateMethodCommand', async () => {
    // The drift --revert "no real change" round-trip case: if state
    // already matches AWS (or the only diffs are on Integration /
    // MethodResponses, which updateMethod intentionally ignores), no
    // SDK call should fire.
    const same = {
      RestApiId: 'api-1',
      ResourceId: 'res-1',
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
      Integration: {} as Record<string, unknown>,
      MethodResponses: {} as Record<string, unknown>,
    };

    await provider.update(
      'MethodLogical',
      'api-1|res-1|GET',
      'AWS::ApiGateway::Method',
      same,
      same
    );

    expect(mockSend).not.toHaveBeenCalled();
    const putMethodCalls = mockSend.mock.calls.filter((c) => c[0] instanceof PutMethodCommand);
    expect(putMethodCalls).toHaveLength(0);
  });

  // ─── AWS::ApiGateway::Authorizer ─────────────────────────────────────

  it('Authorizer update() emits replace patches for changed primitive fields', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGateway::Authorizer',
      {
        RestApiId: 'api-1',
        Name: 'AuthV2',
        AuthorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/v2',
        AuthorizerCredentials: 'arn:aws:iam::123:role/v2',
        IdentitySource: 'method.request.header.AuthorizationV2',
        IdentityValidationExpression: '^Bearer ',
        AuthorizerResultTtlInSeconds: 600,
      },
      {
        RestApiId: 'api-1',
        Name: 'AuthV1',
        AuthorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/v1',
        AuthorizerCredentials: 'arn:aws:iam::123:role/v1',
        IdentitySource: 'method.request.header.Authorization',
        IdentityValidationExpression: '',
        AuthorizerResultTtlInSeconds: 300,
      }
    );

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateAuthorizerCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as {
      restApiId: string;
      authorizerId: string;
      patchOperations: Array<{ op: string; path: string; value?: string }>;
    };
    expect(input.restApiId).toBe('api-1');
    expect(input.authorizerId).toBe('auth-1');
    expect(input.patchOperations).toEqual(
      expect.arrayContaining([
        { op: 'replace', path: '/name', value: 'AuthV2' },
        { op: 'replace', path: '/authorizerUri', value: 'arn:aws:apigateway:us-east-1:lambda:path/v2' },
        { op: 'replace', path: '/authorizerCredentials', value: 'arn:aws:iam::123:role/v2' },
        { op: 'replace', path: '/identitySource', value: 'method.request.header.AuthorizationV2' },
        { op: 'replace', path: '/identityValidationExpression', value: '^Bearer ' },
        { op: 'replace', path: '/authorizerResultTtlInSeconds', value: '600' },
      ])
    );
    expect(input.patchOperations).toHaveLength(6);
  });

  it('Authorizer update() empty IdentitySource placeholder reaches AWS as real clear-patch (not-truthy gate)', async () => {
    // Same not-truthy gate guarantee as Account.CloudWatchRoleArn: an
    // empty placeholder coming from readCurrentStateAuthorizer must
    // round-trip as `replace /identitySource ''`, otherwise drift
    // --revert silently fails to clear a console-side change.
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGateway::Authorizer',
      { RestApiId: 'api-1', IdentitySource: '' },
      { RestApiId: 'api-1', IdentitySource: 'method.request.header.Authorization' }
    );

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateAuthorizerCommand);
    const input = updateCall![0].input as {
      patchOperations: Array<{ op: string; path: string; value?: string }>;
    };
    expect(input.patchOperations).toEqual([
      { op: 'replace', path: '/identitySource', value: '' },
    ]);
  });

  it('Authorizer update() ProviderARNs diff emits comma-joined replace patch', async () => {
    // AWS PATCH wire format for /providerARNs is a single comma-joined
    // string. cdkd state holds the array form; the update() path joins
    // before emitting the op.
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGateway::Authorizer',
      {
        RestApiId: 'api-1',
        ProviderARNs: [
          'arn:aws:cognito-idp:us-east-1:123:userpool/pool-A',
          'arn:aws:cognito-idp:us-east-1:123:userpool/pool-B',
        ],
      },
      {
        RestApiId: 'api-1',
        ProviderARNs: ['arn:aws:cognito-idp:us-east-1:123:userpool/pool-A'],
      }
    );

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateAuthorizerCommand);
    const input = updateCall![0].input as {
      patchOperations: Array<{ op: string; path: string; value?: string }>;
    };
    expect(input.patchOperations).toEqual([
      {
        op: 'replace',
        path: '/providerARNs',
        value:
          'arn:aws:cognito-idp:us-east-1:123:userpool/pool-A,arn:aws:cognito-idp:us-east-1:123:userpool/pool-B',
      },
    ]);
  });

  it('Authorizer update() with no diff sends no UpdateAuthorizerCommand', async () => {
    const same = {
      RestApiId: 'api-1',
      Name: 'Auth',
      Type: 'COGNITO_USER_POOLS',
      ProviderARNs: ['arn:aws:cognito-idp:us-east-1:123:userpool/pool-A'],
      IdentitySource: 'method.request.header.Authorization',
    };

    await provider.update('AuthLogical', 'auth-1', 'AWS::ApiGateway::Authorizer', same, same);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Authorizer update() throws ProvisioningError when RestApiId is missing', async () => {
    await expect(
      provider.update(
        'AuthLogical',
        'auth-1',
        'AWS::ApiGateway::Authorizer',
        { Name: 'Auth' },
        { Name: 'OldAuth' }
      )
    ).rejects.toThrow(/RestApiId is required/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Other immutable-update sub-resources (parity with Method) ──────

  it('Deployment update() throws ResourceUpdateNotSupportedError', async () => {
    // Deployment.update is still intentionally
    // ResourceUpdateNotSupportedError — UpdateDeployment's patch-op
    // surface is narrow and not yet plumbed.
    await expect(
      provider.update('D', 'dep-1', 'AWS::ApiGateway::Deployment', {}, {})
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    expect(mockSend).not.toHaveBeenCalled();
  });
});
