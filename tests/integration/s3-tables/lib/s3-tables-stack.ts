import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export class S3TablesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Issue #2613: verify.sh's Phase 1b redeploys with CDKD_S3T_TEAM set, a tag
    // change on the TableBucket and the SDK-routed Table, so the redeploy
    // reaches the S3 Tables provider's update() and its recorded-region guard.
    const teamTag = process.env.CDKD_S3T_TEAM ?? 'platform';
    // Issue #5313: verify.sh's Phase 1c redeploys with both set, renaming the
    // SDK-routed Table and moving it to the second namespace in place.
    const tableName = process.env.CDKD_S3T_TABLE_NAME ?? 'cdkd_integ_tbl';
    const tableNamespace = process.env.CDKD_S3T_TABLE_NS ?? 'cdkd_integ_ns';

    // Issue #2762: Phase 1b (CDKD_S3T_TEAM set) also changes one value of each
    // updatable configuration property, so the redeploy reaches their Put*
    // calls in update(); Phases 1c / 1d keep that value.
    const configUpdated = process.env.CDKD_S3T_TEAM !== undefined;

    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName: `${this.stackName}-table-bucket`.toLowerCase(),
      // Issue #2762: these used to route the bucket to Cloud Control; the SDK
      // provider now sends them (storage class on CreateTableBucket, the
      // others by their own Put* call). Each is a non-default value, so
      // verify.sh's readback of it proves the value reached AWS.
      storageClassConfiguration: { storageClass: 'INTELLIGENT_TIERING' },
      // Phase 1b drops it: a removal deletes the bucket's metrics
      // configuration (its schema default is Disabled).
      ...(configUpdated ? {} : { metricsConfiguration: { status: 'Enabled' } }),
      unreferencedFileRemoval: {
        status: 'Enabled',
        unreferencedDays: configUpdated ? 6 : 5,
        noncurrentDays: 7,
      },
    });

    // Two tags on the TableBucket — issue #609 Tags backfill (this PR)
    // wires `Tags` for AWS::S3Tables::TableBucket via the SDK provider's
    // `create()` (atomic via CreateTableBucketCommand.tags) + `update()`
    // (tag-diff against the bucket ARN — physicalId IS the ARN, no
    // GetTableBucket lookup needed) + `readCurrentState()` (best-effort
    // ListTagsForResource hop) paths. verify.sh asserts both tags reach
    // AWS via `aws s3tables list-tags-for-resource --resource-arn <bucket-arn>`.
    cdk.Tags.of(tableBucket).add('bucket-env', 'cdkd-integ');
    cdk.Tags.of(tableBucket).add('bucket-team', teamTag);

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

    // The namespace Phase 1c (issue #5313) moves the Table into.
    const namespace2 = new s3tables.CfnNamespace(this, 'Namespace2', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: 'cdkd_integ_ns2',
    });
    namespace2.addDependency(tableBucket);

    // CfnTable L1 emits only the props set here (no L2 defaults that
    // might still be silent-drop and flip routing to CC-API per memory
    // rule feedback_l1_over_l2_for_backfill_integ_fixture). The
    // `openTableFormat` prop is the CFn-canonical name (per AWS docs /
    // CDK schema); this PR also closes its silent-drop and adds it to
    // handledProperties as an alias for the legacy `Format` name.
    const table = new s3tables.CfnTable(this, 'Table', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: tableNamespace,
      tableName,
      openTableFormat: 'ICEBERG',
    });
    table.addDependency(namespace);
    table.addDependency(namespace2);

    // A reader of the SDK-routed Table's `Ref`, which is the TableARN as in
    // CloudFormation (issue #5316). Phase 1c renames the table in place
    // (issue #5313) and verify.sh asserts the reader still holds the ARN;
    // Phase 1d seeds the old cdkd value (the table name) into its record and
    // asserts the next deploy rewrites it to the ARN.
    const tableRefReader = new ssm.CfnParameter(this, 'TableRefParam', {
      name: `/${this.stackName}/table-ref`,
      type: 'String',
      value: table.ref,
    });
    tableRefReader.addDependency(table);

    // Two tags via CDK's `Tags.of(...)` aspect — emits Tags: [{Key, Value}]
    // on the synthesized template, matching the cdkd silent-drop entry
    // shape. The provider's create() forwards these to CreateTableCommand's
    // `tags: Record<string, string>` field in a single atomic call.
    cdk.Tags.of(table).add('env', 'cdkd-integ');
    cdk.Tags.of(table).add('team', teamTag);

    // --- Schema-bearing Table + Ref-to-TableARN assertion (#974 / #5316 / #2762)
    // A schema-bearing Table (IcebergMetadata set). Until issue #2762 its
    // IcebergMetadata / Compaction / SnapshotManagement / StorageClass were
    // silent drops that routed it to Cloud Control; the SDK provider now sends
    // them, so it is SDK-routed like the plain Table and verify.sh reads each
    // value back from AWS. CloudFormation's `Ref` for a Table returns its
    // TableARN (measured with a CloudFormation stack, issue #5316); issue
    // #974 had made cdkd return the table name instead.
    const ICEBERG_TABLE_NAME = 'cdkd_integ_cc_tbl';
    const icebergTable = new s3tables.CfnTable(this, 'IcebergTable', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: 'cdkd_integ_ns',
      tableName: ICEBERG_TABLE_NAME,
      openTableFormat: 'ICEBERG',
      // IcebergMetadata is the everyday schema-bearing-table path: sent on
      // CreateTable, it makes S3 Tables write the table's first metadata file.
      icebergMetadata: {
        icebergSchema: {
          schemaFieldList: [
            { name: 'id', type: 'int', required: true },
            { name: 'name', type: 'string' },
          ],
        },
      },
      // Issue #2762: non-default values (compaction is enabled on a new table;
      // snapshot management keeps 1 snapshot for 120 hours), each read back by
      // verify.sh. Phase 1b turns compaction on with a target file size.
      storageClassConfiguration: { storageClass: 'INTELLIGENT_TIERING' },
      compaction: configUpdated
        ? { status: 'enabled', targetFileSizeMb: 256 }
        : { status: 'disabled' },
      snapshotManagement: { status: 'enabled', minSnapshotsToKeep: 2, maxSnapshotAgeHours: 200 },
    });
    icebergTable.addDependency(namespace);

    // A consuming resource whose property value is `{ Ref: IcebergTable }`.
    // verify.sh reads the parameter back via `ssm get-parameter` and asserts
    // the value equals the TableARN (`Fn::GetAtt TableARN`) — a real consuming
    // resource, not just a CfnOutput (which cdkd resolves through the same
    // code path but never round-trips through an AWS write).
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
    new cdk.CfnOutput(this, 'TableRef', {
      value: table.ref,
      description: 'Ref of the SDK-routed table (expect the TableArn output)',
    });
    new cdk.CfnOutput(this, 'TableArn', {
      value: table.attrTableArn,
      description: 'S3 Table ARN',
    });
    // The IcebergMetadata Table's `Ref` — must resolve to its TableARN (issue
    // #5316), the `IcebergTableArn` output below, and not to the table name.
    new cdk.CfnOutput(this, 'IcebergTableRef', {
      value: icebergTable.ref,
      description: 'Ref of the IcebergMetadata table (expect the TableARN)',
    });
    new cdk.CfnOutput(this, 'IcebergTableArn', {
      value: icebergTable.attrTableArn,
      description: 'The TableARN the Ref should resolve to',
    });
    new cdk.CfnOutput(this, 'IcebergTableName', {
      value: ICEBERG_TABLE_NAME,
      description: 'The table name the Ref must NOT resolve to',
    });
    new cdk.CfnOutput(this, 'IcebergTableRefParamName', {
      value: refConsumer.name!,
      description: 'The SSM parameter whose value is Ref(IcebergTable)',
    });
  }
}
