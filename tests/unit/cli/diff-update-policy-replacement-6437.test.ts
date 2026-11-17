import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6437 / #6472: `cdkd diff --update-policy` (or `cdk.json`
 * `context.cdkd.updatePolicy`) previews an `AutoScalingReplacingUpdate` as the
 * replacement `cdkd deploy --update-policy` makes, its readers promoted; without
 * the flag the preview shows an in-place update.
 */

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import { buildDiffTree, computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { createDiffCommand } from '../../../src/cli/commands/diff.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../src/provisioning/register-providers.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const ASG = 'AWS::AutoScaling::AutoScalingGroup';
const STACK = 'S';

const state = {
  stackName: STACK,
  region: 'us-east-1',
  version: 16,
  resources: {
    Group: {
      physicalId: 'S-Group-abc',
      resourceType: ASG,
      properties: {
        MinSize: '1',
        MaxSize: '2',
        LaunchTemplate: { LaunchTemplateId: 'lt-0abc', Version: '1' },
      },
      attributes: {},
      dependencies: [],
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
} as unknown as StackState;

const template = {
  Resources: {
    Group: {
      Type: ASG,
      Properties: {
        MinSize: '1',
        MaxSize: '2',
        LaunchTemplate: { LaunchTemplateId: 'lt-0abc', Version: '2' },
      },
      UpdatePolicy: { AutoScalingReplacingUpdate: { WillReplace: true } },
    },
    Policy: {
      Type: 'AWS::AutoScaling::ScalingPolicy',
      Properties: { AutoScalingGroupName: { Ref: 'Group' }, PolicyType: 'TargetTrackingScaling' },
    },
  },
} as unknown as CloudFormationTemplate;

const backend = {
  getState: async () => ({ state, etag: 'fake' }),
} as unknown as S3StateBackend;

function parsedDiffUpdatePolicy(args: string[]): unknown {
  const cmd = createDiffCommand();
  cmd.exitOverride();
  cmd.action(() => {});
  cmd.parse(args, { from: 'user' });
  return cmd.opts()['updatePolicy'];
}

const replaces = (changes: Map<string, { propertyChanges?: Array<{ requiresReplacement: boolean }> }>) =>
  changes.get('Group')?.propertyChanges?.some((pc) => pc.requiresReplacement) === true;

describe('cdkd diff and UpdatePolicy AutoScalingReplacingUpdate (go-to-k/cdkd#6437, #6472)', () => {
  it.each([
    [true, true, 'UPDATE'],
    [undefined, false, 'NO_CHANGE'],
    [false, false, 'NO_CHANGE'],
  ])('computeStackDiff updatePolicy=%s replaces=%s, reader %s', async (flag, replaced, reader) => {
    const { changes } = await computeStackDiff(
      state,
      template,
      'us-east-1',
      STACK,
      backend,
      new DiffCalculator(),
      flag === undefined ? {} : { updatePolicy: flag }
    );
    expect(replaces(changes)).toBe(replaced);
    expect(changes.get('Policy')?.changeType).toBe(reader);
  });

  it('blocks a replacement the deploy would refuse (a named group) only with the flag', async () => {
    const named = structuredClone(template);
    (named.Resources['Group']!.Properties as Record<string, unknown>)['AutoScalingGroupName'] =
      'fixed';
    const namedState = structuredClone(state);
    namedState.resources['Group']!.properties['AutoScalingGroupName'] = 'fixed';
    namedState.stackInstanceId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const withFlag = await computeStackDiff(namedState, named, 'us-east-1', STACK, backend, new DiffCalculator(), {
      updatePolicy: true,
    });
    expect(withFlag.blocking.join('\n')).toContain('the template names the group (AutoScalingGroupName)');
    const without = await computeStackDiff(namedState, named, 'us-east-1', STACK, backend, new DiffCalculator(), {});
    expect(without.blocking).toEqual([]);
  });

  it('blocks a replacement whose new group the deploy would create through Cloud Control', async () => {
    const ccRouted = structuredClone(template);
    // A property cdkd's SDK provider does not know routes the create to Cloud Control.
    (ccRouted.Resources['Group']!.Properties as Record<string, unknown>)['NotAnAsgProperty6437'] = 'x';
    const idState = { ...structuredClone(state), stackInstanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    // The registry the deploy routes with, through the same decision.
    const registry = new ProviderRegistry();
    registerAllProviders(registry, await loadProviderClasses());
    const createRouteOf = (input: Parameters<ProviderRegistry['getProviderFor']>[0]) =>
      registry.getProviderFor(input);
    const result = await computeStackDiff(idState, ccRouted, 'us-east-1', STACK, backend, new DiffCalculator(), {
      updatePolicy: true,
      createRouteOf,
    });
    expect(result.blocking.join('\n')).toContain('would be created through Cloud Control');
    const plain = await computeStackDiff(idState, template, 'us-east-1', STACK, backend, new DiffCalculator(), {
      updatePolicy: true,
      createRouteOf,
    });
    expect(plain.blocking).toEqual([]);
    // Without the registry the route is not checked.
    const unchecked = await computeStackDiff(idState, ccRouted, 'us-east-1', STACK, backend, new DiffCalculator(), {
      updatePolicy: true,
    });
    expect(unchecked.blocking).toEqual([]);
  });

  it('leaves a name the plan cannot resolve yet to the deploy', async () => {
    const conditional = structuredClone(template);
    (conditional.Resources['Group']!.Properties as Record<string, unknown>)['AutoScalingGroupName'] = {
      'Fn::If': ['Named', 'fixed', { Ref: 'AWS::NoValue' }],
    };
    const idState = { ...structuredClone(state), stackInstanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    const result = await computeStackDiff(idState, conditional, 'us-east-1', STACK, backend, new DiffCalculator(), {
      updatePolicy: true,
    });
    expect(result.blocking.filter((b) => b.includes('AutoScalingGroupName'))).toEqual([]);
  });

  it('buildDiffTree hands the flag to the stack diff', async () => {
    const node = await buildDiffTree({
      stackName: STACK,
      displayName: STACK,
      region: 'us-east-1',
      template,
      nestedTemplates: {},
      recursive: false,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      updatePolicy: true,
    });
    expect(replaces(node.changes)).toBe(true);
  });

  it('diff parses neither flag to undefined', () => {
    expect(parsedDiffUpdatePolicy([])).toBeUndefined();
  });

  it('diff --update-policy parses to true', () => {
    expect(parsedDiffUpdatePolicy(['--update-policy'])).toBe(true);
  });

  it('diff --no-update-policy parses to false', () => {
    expect(parsedDiffUpdatePolicy(['--no-update-policy'])).toBe(false);
  });
});
