import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Fixture for issue #1682 — the reverse-replacement replay-CREATE must record
 * the provider's `effectiveProperties`.
 *
 * The route is the ENGINE subject: its identity is
 * `<RouteTableId>|<Destination>`, scoped to this stack's own route table, so
 * its re-create is deterministic. The tables and the bucket below are the
 * PER-PROVIDER subjects (issues #1724 / #1726 / #1741 / #1706).
 *
 * Two env knobs drive the phases (see verify.sh; the per-resource names and
 * the phase-5b knobs are documented where each resource is declared):
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

    // ── The rollback REVERT-arm subject (go-to-k/cdkd#4434) ───────────────
    //
    // Every subject above takes the reverse-REPLACEMENT arm; this one takes the
    // plain `revert` UPDATE arm. Its `Description` follows `ROUTE_DEST`, and
    // `Description` is not create-only, so phase 3 UPDATES the rule in place —
    // which `EC2Provider` does by revoking and re-authorizing it, minting a new
    // `sgr-` id — and the rollback's revert does the same again. The
    // post-rollback record must hold the id of the rule that is live THEN, not
    // the phase-1 one the revert revoked.
    const ingressSg = new ec2.CfnSecurityGroup(this, 'RevertSg', {
      vpcId: vpc.ref,
      groupDescription: 'cdkd rollback-replay revert-arm subject',
    });
    const ingress = new ec2.CfnSecurityGroupIngress(this, 'RevertIngress', {
      groupId: ingressSg.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      cidrIp: '10.90.0.0/16',
      description: `cdkd revert-arm subject for ${destination}`,
    });

    // ── The per-PROVIDER replay-CREATE subjects ────────────────────────────
    //
    // The route above proves the ENGINE honours a returned
    // `effectiveProperties` on the reverse-replacement create; the resources
    // below prove each provider's ARMS answer with the right bag, which is
    // per-provider coverage the route cannot give (issue #1706). The first two
    // tables carry issues #1724 / #1726; both of those arms fire
    // only under `CreateContext.replayingState`, i.e. only on this rollback
    // path — which is why they had no live coverage and why the
    // `dynamodb-globaltable` fixture (UPDATE-only) cannot reach them.
    //
    // TWO tables for those two arms because they need INCOMPATIBLE state: #1726 needs a
    // real GSI carrying real per-index capacity, and #1724 needs the GSI blob
    // replaced by a malformed string. One table cannot be both.
    //
    // `TableName` is create-only, so flipping it classifies each table as a
    // REPLACEMENT — the same op class as the route, and the reason the failure
    // below DependsOn every one of them: the replacements must COMPLETE before the deploy
    // fails, or rollback classifies plain CREATEs instead.
    //
    // ONE replica each, in the deploy region. A cross-region replica adds
    // minutes to every create and delete of a table, and neither of these two
    // arms has anything to do with replication; the one arm that does is the
    // opt-in `GsiOmitXrTable` below.
    //
    // Every replica declares the sub-specs `readCurrentState` ALWAYS emits
    // (`Tags`, ContributorInsights, PITR). That is load-bearing, not
    // decoration: `rollback-executor.ts` strips `observedProperties` on the
    // replay, so `cdkd drift` falls back to the template-shaped `properties`
    // baseline and compares `Replicas` as a whole array. A replica declaring
    // only `Region` would drift against the enriched readback on every run —
    // the fixture would fail phase 5 and its message would ACCUSE THE FIX.
    const replicaIn = (region: string, extra: Record<string, unknown> = {}) => ({
      region,
      tags: [],
      contributorInsightsSpecification: { enabled: false },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      ...extra,
    });
    const localReplica = (extra: Record<string, unknown> = {}) => replicaIn(cdk.Aws.REGION, extra);

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
      // NO global secondary index here, and that is a recorded COVERAGE BOUND
      // rather than an oversight. It was briefly added back once the
      // `AttributeDefinitions` ORDERING half of issue #1742 shipped, and then
      // removed again: the SECOND half of that issue is still open, so AWS
      // still reports a computed `GlobalSecondaryIndexes[].WarmThroughput` the
      // template can never carry, and phase 5 fails on it while blaming
      // whatever change is in flight.
      //
      // Both phantoms are visible here and nowhere else for the same reason:
      // the rollback strips `observedProperties`, so the drift baseline is the
      // template-shaped bag rather than a readback that would already agree
      // with itself. Restore the index in the PR that closes the WarmThroughput
      // half — at that point phase 5 becomes the regression test for BOTH, and
      // the per-INDEX members of the #1726 capacity strip gain live coverage.
      attributeDefinitions: [{ attributeName: 'pk', attributeType: 'S' }],
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
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

    // #1706 arm 1: the `StreamSpecification` replay-CREATE substitution. A
    // THIRD table rather than a key on the capacity table, because phase 5b
    // diffs this record against the template per resource, and the capacity
    // and omit tables legitimately diff (their records describe what the
    // replay SENT, not what the template declares).
    //
    // KEYS_ONLY in the deployed template, NOT the NEW_AND_OLD_IMAGES the
    // substitution falls back to: phase 4 reads the live view type, and only a
    // baseline that differs from the default can show that the replay sent the
    // SUBSTITUTED value rather than the one v1 was created with.
    // `GT_STREAM_VIEW` exists for phase 5b alone, which renders the template
    // that describes the live table and asserts it diffs clean.
    const streamTable = new dynamodb.CfnGlobalTable(this, 'StreamTable', {
      tableName: process.env['GT_STREAM_TABLE_NAME'] || 'cdkd-rollback-replay-gts-v1',
      billingMode: 'PAY_PER_REQUEST',
      attributeDefinitions: [{ attributeName: 'pk', attributeType: 'S' }],
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
      streamSpecification: { streamViewType: process.env['GT_STREAM_VIEW'] || 'KEYS_ONLY' },
      replicas: [localReplica()],
    });

    // #1706 arm 2: `AWS::S3::Bucket`'s create-path `applyEffectiveOverrides`.
    // `BucketName` is create-only, so flipping it is the replacement trigger,
    // exactly like `TableName` above. Re-acquiring the just-deleted v1 name on
    // the rollback is what kept a bucket out of this fixture originally; the
    // reverse-replacement create now waits out S3's `conflicting conditional
    // operation` through the name-cooldown retry (issue #2116). That retry's
    // budget is bounded, so a name release slower than it would still fail
    // phase 3, whose failure message names this resource.
    //
    // Versioning is the subject because its replay downgrade is a SKIP: the
    // restored bucket comes up unversioned, so the record must DROP the key.
    // `BUCKET_VERSIONING=off` exists for phase 5b alone, like `GT_STREAM_VIEW`.
    const bucket = new s3.CfnBucket(this, 'ReplayBucket', {
      bucketName: process.env['BUCKET_NAME'] || 'cdkd-rollback-replay-b-v1',
      ...(process.env['BUCKET_VERSIONING'] === 'off'
        ? {}
        : { versioningConfiguration: { status: 'Enabled' } }),
    });

    // #1741, second instance: the CROSS-REGION arm. Opt-in behind
    // `CDKD_INTEG_MULTI_REGION=1` (the name the `dynamodb-globaltable` fixture
    // already uses for the same cost): a cross-region replica is created,
    // deleted and re-created several times across the phases, each taking
    // minutes, so the arm takes the run from ~3 to ~12-20 min. The env
    // var is read once per run and never changes between phases, so the table
    // is either in every template of a run or in none — never a mode-gated
    // DELETE halfway through.
    //
    // The shape is the omit table's plus ONE thing: a replica in a SECOND
    // region carrying a per-index override for `gsi1`. When the replay omits
    // the malformed index block, `CreateTable` builds a table with NO indexes,
    // and the replica-add that follows used to send AND record that override
    // anyway — for an index the table does not have. The replica is deliberately NOT
    // removed by any update in this fixture: the only replica deletes are the
    // provider's own whole-table deletes (the replacement's delete of v1, the
    // rollback's delete of v2, and destroy), which drop the replica and then
    // the table together.
    let crossRegionTable: dynamodb.CfnGlobalTable | undefined;
    if (process.env['CDKD_INTEG_MULTI_REGION'] === '1') {
      crossRegionTable = new dynamodb.CfnGlobalTable(this, 'GsiOmitXrTable', {
        tableName: process.env['GT_XR_TABLE_NAME'] || 'cdkd-rollback-replay-gtx-v1',
        billingMode: 'PAY_PER_REQUEST',
        // Keyed on a dedicated attribute for the same reason as the omit table
        // above: the cross-region withdrawal has to COMPOSE with the
        // `AttributeDefinitions` prune on one create.
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
        replicas: [
          localReplica(),
          replicaIn(process.env['GT_XR_REPLICA_REGION'] || 'eu-west-1', {
            // An on-demand read ceiling rather than a bare `indexName`: it is
            // the override a user would actually write, and it turns into a
            // real `OnDemandThroughputOverride` on the replica-add, so phase 1
            // can prove it was live before the replay withdraws it.
            globalSecondaryIndexes: [
              { indexName: 'gsi1', readOnDemandThroughputSettings: { maxReadRequestUnits: 13 } },
            ],
          }),
        ],
      });
    }

    if (process.env['ROLLBACK_INTEG_FAIL'] === 'true') {
      // MessageRetentionPeriod's ceiling is 1209600 (14 days); this is well
      // past it, so CreateQueue fails and the deploy rolls back.
      const failing = new sqs.CfnQueue(this, 'FailQueue', {
        messageRetentionPeriod: 999999999,
      });
      failing.addDependency(route);
      failing.addDependency(capacityTable);
      failing.addDependency(gsiOmitTable);
      failing.addDependency(streamTable);
      failing.addDependency(bucket);
      // The ingress UPDATE must have COMPLETED, or there is nothing to revert.
      failing.addDependency(ingress);
      if (crossRegionTable) failing.addDependency(crossRegionTable);
    }
  }
}
