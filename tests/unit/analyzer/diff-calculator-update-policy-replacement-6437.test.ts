import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6437: under `--update-policy` the diff turns an Auto Scaling
 * group's trigger property change into a replacement when the template
 * declares `AutoScalingReplacingUpdate` `WillReplace: true`, so the group's
 * readers (a scaling policy naming it by `Ref`) are promoted, and `cdkd diff`
 * and the plan-time prompt show a replacement. Without the flag, an update.
 */

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: () =>
        Promise.reject(
          Object.assign(new Error('not authorized'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        ),
    },
  }),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { findDestructiveChanges } from '../../../src/analyzer/destructive-changes.js';
import { markUpdatePolicyReplacements } from '../../../src/analyzer/diff-calculator/update-policy-replacement.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

const ASG = 'AWS::AutoScaling::AutoScalingGroup';
const LT = (version: string) => ({ LaunchTemplateId: 'lt-0abc', Version: version });

function stateOf(): StackState {
  return {
    version: 16,
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      Lt: {
        physicalId: 'lt-0abc',
        resourceType: 'AWS::EC2::LaunchTemplate',
        properties: { LaunchTemplateData: { UserData: 'v1' } },
        attributes: { LatestVersionNumber: '1' },
        dependencies: [],
      },
      Group: {
        physicalId: 'S-Group-abc',
        resourceType: ASG,
        properties: { MinSize: '1', MaxSize: '2', LaunchTemplate: LT('1') },
        attributes: {},
        dependencies: ['Lt'],
      },
      Policy: {
        physicalId: 'policy-arn',
        resourceType: 'AWS::AutoScaling::ScalingPolicy',
        properties: { AutoScalingGroupName: 'S-Group-abc', PolicyType: 'TargetTrackingScaling' },
        attributes: {},
        dependencies: ['Group'],
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

function templateOf(
  updatePolicy: Record<string, unknown> | undefined,
  group: Record<string, unknown>,
  ltData: Record<string, unknown> = { UserData: 'v1' }
): CloudFormationTemplate {
  return {
    Resources: {
      Lt: { Type: 'AWS::EC2::LaunchTemplate', Properties: { LaunchTemplateData: ltData } },
      Group: {
        Type: ASG,
        Properties: group,
        ...(updatePolicy && { UpdatePolicy: updatePolicy }),
      },
      Policy: {
        Type: 'AWS::AutoScaling::ScalingPolicy',
        Properties: { AutoScalingGroupName: { Ref: 'Group' }, PolicyType: 'TargetTrackingScaling' },
      },
    },
  } as CloudFormationTemplate;
}

const resolver =
  (state: StackState) =>
  async (value: unknown): Promise<unknown> => {
    const resolve = (v: unknown): unknown => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(resolve);
      const obj = v as Record<string, unknown>;
      if ('Ref' in obj && Object.keys(obj).length === 1) {
        return state.resources[obj['Ref'] as string]!.physicalId;
      }
      if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
        const [id, attr] = obj['Fn::GetAtt'] as [string, string];
        return state.resources[id]!.attributes?.[attr];
      }
      return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, resolve(x)]));
    };
    return resolve(value);
  };

const WILL_REPLACE = { AutoScalingReplacingUpdate: { WillReplace: true } };

async function diff(
  template: CloudFormationTemplate,
  updatePolicy: boolean | undefined
): Promise<Map<string, ResourceChange>> {
  const state = stateOf();
  const calc = new DiffCalculator();
  return calc.calculateDiff(
    state,
    template,
    resolver(state),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    updatePolicy
  );
}

describe('DiffCalculator AutoScalingReplacingUpdate (go-to-k/cdkd#6437)', () => {
  const direct = { MinSize: '1', MaxSize: '2', LaunchTemplate: LT('2') };

  it('with --update-policy, replaces the group and promotes its Ref reader', async () => {
    const changes = await diff(templateOf(WILL_REPLACE, direct), true);
    const group = changes.get('Group')!;
    const pc = group.propertyChanges!.find((p) => p.path.startsWith('LaunchTemplate'))!;
    expect(pc.requiresReplacement).toBe(true);
    expect(pc.updatePolicyReplacement).toBe(true);
    const policy = changes.get('Policy')!;
    expect(policy.changeType).toBe('UPDATE');
    expect(policy.propertyChanges!.some((p) => p.path === 'AutoScalingGroupName')).toBe(true);
    expect(
      findDestructiveChanges('S', [...changes.values()], stateOf().resources).map((c) => [
        c.logicalId,
        c.impact,
      ])
    ).toContainEqual(['Group', 'WILL_REPLACE']);
  });

  it.each([
    ['without the flag', WILL_REPLACE, undefined],
    ['under --no-update-policy', WILL_REPLACE, false],
    ['for WillReplace: false', { AutoScalingReplacingUpdate: { WillReplace: false } }, true],
    ['for a rolling update', { AutoScalingRollingUpdate: { MaxBatchSize: 1 } }, true],
  ])('keeps an update %s, and promotes no reader', async (_label, policy, flag) => {
    const changes = await diff(templateOf(policy, direct), flag);
    const group = changes.get('Group')!;
    expect(group.changeType).toBe('UPDATE');
    expect(group.propertyChanges!.some((p) => p.requiresReplacement)).toBe(false);
    expect(changes.get('Policy')!.changeType).toBe('NO_CHANGE');
  });

  it('replaces nothing for a change outside the trigger properties', async () => {
    const changes = await diff(
      templateOf(WILL_REPLACE, { MinSize: '1', MaxSize: '3', LaunchTemplate: LT('1') }),
      true
    );
    expect(changes.get('Group')!.propertyChanges!.some((p) => p.requiresReplacement)).toBe(false);
    expect(changes.get('Policy')!.changeType).toBe('NO_CHANGE');
  });

  it('does not replace for a reordered subnet list', async () => {
    const state = stateOf();
    state.resources['Group']!.properties['VPCZoneIdentifier'] = ['subnet-a', 'subnet-b'];
    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(
      state,
      templateOf(WILL_REPLACE, {
        MinSize: '1',
        MaxSize: '2',
        LaunchTemplate: LT('1'),
        VPCZoneIdentifier: ['subnet-b', 'subnet-a'],
      }),
      resolver(state),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    const group = changes.get('Group')!;
    expect(group.propertyChanges?.some((p) => p.requiresReplacement) ?? false).toBe(false);
    expect(changes.get('Policy')!.changeType).toBe('NO_CHANGE');
  });

  it('never marks a change promoted only for a NoEcho value', () => {
    const changes = new Map<string, ResourceChange>([
      [
        'Group',
        {
          logicalId: 'Group',
          changeType: 'UPDATE',
          resourceType: ASG,
          desiredProperties: { LaunchTemplate: LT('2') },
          currentProperties: { LaunchTemplate: LT('1') },
          propertyChanges: [
            {
              path: 'LaunchTemplate',
              oldValue: LT('1'),
              newValue: LT('2'),
              requiresReplacement: false,
              noEchoPromoted: true,
            },
          ],
        } as ResourceChange,
      ],
    ]);
    markUpdatePolicyReplacements(changes, templateOf(WILL_REPLACE, {}));
    const pc = changes.get('Group')!.propertyChanges![0]!;
    expect(pc.requiresReplacement).toBe(false);
    expect(pc.updatePolicyReplacement).toBeUndefined();
  });

  it('marks a launch template version read through Fn::GetAtt as a ceiling replacement', async () => {
    const viaGetAtt = {
      MinSize: '1',
      MaxSize: '2',
      LaunchTemplate: {
        LaunchTemplateId: { Ref: 'Lt' },
        Version: { 'Fn::GetAtt': ['Lt', 'LatestVersionNumber'] },
      },
    };
    const changes = await diff(templateOf(WILL_REPLACE, viaGetAtt, { UserData: 'v2' }), true);
    const pc = changes
      .get('Group')!
      .propertyChanges?.find((p) => p.path.startsWith('LaunchTemplate'));
    expect(pc).toBeDefined();
    expect(pc!.requiresReplacement).toBe(true);
    expect(pc!.updatePolicyReplacement).toBe(true);
    expect(changes.get('Policy')!.changeType).toBe('UPDATE');
  });
});
