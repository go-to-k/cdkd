import { describe, it, expect, vi } from 'vite-plus/test';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const baseState = (): StackState => ({
  version: 1,
  stackName: 'TestStack',
  resources: {},
  outputs: {},
  lastModified: 0,
});

describe('DiffCalculator - nested-map-key removal (bug-hunt 2026-06-29)', () => {
  // Removing a key from a NESTED map (e.g. a Lambda env var) must be detected.
  // The prior asymmetric valuesEqual walked only the new-side keys, so an
  // old-only nested key (a removal) compared equal -> NO_CHANGE -> never reached
  // AWS (the dropped env var stayed live).
  it('detects a key removed from a nested map (Lambda Environment.Variables)', async () => {
    const state = baseState();
    state.resources['Fn'] = {
      physicalId: 'my-fn',
      resourceType: 'AWS::Lambda::Function',
      properties: {
        FunctionName: 'my-fn',
        Environment: { Variables: { KEEP: 'yes', TOREMOVE: 'bye' } },
      },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: 'my-fn',
            Environment: { Variables: { KEEP: 'yes' } }, // TOREMOVE dropped
          },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template);

    expect(changes.get('Fn')?.changeType).toBe('UPDATE');
    const envChange = changes.get('Fn')?.propertyChanges?.find((pc) => pc.path === 'Environment');
    expect(envChange).toBeDefined();
  });

  it('reports NO_CHANGE when a nested map is unchanged', async () => {
    const state = baseState();
    state.resources['Fn'] = {
      physicalId: 'my-fn',
      resourceType: 'AWS::Lambda::Function',
      properties: { FunctionName: 'my-fn', Environment: { Variables: { KEEP: 'yes' } } },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'my-fn', Environment: { Variables: { KEEP: 'yes' } } },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template);
    expect(changes.get('Fn')?.changeType).toBe('NO_CHANGE');
  });

  it('detects a key ADDED to a nested map (still works)', async () => {
    const state = baseState();
    state.resources['Fn'] = {
      physicalId: 'my-fn',
      resourceType: 'AWS::Lambda::Function',
      properties: { FunctionName: 'my-fn', Environment: { Variables: { KEEP: 'yes' } } },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: 'my-fn',
            Environment: { Variables: { KEEP: 'yes', NEW: 'added' } },
          },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template);
    expect(changes.get('Fn')?.changeType).toBe('UPDATE');
  });
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

  it('without resolver, intrinsic on one side and concrete on the other flags as UPDATE (fail-safe)', async () => {
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
    // No resolver → template Value stays intrinsic, state side is concrete string;
    // the comparator flags as not-equal so the UPDATE fires.
    expect(changes.get('Parameter')?.changeType).toBe('UPDATE');
  });

  it('unresolvable intrinsic on the template side flags as UPDATE so retargeted refs are not silently dropped', async () => {
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
    // Resolver failure → keep unresolved → intrinsic on one side + concrete on
    // the other ⇒ NOT equal ⇒ UPDATE. Pre-fix this silently reported NO_CHANGE
    // and skipped IAM policy refresh after a refactor that changed an
    // Fn::GetAtt target's logical ID.
    expect(changes.get('Parameter')?.changeType).toBe('UPDATE');
  });

  it('flags as UPDATE when an IAM policy Fn::GetAtt target is rebound to a newly-introduced resource (bug regression)', async () => {
    // Scenario: a refactor wraps the bucket in a Construct, so the bucket's
    // logical ID changed (`OldBucket` → `Wrapper/NewBucket`). The IAM Policy
    // resource itself kept the SAME logical ID, but its `Resource` field's
    // Fn::GetAtt now points at the new bucket. State still has the resolved
    // ARN of the old bucket. Best-effort resolution fails because the new
    // bucket isn't in state yet → comparator must classify as UPDATE.
    const state = baseState();
    state.resources['Policy'] = {
      physicalId: 'TestStack-policy',
      resourceType: 'AWS::IAM::Policy',
      properties: {
        PolicyName: 'TestStack-policy',
        Roles: ['TestStack-MyRole'],
        PolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Action: ['s3:ListBucket'],
              Resource: ['arn:aws:s3:::testStack-oldbucket'],
            },
          ],
        },
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Policy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyName: 'TestStack-policy',
            Roles: ['TestStack-MyRole'],
            PolicyDocument: {
              Statement: [
                {
                  Effect: 'Allow',
                  Action: ['s3:ListBucket'],
                  Resource: [{ 'Fn::GetAtt': ['WrapperNewBucket', 'Arn'] }],
                },
              ],
            },
          },
        },
      },
    };

    // Resolver: WrapperNewBucket is NOT in state (will be created same deploy)
    const resolve = async (value: unknown): Promise<unknown> => {
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return Promise.all(value.map((v) => resolve(v)));
      const obj = value as Record<string, unknown>;
      if ('Fn::GetAtt' in obj) {
        const [id] = obj['Fn::GetAtt'] as [string, string];
        const res = state.resources[id];
        if (!res) throw new Error(`GetAtt ${id} not found`);
        return `arn:aws:s3:::${res.physicalId}`;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = await resolve(v);
      return out;
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, resolve);
    expect(changes.get('Policy')?.changeType).toBe('UPDATE');
    expect(changes.get('Policy')?.propertyChanges?.map((p) => p.path)).toContain('PolicyDocument');
  });

  it('treats structurally-identical intrinsics on both sides as equal (state written with unresolved intrinsic)', async () => {
    // Defensive: when state was written by an older cdkd that left the
    // intrinsic unresolved (or the resolver could not resolve at deploy
    // time), and the template still has the same intrinsic shape, the
    // resource is unchanged and should report NO_CHANGE.
    const state = baseState();
    state.resources['Param'] = {
      physicalId: 'TestStack-param',
      resourceType: 'AWS::SSM::Parameter',
      properties: {
        Name: 'TestStack-param',
        Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: 'TestStack-param',
            Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
          },
        },
      },
    };

    const resolve = async (): Promise<unknown> => {
      throw new Error('not found');
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, resolve);
    expect(changes.get('Param')?.changeType).toBe('NO_CHANGE');
  });

  it('both-sides Fn::Sub with the same var map but different key order stays NO_CHANGE', async () => {
    // Var maps in `Fn::Sub`'s 2-arg form are `Record<string, intrinsic>`;
    // key order is implementation-defined and differs between a synth-fresh
    // object literal and a `JSON.parse`'d state record. The both-intrinsic
    // comparator must be key-order-insensitive so an idempotent re-deploy
    // doesn't spuriously fire UPDATE.
    const state = baseState();
    state.resources['Param'] = {
      physicalId: 'TestStack-param',
      resourceType: 'AWS::SSM::Parameter',
      properties: {
        Name: 'TestStack-param',
        Value: {
          'Fn::Sub': [
            '${VarA}-${VarB}',
            { VarA: { Ref: 'BucketA' }, VarB: { Ref: 'BucketB' } },
          ],
        },
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: 'TestStack-param',
            Value: {
              'Fn::Sub': [
                '${VarA}-${VarB}',
                // Same map, keys in reverse order — must still compare equal.
                { VarB: { Ref: 'BucketB' }, VarA: { Ref: 'BucketA' } },
              ],
            },
          },
        },
      },
    };

    const resolve = async (): Promise<unknown> => {
      throw new Error('not found');
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, resolve);
    expect(changes.get('Param')?.changeType).toBe('NO_CHANGE');
  });

  it('treats structurally-different intrinsics on both sides as changed', async () => {
    const state = baseState();
    state.resources['Param'] = {
      physicalId: 'TestStack-param',
      resourceType: 'AWS::SSM::Parameter',
      properties: {
        Name: 'TestStack-param',
        Value: { 'Fn::GetAtt': ['OldBucket', 'Arn'] },
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: 'TestStack-param',
            Value: { 'Fn::GetAtt': ['NewBucket', 'Arn'] },
          },
        },
      },
    };

    const resolve = async (): Promise<unknown> => {
      throw new Error('not found');
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, resolve);
    expect(changes.get('Param')?.changeType).toBe('UPDATE');
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

describe('DiffCalculator - replacement propagation to dependents (issue #807)', () => {
  // Mirrors the deploy engine's diff-time resolution: intrinsics resolve
  // against CURRENT state, so a Ref / Fn::GetAtt to a to-be-replaced
  // resource yields the OLD physical value and the dependent compares
  // equal (NO_CHANGE) without the propagation walk.
  const makeResolver =
    (state: StackState) =>
    async (value: unknown): Promise<unknown> => {
      const resolve = async (v: unknown): Promise<unknown> => {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return Promise.all(v.map((item) => resolve(item)));
        const obj = v as Record<string, unknown>;
        if ('Ref' in obj && Object.keys(obj).length === 1) {
          const id = obj['Ref'] as string;
          const res = state.resources[id];
          if (!res) throw new Error(`Ref ${id} not found`);
          return res.physicalId;
        }
        if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
          const [id, attr] = obj['Fn::GetAtt'] as [string, string];
          const res = state.resources[id];
          const attrValue = res?.attributes?.[attr];
          if (attrValue === undefined) throw new Error(`GetAtt ${id}.${attr} not found`);
          return attrValue;
        }
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(obj)) out[k] = await resolve(val);
        return out;
      };
      return resolve(value);
    };

  it('promotes a NO_CHANGE dependent referencing a to-be-replaced resource via Ref; unrelated NO_CHANGE stays', async () => {
    const state = baseState();
    state.resources['TaskDef'] = {
      physicalId: 'arn:aws:ecs:us-east-1:123:task-definition/app:1',
      resourceType: 'AWS::ECS::TaskDefinition',
      properties: { Family: 'app', ContainerDefinitions: [{ Name: 'app', Image: 'img:1' }] },
      attributes: {},
    };
    state.resources['Service'] = {
      physicalId: 'arn:aws:ecs:us-east-1:123:service/cluster/app-svc',
      resourceType: 'AWS::ECS::Service',
      properties: {
        TaskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/app:1',
        DesiredCount: 1,
      },
      attributes: {},
    };
    state.resources['Unrelated'] = {
      physicalId: 'log-group',
      resourceType: 'AWS::Logs::LogGroup',
      properties: { LogGroupName: 'log-group' },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          // ContainerDefinitions change -> requiresReplacement (immutable)
          Properties: {
            Family: 'app',
            ContainerDefinitions: [{ Name: 'app', Image: 'img:2' }],
          },
        },
        Service: {
          Type: 'AWS::ECS::Service',
          Properties: { TaskDefinition: { Ref: 'TaskDef' }, DesiredCount: 1 },
        },
        Unrelated: {
          Type: 'AWS::Logs::LogGroup',
          Properties: { LogGroupName: 'log-group' },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    const taskDef = changes.get('TaskDef');
    expect(taskDef?.changeType).toBe('UPDATE');
    expect(taskDef?.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(true);

    // Without the propagation walk, the Service resolves the Ref against
    // current state (old revision ARN) and would stay NO_CHANGE.
    const service = changes.get('Service');
    expect(service?.changeType).toBe('UPDATE');
    expect(service?.propertyChanges?.map((pc) => pc.path)).toContain('TaskDefinition');
    // ECS::Service has no replacement rule for TaskDefinition -> in-place.
    expect(service?.propertyChanges?.every((pc) => !pc.requiresReplacement)).toBe(true);

    expect(changes.get('Unrelated')?.changeType).toBe('NO_CHANGE');
  });

  it('promotes a NO_CHANGE dependent referencing a to-be-replaced resource via Fn::GetAtt', async () => {
    const state = baseState();
    state.resources['Queue'] = {
      physicalId: 'https://sqs.us-east-1.amazonaws.com/123/old-queue',
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: 'old-queue' },
      attributes: { Arn: 'arn:aws:sqs:us-east-1:123:old-queue' },
    };
    state.resources['Param'] = {
      physicalId: 'param',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'param', Value: 'arn:aws:sqs:us-east-1:123:old-queue' },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Queue: {
          Type: 'AWS::SQS::Queue',
          // QueueName change -> requiresReplacement
          Properties: { QueueName: 'new-queue' },
        },
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'param', Value: { 'Fn::GetAtt': ['Queue', 'Arn'] } },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Queue')?.changeType).toBe('UPDATE');
    const param = changes.get('Param');
    expect(param?.changeType).toBe('UPDATE');
    expect(param?.propertyChanges?.map((pc) => pc.path)).toContain('Value');
  });

  it('promotes transitively: A replaced -> B promoted and itself replacement-triggering -> C promoted', async () => {
    const state = baseState();
    state.resources['Queue'] = {
      physicalId: 'https://sqs.us-east-1.amazonaws.com/123/old-queue',
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: 'old-queue' },
      attributes: { Arn: 'arn:aws:sqs:us-east-1:123:old-queue' },
    };
    state.resources['TaskDef'] = {
      physicalId: 'arn:aws:ecs:us-east-1:123:task-definition/app:1',
      resourceType: 'AWS::ECS::TaskDefinition',
      properties: {
        Family: 'app',
        ContainerDefinitions: [
          {
            Name: 'app',
            Environment: [{ Name: 'QUEUE_ARN', Value: 'arn:aws:sqs:us-east-1:123:old-queue' }],
          },
        ],
      },
      attributes: {},
    };
    state.resources['Service'] = {
      physicalId: 'arn:aws:ecs:us-east-1:123:service/cluster/app-svc',
      resourceType: 'AWS::ECS::Service',
      properties: { TaskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/app:1' },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Queue: {
          Type: 'AWS::SQS::Queue',
          // A: QueueName change -> replacement (new physical queue + ARN)
          Properties: { QueueName: 'new-queue' },
        },
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          // B: unchanged on its own; ContainerDefinitions references A.
          // ContainerDefinitions is immutable for TaskDefinition -> B is
          // itself replacement-triggering once promoted.
          Properties: {
            Family: 'app',
            ContainerDefinitions: [
              {
                Name: 'app',
                Environment: [{ Name: 'QUEUE_ARN', Value: { 'Fn::GetAtt': ['Queue', 'Arn'] } }],
              },
            ],
          },
        },
        Service: {
          Type: 'AWS::ECS::Service',
          // C: unchanged on its own; references B.
          Properties: { TaskDefinition: { Ref: 'TaskDef' } },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Queue')?.changeType).toBe('UPDATE');

    const taskDef = changes.get('TaskDef');
    expect(taskDef?.changeType).toBe('UPDATE');
    const tdChange = taskDef?.propertyChanges?.find((pc) => pc.path === 'ContainerDefinitions');
    expect(tdChange?.requiresReplacement).toBe(true);

    const service = changes.get('Service');
    expect(service?.changeType).toBe('UPDATE');
    expect(service?.propertyChanges?.map((pc) => pc.path)).toContain('TaskDefinition');
  });

  it('keeps a dependent that already had its own property change as UPDATE and appends the reference change once', async () => {
    const state = baseState();
    state.resources['TaskDef'] = {
      physicalId: 'arn:aws:ecs:us-east-1:123:task-definition/app:1',
      resourceType: 'AWS::ECS::TaskDefinition',
      properties: { Family: 'app', Cpu: '256' },
      attributes: {},
    };
    state.resources['Service'] = {
      physicalId: 'arn:aws:ecs:us-east-1:123:service/cluster/app-svc',
      resourceType: 'AWS::ECS::Service',
      properties: {
        TaskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/app:1',
        DesiredCount: 1,
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          // Cpu change -> requiresReplacement
          Properties: { Family: 'app', Cpu: '512' },
        },
        Service: {
          Type: 'AWS::ECS::Service',
          // Own change (DesiredCount) AND a reference to the replaced TaskDef
          Properties: { TaskDefinition: { Ref: 'TaskDef' }, DesiredCount: 2 },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    const service = changes.get('Service');
    expect(service?.changeType).toBe('UPDATE');
    const paths = service?.propertyChanges?.map((pc) => pc.path) ?? [];
    expect(paths).toContain('DesiredCount');
    expect(paths).toContain('TaskDefinition');
    // No duplicate entries for the same path
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('does not promote dependents of an in-place (non-replacement) update', async () => {
    const state = baseState();
    state.resources['Fn'] = {
      physicalId: 'my-fn',
      resourceType: 'AWS::Lambda::Function',
      properties: { FunctionName: 'my-fn', Description: 'old' },
      attributes: { Arn: 'arn:aws:lambda:us-east-1:123:function:my-fn' },
    };
    state.resources['Param'] = {
      physicalId: 'param',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'param', Value: 'arn:aws:lambda:us-east-1:123:function:my-fn' },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          // Description is updateable in-place -> no replacement, same ARN
          Properties: { FunctionName: 'my-fn', Description: 'new' },
        },
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'param', Value: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Fn')?.changeType).toBe('UPDATE');
    expect(changes.get('Param')?.changeType).toBe('NO_CHANGE');
  });

  it('marks synthetic promoted changes with replacementPropagated for the diff display', async () => {
    const state = baseState();
    state.resources['TaskDef'] = {
      physicalId: 'arn:aws:ecs:us-east-1:123:task-definition/app:1',
      resourceType: 'AWS::ECS::TaskDefinition',
      properties: { Family: 'app', ContainerDefinitions: [{ Name: 'app', Image: 'img:1' }] },
      attributes: {},
    };
    state.resources['Service'] = {
      physicalId: 'arn:aws:ecs:us-east-1:123:service/cluster/app-svc',
      resourceType: 'AWS::ECS::Service',
      properties: {
        TaskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/app:1',
        DesiredCount: 1,
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: { Family: 'app', ContainerDefinitions: [{ Name: 'app', Image: 'img:2' }] },
        },
        Service: {
          Type: 'AWS::ECS::Service',
          Properties: { TaskDefinition: { Ref: 'TaskDef' }, DesiredCount: 1 },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    const service = changes.get('Service');
    const refChange = service?.propertyChanges?.find((pc) => pc.path === 'TaskDefinition');
    expect(refChange?.replacementPropagated).toBe(true);
  });

  it('does NOT spuriously promote grandchildren when the referencing property is a conditionalReplacement (issue #807 Fix 1)', async () => {
    // A type whose referencing property is governed by a conditional rule
    // comparing oldValue vs newValue. If the synthetic promotion fed the
    // phantom string -> {Ref} delta to the condition, it would reliably
    // report "changed" and falsely set requiresReplacement on the
    // dependent, spuriously enqueueing its grandchildren. The fix passes
    // undefined/undefined so conditional rules see no phantom delta.
    //
    // Simulate a conditional rule for AWS::ECS::Service.TaskDefinition that
    // ALWAYS reports replacement when old !== new (the over-broad shape).
    const spy = vi
      .spyOn(ReplacementRulesRegistry.prototype, 'requiresReplacement')
      .mockImplementation(
        (resourceType: string, propertyPath: string, oldValue: unknown, newValue: unknown) => {
          if (resourceType === 'AWS::ECS::Service' && propertyPath === 'TaskDefinition') {
            // Phantom-delta-sensitive conditional rule.
            return oldValue !== newValue;
          }
          if (resourceType === 'AWS::ECS::TaskDefinition') {
            // Keep the seed replacement (immutable property changed).
            return true;
          }
          return false;
        }
      );

    try {
      const state = baseState();
      state.resources['TaskDef'] = {
        physicalId: 'arn:aws:ecs:us-east-1:123:task-definition/app:1',
        resourceType: 'AWS::ECS::TaskDefinition',
        properties: { Family: 'app', ContainerDefinitions: [{ Name: 'app', Image: 'img:1' }] },
        attributes: {},
      };
      // Service references the replaced TaskDef (the dependent under test).
      state.resources['Service'] = {
        physicalId: 'arn:aws:ecs:us-east-1:123:service/cluster/app-svc',
        resourceType: 'AWS::ECS::Service',
        properties: { TaskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/app:1' },
        attributes: { Name: 'service/cluster/app-svc' },
      };
      // Grandchild references the Service. It must NOT be promoted unless the
      // Service is genuinely replacement-triggering. Its own resolved value
      // is unchanged (Service.Name does not change on an in-place Service
      // update), so any UPDATE here could only come from a spurious cascade.
      state.resources['ScalableTarget'] = {
        physicalId: 'service/cluster/app-svc',
        resourceType: 'AWS::ApplicationAutoScaling::ScalableTarget',
        properties: { ResourceId: 'service/cluster/app-svc' },
        attributes: {},
      };

      const template: CloudFormationTemplate = {
        Resources: {
          TaskDef: {
            Type: 'AWS::ECS::TaskDefinition',
            Properties: { Family: 'app', ContainerDefinitions: [{ Name: 'app', Image: 'img:2' }] },
          },
          Service: {
            Type: 'AWS::ECS::Service',
            Properties: { TaskDefinition: { Ref: 'TaskDef' } },
          },
          ScalableTarget: {
            Type: 'AWS::ApplicationAutoScaling::ScalableTarget',
            Properties: { ResourceId: { 'Fn::GetAtt': ['Service', 'Name'] } },
          },
        },
      };

      const calc = new DiffCalculator();
      const changes = await calc.calculateDiff(state, template, makeResolver(state));

      // Service is promoted (it references the replaced TaskDef) but must NOT
      // be flagged as requiring replacement — the conditional rule was fed
      // undefined/undefined, not the phantom string -> {Ref} delta.
      const service = changes.get('Service');
      expect(service?.changeType).toBe('UPDATE');
      expect(service?.propertyChanges?.every((pc) => !pc.requiresReplacement)).toBe(true);

      // Grandchild stays NO_CHANGE — the cascade did not over-broaden.
      expect(changes.get('ScalableTarget')?.changeType).toBe('NO_CHANGE');

      // The synthetic promotion evaluated the rule with undefined/undefined.
      expect(spy).toHaveBeenCalledWith('AWS::ECS::Service', 'TaskDefinition', undefined, undefined);
    } finally {
      spy.mockRestore();
    }
  });

  it('terminates on a reference cycle (A -> B -> A) without infinite-looping (issue #807 Fix 3)', async () => {
    // Two SQS queues that reference each other's ARN (a synthetic cycle).
    // The `enqueued` guard must prevent re-enqueueing an already-visited
    // node so the BFS terminates.
    const state = baseState();
    state.resources['QueueA'] = {
      physicalId: 'https://sqs.us-east-1.amazonaws.com/123/a-old',
      resourceType: 'AWS::SQS::Queue',
      properties: {
        QueueName: 'a-old',
        RedrivePolicy: { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:123:b-old' },
      },
      attributes: { Arn: 'arn:aws:sqs:us-east-1:123:a-old' },
    };
    state.resources['QueueB'] = {
      physicalId: 'https://sqs.us-east-1.amazonaws.com/123/b-old',
      resourceType: 'AWS::SQS::Queue',
      properties: {
        QueueName: 'b-old',
        RedrivePolicy: { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:123:a-old' },
      },
      attributes: { Arn: 'arn:aws:sqs:us-east-1:123:b-old' },
    };

    const template: CloudFormationTemplate = {
      Resources: {
        QueueA: {
          Type: 'AWS::SQS::Queue',
          // QueueName change -> replacement (seeds the walk).
          Properties: {
            QueueName: 'a-new',
            RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['QueueB', 'Arn'] } },
          },
        },
        QueueB: {
          Type: 'AWS::SQS::Queue',
          // QueueName change -> replacement too; references A back (cycle).
          Properties: {
            QueueName: 'b-new',
            RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['QueueA', 'Arn'] } },
          },
        },
      },
    };

    const calc = new DiffCalculator();
    // If the `enqueued` guard regresses, this never resolves (infinite loop).
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('QueueA')?.changeType).toBe('UPDATE');
    expect(changes.get('QueueB')?.changeType).toBe('UPDATE');
    expect(changes.get('QueueA')?.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(true);
    expect(changes.get('QueueB')?.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(true);
  });

  // --- IN-PLACE attribute propagation (bug-hunt 2026-06-29) ----------------

  it('promotes a NO_CHANGE dependent that reads (via GetAtt) a CHANGED property of an in-place-updated resource', async () => {
    const state = baseState();
    state.resources['Base'] = {
      physicalId: 'base',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'base', Value: 'world' },
      attributes: { Value: 'world' },
    };
    state.resources['Derived'] = {
      physicalId: 'derived',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'derived', Value: 'world' },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        // In-place Value change (Value is updateable for SSM Parameter).
        Base: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'base', Value: 'world2' } },
        Derived: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'derived', Value: { 'Fn::GetAtt': ['Base', 'Value'] } },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Base')?.changeType).toBe('UPDATE');
    // Base's Value changed and Derived reads GetAtt[Base, Value] -> promoted.
    expect(changes.get('Derived')?.changeType).toBe('UPDATE');
  });

  it('promotes a dependent that reads a changed property via Fn::Sub ${X.Attr}', async () => {
    const state = baseState();
    state.resources['Base'] = {
      physicalId: 'base',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'base', Value: 'world' },
      attributes: { Value: 'world' },
    };
    const subVal = { 'Fn::Sub': ['hello-${Base.Value}', {}] };
    state.resources['Derived'] = {
      physicalId: 'derived',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'derived', Value: subVal },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Base: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'base', Value: 'world2' } },
        Derived: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'derived', Value: subVal } },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Derived')?.changeType).toBe('UPDATE');
  });

  it('does NOT promote a dependent that only reads the in-place-updated resource via Ref (physical id unchanged)', async () => {
    const state = baseState();
    state.resources['Base'] = {
      physicalId: 'base',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'base', Value: 'world' },
      attributes: { Value: 'world' },
    };
    state.resources['Consumer'] = {
      physicalId: 'consumer',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'consumer', Value: 'base' },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Base: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'base', Value: 'world2' } },
        // Reads only Base's NAME via Ref (physical id), which an in-place update
        // does not move.
        Consumer: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'consumer', Value: { Ref: 'Base' } },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Consumer')?.changeType).toBe('NO_CHANGE');
  });

  it('does NOT promote a dependent that reads an UNCHANGED attribute of an in-place-updated resource', async () => {
    const state = baseState();
    state.resources['Base'] = {
      physicalId: 'base',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'base', Value: 'world' },
      attributes: { Value: 'world', Type: 'String' },
    };
    state.resources['Derived'] = {
      physicalId: 'derived',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'derived', Value: 'String' },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        // Only Value changes.
        Base: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'base', Value: 'world2' } },
        // Reads Base.Type (not Value) -> unaffected by the Value change.
        Derived: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'derived', Value: { 'Fn::GetAtt': ['Base', 'Type'] } },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Derived')?.changeType).toBe('NO_CHANGE');
  });

  // --- IN-PLACE derived-attribute propagation (issue #985) -----------------
  // A LaunchTemplate in-place edit bumps its computed LatestVersionNumber, which
  // is NOT a template property, so the "changed-property NAME" arm above cannot
  // see it. An AutoScalingGroup reading `Fn::GetAtt[Lt, LatestVersionNumber]`
  // (the canonical `LaunchTemplate.Version` shape) must still be promoted so it
  // re-points at the new version in the SAME deploy, not one deploy behind.

  it('promotes a NO_CHANGE ASG that reads LaunchTemplate LatestVersionNumber when the LT is updated in place (issue #985)', async () => {
    const state = baseState();
    state.resources['Lt'] = {
      physicalId: 'lt-123',
      resourceType: 'AWS::EC2::LaunchTemplate',
      properties: {
        LaunchTemplateData: { InstanceType: 't3.micro' },
      },
      // Old computed version; the resolver returns this so the ASG's raw GetAtt
      // resolves to the stale "1" and lands NO_CHANGE without the promotion.
      attributes: { LatestVersionNumber: '1', DefaultVersionNumber: '1' },
    };
    const asgLaunchTemplate = {
      LaunchTemplateId: { Ref: 'Lt' },
      Version: { 'Fn::GetAtt': ['Lt', 'LatestVersionNumber'] },
    };
    state.resources['Asg'] = {
      physicalId: 'asg-1',
      resourceType: 'AWS::AutoScaling::AutoScalingGroup',
      // State stores the RESOLVED form so a plain compare against the resolved
      // desired (which the stale resolver renders as the SAME "1") is NO_CHANGE
      // on its own -- the ONLY reason the ASG becomes UPDATE is the #985
      // derived-attribute promotion, not a raw-vs-resolved diff artifact.
      properties: {
        MinSize: '0',
        MaxSize: '0',
        LaunchTemplate: { LaunchTemplateId: 'lt-123', Version: '1' },
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        // In-place InstanceType edit -> bumps LatestVersionNumber 1 -> 2.
        Lt: {
          Type: 'AWS::EC2::LaunchTemplate',
          Properties: { LaunchTemplateData: { InstanceType: 't3.small' } },
        },
        // ASG props are byte-identical across phases; only the LT changed.
        Asg: {
          Type: 'AWS::AutoScaling::AutoScalingGroup',
          Properties: { MinSize: '0', MaxSize: '0', LaunchTemplate: asgLaunchTemplate },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Lt')?.changeType).toBe('UPDATE');
    // The ASG must be promoted even though NO template property of the ASG
    // changed and LatestVersionNumber is not a property of the LT.
    expect(changes.get('Asg')?.changeType).toBe('UPDATE');
    // The synthetic change targets the referencing property and is an in-place
    // UPDATE (LaunchTemplate is not create-only for an ASG), not a replacement.
    const ltChange = changes.get('Asg')?.propertyChanges?.find((pc) => pc.path === 'LaunchTemplate');
    expect(ltChange).toBeDefined();
    expect(ltChange?.requiresReplacement).toBe(false);
  });

  it('promotes an ASG that reads LaunchTemplate LatestVersionNumber via Fn::Sub (issue #985)', async () => {
    const state = baseState();
    state.resources['Lt'] = {
      physicalId: 'lt-123',
      resourceType: 'AWS::EC2::LaunchTemplate',
      properties: { LaunchTemplateData: { InstanceType: 't3.micro' } },
      attributes: { LatestVersionNumber: '1' },
    };
    const versionSub = { 'Fn::Sub': ['${Lt.LatestVersionNumber}', {}] };
    state.resources['Asg'] = {
      physicalId: 'asg-1',
      resourceType: 'AWS::AutoScaling::AutoScalingGroup',
      properties: { MinSize: '0', MaxSize: '0', LaunchTemplate: { Version: versionSub } },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Lt: {
          Type: 'AWS::EC2::LaunchTemplate',
          Properties: { LaunchTemplateData: { InstanceType: 't3.small' } },
        },
        Asg: {
          Type: 'AWS::AutoScaling::AutoScalingGroup',
          Properties: { MinSize: '0', MaxSize: '0', LaunchTemplate: { Version: versionSub } },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Asg')?.changeType).toBe('UPDATE');
  });

  it('does NOT promote an ASG reading LatestVersionNumber when the LT is UNCHANGED (issue #985)', async () => {
    const state = baseState();
    state.resources['Lt'] = {
      physicalId: 'lt-123',
      resourceType: 'AWS::EC2::LaunchTemplate',
      properties: { LaunchTemplateData: { InstanceType: 't3.micro' } },
      attributes: { LatestVersionNumber: '1' },
    };
    const asgLaunchTemplate = {
      LaunchTemplateId: { Ref: 'Lt' },
      Version: { 'Fn::GetAtt': ['Lt', 'LatestVersionNumber'] },
    };
    state.resources['Asg'] = {
      physicalId: 'asg-1',
      resourceType: 'AWS::AutoScaling::AutoScalingGroup',
      // State stores the RESOLVED form (what the deploy engine persists), so a
      // plain compare against the resolved desired is NO_CHANGE on its own.
      properties: {
        MinSize: '0',
        MaxSize: '0',
        LaunchTemplate: { LaunchTemplateId: 'lt-123', Version: '1' },
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        // LT is byte-identical to state -> NO_CHANGE, no version bump.
        Lt: {
          Type: 'AWS::EC2::LaunchTemplate',
          Properties: { LaunchTemplateData: { InstanceType: 't3.micro' } },
        },
        Asg: {
          Type: 'AWS::AutoScaling::AutoScalingGroup',
          Properties: { MinSize: '0', MaxSize: '0', LaunchTemplate: asgLaunchTemplate },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Lt')?.changeType).toBe('NO_CHANGE');
    expect(changes.get('Asg')?.changeType).toBe('NO_CHANGE');
  });

  it('does NOT promote an ASG reading a NON-allow-listed computed attribute of an updated LT (issue #985)', async () => {
    // Guards the allow list: only LatestVersionNumber / DefaultVersionNumber
    // trigger promotion. A GetAtt of some other LaunchTemplate attribute (here
    // the physical LaunchTemplateId, which an in-place update does not move)
    // must stay NO_CHANGE.
    const state = baseState();
    state.resources['Lt'] = {
      physicalId: 'lt-123',
      resourceType: 'AWS::EC2::LaunchTemplate',
      properties: { LaunchTemplateData: { InstanceType: 't3.micro' } },
      attributes: { LaunchTemplateId: 'lt-123', LatestVersionNumber: '1' },
    };
    const asgLaunchTemplate = {
      // Reads the immutable LaunchTemplateId via GetAtt, NOT the version.
      LaunchTemplateId: { 'Fn::GetAtt': ['Lt', 'LaunchTemplateId'] },
      Version: '1',
    };
    state.resources['Asg'] = {
      physicalId: 'asg-1',
      resourceType: 'AWS::AutoScaling::AutoScalingGroup',
      // State stores the RESOLVED form (LaunchTemplateId resolves to the stable
      // physical id), so a plain compare is NO_CHANGE on its own.
      properties: {
        MinSize: '0',
        MaxSize: '0',
        LaunchTemplate: { LaunchTemplateId: 'lt-123', Version: '1' },
      },
      attributes: {},
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Lt: {
          Type: 'AWS::EC2::LaunchTemplate',
          Properties: { LaunchTemplateData: { InstanceType: 't3.small' } },
        },
        Asg: {
          Type: 'AWS::AutoScaling::AutoScalingGroup',
          Properties: { MinSize: '0', MaxSize: '0', LaunchTemplate: asgLaunchTemplate },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Lt')?.changeType).toBe('UPDATE');
    expect(changes.get('Asg')?.changeType).toBe('NO_CHANGE');
  });

  it('does NOT mutate the desired template (resolveBestEffort resolves a clone)', async () => {
    // The intrinsic resolver mutates its input in place; resolveBestEffort must
    // clone first so the raw Fn::GetAtt survives for the deploy phase to
    // re-resolve against the in-flight (new) upstream value.
    const state = baseState();
    state.resources['Base'] = {
      physicalId: 'base',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'base', Value: 'world' },
      attributes: { Value: 'world' },
    };
    state.resources['Derived'] = {
      physicalId: 'derived',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'derived', Value: 'world' },
      attributes: {},
    };
    const derivedValue: Record<string, unknown> = {
      'Fn::Sub': ['hello-${V}', { V: { 'Fn::GetAtt': ['Base', 'Value'] } }],
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Base: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'base', Value: 'world2' } },
        Derived: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'derived', Value: derivedValue } },
      },
    };

    // A MUTATING resolver: it rewrites the Fn::Sub variable map's GetAtt in place
    // (as the real intrinsic resolver does).
    const mutatingResolver = async (value: unknown): Promise<unknown> => {
      const walk = (v: unknown): unknown => {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(walk);
        const obj = v as Record<string, unknown>;
        if ('Fn::GetAtt' in obj) return 'world'; // resolved current value
        for (const k of Object.keys(obj)) obj[k] = walk(obj[k]); // MUTATE in place
        return obj;
      };
      return walk(value);
    };

    const calc = new DiffCalculator();
    await calc.calculateDiff(state, template, mutatingResolver);

    // The shared template's raw Fn::GetAtt must be intact (NOT rewritten to 'world').
    const sub = (template.Resources.Derived.Properties!.Value as { 'Fn::Sub': [string, Record<string, unknown>] })[
      'Fn::Sub'
    ];
    expect(sub[1].V).toEqual({ 'Fn::GetAtt': ['Base', 'Value'] });
  });
});

describe('DiffCalculator - condition-excluded resource (issue #840)', () => {
  // The deploy engine prunes condition-false resources from the template
  // (`TemplateParser.filterResourcesByCondition`) BEFORE calling the diff, so
  // a resource that was created under a now-false condition reaches the diff
  // as "present in state, absent from the desired template". This asserts the
  // existing DELETE path fires for that shape — the load-bearing behavior the
  // #840 fix relies on (CFn removes a resource whose Condition flips to false).
  it('marks a resource present in state but absent from the (pruned) template as DELETE', async () => {
    const state = baseState();
    state.resources['AlwaysParam'] = {
      physicalId: 'TestStack-always',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Value: 'always' },
      attributes: {},
    };
    // Created in a prior deploy under a then-true condition.
    state.resources['PremiumOnlyParam'] = {
      physicalId: 'TestStack-premium-only',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Value: 'premium-only' },
      attributes: {},
    };

    // The effective template the deploy engine passes after pruning the
    // condition-false `PremiumOnlyParam`.
    const prunedTemplate: CloudFormationTemplate = {
      Resources: {
        AlwaysParam: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Value: 'always' },
        },
      },
    };

    const calc = new DiffCalculator();
    const changes = await calc.calculateDiff(state, prunedTemplate);

    expect(changes.get('PremiumOnlyParam')?.changeType).toBe('DELETE');
    expect(changes.get('AlwaysParam')?.changeType).toBe('NO_CHANGE');
  });
});
