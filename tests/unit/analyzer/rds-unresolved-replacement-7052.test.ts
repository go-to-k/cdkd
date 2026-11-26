/**
 * go-to-k/cdkd#7052: an RDS handler-immutable property (#7044) whose new value
 * the diff cannot resolve yet, or whose referent this deploy replaces, is
 * judged as CloudFormation's handler judges it once resolved: a new
 * resource's id cannot equal a non-empty previous string. Before, both read as
 * "no replacement", so `cdkd diff` showed an update and the deploy sent the
 * moved key on `ModifyDBInstance` where CloudFormation creates a new instance
 * (measured for key A -> key B on #7038).
 */
import { describe, it, expect, vi } from 'vite-plus/test';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory.
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(
    importOriginal
  )
);

vi.mock('../../../src/provisioning/create-only-properties.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    ...actual,
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

vi.mock('../../../src/provisioning/write-only-properties.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, tryGetTopLevelWriteOnlyProperties: async () => new Set<string>() };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { PropertyChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const INSTANCE = 'AWS::RDS::DBInstance';
const KEY = 'AWS::KMS::Key';
const KEY_A = 'arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-1111-2222-3333-444444444444';
const BASE = { Engine: 'mysql', DBInstanceClass: 'db.t4g.medium', EnablePerformanceInsights: true };

type Records = Record<string, { type: string; physicalId: string; props: Record<string, unknown>; attributes?: Record<string, unknown> }>;

function stateOf(records: Records): StackState {
  const resources: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(records)) {
    resources[id] = {
      physicalId: r.physicalId,
      resourceType: r.type,
      properties: r.props,
      attributes: r.attributes ?? {},
      dependencies: [],
    };
  }
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources,
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

/**
 * Resolves `Ref` / `Fn::GetAtt` against the persisted state, as the deploy's
 * diff context does; a reference to a resource absent from state throws, so
 * the diff keeps the raw intrinsic.
 */
const resolverOf =
  (state: StackState) =>
  async (value: unknown): Promise<unknown> => {
    const resolve = (v: unknown): unknown => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(resolve);
      const obj = v as Record<string, unknown>;
      if ('Ref' in obj && Object.keys(obj).length === 1) {
        const res = state.resources[obj['Ref'] as string];
        if (!res) throw new Error(`Ref ${String(obj['Ref'])} not found`);
        return res.physicalId;
      }
      if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
        const [id, attr] = obj['Fn::GetAtt'] as [string, string];
        const attrValue = state.resources[id]?.attributes?.[attr];
        if (attrValue === undefined) throw new Error(`GetAtt ${id}.${attr} not found`);
        return attrValue;
      }
      return Object.fromEntries(Object.entries(obj).map(([k, val]) => [k, resolve(val)]));
    };
    return resolve(value);
  };

async function rowOf(
  records: Records,
  template: CloudFormationTemplate,
  logicalId: string,
  path: string,
  recreateTargets?: ReadonlySet<string>
): Promise<PropertyChange | undefined> {
  const state = stateOf(records);
  const changes = await new DiffCalculator().calculateDiff(
    state,
    template,
    resolverOf(state),
    undefined,
    undefined,
    undefined,
    undefined,
    recreateTargets
  );
  return changes.get(logicalId)?.propertyChanges?.find((pc) => pc.path === path);
}

const DB_ON_KEY_A = { type: INSTANCE, physicalId: 'my-db', props: { ...BASE, PerformanceInsightsKMSKeyId: KEY_A } };

describe('an RDS handler-immutable value the diff cannot resolve yet (go-to-k/cdkd#7052)', () => {
  it('PerformanceInsightsKMSKeyId moved to a key created in this deploy replaces the instance', async () => {
    const pc = await rowOf(
      { Db: DB_ON_KEY_A },
      {
        Resources: {
          NewKey: { Type: KEY, Properties: {} },
          Db: {
            Type: INSTANCE,
            Properties: { ...BASE, PerformanceInsightsKMSKeyId: { 'Fn::GetAtt': ['NewKey', 'Arn'] } },
          },
        },
      } as CloudFormationTemplate,
      'Db',
      'PerformanceInsightsKMSKeyId'
    );
    expect(pc?.newValue).toEqual({ 'Fn::GetAtt': ['NewKey', 'Arn'] });
    expect(pc?.requiresReplacement).toBe(true);
  });

  it('CONTROL: a first key created in this deploy stays in place (the previous key is empty)', async () => {
    const pc = await rowOf(
      { Db: { type: INSTANCE, physicalId: 'my-db', props: BASE } },
      {
        Resources: {
          NewKey: { Type: KEY, Properties: {} },
          Db: {
            Type: INSTANCE,
            Properties: { ...BASE, PerformanceInsightsKMSKeyId: { 'Fn::GetAtt': ['NewKey', 'Arn'] } },
          },
        },
      } as CloudFormationTemplate,
      'Db',
      'PerformanceInsightsKMSKeyId'
    );
    expect(pc).toBeDefined();
    expect(pc?.requiresReplacement).toBe(false);
  });
});

describe('an RDS handler-immutable reference to a resource this deploy replaces (go-to-k/cdkd#7052)', () => {
  it('the instance reading a recreated KMS key is promoted to a replacement ceiling', async () => {
    const pc = await rowOf(
      {
        Key: { type: KEY, physicalId: 'aaaaaaaa-1111', props: {}, attributes: { Arn: KEY_A } },
        Db: DB_ON_KEY_A,
      },
      {
        Resources: {
          Key: { Type: KEY, Properties: {} },
          Db: {
            Type: INSTANCE,
            Properties: { ...BASE, PerformanceInsightsKMSKeyId: { 'Fn::GetAtt': ['Key', 'Arn'] } },
          },
        },
      } as CloudFormationTemplate,
      'Db',
      'PerformanceInsightsKMSKeyId',
      new Set(['Key'])
    );
    expect(pc?.replacementPropagated).toBe(true);
    expect(pc?.requiresReplacement).toBe(true);
  });

  it('a read replica whose source instance is replaced is promoted to a replacement ceiling', async () => {
    const pc = await rowOf(
      {
        Source: { type: INSTANCE, physicalId: 'source-db', props: { Engine: 'mysql', DBInstanceClass: 'db.t4g.micro' } },
        Replica: {
          type: INSTANCE,
          physicalId: 'replica-db',
          props: { DBInstanceClass: 'db.t4g.micro', SourceDBInstanceIdentifier: 'source-db' },
        },
      },
      {
        Resources: {
          // An Engine family change replaces the source (#5467).
          Source: { Type: INSTANCE, Properties: { Engine: 'postgres', DBInstanceClass: 'db.t4g.micro' } },
          Replica: {
            Type: INSTANCE,
            Properties: { DBInstanceClass: 'db.t4g.micro', SourceDBInstanceIdentifier: { Ref: 'Source' } },
          },
        },
      } as CloudFormationTemplate,
      'Replica',
      'SourceDBInstanceIdentifier'
    );
    expect(pc?.replacementPropagated).toBe(true);
    expect(pc?.requiresReplacement).toBe(true);
  });
});
