import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  UpdateApiCommand,
  UpdateStageCommand,
  UpdateIntegrationCommand,
  UpdateRouteCommand,
  UpdateAuthorizerCommand,
  DeleteCorsConfigurationCommand,
  DeleteRouteRequestParameterCommand,
  GetIntegrationCommand,
} from '@aws-sdk/client-apigatewayv2';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ApiGatewayV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { ApiGatewayV2Provider } from '../../../src/provisioning/providers/apigatewayv2-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { getLogger } from '../../../src/utils/logger.js';

const API_ID = 'abcd1234';

/**
 * Read-update round-trip test (docs/provider-rules.md#readcurrentstate-for-drift-detection).
 *
 * Every AWS::ApiGatewayV2::* type now has an in-place update path via
 * its matching `Update*Command`. The tests below cover, per type:
 *   - primitive field replace (only diffed fields surface in input)
 *   - no-diff no-op (zero SDK calls when state == AWS-current)
 *   - immutable-only-diff (ProtocolType / StageName / ApiId) still
 *     rejects with `ResourceUpdateNotSupportedError`
 *   - existing Class 1 / Class 2 readCurrentState shape guards (kept
 *     from the pre-PR test file).
 */
describe('ApiGatewayV2Provider read-update round-trip', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ApiGatewayV2Provider();
  });

  // ─── readCurrentState shape guards (Class 1 / Class 2) ────────────

  it('Class 1 — Api HTTP no-drift snapshot includes CorsConfiguration but excludes WEBSOCKET-only fields', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: API_ID,
      Name: 'my-http-api',
      ProtocolType: 'HTTP',
      Description: 'an http api',
      CorsConfiguration: { AllowOrigins: ['*'] },
      RouteSelectionExpression: '$request.method $request.path',
      Tags: { Foo: 'Bar' },
    });

    const observed = (await provider.readCurrentState(
      API_ID,
      'ApiLogical',
      'AWS::ApiGatewayV2::Api'
    )) as Record<string, unknown> | undefined;

    expect(observed).toBeDefined();
    expect(observed!['CorsConfiguration']).toEqual({ AllowOrigins: ['*'] });
    expect(observed!).not.toHaveProperty('RouteSelectionExpression');
  });

  it('Class 1 — Api WEBSOCKET no-drift snapshot preserves RouteSelectionExpression but excludes CorsConfiguration', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: API_ID,
      Name: 'my-ws-api',
      ProtocolType: 'WEBSOCKET',
      Description: 'a websocket api',
      RouteSelectionExpression: '$request.body.action',
    });

    const observed = (await provider.readCurrentState(
      API_ID,
      'ApiLogical',
      'AWS::ApiGatewayV2::Api'
    )) as Record<string, unknown> | undefined;

    expect(observed).toBeDefined();
    expect(observed!).not.toHaveProperty('CorsConfiguration');
    expect(observed!['RouteSelectionExpression']).toBe('$request.body.action');
  });

  it('Class 1 — Authorizer JWT no-drift snapshot preserves JwtConfiguration and excludes REQUEST-only fields', async () => {
    mockSend.mockResolvedValueOnce({
      AuthorizerId: 'auth-jwt',
      AuthorizerType: 'JWT',
      Name: 'my-jwt-authorizer',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Audience: ['client-id'], Issuer: 'https://issuer.example.com' },
    });

    const observed = (await provider.readCurrentState(
      'auth-jwt',
      'AuthorizerLogical',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID }
    )) as Record<string, unknown> | undefined;

    expect(observed).toBeDefined();
    expect(observed!['JwtConfiguration']).toEqual({
      Audience: ['client-id'],
      Issuer: 'https://issuer.example.com',
    });
    expect(observed!).not.toHaveProperty('AuthorizerUri');
    expect(observed!).not.toHaveProperty('AuthorizerPayloadFormatVersion');
  });

  it('Class 1 — Authorizer REQUEST no-drift snapshot preserves AuthorizerUri and excludes JwtConfiguration', async () => {
    mockSend.mockResolvedValueOnce({
      AuthorizerId: 'auth-req',
      AuthorizerType: 'REQUEST',
      Name: 'my-request-authorizer',
      IdentitySource: ['$request.header.Authorization'],
      AuthorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/...',
      AuthorizerPayloadFormatVersion: '2.0',
    });

    const observed = (await provider.readCurrentState(
      'auth-req',
      'AuthorizerLogical',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID }
    )) as Record<string, unknown> | undefined;

    expect(observed).toBeDefined();
    expect(observed!['AuthorizerUri']).toBe(
      'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/...'
    );
    expect(observed!['AuthorizerPayloadFormatVersion']).toBe('2.0');
    expect(observed!).not.toHaveProperty('JwtConfiguration');
  });

  it('Class 1 — Integration MOCK no-drift snapshot excludes IntegrationUri', async () => {
    mockSend.mockResolvedValueOnce({
      IntegrationId: 'int-mock',
      IntegrationType: 'MOCK',
    });

    const observed = (await provider.readCurrentState(
      'int-mock',
      'IntegrationLogical',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID }
    )) as Record<string, unknown> | undefined;

    expect(observed).toBeDefined();
    expect(observed!).not.toHaveProperty('IntegrationUri');
    expect(observed!['IntegrationType']).toBe('MOCK');
  });

  it('Class 1 — Integration AWS_PROXY no-drift snapshot includes IntegrationUri', async () => {
    mockSend.mockResolvedValueOnce({
      IntegrationId: 'int-lambda',
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:us-east-1:123:function:my-fn',
      IntegrationMethod: 'POST',
      PayloadFormatVersion: '2.0',
    });

    const observed = (await provider.readCurrentState(
      'int-lambda',
      'IntegrationLogical',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID }
    )) as Record<string, unknown> | undefined;

    expect(observed).toBeDefined();
    expect(observed!['IntegrationUri']).toBe('arn:aws:lambda:us-east-1:123:function:my-fn');
  });

  it('Class 2 — Route NONE-auth no-drift snapshot uses AuthorizationType=NONE and excludes AuthorizerId/AuthorizationScopes', async () => {
    mockSend.mockResolvedValueOnce({
      RouteId: 'route-none',
      RouteKey: 'GET /pets',
      Target: 'integrations/int-1',
    });

    const observed = (await provider.readCurrentState(
      'route-none',
      'RouteLogical',
      'AWS::ApiGatewayV2::Route',
      { ApiId: API_ID }
    )) as Record<string, unknown> | undefined;

    expect(observed).toBeDefined();
    expect(observed!['AuthorizationType']).toBe('NONE');
    expect(observed!).not.toHaveProperty('AuthorizerId');
    expect(observed!).not.toHaveProperty('AuthorizationScopes');
  });

  it('Class 1 — Route JWT-auth no-drift snapshot includes AuthorizerId and AuthorizationScopes', async () => {
    mockSend.mockResolvedValueOnce({
      RouteId: 'route-jwt',
      RouteKey: 'GET /pets',
      Target: 'integrations/int-1',
      AuthorizationType: 'JWT',
      AuthorizerId: 'auth-1',
      AuthorizationScopes: ['scope-a', 'scope-b'],
    });

    const observed = (await provider.readCurrentState(
      'route-jwt',
      'RouteLogical',
      'AWS::ApiGatewayV2::Route',
      { ApiId: API_ID }
    )) as Record<string, unknown> | undefined;

    expect(observed).toBeDefined();
    expect(observed!['AuthorizationType']).toBe('JWT');
    expect(observed!['AuthorizerId']).toBe('auth-1');
    expect(observed!['AuthorizationScopes']).toEqual(['scope-a', 'scope-b']);
  });

  // ─── Api update ───────────────────────────────────────────────────

  it('Api update(): primitive Name/Description change emits UpdateApi with only diffed fields', async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { Name: 'new-name', Description: 'new-desc', ProtocolType: 'HTTP' },
      { Name: 'old-name', Description: 'old-desc', ProtocolType: 'HTTP' }
    );

    expect(result).toEqual({ physicalId: API_ID, wasReplaced: false });
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateApiCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      Name: 'new-name',
      Description: 'new-desc',
    });
  });

  it('Api update(): CorsConfiguration object change is sent via UpdateApi', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { CorsConfiguration: { AllowOrigins: ['*'] }, ProtocolType: 'HTTP' },
      { CorsConfiguration: { AllowOrigins: ['https://x'] }, ProtocolType: 'HTTP' }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateApiCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input['CorsConfiguration']).toEqual({ AllowOrigins: ['*'] });
  });

  it('Api update(): no diff produces zero SDK calls', async () => {
    const same = {
      Name: 'same',
      Description: 'same-desc',
      ProtocolType: 'HTTP',
      CorsConfiguration: { AllowOrigins: ['*'] },
    };

    const result = await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      same,
      same
    );

    expect(result).toEqual({ physicalId: API_ID, wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Api update(): ProtocolType-only diff rejects with ResourceUpdateNotSupportedError (immutable)', async () => {
    await expect(
      provider.update(
        'ApiLogical',
        API_ID,
        'AWS::ApiGatewayV2::Api',
        { Name: 'same', ProtocolType: 'WEBSOCKET' },
        { Name: 'same', ProtocolType: 'HTTP' }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Stage update ─────────────────────────────────────────────────

  it('Stage update(): AutoDeploy/Description change emits UpdateStage', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'StageLogical',
      '$default',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID, StageName: '$default', AutoDeploy: true, Description: 'new' },
      { ApiId: API_ID, StageName: '$default', AutoDeploy: false, Description: 'old' }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateStageCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      StageName: '$default',
      AutoDeploy: true,
      Description: 'new',
    });
  });

  it('Stage update(): AutoDeploy=false change reaches AWS as a real replace (not-truthy gate)', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'StageLogical',
      '$default',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID, StageName: '$default', AutoDeploy: false },
      { ApiId: API_ID, StageName: '$default', AutoDeploy: true }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateStageCommand);
    const input = call![0].input as Record<string, unknown>;
    expect(input['AutoDeploy']).toBe(false);
  });

  it('Stage update(): no diff produces zero SDK calls', async () => {
    const same = { ApiId: API_ID, StageName: '$default', AutoDeploy: true, Description: 'd' };
    await provider.update('StageLogical', '$default', 'AWS::ApiGatewayV2::Stage', same, same);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Stage update(): StageName-only diff rejects with ResourceUpdateNotSupportedError (immutable)', async () => {
    await expect(
      provider.update(
        'StageLogical',
        '$default',
        'AWS::ApiGatewayV2::Stage',
        { ApiId: API_ID, StageName: 'prod', AutoDeploy: true },
        { ApiId: API_ID, StageName: '$default', AutoDeploy: true }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Integration update ───────────────────────────────────────────

  it('Integration update(): IntegrationUri/Method/PayloadFormatVersion change emits UpdateIntegration', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      {
        ApiId: API_ID,
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: 'arn:aws:lambda:::function:new',
        IntegrationMethod: 'POST',
        PayloadFormatVersion: '2.0',
      },
      {
        ApiId: API_ID,
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: 'arn:aws:lambda:::function:old',
        IntegrationMethod: 'GET',
        PayloadFormatVersion: '1.0',
      }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateIntegrationCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      IntegrationId: 'int-1',
      IntegrationUri: 'arn:aws:lambda:::function:new',
      IntegrationMethod: 'POST',
      PayloadFormatVersion: '2.0',
    });
  });

  it('Integration update(): no diff produces zero SDK calls', async () => {
    const same = {
      ApiId: API_ID,
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:::function:f',
      IntegrationMethod: 'POST',
      PayloadFormatVersion: '2.0',
    };
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      same,
      same
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Integration update(): ApiId-only diff rejects with ResourceUpdateNotSupportedError (immutable)', async () => {
    await expect(
      provider.update(
        'IntLogical',
        'int-1',
        'AWS::ApiGatewayV2::Integration',
        { ApiId: 'other-api', IntegrationType: 'AWS_PROXY' },
        { ApiId: API_ID, IntegrationType: 'AWS_PROXY' }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Route update ─────────────────────────────────────────────────

  it('Route update(): Target/RouteKey/AuthorizationType/AuthorizerId/Scopes change emits UpdateRoute', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'RouteLogical',
      'route-1',
      'AWS::ApiGatewayV2::Route',
      {
        ApiId: API_ID,
        RouteKey: 'POST /things',
        Target: 'integrations/new',
        AuthorizationType: 'JWT',
        AuthorizerId: 'auth-new',
        AuthorizationScopes: ['scope-a'],
      },
      {
        ApiId: API_ID,
        RouteKey: 'GET /things',
        Target: 'integrations/old',
        AuthorizationType: 'NONE',
        AuthorizerId: undefined,
        AuthorizationScopes: undefined,
      }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateRouteCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      RouteId: 'route-1',
      RouteKey: 'POST /things',
      Target: 'integrations/new',
      AuthorizationType: 'JWT',
      AuthorizerId: 'auth-new',
      AuthorizationScopes: ['scope-a'],
    });
  });

  it('Route update(): no diff produces zero SDK calls', async () => {
    const same = {
      ApiId: API_ID,
      RouteKey: 'GET /pets',
      Target: 'integrations/i-1',
      AuthorizationType: 'NONE',
    };
    await provider.update('RouteLogical', 'route-1', 'AWS::ApiGatewayV2::Route', same, same);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Route update(): ApiId-only diff rejects with ResourceUpdateNotSupportedError (immutable)', async () => {
    await expect(
      provider.update(
        'RouteLogical',
        'route-1',
        'AWS::ApiGatewayV2::Route',
        { ApiId: 'other', RouteKey: 'GET /' },
        { ApiId: API_ID, RouteKey: 'GET /' }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Authorizer update ────────────────────────────────────────────

  it('Authorizer update(): primitive + JwtConfiguration change emits UpdateAuthorizer', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      {
        ApiId: API_ID,
        AuthorizerType: 'JWT',
        Name: 'new-name',
        IdentitySource: ['$request.header.Auth'],
        JwtConfiguration: { Audience: ['c'], Issuer: 'https://i' },
      },
      {
        ApiId: API_ID,
        AuthorizerType: 'JWT',
        Name: 'old-name',
        IdentitySource: ['$request.header.Old'],
        JwtConfiguration: { Audience: ['c'], Issuer: 'https://old' },
      }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateAuthorizerCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      AuthorizerId: 'auth-1',
      Name: 'new-name',
      IdentitySource: ['$request.header.Auth'],
      JwtConfiguration: { Audience: ['c'], Issuer: 'https://i' },
    });
  });

  it('Authorizer update(): IdentitySource accepts string and array forms (CFn legacy parity)', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      {
        ApiId: API_ID,
        AuthorizerType: 'REQUEST',
        Name: 'a',
        IdentitySource: '$request.header.A', // string-form
        AuthorizerUri: 'arn:aws:apigateway:::lambda:path/...',
        AuthorizerPayloadFormatVersion: '2.0',
      },
      {
        ApiId: API_ID,
        AuthorizerType: 'REQUEST',
        Name: 'a',
        IdentitySource: ['$request.header.B'],
        AuthorizerUri: 'arn:aws:apigateway:::lambda:path/...',
        AuthorizerPayloadFormatVersion: '2.0',
      }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateAuthorizerCommand);
    const input = call![0].input as Record<string, unknown>;
    expect(input['IdentitySource']).toEqual(['$request.header.A']);
  });

  it('Authorizer update(): no diff produces zero SDK calls', async () => {
    const same = {
      ApiId: API_ID,
      AuthorizerType: 'JWT',
      Name: 'a',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Audience: ['c'], Issuer: 'https://i' },
    };
    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      same,
      same
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Authorizer update(): ApiId-only diff rejects with ResourceUpdateNotSupportedError (immutable)', async () => {
    await expect(
      provider.update(
        'AuthLogical',
        'auth-1',
        'AWS::ApiGatewayV2::Authorizer',
        { ApiId: 'other', AuthorizerType: 'JWT', Name: 'a' },
        { ApiId: API_ID, AuthorizerType: 'JWT', Name: 'a' }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Unsupported sub-types still reject ───────────────────────────

  it('Unsupported resource type rejects update() with ResourceUpdateNotSupportedError', async () => {
    await expect(
      provider.update('L', 'phys', 'AWS::ApiGatewayV2::DomainName', {}, {})
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

/**
 * Removal-reset coverage (issue #1160 — the absent-field removal
 * silent-drop bug class; reference fix `LambdaFunctionProvider`, #1157).
 *
 * The API Gateway V2 `Update*` APIs merge (an absent field = "no change"),
 * so a field DROPPED from the template must be sent with an explicit reset
 * value or AWS silently keeps the old one while CloudFormation resets it to
 * the property default. Reset values were live-probed against real AWS
 * (2026-07-22). Each clearable field gets the #1157 trio: removed -> reset,
 * never-present -> absent, mixed -> kept fields pass through + removed reset.
 * Fields that the API rejects a reset for (required per protocol/authorizer
 * type, or merge-only maps/objects) are asserted to be left untouched.
 *
 * #5004 (real CloudFormation A/B): CloudFormation RESETS only Api
 * CorsConfiguration, Stage AutoDeploy / AccessLogSettings / RouteSettings and
 * Route AuthorizationScopes; it KEEPS every other removable property, so those
 * assert that NO reset is sent.
 */
describe('ApiGatewayV2Provider update() removal semantics (#1160, #5004)', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations, so a test that sets one with
    // mockImplementation would leak it into the next test on a failed assertion.
    mockSend.mockReset();
    provider = new ApiGatewayV2Provider();
  });

  function updateApiInput() {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateApiCommand);
    return call ? (call[0].input as Record<string, unknown>) : undefined;
  }
  function updateStageInput() {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateStageCommand);
    return call ? (call[0].input as Record<string, unknown>) : undefined;
  }
  function updateIntegrationInput() {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateIntegrationCommand);
    return call ? (call[0].input as Record<string, unknown>) : undefined;
  }
  function updateRouteInput() {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateRouteCommand);
    return call ? (call[0].input as Record<string, unknown>) : undefined;
  }
  function updateAuthorizerInput() {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateAuthorizerCommand);
    return call ? (call[0].input as Record<string, unknown>) : undefined;
  }

  // ─── Api ──────────────────────────────────────────────────────────

  it('Api: removed Description/Version/DisableExecuteApiEndpoint/IpAddressType are KEPT — no SDK call (#5004)', async () => {
    // Real CloudFormation A/B (#5004): CloudFormation leaves the live value, so
    // cdkd sends nothing. Restoring the old reset ('' / false / ipv4) makes
    // UpdateApi fire and fails this test.
    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'HTTP' },
      {
        ProtocolType: 'HTTP',
        Description: 'old',
        Version: 'v1',
        DisableExecuteApiEndpoint: true,
        IpAddressType: 'dualstack',
      }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Api: fields never present produce no reset (zero SDK calls)', async () => {
    const same = { ProtocolType: 'HTTP', Name: 'n' };
    await provider.update('ApiLogical', API_ID, 'AWS::ApiGatewayV2::Api', same, same);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Api: mixed — Name changes, Description removed is NOT sent (#5004)', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'HTTP', Name: 'new' },
      { ProtocolType: 'HTTP', Name: 'old', Description: 'old-desc' }
    );
    expect(updateApiInput()).toEqual({ ApiId: API_ID, Name: 'new' });
  });

  it('Api: removed CorsConfiguration is cleared via DeleteCorsConfiguration, not UpdateApi', async () => {
    mockSend.mockResolvedValue({});
    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'HTTP' },
      { ProtocolType: 'HTTP', CorsConfiguration: { AllowOrigins: ['*'] } }
    );
    const corsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof DeleteCorsConfigurationCommand
    );
    expect(corsCall).toBeDefined();
    expect(corsCall![0].input).toEqual({ ApiId: API_ID });
    // No UpdateApi call when Cors removal is the only change.
    expect(updateApiInput()).toBeUndefined();
  });

  it('Api: Cors removal still resets (CFn RESETS, #5004) while a removed Description sends nothing', async () => {
    mockSend.mockResolvedValue({});
    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'HTTP' },
      { ProtocolType: 'HTTP', Description: 'old', CorsConfiguration: { AllowOrigins: ['*'] } }
    );
    expect(updateApiInput()).toBeUndefined();
    expect(
      mockSend.mock.calls.some((c) => c[0] instanceof DeleteCorsConfigurationCommand)
    ).toBe(true);
  });

  it('Api: removed ApiKeySelectionExpression is KEPT — no SDK call (#5004)', async () => {
    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'WEBSOCKET' },
      { ProtocolType: 'WEBSOCKET', ApiKeySelectionExpression: '$request.querystring.apikey' }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Api: removed RouteSelectionExpression is NOT reset (required/fixed) — no SDK call', async () => {
    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'WEBSOCKET' },
      { ProtocolType: 'WEBSOCKET', RouteSelectionExpression: '$request.body.action' }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Stage ────────────────────────────────────────────────────────

  it('Stage: removed AutoDeploy resets to false (CFn RESETS, #5004); removed StageVariables and ClientCertificateId are KEPT', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'StageLogical',
      '$default',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID, StageName: '$default' },
      {
        ApiId: API_ID,
        StageName: '$default',
        AutoDeploy: true,
        StageVariables: { a: '1', b: '2' },
        ClientCertificateId: 'cert-1',
      }
    );
    expect(updateStageInput()).toEqual({
      ApiId: API_ID,
      StageName: '$default',
      AutoDeploy: false,
    });
  });

  it('Stage: dropping StageVariables keys (whole block or one key) sends nothing (#5004)', async () => {
    // A dropped key stays live, as in CloudFormation. Restoring the '' per-key
    // clear makes UpdateStage fire and fails this test.
    await provider.update(
      'StageLogical',
      '$default',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID, StageName: '$default', StageVariables: { a: '1' } },
      { ApiId: API_ID, StageName: '$default', StageVariables: { a: '1', b: '2' } }
    );
    await provider.update(
      'StageLogical',
      '$default',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID, StageName: '$default' },
      { ApiId: API_ID, StageName: '$default', StageVariables: { constructor: 'old' } }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Stage: a changed StageVariables key is sent in full; the dropped key is not blanked (#5004)', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'StageLogical',
      '$default',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID, StageName: '$default', StageVariables: { a: '2' } },
      { ApiId: API_ID, StageName: '$default', StageVariables: { a: '1', b: '2' } }
    );
    expect(updateStageInput()!['StageVariables']).toEqual({ a: '2' });
  });

  it('Stage: removed Description is NOT reset (API keeps empty-string) — no SDK call', async () => {
    await provider.update(
      'StageLogical',
      '$default',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID, StageName: '$default' },
      { ApiId: API_ID, StageName: '$default', Description: 'old' }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Integration ──────────────────────────────────────────────────

  it('Integration: removed Description and RequestParameters (whole block or key) are KEPT — no SDK call (#5004)', async () => {
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID },
      { ApiId: API_ID, Description: 'old', RequestParameters: { 'append:header.x': 'y' } }
    );
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID, RequestParameters: { 'append:header.a': '1' } },
      { ApiId: API_ID, RequestParameters: { 'append:header.a': '1', 'append:header.b': '2' } }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Integration: a changed RequestParameters key is sent in full; the dropped key is not blanked (#5004)', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID, RequestParameters: { 'append:header.a': '2' } },
      { ApiId: API_ID, RequestParameters: { 'append:header.a': '1', 'append:header.b': '2' } }
    );
    expect(updateIntegrationInput()!['RequestParameters']).toEqual({ 'append:header.a': '2' });
  });

  it('Route: a changed RequestModels key is sent in full; the dropped key is not blanked (#5004)', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'RouteLogical',
      'r-1',
      'AWS::ApiGatewayV2::Route',
      { ApiId: API_ID, RouteKey: '$default', RequestModels: { 'application/json': 'B' } },
      {
        ApiId: API_ID,
        RouteKey: '$default',
        RequestModels: { 'application/json': 'A', 'text/plain': 'C' },
      }
    );
    expect(updateRouteInput()!['RequestModels']).toEqual({ 'application/json': 'B' });
  });

  it('Route: a changed RequestParameters key is sent in full and nothing is deleted (#5004)', async () => {
    mockSend.mockResolvedValue({});
    await provider.update(
      'RouteLogical',
      'r-1',
      'AWS::ApiGatewayV2::Route',
      {
        ApiId: API_ID,
        RouteKey: '$connect',
        RequestParameters: { 'route.request.header.A': { Required: false } },
      },
      {
        ApiId: API_ID,
        RouteKey: '$connect',
        RequestParameters: {
          'route.request.header.A': { Required: true },
          'route.request.header.B': { Required: true },
        },
      }
    );
    expect(updateRouteInput()!['RequestParameters']).toEqual({
      'route.request.header.A': { Required: false },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  // `cdkd drift --revert` replays the baseline over the AWS-current state with
  // `desiredFromAwsReadback: true`; it must still remove a console-added key.
  describe('drift --revert (desiredFromAwsReadback) still clears a console-added map key', () => {
    const revert = { desiredFromAwsReadback: true } as const;

    it('Stage StageVariables: the extra key is blanked', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'StageLogical',
        '$default',
        'AWS::ApiGatewayV2::Stage',
        { ApiId: API_ID, StageName: '$default', StageVariables: { a: '1' } },
        { ApiId: API_ID, StageName: '$default', StageVariables: { a: '1', b: '2' } },
        revert
      );
      expect(updateStageInput()!['StageVariables']).toEqual({ a: '1', b: '' });
    });

    it('Integration RequestParameters: the extra key is blanked', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'IntLogical',
        'int-1',
        'AWS::ApiGatewayV2::Integration',
        { ApiId: API_ID, RequestParameters: { 'append:header.a': '1' } },
        { ApiId: API_ID, RequestParameters: { 'append:header.a': '1', 'append:header.b': '2' } },
        revert
      );
      expect(updateIntegrationInput()!['RequestParameters']).toEqual({
        'append:header.a': '1',
        'append:header.b': '',
      });
    });

    it('Route RequestModels: the extra key is blanked', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'RouteLogical',
        'r-1',
        'AWS::ApiGatewayV2::Route',
        { ApiId: API_ID, RouteKey: '$default', RequestModels: { 'application/json': 'A' } },
        {
          ApiId: API_ID,
          RouteKey: '$default',
          RequestModels: { 'application/json': 'A', 'text/plain': 'C' },
        },
        revert
      );
      expect(updateRouteInput()!['RequestModels']).toEqual({
        'application/json': 'A',
        'text/plain': '',
      });
    });

    it('Route RequestParameters: the extra key is removed with DeleteRouteRequestParameter', async () => {
      mockSend.mockResolvedValue({});
      await provider.update(
        'RouteLogical',
        'r-1',
        'AWS::ApiGatewayV2::Route',
        {
          ApiId: API_ID,
          RouteKey: '$connect',
          RequestParameters: { 'route.request.header.A': { Required: true } },
        },
        {
          ApiId: API_ID,
          RouteKey: '$connect',
          RequestParameters: {
            'route.request.header.A': { Required: true },
            'route.request.header.B': { Required: true },
          },
        },
        revert
      );
      const deletes = mockSend.mock.calls
        .filter((c) => c[0] instanceof DeleteRouteRequestParameterCommand)
        .map((c) => c[0].input.RequestParameterKey);
      expect(deletes).toEqual(['route.request.header.B']);
    });

    it('Route RequestParameters: a delete-only revert sends no UpdateRoute, only the per-key delete', async () => {
      mockSend.mockResolvedValue({});
      await provider.update(
        'RouteLogical',
        'r-1',
        'AWS::ApiGatewayV2::Route',
        { ApiId: API_ID },
        {
          ApiId: API_ID,
          RequestParameters: {
            'route.request.header.A': { Required: true },
            'route.request.header.B': { Required: true },
          },
        },
        revert
      );
      expect(updateRouteInput()).toBeUndefined();
      const deletes = mockSend.mock.calls
        .filter((c) => c[0] instanceof DeleteRouteRequestParameterCommand)
        .map((c) => c[0].input.RequestParameterKey);
      expect(deletes).toEqual(['route.request.header.A', 'route.request.header.B']);
    });
  });

  it('Integration: removed IntegrationMethod is NOT reset (required) — no SDK call', async () => {
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID },
      { ApiId: API_ID, IntegrationMethod: 'GET' }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Route ────────────────────────────────────────────────────────

  it('Route: removed AuthorizationScopes resets to [] (CFn RESETS); AuthorizationType/AuthorizerId/OperationName are KEPT (#5004)', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'RouteLogical',
      'route-1',
      'AWS::ApiGatewayV2::Route',
      { ApiId: API_ID },
      {
        ApiId: API_ID,
        AuthorizationType: 'JWT',
        AuthorizerId: 'auth-1',
        AuthorizationScopes: ['s1'],
        OperationName: 'op',
      }
    );
    expect(updateRouteInput()).toEqual({
      ApiId: API_ID,
      RouteId: 'route-1',
      AuthorizationScopes: [],
    });
  });

  it('Route: no removable fields set on either side — zero SDK calls', async () => {
    const same = { ApiId: API_ID, RouteKey: 'GET /x', Target: 'integrations/int-1' };
    await provider.update('RouteLogical', 'route-1', 'AWS::ApiGatewayV2::Route', same, same);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Authorizer ───────────────────────────────────────────────────

  it('Authorizer: removed Ttl/CredentialsArn/PayloadFormatVersion/IdentityValidationExpression are KEPT — no SDK call (#5004)', async () => {
    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID },
      {
        ApiId: API_ID,
        AuthorizerResultTtlInSeconds: 300,
        AuthorizerCredentialsArn: 'arn:aws:iam::1:role/r',
        AuthorizerPayloadFormatVersion: '2.0',
        IdentityValidationExpression: '^x$',
      }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Authorizer: removed EnableSimpleResponses / AuthorizerUri / JwtConfiguration are KEPT — no SDK call (#1160 A/B)', async () => {
    // Real CloudFormation A/B (#1160): CloudFormation leaves each live value.
    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID, IdentitySource: ['$request.header.Authorization'] },
      {
        ApiId: API_ID,
        IdentitySource: ['$request.header.Authorization'],
        EnableSimpleResponses: true,
        AuthorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/fn',
        JwtConfiguration: { Audience: ['a'], Issuer: 'https://issuer' },
      }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Authorizer: a removed IdentitySource is cleared with [] (CFn CLEARS it, #1160 A/B)', async () => {
    // `UpdateAuthorizer` keeps an omitted IdentitySource; `[]` clears it, which
    // is what CloudFormation does (and what AWS refuses for a JWT authorizer).
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID },
      { ApiId: API_ID, IdentitySource: ['$request.header.Authorization'] }
    );
    expect(updateAuthorizerInput()).toEqual({
      ApiId: API_ID,
      AuthorizerId: 'auth-1',
      IdentitySource: [],
    });
  });

  it('Authorizer: the clear rides beside a declared change, and a never-set IdentitySource stays absent', async () => {
    mockSend.mockResolvedValue({});
    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID, Name: 'new' },
      { ApiId: API_ID, Name: 'old', IdentitySource: '$request.header.Authorization' }
    );
    expect(updateAuthorizerInput()).toEqual({
      ApiId: API_ID,
      AuthorizerId: 'auth-1',
      Name: 'new',
      IdentitySource: [],
    });
    mockSend.mockClear();
    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID, Name: 'new2' },
      { ApiId: API_ID, Name: 'new' }
    );
    expect(updateAuthorizerInput()).toEqual({ ApiId: API_ID, AuthorizerId: 'auth-1', Name: 'new2' });
  });

  it('Authorizer: a caller-injected [] is sent as is, and drift --revert injects nothing', async () => {
    // The caller already put `[]` in the bag (removedProperties is set), so the
    // provider must take the bag as is.
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID, IdentitySource: [] },
      { ApiId: API_ID, IdentitySource: ['$request.header.Authorization'] },
      { removedProperties: new Set(['IdentitySource']) }
    );
    expect(updateAuthorizerInput()!['IdentitySource']).toEqual([]);
    mockSend.mockClear();
    // drift --revert: the previous side is an AWS readback and removedProperties
    // is empty, so nothing reads as removed and nothing is sent.
    await provider.update(
      'AuthLogical',
      'auth-1',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID },
      { ApiId: API_ID, IdentitySource: ['$request.header.Authorization'] },
      { removedProperties: new Set(), desiredFromAwsReadback: true }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── #1160 A/B: Api / Stage / Integration / Route KEEP rows ────────

  it('Api: a removed RouteSelectionExpression is KEPT — no SDK call (#1160 A/B)', async () => {
    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'WEBSOCKET' },
      { ProtocolType: 'WEBSOCKET', RouteSelectionExpression: '$request.body.action' }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Stage: removed Description / DefaultRouteSettings are KEPT; beside a change only the change is sent (#1160 A/B)', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'StageLogical',
      'ab',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID, StageName: 'ab', StageVariables: { k: 'v2' } },
      {
        ApiId: API_ID,
        StageName: 'ab',
        StageVariables: { k: 'v1' },
        Description: 'd',
        DefaultRouteSettings: { ThrottlingBurstLimit: 100 },
      }
    );
    expect(updateStageInput()).toEqual({ ApiId: API_ID, StageName: 'ab', StageVariables: { k: 'v2' } });
  });

  it('Integration: removed URI / method / payload / timeout and the #609 fields are KEPT — no SDK call (#1160 A/B)', async () => {
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID, IntegrationType: 'HTTP_PROXY' },
      {
        ApiId: API_ID,
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://example.com',
        IntegrationMethod: 'GET',
        PayloadFormatVersion: '1.0',
        TimeoutInMillis: 5000,
        ConnectionType: 'VPC_LINK',
        ConnectionId: 'link-1',
        ContentHandlingStrategy: 'CONVERT_TO_TEXT',
        CredentialsArn: 'arn:aws:iam::1:role/r',
        PassthroughBehavior: 'NEVER',
        RequestTemplates: { $default: '{}' },
        ResponseParameters: { '404': { 'append:header.x': 'v' } },
        TemplateSelectionExpression: '\\$default',
        TlsConfig: { ServerNameToVerify: 'b.example.com' },
      }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Route: removed Target / ModelSelectionExpression / RouteResponseSelectionExpression are KEPT (#1160 A/B)', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'RouteLogical',
      'r-1',
      'AWS::ApiGatewayV2::Route',
      { ApiId: API_ID, RouteKey: '$default', OperationName: 'op2' },
      {
        ApiId: API_ID,
        RouteKey: '$default',
        OperationName: 'op1',
        Target: 'integrations/int-1',
        ModelSelectionExpression: '$request.body.model',
        RouteResponseSelectionExpression: '$default',
      }
    );
    expect(updateRouteInput()).toEqual({ ApiId: API_ID, RouteId: 'r-1', OperationName: 'op2' });
  });

  // ─── #1160 A/B: Integration IntegrationSubtype ─────────────────────

  const EVENTS_PARAMS = { Source: 's', DetailType: 'd', Detail: '$request.body' };
  const SERVICE_INTEGRATION = {
    ApiId: API_ID,
    IntegrationType: 'AWS_PROXY',
    IntegrationSubtype: 'EventBridge-PutEvents',
    CredentialsArn: 'arn:aws:iam::1:role/r',
    RequestParameters: EVENTS_PARAMS,
  };

  it('Integration: a removed IntegrationSubtype with no IntegrationUri is REFUSED before any call (CFn fails it)', async () => {
    const { IntegrationSubtype: _dropped, ...withoutSubtype } = SERVICE_INTEGRATION;
    for (const context of [undefined, { removedProperties: new Set(['IntegrationSubtype']) }]) {
      await expect(
        provider.update(
          'IntLogical',
          'int-1',
          'AWS::ApiGatewayV2::Integration',
          { ...withoutSubtype, Description: 'new' },
          SERVICE_INTEGRATION,
          context
        )
      ).rejects.toThrow(/the previous deploy recorded IntegrationSubtype and this template does not declare it\. CloudFormation fails that update/);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Integration: a removed IntegrationSubtype beside a declared IntegrationUri is sent WITHOUT the subtype', async () => {
    const { IntegrationSubtype: _dropped, RequestParameters: _rp, ...rest } = SERVICE_INTEGRATION;
    const lambdaUri = 'arn:aws:lambda:us-east-1:1:function:f';
    const cases: Array<[Record<string, unknown>, Record<string, unknown> | undefined]> = [
      [{ ...rest, IntegrationUri: lambdaUri, IntegrationMethod: 'POST' }, undefined],
      [
        { ...rest, IntegrationUri: lambdaUri, IntegrationMethod: 'POST' },
        { removedProperties: new Set(['IntegrationSubtype', 'RequestParameters']) },
      ],
      // RequestParameters still declared: nothing re-adds the subtype.
      [
        { ...rest, RequestParameters: EVENTS_PARAMS, IntegrationUri: lambdaUri },
        { removedProperties: new Set(['IntegrationSubtype']) },
      ],
      // A rollback replay whose record is URI-based restores that shape.
      [
        { ...rest, IntegrationUri: lambdaUri },
        { removedProperties: new Set(['IntegrationSubtype']), replayingState: true },
      ],
    ];
    for (const [desired, context] of cases) {
      mockSend.mockClear();
      mockSend.mockResolvedValueOnce({});
      const result = await provider.update(
        'IntLogical',
        'int-1',
        'AWS::ApiGatewayV2::Integration',
        desired,
        SERVICE_INTEGRATION,
        context
      );
      const input = updateIntegrationInput()!;
      expect(input['IntegrationSubtype']).toBeUndefined();
      expect(input['IntegrationUri']).toBe(lambdaUri);
      expect(result.effectiveProperties).toBeUndefined();
    }
  });

  it('Integration: the switch sends the declared IntegrationUri even when it equals the previous one', async () => {
    mockSend.mockResolvedValueOnce({});
    const uri = 'arn:aws:lambda:us-east-1:1:function:f';
    const { IntegrationSubtype: _dropped, ...withoutSubtype } = SERVICE_INTEGRATION;
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ...withoutSubtype, IntegrationUri: uri },
      { ...SERVICE_INTEGRATION, IntegrationUri: uri }
    );
    expect(updateIntegrationInput()!['IntegrationUri']).toBe(uri);
  });

  it('Integration: drift --revert (empty removedProperties) keeps re-sending the live subtype', async () => {
    mockSend.mockResolvedValueOnce({});
    const { IntegrationSubtype: _dropped, ...withoutSubtype } = SERVICE_INTEGRATION;
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ...withoutSubtype, Description: 'state' },
      { ...SERVICE_INTEGRATION, Description: 'console' },
      { removedProperties: new Set(), desiredFromAwsReadback: true }
    );
    expect(updateIntegrationInput()!['IntegrationSubtype']).toBe('EventBridge-PutEvents');
  });

  it('Integration: a declared map missing a key is sent AS DECLARED — nothing is carried from the previous record (CFn A/B)', async () => {
    // Real CloudFormation A/B (#1160): dropping a required key beside a
    // Description change FAILS the update, so CloudFormation sends the declared
    // map; cdkd does the same and lets AWS refuse it.
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ...SERVICE_INTEGRATION, RequestParameters: { Source: 's', DetailType: 'd' }, Description: 'n' },
      SERVICE_INTEGRATION
    );
    expect(updateIntegrationInput()!['RequestParameters']).toEqual({ Source: 's', DetailType: 'd' });
  });

  it('Integration: a redacted secret stand-in in the map to send REFUSES; a redacted PREVIOUS value is never sent', async () => {
    for (const standIn of ['{{resolve:secretsmanager:x}}', 'pre-{{resolve:ssm:p}}', '***']) {
      mockSend.mockClear();
      await expect(
        provider.update(
          'IntLogical',
          'int-1',
          'AWS::ApiGatewayV2::Integration',
          // A rollback replay hands back a STATE record as the desired bag.
          { ...SERVICE_INTEGRATION, RequestParameters: { ...EVENTS_PARAMS, Detail: standIn }, Description: 'restored' },
          { ...SERVICE_INTEGRATION, Description: 'failed-deploy' },
          { removedProperties: new Set(), replayingState: true }
        )
      ).rejects.toThrow(/the value of Detail is a redacted secret reference/);
      expect(mockSend).not.toHaveBeenCalled();
    }
    mockSend.mockClear();
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ...SERVICE_INTEGRATION, Description: 'n' },
      { ...SERVICE_INTEGRATION, RequestParameters: { ...EVENTS_PARAMS, Detail: '***' } }
    );
    expect(updateIntegrationInput()!['RequestParameters']).toEqual(EVENTS_PARAMS);
  });

  it('Integration: a replay whose unchanged map holds a stand-in, with nothing else changed, sends nothing and does not refuse', async () => {
    // The stand-in check runs only when an update is actually sent.
    const record = { ...SERVICE_INTEGRATION, RequestParameters: { ...EVENTS_PARAMS, Detail: '***' } };
    await expect(
      provider.update(
        'IntLogical',
        'int-1',
        'AWS::ApiGatewayV2::Integration',
        record,
        structuredClone(record),
        { removedProperties: new Set(), replayingState: true }
      )
    ).resolves.toBeDefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Integration: a rollback replay without IntegrationSubtype keeps the LIVE subtype (read from AWS), warns and records it', async () => {
    const { IntegrationSubtype: _dropped, ...withoutSubtype } = SERVICE_INTEGRATION;
    const warn = vi.mocked(getLogger().child('ApiGatewayV2Provider').warn);
    warn.mockClear();
    const replay = { removedProperties: new Set(['IntegrationSubtype']), replayingState: true };
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetIntegrationCommand ? { IntegrationSubtype: 'EventBridge-PutEvents' } : {}
    );
    const result = await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ...withoutSubtype, Description: 'restored' },
      { ...SERVICE_INTEGRATION, Description: 'failed-deploy' },
      replay
    );
    expect(updateIntegrationInput()!['IntegrationSubtype']).toBe('EventBridge-PutEvents');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('keeps the integration'))).toBe(true);
    // The kept subtype is RECORDED, so the next deploy's previous side still
    // carries it (a later update without it would be refused by AWS).
    expect(result.effectiveProperties).toEqual({
      ...withoutSubtype,
      Description: 'restored',
      IntegrationSubtype: 'EventBridge-PutEvents',
    });
    // ...also when the replay has nothing else to send.
    mockSend.mockClear();
    const quiet = await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      withoutSubtype,
      SERVICE_INTEGRATION,
      replay
    );
    expect(updateIntegrationInput()).toBeUndefined();
    expect(quiet.effectiveProperties).toEqual(SERVICE_INTEGRATION);
  });

  it('Integration: the revert-failed arm (subtype only in the FAILED attempt, never applied) neither records, warns nor sends it', async () => {
    // A MOCK integration with no URI and no subtype; a failed deploy tried to
    // add IntegrationSubtype and AWS rejected it. The rollback's previous side
    // is that attempted bag. AWS reports no subtype, so nothing is kept.
    const original = { ApiId: API_ID, IntegrationType: 'MOCK', Description: 'orig' };
    const attempted = { ...original, IntegrationSubtype: 'EventBridge-PutEvents' };
    const replay = { removedProperties: new Set(['IntegrationSubtype']), replayingState: true };
    const warn = vi.mocked(getLogger().child('ApiGatewayV2Provider').warn);
    warn.mockClear();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetIntegrationCommand ? { IntegrationType: 'MOCK' } : {}
    );
    const quiet = await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      original,
      attempted,
      replay
    );
    expect(updateIntegrationInput()).toBeUndefined();
    expect(quiet.effectiveProperties).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('keeps the integration'))).toBe(false);
    // With another field to restore, the update goes out WITHOUT the subtype.
    mockSend.mockClear();
    const result = await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      original,
      { ...attempted, Description: 'failed' },
      replay
    );
    expect(updateIntegrationInput()).toEqual({
      ApiId: API_ID,
      IntegrationId: 'int-1',
      Description: 'orig',
    });
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('Integration: a Description-only change on a service integration re-sends the subtype WITH the full RequestParameters', async () => {
    // AWS re-validates the operation's required parameter mapping on every
    // UpdateIntegration carrying the subtype (#1160 direct probe).
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ...SERVICE_INTEGRATION, Description: 'new' },
      SERVICE_INTEGRATION
    );
    expect(updateIntegrationInput()).toEqual({
      ApiId: API_ID,
      IntegrationId: 'int-1',
      Description: 'new',
      IntegrationSubtype: 'EventBridge-PutEvents',
      RequestParameters: EVENTS_PARAMS,
    });
  });

  it('Integration: with RequestParameters removed from the template, no map is sent beside the subtype (CFn A/B: AWS refuses it)', async () => {
    // Real CloudFormation A/B (#1160): removing the whole map beside a
    // Description change FAILS the update. Nothing from the previous record
    // is sent, so AWS refuses cdkd's call the same way.
    mockSend.mockResolvedValueOnce({});
    const { RequestParameters: _rp, ...withoutParams } = SERVICE_INTEGRATION;
    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      { ...withoutParams, Description: 'new' },
      SERVICE_INTEGRATION
    );
    const input = updateIntegrationInput()!;
    expect(input['IntegrationSubtype']).toBe('EventBridge-PutEvents');
    expect(input['RequestParameters']).toBeUndefined();
  });
});
