import { describe, it, expect } from 'vite-plus/test';
import {
  buildImportPlan,
  cfnRefusesImportDespiteRegistry,
  COMPOSITE_PHYSICAL_ID_IDENTIFIER_TYPES,
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

/**
 * Issue #1761. The rule-id shape is the one measured live (us-east-1,
 * 2026-08-14) as a CloudFormation stack's `PhysicalResourceId` for a standalone
 * `AWS::EC2::SecurityGroupIngress`; the composite is what `EC2Provider` stores
 * as the physical id. Deliberately unrelated strings — a fixture where the two
 * coincided would fence neither arm of the source preference.
 */
const SG_RULE_ID = 'sgr-02345615af6d2db0d';
const SG_INGRESS_COMPOSITE = 'sg-0abc0def0|tcp|443|443';

function ctx(overrides: {
  logicalId?: string;
  physicalId: string;
  attributes?: Record<string, unknown>;
}) {
  return {
    logicalId: overrides.logicalId ?? 'MyResource',
    physicalId: overrides.physicalId,
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

  it('resolves AWS::EC2::SecurityGroupIngress from the recorded Id, not the composite', () => {
    // Inverted by issue #1761: this used to PIN the refusal, with a comment
    // saying "nothing in cdkd writes an `Id` attribute for this type today".
    // `EC2Provider` writes it now, so pinning the refusal kept CI green over
    // the wrong behavior.
    const resolved = resolveCompositePhysicalIdIdentifier(
      'AWS::EC2::SecurityGroupIngress',
      ctx({ physicalId: SG_INGRESS_COMPOSITE, attributes: { Id: SG_RULE_ID } })
    );
    expect(resolved).toEqual({ field: 'Id', value: SG_RULE_ID });
    // The pre-#1659 defect: the single-key branch shipped the composite AS the
    // identifier value.
    expect(resolved.value).not.toBe(SG_INGRESS_COMPOSITE);
  });

  it('accepts a bare sgr- physicalId when no attribute was recorded', () => {
    // CloudFormation's own `PhysicalResourceId` for the type IS the bare rule
    // id (measured live, us-east-1 2026-08-14: `sgr-02345615af6d2db0d`), so a
    // row hand-repaired from a CFn listing carries an unambiguous identifier.
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ physicalId: SG_RULE_ID, attributes: {} })
      )
    ).toEqual({ field: 'Id', value: SG_RULE_ID });
  });

  it('prefers the recorded attribute over a bare sgr- physicalId (both arms present)', () => {
    const other = 'sgr-99999999999999999';
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ physicalId: SG_RULE_ID, attributes: { Id: other } })
      ).value
    ).toBe(other);
  });

  it('trims a padded recorded rule id rather than shipping the whitespace', () => {
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ physicalId: SG_INGRESS_COMPOSITE, attributes: { Id: `  ${SG_RULE_ID}\n` } })
      ).value
    ).toBe(SG_RULE_ID);
  });

  it('trims a padded FALLBACK physicalId too — the other return path', () => {
    // Its own case: the attribute arm's `.trim()` and the physicalId arm's are
    // separate returns, so a test that only pads the attribute leaves the
    // second one unfenced (dropping `.trim()` there alone stays green).
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ physicalId: `  ${SG_RULE_ID}\n`, attributes: {} })
      ).value
    ).toBe(SG_RULE_ID);
  });

  it('refuses a composite physicalId with no recorded rule id, naming the real remedy', () => {
    // The remedy differs from the ARN family's plain "re-deploy the stack":
    // AWS returns the rule id only from `AuthorizeSecurityGroupIngress`, so a
    // no-op deploy issues no call and heals nothing.
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ logicalId: 'SshIn', physicalId: SG_INGRESS_COMPOSITE, attributes: {} })
      )
    ).toThrow(
      /'SshIn'.*attributes\.Id is missing or empty.*no-op re-deploy will NOT heal the record/s
    );
  });

  it('names the MULTI-SOURCE cause too — re-deploying does not heal that one', () => {
    // `buildIpPermission` emits both `IpRanges` and `Ipv6Ranges` when one
    // ingress resource sets `CidrIp` AND `CidrIpv6`; AWS mints a rule per
    // source and `singleSecurityGroupRuleId` deliberately records neither. A
    // message offering only "re-deploy" as the remedy sends that user round a
    // loop that can never terminate, so both causes are named.
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ physicalId: SG_INGRESS_COMPOSITE, attributes: {} })
      )
    ).toThrow(/MORE THAN ONE source.*Re-deploying does not help.*one .* resource per source/s);
  });

  it.each([
    ['the parent group id', 'sg-0abc0def0'],
    ['cdkd’s own composite', 'sg-0abc|tcp|22|22'],
    ['an sgr- id with composite segments appended', 'sgr-0123456789abcdef0|tcp|22|22'],
    ['a blank value', '   '],
    ['an uppercase / non-hex body', 'sgr-NOTHEXAT4LL'],
  ])('refuses %s under attributes.Id rather than shipping it as the identifier', (_why, value) => {
    // Anchoring is what discriminates: a bare `startsWith('sgr-')` accepts the
    // third row, which is the composite wearing the identifier's prefix.
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ physicalId: SG_INGRESS_COMPOSITE, attributes: { Id: value } })
      )
    ).toThrow(/attributes\.Id is (missing or empty|recorded as)/);
  });

  it('refuses BOTH sources at once — a bad attribute does not fall through to a bad physicalId', () => {
    // The #1771 finding applied here: validating one side is not a
    // discriminator. Both sources share one predicate, so a row whose
    // attribute AND physicalId are both unusable is refused, not resolved.
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::EC2::SecurityGroupIngress',
        ctx({ physicalId: 'sg-0abc|tcp|22|22', attributes: { Id: 'sg-0abc' } })
      )
    ).toThrow(/which is not an 'sgr-…' security-group rule id/);
  });

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'reports %s as unregistered rather than resolving an inherited member',
    (resourceType) => {
      // A bare index into the identifier map answers for Object.prototype
      // members, so `constructor` would make `entry` the Object constructor —
      // truthy, and `entry.field` / `entry.resolve` then fail somewhere far
      // from the actual cause instead of at this not-registered check.
      expect(() =>
        resolveCompositePhysicalIdIdentifier(resourceType, ctx({ physicalId: 'whatever' }))
      ).toThrow(/no composite-physicalId identifier registered/);
      expect(hasCompositePhysicalIdIdentifier(resourceType)).toBe(false);
    }
  );

  it('throws for a type with no registered entry', () => {
    expect(() =>
      resolveCompositePhysicalIdIdentifier('AWS::S3::Bucket', ctx({ physicalId: 'my-bucket' }))
    ).toThrow(/no composite-physicalId identifier registered for AWS::S3::Bucket/);
  });

  it('hasCompositePhysicalIdIdentifier covers exactly the five measured types', () => {
    // Size-asserted, not just membership: a sixth entry added later without a
    // measurement row in the table's doc comment would otherwise pass here.
    expect(COMPOSITE_PHYSICAL_ID_IDENTIFIER_TYPES).toHaveLength(5);
    expect([...COMPOSITE_PHYSICAL_ID_IDENTIFIER_TYPES].sort()).toEqual([
      'AWS::AppSync::DataSource',
      'AWS::AppSync::GraphQLApi',
      'AWS::AppSync::Resolver',
      'AWS::EC2::SecurityGroupIngress',
      'AWS::S3Tables::Table',
    ]);
    for (const t of [
      'AWS::AppSync::DataSource',
      'AWS::AppSync::GraphQLApi',
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

  it('refuses a recorded attribute holding cdkd COMPOSITE id (the arm that actually fires)', () => {
    // The composite starts with `arn:` AND carries `:s3tables:` (it is built
    // FROM the bucket ARN), so only the `|` test tells the two apart. An older
    // binary or a hand-edited row can put it under the attribute name, and
    // shipping it would adopt the wrong resource — the defect this whole table
    // exists to prevent, on the path that runs for essentially every export.
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({ physicalId: TABLE_COMPOSITE, attributes: { TableARN: TABLE_COMPOSITE } })
      )
    ).toThrow(/not a s3tables ARN/);
  });

  it('refuses a recorded attribute holding ANOTHER service ARN', () => {
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({ physicalId: TABLE_COMPOSITE, attributes: { TableARN: 'arn:aws:s3:::my-bucket' } })
      )
    ).toThrow(/recorded as 'arn:aws:s3:::my-bucket', which is not a s3tables ARN/);
  });

  it('refuses a non-ARN value that merely contains the service segment', () => {
    // Fences the `arn:` prefix test on its own: every other non-ARN fixture
    // ALSO fails the service-segment test, so the two coincide and neither is
    // fenced (the coinciding-disjunct trap, twice over in this file already).
    const notAnArn = `s3tables:${TABLE_ARN.slice('arn:aws:s3tables:'.length)}`;
    expect(notAnArn.includes(':s3tables:')).toBe(false);
    for (const value of ['x:s3tables:y', notAnArn]) {
      expect(() =>
        resolveCompositePhysicalIdIdentifier(
          'AWS::S3Tables::Table',
          ctx({ physicalId: value, attributes: {} })
        )
      ).toThrow(/is missing or empty/);
      expect(() =>
        resolveCompositePhysicalIdIdentifier(
          'AWS::S3Tables::Table',
          ctx({ physicalId: TABLE_COMPOSITE, attributes: { TableARN: value } })
        )
      ).toThrow(/not a s3tables ARN/);
    }
  });

  it('trims a padded bare-ARN physicalId too (arm 2 symmetry with arm 1)', () => {
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::S3Tables::Table',
        ctx({ physicalId: `  ${TABLE_ARN}\n`, attributes: {} })
      ).value
    ).toBe(TABLE_ARN);
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
  // Issue #3414 — both AppSync shapes measured us-east-1 2026-09-18. The API's
  // identifier moved from `ApiId` to `Arn` (issue #3327); the key moved from
  // the single `ApiKeyId` to the composite `[ApiId, ApiKeyId]` AND gained the
  // handler set that takes it past the IMPORT pre-flight for the first time.
  'AWS::AppSync::GraphQLApi': {
    primaryIdentifier: ['/properties/Arn'],
    handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
    provisioningType: 'FULLY_MUTABLE',
  },
  'AWS::AppSync::ApiKey': {
    primaryIdentifier: ['/properties/ApiId', '/properties/ApiKeyId'],
    handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
    provisioningType: 'FULLY_MUTABLE',
  },
};

const GRAPHQL_API_ID = 'abcdefghijklmnopqrstuvwxyz';
const GRAPHQL_API_ARN = `arn:aws:appsync:us-east-1:123456789012:apis/${GRAPHQL_API_ID}`;
const API_KEY_ID = 'da2-abcdefghijklmnopqrstuvwxyz';

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

  it('plans an AWS::EC2::SecurityGroupIngress from its recorded Id, with an EMPTY overlay', async () => {
    // The end-to-end shape issue #1761 unblocks. The overlay must be empty:
    // `Id` is the type's only identifier field AND is `readOnlyProperties`
    // (live DescribeType, us-east-1 2026-08-14), and CFn rejects a read-only
    // property write at changeset-create.
    const state = stateWith({
      SshIn: {
        resourceType: 'AWS::EC2::SecurityGroupIngress',
        physicalId: SG_INGRESS_COMPOSITE,
        attributes: { Id: SG_RULE_ID },
      },
    });
    const template = {
      Resources: { SshIn: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: {} } },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports).toHaveLength(1);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
    expect(plan.phase1Imports[0]!.propertiesOverlay).toEqual({});
    // The pre-#1659 defect one more time, at the plan level: the composite must
    // not reach CloudFormation as the identifier.
    expect(plan.phase1Imports[0]!.resourceIdentifier['Id']).not.toBe(SG_INGRESS_COMPOSITE);
  });

  it('surfaces an UNRECORDED AWS::EC2::SecurityGroupIngress as a blocked row, not a crash', async () => {
    // The type IS importable as far as CFn is concerned (read handler present,
    // FULLY_MUTABLE), so it reaches the identifier resolution. A rule deployed
    // before issue #1761 carries no `Id`, and is refused THERE — the run must
    // continue and report it alongside other rows.
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

  it('resolves an AWS::AppSync::DataSource through the plan builder too', async () => {
    // The second (a)-class family, exercised end-to-end rather than only at
    // the helper: same single-field identifier, different service segment.
    const arn = 'arn:aws:appsync:us-east-1:123456789012:apis/abc123/datasources/MyDs';
    const state = stateWith({
      Ds: {
        resourceType: 'AWS::AppSync::DataSource',
        physicalId: 'abc123|MyDs',
        attributes: { DataSourceArn: arn, Name: 'MyDs' },
      },
    });
    const template = {
      Resources: { Ds: { Type: 'AWS::AppSync::DataSource', Properties: { Name: 'MyDs' } } },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ DataSourceArn: arn });
    expect(plan.phase1Imports[0]!.propertiesOverlay).toEqual({});
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

  it('treats a `handlers: null` schema as no read handler', async () => {
    // Fences the null-guard in `fetchPrimaryIdentifier`'s handler probe on its
    // own: `hasOwnProperty` on `null` THROWS, so without the guard this is a
    // crash rather than a verdict.
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
          handlers: null as unknown as Record<string, unknown>,
          provisioningType: 'NON_PROVISIONABLE',
        },
      }),
      'MyStack'
    );
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/no 'read' handler/);
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

  it('--skip-import-support-preflight lets the type through to CloudFormation', async () => {
    // The verdict is a registry HEURISTIC, not AWS's supported-for-import
    // list, and `blocked` aborts the whole export — so a type AWS has since
    // made importable must have an escape hatch, like its neighbour
    // IMPORT_UNSUPPORTED_RECREATABLE_TYPES has --no-recreate-import-unsupported.
    const state = stateWith({
      GlueTable: { resourceType: 'AWS::Glue::Table', physicalId: 'mydb|my_table' },
    });
    const template = { Resources: { GlueTable: { Type: 'AWS::Glue::Table', Properties: {} } } };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack', {
      recreateImportUnsupported: true,
      skipImportSupportPreflight: true,
    });
    expect(plan.blocked).toEqual([]);
    // Resolution continues as it did before the pre-flight existed.
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: 'mydb|my_table' });
  });

  it('still blocks with the flag OFF (the same fixture, opposite arm)', async () => {
    const state = stateWith({
      GlueTable: { resourceType: 'AWS::Glue::Table', physicalId: 'mydb|my_table' },
    });
    const template = { Resources: { GlueTable: { Type: 'AWS::Glue::Table', Properties: {} } } };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack', {
      recreateImportUnsupported: true,
      skipImportSupportPreflight: false,
    });
    expect(plan.blocked).toHaveLength(1);
    expect(plan.phase1Imports).toEqual([]);
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

/**
 * Issue [#2932](https://github.com/go-to-k/cdkd/issues/2932): the `properties`
 * mask blocker (issue #2274) did not look at `attributes`, and since issue
 * #2847 `CloudControlProvider.import` routinely writes the redaction mask
 * THERE — for every model key it cannot certify read-only, the whole model
 * when `cloudformation:DescribeType` was unavailable. The export reads
 * `attributes` at exactly ONE position (the identifier attribute of a
 * `COMPOSITE_PHYSICAL_ID_IDENTIFIERS` type), so the guarantee is stated at the
 * value the template would receive, not over the whole bag: widening the
 * blocker to any masked attribute would make every Cloud-Control-imported
 * record permanently unexportable — the population control below pins that
 * this did NOT happen.
 */
describe('buildImportPlan — a redaction mask never reaches the import identifier (issue #2932)', () => {
  const SECRET_MASK = '***';

  it('BLOCKS a record whose identifier ATTRIBUTE holds the mask, naming the bag and the field', async () => {
    // Clean `properties`, so the #2274 blocker is NOT what fires; the
    // physicalId is the composite, so the resolver cannot fall back to it.
    const state = stateWith({
      Table: {
        resourceType: 'AWS::S3Tables::Table',
        physicalId: TABLE_COMPOSITE,
        properties: { Namespace: 'analytics', TableName: 'events' },
        attributes: { TableARN: SECRET_MASK },
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
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.logicalId).toBe('Table');
    const reason = plan.blocked[0]!.reason;
    expect(reason).toMatch(/redaction mask/);
    expect(reason).toMatch(/attributes\.TableARN/);
    // The remedy is the MASK's, not the shape refusal's: a re-deploy re-masks
    // the attribute, so "re-deploy the stack once so cdkd records TableARN"
    // (the state-only wording this replaces) would send the user in a circle.
    expect(reason).toMatch(/cloudformation:DescribeType/);
    expect(reason).toMatch(/Re-deploying does NOT clear it/);
    expect(reason).not.toMatch(/Re-deploy the stack once/);
  });

  it('names the logical id through the paste GATE, never the display renderer', async () => {
    // The P1 this lane shipped and review probed. The remedy line is a
    // `cdkd import` an operator PASTES, and the first cut rendered the logical
    // id through `displayIdent` inside it, with a comment asserting the holes
    // on either side kept the line inert. Both halves were wrong: `displayIdent`
    // JSON-quotes, and JSON quotes do not stop COMMAND SUBSTITUTION -- measured,
    // the pasted line created the file. That is go-to-k/cdkd#3486's round-3
    // finding, reintroduced three PRs later.
    //
    // This id renders EXACTLY (printable ASCII, no leading `-`, no `*` or `/`),
    // so the gate NAMES it -- shell-quoted. The distinction under test is the
    // QUOTE KIND, not withholding: `'...'` makes `$( )` literal in argv,
    // `"..."` does not.
    const hostile = 'Tbl$(touch OWNED)';
    const state = stateWith({
      [hostile]: {
        resourceType: 'AWS::S3Tables::Table',
        physicalId: TABLE_COMPOSITE,
        properties: { Namespace: 'analytics', TableName: 'events' },
        attributes: { TableARN: SECRET_MASK },
      },
    });
    const template = {
      Resources: { [hostile]: { Type: 'AWS::S3Tables::Table', Properties: {} } },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toHaveLength(1);
    const reason = plan.blocked[0]!.reason;
    // Positive control: the arm under test is the one that fired.
    expect(reason).toMatch(/redaction mask/);
    // SHELL-quoted by the gate...
    expect(reason).toContain(`--resource 'Tbl$(touch OWNED)'=`);
    // ...and NOT JSON-quoted, which is what `displayIdent` would have emitted
    // and what ran when pasted.
    expect(reason).not.toContain('--resource "Tbl$(touch OWNED)"');
    // The positional is a HOLE, not the logical id: `cdkd import` declares it
    // as `[stack]`, and an earlier cut passed the RESOURCE there -- a command
    // naming a resource where a stack goes, from a function with no stack name
    // in scope. A shape fence cannot see that; only reading the command can.
    expect(reason).toContain(`Repair with: cdkd import '<stack>' --resource`);
  });

  it('CONTROL: the same record with a real recorded ARN exports', async () => {
    const state = stateWith({
      Table: {
        resourceType: 'AWS::S3Tables::Table',
        physicalId: TABLE_COMPOSITE,
        properties: { Namespace: 'analytics', TableName: 'events' },
        attributes: { TableARN: TABLE_ARN },
      },
    });
    const template = { Resources: { Table: { Type: 'AWS::S3Tables::Table', Properties: {} } } };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ TableARN: TABLE_ARN });
  });

  it('POPULATION CONTROL: masked attributes the export never reads do NOT block (the CC-imported shape)', async () => {
    // A single-key type takes its identifier from the physicalId; its
    // `attributes` can be masked wholesale by a Cloud Control import and it
    // exports today. This is the row that distinguishes the position-scoped
    // guarantee from a whole-bag `carriesSecretMask(attributes)` blocker,
    // which would refuse this record forever (a re-import with the grant
    // still masks every writable key).
    const state = stateWith({
      Bucket: {
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'my-bucket',
        properties: { BucketName: 'my-bucket' },
        attributes: { Arn: SECRET_MASK, DomainName: SECRET_MASK, WebsiteURL: SECRET_MASK },
      },
    });
    const template = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'my-bucket' } } },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports).toHaveLength(1);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ BucketName: 'my-bucket' });
  });

  it('does NOT block a masked identifier attribute when the physicalId is itself the identifier', async () => {
    // The CC-routed `AWS::S3Tables::Table` shape: `S3TablesProvider.importTable`
    // records the bare ARN as the physicalId, and a later Cloud Control import
    // can mask the attribute beside it. The resolver prefers the attribute,
    // finds it unusable, and falls back to the physicalId — nothing masked is
    // shipped, so nothing is blocked. A blocker keyed on the attribute alone
    // would refuse a record the export handles correctly.
    const state = stateWith({
      Table: {
        resourceType: 'AWS::S3Tables::Table',
        physicalId: TABLE_ARN,
        attributes: { TableARN: SECRET_MASK },
      },
    });
    const template = { Resources: { Table: { Type: 'AWS::S3Tables::Table', Properties: {} } } };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ TableARN: TABLE_ARN });
  });

  it('BLOCKS at the choke point when the resolved identifier VALUE is the mask, whatever produced it', async () => {
    // The structural half: the check sits where the identifier map is built,
    // so a resolver that does not shape-validate — the "third resolver" the
    // issue names — or a masked physicalId on the single-key path cannot put
    // `***` into `ResourcesToImport`. Driven through the physicalId arm, the
    // one route a test can reach without registering a resolver.
    const state = stateWith({
      Bucket: {
        resourceType: 'AWS::S3::Bucket',
        physicalId: SECRET_MASK,
        properties: { BucketName: 'my-bucket' },
      },
    });
    const template = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'my-bucket' } } },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(
      /import identifier cdkd resolved for this resource is the redaction mask/
    );
    expect(plan.blocked[0]!.reason).toMatch(/masked physical id/);
  });

  // NO case here for `buildImportPlan`'s own redaction-mask refusal, and its
  // absence is a decision. That site still prints its `cdkd import` remedy
  // inside a prose `'...'` span with the logical id interpolated -- the twin of
  // the one `maskedIdentifierAttributeReason` fixes, and the same defect. It is
  // NOT gated in this PR because the maintainer asked it to stop widening:
  // `export.ts` is one of the go-to-k/cdkd#3436 own-copy gates that belong in
  // follow-up PRs. The source fence carries an EXEMPTION naming the site, so
  // the decision is on the record and goes stale the moment the gate lands.
});

// -----------------------------------------------------------------------------
// Issue #3414 — the two AppSync types AWS re-declared in September 2026.
// -----------------------------------------------------------------------------

describe('resolveCompositePhysicalIdIdentifier — AWS::AppSync::GraphQLApi (issue #3414)', () => {
  it('resolves the API from the recorded Arn attribute, not the bare apiId physicalId', () => {
    const resolved = resolveCompositePhysicalIdIdentifier(
      'AWS::AppSync::GraphQLApi',
      ctx({ physicalId: GRAPHQL_API_ID, attributes: { Arn: GRAPHQL_API_ARN } })
    );
    expect(resolved).toEqual({ field: 'Arn', value: GRAPHQL_API_ARN });
    // The defect: the single-key path would have shipped the apiId as `Arn`.
    expect(resolved.value).not.toBe(GRAPHQL_API_ID);
  });

  it('accepts a physicalId that is already the API ARN (a record adopted from CloudFormation)', () => {
    expect(
      resolveCompositePhysicalIdIdentifier(
        'AWS::AppSync::GraphQLApi',
        ctx({ physicalId: GRAPHQL_API_ARN, attributes: {} })
      ).value
    ).toBe(GRAPHQL_API_ARN);
  });

  it('refuses a bare apiId with no recorded Arn, naming the remedy', () => {
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::AppSync::GraphQLApi',
        ctx({ logicalId: 'Api', physicalId: GRAPHQL_API_ID, attributes: {} })
      )
    ).toThrow(/'Api'.*attributes\.Arn is missing or empty.*Re-deploy the stack/s);
  });

  it('refuses an ARN for another service recorded under Arn', () => {
    expect(() =>
      resolveCompositePhysicalIdIdentifier(
        'AWS::AppSync::GraphQLApi',
        ctx({
          physicalId: GRAPHQL_API_ID,
          attributes: { Arn: 'arn:aws:lambda:us-east-1:123456789012:function:not-an-api' },
        })
      )
    ).toThrow(/attributes\.Arn is recorded as '.*', which is not a appsync ARN/);
  });
});

describe('buildImportPlan — AWS::AppSync::GraphQLApi / ::ApiKey (issue #3414)', () => {
  it('sends the recorded Arn for the API and overlays NOTHING (Arn is readOnly)', async () => {
    const state = stateWith({
      Api: {
        resourceType: 'AWS::AppSync::GraphQLApi',
        physicalId: GRAPHQL_API_ID,
        attributes: { ApiId: GRAPHQL_API_ID, Arn: GRAPHQL_API_ARN },
      },
    });
    const template = {
      Resources: {
        Api: {
          Type: 'AWS::AppSync::GraphQLApi',
          Properties: { Name: 'my-api', AuthenticationType: 'API_KEY' },
        },
      },
    };
    // Under the bypass flag: the measured refusal below blocks the API by
    // default, and the identifier resolution is what this case pins.
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack', {
      recreateImportUnsupported: true,
      skipImportSupportPreflight: true,
    });
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports).toHaveLength(1);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Arn: GRAPHQL_API_ARN });
    expect(plan.phase1Imports[0]!.propertiesOverlay).toEqual({});
  });

  it('blocks the API up front from the MEASURED refusal list although its registry passes the read-handler pre-flight', async () => {
    // us-east-1, 2026-09-18, the `export` integ fixture: registry FULLY_MUTABLE
    // with a full handler set, and CreateChangeSet --change-set-type IMPORT
    // still answered `ResourceTypes [AWS::AppSync::GraphQLApi] are not
    // supported for Import` — after the lock. The heuristic is necessary, not
    // sufficient, so the type is blocked before any of that happens.
    expect(cfnRefusesImportDespiteRegistry('AWS::AppSync::GraphQLApi')).toMatch(/2026-09-18/);
    // The key is NOT on the list: a standalone IMPORT changeset carrying one
    // reached CREATE_COMPLETE the same day.
    expect(cfnRefusesImportDespiteRegistry('AWS::AppSync::ApiKey')).toBeUndefined();
    const state = stateWith({
      Api: {
        resourceType: 'AWS::AppSync::GraphQLApi',
        physicalId: GRAPHQL_API_ID,
        attributes: { Arn: GRAPHQL_API_ARN },
      },
    });
    const template = {
      Resources: { Api: { Type: 'AWS::AppSync::GraphQLApi', Properties: { Name: 'my-api' } } },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/measured in us-east-1 on 2026-09-18/);
    expect(plan.blocked[0]!.reason).toMatch(/--skip-import-support-preflight/);
    // The registry stub DOES declare a read handler, so the older heuristic
    // did not fire — the case that made the list necessary.
    expect(plan.blocked[0]!.reason).not.toMatch(/declares no 'read' handler/);
  });

  it('takes the plain single-key path when the registry still reports the OLD `ApiId` identifier', async () => {
    // The tolerance the entry declares via `physicalIdIsIdentifierFor`: the two
    // AWS-published sources disagreed while the identifier moved (issue #3327),
    // and a schema answering `ApiId` is not a change to refuse — cdkd's
    // physicalId IS that value. Note the state carries NO Arn attribute, so a
    // resolve through the entry would have blocked; the path must be the
    // single-key one.
    const state = stateWith({
      Api: { resourceType: 'AWS::AppSync::GraphQLApi', physicalId: GRAPHQL_API_ID },
    });
    const template = {
      Resources: { Api: { Type: 'AWS::AppSync::GraphQLApi', Properties: { Name: 'my-api' } } },
    };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        ...SCHEMAS,
        'AWS::AppSync::GraphQLApi': {
          primaryIdentifier: ['/properties/ApiId'],
          handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
          provisioningType: 'FULLY_MUTABLE',
        },
      }),
      'MyStack',
      { recreateImportUnsupported: true, skipImportSupportPreflight: true }
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ ApiId: GRAPHQL_API_ID });
  });

  it('does NOT bypass the drift guard for an ARN-shaped physicalId under the old `ApiId` registry', async () => {
    // A `--migrate-from-cloudformation` record stores CloudFormation's
    // PhysicalResourceId — the API ARN. Shipping that as `ApiId` would be a
    // wrong identifier, so the tolerance is scoped to a non-ARN physicalId and
    // this record keeps the loud cross-check refusal (review of #3414).
    const state = stateWith({
      Api: { resourceType: 'AWS::AppSync::GraphQLApi', physicalId: GRAPHQL_API_ARN },
    });
    const template = {
      Resources: { Api: { Type: 'AWS::AppSync::GraphQLApi', Properties: {} } },
    };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        ...SCHEMAS,
        'AWS::AppSync::GraphQLApi': {
          primaryIdentifier: ['/properties/ApiId'],
          handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
          provisioningType: 'FULLY_MUTABLE',
        },
      }),
      'MyStack',
      { recreateImportUnsupported: true, skipImportSupportPreflight: true }
    );
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/registry schema changed under cdkd/);
  });

  it('still refuses by name when the registry reports a field the entry does NOT tolerate', async () => {
    // `physicalIdIsIdentifierFor` is a LIST, not a blanket "any single field":
    // a third spelling is a genuine schema change and keeps the drift guard.
    const state = stateWith({
      Api: {
        resourceType: 'AWS::AppSync::GraphQLApi',
        physicalId: GRAPHQL_API_ID,
        attributes: { Arn: GRAPHQL_API_ARN },
      },
    });
    const template = {
      Resources: { Api: { Type: 'AWS::AppSync::GraphQLApi', Properties: {} } },
    };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        ...SCHEMAS,
        'AWS::AppSync::GraphQLApi': {
          primaryIdentifier: ['/properties/Name'],
          handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
          provisioningType: 'FULLY_MUTABLE',
        },
      }),
      'MyStack',
      { recreateImportUnsupported: true, skipImportSupportPreflight: true }
    );
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/registry schema changed under cdkd/);
  });

  it('resolves the key through its COMPOSITE_ID_SPLITTERS entry once the pre-flight admits it', async () => {
    // The pre-#3414 shape: the type was NON_PROVISIONABLE with no handlers, so
    // the pre-flight blocked it BEFORE the identifier was resolved and the
    // missing splitter never fired. With the live handler set it reaches the
    // composite path — and the throw this test would have hit is the one the
    // issue reports.
    const state = stateWith({
      Key: {
        resourceType: 'AWS::AppSync::ApiKey',
        physicalId: `${GRAPHQL_API_ID}|${API_KEY_ID}`,
        properties: { ApiId: GRAPHQL_API_ID, Description: 'dev' },
        attributes: { ApiKey: API_KEY_ID },
      },
    });
    const template = {
      Resources: {
        Key: {
          Type: 'AWS::AppSync::ApiKey',
          Properties: { ApiId: { 'Fn::GetAtt': ['Api', 'ApiId'] }, Description: 'dev' },
        },
      },
    };
    const plan = await buildImportPlan(state, template, cfnClientFor(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports).toHaveLength(1);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({
      ApiId: GRAPHQL_API_ID,
      ApiKeyId: API_KEY_ID,
    });
    // `ApiKeyId` is readOnlyProperties — never written into Properties.
    expect(plan.phase1Imports[0]!.propertiesOverlay).toEqual({ ApiId: GRAPHQL_API_ID });
  });

  it('still blocks the key on the pre-#3414 registry shape (no handlers, NON_PROVISIONABLE)', async () => {
    // The pre-flight keeps reading the LIVE response, so a region whose
    // registry has not moved yet gets the old refusal, not the splitter.
    const state = stateWith({
      Key: {
        resourceType: 'AWS::AppSync::ApiKey',
        physicalId: `${GRAPHQL_API_ID}|${API_KEY_ID}`,
        properties: { ApiId: GRAPHQL_API_ID },
      },
    });
    const template = { Resources: { Key: { Type: 'AWS::AppSync::ApiKey', Properties: {} } } };
    const plan = await buildImportPlan(
      state,
      template,
      cfnClientFor({
        ...SCHEMAS,
        'AWS::AppSync::ApiKey': {
          primaryIdentifier: ['/properties/ApiKeyId'],
          provisioningType: 'NON_PROVISIONABLE',
        },
      }),
      'MyStack'
    );
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/not supported for Import/);
  });
});
