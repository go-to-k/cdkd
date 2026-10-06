import { describe, it, expect } from 'vite-plus/test';
import {
  findDestructiveChanges,
  formatDestructiveChange,
  withConstructPath,
} from '../../../src/analyzer/destructive-changes.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

const rec = (extra: Partial<ResourceState> = {}): ResourceState =>
  ({ physicalId: 'p', resourceType: 'AWS::DynamoDB::Table', properties: {}, ...extra }) as ResourceState;

const update = (propertyChanges: ResourceChange['propertyChanges'], resourceType = 'AWS::DynamoDB::Table'): ResourceChange => ({
  logicalId: 'T',
  changeType: 'UPDATE',
  resourceType,
  propertyChanges,
});

const impactOf = (change: ResourceChange, record?: ResourceState) =>
  findDestructiveChanges('S', [change], record ? { [change.logicalId]: record } : {}).map(
    (c) => c.impact
  );

describe('findDestructiveChanges', () => {
  it.each([
    [undefined, 'WILL_DESTROY'],
    ['Delete', 'WILL_DESTROY'],
    ['Snapshot', 'WILL_DESTROY'],
    ['Retain', 'WILL_ORPHAN'],
    // A deploy keeps it on removal too (`shouldRetainResource`).
    ['RetainExceptOnCreate', 'WILL_ORPHAN'],
  ] as const)('a DELETE under DeletionPolicy %s is %s', (policy, impact) => {
    const change: ResourceChange = { logicalId: 'T', changeType: 'DELETE', resourceType: 'AWS::DynamoDB::Table' };
    expect(impactOf(change, rec(policy ? { deletionPolicy: policy } : {}))).toEqual([impact]);
  });

  it('a create-only property change WILL replace', () => {
    expect(
      impactOf(update([{ path: 'TableName', oldValue: 'a', newValue: 'b', requiresReplacement: true }]), rec())
    ).toEqual(['WILL_REPLACE']);
  });

  it('a Type change WILL replace, named by its recorded type', () => {
    const found = findDestructiveChanges('S', [update([], 'AWS::S3::Bucket')], { T: rec() });
    expect(found).toEqual([
      { stackName: 'S', logicalId: 'T', resourceType: 'AWS::DynamoDB::Table', impact: 'WILL_REPLACE' },
    ]);
  });

  it.each(['inPlacePropagated', 'replacementPropagated'] as const)(
    'a replacement ceiling (%s) MAY replace',
    (marker) => {
      expect(
        impactOf(
          update([
            { path: 'TableName', oldValue: 'a', newValue: 'b', requiresReplacement: true, [marker]: true },
          ]),
          rec()
        )
      ).toEqual(['MAY_REPLACE']);
    }
  );

  it('a firm replacement wins over a ceiling on the same resource', () => {
    expect(
      impactOf(
        update([
          { path: 'A', oldValue: 1, newValue: 2, requiresReplacement: true, inPlacePropagated: true },
          { path: 'B', oldValue: 1, newValue: 2, requiresReplacement: true },
        ]),
        rec()
      )
    ).toEqual(['WILL_REPLACE']);
  });

  it('is empty for an in-place update, a create and no change', () => {
    const changes: ResourceChange[] = [
      update([{ path: 'BillingMode', oldValue: 'a', newValue: 'b', requiresReplacement: false }]),
      { logicalId: 'N', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue' },
      { logicalId: 'U', changeType: 'NO_CHANGE', resourceType: 'AWS::SQS::Queue' },
    ];
    expect(findDestructiveChanges('S', changes, { T: rec(), U: rec() })).toEqual([]);
  });

  it('ignores AWS::CDK::Metadata, which is not a physical resource', () => {
    const change: ResourceChange = { logicalId: 'CDKMetadata', changeType: 'DELETE', resourceType: 'AWS::CDK::Metadata' };
    expect(findDestructiveChanges('S', [change], { CDKMetadata: rec({ resourceType: 'AWS::CDK::Metadata' }) })).toEqual([]);
  });

  it('reads an OWN record only', () => {
    const change: ResourceChange = { logicalId: 'toString', changeType: 'DELETE', resourceType: 'AWS::SQS::Queue' };
    expect(findDestructiveChanges('S', [change], {}).map((c) => c.impact)).toEqual(['WILL_DESTROY']);
  });

  it('takes the construct path from the template metadata', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        T: { Type: 'AWS::DynamoDB::Table', Metadata: { 'aws:cdk:path': 'S/Data/Table/Resource' } },
      },
    } as CloudFormationTemplate;
    const [found] = findDestructiveChanges(
      'S',
      [update([{ path: 'TableName', oldValue: 'a', newValue: 'b', requiresReplacement: true }])],
      { T: rec() },
      template
    );
    expect(found?.constructPath).toBe('S/Data/Table/Resource');
    expect(formatDestructiveChange(found!)).toBe('S: AWS::DynamoDB::Table Data/Table T will be replaced');
  });
});

describe('formatDestructiveChange', () => {
  it('omits an absent construct path', () => {
    expect(
      formatDestructiveChange({ stackName: 'S', logicalId: 'Q', resourceType: 'AWS::SQS::Queue', impact: 'WILL_ORPHAN' })
    ).toBe('S: AWS::SQS::Queue Q will be orphaned');
  });

  it('keeps a trailing Default only when it is the whole path below the stack', () => {
    expect(
      formatDestructiveChange({
        stackName: 'S',
        logicalId: 'Q',
        resourceType: 'AWS::SQS::Queue',
        constructPath: 'S/Default',
        impact: 'MAY_REPLACE',
      })
    ).toBe('S: AWS::SQS::Queue Default Q may be replaced');
  });

  it('cannot be forged onto a second line by a template value', () => {
    const line = formatDestructiveChange({
      stackName: 'S',
      logicalId: 'Q\nS: AWS::SQS::Queue Fake will be destroyed',
      resourceType: 'AWS::SQS::Queue',
      impact: 'WILL_DESTROY',
    });
    expect(line).not.toContain('\n');
  });
});

describe('constructPath from state', () => {
  it('names a removed resource by the path its last deploy recorded', () => {
    const change: ResourceChange = { logicalId: 'T', changeType: 'DELETE', resourceType: 'AWS::DynamoDB::Table' };
    const [found] = findDestructiveChanges('S', [change], {
      T: rec({ deletionPolicy: 'Retain', constructPath: 'S/Data/Table/Resource' }),
    });
    expect(formatDestructiveChange(found!)).toBe('S: AWS::DynamoDB::Table Data/Table T will be orphaned');
  });

  it('prefers the template path over a recorded one', () => {
    const template = {
      Resources: { T: { Type: 'AWS::DynamoDB::Table', Metadata: { 'aws:cdk:path': 'S/New/Resource' } } },
    } as CloudFormationTemplate;
    const [found] = findDestructiveChanges(
      'S',
      [update([{ path: 'TableName', oldValue: 'a', newValue: 'b', requiresReplacement: true }])],
      { T: rec({ constructPath: 'S/Old/Resource' }) },
      template
    );
    expect(found?.constructPath).toBe('S/New/Resource');
  });

  it('withConstructPath returns the record itself when nothing changes', () => {
    const r = rec({ constructPath: 'S/A/Resource' });
    expect(withConstructPath(r, 'S/A/Resource')).toBe(r);
    expect(withConstructPath(r, undefined)).toBe(r);
    const moved = withConstructPath(r, 'S/B/Resource');
    expect(moved).not.toBe(r);
    expect(moved).toEqual({ ...r, constructPath: 'S/B/Resource' });
    expect(r.constructPath).toBe('S/A/Resource');
  });
});
