import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetEventSourceMappingCommand, ResourceNotFoundException } from '@aws-sdk/client-lambda';

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

import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';

describe('LambdaEventSourceMappingProvider.readCurrentState', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaEventSourceMappingProvider();
  });

  it('returns CFn-shaped properties (happy path, Enabled derived from State)', async () => {
    mockSend.mockResolvedValueOnce({
      UUID: 'abc-123',
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 5,
      MaximumRetryAttempts: 3,
      State: 'Enabled',
      StateTransitionReason: 'USER_INITIATED', // AWS-managed, not surfaced
      LastModified: new Date(0),
    });

    const result = await provider.readCurrentState(
      'abc-123',
      'Logical',
      'AWS::Lambda::EventSourceMapping'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetEventSourceMappingCommand);
    // SQS source supports FunctionResponseTypes but not
    // SourceAccessConfigurations — the placeholder is type-discriminator-
    // gated so a `cdkd drift --revert` round-trip cannot push a
    // `SourceAccessConfigurations: []` to AWS (which would be rejected).
    expect(result).toEqual({
      FunctionName: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 5,
      MaximumRetryAttempts: 3,
      Enabled: true,
      FunctionResponseTypes: [],
    });
  });

  it('marks Enabled=false when State is Disabled', async () => {
    mockSend.mockResolvedValueOnce({
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      State: 'Disabled',
    });

    const result = await provider.readCurrentState(
      'abc-123',
      'Logical',
      'AWS::Lambda::EventSourceMapping'
    );
    expect(result?.['Enabled']).toBe(false);
  });

  it('returns undefined when mapping gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'abc-123',
      'Logical',
      'AWS::Lambda::EventSourceMapping'
    );
    expect(result).toBeUndefined();
  });
});
