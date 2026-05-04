import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CreateFunctionCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  DeleteFunctionCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';
import { DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';

// Mock AWS clients before importing the provider
const mockLambdaSend = vi.fn();
const mockEc2Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: {
      send: mockLambdaSend,
      // config.region is consulted by region-check.ts before treating
      // ResourceNotFoundException as idempotent delete success.
      config: { region: () => Promise.resolve('us-east-1') },
    },
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

import {
  LambdaFunctionProvider,
  inlineCodeFileNameForRuntime,
} from '../../../src/provisioning/providers/lambda-function-provider.js';
import * as zlib from 'node:zlib';

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
      // CreateFunction returns straight away — no post-create Active
      // wait. The wait moved to CustomResourceProvider so VPC-Lambda
      // stacks without Custom Resources don't pay the cost.
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

    it('does NOT wait for Active state — wait moved to CustomResourceProvider', async () => {
      // PR #121 added a post-CreateFunction State=Active wait here. It
      // doubled deploy time on benchmark stacks because every Lambda
      // paid the cost regardless of whether anything synchronously
      // invoked it. The wait now lives in CustomResourceProvider —
      // gated to the only consumer that breaks against Pending — so
      // CreateFunction returns immediately again.
      mockLambdaSend.mockResolvedValueOnce({
        FunctionName: 'fn-fast',
        FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn-fast',
      });

      await provider.create('Fn', 'AWS::Lambda::Function', {
        FunctionName: 'fn-fast',
        Role: 'arn:aws:iam::123456789012:role/exec',
        Handler: 'index.handler',
        Runtime: 'nodejs20.x',
        Code: { S3Bucket: 'b', S3Key: 'k' },
      });

      // Exactly ONE call: CreateFunction. No GetFunction polling.
      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
      expect(mockLambdaSend.mock.calls[0][0]).toBeInstanceOf(CreateFunctionCommand);
    });
  });

  describe('update', () => {
    it('sends VpcConfig change via UpdateFunctionConfiguration', async () => {
      // 1) UpdateFunctionConfiguration
      // 2) GetFunction (waitUntilFunctionUpdatedV2 — LastUpdateStatus=Successful)
      // 3) GetFunction (final attribute fetch)
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
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
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
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
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
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

    it('waits for LastUpdateStatus === Successful between UpdateFunctionConfiguration and UpdateFunctionCode', async () => {
      // UpdateFunctionConfiguration is async; calling UpdateFunctionCode
      // before LastUpdateStatus flips to Successful triggers the same
      // "function is currently in the following state" rejection that
      // bites Custom Resource Invokes after CreateFunction. Verify the
      // ordering: Update -> wait -> Update -> wait -> attribute fetch.
      mockLambdaSend
        .mockResolvedValueOnce({}) // UpdateFunctionConfiguration
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } }) // waiter #1
        .mockResolvedValueOnce({}) // UpdateFunctionCode
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } }) // waiter #2
        .mockResolvedValueOnce({
          Configuration: {
            FunctionName: 'fn-both',
            FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn-both',
          },
        });

      await provider.update(
        'Fn',
        'fn-both',
        'AWS::Lambda::Function',
        {
          Role: 'arn:aws:iam::123456789012:role/exec',
          Timeout: 60,
          Code: { S3Bucket: 'new-b', S3Key: 'new-k' },
        },
        {
          Role: 'arn:aws:iam::123456789012:role/exec',
          Timeout: 30,
          Code: { S3Bucket: 'old-b', S3Key: 'old-k' },
        }
      );

      expect(mockLambdaSend).toHaveBeenCalledTimes(5);
      expect(mockLambdaSend.mock.calls[0][0]).toBeInstanceOf(UpdateFunctionConfigurationCommand);
      // calls[1] is the waiter's GetFunction.
      expect(mockLambdaSend.mock.calls[2][0]).toBeInstanceOf(UpdateFunctionCodeCommand);
      // calls[3] is the second waiter's GetFunction.
    });

    it('throws ProvisioningError when the post-update waiter sees LastUpdateStatus === Failed', async () => {
      mockLambdaSend
        .mockResolvedValueOnce({}) // UpdateFunctionConfiguration
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Failed' } });

      await expect(
        provider.update(
          'Fn',
          'fn-bad',
          'AWS::Lambda::Function',
          {
            Role: 'arn:aws:iam::123456789012:role/exec',
            Timeout: 60,
          },
          {
            Role: 'arn:aws:iam::123456789012:role/exec',
            Timeout: 30,
          }
        )
      ).rejects.toThrow(/update did not complete/);
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
      // Past initial sleep (10s) + one 15s retry interval.
      await vi.advanceTimersByTimeAsync(30_000);
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
      // Past initial sleep + the 30-minute per-ENI budget.
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
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

  describe('delete region verification', () => {
    // The PR-2 contract: a `*NotFound` error must not be treated as
    // idempotent delete success when the AWS client's region differs from
    // the region recorded in stack state. Otherwise a destroy run with the
    // wrong region silently strips every resource from state and orphans
    // the actual AWS resources in the real region (the originating bug).

    it('treats NotFound as success when context.expectedRegion matches client region', async () => {
      mockLambdaSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'Function not found', $metadata: {} })
      );

      // Mocked client.config.region() returns 'us-east-1' (see mock above).
      await expect(
        provider.delete(
          'Fn',
          'fn-gone',
          'AWS::Lambda::Function',
          {},
          { expectedRegion: 'us-east-1' }
        )
      ).resolves.toBeUndefined();
      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    });

    it('throws ProvisioningError on NotFound when context.expectedRegion does not match client region', async () => {
      mockLambdaSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'Function not found', $metadata: {} })
      );

      await expect(
        provider.delete(
          'Fn',
          'fn-gone',
          'AWS::Lambda::Function',
          {},
          { expectedRegion: 'us-west-2' }
        )
      ).rejects.toThrow(/us-east-1.*us-west-2|us-west-2.*us-east-1/);
    });

    it('preserves existing idempotent NotFound behavior when context is omitted', async () => {
      mockLambdaSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'Function not found', $metadata: {} })
      );

      // No context argument -> back-compat path, NotFound silently succeeds.
      await expect(
        provider.delete('Fn', 'fn-gone', 'AWS::Lambda::Function', {})
      ).resolves.toBeUndefined();
    });
  });

  describe('getAttribute', () => {
    it('returns Arn from GetFunction', async () => {
      mockLambdaSend.mockResolvedValueOnce({
        Configuration: { FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-fn' },
      });

      const result = await provider.getAttribute('my-fn', 'AWS::Lambda::Function', 'Arn');
      expect(result).toBe('arn:aws:lambda:us-east-1:123:function:my-fn');
    });

    it('returns undefined for unknown attribute without calling AWS', async () => {
      const result = await provider.getAttribute('my-fn', 'AWS::Lambda::Function', 'Unknown');
      expect(result).toBeUndefined();
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });

    it('returns undefined when function does not exist', async () => {
      mockLambdaSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );

      const result = await provider.getAttribute('missing-fn', 'AWS::Lambda::Function', 'Arn');
      expect(result).toBeUndefined();
    });

    it('returns SnapStartResponse.ApplyOn from GetFunction.Configuration.SnapStart.ApplyOn', async () => {
      mockLambdaSend.mockResolvedValueOnce({
        Configuration: {
          FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-fn',
          SnapStart: { ApplyOn: 'PublishedVersions', OptimizationStatus: 'On' },
        },
      });

      const result = await provider.getAttribute(
        'my-fn',
        'AWS::Lambda::Function',
        'SnapStartResponse.ApplyOn'
      );
      expect(result).toBe('PublishedVersions');
    });

    it('returns SnapStartResponse.OptimizationStatus from GetFunction.Configuration.SnapStart.OptimizationStatus', async () => {
      mockLambdaSend.mockResolvedValueOnce({
        Configuration: {
          FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-fn',
          SnapStart: { ApplyOn: 'PublishedVersions', OptimizationStatus: 'On' },
        },
      });

      const result = await provider.getAttribute(
        'my-fn',
        'AWS::Lambda::Function',
        'SnapStartResponse.OptimizationStatus'
      );
      expect(result).toBe('On');
    });
  });

  describe('inline Code.ZipFile', () => {
    // Reads the first entry's filename out of the hand-rolled ZIP that
    // createZipFromInlineCode emits. Layout: local file header at offset 0,
    // filename length at byte 26 (uint16 LE), filename at byte 30.
    function readZipEntryName(buf: Uint8Array): string {
      const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
      const nameLen = view.readUInt16LE(26);
      return view.subarray(30, 30 + nameLen).toString('utf-8');
    }

    function readZipEntryBody(buf: Uint8Array): string {
      const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
      const compressedSize = view.readUInt32LE(18);
      const nameLen = view.readUInt16LE(26);
      const extraLen = view.readUInt16LE(28);
      const dataStart = 30 + nameLen + extraLen;
      const compressed = view.subarray(dataStart, dataStart + compressedSize);
      return zlib.inflateRawSync(compressed).toString('utf-8');
    }

    describe('inlineCodeFileNameForRuntime helper', () => {
      it('returns index.py for python runtimes', () => {
        expect(inlineCodeFileNameForRuntime('python3.12')).toBe('index.py');
        expect(inlineCodeFileNameForRuntime('python3.9')).toBe('index.py');
      });

      it('returns index.js for nodejs runtimes', () => {
        expect(inlineCodeFileNameForRuntime('nodejs20.x')).toBe('index.js');
        expect(inlineCodeFileNameForRuntime('nodejs22.x')).toBe('index.js');
      });

      it('defaults to index.js for undefined or unknown runtimes', () => {
        // Code.fromInline only supports nodejs + python; an unknown runtime
        // here means a hand-crafted template. Default to nodejs because
        // it's the most common in CDK apps.
        expect(inlineCodeFileNameForRuntime(undefined)).toBe('index.js');
        expect(inlineCodeFileNameForRuntime('ruby3.2')).toBe('index.js');
      });
    });

    it('zips inline ZipFile as index.js for nodejs runtime', async () => {
      // Regression test: previously the file was hardcoded as index.py
      // regardless of runtime, breaking nodejs Lambdas with
      // "Runtime.ImportModuleError: Cannot find module 'index'" because
      // the runtime expects index.js / index.mjs and finds neither.
      mockLambdaSend.mockResolvedValueOnce({
        FunctionName: 'fn-inline-node',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn-inline-node',
      });

      const inlineSource = "exports.handler = async () => ({ statusCode: 200 });\n";
      await provider.create('Fn', 'AWS::Lambda::Function', {
        FunctionName: 'fn-inline-node',
        Role: 'arn:aws:iam::123:role/exec',
        Handler: 'index.handler',
        Runtime: 'nodejs20.x',
        Code: { ZipFile: inlineSource },
      });

      const cmd = mockLambdaSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(CreateFunctionCommand);
      const zipBuf = cmd.input.Code.ZipFile as Uint8Array;
      expect(readZipEntryName(zipBuf)).toBe('index.js');
      expect(readZipEntryBody(zipBuf)).toBe(inlineSource);
    });

    it('zips inline ZipFile as index.py for python runtime', async () => {
      mockLambdaSend.mockResolvedValueOnce({
        FunctionName: 'fn-inline-py',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn-inline-py',
      });

      const inlineSource = "def handler(event, context):\n    return {'statusCode': 200}\n";
      await provider.create('Fn', 'AWS::Lambda::Function', {
        FunctionName: 'fn-inline-py',
        Role: 'arn:aws:iam::123:role/exec',
        Handler: 'index.handler',
        Runtime: 'python3.12',
        Code: { ZipFile: inlineSource },
      });

      const cmd = mockLambdaSend.mock.calls[0][0];
      const zipBuf = cmd.input.Code.ZipFile as Uint8Array;
      expect(readZipEntryName(zipBuf)).toBe('index.py');
      expect(readZipEntryBody(zipBuf)).toBe(inlineSource);
    });

    it('zips inline ZipFile as index.js when runtime is omitted (safe default)', async () => {
      mockLambdaSend.mockResolvedValueOnce({
        FunctionName: 'fn-no-runtime',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn-no-runtime',
      });

      await provider.create('Fn', 'AWS::Lambda::Function', {
        FunctionName: 'fn-no-runtime',
        Role: 'arn:aws:iam::123:role/exec',
        Handler: 'index.handler',
        Code: { ZipFile: "exports.handler = async () => ({});\n" },
      });

      const cmd = mockLambdaSend.mock.calls[0][0];
      const zipBuf = cmd.input.Code.ZipFile as Uint8Array;
      expect(readZipEntryName(zipBuf)).toBe('index.js');
    });

    it('uses python extension on UpdateFunctionCode when runtime is python', async () => {
      // 1) UpdateFunctionCode (Code changed)
      // 2) GetFunction (waitUntilFunctionUpdatedV2)
      // 3) GetFunction (final attribute fetch)
      mockLambdaSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
        .mockResolvedValueOnce({
          Configuration: {
            FunctionName: 'fn-py',
            FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn-py',
          },
        });

      await provider.update(
        'Fn',
        'fn-py',
        'AWS::Lambda::Function',
        {
          Role: 'arn:aws:iam::123:role/exec',
          Runtime: 'python3.12',
          Code: { ZipFile: "def handler(e, c): return {}\n" },
        },
        {
          Role: 'arn:aws:iam::123:role/exec',
          Runtime: 'python3.12',
          Code: { ZipFile: "def handler(e, c): pass\n" },
        }
      );

      const updateCmd = mockLambdaSend.mock.calls[0][0];
      expect(updateCmd).toBeInstanceOf(UpdateFunctionCodeCommand);
      const zipBuf = updateCmd.input.ZipFile as Uint8Array;
      expect(readZipEntryName(zipBuf)).toBe('index.py');
    });
  });
});
