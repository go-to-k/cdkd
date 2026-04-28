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
  });

  describe('delete', () => {
    it('does not poll EC2 when function has no VpcConfig', async () => {
      mockLambdaSend.mockResolvedValueOnce({});

      await provider.delete('Fn', 'fn-no-vpc', 'AWS::Lambda::Function', {});

      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
      const cmd = mockLambdaSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(DeleteFunctionCommand);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it('does not poll EC2 when VpcConfig has empty SubnetIds', async () => {
      mockLambdaSend.mockResolvedValueOnce({});

      await provider.delete('Fn', 'fn-empty', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: [], SecurityGroupIds: [] },
      });

      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it('treats ResourceNotFoundException as already-deleted (no ENI wait)', async () => {
      mockLambdaSend.mockRejectedValueOnce(
        new ResourceNotFoundException({
          message: 'Function not found',
          $metadata: {},
        })
      );

      await provider.delete('Fn', 'fn-gone', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });

      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it('polls DescribeNetworkInterfaces and returns once Lambda ENIs are gone', async () => {
      mockLambdaSend.mockResolvedValueOnce({}); // DeleteFunction

      // 1st poll: 1 ENI still present.
      // 2nd poll: 0 ENIs — wait completes.
      mockEc2Send
        .mockResolvedValueOnce({
          NetworkInterfaces: [
            {
              NetworkInterfaceId: 'eni-aaa',
              Description: 'AWS Lambda VPC ENI-fn-vpc-abc123',
            },
          ],
        })
        .mockResolvedValueOnce({ NetworkInterfaces: [] });

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });

      // Advance past first poll's backoff (10s).
      await vi.advanceTimersByTimeAsync(15_000);

      await promise;

      expect(mockEc2Send).toHaveBeenCalledTimes(2);
      const cmd = mockEc2Send.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(DescribeNetworkInterfacesCommand);
    });

    it('ignores ENIs whose Description does not match the function name', async () => {
      mockLambdaSend.mockResolvedValueOnce({});

      mockEc2Send.mockResolvedValueOnce({
        NetworkInterfaces: [
          {
            NetworkInterfaceId: 'eni-other',
            Description: 'AWS Lambda VPC ENI-other-function-xyz',
          },
        ],
      });

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });

      await promise;

      // Only one poll needed because the matched ENI does not belong to fn-vpc.
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });

    it('paginates DescribeNetworkInterfaces using NextToken', async () => {
      mockLambdaSend.mockResolvedValueOnce({});

      // First page returns NextToken with no matching ENIs;
      // second page returns no matching ENIs and no NextToken — count is 0.
      mockEc2Send
        .mockResolvedValueOnce({
          NetworkInterfaces: [
            {
              NetworkInterfaceId: 'eni-x',
              Description: 'AWS Lambda VPC ENI-other-fn-xxx',
            },
          ],
          NextToken: 'page2',
        })
        .mockResolvedValueOnce({
          NetworkInterfaces: [],
        });

      await provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });

      expect(mockEc2Send).toHaveBeenCalledTimes(2);
      const secondCmd = mockEc2Send.mock.calls[1][0];
      expect(secondCmd.input.NextToken).toBe('page2');
    });

    it('warns and resolves on ENI-wait timeout instead of throwing', async () => {
      mockLambdaSend.mockResolvedValueOnce({});

      // Always return one matching ENI — the wait should give up after 10min.
      mockEc2Send.mockResolvedValue({
        NetworkInterfaces: [
          {
            NetworkInterfaceId: 'eni-stuck',
            Description: 'AWS Lambda VPC ENI-fn-vpc-stuck',
          },
        ],
      });

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });

      // Advance well past the 10-minute timeout so the loop exits.
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      // Must resolve (not reject) — timeout is a soft warning.
      await expect(promise).resolves.toBeUndefined();
    });

    it('continues polling after a transient EC2 failure', async () => {
      mockLambdaSend.mockResolvedValueOnce({});

      mockEc2Send
        .mockRejectedValueOnce(new Error('ThrottlingException'))
        .mockResolvedValueOnce({ NetworkInterfaces: [] });

      const promise = provider.delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] },
      });

      // Advance past the first poll's backoff.
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(promise).resolves.toBeUndefined();
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });
  });
});
