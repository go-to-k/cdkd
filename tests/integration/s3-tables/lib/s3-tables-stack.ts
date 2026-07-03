import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as ssm from 'aws-cdk-lib/aws-ssm';

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

    // --- CC-routed Table + Ref-to-table-name assertion (issue #974) ------
    // A schema-bearing Table (IcebergMetadata set) is NOT in the SDK
    // provider's `handledProperties` for AWS::S3Tables::Table, so cdkd's
    // #614 silent-drop routing sends it entirely through Cloud Control.
    // The CC primaryIdentifier for a Table is the bare single-segment
    // TableARN (describe-type-verified in PR #972), so the CC path stores a
    // pipe-free ARN (ending in a UUID) as the physical id — and CFn's `Ref`
    // for a Table returns the table NAME, not the ARN. Before the #974 fix
    // cdkd's Ref leaked the ARN; the fix recovers the name from the stored
    // TableName property. This Table proves the CC-routed Ref resolves to
    // the table name against real AWS.
    const ICEBERG_TABLE_NAME = 'cdkd_integ_cc_tbl';
    const icebergTable = new s3tables.CfnTable(this, 'IcebergTable', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: 'cdkd_integ_ns',
      tableName: ICEBERG_TABLE_NAME,
      openTableFormat: 'ICEBERG',
      // IcebergMetadata is the everyday schema-bearing-table path and the
      // property that flips routing to Cloud Control (silent-drop on the
      // SDK provider). Its presence is what this fixture is exercising.
      icebergMetadata: {
        icebergSchema: {
          schemaFieldList: [
            { name: 'id', type: 'int', required: true },
            { name: 'name', type: 'string' },
          ],
        },
      },
    });
    icebergTable.addDependency(namespace);

    // A consuming resource whose property value is `{ Ref: IcebergTable }`.
    // If the Ref leaked the bare TableARN (the pre-#974 bug), this SSM
    // parameter's Value on AWS would be the ARN; the fix makes it the table
    // name. verify.sh reads the parameter back via `ssm get-parameter` and
    // asserts the value equals the table name — a real consuming resource,
    // not just a CfnOutput (which cdkd resolves through the same code path
    // but never round-trips through an AWS write).
    const refConsumer = new ssm.CfnParameter(this, 'IcebergTableRefParam', {
      name: `/${this.stackName}/iceberg-table-ref`,
      type: 'String',
      value: icebergTable.ref,
    });
    refConsumer.addDependency(icebergTable);

    new cdk.CfnOutput(this, 'TableBucketArn', {
      value: tableBucket.attrTableBucketArn,
      description: 'S3 Table Bucket ARN',
    });
    new cdk.CfnOutput(this, 'TableArn', {
      value: table.attrTableArn,
      description: 'S3 Table ARN',
    });
    // The CC-routed Table's `Ref` — must resolve to the table NAME (issue
    // #974), not the bare TableARN. verify.sh asserts this output equals
    // ICEBERG_TABLE_NAME.
    new cdk.CfnOutput(this, 'IcebergTableRef', {
      value: icebergTable.ref,
      description: 'Ref of the CC-routed IcebergMetadata table (expect table name)',
    });
    new cdk.CfnOutput(this, 'IcebergTableName', {
      value: ICEBERG_TABLE_NAME,
      description: 'The expected table name the Ref should resolve to',
    });
    new cdk.CfnOutput(this, 'IcebergTableRefParamName', {
      value: refConsumer.name!,
      description: 'The SSM parameter whose value is Ref(IcebergTable)',
    });
  }
}
