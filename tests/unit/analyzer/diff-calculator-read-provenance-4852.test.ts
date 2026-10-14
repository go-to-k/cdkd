/**
 * go-to-k/cdkd#4852: the diff's READ-PROVENANCE arm (state schema v12), on
 * the real `DiffCalculator`. Records only: a reader whose recorded
 * `readVersions` its upstream domain no longer holds is promoted, with no
 * resolution and no AWS call.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ReferenceProvenance, ResourceState, StackState } from '../../../src/types/state.js';
import { markTokenFreeState } from '../../../src/state/token-free-state.js';
import { inheritedProvenanceForChildDiff } from '../../../src/deployment/read-provenance-sources.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;

const at = (versions: string[], read?: string[]): ReferenceProvenance => ({
  region: 'us-east-1',
  versions,
  ...(read !== undefined && { readVersions: read }),
});

function record(
  type: string,
  properties: Record<string, unknown>,
  provenance?: Record<string, ReferenceProvenance>
): ResourceState {
  return {
    physicalId: `${type}-id`,
    resourceType: type,
    properties,
    attributes: {},
    dependencies: [],
    ...(provenance && { referenceProvenance: provenance }),
  };
}

function stateOf(resources: Record<string, ResourceState>): StackState {
  return {
    version: 12,
    stackName: 's',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  } as StackState;
}

/** The queue (named from the secret) and an SSM reader of its ARN. */
function fixture(
  queue: Record<string, ReferenceProvenance> | undefined,
  reader: Record<string, ReferenceProvenance> | undefined,
  extra: { readerDescription?: string } = {}
): { state: StackState; template: CloudFormationTemplate } {
  const resources: Record<string, ResourceState> = {
    Queue: record('AWS::SQS::Queue', { QueueName: REF }, queue),
    Reader: record(
      'AWS::SSM::Parameter',
      { Name: '/r', Type: 'String', Value: ARN, Description: 'a' },
      reader
    ),
  };
  const template: CloudFormationTemplate = {
    Resources: {
      Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
      Reader: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: '/r',
          Type: 'String',
          Value: { 'Fn::GetAtt': ['Queue', 'Arn'] },
          Description: extra.readerDescription ?? 'a',
        },
      },
    },
  };
  return { state: stateOf(resources), template };
}

async function diff(
  state: StackState,
  template: CloudFormationTemplate,
  sources?: Parameters<DiffCalculator['calculateDiff']>[11]
) {
  // The diff pass's resolution, as the deploy's does it against the records:
  // every read of the queue serves its recorded (reference-form) ARN.
  const resolve = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(resolve));
    if (value === null || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    if ('Fn::GetAtt' in obj || 'Fn::ImportValue' in obj) return ARN;
    if ('Ref' in obj) return obj['Ref'] === 'Reader' ? '/r' : ARN;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = await resolve(v);
    return out;
  };
  return new DiffCalculator().calculateDiff(
    state,
    template,
    resolve,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sources
  );
}

describe('same stack', () => {
  it('promotes a reader whose read version the upstream no longer records', async () => {
    const { state, template } = fixture({ [REF]: at([V2]) }, { [REF]: at([V1], [V1]) });
    const changes = await diff(state, template);
    const reader = changes.get('Reader')!;
    expect(reader.changeType).toBe('UPDATE');
    expect(reader.propertyChanges).toEqual([
      expect.objectContaining({
        path: 'Value',
        inPlacePropagated: true,
        readProvenancePromoted: true,
        requiresReplacement: false,
      }),
    ]);
    expect(changes.get('Queue')!.changeType).toBe('NO_CHANGE');
  });

  it('does not promote while the upstream still holds the read version (a rotation alone)', async () => {
    const { state, template } = fixture({ [REF]: at([V1]) }, { [REF]: at([V1], [V1]) });
    expect((await diff(state, template)).get('Reader')!.changeType).toBe('NO_CHANGE');
  });

  it('witness is a SUBSET test: an upstream holding more generations promotes nothing', async () => {
    const { state, template } = fixture({ [REF]: at([V1, V2]) }, { [REF]: at([V1], [V1]) });
    expect((await diff(state, template)).get('Reader')!.changeType).toBe('NO_CHANGE');
  });

  it('S2: an upstream with no version for the token is no verdict', async () => {
    for (const queue of [undefined, {}, { [REF]: { region: "us-east-1" } }] as Array<Record<string, ReferenceProvenance> | undefined>) {
      const { state, template } = fixture(queue, { [REF]: at([V1], [V1]) });
      expect((await diff(state, template)).get('Reader')!.changeType).toBe('NO_CHANGE');
    }
  });

  it('a reader with no field, or no readVersions, diffs as v11', async () => {
    for (const reader of [undefined, {}, { [REF]: at([V1]) }] as Array<Record<string, ReferenceProvenance> | undefined>) {
      const { state, template } = fixture({ [REF]: at([V2]) }, reader);
      expect((await diff(state, template)).get('Reader')!.changeType).toBe('NO_CHANGE');
    }
  });

  it('a malformed readVersions (not a subset of versions) reads as absent', async () => {
    const { state, template } = fixture(
      { [REF]: at([V2]) },
      { [REF]: { region: 'us-east-1', versions: [V2], readVersions: [V1] } }
    );
    expect((await diff(state, template)).get('Reader')!.changeType).toBe('NO_CHANGE');
  });

  it('a token-free stack is not walked', async () => {
    const { state, template } = fixture({ [REF]: at([V2]) }, { [REF]: at([V1], [V1]) });
    markTokenFreeState(state);
    expect((await diff(state, template)).get('Reader')!.changeType).toBe('NO_CHANGE');
  });

  it('augments an UPDATE row, so an unrelated edit does not hide the read', async () => {
    const { state, template } = fixture({ [REF]: at([V2]) }, { [REF]: at([V1], [V1]) }, {
      readerDescription: 'b',
    });
    const paths = (await diff(state, template))
      .get('Reader')!
      .propertyChanges!.map((pc) => [pc.path, pc.readProvenancePromoted === true]);
    expect(paths).toEqual([
      ['Description', false],
      ['Value', true],
    ]);
  });

  it('a key the template edit already changed is not marked twice', async () => {
    const { state, template } = fixture({ [REF]: at([V2]) }, { [REF]: at([V1], [V1]) });
    // The reader's Value is edited AND promoted: one change for it.
    (template.Resources['Reader']!.Properties as Record<string, unknown>)['Value'] = {
      'Fn::Join': ['', ['x', { 'Fn::GetAtt': ['Queue', 'Arn'] }]],
    };
    const paths = (await diff(state, template))
      .get('Reader')!
      .propertyChanges!.map((pc) => pc.path);
    expect(paths).toEqual(['Value']);
  });

  it('only a reading property whose recorded value holds the moved token is marked', async () => {
    const state = stateOf({
      Queue: record('AWS::SQS::Queue', { QueueName: REF }, { [REF]: at([V2]) }),
      Other: record('AWS::SNS::Topic', { TopicName: 'other' }),
      Reader: record(
        'AWS::SSM::Parameter',
        { Name: '/r', Type: 'String', Value: ARN, Description: 'Other-id' },
        { [REF]: at([V1], [V1]) }
      ),
    });
    const template: CloudFormationTemplate = {
      Resources: {
        Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Other: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'other' } },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/r',
            Type: 'String',
            Value: { 'Fn::GetAtt': ['Queue', 'Arn'] },
            Description: { 'Fn::GetAtt': ['Other', 'Id'] },
          },
        },
      },
    };
    const changes = await new DiffCalculator().calculateDiff(state, template, async (value) =>
      value !== null && typeof value === 'object'
        ? JSON.stringify(value).includes('Queue')
          ? ARN
          : 'Other-id'
        : value
    );
    expect(changes.get('Reader')!.propertyChanges!.map((pc) => pc.path)).toEqual(['Value']);
  });

  it('a create-only read-derived leaf is a REPLACEMENT ceiling, and its readers follow', async () => {
    // `AWS::SSM::Parameter.Name` is create-only (registry); here it reads the queue.
    const state = stateOf({
      Queue: record('AWS::SQS::Queue', { QueueName: REF }, { [REF]: at([V2]) }),
      Reader: record(
        'AWS::SSM::Parameter',
        { Name: ARN, Type: 'String', Value: 'v' },
        { [REF]: at([V1], [V1]) }
      ),
      Grand: record('AWS::SSM::Parameter', { Name: '/g', Type: 'String', Value: '/r' }),
    });
    const template: CloudFormationTemplate = {
      Resources: {
        Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: { 'Fn::GetAtt': ['Queue', 'Arn'] }, Type: 'String', Value: 'v' },
        },
        Grand: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/g', Type: 'String', Value: { Ref: 'Reader' } },
        },
      },
    };
    const changes = await diff(state, template);
    const reader = changes.get('Reader')!.propertyChanges![0]!;
    expect(reader).toEqual(
      expect.objectContaining({ path: 'Name', requiresReplacement: true, inPlacePropagated: true })
    );
    // The existing replacement pass carries it on (the arm runs before the fixpoint).
    expect(changes.get('Grand')!.changeType).toBe('UPDATE');
    expect(changes.get('Grand')!.propertyChanges![0]!.replacementPropagated).toBe(true);
  });

  it('a nested-stack row is promoted over its Parameters', async () => {
    const state = stateOf({
      Queue: record('AWS::SQS::Queue', { QueueName: REF }, { [REF]: at([V2]) }),
      Child: record(
        'AWS::CloudFormation::Stack',
        { TemplateURL: 'u', Parameters: { QueueArn: ARN } },
        { [REF]: at([V1], [V1]) }
      ),
    });
    const template: CloudFormationTemplate = {
      Resources: {
        Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'u',
            Parameters: { QueueArn: { 'Fn::GetAtt': ['Queue', 'Arn'] } },
          },
        },
      },
    };
    const child = (await diff(state, template)).get('Child')!;
    expect(child.changeType).toBe('UPDATE');
    expect(child.propertyChanges!.map((pc) => pc.path)).toEqual(['Parameters']);
  });
});

describe('a nested CHILD: the inherited snapshot is the upstream of a parameter', () => {
  const childState = stateOf({
    Reader: record(
      'AWS::SSM::Parameter',
      { Name: '/n', Type: 'String', Value: ARN },
      { [REF]: at([V1], [V1]) }
    ),
  });
  const childTemplate: CloudFormationTemplate = {
    Parameters: { QueueArn: { Type: 'String' } },
    Resources: {
      Reader: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/n', Type: 'String', Value: { Ref: 'QueueArn' } },
      },
    },
  };

  it('promoted against a snapshot that no longer holds its version', async () => {
    const changes = await diff(childState, childTemplate, {
      inherited: new Map([[REF, at([V2], [V2])]]),
    });
    expect(changes.get('Reader')!.changeType).toBe('UPDATE');
  });

  it('a child reader that reads no parameter does not join the snapshot (S2 stands)', async () => {
    const state = stateOf({
      Sibling: record('AWS::SQS::Queue', { QueueName: REF }),
      Reader: record(
        'AWS::SSM::Parameter',
        { Name: '/n', Type: 'String', Value: ARN },
        { [REF]: at([V1], [V1]) }
      ),
    });
    const template: CloudFormationTemplate = {
      Parameters: { QueueArn: { Type: 'String' } },
      Resources: {
        Sibling: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/n', Type: 'String', Value: { 'Fn::GetAtt': ['Sibling', 'Arn'] } },
        },
      },
    };
    const changes = await diff(state, template, { inherited: new Map([[REF, at([V2], [V2])]]) });
    expect(changes.get('Reader')!.changeType).toBe('NO_CHANGE');
  });

  it('not promoted against a snapshot at its version, nor with no snapshot', async () => {
    const same = await diff(childState, childTemplate, {
      inherited: new Map([[REF, at([V1], [V1])]]),
    });
    expect(same.get('Reader')!.changeType).toBe('NO_CHANGE');
    expect((await diff(childState, childTemplate)).get('Reader')!.changeType).toBe('NO_CHANGE');
  });

  it('`cdkd diff --recursive` derives the same snapshot from the parent records', async () => {
    const parentRecords = {
      Queue: record('AWS::SQS::Queue', { QueueName: REF }, { [REF]: at([V2]) }),
      Child: record(
        'AWS::CloudFormation::Stack',
        { TemplateURL: 'u', Parameters: { QueueArn: ARN } },
        { [REF]: at([V1], [V1]) }
      ),
    };
    const parentTemplate: CloudFormationTemplate = {
      Resources: {
        Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'u',
            Parameters: { QueueArn: { 'Fn::GetAtt': ['Queue', 'Arn'] } },
          },
        },
      },
    };
    const derived = inheritedProvenanceForChildDiff({
      row: parentTemplate.Resources['Child']!,
      rowRecord: parentRecords.Child,
      rowProvisioned: true,
      parentRecords,
      parentTemplate,
    });
    // What the deploy's row resolution records for the token: the queue's version.
    expect(derived).toEqual(new Map([[REF, { region: 'us-east-1', versions: [V2] }]]));
    const changes = await diff(childState, childTemplate, { inherited: derived! });
    expect(changes.get('Reader')!.changeType).toBe('UPDATE');
    // A row the deploy does not provision runs no child engine: nothing promotes.
    expect(
      inheritedProvenanceForChildDiff({
        row: parentTemplate.Resources['Child']!,
        rowRecord: parentRecords.Child,
        rowProvisioned: false,
        parentRecords,
        parentTemplate,
      })
    ).toBeUndefined();
  });

  it('a token the row spells takes the row record\'s own entry', () => {
    const rowRecord = record(
      'AWS::CloudFormation::Stack',
      { TemplateURL: 'u', Parameters: { Name: REF } },
      { [REF]: at([V1]) }
    );
    const parentTemplate: CloudFormationTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { Name: REF } },
        },
      },
    };
    expect(
      inheritedProvenanceForChildDiff({
        row: parentTemplate.Resources['Child']!,
        rowRecord,
        rowProvisioned: true,
        parentRecords: { Child: rowRecord },
        parentTemplate,
      })
    ).toEqual(new Map([[REF, at([V1])]]));
  });
});

describe('cross-stack: the producer output provenance', () => {
  const state = stateOf({
    Reader: record(
      'AWS::SSM::Parameter',
      { Name: '/c', Type: 'String', Value: ARN },
      { [REF]: at([V1], [V1]) }
    ),
    Plain: record('AWS::SSM::Parameter', { Name: '/p', Type: 'String', Value: ARN }),
  });
  const template: CloudFormationTemplate = {
    Resources: {
      Reader: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/c', Type: 'String', Value: { 'Fn::ImportValue': 'q-arn' } },
      },
      Plain: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/p', Type: 'String', Value: { 'Fn::ImportValue': 'q-arn' } },
      },
    },
  };

  it('promotes against the producer output, read ONCE and only for a reader with read versions', async () => {
    const crossStackOutputs = vi.fn(async () => [{ [REF]: at([V2], [V2]) }]);
    const changes = await diff(state, template, { crossStackOutputs });
    expect(changes.get('Reader')!.changeType).toBe('UPDATE');
    expect(changes.get('Plain')!.changeType).toBe('NO_CHANGE');
    // Once (the arm runs once, before the fixpoint), and for Reader alone.
    expect(crossStackOutputs).toHaveBeenCalledTimes(1);
    expect(crossStackOutputs).toHaveBeenCalledWith([{ 'Fn::ImportValue': 'q-arn' }]);
  });

  it('a producer output at the read version, or with no provenance, promotes nothing', async () => {
    for (const bags of [[{ [REF]: at([V1], [V1]) }], []]) {
      const changes = await diff(state, template, { crossStackOutputs: async () => bags });
      expect(changes.get('Reader')!.changeType).toBe('NO_CHANGE');
    }
  });
});
