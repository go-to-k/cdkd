import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetParameterCommand,
  DescribeParametersCommand,
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
      });

    const result = await provider.readCurrentState('/foo', 'ParamLogical', 'AWS::SSM::Parameter');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetParameterCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeParametersCommand);
    expect(result).toEqual({
      Name: '/foo',
      Type: 'String',
      Value: 'bar',
      DataType: 'text',
      Description: 'a parameter',
      AllowedPattern: '^[a-z]+$',
      Tier: 'Standard',
    });
  });

  it('returns undefined when parameter is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ParameterNotFound({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('/gone', 'ParamLogical', 'AWS::SSM::Parameter');

    expect(result).toBeUndefined();
  });

  it('omits metadata fields when DescribeParameters fails (best-effort)', async () => {
    mockSend
      .mockResolvedValueOnce({
        Parameter: {
          Name: '/foo',
          Type: 'String',
          Value: 'bar',
        },
      })
      .mockRejectedValueOnce(new Error('access denied'));

    const result = await provider.readCurrentState('/foo', 'ParamLogical', 'AWS::SSM::Parameter');

    expect(result).toEqual({
      Name: '/foo',
      Type: 'String',
      Value: 'bar',
    });
  });
});
