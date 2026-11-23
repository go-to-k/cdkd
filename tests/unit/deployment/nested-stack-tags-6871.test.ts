/**
 * go-to-k/cdkd#6871: a nested-stack row whose child's effective stack tags
 * differ from the ones its child was last deployed with updates, so the
 * child's engine runs and re-tags the child's resources (CloudFormation
 * updates a nested stack on a stack-tag-only change).
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  expectedNestedStackTags,
  markStackTagChildRuns,
  nestedRowsNeedingTagRun,
  nestedStackTagsField,
  recordedNestedStackTagsOf,
} from '../../../src/deployment/nested-stack-tags.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state/changes.js';

const ROW = 'AWS::CloudFormation::Stack';
const template = (rowTags?: unknown): CloudFormationTemplate => ({
  Resources: {
    Child: {
      Type: ROW,
      Properties: { TemplateURL: 'u', ...(rowTags !== undefined && { Tags: rowTags }) },
    },
    Q: { Type: 'AWS::SQS::Queue' },
  },
});
const recorded = (nestedStackTags?: unknown) => ({
  resources: { Child: { resourceType: ROW, physicalId: 'arn', properties: {} } } as never,
  ...(nestedStackTags !== undefined && { nestedStackTags: nestedStackTags as never }),
});

describe('nested stack tag runs (go-to-k/cdkd#6871)', () => {
  it("merges the parent's tags with the row's own, the row winning", () => {
    expect(
      expectedNestedStackTags(template([{ Key: 'b', Value: 'row' }]), { a: '1', b: '2' })
    ).toEqual(new Map([['Child', { a: '1', b: 'row' }]]));
  });

  it('marks a row with non-literal Tags as unknowable', () => {
    expect(
      expectedNestedStackTags(template([{ Key: 'b', Value: { Ref: 'P' } }]), { a: '1' }).get(
        'Child'
      )
    ).toBeUndefined();
  });

  it('runs a tagged child once for a record without the field (catch-up)', () => {
    const expected = expectedNestedStackTags(template(), { a: '1' });
    expect(nestedRowsNeedingTagRun(expected, recorded())).toEqual(new Set(['Child']));
  });

  it('costs nothing for an untagged child and a record without the field', () => {
    const expected = expectedNestedStackTags(template(), undefined);
    expect(nestedRowsNeedingTagRun(expected, recorded())).toEqual(new Set());
  });

  it('runs nothing when the recorded tags match', () => {
    const expected = expectedNestedStackTags(template(), { a: '1' });
    expect(nestedRowsNeedingTagRun(expected, recorded({ Child: { a: '1' } }))).toEqual(new Set());
  });

  it('runs the child on a changed, added or removed tag', () => {
    for (const [stackTags, field] of [
      [{ a: '2' }, { Child: { a: '1' } }],
      [{ a: '1', b: '2' }, { Child: { a: '1' } }],
      [undefined, { Child: { a: '1' } }],
    ] as const) {
      const expected = expectedNestedStackTags(template(), stackTags);
      expect(nestedRowsNeedingTagRun(expected, recorded(field))).toEqual(new Set(['Child']));
    }
  });

  it("runs the child when only the row's own Tags changed", () => {
    const expected = expectedNestedStackTags(template([{ Key: 'r', Value: '2' }]), undefined);
    expect(nestedRowsNeedingTagRun(expected, recorded({ Child: { r: '1' } }))).toEqual(
      new Set(['Child'])
    );
  });

  it('runs every recorded row on a malformed field, and an unknowable one always', () => {
    const expected = expectedNestedStackTags(template(), undefined);
    expect(recordedNestedStackTagsOf({ nestedStackTags: 'x' as never })).toBeUndefined();
    expect(nestedRowsNeedingTagRun(expected, recorded('x'))).toEqual(new Set(['Child']));
    const unknowable = expectedNestedStackTags(template({ Ref: 'TagList' }), undefined);
    expect(nestedRowsNeedingTagRun(unknowable, recorded({}))).toEqual(new Set(['Child']));
  });

  it('never runs a row with no nested-stack record (its CREATE runs the child)', () => {
    const expected = expectedNestedStackTags(template(), { a: '1' });
    expect(nestedRowsNeedingTagRun(expected, { resources: {} })).toEqual(new Set());
  });

  it('records only rows with known, non-empty tags', () => {
    expect(
      nestedStackTagsField(
        new Map<string, Record<string, string> | undefined>([
          ['A', { a: '1' }],
          ['B', {}],
          ['C', undefined],
        ])
      )
    ).toEqual({ A: { a: '1' } });
    expect(nestedStackTagsField(new Map([['B', {}]]))).toBeUndefined();
  });

  it('turns a NO_CHANGE row into a property-less UPDATE and marks it', () => {
    const changes = new Map<string, ResourceChange>([
      ['Child', { logicalId: 'Child', changeType: 'NO_CHANGE', resourceType: ROW }],
      ['Q', { logicalId: 'Q', changeType: 'NO_CHANGE', resourceType: 'AWS::SQS::Queue' }],
    ]);
    markStackTagChildRuns(changes, new Set(['Child', 'Q']));
    expect(changes.get('Child')).toMatchObject({
      changeType: 'UPDATE',
      propertyChanges: [],
      nestedStackTagsChanged: true,
    });
    expect(changes.get('Q')?.changeType).toBe('NO_CHANGE');
  });
});

describe('stackInstanceIdCarriedFrom carries nestedStackTags (go-to-k/cdkd#6871)', () => {
  it('carries the field verbatim, so a non-deploy writer does not re-run every tagged child', async () => {
    const { stackInstanceIdCarriedFrom } = await import('../../../src/types/state.js');
    expect(stackInstanceIdCarriedFrom({ nestedStackTags: { Child: { a: '1' } } })).toEqual({
      nestedStackTags: { Child: { a: '1' } },
    });
    expect(stackInstanceIdCarriedFrom({})).toEqual({});
  });
});

describe('settleStackTagChildRuns (go-to-k/cdkd#6871, code review M2)', () => {
  const changesFor = () =>
    new Map<string, ResourceChange>([
      ['Child', { logicalId: 'Child', changeType: 'NO_CHANGE', resourceType: ROW }],
    ]);
  const refTags = [{ Key: 'env', Value: { Ref: 'Env' } }];

  it('resolves a non-literal row Tags with the diff resolver, so an unchanged row is not re-run', async () => {
    const { settleStackTagChildRuns } = await import('../../../src/deployment/nested-stack-tags.js');
    const changes = changesFor();
    const expected = await settleStackTagChildRuns({
      changes,
      template: template(refTags),
      stackTags: undefined,
      state: recorded({ Child: { env: 'prod' } }),
      resolve: async () => [{ Key: 'env', Value: 'prod' }],
      secrets: undefined,
    });
    expect(expected.get('Child')).toEqual({ env: 'prod' });
    expect(changes.get('Child')?.changeType).toBe('NO_CHANGE');
  });

  it('runs the row when the resolved value moved', async () => {
    const { settleStackTagChildRuns } = await import('../../../src/deployment/nested-stack-tags.js');
    const changes = changesFor();
    await settleStackTagChildRuns({
      changes,
      template: template(refTags),
      stackTags: undefined,
      state: recorded({ Child: { env: 'prod' } }),
      resolve: async () => [{ Key: 'env', Value: 'dev' }],
      secrets: undefined,
    });
    expect(changes.get('Child')).toMatchObject({ changeType: 'UPDATE', nestedStackTagsChanged: true });
  });

  it('keeps a row it cannot resolve unknowable: it runs', async () => {
    const { settleStackTagChildRuns } = await import('../../../src/deployment/nested-stack-tags.js');
    const changes = changesFor();
    const expected = await settleStackTagChildRuns({
      changes,
      template: template(refTags),
      stackTags: undefined,
      state: recorded({ Child: { env: 'prod' } }),
      resolve: async () => {
        throw new Error('unresolvable');
      },
      secrets: undefined,
    });
    expect(expected.get('Child')).toBeUndefined();
    expect(changes.get('Child')?.changeType).toBe('UPDATE');
  });
});

describe('settleStackTagChildRuns never records a secret (go-to-k/cdkd#6871, security review)', () => {
  it('leaves a row unknowable when its resolved tags hold a NoEcho needle of the bag', async () => {
    const { settleStackTagChildRuns } = await import('../../../src/deployment/nested-stack-tags.js');
    const { recordLogOnlyValue } = await import('../../../src/deployment/secret-redaction.js');
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, 'noecho-6871-value');
    const changes = new Map<string, ResourceChange>([
      ['Child', { logicalId: 'Child', changeType: 'NO_CHANGE', resourceType: ROW }],
    ]);
    const expected = await settleStackTagChildRuns({
      changes,
      template: template([{ Key: 'k', Value: { Ref: 'Secret' } }]),
      stackTags: undefined,
      state: recorded({}),
      resolve: async () => [{ Key: 'k', Value: 'noecho-6871-value' }],
      secrets: bag,
    });
    expect(expected.get('Child')).toBeUndefined();
    expect(JSON.stringify(nestedStackTagsField(expected) ?? {})).not.toContain('noecho-6871-value');
    expect(changes.get('Child')?.changeType).toBe('UPDATE');
  });
});
