import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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

import { EMRInstanceGroupConfigProvider } from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';
import {
  InvalidRequestException,
  ModifyInstanceGroupsCommand,
  RemoveAutoScalingPolicyCommand,
} from '@aws-sdk/client-emr';

/**
 * go-to-k/cdkd#6751: deleting a TASK group scales it to 0, which EMR accepts
 * with an automatic scaling policy attached, but the policy's CloudWatch
 * alarm and Application Auto Scaling target outlived the group (live probe,
 * us-east-1). CloudFormation's handler sent RemoveAutoScalingPolicy, then
 * ModifyInstanceGroups to 0.
 */
const TYPE = 'AWS::EMR::InstanceGroupConfig';
const CLUSTER = 'j-1A2B3C4D5E6F7';
const GROUP = 'ig-ABCDEF123456';
const POLICY = {
  Constraints: { MinCapacity: 1, MaxCapacity: 2 },
  Rules: [],
};
const PROPS = { JobFlowId: CLUSTER, InstanceRole: 'TASK', InstanceType: 'm5.xlarge', InstanceCount: 1 };

const sent = (): string[] => mockSend.mock.calls.map(([cmd]) => cmd.constructor.name);

describe('EMR instance group delete with an automatic scaling policy (#6751)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
  });

  it('removes the automatic scaling policy before scaling the TASK group to 0', async () => {
    mockSend.mockResolvedValue({});
    await new EMRInstanceGroupConfigProvider().delete('Grp', GROUP, TYPE, {
      ...PROPS,
      AutoScalingPolicy: POLICY,
    });
    expect(sent()).toEqual(['RemoveAutoScalingPolicyCommand', 'ModifyInstanceGroupsCommand']);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(RemoveAutoScalingPolicyCommand);
    expect(mockSend.mock.calls[0][0].input).toEqual({ ClusterId: CLUSTER, InstanceGroupId: GROUP });
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(ModifyInstanceGroupsCommand);
  });

  it('sends no RemoveAutoScalingPolicy for a group declaring no policy', async () => {
    mockSend.mockResolvedValue({});
    await new EMRInstanceGroupConfigProvider().delete('Grp', GROUP, TYPE, PROPS);
    expect(sent()).toEqual(['ModifyInstanceGroupsCommand']);
  });

  it('scales to 0 without a warning when AWS reports the policy already gone', async () => {
    const notFound = Object.assign(
      new Error(`Auto Scaling policy was not found for instance group '${GROUP}'.`),
      { name: 'ValidationException' }
    );
    mockSend.mockRejectedValueOnce(notFound).mockResolvedValueOnce({});
    await new EMRInstanceGroupConfigProvider().delete('Grp', GROUP, TYPE, {
      ...PROPS,
      AutoScalingPolicy: POLICY,
    });
    expect(sent()).toEqual(['RemoveAutoScalingPolicyCommand', 'ModifyInstanceGroupsCommand']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and still scales to 0 when the policy removal fails', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    mockSend.mockRejectedValueOnce(denied).mockResolvedValueOnce({});
    await new EMRInstanceGroupConfigProvider().delete('Grp', GROUP, TYPE, {
      ...PROPS,
      AutoScalingPolicy: POLICY,
    });
    expect(sent()).toEqual(['RemoveAutoScalingPolicyCommand', 'ModifyInstanceGroupsCommand']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      `Removing the automatic scaling policy of EMR instance group ${GROUP} failed`
    );
  });

  it('stays quiet when the cluster is already gone for both calls', async () => {
    const gone = (): InvalidRequestException =>
      new InvalidRequestException({ $metadata: {}, message: 'Cluster id is not valid.' });
    mockSend.mockRejectedValueOnce(gone()).mockRejectedValueOnce(gone());
    await new EMRInstanceGroupConfigProvider().delete('Grp', GROUP, TYPE, {
      ...PROPS,
      AutoScalingPolicy: POLICY,
    });
    expect(sent()).toEqual(['RemoveAutoScalingPolicyCommand', 'ModifyInstanceGroupsCommand']);
    expect(warn).not.toHaveBeenCalled();
  });
});
