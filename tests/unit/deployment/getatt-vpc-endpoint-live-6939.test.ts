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
import type { ResolverContext } from '../../../src/deployment/intrinsic-resolver/support.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';

const ID = 'vpce-0123456789abcdef0';

/**
 * go-to-k/cdkd#6940: the wait for a `pending` endpoint is the deploy's shared
 * deferred readiness of it (the provider's --no-wait create / modify defers
 * it); `undefined` when this deploy skipped no wait for it.
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
  const awaitReady = vi.fn((): Promise<void> | undefined => Promise.resolve());
  beforeEach(() => {
    mockEc2Send.mockReset();
    awaitReady.mockClear();
  });

  it("waits for a pending endpoint's deferred readiness, then serves NetworkInterfaceIds", async () => {
    mockEc2Send
      .mockResolvedValueOnce(endpoint('pending'))
      .mockResolvedValueOnce(endpoint('available'));
    const resolver = new IntrinsicFunctionResolver();
    expect(
      await resolver.resolve(
        { 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] },
        context(undefined, awaitReady)
      )
    ).toEqual(['eni-1', 'eni-2']);
    expect(mockEc2Send.mock.calls[0]![0]).toBeInstanceOf(DescribeVpcEndpointsCommand);
    expect(awaitReady).toHaveBeenCalledTimes(1);
  });

  it('serves DnsEntries in the CloudFormation <hosted zone>:<name> form', async () => {
    mockEc2Send.mockResolvedValue(endpoint('available'));
    const resolver = new IntrinsicFunctionResolver();
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'DnsEntries'] }, context(undefined, awaitReady))
    ).toEqual(['Z7HUB:vpce-1.sts.us-east-1.vpce.amazonaws.com', 'Z0578:sts.us-east-1.amazonaws.com']);
    expect(awaitReady).not.toHaveBeenCalled();
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

  it('refuses, rather than answering the endpoint id, a pending endpoint whose wait was not skipped', async () => {
    mockEc2Send.mockResolvedValue(endpoint('pending'));
    const resolver = new IntrinsicFunctionResolver();
    const error = await resolver
      .resolve({ 'Fn::GetAtt': ['Endpoint', 'DnsEntries'] }, context(undefined, () => undefined))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(String(error)).toMatch(/still pending/);
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it("a deferred readiness that fails fails the reference with the endpoint's error", async () => {
    mockEc2Send.mockResolvedValue(endpoint('pending'));
    const failure = new Error('VPC endpoint Endpoint is failed');
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['Endpoint', 'DnsEntries'] },
        context(undefined, () => Promise.reject(failure))
      )
    ).rejects.toBe(failure);
  });

  it('reads CreationTimestamp live without waiting on a pending endpoint', async () => {
    mockEc2Send.mockResolvedValue(endpoint('pending'));
    const resolver = new IntrinsicFunctionResolver();
    expect(
      await resolver.resolve(
        { 'Fn::GetAtt': ['Endpoint', 'CreationTimestamp'] },
        context(undefined, awaitReady)
      )
    ).toBe('2026-11-24T14:28:20Z');
    expect(awaitReady).not.toHaveBeenCalled();
  });

  it('refuses an endpoint EC2 no longer lists', async () => {
    mockEc2Send.mockResolvedValue({ VpcEndpoints: [] });
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] }, context())
    ).rejects.toThrow(/reported no such endpoint/);
  });

  it('a throttled read reads again after the deferred readiness, then refuses if it still fails', async () => {
    mockEc2Send.mockRejectedValue(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
    );
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] },
        context(undefined, awaitReady)
      )
    ).rejects.toThrow(/was throttled or failing/);
    expect(mockEc2Send).toHaveBeenCalledTimes(2);
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
});
