import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeStateMachineCommand,
  ListTagsForResourceCommand,
  StateMachineDoesNotExist,
} from '@aws-sdk/client-sfn';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-sfn', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    SFNClient: vi.fn().mockImplementation(() => ({
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

import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';

describe('StepFunctionsProvider.readCurrentState', () => {
  let provider: StepFunctionsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new StepFunctionsProvider();
  });

  it('returns CFn-shaped fields from DescribeStateMachine (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      stateMachineArn: 'arn:aws:states:us-east-1:123:stateMachine:my-sm',
      name: 'my-sm',
      roleArn: 'arn:aws:iam::123:role/sfn',
      type: 'STANDARD',
      definition: '{"StartAt":"Pass","States":{"Pass":{"Type":"Pass","End":true}}}',
      loggingConfiguration: {
        level: 'ALL',
        includeExecutionData: true,
        destinations: [
          { cloudWatchLogsLogGroup: { logGroupArn: 'arn:aws:logs:us-east-1:123:log-group:/aws/sfn' } },
        ],
      },
      tracingConfiguration: { enabled: true },
      encryptionConfiguration: { type: 'AWS_OWNED_KEY' },
    });
    mockSend.mockResolvedValueOnce({ tags: [] });

    const result = await provider.readCurrentState(
      'arn:aws:states:us-east-1:123:stateMachine:my-sm',
      'SMLogical',
      'AWS::StepFunctions::StateMachine'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeStateMachineCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      StateMachineName: 'my-sm',
      RoleArn: 'arn:aws:iam::123:role/sfn',
      StateMachineType: 'STANDARD',
      Definition: { StartAt: 'Pass', States: { Pass: { Type: 'Pass', End: true } } },
      LoggingConfiguration: {
        Level: 'ALL',
        IncludeExecutionData: true,
        Destinations: [
          {
            CloudWatchLogsLogGroup: {
              LogGroupArn: 'arn:aws:logs:us-east-1:123:log-group:/aws/sfn',
            },
          },
        ],
      },
      TracingConfiguration: { Enabled: true },
      EncryptionConfiguration: { Type: 'AWS_OWNED_KEY' },
      Tags: [],
    });
  });

  it('returns undefined when state machine is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new StateMachineDoesNotExist({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'arn:aws:states:us-east-1:123:stateMachine:gone',
      'SMLogical',
      'AWS::StepFunctions::StateMachine'
    );

    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out (SFN lower-case shape)', async () => {
    mockSend.mockResolvedValueOnce({ name: 'my-sm', type: 'STANDARD' });
    mockSend.mockResolvedValueOnce({
      tags: [
        { key: 'Foo', value: 'Bar' },
        { key: 'aws:cdk:path', value: 'MyStack/MyStateMachine/Resource' },
      ],
    });

    const result = await provider.readCurrentState(
      'arn:aws:states:us-east-1:123:stateMachine:my-sm',
      'SMLogical',
      'AWS::StepFunctions::StateMachine'
    );

    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({ name: 'my-sm', type: 'STANDARD' });
    mockSend.mockResolvedValueOnce({
      tags: [{ key: 'aws:cdk:path', value: 'MyStack/MyStateMachine/Resource' }],
    });

    const result = await provider.readCurrentState(
      'arn:aws:states:us-east-1:123:stateMachine:my-sm',
      'SMLogical',
      'AWS::StepFunctions::StateMachine'
    );

    expect(result?.Tags).toEqual([]);
  });
});
