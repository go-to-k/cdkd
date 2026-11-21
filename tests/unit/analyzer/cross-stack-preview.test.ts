import { describe, it, expect, vi } from 'vite-plus/test';
import {
  CrossStackPreview,
  crossStackReads,
  orderProducersFirst,
  recordProducerPreview,
  previewProducerValues,
  type ProducerPreviewInput,
} from '../../../src/analyzer/cross-stack-preview.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { ResourceChange } from '../../../src/types/state.js';

/** go-to-k/cdkd#6796: a consumer diffed after its producer previews the producer's new exports. */

const TEMPLATE = {
  Resources: {
    Table: { Type: 'AWS::DynamoDB::Table', Properties: {} },
    Queue: { Type: 'AWS::SQS::Queue', Properties: {} },
  },
  Outputs: {
    TableName: { Value: { Ref: 'Table' }, Export: { Name: 'p-table' } },
    Res: { Value: 'arn:new', Export: { Name: 'p-res' } },
    QueueUrl: { Value: { Ref: 'Queue' }, Export: { Name: 'p-queue' } },
    Gated: { Value: 'gated-new', Condition: 'Off', Export: { Name: 'p-gated' } },
  },
};

function input(overrides: Partial<ProducerPreviewInput> = {}): ProducerPreviewInput {
  return {
    stackName: 'Producer',
    template: TEMPLATE,
    changes: new Map<string, ResourceChange>(),
    desiredOutputs: { TableName: 't1', Res: 'arn:new', QueueUrl: 'q-url', Gated: 'gated-new' },
    // The stored bag aliases each export under its name, as the deploy writes it.
    storedOutputs: {
      TableName: 't1',
      'p-table': 't1',
      Res: 'arn:old',
      'p-res': 'arn:old',
      QueueUrl: 'q-url',
      'p-queue': 'q-url',
      Gated: 'gated-old',
      'p-gated': 'gated-old',
    },
    exportNameOf: new Map([
      ['TableName', 'p-table'],
      ['Res', 'p-res'],
      ['QueueUrl', 'p-queue'],
      ['Gated', 'p-gated'],
    ]),
    conditions: { Off: false },
    holdsSecret: () => false,
    ...overrides,
  };
}

const replaced = (logicalId: string): ResourceChange => ({
  logicalId,
  changeType: 'UPDATE',
  resourceType: 'AWS::DynamoDB::Table',
  propertyChanges: [{ path: 'TableName', oldValue: 't1', newValue: 't2', requiresReplacement: true }],
});

describe('previewProducerValues', () => {
  it('previews a changed literal as known and leaves unchanged and condition-false outputs out', () => {
    const preview = previewProducerValues(input());
    expect(preview.exports.get('p-res')).toEqual({
      kind: 'known',
      value: 'arn:new',
      producerStack: 'Producer',
    });
    expect(preview.outputs.get('Res')).toEqual(preview.exports.get('p-res'));
    expect(preview.exports.has('p-table')).toBe(false);
    expect(preview.exports.has('p-queue')).toBe(false);
    expect(preview.exports.has('p-gated')).toBe(false);
  });

  it('previews an output referencing a replaced or created resource as unknown', () => {
    const preview = previewProducerValues(
      input({
        changes: new Map<string, ResourceChange>([
          ['Table', replaced('Table')],
          ['Queue', { logicalId: 'Queue', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue' }],
        ]),
      })
    );
    expect(preview.exports.get('p-table')).toEqual({ kind: 'unknown', producerStack: 'Producer' });
    expect(preview.exports.get('p-queue')).toEqual({ kind: 'unknown', producerStack: 'Producer' });
  });

  it('keeps an in-place update of a referenced resource out of the preview', () => {
    const preview = previewProducerValues(
      input({
        changes: new Map<string, ResourceChange>([
          [
            'Table',
            {
              logicalId: 'Table',
              changeType: 'UPDATE',
              resourceType: 'AWS::DynamoDB::Table',
              propertyChanges: [
                { path: 'BillingMode', oldValue: 'a', newValue: 'b', requiresReplacement: false },
              ],
            },
          ],
        ]),
      })
    );
    expect(preview.exports.has('p-table')).toBe(false);
  });

  it('never hands a secret or a dynamic reference to another stack', () => {
    expect(
      previewProducerValues(input({ holdsSecret: (text) => text === 'arn:new' })).exports.get(
        'p-res'
      )
    ).toEqual({ kind: 'unknown', producerStack: 'Producer' });
    expect(
      previewProducerValues(
        input({ desiredOutputs: { Res: '{{resolve:secretsmanager:s}}' } })
      ).exports.get('p-res')
    ).toEqual({ kind: 'unknown', producerStack: 'Producer' });
  });

  it('previews an output reading another stack the preview answered unknown (A -> B -> C)', () => {
    const preview = previewProducerValues(
      input({
        template: {
          Resources: {},
          Outputs: { Fwd: { Value: { 'Fn::ImportValue': 'a-x' }, Export: { Name: 'b-x' } } },
        },
        desiredOutputs: {},
        storedOutputs: { Fwd: 'old' },
        exportNameOf: new Map([['Fwd', 'b-x']]),
        readsUnknownPreview: (value) => crossStackReads(value).some((r) => r.kind === 'export' && r.name === 'a-x'),
      })
    );
    expect(preview.exports.get('b-x')).toEqual({ kind: 'unknown', producerStack: 'Producer' });
  });

  it('CONTROL: an output failing for another reason (a denied RoleArn read, no fallback) stays out', () => {
    const preview = previewProducerValues(
      input({
        template: {
          Resources: {},
          Outputs: { Fwd: { Value: { 'Fn::ImportValue': 'cfn-only' }, Export: { Name: 'b-x' } } },
        },
        desiredOutputs: {},
        storedOutputs: { Fwd: 'old' },
        exportNameOf: new Map([['Fwd', 'b-x']]),
        readsUnknownPreview: () => false,
      })
    );
    expect(preview.exports.has('b-x')).toBe(false);
  });

  it('crossStackReads finds literal imports and same-account stack-output reads only', () => {
    expect(
      crossStackReads({
        'Fn::Join': [
          '',
          [
            { 'Fn::ImportValue': 'a-x' },
            { 'Fn::GetStackOutput': { StackName: 'P', OutputName: 'O', Region: 'us-west-2' } },
            { 'Fn::GetStackOutput': { StackName: 'X', OutputName: 'O', RoleArn: 'arn:r' } },
            { 'Fn::ImportValue': { 'Fn::Sub': 'n' } },
          ],
        ],
      })
    ).toEqual([
      { kind: 'export', name: 'a-x' },
      { kind: 'output', stackName: 'P', outputName: 'O', region: 'us-west-2' },
    ]);
  });

  it('recordProducerPreview chains an unknown through a re-export (A -> B -> C)', async () => {
    const preview = new CrossStackPreview();
    preview.record('us-east-1', 'A', {
      exports: new Map([['a-x', { kind: 'unknown', producerStack: 'A' }]]),
      outputs: new Map(),
    });
    await recordProducerPreview(preview, 'us-east-1', async (v) => v, {
      stackName: 'B',
      template: {
        Resources: {},
        Outputs: {
          Fwd: { Value: { 'Fn::ImportValue': 'a-x' }, Export: { Name: 'b-x' } },
          Other: { Value: { 'Fn::ImportValue': 'cfn-only' }, Export: { Name: 'b-y' } },
        },
      },
      changes: new Map(),
      desiredOutputs: {},
      storedOutputs: { Fwd: 'old', 'b-x': 'old', Other: 'o', 'b-y': 'o' },
      holdsSecret: () => false,
    });
    expect(preview.exportValue('us-east-1', 'b-x')).toEqual({ kind: 'unknown', producerStack: 'B' });
    expect(preview.exportValue('us-east-1', 'b-y')).toBeUndefined();
  });

  it('previews an output of a nested stack the deploy updates as unknown', () => {
    const preview = previewProducerValues(
      input({
        template: {
          Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} } },
          Outputs: {
            FromChild: { Value: { 'Fn::GetAtt': ['Child', 'Outputs.X'] }, Export: { Name: 'p-child' } },
          },
        },
        changes: new Map<string, ResourceChange>([
          [
            'Child',
            {
              logicalId: 'Child',
              changeType: 'UPDATE',
              resourceType: 'AWS::CloudFormation::Stack',
              propertyChanges: [],
            },
          ],
        ]),
        desiredOutputs: { FromChild: 'v' },
        storedOutputs: { FromChild: 'v' },
        exportNameOf: new Map([['FromChild', 'p-child']]),
      })
    );
    expect(preview.exports.get('p-child')).toEqual({ kind: 'unknown', producerStack: 'Producer' });
  });

  it('previews a renamed export with an unchanged value as an export only', () => {
    const preview = previewProducerValues(
      input({
        desiredOutputs: { Res: 'arn:same' },
        storedOutputs: { Res: 'arn:same', 'p-res-old': 'arn:same' },
      })
    );
    expect(preview.exports.get('p-res')).toEqual({
      kind: 'known',
      value: 'arn:same',
      producerStack: 'Producer',
    });
    expect(preview.outputs.has('Res')).toBe(false);
  });

  it('never hands the mask on as a value', () => {
    const preview = previewProducerValues(
      input({ desiredOutputs: { Res: '***' }, storedOutputs: {} })
    );
    expect(preview.exports.get('p-res')).toEqual({ kind: 'unknown', producerStack: 'Producer' });
  });

  it('skips an output stored as the mask, which the producer diff cannot compare either', () => {
    const preview = previewProducerValues(input({ storedOutputs: { Res: '***' } }));
    expect(preview.exports.has('p-res')).toBe(false);
  });
});

describe('orderProducersFirst', () => {
  it('moves a producer before its consumer and keeps the rest in order', () => {
    const deps: Record<string, string[]> = { B: ['A'], C: [], A: [] };
    expect(orderProducersFirst(['B', 'C', 'A'], (s) => deps[s]!)).toEqual(['C', 'A', 'B']);
    expect(orderProducersFirst(['A', 'B', 'C'], (s) => deps[s]!)).toEqual(['A', 'B', 'C']);
  });

  it('ignores a dependency outside the selection and keeps a cycle as given', () => {
    expect(orderProducersFirst(['B'], () => ['A'])).toEqual(['B']);
    const cycle: Record<string, string[]> = { X: ['Y'], Y: ['X'] };
    expect(orderProducersFirst(['X', 'Y'], (s) => cycle[s]!)).toEqual(['X', 'Y']);
  });
});

/** A state backend the preview must not need: every read fails the test. */
const untouchedBackend = (): S3StateBackend =>
  ({
    listStacks: vi.fn(async () => {
      throw new Error('state read');
    }),
    getState: vi.fn(async () => {
      throw new Error('state read');
    }),
  }) as unknown as S3StateBackend;

function context(preview: CrossStackPreview, stackName = 'Consumer'): ResolverContext {
  return {
    template: { Resources: {} },
    resources: {},
    stackName,
    stateBackend: untouchedBackend(),
    crossStackPreview: preview,
  };
}

function previewWith(): CrossStackPreview {
  const preview = new CrossStackPreview();
  preview.record('us-east-1', 'Producer', {
    exports: new Map([
      ['p-res', { kind: 'known', value: '*', producerStack: 'Producer' }],
      ['p-table', { kind: 'unknown', producerStack: 'Producer' }],
    ]),
    outputs: new Map([
      ['Res', { kind: 'known', value: '*', producerStack: 'Producer' }],
      ['TableName', { kind: 'unknown', producerStack: 'Producer' }],
    ]),
  });
  return preview;
}

describe('the resolver reads the preview before state', () => {
  it('Fn::ImportValue: a known value is returned without a state read', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = context(previewWith());
    await expect(resolver.resolve({ 'Fn::ImportValue': 'p-res' }, ctx)).resolves.toBe('*');
    expect(ctx.stateBackend!.listStacks).not.toHaveBeenCalled();
  });

  it('Fn::ImportValue: an unknown value fails the resolution, so the diff keeps the intrinsic', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve({ 'Fn::ImportValue': 'p-table' }, context(previewWith()))
    ).rejects.toThrow(/publishes a new value only when it deploys/);
  });

  it('Fn::ImportValue: another region, or the producer itself, reads state as before', async () => {
    const other = new IntrinsicFunctionResolver('us-west-2');
    await expect(
      other.resolve({ 'Fn::ImportValue': 'p-res' }, context(previewWith()))
    ).rejects.toThrow(/state read/);
    const own = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      own.resolve({ 'Fn::ImportValue': 'p-res' }, context(previewWith(), 'Producer'))
    ).rejects.toThrow(/state read/);
  });

  it('Fn::GetStackOutput: known and unknown values of a same-account producer', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Res' } },
        context(previewWith())
      )
    ).resolves.toBe('*');
    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'TableName' } },
        context(previewWith())
      )
    ).rejects.toThrow(/publishes a new value only when it deploys/);
  });

  it('a region spelled in another case keys the same producer', () => {
    const preview = previewWith();
    expect(preview.exportValue('US-EAST-1', 'p-res')?.kind).toBe('known');
    expect(preview.stackOutput('us-east-1', 'Producer', 'Res')?.kind).toBe('known');
    expect(preview.stackOutput('us-east-1', 'Other', 'Res')).toBeUndefined();
  });
});
