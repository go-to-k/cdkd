import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';

/**
 * Data Analytics example stack
 *
 * Demonstrates:
 * - AWS::Glue::Database (SDK Provider)
 * - AWS::Glue::Table (SDK Provider) — regular EXTERNAL_TABLE + Iceberg table
 * - AWS::Athena::WorkGroup (L1 CfnWorkGroup)
 * - AWS::Athena::NamedQuery (L1 CfnNamedQuery)
 * - AWS::S3::Bucket for query results
 * - CfnOutputs for workgroup name, database name, bucket name, iceberg table
 *
 * UPDATE mode (`CDKD_TEST_UPDATE=true`, issue #1461) re-shapes two tables so a
 * second deploy exercises the full-replace `UpdateTable` path:
 *
 *  - the Iceberg table gets a NEW Description and nothing else. That is an
 *    edit to a property completely unrelated to `Parameters`, and it is what
 *    used to erase the AWS-authored `table_type` / `metadata_location` the
 *    catalog needs to still read the table as Iceberg.
 *  - the plain `events` table DROPS one user-authored parameter and keeps the
 *    other. That pins the mirror-image half: the fix must not make a
 *    template-expressed removal unremovable. It rides the non-Iceberg table
 *    deliberately, so a user-parameter edit can never be confused with (or
 *    interfere with) Glue's own Iceberg bookkeeping.
 *  - the DATABASE takes the same treatment (new Description, one parameter
 *    dropped, one kept). `UpdateDatabase` is the sibling full-replace API with
 *    the same `Parameters` bag, and without this it had zero real-AWS
 *    coverage — the phase-2 template left the database untouched, so
 *    `readLiveDatabaseParameters` and the database merge were never exercised
 *    against AWS at all.
 */
export class DataAnalyticsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Phase 2 of the #1461 UPDATE round-trip. See the class docstring.
    const updateMode = process.env.CDKD_TEST_UPDATE === 'true';

    // S3 bucket for Athena query results. autoDeleteObjects is enabled so
    // destroy can empty the Iceberg metadata the table below writes under
    // s3://<bucket>/iceberg/ at create time.
    const bucket = new s3.Bucket(this, 'ResultsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Glue Database. Same phase-1 / phase-2 shape as the `events` table below,
    // so verify.sh can exercise the UpdateDatabase merge against real AWS.
    const databaseParameters: Record<string, string> = { keep_me: 'yes' };
    if (!updateMode) {
      databaseParameters.drop_me = 'phase-1-only';
    }

    const database = new glue.CfnDatabase(this, 'AnalyticsDb', {
      catalogId: this.account,
      databaseInput: {
        name: `${this.stackName}-analytics-db`.toLowerCase(),
        description: updateMode ? 'phase-2 update' : 'phase-1 create',
        parameters: databaseParameters,
      },
    });

    // Glue Table. `parameters` here are USER-authored: phase 1 sets both,
    // phase 2 drops `owner_team` and keeps `classification`, so verify.sh can
    // assert a template-expressed removal still reaches AWS after #1461.
    const eventsParameters: Record<string, string> = { classification: 'json' };
    if (!updateMode) {
      eventsParameters.owner_team = 'analytics';
    }

    const table = new glue.CfnTable(this, 'EventsTable', {
      catalogId: this.account,
      databaseName: database.ref,
      tableInput: {
        name: 'events',
        tableType: 'EXTERNAL_TABLE',
        parameters: eventsParameters,
        storageDescriptor: {
          columns: [
            { name: 'event_id', type: 'string' },
            { name: 'timestamp', type: 'timestamp' },
            { name: 'payload', type: 'string' },
          ],
          location: `s3://${bucket.bucketName}/events/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
          },
        },
      },
    });

    // Iceberg Glue Table — exercises the #609 OpenTableFormatInput backfill
    // (top-level CreateTable param; MetadataOperation: 'CREATE' writes Iceberg
    // metadata under the S3 location at create time).
    new glue.CfnTable(this, 'IcebergTable', {
      catalogId: this.account,
      databaseName: database.ref,
      openTableFormatInput: { icebergInput: { metadataOperation: 'CREATE', version: '2' } },
      tableInput: {
        name: 'events_iceberg',
        tableType: 'EXTERNAL_TABLE',
        // The ONLY thing phase 2 changes on this table. `Parameters` is never
        // declared here, so every entry on the live table is AWS-authored.
        description: updateMode ? 'phase-2 update' : 'phase-1 create',
        storageDescriptor: {
          columns: [
            { name: 'event_id', type: 'string' },
            { name: 'ts', type: 'timestamp' },
          ],
          location: `s3://${bucket.bucketName}/iceberg/`,
        },
      },
    });

    // Athena WorkGroup
    const workGroup = new athena.CfnWorkGroup(this, 'AnalyticsWorkGroup', {
      name: `${this.stackName}-workgroup`,
      state: 'ENABLED',
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${bucket.bucketName}/athena-results/`,
        },
      },
    });

    // Athena Named Query.
    // `workGroup.name` is a literal string (not a Ref), so it creates NO
    // dependency edge — an explicit addDependency is required so cdkd's DAG
    // creates the WorkGroup before the NamedQuery (else AWS rejects with
    // "WorkGroup is not found").
    const sampleQuery = new athena.CfnNamedQuery(this, 'SampleQuery', {
      database: database.ref,
      queryString: 'SELECT event_id, timestamp FROM events LIMIT 10',
      name: `${this.stackName}-sample-query`,
      workGroup: workGroup.name,
    });
    sampleQuery.addDependency(workGroup);

    // Outputs
    new cdk.CfnOutput(this, 'WorkGroupName', {
      value: workGroup.name,
      description: 'Athena WorkGroup name',
    });

    new cdk.CfnOutput(this, 'DatabaseName', {
      value: database.ref,
      description: 'Glue Database name',
    });

    new cdk.CfnOutput(this, 'IcebergTableName', {
      value: 'events_iceberg',
      description: 'Glue Iceberg table name (OpenTableFormatInput backfill)',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 results bucket name',
    });
  }
}
