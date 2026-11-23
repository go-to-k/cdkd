/**
 * go-to-k/cdkd#6871: `applyStackTags` merges a stack's `StackProps.tags` into
 * each taggable resource the way CloudFormation does (measured us-east-1,
 * 2026-11-23): both tag shapes, the resource's own key wins, untaggable and
 * `tagUpdatable: false` types get none, and nothing is guessed.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  applyStackTags,
  childStackTags,
  literalRowTags,
  sameTags,
  stackTagCandidateTypes,
  type StackTagTarget,
} from '../../../src/provisioning/stack-tags.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const LIST: StackTagTarget = { kind: 'apply', property: 'Tags', shape: 'array' };
const MAP: StackTagTarget = { kind: 'apply', property: 'Tags', shape: 'object' };

const targets: Record<string, StackTagTarget> = {
  'AWS::SQS::Queue': LIST,
  'AWS::SSM::Parameter': MAP,
  'AWS::AutoScaling::AutoScalingGroup': LIST,
  'AWS::Cognito::UserPool': { kind: 'apply', property: 'UserPoolTags', shape: 'object' },
  'AWS::EC2::PlacementGroup': { kind: 'skip' },
  'AWS::Lambda::Permission': { kind: 'skip' },
  'AWS::Odd::Thing': { kind: 'unknown', reason: 'its registry schema could not be read' },
};
const targetOf = (type: string): StackTagTarget => targets[type] ?? { kind: 'skip' };

const STACK_TAGS = { shared: 'fromstack', team: 'platform' };

function resource(template: CloudFormationTemplate, id: string): Record<string, unknown> {
  return template.Resources[id] as unknown as Record<string, unknown>;
}
function props(template: CloudFormationTemplate, id: string): Record<string, unknown> {
  return resource(template, id)['Properties'] as Record<string, unknown>;
}

describe('applyStackTags (go-to-k/cdkd#6871)', () => {
  it('merges into a list-shaped Tags, the resource-declared value winning a shared key', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Q: {
          Type: 'AWS::SQS::Queue',
          Properties: { Tags: [{ Key: 'shared', Value: 'fromresource' }] },
        },
      },
    };
    const { template: out, warnings } = applyStackTags(template, STACK_TAGS, targetOf);
    expect(warnings).toEqual([]);
    expect(props(out, 'Q')['Tags']).toEqual([
      { Key: 'shared', Value: 'fromresource' },
      { Key: 'team', Value: 'platform' },
    ]);
  });

  it('merges into a map-shaped Tags (SSM Parameter), the resource-declared value winning', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        P: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v', Tags: { shared: 'mine' } } },
      },
    };
    const out = applyStackTags(template, STACK_TAGS, targetOf).template;
    expect(props(out, 'P')['Tags']).toEqual({ shared: 'mine', team: 'platform' });
    expect(props(out, 'P')['Value']).toBe('v');
  });

  it('adds the tag property when the resource declares none, and Properties when absent', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Q: { Type: 'AWS::SQS::Queue' },
        P: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } },
      },
    };
    const out = applyStackTags(template, STACK_TAGS, targetOf).template;
    expect(props(out, 'Q')['Tags']).toEqual([
      { Key: 'shared', Value: 'fromstack' },
      { Key: 'team', Value: 'platform' },
    ]);
    expect(props(out, 'P')['Tags']).toEqual(STACK_TAGS);
  });

  it("uses the schema's tag property (Cognito UserPoolTags), not Tags", () => {
    const template: CloudFormationTemplate = {
      Resources: { U: { Type: 'AWS::Cognito::UserPool', Properties: {} } },
    };
    const out = applyStackTags(template, STACK_TAGS, targetOf).template;
    expect(props(out, 'U')['UserPoolTags']).toEqual(STACK_TAGS);
    expect(props(out, 'U')['Tags']).toBeUndefined();
  });

  it('sends PropagateAtLaunch: true for an Auto Scaling group stack tag, keeping the declared entry as is', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        G: {
          Type: 'AWS::AutoScaling::AutoScalingGroup',
          Properties: { Tags: [{ Key: 'own', Value: 'x', PropagateAtLaunch: false }] },
        },
      },
    };
    const out = applyStackTags(template, { s: 'v' }, targetOf).template;
    expect(props(out, 'G')['Tags']).toEqual([
      { Key: 'own', Value: 'x', PropagateAtLaunch: false },
      { Key: 's', Value: 'v', PropagateAtLaunch: true },
    ]);
  });

  it('skips nested-stack rows, custom resources, the CDK metadata sentinel and skip types', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        N: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } },
        C: { Type: 'Custom::Thing', Properties: { ServiceToken: 't' } },
        CR: { Type: 'AWS::CloudFormation::CustomResource', Properties: { ServiceToken: 't' } },
        M: { Type: 'AWS::CDK::Metadata', Properties: { Analytics: 'x' } },
        PG: { Type: 'AWS::EC2::PlacementGroup', Properties: { Strategy: 'cluster' } },
        LP: { Type: 'AWS::Lambda::Permission', Properties: { Action: 'a' } },
      },
    };
    const asked = vi.fn(targetOf);
    const result = applyStackTags(template, STACK_TAGS, asked);
    expect(result.template).toBe(template);
    expect(result.warnings).toEqual([]);
    expect(asked.mock.calls.map((c) => c[0]).sort()).toEqual([
      'AWS::EC2::PlacementGroup',
      'AWS::Lambda::Permission',
    ]);
  });

  it('with no stack tags returns the input itself and asks nothing (zero cost)', () => {
    const template: CloudFormationTemplate = {
      Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: {} } },
    };
    for (const tags of [undefined, {}]) {
      const asked = vi.fn(targetOf);
      const result = applyStackTags(template, tags, asked);
      expect(result.template).toBe(template);
      expect(asked).not.toHaveBeenCalled();
    }
  });

  it('never mutates the input template', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Q: { Type: 'AWS::SQS::Queue', Properties: { Tags: [{ Key: 'a', Value: 'b' }] } },
      },
    };
    const before = structuredClone(template);
    const out = applyStackTags(template, STACK_TAGS, targetOf).template;
    expect(template).toEqual(before);
    expect(out).not.toBe(template);
    expect(out.Resources).not.toBe(template.Resources);
  });

  it('warns once per type it cannot classify and leaves those resources alone', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::Odd::Thing', Properties: { Tags: [] } },
        B: { Type: 'AWS::Odd::Thing', Properties: {} },
      },
    };
    const result = applyStackTags(template, STACK_TAGS, targetOf);
    expect(result.template).toBe(template);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('AWS::Odd::Thing');
    expect(result.warnings[0]).toContain('could not be read');
  });

  it('leaves a resource whose tag property is an intrinsic untouched, warning with its logical id', () => {
    const tags = { 'Fn::If': ['C', [{ Key: 'a', Value: 'b' }], { Ref: 'AWS::NoValue' }] };
    const template: CloudFormationTemplate = {
      Resources: {
        Q: { Type: 'AWS::SQS::Queue', Properties: { Tags: tags } },
        P: { Type: 'AWS::SSM::Parameter', Properties: { Tags: { Ref: 'TagsParam' } } },
      },
    };
    const result = applyStackTags(template, STACK_TAGS, targetOf);
    expect(result.template).toBe(template);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('Q');
    expect(result.warnings[1]).toContain('P');
  });

  it('leaves a list holding an entry with a non-literal Key untouched', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Q: {
          Type: 'AWS::SQS::Queue',
          Properties: { Tags: [{ Key: { Ref: 'K' }, Value: 'v' }] },
        },
      },
    };
    const result = applyStackTags(template, STACK_TAGS, targetOf);
    expect(result.template).toBe(template);
    expect(result.warnings).toHaveLength(1);
  });

  it('keeps an Fn::If entry and appends the stack keys it cannot declare', () => {
    const conditional = { 'Fn::If': ['C', { Key: 'other', Value: 'x' }, { Ref: 'AWS::NoValue' }] };
    const template: CloudFormationTemplate = {
      Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { Tags: [conditional] } } },
    };
    const result = applyStackTags(template, STACK_TAGS, targetOf);
    expect(result.warnings).toEqual([]);
    expect(props(result.template, 'Q')['Tags']).toEqual([
      conditional,
      { Key: 'shared', Value: 'fromstack' },
      { Key: 'team', Value: 'platform' },
    ]);
  });

  it('leaves the resource alone when an Fn::If entry may or may not declare a stack key', () => {
    const conditional = { 'Fn::If': ['C', { Key: 'shared', Value: 'x' }, { Ref: 'AWS::NoValue' }] };
    const template: CloudFormationTemplate = {
      Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { Tags: [conditional] } } },
    };
    const result = applyStackTags(template, STACK_TAGS, targetOf);
    expect(result.template).toBe(template);
    expect(result.warnings).toHaveLength(1);
  });

  it('lists the candidate types without nested-stack rows or schema-less types', () => {
    expect(
      stackTagCandidateTypes({
        Resources: {
          A: { Type: 'AWS::SQS::Queue' },
          B: { Type: 'AWS::SQS::Queue' },
          N: { Type: 'AWS::CloudFormation::Stack' },
          C: { Type: 'Custom::X' },
          M: { Type: 'AWS::CDK::Metadata' },
        },
      })
    ).toEqual(['AWS::SQS::Queue']);
  });
});

describe('nested-stack row tag helpers (go-to-k/cdkd#6871)', () => {
  it('reads literal row Tags, and none for an absent value', () => {
    expect(literalRowTags([{ Key: 'a', Value: 'b' }])).toEqual({ a: 'b' });
    expect(literalRowTags(undefined)).toEqual({});
    expect(literalRowTags([{ Key: 'a', Value: { Ref: 'X' } }])).toBeUndefined();
    expect(literalRowTags({ 'Fn::If': [] })).toBeUndefined();
  });

  it("gives a child its parent's tags with the row's own winning", () => {
    expect(childStackTags({ a: '1', b: '2' }, { b: 'row', c: '3' })).toEqual({
      a: '1',
      b: 'row',
      c: '3',
    });
    expect(childStackTags(undefined, undefined)).toEqual({});
  });

  it('compares tag maps by their pairs', () => {
    expect(sameTags({ a: '1' }, { a: '1' })).toBe(true);
    expect(sameTags({ a: '1' }, { a: '2' })).toBe(false);
    expect(sameTags({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(sameTags(undefined, {})).toBe(true);
  });
});
