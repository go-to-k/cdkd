/**
 * `Fn::GetAtt` on an `AWS::Connect::Instance` whose record lacks the attribute
 * (go-to-k/cdkd#6912): a `--no-wait` create returns while the instance is
 * still CREATION_IN_PROGRESS, before `ServiceRole` exists. The resolver reads
 * the instance live, WAITS for ACTIVE on a referenced `ServiceRole`, and
 * REFUSES with the cause when no value comes, never answering with the ARN.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockConnectSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...l, child: () => l }) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

vi.mock('@aws-sdk/client-connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-connect')>();
  return {
    ...actual,
    ConnectClient: class {
      send = mockConnectSend;
    },
  };
});

import { DescribeInstanceCommand } from '@aws-sdk/client-connect';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { connectInstanceAttributeWait } from '../../../src/deployment/intrinsic-resolver/getatt-construct-app.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-resolver/support.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';

const ID = '11111111-2222-3333-4444-555555555555';
const ARN = `arn:aws:connect:us-east-1:123456789012:instance/${ID}`;
const ROLE = 'arn:aws:iam::123456789012:role/aws-service-role/connect.amazonaws.com/R';

function context(): ResolverContext {
  return {
    template: { Resources: { Inst: { Type: 'AWS::Connect::Instance', Properties: {} } } },
    resources: {
      Inst: {
        physicalId: ARN,
        resourceType: 'AWS::Connect::Instance',
        properties: {},
        // What a `--no-wait` create records.
        attributes: { Id: ID, Arn: ARN },
        dependencies: [],
      },
    },
  };
}

const instance = (fields: Record<string, unknown>) => ({ Instance: { Id: ID, Arn: ARN, ...fields } });

describe('Fn::GetAtt AWS::Connect::Instance live arm (#6912)', () => {
  const realWait = { ...connectInstanceAttributeWait };
  const sleep = vi.fn((_ms: number) => Promise.resolve());
  beforeEach(() => {
    mockConnectSend.mockReset();
    sleep.mockClear();
    Object.assign(connectInstanceAttributeWait, { polls: 3, delayMs: 5_000, sleep });
  });
  afterEach(() => {
    Object.assign(connectInstanceAttributeWait, realWait);
  });

  it('waits for a CREATION_IN_PROGRESS instance and then serves ServiceRole', async () => {
    mockConnectSend
      .mockResolvedValueOnce(instance({ InstanceStatus: 'CREATION_IN_PROGRESS' }))
      .mockResolvedValueOnce(instance({ InstanceStatus: 'CREATION_IN_PROGRESS' }))
      .mockResolvedValueOnce(instance({ InstanceStatus: 'ACTIVE', ServiceRole: ROLE }));
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Inst', 'ServiceRole'] }, context())).toBe(ROLE);
    expect(mockConnectSend).toHaveBeenCalledTimes(3);
    expect(mockConnectSend.mock.calls[0]![0]).toBeInstanceOf(DescribeInstanceCommand);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('serves Arn / Id from the physical id without a read', async () => {
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Inst', 'Id'] }, context())).toBe(ID);
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Inst', 'Arn'] }, context())).toBe(ARN);
    expect(mockConnectSend).not.toHaveBeenCalled();
  });

  it('refuses, rather than answering the ARN, when the wait runs out', async () => {
    mockConnectSend.mockResolvedValue(instance({ InstanceStatus: 'CREATION_IN_PROGRESS' }));
    const resolver = new IntrinsicFunctionResolver();
    const error = await resolver
      .resolve({ 'Fn::GetAtt': ['Inst', 'ServiceRole'] }, context())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(String(error)).toMatch(/stayed CREATION_IN_PROGRESS/);
    expect(mockConnectSend).toHaveBeenCalledTimes(4);
  });

  it('keeps polling through a throttled read during the ServiceRole wait', async () => {
    mockConnectSend
      .mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .mockResolvedValueOnce(instance({ InstanceStatus: 'ACTIVE', ServiceRole: ROLE }));
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Inst', 'ServiceRole'] }, context())).toBe(ROLE);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('reads InstanceStatus live when the record lacks it (a --no-wait create), without waiting', async () => {
    mockConnectSend.mockResolvedValue(instance({ InstanceStatus: 'ACTIVE' }));
    const ctx = context();
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Inst', 'InstanceStatus'] }, ctx)).toBe('ACTIVE');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('refuses a CREATION_FAILED instance without waiting', async () => {
    mockConnectSend.mockResolvedValue(instance({ InstanceStatus: 'CREATION_FAILED' }));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Inst', 'ServiceRole'] }, context())
    ).rejects.toThrow(/CREATION_FAILED/);
    expect(sleep).not.toHaveBeenCalled();
  });
});
