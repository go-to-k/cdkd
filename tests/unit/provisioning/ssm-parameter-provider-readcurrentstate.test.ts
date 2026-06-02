import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetParameterCommand,
  DescribeParametersCommand,
  ListTagsForResourceCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';

describe('SSMParameterProvider.readCurrentState', () => {
  let provider: SSMParameterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SSMParameterProvider();
  });

  it('returns CFn-shaped fields combining GetParameter + DescribeParameters', async () => {
    mockSend
      .mockResolvedValueOnce({
        Parameter: {
          Name: '/foo',
          Type: 'String',
          Value: 'bar',
          DataType: 'text',
        },
      })
      .mockResolvedValueOnce({
        Parameters: [
          {
            Name: '/foo',
            Description: 'a parameter',
            AllowedPattern: '^[a-z]+$',
            Tier: 'Standard',
          },
        ],
      })
      .mockResolvedValueOnce({ TagList: [] });

    const result = await provider.readCurrentState('/foo', 'ParamLogical', 'AWS::SSM::Parameter');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetParameterCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeParametersCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      Name: '/foo',
      Type: 'String',
      Value: 'bar',
      DataType: 'text',
      Description: 'a parameter',
      AllowedPattern: '^[a-z]+$',
      Tier: 'Standard',
      Tags: {},
      Policies: [],
    });
  });

  it('surfaces parsed Policies (PolicyText JSON-parsed, PolicyStatus filtered)', async () => {
    const expirationPolicy = {
      Type: 'Expiration',
      Version: '1.0',
      Attributes: { Timestamp: '2024-01-01T00:00:00Z' },
    };
    mockSend
      .mockResolvedValueOnce({
        Parameter: { Name: '/foo', Type: 'String', Value: 'bar' },
      })
      .mockResolvedValueOnce({
        Parameters: [
          {
            Name: '/foo',
            Policies: [
              {
                PolicyText: JSON.stringify(expirationPolicy),
                PolicyType: 'Expiration',
                PolicyStatus: 'Pending', // AWS-managed, must NOT appear in result
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({ TagList: [] });

    const result = await provider.readCurrentState('/foo', 'ParamLogical', 'AWS::SSM::Parameter');
    expect(result?.Policies).toEqual([expirationPolicy]);
  });

  it('returns undefined when parameter is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ParameterNotFound({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('/gone', 'ParamLogical', 'AWS::SSM::Parameter');

    expect(result).toBeUndefined();
  });

  it('emits Policies=[] placeholder when DescribeParameters fails (best-effort)', async () => {
    mockSend
      .mockResolvedValueOnce({
        Parameter: {
          Name: '/foo',
          Type: 'String',
          Value: 'bar',
        },
      })
      .mockRejectedValueOnce(new Error('access denied'))
      .mockResolvedValueOnce({ TagList: [] });

    const result = await provider.readCurrentState('/foo', 'ParamLogical', 'AWS::SSM::Parameter');

    expect(result).toEqual({
      Name: '/foo',
      Type: 'String',
      Value: 'bar',
      Tags: {},
      // Always-emit fallback so console-side ADD on a previously-
      // un-policy'd parameter surfaces as drift even when
      // DescribeParameters errored.
      Policies: [],
    });
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({
        Parameter: { Name: '/foo', Type: 'String', Value: 'bar' },
      })
      .mockResolvedValueOnce({ Parameters: [] })
      .mockResolvedValueOnce({
        TagList: [
          { Key: 'Foo', Value: 'Bar' },
          { Key: 'aws:cdk:path', Value: 'MyStack/MyParam/Resource' },
        ],
      });

    const result = await provider.readCurrentState('/foo', 'ParamLogical', 'AWS::SSM::Parameter');
    // SSM Tags surface as the CFn key->value MAP shape (matching the template
    // shape cdkd stores in state), not the {Key,Value}[] list other providers use.
    expect(result?.Tags).toEqual({ Foo: 'Bar' });
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        Parameter: { Name: '/foo', Type: 'String', Value: 'bar' },
      })
      .mockResolvedValueOnce({ Parameters: [] })
      .mockResolvedValueOnce({
        TagList: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyParam/Resource' }],
      });

    const result = await provider.readCurrentState('/foo', 'ParamLogical', 'AWS::SSM::Parameter');
    expect(result?.Tags).toEqual({});
  });
});
