import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetFunctionUrlConfigCommand, ResourceNotFoundException } from '@aws-sdk/client-lambda';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { LambdaUrlProvider } from '../../../src/provisioning/providers/lambda-url-provider.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../src/types/resource.js';

/** Narrow a `readCurrentState` result to its property bag; fails on `RESOURCE_NOT_FOUND`. */
function bagOf(
  r: Record<string, unknown> | ResourceNotFound | undefined
): Record<string, unknown> | undefined {
  expect(r).not.toBe(RESOURCE_NOT_FOUND);
  return r as Record<string, unknown> | undefined;
}

describe('LambdaUrlProvider.readCurrentState', () => {
  let provider: LambdaUrlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaUrlProvider();
  });

  it('returns CFn-shaped properties (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/',
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
      AuthType: 'NONE',
      InvokeMode: 'BUFFERED',
      Cors: {
        AllowOrigins: ['*'],
        AllowMethods: ['GET'],
        AllowHeaders: ['Content-Type'],
        MaxAge: 86400,
        AllowCredentials: false,
      },
      CreationTime: '2026-01-01',
      LastModifiedTime: '2026-01-01',
    });

    const physicalId = 'arn:aws:lambda:us-east-1:123:function:fn';
    const result = await provider.readCurrentState(physicalId, 'Logical', 'AWS::Lambda::Url');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetFunctionUrlConfigCommand);
    expect(result).toEqual({
      TargetFunctionArn: physicalId,
      AuthType: 'NONE',
      InvokeMode: 'BUFFERED',
      Cors: {
        AllowOrigins: ['*'],
        AllowMethods: ['GET'],
        AllowHeaders: ['Content-Type'],
        ExposeHeaders: [],
        MaxAge: 86400,
        AllowCredentials: false,
      },
    });
  });

  it('returns RESOURCE_NOT_FOUND when URL config gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'arn:aws:lambda:us-east-1:123:function:fn',
      'Logical',
      'AWS::Lambda::Url'
    );
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('emits Cors with empty-array placeholders when AWS returns empty cors object', async () => {
    mockSend.mockResolvedValueOnce({
      AuthType: 'AWS_IAM',
      InvokeMode: 'BUFFERED',
      Cors: {}, // empty — placeholders fill in.
    });

    const result = bagOf(await provider.readCurrentState(
      'arn:aws:lambda:us-east-1:123:function:fn',
      'Logical',
      'AWS::Lambda::Url'
    ));
    expect(result?.Cors).toEqual({
      AllowOrigins: [],
      AllowMethods: [],
      AllowHeaders: [],
      ExposeHeaders: [],
    });
  });
});
