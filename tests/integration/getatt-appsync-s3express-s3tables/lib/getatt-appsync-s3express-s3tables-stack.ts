import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as s3express from 'aws-cdk-lib/aws-s3express';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import type { Construct } from 'constructs';

/**
 * Issue #6242, measured against CloudFormation: each of these attributes
 * resolved to the physical id (the api id, the directory
 * bucket name, the table's composite id). `WarehouseLocation` is served by the
 * resolver's re-read through the provider's `import()`, so this fixture also
 * exercises that heal on a fresh deploy. `ApiKeyId` is covered by unit tests
 * only: its value is the API key itself, which an Output would persist to state.
 *
 * covers: AWS::AppSync::GraphQLApi
 * covers: AWS::S3Express::DirectoryBucket
 * covers: AWS::S3Tables::TableBucket
 * covers: AWS::S3Tables::Namespace
 * covers: AWS::S3Tables::Table
 */
export class GetattAppsyncS3expressS3tablesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const api = new appsync.CfnGraphQLApi(this, 'Api', { name: `${id}-api`, authenticationType: 'API_KEY' });

    const dir = new s3express.CfnDirectoryBucket(this, 'Dir', {
      dataRedundancy: 'SingleAvailabilityZone',
      locationName: 'use1-az4',
    });

    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName: `${id.toLowerCase()}-tb`,
    });
    const namespace = new s3tables.CfnNamespace(this, 'Namespace', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: 'ns1',
    });
    const table = new s3tables.CfnTable(this, 'Table', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: 'ns1',
      tableName: 't1',
      openTableFormat: 'ICEBERG',
      icebergMetadata: { icebergSchema: { schemaFieldList: [{ name: 'id', type: 'int', required: true }] } },
    });
    table.addDependency(namespace);

    new cdk.CfnOutput(this, 'ApiId', { value: api.attrApiId });
    new cdk.CfnOutput(this, 'GraphQLDns', { value: api.attrGraphQlDns });
    new cdk.CfnOutput(this, 'RealtimeDns', { value: api.attrRealtimeDns });
    new cdk.CfnOutput(this, 'DirectoryBucket', { value: dir.ref });
    new cdk.CfnOutput(this, 'DirectoryBucketAz', { value: dir.attrAvailabilityZoneName });
    new cdk.CfnOutput(this, 'TableArn', { value: table.attrTableArn });
    new cdk.CfnOutput(this, 'WarehouseLocation', { value: table.attrWarehouseLocation });
    new cdk.CfnOutput(this, 'VersionToken', { value: table.attrVersionToken });
  }
}
