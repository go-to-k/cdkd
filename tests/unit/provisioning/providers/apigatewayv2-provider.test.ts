import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-apigatewayv2')>();
  return {
    ...actual,
    ApiGatewayV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
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

import { ApiGatewayV2Provider } from '../../../../src/provisioning/providers/apigatewayv2-provider.js';
import {
  GetApiCommand,
  GetApisCommand,
  NotFoundException,
} from '@aws-sdk/client-apigatewayv2';

describe('ApiGatewayV2Provider import', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ApiGatewayV2Provider();
  });

  function makeInput(
    overrides: Partial<{
      knownPhysicalId: string;
      cdkPath: string;
      resourceType: string;
      properties: Record<string, unknown>;
    }> = {}
  ) {
    return {
      logicalId: 'MyApi',
      resourceType: 'AWS::ApiGatewayV2::Api',
      cdkPath: 'MyStack/MyApi/Resource',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('explicit override: verifies via GetApi and returns the physicalId', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: 'abc123',
      Name: 'my-api',
    });

    const result = await provider.import(makeInput({ knownPhysicalId: 'abc123' }));

    expect(result).toEqual({ physicalId: 'abc123', attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetApiCommand);
    expect(mockSend.mock.calls[0][0].input).toEqual({ ApiId: 'abc123' });
  });

  it('tag-based lookup: GetApis matches the aws:cdk:path tag map', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          ApiId: 'other123',
          Tags: { 'aws:cdk:path': 'OtherStack/Api/Resource' },
        },
        {
          ApiId: 'abc123',
          Tags: { 'aws:cdk:path': 'MyStack/MyApi/Resource' },
        },
      ],
    });

    const result = await provider.import(makeInput());

    expect(result).toEqual({ physicalId: 'abc123', attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetApisCommand);
  });

  it('returns null when no API matches the cdkPath', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          ApiId: 'unrelated',
          Tags: { 'aws:cdk:path': 'OtherStack/Api/Resource' },
        },
      ],
    });

    const result = await provider.import(makeInput());

    expect(result).toBeNull();
  });

  it('sub-resource override-only: returns the knownPhysicalId without API calls', async () => {
    const result = await provider.import(
      makeInput({
        resourceType: 'AWS::ApiGatewayV2::Stage',
        knownPhysicalId: 'abc123/prod',
      })
    );

    expect(result).toEqual({ physicalId: 'abc123/prod', attributes: {} });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sub-resource without knownPhysicalId returns null (no auto lookup)', async () => {
    const result = await provider.import(
      makeInput({ resourceType: 'AWS::ApiGatewayV2::Stage' })
    );

    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('GetApi NotFoundException on explicit override returns null', async () => {
    mockSend.mockRejectedValueOnce(
      new NotFoundException({ $metadata: {}, message: 'not found' })
    );

    const result = await provider.import(makeInput({ knownPhysicalId: 'missing' }));

    expect(result).toBeNull();
  });
});
