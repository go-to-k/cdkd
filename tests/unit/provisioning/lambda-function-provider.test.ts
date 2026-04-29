import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CreateFunctionCommand,
  UpdateFunctionConfigurationCommand,
  DeleteFunctionCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';
import { DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';

// Mock AWS clients before importing the provider
const mockLambdaSend = vi.fn();
const mockEc2Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    ec2: { send: mockEc2Send },
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

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';

describe('LambdaFunctionProvider', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLambdaSend.mockReset();
    mockEc2Send.mockReset();
    provider = new LambdaFunctionProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('handledProperties', () => {
    it('declares VpcConfig as handled to prevent CC API fallback', () => {
      const handled = provider.handledProperties.get('AWS::Lambda::Function');
      expect(handled).toBeDefined();
      expect(handled?.has('VpcConfig')).toBe(true);
    });
  });

  describe('create', () => {
    it('passes VpcConfig (SubnetIds, SecurityGroupIds, Ipv6AllowedForDualStack) to CreateFunction', async () => {
      mockLambdaSend.mockResolvedValueOnce({
        FunctionName: 'fn-vpc',
        FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn-vpc',
      });

      const result = await provider.create('VpcFn', 'AWS::Lambda::Function', {
        FunctionName: 'fn-vpc',
        Role: 'arn:aws:iam::123456789012:role/exec',
        Handler: 'index.handler',
        Runtime: 'nodejs20.x',
        Code: { S3Bucket: 'b', S3Key: 'k' },
        VpcConfig: {
          SubnetIds: ['subnet-aaa', 'subnet-bbb'],
          SecurityGroupIds: ['sg-111'],
          Ipv6AllowedForDualStack: true,
        },
      });

      expect(result.physicalId).toBe('fn-vpc');
      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
      const cmd = mockLambdaSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(CreateFunctionCommand);
      expect(cmd.input.VpcConfig).toEqual({
        SubnetIds: ['subnet-aaa', 'subnet-bbb'],
        SecurityGroupIds: ['sg-111'],
        Ipv6AllowedForDualStack: true,
      });
    });

    it('omits VpcConfig from CreateFunction input when not provided', async () => {
      mockLambdaSend.mockResolvedValueOnce({
        FunctionName: 'fn-no-vpc',
        FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn-no-vpc',
      });

      await provider.create('NoVpcFn', 'AWS::Lambda::Function', {
        FunctionName: 'fn-no-vpc',
        Role: 'arn:aws:iam::123456789012:role/exec',
        Handler: 'index.handler',
        Runtime: 'nodejs20.x',
        Code: { S3Bucket: 'b', S3Key: 'k' },
      });

      const cmd = mockLambdaSend.mock.calls[0][0];
      expect(cmd.input.VpcConfig).toBeUndefined();
    });
  });

  describe('update', () => {
    it('sends VpcConfig change via UpdateFunctionConfiguration', async () => {
      // 1) UpdateFunctionConfiguration  2) GetFunction (for attributes)
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          Configuration: {
            FunctionName: 'fn-vpc',
            FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn-vpc',
          },
        });

      const result = await provider.update(
        'VpcFn',
        'fn-vpc',
        'AWS::Lambda::Function',
        {
          Role: 'arn:aws:iam::123456789012:role/exec',
          VpcConfig: {
            SubnetIds: ['subnet-new'],
            SecurityGroupIds: ['sg-new'],
          },
        },
        {
          Role: 'arn:aws:iam::123456789012:role/exec',
          VpcConfig: {
            SubnetIds: ['subnet-old'],
            SecurityGroupIds: ['sg-old'],
          },
        }
      );

      expect(result.physicalId).toBe('fn-vpc');
      const cmd = mockLambdaSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(UpdateFunctionConfigurationCommand);
      expect(cmd.input.VpcConfig).toEqual({
        SubnetIds: ['subnet-new'],
        SecurityGroupIds: ['sg-new'],
      });
    });

    it('detaches the function from a VPC by sending empty arrays when VpcConfig is removed', async () => {
      // UpdateFunctionConfiguration treats an absent VpcConfig as "no
      // change", so we must explicitly send empty SubnetIds and
      // SecurityGroupIds to detach a function from its VPC.
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          Configuration: {
            FunctionName: 'fn-detach',
            FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn-detach',
          },
        });

      await provider.update(
        'VpcFn',
        'fn-detach',
        'AWS::Lambda::Function',
        {
          Role: 'arn:aws:iam::123456789012:role/exec',
          // VpcConfig intentionally absent.
        },
        {
          Role: 'arn:aws:iam::123456789012:role/exec',
          VpcConfig: {
            SubnetIds: ['subnet-old'],
            SecurityGroupIds: ['sg-old'],
          },
        }
      );

      const cmd = mockLambdaSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(UpdateFunctionConfigurationCommand);
      expect(cmd.input.VpcConfig).toEqual({
        SubnetIds: [],
        SecurityGroupIds: [],
      });
    });

    it('does not send VpcConfig at all when neither previous nor new has VpcConfig', async () => {
      // Force a config update by changing Timeout, then verify the input
      // does not include a synthetic empty VpcConfig.
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          Configuration: {
            FunctionName: 'fn-no-vpc',
            FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn-no-vpc',
          },
        });

      await provider.update(
        'NoVpcFn',
        'fn-no-vpc',
        'AWS::Lambda::Function',
        {
          Role: 'arn:aws:iam::123456789012:role/exec',
          Timeout: 30,
        },
        {
          Role: 'arn:aws:iam::123456789012:role/exec',
          Timeout: 10,
        }
      );

      const cmd = mockLambdaSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(UpdateFunctionConfigurationCommand);
      expect(cmd.input.VpcConfig).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('skips VPC handling when no VpcConfig is provided', async () => {
      mockLambdaSend.mockResolvedValueOnce({});

      await provider.delete('Fn', 'fn-no-vpc', 'AWS::Lambda::Function', {});

      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
      expect(mockLambdaSend.mock.calls[0][0]).toBeInstanceOf(DeleteFunctionCommand);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it('skips VPC handling when VpcConfig has empty SubnetIds', async () => {
      mockLambdaSend.mockResolvedValueOnce({});

      await provider.delete('Fn', 'fn-empty', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: [], SecurityGroupIds: [] },
      });

      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it('pre-detaches VPC config (UpdateFunctionConfiguration with empty arrays) and waits for Active before DeleteFunction', async () => {
      mockLambdaSend
        .mockResolvedValueOnce({}) // UpdateFunctionConfiguration (pre-detach)
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } }) // GetFunction (wait)
        .mockResolvedValueOnce({}); // DeleteFunction
      mockEc2Send.mockResolvedValueOnce({ NetworkInterfaces: [] });

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;

      expect(mockLambdaSend).toHaveBeenCalledTimes(3);
      const updateCmd = mockLambdaSend.mock.calls[0][0];
      expect(updateCmd).toBeInstanceOf(UpdateFunctionConfigurationCommand);
      expect(updateCmd.input.VpcConfig).toEqual({ SubnetIds: [], SecurityGroupIds: [] });
      expect(mockLambdaSend.mock.calls[2][0]).toBeInstanceOf(DeleteFunctionCommand);
    });

    it('returns early when pre-detach hits ResourceNotFoundException (function already gone)', async () => {
      mockLambdaSend.mockRejectedValueOnce(
        new ResourceNotFoundException({
          message: 'Function not found',
          $metadata: {},
        })
      );

      await provider.delete('Fn', 'fn-gone', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });

      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it('continues with DeleteFunction when pre-detach fails with non-NotFound error', async () => {
      mockLambdaSend
        .mockRejectedValueOnce(new Error('Throttling'))
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } }) // GetFunction (wait still runs)
        .mockResolvedValueOnce({}); // DeleteFunction
      mockEc2Send.mockResolvedValueOnce({ NetworkInterfaces: [] });

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;

      expect(mockLambdaSend).toHaveBeenCalledTimes(3);
      expect(mockLambdaSend.mock.calls[2][0]).toBeInstanceOf(DeleteFunctionCommand);
    });

    it('after DeleteFunction sleeps then lists once and per-ENI deletes in parallel', async () => {
      mockLambdaSend
        .mockResolvedValueOnce({}) // UpdateFunctionConfiguration (pre-detach)
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } }) // GetFunction (wait)
        .mockResolvedValueOnce({}); // DeleteFunction

      mockEc2Send
        .mockResolvedValueOnce({
          NetworkInterfaces: [
            {
              NetworkInterfaceId: 'eni-aaa',
              Description: 'AWS Lambda VPC ENI-fn-vpc',
              Status: 'available',
            },
          ],
        })
        .mockResolvedValueOnce({}); // DeleteNetworkInterface success

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });

      // Advance past the initial 10s sleep so list+delete fire.
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;

      // 1 list + 1 DeleteNetworkInterface (no re-list in delstack pattern).
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
      expect(mockEc2Send.mock.calls[0][0]).toBeInstanceOf(DescribeNetworkInterfacesCommand);
    });

    it('matches ENIs whose Description token is a hyphen-prefix of the physical function name (CDK suffix)', async () => {
      const physicalName = 'CdkdBenchCdkSample-ApiFunction-zZBaJTabq03f';
      const eniDescription = 'AWS Lambda VPC ENI-CdkdBenchCdkSample-ApiFunction';

      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
        .mockResolvedValueOnce({});

      mockEc2Send
        .mockResolvedValueOnce({
          NetworkInterfaces: [
            {
              NetworkInterfaceId: 'eni-cdk',
              Description: eniDescription,
              Status: 'available',
            },
          ],
        })
        .mockResolvedValueOnce({}); // DeleteNetworkInterface

      const promise = provider.delete('Fn', physicalName, 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;

      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });

    it('rejects ENIs where the function name appears only as a non-hyphen-bounded prefix', async () => {
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
        .mockResolvedValueOnce({});

      mockEc2Send.mockResolvedValueOnce({
        NetworkInterfaces: [
          {
            NetworkInterfaceId: 'eni-myfn',
            Description: 'AWS Lambda VPC ENI-myfn-abc123',
            Status: 'available',
          },
        ],
      });

      const promise = provider.delete('Fn', 'fn', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;

      // Only the list — no DeleteNetworkInterface because the token doesn't match.
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });

    it('paginates DescribeNetworkInterfaces using NextToken', async () => {
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
        .mockResolvedValueOnce({});

      mockEc2Send
        .mockResolvedValueOnce({
          NetworkInterfaces: [
            {
              NetworkInterfaceId: 'eni-x',
              Description: 'AWS Lambda VPC ENI-other-fn-xxx',
              Status: 'available',
            },
          ],
          NextToken: 'page2',
        })
        .mockResolvedValueOnce({ NetworkInterfaces: [] });

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;

      expect(mockEc2Send).toHaveBeenCalledTimes(2);
      expect(mockEc2Send.mock.calls[1][0].input.NextToken).toBe('page2');
    });

    it('retries DeleteNetworkInterface within the per-ENI budget when AWS reports in-use', async () => {
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
        .mockResolvedValueOnce({});

      mockEc2Send
        .mockResolvedValueOnce({
          NetworkInterfaces: [
            {
              NetworkInterfaceId: 'eni-inuse',
              Description: 'AWS Lambda VPC ENI-fn-vpc',
              Status: 'in-use',
            },
          ],
        })
        .mockRejectedValueOnce(new Error('InvalidParameterValue: in-use'))
        .mockResolvedValueOnce({}); // 2nd attempt succeeds (AWS detached)

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });
      // Past initial sleep + the 5s retry interval.
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(promise).resolves.toBeUndefined();
    });

    it('warns and resolves when DeleteNetworkInterface budget runs out', async () => {
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
        .mockResolvedValueOnce({});

      mockEc2Send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'DescribeNetworkInterfacesCommand') {
          return {
            NetworkInterfaces: [
              {
                NetworkInterfaceId: 'eni-stuck',
                Description: 'AWS Lambda VPC ENI-fn-vpc',
                Status: 'in-use',
              },
            ],
          };
        }
        throw new Error('In-use');
      });

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });
      // Past initial sleep + the 90s budget for DeleteNetworkInterface retries.
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await expect(promise).resolves.toBeUndefined();
    });

    it('returns gracefully when the initial DescribeNetworkInterfaces fails', async () => {
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
        .mockResolvedValueOnce({});

      mockEc2Send.mockRejectedValueOnce(new Error('ThrottlingException'));

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      // Subnet/SG provider will retry from its side, so list-failure is non-fatal.
      await expect(promise).resolves.toBeUndefined();
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });
  });
});
