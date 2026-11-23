/**
 * go-to-k/cdkd#6871: where each type takes stack tags, read from the registry
 * schema's `tagging` block (shapes copied from live DescribeType answers,
 * us-east-1, 2026-11-24), the cache keeping only successes, and the
 * property-shape fallback when the schema cannot be read.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const schedule = vi.fn();
vi.mock('../../../src/provisioning/describe-type.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/describe-type.js')>()),
  scheduleDescribeType: (type: string) => ({ promise: schedule(type) }),
}));

const {
  applyStackTagsToTemplate,
  clearStackTagTargetCache,
  getStackTagTarget,
  stackTagTargetFromSchema,
} = await import('../../../src/provisioning/stack-tag-targets.js');

const TAG_ITEM = {
  type: 'object',
  properties: { Key: { type: 'string' }, Value: { type: 'string' } },
  required: ['Key', 'Value'],
};

const sqs = {
  tagging: { taggable: true, tagUpdatable: true, tagProperty: '/properties/Tags' },
  definitions: { Tag: TAG_ITEM },
  properties: { Tags: { type: 'array', items: { $ref: '#/definitions/Tag' } } },
};

describe('stackTagTargetFromSchema (go-to-k/cdkd#6871)', () => {
  it('a list-shaped Tags through a $ref is applied as a list', () => {
    expect(stackTagTargetFromSchema('AWS::SQS::Queue', sqs)).toEqual({
      kind: 'apply',
      property: 'Tags',
      shape: 'array',
    });
  });

  it('a map-shaped Tags (SSM Parameter) is applied as a map', () => {
    expect(
      stackTagTargetFromSchema('AWS::SSM::Parameter', {
        tagging: { taggable: true, tagProperty: '/properties/Tags' },
        properties: { Tags: { type: 'object', patternProperties: { '.*': { type: 'string' } } } },
      })
    ).toEqual({ kind: 'apply', property: 'Tags', shape: 'object' });
  });

  it("follows tagProperty (Cognito's UserPoolTags)", () => {
    expect(
      stackTagTargetFromSchema('AWS::Cognito::UserPool', {
        tagging: { taggable: true, tagProperty: '/properties/UserPoolTags' },
        properties: { UserPoolTags: { type: 'object' } },
      })
    ).toEqual({ kind: 'apply', property: 'UserPoolTags', shape: 'object' });
  });

  it('skips taggable: false and tagUpdatable: false (PlacementGroup, measured)', () => {
    expect(
      stackTagTargetFromSchema('AWS::Lambda::Permission', { tagging: { taggable: false } })
    ).toEqual({ kind: 'skip' });
    expect(
      stackTagTargetFromSchema('AWS::EC2::PlacementGroup', {
        ...sqs,
        tagging: { taggable: true, tagUpdatable: false, tagProperty: '/properties/Tags' },
      })
    ).toEqual({ kind: 'skip' });
  });

  it('a schema with no tagging block and no Tags property is untaggable (IAM::Policy)', () => {
    expect(
      stackTagTargetFromSchema('AWS::IAM::Policy', { properties: { PolicyName: {} } })
    ).toEqual({ kind: 'skip' });
  });

  it('a schema with no tagging block takes the default /properties/Tags', () => {
    expect(
      stackTagTargetFromSchema('AWS::X::Y', { ...sqs, tagging: undefined })
    ).toEqual({ kind: 'apply', property: 'Tags', shape: 'array' });
  });

  it("accepts an Auto Scaling group's required PropagateAtLaunch, and no other extra member", () => {
    const withExtra = {
      ...sqs,
      definitions: {
        Tag: {
          ...TAG_ITEM,
          properties: { ...TAG_ITEM.properties, PropagateAtLaunch: { type: 'boolean' } },
          required: ['Key', 'Value', 'PropagateAtLaunch'],
        },
      },
    };
    expect(stackTagTargetFromSchema('AWS::AutoScaling::AutoScalingGroup', withExtra).kind).toBe(
      'apply'
    );
    expect(stackTagTargetFromSchema('AWS::Other::Group', withExtra).kind).toBe('unknown');
  });

  it('answers unknown for a nested tag property or a shape it cannot read', () => {
    expect(
      stackTagTargetFromSchema('AWS::X::Y', {
        tagging: { taggable: true, tagProperty: '/properties/Config/Tags' },
      }).kind
    ).toBe('unknown');
    expect(
      stackTagTargetFromSchema('AWS::X::Y', {
        tagging: { taggable: true, tagProperty: '/properties/Tags' },
        properties: { Tags: { type: 'string' } },
      }).kind
    ).toBe('unknown');
    expect(
      stackTagTargetFromSchema('AWS::X::Y', {
        tagging: { taggable: true, tagProperty: '/properties/Tags' },
        properties: { Tags: { type: 'array', items: { type: 'string' } } },
      }).kind
    ).toBe('unknown');
  });
});

describe('getStackTagTarget / applyStackTagsToTemplate (go-to-k/cdkd#6871)', () => {
  beforeEach(() => {
    schedule.mockReset();
    clearStackTagTargetCache();
  });

  it('caches a successful lookup: one DescribeType for two asks', async () => {
    schedule.mockResolvedValue({ Schema: JSON.stringify(sqs) });
    expect((await getStackTagTarget('AWS::SQS::Queue')).kind).toBe('apply');
    expect((await getStackTagTarget('AWS::SQS::Queue')).kind).toBe('apply');
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("falls back to the bundled property-shape row on a failed lookup, and does not cache it", async () => {
    schedule.mockRejectedValue(new Error('AccessDenied'));
    expect(await getStackTagTarget('AWS::SQS::Queue')).toEqual({
      kind: 'apply',
      property: 'Tags',
      shape: 'array',
    });
    expect(await getStackTagTarget('AWS::SSM::Parameter')).toEqual({
      kind: 'apply',
      property: 'Tags',
      shape: 'object',
    });
    await getStackTagTarget('AWS::SQS::Queue');
    expect(schedule.mock.calls.filter((c) => c[0] === 'AWS::SQS::Queue')).toHaveLength(2);
  });

  it('answers unknown, naming DescribeType, for a failed lookup with no fallback row', async () => {
    schedule.mockRejectedValue(new Error('AccessDenied'));
    const target = await getStackTagTarget('AWS::Not::InTheTable');
    expect(target.kind).toBe('unknown');
    expect(target.kind === 'unknown' && target.reason).toContain('cloudformation:DescribeType');
  });

  it('makes no lookup and returns the same template for a stack without tags', async () => {
    const template = { Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: {} } } };
    const warn = vi.fn();
    expect(await applyStackTagsToTemplate(template, {}, warn)).toBe(template);
    expect(await applyStackTagsToTemplate(template, undefined, warn)).toBe(template);
    expect(schedule).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('looks each type up once and warns for a type it cannot classify', async () => {
    schedule.mockImplementation(async (type: string) => {
      if (type === 'AWS::SQS::Queue') return { Schema: JSON.stringify(sqs) };
      throw new Error('AccessDenied');
    });
    const warn = vi.fn();
    const out = await applyStackTagsToTemplate(
      {
        Resources: {
          A: { Type: 'AWS::SQS::Queue', Properties: {} },
          B: { Type: 'AWS::SQS::Queue' },
          X: { Type: 'AWS::Not::InTheTable', Properties: {} },
        },
      },
      { team: 'platform' },
      warn
    );
    expect(schedule.mock.calls.map((c) => c[0]).sort()).toEqual([
      'AWS::Not::InTheTable',
      'AWS::SQS::Queue',
    ]);
    expect((out.Resources['A'] as { Properties: Record<string, unknown> }).Properties['Tags']).toEqual(
      [{ Key: 'team', Value: 'platform' }]
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('AWS::Not::InTheTable');
  });
});

describe('applyStackTagsToTemplate never rejects (go-to-k/cdkd#6871)', () => {
  it('warns and returns the template unchanged when the merge itself throws', async () => {
    const template = {
      get Resources(): never {
        throw new Error('boom');
      },
    } as unknown as Parameters<typeof applyStackTagsToTemplate>[0];
    const warn = vi.fn();
    await expect(applyStackTagsToTemplate(template, { a: '1' }, warn)).resolves.toBe(template);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
