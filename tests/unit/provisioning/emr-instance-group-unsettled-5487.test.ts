/**
 * go-to-k/cdkd#5487: the EMR InstanceGroupConfig `update()` marks
 * `InstanceCount` before `ModifyInstanceGroups` (its resize wait can fail with
 * the resize accepted) and `AutoScalingPolicy` before Put / Remove, reads the
 * group's effective count for the engine's convergence step, and reports the
 * count as unsettled unless the group is RUNNING with every requested instance
 * up (a stuck resize included).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn().mockImplementation(() => ({
      config: { region: () => Promise.resolve('us-east-1') },
      send: (command: unknown) => mockSend(command),
    })),
  };
});
vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { EMRInstanceGroupConfigProvider } from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';

const TYPE = 'AWS::EMR::InstanceGroupConfig';
const BASE = { JobFlowId: 'j-1', InstanceRoleType: 'TASK', InstanceType: 'm5.xlarge' };

function serve(live: { requested?: number; running?: number; state?: string; policy?: boolean }): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'ListInstanceGroupsCommand') {
      return {
        InstanceGroups: [
          {
            Id: 'ig-1',
            RequestedInstanceCount: live.requested ?? 1,
            RunningInstanceCount: live.running ?? live.requested ?? 1,
            Status: { State: live.state ?? 'RUNNING' },
            ...(live.policy === true && { AutoScalingPolicy: { Status: { State: 'ATTACHED' } } }),
          },
        ],
      };
    }
    return {};
  });
}

const sent = (name: string) =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);

describe('EMR InstanceGroupConfig unsettled properties (go-to-k/cdkd#5487)', () => {
  let provider: EMRInstanceGroupConfigProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EMRInstanceGroupConfigProvider();
  });

  it('marks InstanceCount before ModifyInstanceGroups', async () => {
    serve({ requested: 2, running: 2 });
    const marks: string[] = [];
    let modifiesAtMark: number | undefined;
    await provider.update('G', 'ig-1', TYPE, { ...BASE, InstanceCount: 2 }, { ...BASE, InstanceCount: 1 }, {
      markUnsettled: (k: string) => {
        marks.push(k);
        modifiesAtMark ??= sent('ModifyInstanceGroupsCommand').length;
      },
    });
    expect(marks).toEqual(['InstanceCount']);
    expect(modifiesAtMark).toBe(0);
  });

  it('marks nothing when nothing changes', async () => {
    serve({});
    const marks: string[] = [];
    await provider.update('G', 'ig-1', TYPE, { ...BASE, InstanceCount: 1 }, { ...BASE, InstanceCount: 1 }, {
      markUnsettled: (k: string) => marks.push(k),
    });
    expect(marks).toEqual([]);
  });

  it('readUnsettled: the RUNNING count, the attached policy, and a refusal without a cluster id', async () => {
    serve({ requested: 3, running: 2, policy: true });
    const live = await provider.readUnsettled('ig-1', 'G', TYPE, new Set(['InstanceCount']), BASE);
    expect(live?.['InstanceCount']).toBe(2);
    expect(live).toHaveProperty('AutoScalingPolicy');
    await expect(provider.readUnsettled('ig-1', 'G', TYPE, new Set(['InstanceCount']), {})).rejects.toThrow(
      /no JobFlowId/
    );
  });

  it.each(['PROVISIONING', 'BOOTSTRAPPING', 'RESIZING', 'RECONFIGURING'])(
    'unsettledInTransition: InstanceCount while %s',
    async (state) => {
      serve({ state, requested: 2, running: 1 });
      expect([
        ...(await provider.unsettledInTransition('ig-1', 'G', TYPE, new Set(['InstanceCount']), BASE)),
      ]).toEqual(['InstanceCount']);
    }
  );

  it.each(['SUSPENDED', 'ARRESTED', 'RUNNING'])(
    'a group at rest in %s is not in transition, and reads its RUNNING count (so the update re-sends the resize)',
    async (state) => {
      serve({ state, requested: 2, running: 1 });
      expect(
        (await provider.unsettledInTransition('ig-1', 'G', TYPE, new Set(['InstanceCount']), BASE)).size
      ).toBe(0);
      const live = await provider.readUnsettled('ig-1', 'G', TYPE, new Set(['InstanceCount']), BASE);
      expect(live?.['InstanceCount']).toBe(1);
    }
  );

  it('unsettledInTransition: nothing without a cluster id (readUnsettled refuses with the cause), all on a failed read', async () => {
    const names = new Set(['InstanceCount', 'AutoScalingPolicy']);
    expect((await provider.unsettledInTransition('ig-1', 'G', TYPE, names, {})).size).toBe(0);
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    expect([...(await provider.unsettledInTransition('ig-1', 'G', TYPE, names, BASE))]).toEqual(['InstanceCount']);
    expect((await provider.unsettledInTransition('ig-1', 'G', TYPE, new Set(['AutoScalingPolicy']), BASE)).size).toBe(0);
  });
});
