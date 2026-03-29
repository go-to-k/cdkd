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
 * - AWS::Glue::Table (SDK Provider)
 * - AWS::Athena::WorkGroup (L1 CfnWorkGroup)
 * - AWS::Athena::NamedQuery (L1 CfnNamedQuery)
 * - AWS::S3::Bucket for query results
 * - CfnOutputs for workgroup name, database name, bucket name
 */
export class DataAnalyticsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for Athena query results
    const bucket = new s3.Bucket(this, 'ResultsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // Glue Database
    const database = new glue.CfnDatabase(this, 'AnalyticsDb', {
      catalogId: this.account,
      databaseInput: {
        name: `${this.stackName}-analytics-db`.toLowerCase(),
      },
    });

    // Glue Table
    const table = new glue.CfnTable(this, 'EventsTable', {
      catalogId: this.account,
      databaseName: database.ref,
      tableInput: {
        name: 'events',
        tableType: 'EXTERNAL_TABLE',
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

    // Athena Named Query
    new athena.CfnNamedQuery(this, 'SampleQuery', {
      database: database.ref,
      queryString: 'SELECT event_id, timestamp FROM events LIMIT 10',
      name: `${this.stackName}-sample-query`,
      workGroup: workGroup.name,
    });

    // Outputs
    new cdk.CfnOutput(this, 'WorkGroupName', {
      value: workGroup.name,
      description: 'Athena WorkGroup name',
    });

    new cdk.CfnOutput(this, 'DatabaseName', {
      value: database.ref,
      description: 'Glue Database name',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 results bucket name',
    });
  }
}
