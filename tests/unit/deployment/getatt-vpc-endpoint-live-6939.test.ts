/**
 * `Fn::GetAtt` on an `AWS::EC2::VPCEndpoint` whose record lacks the attribute
 * (go-to-k/cdkd#6939): a `--no-wait` update leaves `DnsEntries` /
 * `NetworkInterfaceIds` out while `ModifyVpcEndpoint` has the endpoint
 * `pending`. The resolver reads the endpoint live, WAITS while it is
 * `pending`, and REFUSES with the cause when no value comes, never answering
 * with the endpoint id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockEc2Send = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: () => Promise.resolve({ Account: '123456789012' }) },
    ec2: { send: mockEc2Send },
  }),
}));

import { DescribeVpcEndpointsCommand } from '@aws-sdk/client-ec2';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { vpcEndpointAttributeWait } from '../../../src/deployment/intrinsic-resolver/getatt-construct-core.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-resolver/support.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

const ID = 'vpce-0123456789abcdef0';

/**
 * Without `awaitReady` the endpoint was not left pending by this deploy (an
 * earlier --no-wait deploy's): the arm's own bounded wait. With it, the
 * deploy's shared deferred readiness of the endpoint (go-to-k/cdkd#6940).
 */
function context(
  attributes: Record<string, unknown> = { Id: ID },
  awaitReady?: () => Promise<void> | undefined
): ResolverContext {
  return {
    ...(awaitReady !== undefined && {
      deferredReadiness: {
        awaitReady,
        readAfterReady: async () => ({ kind: 'not-attempted' as const }),
      },
    }),
    template: { Resources: { Endpoint: { Type: 'AWS::EC2::VPCEndpoint', Properties: {} } } },
    resources: {
      Endpoint: {
        physicalId: ID,
        resourceType: 'AWS::EC2::VPCEndpoint',
        properties: {},
        attributes,
        dependencies: [],
      },
    },
  };
}

const endpoint = (state: string) => ({
  VpcEndpoints: [
    {
      VpcEndpointId: ID,
      State: state,
      NetworkInterfaceIds: ['eni-1', 'eni-2'],
      DnsEntries: [
        { DnsName: 'vpce-1.sts.us-east-1.vpce.amazonaws.com', HostedZoneId: 'Z7HUB' },
        { DnsName: 'sts.us-east-1.amazonaws.com', HostedZoneId: 'Z0578' },
      ],
      CreationTimestamp: new Date('2026-11-24T14:28:20.000Z'),
    },
  ],
});

describe('Fn::GetAtt AWS::EC2::VPCEndpoint live arm (#6939)', () => {
  const realWait = { ...vpcEndpointAttributeWait };
  const sleep = vi.fn((_ms: number) => Promise.resolve());
  beforeEach(() => {
    mockEc2Send.mockReset();
    sleep.mockClear();
    Object.assign(vpcEndpointAttributeWait, { polls: 3, delayMs: 3_000, sleep });
  });
  afterEach(() => {
    Object.assign(vpcEndpointAttributeWait, realWait);
  });

  it('waits for a pending endpoint, then serves NetworkInterfaceIds', async () => {
    mockEc2Send
      .mockResolvedValueOnce(endpoint('pending'))
      .mockResolvedValueOnce(endpoint('available'));
    const resolver = new IntrinsicFunctionResolver();
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] }, context())
    ).toEqual(['eni-1', 'eni-2']);
    expect(mockEc2Send.mock.calls[0]![0]).toBeInstanceOf(DescribeVpcEndpointsCommand);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('serves DnsEntries in the CloudFormation <hosted zone>:<name> form', async () => {
    mockEc2Send.mockResolvedValue(endpoint('available'));
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'DnsEntries'] }, context())).toEqual([
      'Z7HUB:vpce-1.sts.us-east-1.vpce.amazonaws.com',
      'Z0578:sts.us-east-1.amazonaws.com',
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('serves a recorded value without a read, and Id from the physical id', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const ctx = context({ Id: ID, NetworkInterfaceIds: ['eni-9'] });
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] }, ctx)).toEqual([
      'eni-9',
    ]);
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'Id'] }, context({}))).toBe(ID);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('refuses, rather than answering the endpoint id, when the wait runs out', async () => {
    mockEc2Send.mockResolvedValue(endpoint('pending'));
    const resolver = new IntrinsicFunctionResolver();
    const error = await resolver
      .resolve({ 'Fn::GetAtt': ['Endpoint', 'DnsEntries'] }, context())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(String(error)).toMatch(/stayed pending/);
    expect(mockEc2Send).toHaveBeenCalledTimes(4);
  });

  it('reads CreationTimestamp live without waiting on a pending endpoint', async () => {
    mockEc2Send.mockResolvedValue(endpoint('pending'));
    const resolver = new IntrinsicFunctionResolver();
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'CreationTimestamp'] }, context())
    ).toBe('2026-11-24T14:28:20Z');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('refuses an endpoint EC2 no longer lists', async () => {
    mockEc2Send.mockResolvedValue({ VpcEndpoints: [] });
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] }, context())
    ).rejects.toThrow(/reported no such endpoint/);
  });

  it('keeps polling through throttles, then refuses when they outlast the wait', async () => {
    mockEc2Send.mockRejectedValue(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
    );
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] }, context())
    ).rejects.toThrow(/stayed throttled or failing past the attribute wait/);
    expect(mockEc2Send).toHaveBeenCalledTimes(4);
  });

  it('refuses at once on a non-transient read failure, naming its class', async () => {
    mockEc2Send.mockRejectedValue(
      Object.assign(new Error('denied for arn:aws:sts::1:assumed-role/x'), {
        name: 'UnauthorizedOperation',
      })
    );
    const resolver = new IntrinsicFunctionResolver();
    const error = await resolver
      .resolve({ 'Fn::GetAtt': ['Endpoint', 'DnsEntries'] }, context())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(String(error)).toMatch(/UnauthorizedOperation/);
    expect(String(error)).not.toMatch(/assumed-role/);
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it('refuses a CreationTimestamp EC2 does not report', async () => {
    mockEc2Send.mockResolvedValue({ VpcEndpoints: [{ VpcEndpointId: ID, State: 'available' }] });
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'CreationTimestamp'] }, context())
    ).rejects.toThrow(/reported no CreationTimestamp/);
  });

  describe('with the command owning interrupts', () => {
    beforeEach(() => {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    });
    afterEach(() => {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    });

    it('stops the pending wait on Ctrl-C', async () => {
      mockEc2Send.mockResolvedValue(endpoint('pending'));
      vpcEndpointAttributeWait.sleep = () => {
        process.emit('SIGINT');
        return Promise.resolve();
      };
      const resolver = new IntrinsicFunctionResolver();
      const error = await resolver
        .resolve({ 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] }, context())
        .catch((e: unknown) => e);
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });
  });

  describe('an endpoint this deploy left pending (#6940)', () => {
    it("waits through the deploy's deferred readiness, not the arm's own poll", async () => {
      mockEc2Send
        .mockResolvedValueOnce(endpoint('pending'))
        .mockResolvedValueOnce(endpoint('available'));
      const awaitReady = vi.fn(() => Promise.resolve());
      const resolver = new IntrinsicFunctionResolver();
      expect(
        await resolver.resolve(
          { 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] },
          context(undefined, awaitReady)
        )
      ).toEqual(['eni-1', 'eni-2']);
      expect(awaitReady).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('a deferred readiness that fails fails the reference with its error', async () => {
      mockEc2Send.mockResolvedValue(endpoint('pending'));
      const failure = new Error('VPC endpoint Endpoint is failed');
      const resolver = new IntrinsicFunctionResolver();
      await expect(
        resolver.resolve(
          { 'Fn::GetAtt': ['Endpoint', 'DnsEntries'] },
          context(undefined, () => Promise.reject(failure))
        )
      ).rejects.toBe(failure);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('a pending endpoint this deploy did not defer keeps the bounded live wait', async () => {
      mockEc2Send
        .mockResolvedValueOnce(endpoint('pending'))
        .mockResolvedValueOnce(endpoint('available'));
      const resolver = new IntrinsicFunctionResolver();
      expect(
        await resolver.resolve(
          { 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] },
          context(undefined, () => undefined)
        )
      ).toEqual(['eni-1', 'eni-2']);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('a shared wait that ends but leaves the endpoint pending refuses, rather than serving a stale value', async () => {
      mockEc2Send.mockResolvedValue(endpoint('pending'));
      const awaitReady = vi.fn(() => Promise.resolve());
      const resolver = new IntrinsicFunctionResolver();
      const error = await resolver
        .resolve({ 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] }, context(undefined, awaitReady))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect(String(error)).toMatch(/stayed pending/);
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });

    it('a shared wait that ends with the endpoint no longer listed refuses', async () => {
      mockEc2Send.mockResolvedValueOnce(endpoint('pending')).mockResolvedValueOnce({ VpcEndpoints: [] });
      const resolver = new IntrinsicFunctionResolver();
      await expect(
        resolver.resolve(
          { 'Fn::GetAtt': ['Endpoint', 'DnsEntries'] },
          context(undefined, () => Promise.resolve())
        )
      ).rejects.toThrow(/reported no such endpoint/);
    });
  });
});

