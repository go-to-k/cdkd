import { describe, it, expect } from 'vite-plus/test';
import {
  buildImportPlan,
  hasCompositePhysicalIdIdentifier,
  resolveCompositePhysicalIdIdentifier,
  splitCompositePhysicalId,
} from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * Issue [#1659](https://github.com/go-to-k/cdkd/issues/1659) — `cdkd export`'s
 * identifier resolution for types whose cdkd physicalId is COMPOSITE while
 * CloudFormation's `primaryIdentifier` is a SINGLE field, plus the pre-flight
 * refusal for types CloudFormation cannot IMPORT at all.
 *
 * Every schema literal below is the live `DescribeType` shape measured in
 * us-east-1 on 2026-08-13 (see the issue's comments for the full table).
 */

const TABLE_ARN =
  'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket/table/2a1b0c9d-1111-2222-3333-444455556666';
const TABLE_BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
const TABLE_COMPOSITE = `${TABLE_BUCKET_ARN}|analytics|events`;

function ctx(overrides: {
  logicalId?: string;
  physicalId: string;
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}) {
  return {
    logicalId: overrides.logicalId ?? 'MyResource',
    physicalId: overrides.physicalId,
    properties: overrides.properties ?? {},
    attributes: overrides.attributes ?? {},
  };
}

describe('resolveCompositePhysicalIdIdentifier (issue #1659)', () => {
  it('resolves AWS::AppSync::DataSource from the recorded DataSourceArn, not the composite id', () => {
    const arn = 'arn:aws:appsync:us-east-1:123456789012:apis/abc123/datasources/MyDs';
    const resolved = resolveCompositePhysicalIdIdentifier(
      'AWS::AppSync::DataSource',
      ctx({ physicalId: 'abc123|MyDs', attributes: { DataSourceArn: arn } })
    );
    expect(resolved).toEqual({ field: 'DataSourceArn', value: arn });
    // The defect being fenced: the pre-fix single-key branch returned the
    // composite physical id as the identifier VALUE.
    expect(resolved.value).not.toBe('abc123|MyDs');
  });

  it('resolves AWS::AppSync::Resolver from the recorded ResolverArn', () => {
    const arn = 'arn:aws:appsync:us-east-1:123456789012:apis/abc123/types/Query/resolvers/getItem';
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::AppSync::Resolver',
        ctx({ physicalId: 'abc123|Query|getItem', attributes: { ResolverArn: arn } })
      )
    ).toEqual({ field: 'ResolverArn', value: arn });
  });

  it('resolves AWS::S3Tables::Table from the recorded TableARN', () => {
    const resolved = resolveCompositePhysicalIdIdentifier(
      'AWS::S3Tables::Table',
      ctx({ physicalId: TABLE_COMPOSITE, attributes: { TableARN: TABLE_ARN } })
    );
    expect(resolved).toEqual({ field: 'TableARN', value: TABLE_ARN });
    // Deliberately distinct values: a fixture where the recorded ARN equalled
    // the physical id would fence neither arm of the preference below.
    expect(resolved.value).not.toBe(TABLE_COMPOSITE);
  });

  it('accepts a bare-ARN physicalId when no attribute was recorded (the CC-routed import shape)', () => {
    // `S3TablesProvider.importTable` records the bare TableARN as the
    // physicalId for a Cloud-Control-routed table.
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({ physicalId: TABLE_ARN, attributes: {} })
      )
    ).toEqual({ field: 'TableARN', value: TABLE_ARN });
  });

  it('prefers the recorded attribute over a bare-ARN physicalId (both arms present)', () => {
    const other = `${TABLE_ARN}-recorded`;
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({ physicalId: TABLE_ARN, attributes: { TableARN: other } })
      ).value
    ).toBe(other);
  });

  it('refuses a composite physicalId with no recorded ARN, naming the logical id and the remedy', () => {
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({ logicalId: 'AnalyticsTable', physicalId: TABLE_COMPOSITE, attributes: {} })
      )
    ).toThrow(/'AnalyticsTable'.*attributes\.TableARN is missing or empty.*Re-deploy the stack/s);
  });

  it('refuses a blank recorded ARN rather than shipping whitespace as the identifier', () => {
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({ physicalId: TABLE_COMPOSITE, attributes: { TableARN: '   ' } })
      )
    ).toThrow(/missing or empty/);
  });

  it('refuses a non-ARN, non-composite physicalId (nothing proves it is the CFn identifier)', () => {
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::AppSync::DataSource',
        ctx({ physicalId: 'MyDs', attributes: {} })
      )
    ).toThrow(/attributes\.DataSourceArn is missing or empty/);
  });

  it('refuses AWS::EC2::SecurityGroupIngress with a pointer at the sgr- recording issue', () => {
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ logicalId: 'SshIn', physicalId: 'sg-0abc|tcp|22|22' })
      )
    ).toThrow(/'sgr-\.\.\.'.*issues\/1761.*Remove 'SshIn' from the stack/s);
  });

  it('refuses AWS::EC2::SecurityGroupIngress even when an Id attribute happens to be present', () => {
    // The refusal is deliberate, not a lookup miss: nothing in cdkd writes an
    // `Id` attribute for this type today, so a record carrying one is not
    // evidence the value is the rule id AWS minted.
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ physicalId: 'sg-0abc|tcp|22|22', attributes: { Id: 'sgr-0123456789abcdef0' } })
      )
    ).toThrow(/issues\/1761/);
  });

  it('throws for a type with no registered entry', () => {
    expect(() =>
      resolveCompositePhysicalIdIdentifier('AWS::S3::Bucket', ctx({ physicalId: 'my-bucket' }))
    ).toThrow(/no composite-physicalId identifier registered for AWS::S3::Bucket/);
  });

  it('hasCompositePhysicalIdIdentifier covers exactly the four measured types', () => {
    for (const t of [
      'AWS::AppSync::DataSource',
      'AWS::AppSync::Resolver',
      'AWS::S3Tables::Table',
      'AWS::EC2::SecurityGroupIngress',
    ]) {
      expect(hasCompositePhysicalIdIdentifier(t)).toBe(true);
    }
    // Composite cdkd id, but a MULTI-field CFn identifier — the splitter
    // family's job, not this table's.
    expect(hasCompositePhysicalIdIdentifier('AWS::ApiGateway::Method')).toBe(false);
    expect(hasCompositePhysicalIdIdentifier('AWS::S3Tables::Namespace')).toBe(false);
    expect(hasCompositePhysicalIdIdentifier('AWS::S3::Bucket')).toBe(false);
  });

  it('trims a padded recorded ARN rather than shipping whitespace into the changeset', () => {
    // The guard tests `.trim()` but the RETURN must be trimmed too — CFn
    // rejects an identifier carrying leading / trailing whitespace verbatim.
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({ physicalId: TABLE_COMPOSITE, attributes: { TableARN: `  ${TABLE_ARN}\n` } })
      ).value
    ).toBe(TABLE_ARN);
  });

  it('rejects a bare ARN naming a DIFFERENT service on the physicalId arm', () => {
    // Arm 2 exists for a row whose id is already this type's CFn identifier.
    // An ARN for some other service is a different value entirely, so the
    // `arn:` prefix alone is not enough evidence.
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({ physicalId: 'arn:aws:s3:::my-bucket', attributes: {} })
      )
    ).toThrow(/attributes\.TableARN is missing or empty/);
    // ...while the right service passes, in any partition.
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({
          physicalId: TABLE_ARN.replace('arn:aws:', 'arn:aws-cn:'),
          attributes: {},
        })
      ).value
    ).toBe(TABLE_ARN.replace('arn:aws:', 'arn:aws-cn:'));
  });

  it('accepts an AppSync child adopted from CloudFormation, whose physicalId is the ARN', () => {
    // `cdkd import --migrate-from-cloudformation` records CFn's
    // PhysicalResourceId verbatim, which for these children is the ARN — the
    // second live producer of arm 2 alongside S3TablesProvider.importTable.
    const arn = 'arn:aws:appsync:us-east-1:123456789012:apis/abc123/datasources/MyDs';
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::AppSync::DataSource',
        ctx({ physicalId: arn, attributes: {} })
      ).value
    ).toBe(arn);
  });

  it('refuses a recorded attribute that is not a string', () => {
    // A state record whose attribute holds a number / object / array is
    // corrupt, not a usable identifier — the typeof gate must reject it rather
    // than stringify it into the changeset.
    for (const bad of [12345, { arn: TABLE_ARN }, [TABLE_ARN], null, true]) {
      expect(() =>
        resolveCompositePhysicalIdIdentifier(
          'AWS::S3Tables::Table',
          ctx({ physicalId: TABLE_COMPOSITE, attributes: { TableARN: bad } })
        )
      ).toThrow(/attributes\.TableARN is missing or empty/);
    }
  });
});

// -----------------------------------------------------------------------------
// buildImportPlan integration: the same two behaviors through the real plan
// builder, against stubbed DescribeType responses carrying the measured shapes.
// -----------------------------------------------------------------------------

type SchemaStub = {
  primaryIdentifier: string[];
  handlers?: Record<string, unknown>;
  /** DescribeType RESPONSE field, not part of the schema JSON. */
  provisioningType?: string;
};

/**
 * Live `DescribeType` shapes, measured us-east-1 2026-08-13. Every
 * no-read-handler type below is also `NON_PROVISIONABLE`, and every importable
 * one is `FULLY_MUTABLE` — the two-agreeing-fields rule the pre-flight applies.
 */
const SCHEMAS: Record<string, SchemaStub> = {
  'AWS::S3Tables::Table': {
    primaryIdentifier: ['/properties/TableARN'],
    handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
    provisioningType: 'FULLY_MUTABLE',
  },
  'AWS::AppSync::DataSource': {
    primaryIdentifier: ['/properties/DataSourceArn'],
    handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
    provisioningType: 'FULLY_MUTABLE',
  },
  'AWS::S3::Bucket': {
    primaryIdentifier: ['/properties/BucketName'],
    handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
    provisioningType: 'FULLY_MUTABLE',
  },
  // No `handlers` block AT ALL — the legacy shape.
  'AWS::Glue::Table': {
    primaryIdentifier: ['/properties/Id'],
    provisioningType: 'NON_PROVISIONABLE',
  },
  'AWS::Route53::RecordSet': {
    primaryIdentifier: ['/properties/Id'],
    provisioningType: 'NON_PROVISIONABLE',
  },
  // A `handlers` block WITHOUT `read` — the second shape of the same verdict.
  'AWS::EC2::NetworkAclEntry': {
    primaryIdentifier: ['/properties/Id'],
    handlers: { create: {}, update: {}, delete: {} },
    provisioningType: 'NON_PROVISIONABLE',
  },
  'AWS::IAM::Policy': {
    primaryIdentifier: ['/properties/Id'],
    handlers: { create: {}, update: {}, delete: {} },
    provisioningType: 'NON_PROVISIONABLE',
  },
  'AWS::EC2::SecurityGroupIngress': {
    primaryIdentifier: ['/properties/Id'],
    handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
    provisioningType: 'FULLY_MUTABLE',
  },
  'AWS::S3Tables::Namespace': {
    primaryIdentifier: ['/properties/TableBucketARN', '/properties/Namespace'],
    handlers: { create: {}, read: {}, delete: {}, list: {} },
    provisioningType: 'IMMUTABLE',
  },
};

/** Records one entry per DescribeType call the plan builder issues. */
const describeTypeCalls: string[] = [];

function cfnClientFor(
  schemas: Record<string, SchemaStub | 'describe-type-fails'> = SCHEMAS
): AwsClients['cloudFormation'] {
  return {
    async send(cmd: { input?: { TypeName?: string } }) {
      describeTypeCalls.push(cmd.input?.TypeName ?? '');
      const typeName = cmd.input?.TypeName ?? '';
      const schema = schemas[typeName];
      if (schema === undefined || schema === 'describe-type-fails') {
        throw new Error(`DescribeType stub: no schema for ${typeName}`);
      }
      const { provisioningType, ...schemaJson } = schema;
      return {
        Schema: JSON.stringify(schemaJson),
        ...(provisioningType !== undefined && { ProvisioningType: provisioningType }),
      };
    },
  } as unknown as AwsClients['cloudFormation'];
}

function stateWith(
  resources: Record<
    string,
    {
      resourceType: string;
      physicalId: string;
      properties?: Record<string, unknown>;
      attributes?: Record<string, unknown>;
    }
  >
): StackState {
  const out: StackState['resources'] = {};
  for (const [logicalId, r] of Object.entries(resources)) {
    out[logicalId] = {
      physicalId: r.physicalId,
      resourceType: r.resourceType,
      properties: r.properties ?? {},
      attributes: r.attributes ?? {},
      dependencies: [],
    };
  }
  return {
    version: 8,
    stackName: 'MyStack',
    region: 'us-east-1',
    resources: out,
    outputs: {},
    lastModified: 0,
  };
}

describe('buildImportPlan — composite physicalId identifier (issue #1659)', () => {
  it('sends the recorded TableARN, not cdkd composite id, and overlays NOTHING onto Properties', async () => {
    const state = stateWith({
      Table: {
        resourceType: 'AWS::S3Tables::Table',
        physicalId: TABLE_COMPOSITE,
        attributes: { TableARN: TABLE_ARN },
      },
    });
    const template = {
      Resources: {
        Table: {
          Type: 'AWS::S3Tables::Table',
          Properties: { Namespace: 'analytics', TableName: 'events' },
        },
      },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports).toHaveLength(1);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ TableARN: TABLE_ARN });
    // `TableARN` is readOnlyProperties — writing it into the template's
    // Properties block is rejected by CFn at changeset-create.
    expect(plan.phase1Imports[0]!.propertiesOverlay).toEqual({});
    // The physical id is still reported verbatim (it is what cdkd state holds).
    expect(plan.phase1Imports[0]!.physicalId).toBe(TABLE_COMPOSITE);
  });

  it('blocks the resource (rather than sending a wrong identifier) when the ARN is unrecorded', async () => {
    const state = stateWith({
      Table: { resourceType: 'AWS::S3Tables::Table', physicalId: TABLE_COMPOSITE },
    });
    const template = { Resources: { Table: { Type: 'AWS::S3Tables::Table', Properties: {} } } };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(
      /could not resolve resource identifier.*attributes\.TableARN is missing or empty/s
    );
  });

  it('refuses when the registry schema no longer matches the registered field (drift guard)', async () => {
    const state = stateWith({
      Table: {
        resourceType: 'AWS::S3Tables::Table',
        physicalId: TABLE_COMPOSITE,
        attributes: { TableARN: TABLE_ARN },
      },
    });
    const template = { Resources: { Table: { Type: 'AWS::S3Tables::Table', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        'AWS::S3Tables::Table': {
          primaryIdentifier: ['/properties/TableBucketARN', '/properties/Namespace'],
          handlers: { read: {} },
        },
      }),
      'MyStack'
    );
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked[0]!.reason).toMatch(
      /primaryIdentifier \[TableBucketARN, Namespace\].*registry schema changed under cdkd/s
    );
  });

  it('refuses when the registered field is renamed but the arity still matches', async () => {
    // Fences the FIELD-NAME half of the drift guard on its own: a fixture where
    // the arity ALSO changed satisfies both disjuncts and fences neither.
    const state = stateWith({
      Table: {
        resourceType: 'AWS::S3Tables::Table',
        physicalId: TABLE_COMPOSITE,
        attributes: { TableARN: TABLE_ARN },
      },
    });
    const template = { Resources: { Table: { Type: 'AWS::S3Tables::Table', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        'AWS::S3Tables::Table': {
          primaryIdentifier: ['/properties/TableArn'],
          handlers: { read: {} },
          provisioningType: 'FULLY_MUTABLE',
        },
      }),
      'MyStack'
    );
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked[0]!.reason).toMatch(
      /primaryIdentifier \[TableArn\].*registry schema changed under cdkd/s
    );
  });

  it('refuses when the field still matches but the identifier became composite', async () => {
    // Fences the ARITY half on its own. Without it, a type AWS makes
    // multi-field would silently ship a single-key identifier again — the
    // exact #1659 defect, re-created.
    const state = stateWith({
      Table: {
        resourceType: 'AWS::S3Tables::Table',
        physicalId: TABLE_COMPOSITE,
        attributes: { TableARN: TABLE_ARN },
      },
    });
    const template = { Resources: { Table: { Type: 'AWS::S3Tables::Table', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        'AWS::S3Tables::Table': {
          primaryIdentifier: ['/properties/TableARN', '/properties/Namespace'],
          handlers: { read: {} },
          provisioningType: 'FULLY_MUTABLE',
        },
      }),
      'MyStack'
    );
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked[0]!.reason).toMatch(
      /primaryIdentifier \[TableARN, Namespace\].*registry schema changed under cdkd/s
    );
  });

  it('surfaces the AWS::EC2::SecurityGroupIngress refusal as a blocked row, not a crash', async () => {
    // The type IS importable as far as CFn is concerned (read handler present,
    // FULLY_MUTABLE), so it reaches the identifier resolution and is refused
    // there — the run must continue and report it alongside other rows.
    const state = stateWith({
      SshIn: {
        resourceType: 'AWS::EC2::SecurityGroupIngress',
        physicalId: 'sg-0abc|tcp|22|22',
      },
      Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'mystack-bucket-123' },
    });
    const template = {
      Resources: {
        SshIn: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: {} },
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.logicalId).toBe('SshIn');
    expect(plan.blocked[0]!.reason).toMatch(/could not resolve resource identifier.*issues\/1761/s);
    // The sibling still resolved — a refusal is per-resource, not a run abort.
    expect(plan.phase1Imports.map((p) => p.logicalId)).toEqual(['Bucket']);
  });

  it('routes AWS::S3Tables::Namespace through its splitter (multi-field arm)', async () => {
    // The sibling splitter registered alongside this fix: without it an S3
    // Tables stack aborts before ever reaching the Table row above.
    const state = stateWith({
      Namespace: {
        resourceType: 'AWS::S3Tables::Namespace',
        physicalId: `${TABLE_BUCKET_ARN}|analytics`,
      },
    });
    const template = {
      Resources: { Namespace: { Type: 'AWS::S3Tables::Namespace', Properties: {} } },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({
      TableBucketARN: TABLE_BUCKET_ARN,
      Namespace: 'analytics',
    });
  });

  it('leaves an ordinary single-key type resolving from its physical id', async () => {
    const state = stateWith({
      Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'mystack-bucket-123' },
    });
    const template = { Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } } };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ BucketName: 'mystack-bucket-123' });
    // Unregistered types keep the whole-map overlay default.
    expect(plan.phase1Imports[0]!.propertiesOverlay).toEqual({ BucketName: 'mystack-bucket-123' });
  });
});

describe('buildImportPlan — IMPORT read-handler pre-flight (issue #1659)', () => {
  it('blocks a type whose schema declares NO handlers block at all', async () => {
    const state = stateWith({
      GlueTable: { resourceType: 'AWS::Glue::Table', physicalId: 'mydb|my_table' },
    });
    const template = { Resources: { GlueTable: { Type: 'AWS::Glue::Table', Properties: {} } } };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(
      /does not support AWS::Glue::Table in IMPORT changesets.*no 'read' handler/s
    );
    expect(plan.blocked[0]!.reason).toMatch(
      /ResourceTypes \[AWS::Glue::Table\] are not supported for Import/
    );
  });

  it('blocks a type whose handlers block exists but omits read', async () => {
    const state = stateWith({
      Entry: { resourceType: 'AWS::EC2::NetworkAclEntry', physicalId: 'acl-0abc|100|false' },
    });
    const template = {
      Resources: { Entry: { Type: 'AWS::EC2::NetworkAclEntry', Properties: {} } },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/no 'read' handler/);
  });

  it('names EVERY offender in one pass (AWS names only some of them)', async () => {
    const state = stateWith({
      GlueTable: { resourceType: 'AWS::Glue::Table', physicalId: 'mydb|my_table' },
      Record: { resourceType: 'AWS::Route53::RecordSet', physicalId: 'Z123|www.example.com.|A' },
      Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'mystack-bucket-123' },
    });
    const template = {
      Resources: {
        GlueTable: { Type: 'AWS::Glue::Table', Properties: {} },
        Record: { Type: 'AWS::Route53::RecordSet', Properties: {} },
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked.map((b) => b.logicalId).sort()).toEqual(['GlueTable', 'Record']);
    expect(plan.phase1Imports.map((p) => p.logicalId)).toEqual(['Bucket']);
  });

  it('does NOT block a type whose schema declares a read handler', async () => {
    const state = stateWith({
      Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'mystack-bucket-123' },
    });
    const template = { Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } } };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports).toHaveLength(1);
  });

  it('does NOT block when DescribeType is unusable and the fallback table answers', async () => {
    // A permissions gap / throttle must never be read as "AWS cannot import
    // this type" — the fallback carries identifier names only.
    const state = stateWith({
      Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'mystack-bucket-123' },
    });
    const template = { Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({ 'AWS::S3::Bucket': 'describe-type-fails' }),
      'MyStack'
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ BucketName: 'mystack-bucket-123' });
  });

  it('does NOT block when only ONE of the two signals says unsupported (provisionable type)', async () => {
    // A read-handler-less schema on a FULLY_MUTABLE type is not a shape any
    // measured rejection had. Refusing on one signal would turn a working
    // export into a cdkd-side failure — strictly worse than letting
    // CreateChangeSet answer, which is what `unknown` preserves.
    const state = stateWith({
      Thing: { resourceType: 'AWS::Some::Thing', physicalId: 'thing-1' },
    });
    const template = { Resources: { Thing: { Type: 'AWS::Some::Thing', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        'AWS::Some::Thing': {
          primaryIdentifier: ['/properties/Id'],
          handlers: { create: {}, update: {}, delete: {} },
          provisioningType: 'FULLY_MUTABLE',
        },
      }),
      'MyStack'
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: 'thing-1' });
  });

  it('does NOT block a NON_PROVISIONABLE type that DOES declare a read handler', async () => {
    // The other direction of disagreement. No type measured on 2026-08-13 had
    // this combination — across 21 sampled types the two signals were
    // perfectly correlated — so this arm pins the RULE rather than an observed
    // type: the `read` handler is the mechanistic reason CFn accepts a type for
    // IMPORT, so refusing on `ProvisioningType` alone would reject a type that
    // can genuinely be adopted. Without this fixture the read-handler half of
    // the predicate is unfenced (both candidate values coincide everywhere
    // else), which a mutation probe demonstrated.
    const state = stateWith({
      Thing: { resourceType: 'AWS::Some::Thing', physicalId: 'thing-1' },
    });
    const template = { Resources: { Thing: { Type: 'AWS::Some::Thing', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        'AWS::Some::Thing': {
          primaryIdentifier: ['/properties/Id'],
          handlers: { create: {}, read: {}, update: {}, delete: {} },
          provisioningType: 'NON_PROVISIONABLE',
        },
      }),
      'MyStack'
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: 'thing-1' });
  });

  it('does NOT block on a partial schema carrying neither handlers nor ProvisioningType', async () => {
    const state = stateWith({
      Thing: { resourceType: 'AWS::Some::Thing', physicalId: 'thing-1' },
    });
    const template = { Resources: { Thing: { Type: 'AWS::Some::Thing', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({ 'AWS::Some::Thing': { primaryIdentifier: ['/properties/Id'] } }),
      'MyStack'
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports).toHaveLength(1);
  });

  it('reports the fallback-less unresolvable type as an identifier failure, not as unsupported', async () => {
    // The `catch` around the shared lookup must keep `fetchPrimaryIdentifier`'s
    // own remediation message. Every other DescribeType-fails fixture uses a
    // type that IS in PRIMARY_IDENTIFIER_FALLBACK, so this is the only case
    // that reaches the throw-through.
    const state = stateWith({
      Thing: { resourceType: 'AWS::Some::Thing', physicalId: 'thing-1' },
    });
    const template = { Resources: { Thing: { Type: 'AWS::Some::Thing', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({ 'AWS::Some::Thing': 'describe-type-fails' }),
      'MyStack'
    );
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(
      /could not resolve resource identifier: primary identifier unknown/
    );
    // Must NOT be mis-reported as "AWS cannot import this type".
    expect(plan.blocked[0]!.reason).not.toMatch(/does not support .* in IMPORT changesets/);
  });

  it('issues exactly ONE DescribeType per resource type across pre-flight + resolution', async () => {
    // `cachedTypeSchemaInfo` exists so the two consumers share one call. A
    // regression to a per-consumer fetch doubles DescribeType on every export
    // and is otherwise invisible.
    describeTypeCalls.length = 0;
    const state = stateWith({
      BucketA: { resourceType: 'AWS::S3::Bucket', physicalId: 'bucket-a' },
      BucketB: { resourceType: 'AWS::S3::Bucket', physicalId: 'bucket-b' },
      Table: {
        resourceType: 'AWS::S3Tables::Table',
        physicalId: TABLE_COMPOSITE,
        attributes: { TableARN: TABLE_ARN },
      },
    });
    const template = {
      Resources: {
        BucketA: { Type: 'AWS::S3::Bucket', Properties: {} },
        BucketB: { Type: 'AWS::S3::Bucket', Properties: {} },
        Table: { Type: 'AWS::S3Tables::Table', Properties: {} },
      },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(describeTypeCalls).toEqual(['AWS::S3::Bucket', 'AWS::S3Tables::Table']);
  });

  it('treats a `handlers: []` array (the legacy render) as no read handler', async () => {
    // Real registry entries render an EMPTY handlers block as an array — see
    // the AWS::ApiGatewayV2::Stage note in export.ts. `hasOwnProperty` on an
    // array is false either way, but the fixture pins the real wire shape.
    const state = stateWith({
      Thing: { resourceType: 'AWS::Some::Thing', physicalId: 'thing-1' },
    });
    const template = { Resources: { Thing: { Type: 'AWS::Some::Thing', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        'AWS::Some::Thing': {
          primaryIdentifier: ['/properties/Id'],
          handlers: [] as unknown as Record<string, unknown>,
          provisioningType: 'NON_PROVISIONABLE',
        },
      }),
      'MyStack'
    );
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/no 'read' handler/);
  });

  it('leaves the recreate-before-phase-2 types on their own path (ordering fence)', async () => {
    // AWS::IAM::Policy also lacks a `read` handler, but cdkd has a real answer
    // for it: pre-delete + phase-2 CREATE. The pre-flight must not steal it.
    const state = stateWith({
      Policy: { resourceType: 'AWS::IAM::Policy', physicalId: 'MyRole:MyPolicy' },
    });
    const template = { Resources: { Policy: { Type: 'AWS::IAM::Policy', Properties: {} } } };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.recreateBeforePhase2.map((r) => r.logicalId)).toEqual(['Policy']);
  });
});

// -----------------------------------------------------------------------------
// The sibling splitter this change had to add to reach the fix above: without
// it `cdkd export` aborts on every S3 Tables stack, because a table cannot be
// exported without the namespace resource it lives in.
// -----------------------------------------------------------------------------

describe('AWS::S3Tables::Namespace composite-id splitter (issue #1659 live-test residual)', () => {
  const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';

  it('splits `<tableBucketARN>|<namespaceName>` into the CFn identifier order', () => {
    expect(splitCompositePhysicalId('AWS::S3Tables::Namespace', `${BUCKET_ARN}|analytics`)).toEqual({
      resourceIdentifier: { TableBucketARN: BUCKET_ARN, Namespace: 'analytics' },
    });
  });

  it('leaves propertiesOverlay at the whole-map default (neither field is read-only)', () => {
    // Live DescribeType (us-east-1, 2026-08-13) reports no `readOnlyProperties`
    // at all for this type, and the synth template carries both fields — so
    // narrowing would be wrong here, unlike the sibling ApiGateway splitters.
    expect(
      splitCompositePhysicalId('AWS::S3Tables::Namespace', `${BUCKET_ARN}|analytics`)
        .propertiesOverlay
    ).toBeUndefined();
  });

  it('refuses a physical id with the wrong number of parts', () => {
    expect(() => splitCompositePhysicalId('AWS::S3Tables::Namespace', BUCKET_ARN)).toThrow(
      /expected 2 parts.*got 1/
    );
    expect(() =>
      splitCompositePhysicalId('AWS::S3Tables::Namespace', `${BUCKET_ARN}|analytics|events`)
    ).toThrow(/expected 2 parts.*got 3/);
  });

  it('refuses an empty segment rather than shipping a blank identifier field', () => {
    expect(() => splitCompositePhysicalId('AWS::S3Tables::Namespace', `${BUCKET_ARN}|`)).toThrow(
      /empty part/
    );
    expect(() => splitCompositePhysicalId('AWS::S3Tables::Namespace', '|analytics')).toThrow(
      /empty part/
    );
  });
});
