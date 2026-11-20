import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6656: a Route 53 record set whose `Name` changed is deleted and
 * created again by its provider's `update()` (one change batch), so the diff,
 * `--fail-on destructive` and the deploy's destructive approval show it as a
 * replacement, as CloudFormation does. A `Type` or `SetIdentifier` change takes
 * the same batch but stays an update, as in CloudFormation.
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
import {
  PROVIDER_REPLACEMENT_PLANNERS,
  providerReplacementReason,
} from '../../../src/analyzer/diff-calculator/provider-replacement.js';
import { recordIdentityChanged } from '../../../src/provisioning/providers/route53/shared.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

const RS = 'AWS::Route53::RecordSet';
const BASE = { HostedZoneId: 'Z123', Type: 'A', TTL: '60', ResourceRecords: ['192.0.2.1'] };

const recordOf = (properties: Record<string, unknown>, provisionedBy?: 'sdk' | 'cc-api'): ResourceState => ({
  physicalId: 'Z123|a.example.com|A',
  resourceType: RS,
  properties: { ...BASE, ...properties },
  attributes: {},
  dependencies: [],
  ...(provisionedBy && { provisionedBy }),
});

async function diff(
  recorded: Record<string, unknown>,
  desired: Record<string, unknown>,
  provisionedBy?: 'sdk' | 'cc-api'
): Promise<ResourceChange> {
  const state = {
    version: 16,
    stackName: 'S',
    region: 'us-east-1',
    resources: { Rec: recordOf(recorded, provisionedBy) },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const template = {
    Resources: { Rec: { Type: RS, Properties: { ...BASE, ...desired } } },
  } as CloudFormationTemplate;
  const changes = await new DiffCalculator().calculateDiff(state, template, async (v) => v);
  return changes.get('Rec')!;
}

describe('Route 53 record set rename through DiffCalculator (#6656)', () => {
  it('marks a Name change as a replacement the provider performs, display only', async () => {
    const change = await diff({ Name: 'a.example.com' }, { Name: 'b.example.com' });
    expect(change.changeType).toBe('UPDATE');
    expect(change.providerReplacement).toBe('its Name changed, and Route 53 keys a record on its name');
    // The provider keeps its one-batch swap: the engine is not told to replace.
    expect(change.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(false);
    const record = recordOf({ Name: 'a.example.com' });
    expect(findDestructiveChanges('S', [change], { Rec: record }).map((c) => c.impact)).toEqual([
      'WILL_REPLACE',
    ]);
  });

  it.each([
    ['a Type change', { Name: 'a.example.com' }, { Name: 'a.example.com', Type: 'AAAA' }],
    ['a SetIdentifier change', { Name: 'a.example.com', SetIdentifier: 'x' }, { Name: 'a.example.com', SetIdentifier: 'y' }],
    ['a trailing dot and a case change', { Name: 'a.example.com' }, { Name: 'A.Example.com.', TTL: '120' }],
    ['a TTL change', { Name: 'a.example.com' }, { Name: 'a.example.com', TTL: '120' }],
  ])('leaves %s an in-place update', async (_label, recorded, desired) => {
    const change = await diff(recorded, desired);
    expect(change.changeType).toBe('UPDATE');
    expect(change.providerReplacement).toBeUndefined();
  });

  it('drops the mark when a move to another hosted zone replaces the record anyway', async () => {
    const change = await diff(
      { Name: 'a.example.com' },
      { Name: 'b.example.com', HostedZoneId: 'Z999' }
    );
    expect(change.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(true);
    expect(change.providerReplacement).toBeUndefined();
  });

  it('leaves a Cloud Control record, and a name behind a secret reference, alone', async () => {
    expect(
      (await diff({ Name: 'a.example.com' }, { Name: 'b.example.com' }, 'cc-api')).providerReplacement
    ).toBeUndefined();
    expect(
      providerReplacementReason(RS, recordOf({ Name: '{{resolve:ssm:/n}}' }), { ...BASE, Name: 'b.example.com' })
    ).toBeUndefined();
  });

  it('marks exactly when the provider takes its replace branch for a name', () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ Name: 'a.example.com' }, { Name: 'b.example.com' }],
      [{ Name: 'a.example.com' }, { Name: 'a.example.com.' }],
      [{ Name: '\\052.example.com.' }, { Name: '*.example.com' }],
      [{ Name: 'a.example.com', Type: '' }, { Name: 'b.example.com' }],
      [{ Name: 'a.example.com' }, { Name: 7 }],
    ];
    for (const [recorded, desired] of cases) {
      const previous = { ...BASE, ...recorded };
      const next = { ...BASE, ...desired };
      // The provider's branch for a pair that differs only in its name.
      const branch = recordIdentityChanged(previous, next);
      expect(providerReplacementReason(RS, recordOf(recorded), next) !== undefined).toBe(branch);
    }
  });
});

describe('PROVIDER_REPLACEMENT_PLANNERS property lists (#6656)', () => {
  // gen-provider-replace-branches reads each list as the properties whose
  // change the diff marks; each must have a change the planner marks.
  const MARKING_CHANGES: Record<string, Record<string, [Record<string, unknown>, Record<string, unknown>]>> = {
    'AWS::SNS::Subscription': {
      DeliveryPolicy: [{ DeliveryPolicy: { x: 1 } }, {}],
      FilterPolicy: [
        { FilterPolicy: { k: ['a'] }, FilterPolicyScope: 'MessageBody' },
        { FilterPolicy: { k: ['b'] } },
      ],
      FilterPolicyScope: [
        { FilterPolicy: { k: ['a'] } },
        { FilterPolicy: { k: ['b'] }, FilterPolicyScope: 'MessageBody' },
      ],
      ReplayPolicy: [{ ReplayPolicy: { x: 1 } }, {}],
      SubscriptionRoleArn: [{ SubscriptionRoleArn: 'arn:aws:iam::111111111111:role/r' }, {}],
    },
    [RS]: { Name: [{ ...BASE, Name: 'a.example.com' }, { ...BASE, Name: 'b.example.com' }] },
  };

  it('every listed property has a change the planner marks', () => {
    expect([...PROVIDER_REPLACEMENT_PLANNERS.keys()].sort()).toEqual(Object.keys(MARKING_CHANGES).sort());
    for (const [type, entry] of PROVIDER_REPLACEMENT_PLANNERS) {
      expect([...entry.properties].sort()).toEqual(Object.keys(MARKING_CHANGES[type]!).sort());
      for (const [prop, [recorded, desired]] of Object.entries(MARKING_CHANGES[type]!)) {
        expect(entry.plan(recorded, desired), `${type}#${prop}`).toEqual(expect.any(String));
      }
    }
  });
});
