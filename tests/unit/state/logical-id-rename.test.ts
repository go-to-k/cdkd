/**
 * go-to-k/cdkd#5201: `applyLogicalIdRenames`, the state rewrite behind
 * `cdkd refactor`. A rename moves a record verbatim; it never touches a field
 * the rename does not own, and never reshapes a record it cannot read.
 */
import { describe, expect, it } from 'vite-plus/test';
import {
  applyLogicalIdRenames,
  insertMovedRecords,
  removeMovedRecords,
  renameReferencesInValue,
} from '../../../src/state/logical-id-rename.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function record(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-1',
    resourceType: 'AWS::SQS::Queue',
    properties: { VisibilityTimeout: 30 },
    ...overrides,
  };
}

function stack(overrides: Partial<StackState> = {}): StackState {
  return {
    version: 13,
    stackName: 'MyStack',
    region: 'us-east-1',
    resources: {},
    outputs: { QueueUrl: 'https://q' },
    lastModified: 1,
    ...overrides,
  };
}

const template: CloudFormationTemplate = {
  Resources: {
    NewQueue: {
      Type: 'AWS::SQS::Queue',
      Properties: { VisibilityTimeout: 30 },
      Metadata: { 'aws:cdk:path': 'MyStack/Renamed/Resource' },
    },
  },
};

describe('applyLogicalIdRenames', () => {
  it('moves the record verbatim under the new id and stamps the template construct path', () => {
    const old = record({
      attributes: { Arn: 'arn:aws:sqs:us-east-1:123456789012:q' },
      observedProperties: { VisibilityTimeout: 30, MessageRetentionPeriod: 345600 },
      deletionPolicy: 'Retain',
      provisionedBy: 'sdk',
      constructPath: 'MyStack/Old/Resource',
      noEchoLeaves: [['Secret']],
    });
    const out = applyLogicalIdRenames(
      stack({ resources: { OldQueue: old } }),
      [{ from: 'OldQueue', to: 'NewQueue' }],
      template
    );
    expect(Object.keys(out.resources)).toEqual(['NewQueue']);
    expect(out.resources['NewQueue']).toEqual({ ...old, constructPath: 'MyStack/Renamed/Resource' });
  });

  it('keeps the old construct path when the template declares none', () => {
    const out = applyLogicalIdRenames(
      stack({ resources: { OldQueue: record({ constructPath: 'MyStack/Old/Resource' }) } }),
      [{ from: 'OldQueue', to: 'Bare' }],
      { Resources: { Bare: { Type: 'AWS::SQS::Queue' } } }
    );
    expect(out.resources['Bare']!.constructPath).toBe('MyStack/Old/Resource');
  });

  it('rewrites sibling dependencies and unresolved references, deduplicating', () => {
    const sibling = record({
      physicalId: 'phys-2',
      resourceType: 'AWS::SQS::QueuePolicy',
      dependencies: ['OldQueue', 'NewQueue', 'Other'],
      properties: {
        Queues: [{ Ref: 'OldQueue' }],
        Arn: { 'Fn::GetAtt': ['OldQueue', 'Arn'] },
        Dotted: { 'Fn::GetAtt': 'OldQueue.Arn' },
        Sub: { 'Fn::Sub': '${OldQueue}/${OldQueue.Arn}/${!OldQueue}/${OldQueueX}' },
        Shadowed: { 'Fn::Sub': ['${OldQueue}-${Other}', { OldQueue: 'literal' }] },
      },
    });
    const out = applyLogicalIdRenames(
      stack({ resources: { OldQueue: record(), Policy: sibling } }),
      [{ from: 'OldQueue', to: 'NewQueue' }],
      template
    );
    const policy = out.resources['Policy']!;
    expect(policy.dependencies).toEqual(['NewQueue', 'Other']);
    expect(policy.properties).toEqual({
      Queues: [{ Ref: 'NewQueue' }],
      Arn: { 'Fn::GetAtt': ['NewQueue', 'Arn'] },
      Dotted: { 'Fn::GetAtt': 'NewQueue.Arn' },
      Sub: { 'Fn::Sub': '${NewQueue}/${NewQueue.Arn}/${!OldQueue}/${OldQueueX}' },
      Shadowed: { 'Fn::Sub': ['${OldQueue}-${Other}', { OldQueue: 'literal' }] },
    });
    expect(policy.physicalId).toBe('phys-2');
  });

  it('applies chained renames together', () => {
    const out = applyLogicalIdRenames(
      stack({
        resources: {
          A: record(),
          B: record({ physicalId: 'p-b', dependencies: ['A'], properties: { Q: { Ref: 'A' } } }),
        },
      }),
      [
        { from: 'A', to: 'A2' },
        { from: 'B', to: 'B2' },
      ],
      { Resources: {} }
    );
    expect(Object.keys(out.resources).sort()).toEqual(['A2', 'B2']);
    expect(out.resources['B2']!.dependencies).toEqual(['A2']);
    expect(out.resources['B2']!.properties).toEqual({ Q: { Ref: 'A2' } });
  });

  it('retires the old id generation and raises the moved record past a retired new id', () => {
    const out = applyLogicalIdRenames(
      stack({
        stackInstanceId: '11111111-2222-3333-4444-555555555555',
        retiredNameGenerations: { NewQueue: 4 },
        resources: { OldQueue: record({ nameGeneration: 2 }) },
      }),
      [{ from: 'OldQueue', to: 'NewQueue' }],
      template
    );
    expect(out.retiredNameGenerations).toEqual({ NewQueue: 4, OldQueue: 2 });
    expect(out.resources['NewQueue']!.nameGeneration).toBe(2);
    expect(out.resources['NewQueue']!.nameGenerationHigh).toBe(4);
  });

  it('retires nothing on a legacy stack', () => {
    const out = applyLogicalIdRenames(
      stack({ resources: { OldQueue: record() } }),
      [{ from: 'OldQueue', to: 'NewQueue' }],
      template
    );
    expect(out.retiredNameGenerations).toBeUndefined();
  });

  it('carries every other stack field, relabels superseded records and drops skippedOutputs', () => {
    const superseded = { logicalId: 'OldQueue', supersededAt: 5, state: record({ physicalId: 'gone' }) };
    const before = stack({
      resources: { OldQueue: record(), Keep: record({ physicalId: 'k' }) },
      imports: [{ sourceStack: 'P', sourceRegion: 'us-east-1', exportName: 'E' }],
      exportNames: ['QueueUrl'],
      skippedOutputs: { X: 'sha256:abc' },
      conditionVerdicts: { C: { verdict: true, fingerprint: 'sha256:f' } },
      supersededResources: [superseded, { ...superseded, logicalId: 'Keep' }],
    });
    const out = applyLogicalIdRenames(before, [{ from: 'OldQueue', to: 'NewQueue' }], template);
    expect(out.outputs).toEqual(before.outputs);
    expect(out.imports).toEqual(before.imports);
    expect(out.exportNames).toEqual(before.exportNames);
    expect(out.conditionVerdicts).toEqual(before.conditionVerdicts);
    expect(out.skippedOutputs).toBeUndefined();
    expect(out.supersededResources!.map((s) => s.logicalId)).toEqual(['NewQueue', 'Keep']);
    expect(out.resources['Keep']).toEqual(before.resources['Keep']);
    // The input is not mutated.
    expect(Object.keys(before.resources)).toEqual(['OldQueue', 'Keep']);
    expect(before.skippedOutputs).toEqual({ X: 'sha256:abc' });
  });

  it('rewrites the references held by rollback-orphan and superseded records', () => {
    const out = applyLogicalIdRenames(
      stack({
        resources: { OldQueue: record() },
        orphans: [{ logicalId: 'Kept', orphanedAt: 1, state: record({ dependencies: ['OldQueue'] }) }],
        supersededResources: [
          { logicalId: 'Other', supersededAt: 1, state: record({ properties: { Q: { Ref: 'OldQueue' } } }) },
        ],
      }),
      [{ from: 'OldQueue', to: 'NewQueue' }],
      template
    );
    expect(out.orphans![0]!.logicalId).toBe('Kept');
    expect(out.orphans![0]!.state.dependencies).toEqual(['NewQueue']);
    expect(out.supersededResources![0]!.logicalId).toBe('Other');
    expect(out.supersededResources![0]!.state.properties).toEqual({ Q: { Ref: 'NewQueue' } });
  });

  it('keeps a null orphan or superseded entry verbatim', () => {
    const out = applyLogicalIdRenames(
      stack({
        resources: { OldQueue: record() },
        orphans: [null as never],
        supersededResources: [null as never],
      }),
      [{ from: 'OldQueue', to: 'NewQueue' }],
      template
    );
    expect(out.orphans).toEqual([null]);
    expect(out.supersededResources).toEqual([null]);
  });

  it('keeps a non-string dependency entry verbatim', () => {
    const out = applyLogicalIdRenames(
      stack({
        resources: {
          OldQueue: record(),
          Sib: record({ dependencies: ['OldQueue', 7 as unknown as string] }),
        },
      }),
      [{ from: 'OldQueue', to: 'NewQueue' }],
      template
    );
    expect(out.resources['Sib']!.dependencies).toEqual(['NewQueue', 7]);
  });

  it('leaves an unreadable sibling entry verbatim', () => {
    const out = applyLogicalIdRenames(
      stack({
        resources: { OldQueue: record(), Torn: 'abc' as unknown as ResourceState },
      }),
      [{ from: 'OldQueue', to: 'NewQueue' }],
      template
    );
    expect(out.resources['Torn']).toBe('abc');
  });

  it('defines a __proto__ logical id as an own key', () => {
    const out = applyLogicalIdRenames(
      stack({ resources: { OldQueue: record() } }),
      [{ from: 'OldQueue', to: '__proto__' }],
      { Resources: {} }
    );
    expect(Object.hasOwn(out.resources, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out.resources)).toBe(Object.prototype);
  });

  it.each([
    ['a from not in state', [{ from: 'Missing', to: 'X' }]],
    ['a to already in state', [{ from: 'OldQueue', to: 'Keep' }]],
    [
      'an id named twice',
      [
        { from: 'OldQueue', to: 'X' },
        { from: 'OldQueue', to: 'Y' },
      ],
    ],
    ['an inherited from', [{ from: 'constructor', to: 'X' }]],
  ])('throws on %s', (_label, renames) => {
    expect(() =>
      applyLogicalIdRenames(
        stack({ resources: { OldQueue: record(), Keep: record() } }),
        renames,
        template
      )
    ).toThrow();
  });
});

describe('renameReferencesInValue', () => {
  const renames = new Map([['Old', 'New']]);

  it('leaves values naming no renamed id unchanged', () => {
    const value = { a: [1, 'Old', { Ref: 'Other' }], b: { 'Fn::Join': ['', ['Old']] } };
    expect(renameReferencesInValue(value, renames)).toEqual(value);
  });

  it('rewrites nested references inside other intrinsics', () => {
    expect(
      renameReferencesInValue({ 'Fn::Join': ['', [{ Ref: 'Old' }, { 'Fn::GetAtt': ['Old', 'Arn'] }]] }, renames)
    ).toEqual({ 'Fn::Join': ['', [{ Ref: 'New' }, { 'Fn::GetAtt': ['New', 'Arn'] }]] });
  });

  it('does not treat a two-key object as an intrinsic', () => {
    expect(renameReferencesInValue({ Ref: 'Old', Other: 1 }, renames)).toEqual({ Ref: 'Old', Other: 1 });
  });
});

describe('removeMovedRecords / insertMovedRecords (go-to-k/cdkd#5202)', () => {
  it('drops the moved record, its dependency edges and skippedOutputs, and retires its generation', () => {
    const out = removeMovedRecords(
      stack({
        stackInstanceId: '11111111-2222-3333-4444-555555555555',
        resources: {
          Moved: record({ nameGeneration: 3 }),
          Stay: record({ physicalId: 's', dependencies: ['Moved', 'Other'] }),
        },
        orphans: [{ logicalId: 'O', orphanedAt: 1, state: record({ dependencies: ['Moved'] }) }],
        skippedOutputs: { X: 'sha256:a' },
      }),
      [{ from: 'Moved', to: 'There' }]
    );
    expect(Object.keys(out.resources)).toEqual(['Stay']);
    expect(out.resources['Stay']!.dependencies).toEqual(['Other']);
    expect(out.orphans![0]!.state.dependencies).toEqual([]);
    expect(out.retiredNameGenerations).toEqual({ Moved: 3 });
    expect(out.skippedOutputs).toBeUndefined();
    expect(out.stackInstanceId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('throws on a record the source does not hold', () => {
    expect(() => removeMovedRecords(stack({ resources: {} }), [{ from: 'Nope', to: 'X' }])).toThrow();
  });

  it('adds each record verbatim under its new id, keeping only edges to other moved records', () => {
    const moved = record({
      physicalId: 'p1',
      attributes: { Arn: 'arn:1' },
      dependencies: ['Stayed', 'Sibling'],
      properties: { Q: { Ref: 'Sibling' } },
    });
    const out = insertMovedRecords(
      stack({
        stackInstanceId: '11111111-2222-3333-4444-555555555555',
        retiredNameGenerations: { NewQueue: 5 },
        resources: { Existing: record({ physicalId: 'e' }) },
      }),
      [
        { from: 'OldQueue', to: 'NewQueue', record: moved },
        { from: 'Sibling', to: 'NewSibling', record: record({ physicalId: 'p2' }) },
      ],
      template
    );
    expect(Object.keys(out.resources)).toEqual(['Existing', 'NewQueue', 'NewSibling']);
    const placed = out.resources['NewQueue']!;
    expect(placed.physicalId).toBe('p1');
    expect(placed.attributes).toEqual({ Arn: 'arn:1' });
    expect(placed.dependencies).toEqual(['NewSibling']);
    expect(placed.properties).toEqual({ Q: { Ref: 'NewSibling' } });
    expect(placed.constructPath).toBe('MyStack/Renamed/Resource');
    expect(placed.nameGenerationHigh).toBe(5);
  });

  it('resolves each moved record\'s references within its own source stack', () => {
    // Two sources each move a `Table` and a record referencing it.
    const out = insertMovedRecords(
      stack({ resources: {} }),
      [
        { from: 'Table', to: 'TableA', record: record({ physicalId: 'ta' }), source: 'A' },
        { from: 'User', to: 'UserA', record: record({ physicalId: 'ua', dependencies: ['Table'], properties: { T: { Ref: 'Table' } } }), source: 'A' },
        { from: 'Table', to: 'TableB', record: record({ physicalId: 'tb' }), source: 'B' },
      ],
      { Resources: {} }
    );
    expect(out.resources['UserA']!.dependencies).toEqual(['TableA']);
    expect(out.resources['UserA']!.properties).toEqual({ T: { Ref: 'TableA' } });
  });

  it('throws on a destination id the destination already holds', () => {
    expect(() =>
      insertMovedRecords(stack({ resources: { NewQueue: record() } }), [{ from: 'A', to: 'NewQueue', record: record() }], template)
    ).toThrow();
  });
});
