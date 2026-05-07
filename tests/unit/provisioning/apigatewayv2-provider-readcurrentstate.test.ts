import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetApiCommand,
  GetAuthorizerCommand,
  GetIntegrationCommand,
  GetRouteCommand,
  GetStageCommand,
  NotFoundException,
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

describe('ApiGatewayV2Provider.readCurrentState', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ApiGatewayV2Provider();
  });

  it('returns CFn-shaped Api fields from GetApi (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: 'abcd1234',
      Name: 'my-api',
      ProtocolType: 'HTTP',
      Description: 'a fancy API',
      CorsConfiguration: { AllowOrigins: ['*'] },
    });

    const result = await provider.readCurrentState(
      'abcd1234',
      'ApiLogical',
      'AWS::ApiGatewayV2::Api'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetApiCommand);
    expect(result).toEqual({
      Name: 'my-api',
      ProtocolType: 'HTTP',
      Description: 'a fancy API',
      CorsConfiguration: { AllowOrigins: ['*'] },
      Tags: [],
    });
  });

  it('returns undefined when api is gone', async () => {
    mockSend.mockRejectedValueOnce(new NotFoundException({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState('gone', 'ApiLogical', 'AWS::ApiGatewayV2::Api');

    expect(result).toBeUndefined();
  });

  it('returns Stage fields via GetStage using properties.ApiId', async () => {
    mockSend.mockResolvedValueOnce({
      StageName: '$default',
      AutoDeploy: true,
      Description: 'default stage',
    });

    const result = await provider.readCurrentState(
      '$default',
      'StageLogical',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: 'abcd1234' }
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetStageCommand);
    expect(result).toEqual({
      ApiId: 'abcd1234',
      StageName: '$default',
      AutoDeploy: true,
      Description: 'default stage',
    });
  });

  it('returns Integration fields via GetIntegration using properties.ApiId', async () => {
    mockSend.mockResolvedValueOnce({
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:us-east-1:123:function:my-fn',
      IntegrationMethod: 'POST',
      PayloadFormatVersion: '2.0',
    });

    const result = await provider.readCurrentState(
      'int-1',
      'IntegrationLogical',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: 'abcd1234' }
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetIntegrationCommand);
    expect(result).toEqual({
      ApiId: 'abcd1234',
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:us-east-1:123:function:my-fn',
      IntegrationMethod: 'POST',
      PayloadFormatVersion: '2.0',
    });
  });

  it('returns Route fields via GetRoute using properties.ApiId', async () => {
    mockSend.mockResolvedValueOnce({
      RouteKey: 'GET /pets',
      Target: 'integrations/int-1',
      AuthorizationType: 'JWT',
      AuthorizerId: 'auth-1',
    });

    const result = await provider.readCurrentState(
      'route-1',
      'RouteLogical',
      'AWS::ApiGatewayV2::Route',
      { ApiId: 'abcd1234' }
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetRouteCommand);
    expect(result).toEqual({
      ApiId: 'abcd1234',
      RouteKey: 'GET /pets',
      Target: 'integrations/int-1',
      AuthorizationType: 'JWT',
      AuthorizerId: 'auth-1',
    });
  });

  it('returns Authorizer fields via GetAuthorizer using properties.ApiId', async () => {
    mockSend.mockResolvedValueOnce({
      AuthorizerType: 'JWT',
      Name: 'my-jwt-authorizer',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Audience: ['client-id'], Issuer: 'https://issuer.example.com' },
    });

    const result = await provider.readCurrentState(
      'auth-1',
      'AuthorizerLogical',
      'AWS::ApiGatewayV2::Authorizer',
      { ApiId: 'abcd1234' }
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetAuthorizerCommand);
    expect(result).toEqual({
      ApiId: 'abcd1234',
      AuthorizerType: 'JWT',
      Name: 'my-jwt-authorizer',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Audience: ['client-id'], Issuer: 'https://issuer.example.com' },
      AuthorizerUri: '',
      AuthorizerPayloadFormatVersion: '',
    });
  });

  it('returns undefined for sub-resources when properties.ApiId is missing', async () => {
    const result = await provider.readCurrentState(
      'route-id',
      'RouteLogical',
      'AWS::ApiGatewayV2::Route'
    );

    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns undefined for sub-resources when AWS reports NotFound', async () => {
    mockSend.mockRejectedValueOnce(new NotFoundException({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState(
      'route-1',
      'RouteLogical',
      'AWS::ApiGatewayV2::Route',
      { ApiId: 'abcd1234' }
    );

    expect(result).toBeUndefined();
  });

  it('surfaces Tags from GetApi with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      Name: 'my-api',
      ProtocolType: 'HTTP',
      Tags: { Foo: 'Bar', 'aws:cdk:path': 'MyStack/MyApi/Resource' },
    });

    const result = await provider.readCurrentState(
      'abcd1234',
      'ApiLogical',
      'AWS::ApiGatewayV2::Api'
    );

    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when GetApi returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      Name: 'my-api',
      ProtocolType: 'HTTP',
      Tags: { 'aws:cdk:path': 'MyStack/MyApi/Resource' },
    });

    const result = await provider.readCurrentState(
      'abcd1234',
      'ApiLogical',
      'AWS::ApiGatewayV2::Api'
    );

    expect(result?.Tags).toEqual([]);
  });

  // Structural regression test for the always-emit-placeholder convention
  // (docs/provider-development.md § 3b). Ensures every user-controllable
  // top-level CFn key is present in the result even when AWS returns
  // the resource with all optional fields undefined / empty. A future
  // refactor that drops a placeholder for any of these keys must update
  // this test consciously — silent regression is structurally prevented.
  it('emits placeholders for every user-controllable top-level key on AWS minimum response (Api)', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: 'a',
      ProtocolType: 'HTTP',
      // Name / Description / CorsConfiguration / Tags deliberately undefined.
    });

    const result = await provider.readCurrentState(
      'a',
      'ApiLogical',
      'AWS::ApiGatewayV2::Api'
    );

    expect(Object.keys(result ?? {}).sort()).toEqual(
      ['CorsConfiguration', 'Description', 'Name', 'ProtocolType', 'Tags'].sort()
    );
    expect(result?.Name).toBe('');
    expect(result?.Description).toBe('');
    expect(result?.CorsConfiguration).toEqual({});
    expect(result?.ProtocolType).toBe('HTTP');
    expect(result?.Tags).toEqual([]);
  });
});
