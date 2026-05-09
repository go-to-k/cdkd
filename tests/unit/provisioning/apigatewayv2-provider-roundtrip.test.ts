import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  UpdateApiCommand,
  UpdateStageCommand,
  UpdateIntegrationCommand,
  UpdateRouteCommand,
  UpdateAuthorizerCommand,
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

const API_ID = 'abcd1234';

/**
 * Read-update round-trip test (docs/provider-development.md § 3b).
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

    const observed = await provider.readCurrentState(
      API_ID,
      'ApiLogical',
      'AWS::ApiGatewayV2::Api'
    );

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

    const observed = await provider.readCurrentState(
      API_ID,
      'ApiLogical',
      'AWS::ApiGatewayV2::Api'
    );

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

    const observed = await provider.readCurrentState(
      'auth-jwt',
      'AuthorizerLogical',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID }
    );

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

    const observed = await provider.readCurrentState(
      'auth-req',
      'AuthorizerLogical',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: API_ID }
    );

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

    const observed = await provider.readCurrentState(
      'int-mock',
      'IntegrationLogical',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID }
    );

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

    const observed = await provider.readCurrentState(
      'int-lambda',
      'IntegrationLogical',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID }
    );

    expect(observed).toBeDefined();
    expect(observed!['IntegrationUri']).toBe('arn:aws:lambda:us-east-1:123:function:my-fn');
  });

  it('Class 2 — Route NONE-auth no-drift snapshot uses AuthorizationType=NONE and excludes AuthorizerId/AuthorizationScopes', async () => {
    mockSend.mockResolvedValueOnce({
      RouteId: 'route-none',
      RouteKey: 'GET /pets',
      Target: 'integrations/int-1',
    });

    const observed = await provider.readCurrentState(
      'route-none',
      'RouteLogical',
      'AWS::ApiGatewayV2::Route',
      { ApiId: API_ID }
    );

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

    const observed = await provider.readCurrentState(
      'route-jwt',
      'RouteLogical',
      'AWS::ApiGatewayV2::Route',
      { ApiId: API_ID }
    );

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
