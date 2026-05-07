import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeRuleCommand,
  ListTagsForResourceCommand,
  ListTargetsByRuleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-eventbridge';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';

describe('EventBridgeRuleProvider.readCurrentState', () => {
  let provider: EventBridgeRuleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EventBridgeRuleProvider();
  });

  it('returns CFn-shaped fields from DescribeRule + ListTargetsByRule (happy path, default bus)', async () => {
    mockSend
      .mockResolvedValueOnce({
        Name: 'my-rule',
        Arn: 'arn:aws:events:us-east-1:123:rule/my-rule',
        Description: 'a rule',
        EventBusName: 'default',
        EventPattern: '{"source":["aws.s3"]}',
        ScheduleExpression: 'rate(5 minutes)',
        State: 'ENABLED',
        RoleArn: 'arn:aws:iam::123:role/my-role',
      })
      .mockResolvedValueOnce({
        Targets: [
          {
            Id: 't1',
            Arn: 'arn:aws:lambda:us-east-1:123:function:fn',
          },
        ],
      })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(
      'arn:aws:events:us-east-1:123:rule/my-rule',
      'RuleLogical',
      'AWS::Events::Rule'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeRuleCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTargetsByRuleCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      Name: 'my-rule',
      Description: 'a rule',
      EventPattern: { source: ['aws.s3'] },
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
      RoleArn: 'arn:aws:iam::123:role/my-role',
      Targets: [
        {
          Id: 't1',
          Arn: 'arn:aws:lambda:us-east-1:123:function:fn',
        },
      ],
      Tags: [],
    });
  });

  it('surfaces EventBusName when not default bus', async () => {
    mockSend
      .mockResolvedValueOnce({
        Name: 'my-rule',
        EventBusName: 'my-bus',
        State: 'ENABLED',
      })
      .mockResolvedValueOnce({ Targets: [] })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(
      'arn:aws:events:us-east-1:123:rule/my-bus/my-rule',
      'RuleLogical',
      'AWS::Events::Rule'
    );

    expect(result).toEqual({
      Name: 'my-rule',
      EventBusName: 'my-bus',
      State: 'ENABLED',
      Tags: [],
    });
  });

  it('returns undefined when rule is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'arn:aws:events:us-east-1:123:rule/gone',
      'RuleLogical',
      'AWS::Events::Rule'
    );

    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({ Name: 'my-rule', State: 'ENABLED' })
      .mockResolvedValueOnce({ Targets: [] })
      .mockResolvedValueOnce({
        Tags: [
          { Key: 'Foo', Value: 'Bar' },
          { Key: 'aws:cdk:path', Value: 'MyStack/MyRule/Resource' },
        ],
      });

    const result = await provider.readCurrentState(
      'arn:aws:events:us-east-1:123:rule/my-rule',
      'RuleLogical',
      'AWS::Events::Rule'
    );

    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({ Name: 'my-rule', State: 'ENABLED' })
      .mockResolvedValueOnce({ Targets: [] })
      .mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyRule/Resource' }],
      });

    const result = await provider.readCurrentState(
      'arn:aws:events:us-east-1:123:rule/my-rule',
      'RuleLogical',
      'AWS::Events::Rule'
    );

    expect(result?.Tags).toEqual([]);
  });
});
