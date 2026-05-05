import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetApiCommand, NotFoundException } from '@aws-sdk/client-apigatewayv2';

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
    });
  });

  it('returns undefined when api is gone', async () => {
    mockSend.mockRejectedValueOnce(new NotFoundException({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState('gone', 'ApiLogical', 'AWS::ApiGatewayV2::Api');

    expect(result).toBeUndefined();
  });

  it('returns undefined for sub-resources (Route)', async () => {
    const result = await provider.readCurrentState(
      'route-id',
      'RouteLogical',
      'AWS::ApiGatewayV2::Route'
    );

    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
