import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';

export class S3TablesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName: `${this.stackName}-table-bucket`.toLowerCase(),
    });

    // Two tags on the TableBucket — issue #609 Tags backfill (this PR)
    // wires `Tags` for AWS::S3Tables::TableBucket via the SDK provider's
    // `create()` (atomic via CreateTableBucketCommand.tags) + `update()`
    // (tag-diff against the bucket ARN — physicalId IS the ARN, no
    // GetTableBucket lookup needed) + `readCurrentState()` (best-effort
    // ListTagsForResource hop) paths. verify.sh asserts both tags reach
    // AWS via `aws s3tables list-tags-for-resource --resource-arn <bucket-arn>`.
    cdk.Tags.of(tableBucket).add('bucket-env', 'cdkd-integ');
    cdk.Tags.of(tableBucket).add('bucket-team', 'platform');

    // Namespace + Table inside the bucket. Issue #609 Tags backfill (this
    // PR) wires `Tags` for AWS::S3Tables::Table via the SDK provider's
    // `create()` / `update()` / `readCurrentState()` paths, so the fixture
    // exercises that closure end-to-end.
    const namespace = new s3tables.CfnNamespace(this, 'Namespace', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      // CDK CfnNamespace's `namespace` is a string in CDK 2.x even though
      // AWS docs list `Namespace: [name]` (singleton array). CDK wraps the
      // string into the array on synth.
      namespace: 'cdkd_integ_ns',
    });
    namespace.addDependency(tableBucket);

    // CfnTable L1 emits only the props set here (no L2 defaults that
    // might still be silent-drop and flip routing to CC-API per memory
    // rule feedback_l1_over_l2_for_backfill_integ_fixture). The
    // `openTableFormat` prop is the CFn-canonical name (per AWS docs /
    // CDK schema); this PR also closes its silent-drop and adds it to
    // handledProperties as an alias for the legacy `Format` name.
    const table = new s3tables.CfnTable(this, 'Table', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: 'cdkd_integ_ns',
      tableName: 'cdkd_integ_tbl',
      openTableFormat: 'ICEBERG',
    });
    table.addDependency(namespace);

    // Two tags via CDK's `Tags.of(...)` aspect — emits Tags: [{Key, Value}]
    // on the synthesized template, matching the cdkd silent-drop entry
    // shape. The provider's create() forwards these to CreateTableCommand's
    // `tags: Record<string, string>` field in a single atomic call.
    cdk.Tags.of(table).add('env', 'cdkd-integ');
    cdk.Tags.of(table).add('team', 'platform');

    new cdk.CfnOutput(this, 'TableBucketArn', {
      value: tableBucket.attrTableBucketArn,
      description: 'S3 Table Bucket ARN',
    });
    new cdk.CfnOutput(this, 'TableArn', {
      value: table.attrTableArn,
      description: 'S3 Table ARN',
    });
  }
}
