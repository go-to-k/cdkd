import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetAccountCommand,
  GetAuthorizerCommand,
  GetDeploymentCommand,
  GetMethodCommand,
  GetResourceCommand,
  GetStageCommand,
  NotFoundException,
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

describe('ApiGatewayProvider.readCurrentState', () => {
  let provider: ApiGatewayProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ApiGatewayProvider();
  });

  it('returns CloudWatchRoleArn for AWS::ApiGateway::Account', async () => {
    mockSend.mockResolvedValueOnce({
      cloudwatchRoleArn: 'arn:aws:iam::123:role/cw',
    });

    const result = await provider.readCurrentState(
      'ApiGatewayAccount',
      'AccountLogical',
      'AWS::ApiGateway::Account'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetAccountCommand);
    expect(result).toEqual({
      CloudWatchRoleArn: 'arn:aws:iam::123:role/cw',
    });
  });

  it('returns CFn-shaped Method fields from GetMethod (composite physicalId)', async () => {
    mockSend.mockResolvedValueOnce({
      httpMethod: 'GET',
      authorizationType: 'NONE',
      methodIntegration: { type: 'AWS_PROXY', uri: 'arn:aws:lambda:...' },
    });

    const result = await provider.readCurrentState(
      'api-1|res-1|GET',
      'MethodLogical',
      'AWS::ApiGateway::Method'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetMethodCommand);
    expect(result).toEqual({
      RestApiId: 'api-1',
      ResourceId: 'res-1',
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
      AuthorizerId: '',
      Integration: { type: 'AWS_PROXY', uri: 'arn:aws:lambda:...' },
      MethodResponses: {},
    });
  });

  it('returns undefined when method is gone', async () => {
    mockSend.mockRejectedValueOnce(new NotFoundException({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState(
      'api-1|res-1|GET',
      'MethodLogical',
      'AWS::ApiGateway::Method'
    );

    expect(result).toBeUndefined();
  });

  it('returns Authorizer fields via GetAuthorizer using properties.RestApiId', async () => {
    mockSend.mockResolvedValueOnce({
      id: 'auth-1',
      name: 'my-authorizer',
      type: 'COGNITO_USER_POOLS',
      providerARNs: ['arn:aws:cognito-idp:us-east-1:123:userpool/x'],
      identitySource: 'method.request.header.Authorization',
    });

    const result = await provider.readCurrentState(
      'auth-1',
      'AuthorizerLogical',
      'AWS::ApiGateway::Authorizer',
      { RestApiId: 'api-1' }
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetAuthorizerCommand);
    expect(result).toEqual({
      RestApiId: 'api-1',
      Name: 'my-authorizer',
      Type: 'COGNITO_USER_POOLS',
      ProviderARNs: ['arn:aws:cognito-idp:us-east-1:123:userpool/x'],
      AuthorizerUri: '',
      AuthorizerCredentials: '',
      IdentitySource: 'method.request.header.Authorization',
      IdentityValidationExpression: '',
    });
  });

  it('returns Resource fields via GetResource using properties.RestApiId', async () => {
    mockSend.mockResolvedValueOnce({ id: 'res-1', parentId: 'root', pathPart: 'users' });

    const result = await provider.readCurrentState(
      'res-1',
      'ResourceLogical',
      'AWS::ApiGateway::Resource',
      { RestApiId: 'api-1' }
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetResourceCommand);
    expect(result).toEqual({ RestApiId: 'api-1', ParentId: 'root', PathPart: 'users' });
  });

  it('returns Deployment fields via GetDeployment using properties.RestApiId', async () => {
    mockSend.mockResolvedValueOnce({ id: 'dep-1', description: 'release-1' });

    const result = await provider.readCurrentState(
      'dep-1',
      'DeploymentLogical',
      'AWS::ApiGateway::Deployment',
      { RestApiId: 'api-1' }
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetDeploymentCommand);
    expect(result).toEqual({ RestApiId: 'api-1', Description: 'release-1' });
  });

  it('returns Stage fields via GetStage using properties.RestApiId', async () => {
    mockSend.mockResolvedValueOnce({
      stageName: 'prod',
      deploymentId: 'dep-1',
      description: 'production stage',
    });

    const result = await provider.readCurrentState('prod', 'StageLogical', 'AWS::ApiGateway::Stage', {
      RestApiId: 'api-1',
    });

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetStageCommand);
    expect(result).toEqual({
      RestApiId: 'api-1',
      StageName: 'prod',
      DeploymentId: 'dep-1',
      Description: 'production stage',
    });
  });

  it('returns undefined for sub-resources when properties.RestApiId is missing', async () => {
    const result = await provider.readCurrentState(
      'prod',
      'StageLogical',
      'AWS::ApiGateway::Stage'
    );

    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns undefined for sub-resources when AWS reports NotFound', async () => {
    mockSend.mockRejectedValueOnce(new NotFoundException({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState(
      'auth-1',
      'AuthorizerLogical',
      'AWS::ApiGateway::Authorizer',
      { RestApiId: 'api-1' }
    );

    expect(result).toBeUndefined();
  });
});
