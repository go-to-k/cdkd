import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetAccountCommand,
  GetMethodCommand,
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
      Integration: { type: 'AWS_PROXY', uri: 'arn:aws:lambda:...' },
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

  it('returns undefined for unsupported sub-resource types (Stage)', async () => {
    const result = await provider.readCurrentState(
      'prod',
      'StageLogical',
      'AWS::ApiGateway::Stage'
    );

    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
