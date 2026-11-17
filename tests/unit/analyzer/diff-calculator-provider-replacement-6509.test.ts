import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6509: an SNS subscription UPDATE that the provider carries out
 * by re-creating the subscription (a new `FilterPolicy` together with a
 * `FilterPolicyScope` change, or a removed attribute SNS cannot reset) is
 * reported as a replacement by the diff, `--fail-on destructive` and the
 * deploy's destructive approval, while the engine still calls `update()`.
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
import { markProviderReplacements } from '../../../src/analyzer/diff-calculator/provider-replacement.js';
import { planSubscriptionAttributes } from '../../../src/provisioning/providers/sns-subscription/attribute-plan.js';
import { renderDiffTree } from '../../../src/cli/commands/diff-recursive/render.js';
import { diffTreeToJson } from '../../../src/cli/commands/diff-recursive/json.js';
import type { DiffTreeNode } from '../../../src/cli/commands/diff-recursive/types.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

const SUB = 'AWS::SNS::Subscription';
const BASE = { TopicArn: 'arn:aws:sns:us-east-1:111111111111:t', Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:111111111111:q' };

function stateOf(
  properties: Record<string, unknown>,
  provisionedBy?: 'sdk' | 'cc-api'
): StackState {
  return {
    version: 16,
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      Sub: {
        physicalId: 'arn:aws:sns:us-east-1:111111111111:t:abc',
        resourceType: SUB,
        properties: { ...BASE, ...properties },
        attributes: {},
        dependencies: [],
        ...(provisionedBy && { provisionedBy }),
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

const templateOf = (properties: Record<string, unknown>): CloudFormationTemplate =>
  ({ Resources: { Sub: { Type: SUB, Properties: { ...BASE, ...properties } } } }) as CloudFormationTemplate;

async function diff(
  recorded: Record<string, unknown>,
  desired: Record<string, unknown>,
  provisionedBy?: 'sdk' | 'cc-api'
): Promise<ResourceChange> {
  const changes = await new DiffCalculator().calculateDiff(
    stateOf(recorded, provisionedBy),
    templateOf(desired),
    async (v: unknown) => v
  );
  return changes.get('Sub')!;
}

const BODY_A = { FilterPolicy: { kind: ['a'] }, FilterPolicyScope: 'MessageBody' };

describe('markProviderReplacements through DiffCalculator (#6509)', () => {
  it('marks a scope switch that also changes the policy (what CDK emits for filterPolicyWithMessageBody -> filterPolicy)', async () => {
    const change = await diff(BODY_A, { FilterPolicy: { kind: ['b'] } });
    expect(change.changeType).toBe('UPDATE');
    expect(change.providerReplacement).toBe('FilterPolicy and FilterPolicyScope change together');
    // Display only: the engine must not be told to replace it.
    expect(change.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(false);
  });

  it('marks a declared scope change with a new policy', async () => {
    const change = await diff(
      { FilterPolicy: { kind: ['a'] } },
      { FilterPolicy: { kind: ['b'] }, FilterPolicyScope: 'MessageBody' }
    );
    expect(change.providerReplacement).toBe('FilterPolicy and FilterPolicyScope change together');
  });

  it.each(['DeliveryPolicy', 'ReplayPolicy', 'SubscriptionRoleArn'])(
    'marks the removal of %s, which SNS cannot reset',
    async (name) => {
      const value = name === 'SubscriptionRoleArn' ? 'arn:aws:iam::111111111111:role/r' : { x: 1 };
      const change = await diff({ [name]: value }, {});
      expect(change.providerReplacement).toBe(`${name} removed, which SNS cannot reset`);
    }
  );

  it.each([
    ['a policy change alone', { FilterPolicy: { kind: ['a'] } }, { FilterPolicy: { kind: ['b'] } }],
    ['a scope change alone', { FilterPolicy: { kind: ['a'] } }, { FilterPolicy: { kind: ['a'] }, FilterPolicyScope: 'MessageBody' }],
    ['a policy and scope removed together', BODY_A, {}],
    ['a RawMessageDelivery toggle and a removed RedrivePolicy', { RawMessageDelivery: true, RedrivePolicy: { deadLetterTargetArn: 'x' } }, { RawMessageDelivery: false }],
  ])('leaves %s as an in-place update', async (_label, recorded, desired) => {
    const change = await diff(recorded, desired);
    expect(change.changeType).toBe('UPDATE');
    expect(change.providerReplacement).toBeUndefined();
  });

  it('leaves a Cloud Control record alone: its update is not the SDK provider', async () => {
    const change = await diff(BODY_A, { FilterPolicy: { kind: ['b'] } }, 'cc-api');
    expect(change.providerReplacement).toBeUndefined();
  });

  it('leaves a change the engine replaces anyway (a create-only Endpoint) unmarked', async () => {
    const change = await diff(BODY_A, {
      FilterPolicy: { kind: ['b'] },
      Endpoint: 'arn:aws:sqs:us-east-1:111111111111:q2',
    });
    expect(change.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(true);
    expect(change.providerReplacement).toBeUndefined();
  });
});

describe('markProviderReplacements (#6509)', () => {
  const record = (properties: Record<string, unknown>): ResourceState =>
    ({ physicalId: 'p', resourceType: SUB, properties }) as ResourceState;
  const update = (current: Record<string, unknown>, desired: Record<string, unknown>): ResourceChange => ({
    logicalId: 'Sub',
    changeType: 'UPDATE',
    resourceType: SUB,
    currentProperties: current,
    desiredProperties: desired,
    propertyChanges: [{ path: 'FilterPolicy', oldValue: 1, newValue: 2, requiresReplacement: false }],
  });

  it('is idempotent and clears a stale mark', () => {
    const change = update(BODY_A, { FilterPolicy: { kind: ['b'] } });
    const changes = new Map([['Sub', change]]);
    markProviderReplacements(changes, { Sub: record(BODY_A) });
    markProviderReplacements(changes, { Sub: record(BODY_A) });
    expect(change.providerReplacement).toBe('FilterPolicy and FilterPolicyScope change together');
    change.desiredProperties = { FilterPolicy: { kind: ['b'] }, FilterPolicyScope: 'MessageBody' };
    markProviderReplacements(changes, { Sub: record(BODY_A) });
    expect(change.providerReplacement).toBeUndefined();
  });

  it.each([
    ['MessageBody', 'FilterPolicy and FilterPolicyScope change together'],
    ['MessageAttributes', undefined],
  ])(
    'reads a live scope of %s the record no longer names (a dropped policy left it) from observedProperties',
    (scope, expected) => {
      const change = update({}, { FilterPolicy: { kind: ['c'] } });
      markProviderReplacements(new Map([['Sub', change]]), {
        Sub: { ...record({}), observedProperties: { FilterPolicyScope: scope } },
      });
      expect(change.providerReplacement).toBe(expected);
    }
  );

  it('prefers the recorded scope over the snapshot', () => {
    const change = update(BODY_A, { FilterPolicy: { kind: ['b'] }, FilterPolicyScope: 'MessageBody' });
    markProviderReplacements(new Map([['Sub', change]]), {
      Sub: { ...record(BODY_A), observedProperties: { FilterPolicyScope: 'MessageAttributes' } },
    });
    expect(change.providerReplacement).toBeUndefined();
  });

  it('skips another type and a record of another type', () => {
    const other: ResourceChange = { ...update(BODY_A, {}), resourceType: 'AWS::SNS::Topic' };
    const retyped = update({ DeliveryPolicy: { x: 1 } }, {});
    markProviderReplacements(
      new Map([
        ['Sub', retyped],
        ['T', { ...other, logicalId: 'T' }],
      ]),
      { Sub: { ...record({}), resourceType: 'AWS::SNS::Topic' }, T: record({ DeliveryPolicy: { x: 1 } }) }
    );
    expect(retyped.providerReplacement).toBeUndefined();
    expect(other.providerReplacement).toBeUndefined();
  });
});

describe('planSubscriptionAttributes keeps the provider plan (#4853)', () => {
  it('orders the policy before the scope and resets a dropped scope after a cleared policy', () => {
    expect(
      planSubscriptionAttributes({ FilterPolicy: '{"a":[1]}', FilterPolicyScope: 'MessageBody' }, {})
    ).toEqual({ kind: 'in-place', calls: [['FilterPolicy', '']] });
    expect(
      planSubscriptionAttributes({ FilterPolicy: '{"a":[1]}' }, { FilterPolicy: { a: [1] }, FilterPolicyScope: 'MessageBody' })
    ).toEqual({ kind: 'in-place', calls: [['FilterPolicyScope', 'MessageBody']] });
  });
});

describe('the replacement reaches every reader (#6509)', () => {
  const change: ResourceChange = {
    logicalId: 'Sub',
    changeType: 'UPDATE',
    resourceType: SUB,
    propertyChanges: [{ path: 'FilterPolicy', oldValue: 'a', newValue: 'b', requiresReplacement: false }],
    providerReplacement: 'FilterPolicy and FilterPolicyScope change together',
  };

  it('counts as WILL_REPLACE for --fail-on destructive and --require-approval destructive', () => {
    const record = { physicalId: 'p', resourceType: SUB, properties: {} } as ResourceState;
    expect(findDestructiveChanges('S', [change], { Sub: record }).map((c) => c.impact)).toEqual([
      'WILL_REPLACE',
    ]);
    const { providerReplacement: _r, ...unmarked } = change;
    expect(findDestructiveChanges('S', [unmarked], { Sub: record })).toEqual([]);
  });

  const node = (): DiffTreeNode =>
    ({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      changes: new Map([['Sub', change]]),
      ccApiRoutes: new Map(),
      outputChanges: [],
      adoptedOrphans: [],
      blocking: [],
      unreadable: [],
      unreadableContainers: [],
      unreadableOrphans: [],
      destructiveChanges: [],
      children: [],
    }) as unknown as DiffTreeNode;

  it('is printed under the resource line', () => {
    const lines: string[] = [];
    renderDiffTree(node(), true, (m) => lines.push(m));
    const header = lines.findIndex((l) => l.includes('[~] Sub (AWS::SNS::Subscription)'));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(lines[header + 1]).toBe(
      '      [requires replacement: FilterPolicy and FilterPolicyScope change together; deleted, then created again]'
    );
  });

  it('is carried in --json', () => {
    expect(diffTreeToJson(node()).changes[0]).toMatchObject({
      providerReplacement: 'FilterPolicy and FilterPolicyScope change together',
    });
  });
});
