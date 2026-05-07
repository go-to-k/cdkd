import { describe, it, expect, vi, beforeEach } from 'vitest';

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
 * `cdkd drift --revert` round-trips `observedProperties` (= a
 * `readCurrentState` snapshot) through `provider.update`. ApiGatewayV2's
 * `update()` rejects every type with `ResourceUpdateNotSupportedError`
 * (see PR I), so the structural guard for this provider is two-fold:
 *
 * 1. `readCurrentState` must NOT emit Class 1 placeholders that the
 *    AWS-side Update API would reject (e.g. `JwtConfiguration` on a
 *    REQUEST authorizer, `CorsConfiguration` on a WEBSOCKET API,
 *    `IntegrationUri` on a MOCK integration). The drift comparator
 *    consumes `observedProperties`, so leaving an invalid placeholder
 *    in there would also fire false-positive drift on every clean run.
 * 2. `update()` must reject cleanly with `ResourceUpdateNotSupportedError`
 *    for every resource type — no spurious SDK calls should fire on the
 *    revert path.
 */
describe('ApiGatewayV2Provider read-update round-trip', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ApiGatewayV2Provider();
  });

  it('Class 1 — Api HTTP no-drift snapshot includes CorsConfiguration but excludes WEBSOCKET-only fields', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: API_ID,
      Name: 'my-http-api',
      ProtocolType: 'HTTP',
      Description: 'an http api',
      CorsConfiguration: { AllowOrigins: ['*'] },
      // RouteSelectionExpression: AWS DOES return one for HTTP APIs as a
      // server-managed default, but it must NOT show up in observed.
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

    // Round-trip: update must reject cleanly without sending any SDK
    // commands.
    vi.clearAllMocks();
    await expect(
      provider.update('L', API_ID, 'AWS::ApiGatewayV2::Api', observed!, observed!)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Class 1 — Api WEBSOCKET no-drift snapshot preserves RouteSelectionExpression but excludes CorsConfiguration', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: API_ID,
      Name: 'my-ws-api',
      ProtocolType: 'WEBSOCKET',
      Description: 'a websocket api',
      // CorsConfiguration: AWS would not return one on a WEBSOCKET API,
      // and the readCurrentState placeholder MUST NOT push `{}` here —
      // CORS is HTTP-only and `UpdateApi` rejects a CORS payload on a
      // WEBSOCKET API.
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

    vi.clearAllMocks();
    await expect(
      provider.update('L', API_ID, 'AWS::ApiGatewayV2::Api', observed!, observed!)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
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
    // REQUEST-only fields MUST be absent on a JWT authorizer (would
    // trigger AWS rejection on revert).
    expect(observed!).not.toHaveProperty('AuthorizerUri');
    expect(observed!).not.toHaveProperty('AuthorizerPayloadFormatVersion');

    vi.clearAllMocks();
    await expect(
      provider.update('L', 'auth-jwt', 'AWS::ApiGatewayV2::Authorizer', observed!, observed!)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
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
    // JWT-only fields MUST be absent on a REQUEST authorizer.
    expect(observed!).not.toHaveProperty('JwtConfiguration');

    vi.clearAllMocks();
    await expect(
      provider.update('L', 'auth-req', 'AWS::ApiGatewayV2::Authorizer', observed!, observed!)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Class 1 — Integration MOCK no-drift snapshot excludes IntegrationUri', async () => {
    mockSend.mockResolvedValueOnce({
      IntegrationId: 'int-mock',
      IntegrationType: 'MOCK',
      // AWS does not return IntegrationUri for MOCK; the readCurrentState
      // placeholder MUST NOT push `''` here — AWS rejects an empty
      // IntegrationUri on MOCK integrations.
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

    vi.clearAllMocks();
    await expect(
      provider.update(
        'L',
        'int-lambda',
        'AWS::ApiGatewayV2::Integration',
        observed!,
        observed!
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Class 2 — Route NONE-auth no-drift snapshot uses AuthorizationType=NONE and excludes AuthorizerId/AuthorizationScopes', async () => {
    mockSend.mockResolvedValueOnce({
      RouteId: 'route-none',
      RouteKey: 'GET /pets',
      Target: 'integrations/int-1',
      // AuthorizationType undefined / AWS returns 'NONE' default.
    });

    const observed = await provider.readCurrentState(
      'route-none',
      'RouteLogical',
      'AWS::ApiGatewayV2::Route',
      { ApiId: API_ID }
    );

    expect(observed).toBeDefined();
    // Class 2 fix: must be 'NONE' (AWS-valid sentinel), not '' (rejected).
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

  it('every resource type rejects update() cleanly with ResourceUpdateNotSupportedError and no SDK calls', async () => {
    // Mechanical guard: ApiGatewayV2 update() is an immutable-only
    // wrapper (PR I). state == AWS round-trip MUST produce zero
    // mutating SDK calls.
    const cases: Array<{ type: string; observed: Record<string, unknown> }> = [
      {
        type: 'AWS::ApiGatewayV2::Api',
        observed: { Name: 'a', ProtocolType: 'HTTP', Description: '', CorsConfiguration: {}, Tags: [] },
      },
      {
        type: 'AWS::ApiGatewayV2::Stage',
        observed: { ApiId: API_ID, StageName: '$default', AutoDeploy: true, Description: '' },
      },
      {
        type: 'AWS::ApiGatewayV2::Integration',
        observed: {
          ApiId: API_ID,
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: 'arn:aws:lambda:us-east-1:1:function:f',
          IntegrationMethod: 'POST',
          PayloadFormatVersion: '2.0',
        },
      },
      {
        type: 'AWS::ApiGatewayV2::Route',
        observed: { ApiId: API_ID, RouteKey: 'GET /', Target: 'integrations/i-1', AuthorizationType: 'NONE' },
      },
      {
        type: 'AWS::ApiGatewayV2::Authorizer',
        observed: {
          ApiId: API_ID,
          AuthorizerType: 'JWT',
          Name: 'auth',
          IdentitySource: ['$request.header.Authorization'],
          JwtConfiguration: { Audience: ['c'], Issuer: 'https://i' },
        },
      },
    ];

    for (const { type, observed } of cases) {
      vi.clearAllMocks();
      await expect(provider.update('L', 'phys', type, observed, observed)).rejects.toBeInstanceOf(
        ResourceUpdateNotSupportedError
      );
      expect(mockSend).not.toHaveBeenCalled();
    }
  });
});
