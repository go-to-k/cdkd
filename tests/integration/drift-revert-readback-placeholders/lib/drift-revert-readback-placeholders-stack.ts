import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Integ probe for go-to-k/cdkd#7027, #7028 and #7029: `cdkd drift --revert`
 * after an unrelated out-of-band change failed on each of these, because the
 * read-back's placeholders for members AWS reports none of were sent back:
 *
 * - `Api` (no `logConfig`): `LogConfig: {}` -> `cloudWatchLogsRoleArn is invalid`.
 * - `Job` (worker-type capacity, no execution class / maintenance window /
 *   security configuration / notification): `''` and `0` placeholders refused,
 *   then the computed `MaxCapacity` / `AllocatedCapacity` beside the workers.
 * - `Trigger` (`ON_DEMAND`): `EventBatchingCondition: {}` -> `BatchSize` 0 refused.
 *
 * `LogsRole` is unused by the template: the verify script turns the API's
 * logging on with it out of band, for the revert back to "no logging".
 */
export class DriftRevertReadbackPlaceholdersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const api = new appsync.CfnGraphQLApi(this, 'Api', {
      name: `${this.stackName}-api`,
      authenticationType: 'API_KEY',
    });
    // The role the verify script turns logging on with, out of band.
    new iam.Role(this, 'LogsRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSAppSyncPushToCloudWatchLogs'),
      ],
    });
    new appsync.CfnGraphQLSchema(this, 'Schema', {
      apiId: api.attrApiId,
      definition: 'type Query { hello: String }\nschema { query: Query }',
    });

    const scripts = new s3.Bucket(this, 'Scripts', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const role = new iam.Role(this, 'GlueRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
    });
    scripts.grantRead(role);
    const job = new glue.CfnJob(this, 'Job', {
      name: `${this.stackName}-job`,
      role: role.roleArn,
      description: 'integ job',
      command: { name: 'glueetl', scriptLocation: `s3://${scripts.bucketName}/x.py`, pythonVersion: '3' },
      glueVersion: '4.0',
      workerType: 'G.1X',
      numberOfWorkers: 2,
    });
    const trigger = new glue.CfnTrigger(this, 'Trigger', {
      name: `${this.stackName}-trigger`,
      type: 'ON_DEMAND',
      description: 'integ trigger',
      actions: [{ jobName: `${this.stackName}-job` }],
    });
    trigger.addDependency(job);
  }
}
