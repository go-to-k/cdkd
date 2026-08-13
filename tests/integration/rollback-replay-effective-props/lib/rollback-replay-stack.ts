import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Fixture for issue #1682 — the reverse-replacement replay-CREATE must record
 * the provider's `effectiveProperties`.
 *
 * Why `AWS::EC2::Route` and not the `AWS::S3::Bucket` the issue names: both
 * providers substitute on a state replay, but a bucket's reverse-replacement
 * re-create has to re-acquire a just-deleted GLOBALLY unique name, whose
 * release is not immediate — the fixture would be flaky for a reason that has
 * nothing to do with what it tests. A route's identity is
 * `<RouteTableId>|<Destination>`, scoped to this stack's own route table, so
 * the re-create is deterministic.
 *
 * Two env knobs drive the phases (see verify.sh):
 *
 * - `ROUTE_DEST` flips the route's destination CIDR. It is create-only, so the
 *   second deploy classifies the route as a REPLACEMENT — which is the op
 *   class whose rollback arm this fixture exercises.
 * - `ROLLBACK_INTEG_FAIL=true` adds an SQS queue with an out-of-range
 *   `MessageRetentionPeriod` that AWS rejects. It DependsOn the route, so the
 *   route's replacement has already COMPLETED when the failure fires and the
 *   rollback classifies it `reverse-replacement` rather than a plain CREATE.
 */
export class RollbackReplayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // A deterministic, NON-reserved tag on every resource. AWS reserves the
    // `aws:` prefix, so `aws:cdk:path` is never set on a real resource and a
    // cleanup filtered on it would return empty — vacuously passing the very
    // leak assertions it exists to make.
    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-replay-effective-props');

    // L1 throughout: the test asserts on the route's recorded property BAG, so
    // the template has to say exactly what this file says and nothing an L2
    // might add on its behalf.
    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.90.0.0/16',
      enableDnsSupport: true,
      enableDnsHostnames: false,
    });

    const igw = new ec2.CfnInternetGateway(this, 'Igw', {});

    const attachment = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: vpc.ref,
      internetGatewayId: igw.ref,
    });

    const routeTable = new ec2.CfnRouteTable(this, 'RouteTable', {
      vpcId: vpc.ref,
    });

    // DestinationCidrBlock is create-only -> changing it forces a replacement.
    const destination = process.env['ROUTE_DEST'] ?? '0.0.0.0/0';

    const route = new ec2.CfnRoute(this, 'Route', {
      routeTableId: routeTable.ref,
      destinationCidrBlock: destination,
      gatewayId: igw.ref,
    });
    // A route to an internet gateway is only creatable once the gateway is
    // attached to the VPC.
    route.addDependency(attachment);

    // ── The per-PROVIDER replay-CREATE subjects: two GlobalTables ─────────
    //
    // Issues #1724 / #1726. The route above proves the ENGINE honours a
    // returned `effectiveProperties` on the reverse-replacement create; these
    // two tables prove the GlobalTable ARMS answer with the right bag, which is
    // per-provider coverage the route cannot give (issue #1706). Both arms fire
    // only under `CreateContext.replayingState`, i.e. only on this rollback
    // path — which is why they had no live coverage and why the
    // `dynamodb-globaltable` fixture (UPDATE-only) cannot reach them.
    //
    // TWO tables because the two arms need INCOMPATIBLE state: #1726 needs a
    // real GSI carrying real per-index capacity, and #1724 needs the GSI blob
    // replaced by a malformed string. One table cannot be both.
    //
    // `TableName` is create-only, so flipping it classifies each table as a
    // REPLACEMENT — the same op class as the route, and the reason the failure
    // below DependsOn both: the replacements must COMPLETE before the deploy
    // fails, or rollback classifies plain CREATEs instead.
    //
    // ONE replica each, in the deploy region. A cross-region replica would make
    // the rollback's delete-of-the-new-table a replica removal, which arms
    // DynamoDB's 24h source-region delete lock — a fixture hazard with nothing
    // to do with what this tests.
    //
    // Every replica declares the sub-specs `readCurrentState` ALWAYS emits
    // (`Tags`, ContributorInsights, PITR). That is load-bearing, not
    // decoration: `rollback-executor.ts` strips `observedProperties` on the
    // replay, so `cdkd drift` falls back to the template-shaped `properties`
    // baseline and compares `Replicas` as a whole array. A replica declaring
    // only `Region` would drift against the enriched readback on every run —
    // the fixture would fail phase 5 and its message would ACCUSE THE FIX.
    const localReplica = (extra: Record<string, unknown> = {}) => ({
      region: cdk.Aws.REGION,
      tags: [],
      contributorInsightsSpecification: { enabled: false },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      ...extra,
    });

    // #1726: the capacity-strip subject. It carries a REAL GSI so that the
    // per-INDEX members of the strip have somewhere to live; the PROVISIONED-only
    // capacity blocks themselves are INJECTED by verify.sh rather than declared
    // here, and that is a decision rather than a shortcut.
    //
    // CFn's `WriteProvisionedThroughputSettings` accepts ONLY
    // `WriteCapacityAutoScalingSettings` (checked against
    // `CfnGlobalTable.WriteProvisionedThroughputSettingsProperty`), so a
    // genuinely PROVISIONED template would drag Application Auto Scaling
    // registration + deregistration into the reverse-replacement rollback —
    // a large, slow, orthogonal surface that would make this fixture flaky for
    // reasons that have nothing to do with the arms under test. Injection also
    // matches the fixture's existing premise for the route: "a state record
    // written by an older binary", which is exactly the population that carries
    // the two legacy SDK-shaped spellings (`GlobalSecondaryIndexes[]
    // .ProvisionedThroughput`, `Replicas[].ProvisionedThroughputOverride`) the
    // strip must also remove.
    const capacityTable = new dynamodb.CfnGlobalTable(this, 'GlobalTable', {
      tableName: process.env['GT_TABLE_NAME'] || 'cdkd-rollback-replay-gt-v1',
      billingMode: 'PAY_PER_REQUEST',
      //
      // This table DOES carry a global secondary index, and the index is what
      // makes phase 5 a real assertion. An earlier revision deliberately had
      // none, because a GSI exposed two phantom drifts (issue #1742) that would
      // fail that phase while blaming the arms under test: AWS returns
      // `AttributeDefinitions` in an arbitrary order and the comparator
      // compares arrays positionally, and AWS reports a computed
      // `GlobalSecondaryIndexes[].WarmThroughput` the template can never carry.
      // Both are FIXED now, so the coverage bound that comment recorded is
      // lifted and the index is back — which is also what puts the per-INDEX
      // members of the #1726 capacity strip under live coverage rather than
      // leaving them unit-only.
      //
      // Both phantoms are visible here and nowhere else for the same reason:
      // the rollback strips `observedProperties`, so the drift baseline is the
      // template-shaped bag rather than a readback that would already agree
      // with itself. A clean phase 5 over this table IS the regression test for
      // both fixes; do not remove the index to make a future phase quieter.
      attributeDefinitions: [
        { attributeName: 'pk', attributeType: 'S' },
        { attributeName: 'capgsipk', attributeType: 'S' },
      ],
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
      globalSecondaryIndexes: [
        {
          indexName: 'capgsi1',
          keySchema: [{ attributeName: 'capgsipk', keyType: 'HASH' }],
          projection: { projectionType: 'KEYS_ONLY' },
        },
      ],
      replicas: [localReplica()],
    });

    // #1724: a table whose GSI is REAL in v1, so that after the replay's omit
    // "the live table has 0 indexes" is an assertion that can actually fail.
    // PAY_PER_REQUEST here because this arm has nothing to do with billing.
    const gsiOmitTable = new dynamodb.CfnGlobalTable(this, 'GsiOmitTable', {
      tableName: process.env['GT_OMIT_TABLE_NAME'] || 'cdkd-rollback-replay-gto-v1',
      billingMode: 'PAY_PER_REQUEST',
      // The index is keyed on a DEDICATED attribute (`gsipk`) that exists
      // solely for it, and that is the whole point of this arm rather than an
      // incidental choice. When the replay OMITS the malformed index block,
      // `gsipk` becomes an attribute no key schema references, and DynamoDB
      // requires `AttributeDefinitions` to be EXACTLY the referenced set — so
      // before issue #1741 shipped, `CreateTable` rejected the whole call
      // (`Some AttributeDefinitions are not used. AttributeDefinitions:
      // [pk, gsipk], KeySchema: [pk]`), the reverse-replacement re-create
      // failed, and the arm under test never got to record anything. Measured
      // on run 3 of this fixture.
      //
      // An earlier revision keyed the index on the table's own `pk` to dodge
      // exactly that, with a comment calling the choice load-bearing. It was
      // load-bearing for the WRONG reason — it made the fixture pass over a
      // real provider bug — so it is deliberately reverted here now that the
      // omit arm prunes the orphaned definitions. Keying this index back on
      // `pk` would silently retire the only live coverage #1741 has.
      attributeDefinitions: [
        { attributeName: 'pk', attributeType: 'S' },
        { attributeName: 'gsipk', attributeType: 'S' },
      ],
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
      globalSecondaryIndexes: [
        {
          indexName: 'gsi1',
          keySchema: [{ attributeName: 'gsipk', keyType: 'HASH' }],
          projection: { projectionType: 'KEYS_ONLY' },
        },
      ],
      replicas: [localReplica()],
    });

    if (process.env['ROLLBACK_INTEG_FAIL'] === 'true') {
      // MessageRetentionPeriod's ceiling is 1209600 (14 days); this is well
      // past it, so CreateQueue fails and the deploy rolls back.
      const failing = new sqs.CfnQueue(this, 'FailQueue', {
        messageRetentionPeriod: 999999999,
      });
      failing.addDependency(route);
      failing.addDependency(capacityTable);
      failing.addDependency(gsiOmitTable);
    }
  }
}
