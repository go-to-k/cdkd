import { describe, it, expect } from 'vite-plus/test';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const baseState = (): StackState => ({
  version: 1,
  stackName: 'TestStack',
  resources: {},
  outputs: {},
  lastModified: 0,
});

describe('DiffCalculator - intrinsic-aware diff', () => {
  it('detects literal changes inside Fn::Join when a resolver is provided', async () => {
    // State stores resolved values (as deploy-engine writes them after intrinsic resolution)
    const state = baseState();
    state.resources['Parameter'] = {
      physicalId: 'TestStack-parameter',
      resourceType: 'AWS::SSM::Parameter',
      properties: {
        Name: 'TestStack-parameter',
        // Previously deployed value: "${bucket.bucketName}-value" with bucket="my-bucket"
        Value: 'my-bucket-value',
      },
      attributes: {},
    };
    state.resources['Bucket'] = {
      physicalId: 'my-bucket',
      resourceType: 'AWS::S3::Bucket',
      properties: { BucketName: 'my-bucket' },
      attributes: {},
    };

    // Template uses Fn::Join — the literal changed from "-value" to "-value2"
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'my-bucket' },
        },
        Parameter: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: 'TestStack-parameter',
            Value: { 'Fn::Join': ['', [{ Ref: 'Bucket' }, '-value2']] },
          },
        },
      },
    };

    // Minimal resolver: handles Ref and Fn::Join well enough for this test
    const resolve = async (value: unknown): Promise<unknown> => {
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return Promise.all(value.map((v) => resolve(v)));
      const obj = value as Record<string, unknown>;
      if ('Ref' in obj) {
        const id = obj['Ref'] as string;
        const res = state.resources[id];
        if (!res) throw new Error(`Ref ${id} not found`);
        return res.physicalId;
      }
      if ('Fn::Join' in obj) {
        const [sep, parts] = obj['Fn::Join'] as [string, unknown[]];
        const resolvedParts = await Promise.all(parts.map((p) => resolve(p)));
        return resolvedParts.join(sep);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = await resolve(v);
      return out;
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, resolve);
    const paramChange = changes.get('Parameter');
    expect(paramChange?.changeType).toBe('UPDATE');
    expect(paramChange?.propertyChanges?.map((p) => p.path)).toContain('Value');
  });

  it('without resolver, intrinsic wraps mask inner literal changes (legacy behavior)', async () => {
    const state = baseState();
    state.resources['Parameter'] = {
      physicalId: 'TestStack-parameter',
      resourceType: 'AWS::SSM::Parameter',
      properties: {
        Name: 'TestStack-parameter',
        Value: 'my-bucket-value',
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Parameter: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: 'TestStack-parameter',
            Value: { 'Fn::Join': ['', [{ Ref: 'Bucket' }, '-value2']] },
          },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template);
    // Without resolver, the existing isIntrinsic short-circuit returns "equal"
    expect(changes.get('Parameter')?.changeType).toBe('NO_CHANGE');
  });

  it('falls back to unresolved value when resolver throws for a property', async () => {
    const state = baseState();
    state.resources['Parameter'] = {
      physicalId: 'TestStack-parameter',
      resourceType: 'AWS::SSM::Parameter',
      properties: {
        Name: 'TestStack-parameter',
        Value: 'my-bucket-value',
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Parameter: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: 'TestStack-parameter',
            Value: { 'Fn::GetAtt': ['NotYetCreated', 'Arn'] },
          },
        },
      },
    };

    const resolve = async (): Promise<unknown> => {
      throw new Error('not found');
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, resolve);
    // Resolver failure → keep unresolved → intrinsic treated as equal → NO_CHANGE
    expect(changes.get('Parameter')?.changeType).toBe('NO_CHANGE');
  });

  it('still detects plain property changes when resolver is provided', async () => {
    const state = baseState();
    state.resources['Bucket'] = {
      physicalId: 'my-bucket',
      resourceType: 'AWS::S3::Bucket',
      properties: { BucketName: 'my-bucket', VersioningConfiguration: { Status: 'Suspended' } },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: 'my-bucket',
            VersioningConfiguration: { Status: 'Enabled' },
          },
        },
      },
    };

    const resolve = async (v: unknown): Promise<unknown> => v;

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, resolve);
    expect(changes.get('Bucket')?.changeType).toBe('UPDATE');
  });

  it('excludes AWS::CDK::Metadata from change entries so level counts reflect real work only', async () => {
    const state = baseState();

    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'my-bucket' },
        },
        CDKMetadata: {
          Type: 'AWS::CDK::Metadata',
          Properties: { Analytics: 'v2:deflate64:abc' },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template);

    expect(changes.has('CDKMetadata')).toBe(false);
    expect(changes.get('Bucket')?.changeType).toBe('CREATE');
  });
});

describe('DiffCalculator - DeletionPolicy / UpdateReplacePolicy attribute diff (schema v5)', () => {
  it('reports UPDATE with attributeChanges when DeletionPolicy is added to a resource with no other changes', async () => {
    const state = baseState();
    state.resources['Table'] = {
      physicalId: 'my-table',
      resourceType: 'AWS::DynamoDB::GlobalTable',
      properties: { BillingMode: 'PAY_PER_REQUEST' },
      // Pre-v5 state: no deletionPolicy field.
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Table: {
          Type: 'AWS::DynamoDB::GlobalTable',
          Properties: { BillingMode: 'PAY_PER_REQUEST' },
          DeletionPolicy: 'Retain',
          UpdateReplacePolicy: 'Retain',
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template);
    const change = changes.get('Table');

    expect(change?.changeType).toBe('UPDATE');
    expect(change?.propertyChanges).toEqual([]);
    expect(change?.attributeChanges).toEqual([
      { attribute: 'DeletionPolicy', oldValue: undefined, newValue: 'Retain' },
      { attribute: 'UpdateReplacePolicy', oldValue: undefined, newValue: 'Retain' },
    ]);
  });

  it('reports UPDATE with attributeChanges when DeletionPolicy is removed (RemovalPolicy.DESTROY → default Retain on the canonical CDK case)', async () => {
    const state = baseState();
    state.resources['Bucket'] = {
      physicalId: 'my-bucket',
      resourceType: 'AWS::S3::Bucket',
      properties: { BucketName: 'my-bucket' },
      deletionPolicy: 'Delete',
      updateReplacePolicy: 'Delete',
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'my-bucket' },
          // RemovalPolicy stripped: CDK now emits Retain (the CFn default for
          // L2 constructs that wrap RemovalPolicy).
          DeletionPolicy: 'Retain',
          UpdateReplacePolicy: 'Retain',
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template);
    const change = changes.get('Bucket');

    expect(change?.changeType).toBe('UPDATE');
    expect(change?.attributeChanges).toEqual([
      { attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' },
      { attribute: 'UpdateReplacePolicy', oldValue: 'Delete', newValue: 'Retain' },
    ]);
  });

  it('stays NO_CHANGE when state and template carry the same attribute value (including both-undefined)', async () => {
    const state = baseState();
    state.resources['Topic'] = {
      physicalId: 'my-topic',
      resourceType: 'AWS::SNS::Topic',
      properties: {},
      deletionPolicy: 'Retain',
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Topic: {
          Type: 'AWS::SNS::Topic',
          Properties: {},
          DeletionPolicy: 'Retain',
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template);
    expect(changes.get('Topic')?.changeType).toBe('NO_CHANGE');
  });

  it('combines propertyChanges and attributeChanges in one UPDATE entry', async () => {
    const state = baseState();
    state.resources['Topic'] = {
      physicalId: 'my-topic',
      resourceType: 'AWS::SNS::Topic',
      properties: { DisplayName: 'old' },
      deletionPolicy: 'Delete',
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Topic: {
          Type: 'AWS::SNS::Topic',
          Properties: { DisplayName: 'new' },
          DeletionPolicy: 'Retain',
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template);
    const change = changes.get('Topic');

    expect(change?.changeType).toBe('UPDATE');
    expect(change?.propertyChanges?.length).toBe(1);
    expect(change?.propertyChanges?.[0]?.path).toBe('DisplayName');
    expect(change?.attributeChanges).toEqual([
      { attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' },
    ]);
  });
});
