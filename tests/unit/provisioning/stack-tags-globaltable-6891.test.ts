/**
 * go-to-k/cdkd#6891: `AWS::DynamoDB::GlobalTable` has no top-level tag
 * property, yet CloudFormation merges the stack tags into every replica's
 * `Tags` (a replica without `Tags` included), each replica's own value
 * winning on a shared key (measured us-east-1 + us-west-2, 2026-11-24).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const schedule = vi.fn();
vi.mock('../../../src/provisioning/describe-type.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/describe-type.js')>()),
  scheduleDescribeType: (type: string) => ({ promise: schedule(type) }),
}));

const { applyStackTagsToTemplate, clearStackTagTargetCache, getStackTagTarget } = await import(
  '../../../src/provisioning/stack-tag-targets.js'
);
const { applyStackTags } = await import('../../../src/provisioning/stack-tags.js');

import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const GT = 'AWS::DynamoDB::GlobalTable';
const STACK_TAGS = { shared: 'fromstack', team: 'a' };
const replicasTarget = () => ({ kind: 'replicas' }) as const;

function table(replicas: unknown): CloudFormationTemplate {
  return {
    Resources: {
      T: {
        Type: GT,
        Properties: { BillingMode: 'PAY_PER_REQUEST', Replicas: replicas },
      },
    },
  } as unknown as CloudFormationTemplate;
}

function replicasOf(template: CloudFormationTemplate): unknown {
  return (template.Resources['T'] as unknown as { Properties: Record<string, unknown> })
    .Properties['Replicas'];
}

describe('stack tags on a DynamoDB global table (go-to-k/cdkd#6891)', () => {
  beforeEach(() => {
    schedule.mockReset();
    clearStackTagTargetCache();
  });

  it('merges into every replica, a replica without Tags included, its own value winning', () => {
    const input = table([
      { Region: 'us-east-1' },
      {
        Region: 'us-west-2',
        ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 5 },
        Tags: [{ Key: 'shared', Value: 'fromresource' }],
      },
    ]);
    const snapshot = structuredClone(input);
    const { template, warnings } = applyStackTags(input, STACK_TAGS, replicasTarget);
    expect(warnings).toEqual([]);
    expect(replicasOf(template)).toEqual([
      {
        Region: 'us-east-1',
        Tags: [
          { Key: 'shared', Value: 'fromstack' },
          { Key: 'team', Value: 'a' },
        ],
      },
      {
        Region: 'us-west-2',
        ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 5 },
        Tags: [
          { Key: 'shared', Value: 'fromresource' },
          { Key: 'team', Value: 'a' },
        ],
      },
    ]);
    expect(
      (template.Resources['T'] as unknown as { Properties: Record<string, unknown> }).Properties[
        'BillingMode'
      ]
    ).toBe('PAY_PER_REQUEST');
    expect(input).toEqual(snapshot);
  });

  it.each([
    ['an intrinsic Replicas', { 'Fn::If': ['C', [{ Region: 'us-east-1' }], []] }],
    ['an Fn::If replica', [{ 'Fn::If': ['C', { Region: 'us-east-1' }, { Ref: 'AWS::NoValue' }] }]],
    ['a replica whose Tags is an intrinsic', [{ Region: 'us-east-1', Tags: { Ref: 'P' } }]],
    [
      'a replica tag whose key cdkd cannot read',
      [{ Region: 'us-east-1', Tags: [{ Key: { Ref: 'K' }, Value: 'v' }] }],
    ],
    ['an absent Replicas', undefined],
    [
      'an Fn::If tag whose branch may declare a stack key',
      [
        {
          Region: 'us-east-1',
          Tags: [{ 'Fn::If': ['C', { Key: 'team', Value: 'x' }, { Ref: 'AWS::NoValue' }] }],
        },
      ],
    ],
  ])('leaves the table untouched with one warning for %s', (_label, replicas) => {
    const input = table(replicas);
    const { template, warnings } = applyStackTags(input, STACK_TAGS, replicasTarget);
    expect(template).toBe(input);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Replicas');
  });

  it('treats a replica Tags of AWS::NoValue as no Tags, and keeps an empty Replicas list', () => {
    const noValue = applyStackTags(
      table([{ Region: 'us-east-1', Tags: { Ref: 'AWS::NoValue' } }]),
      STACK_TAGS,
      replicasTarget
    );
    expect(noValue.warnings).toEqual([]);
    expect(replicasOf(noValue.template)).toEqual([
      {
        Region: 'us-east-1',
        Tags: [
          { Key: 'shared', Value: 'fromstack' },
          { Key: 'team', Value: 'a' },
        ],
      },
    ]);
    const empty = applyStackTags(table([]), STACK_TAGS, replicasTarget);
    expect(empty.warnings).toEqual([]);
    expect(replicasOf(empty.template)).toEqual([]);
  });

  it('answers replicas without a DescribeType lookup', async () => {
    expect(await getStackTagTarget(GT)).toEqual({ kind: 'replicas' });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('applies end to end through applyStackTagsToTemplate', async () => {
    const warn = vi.fn();
    const out = await applyStackTagsToTemplate(table([{ Region: 'us-east-1' }]), STACK_TAGS, warn);
    expect(warn).not.toHaveBeenCalled();
    expect(replicasOf(out)).toEqual([
      {
        Region: 'us-east-1',
        Tags: [
          { Key: 'shared', Value: 'fromstack' },
          { Key: 'team', Value: 'a' },
        ],
      },
    ]);
    expect(schedule).not.toHaveBeenCalled();
  });
});
