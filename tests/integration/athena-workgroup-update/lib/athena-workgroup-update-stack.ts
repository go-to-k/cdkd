import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Integ probe for an Athena workgroup's in-place configuration UPDATE
 * (go-to-k/cdkd#6561).
 *
 * covers: AWS::Athena::WorkGroup
 * covers: AWS::S3::Bucket
 *
 * The workgroup never declares `WorkGroupConfiguration.EngineVersion`; AWS
 * fills it in at create (`SelectedEngineVersion: AUTO` plus the read-only
 * `EffectiveEngineVersion`). The workgroup goes through Cloud Control, and a
 * configuration change is one op writing the whole `WorkGroupConfiguration`:
 * without the live `EngineVersion` carried into it, Cloud Control refused the
 * update (`readOnlyProperties [.../EngineVersion/EffectiveEngineVersion]
 * cannot be updated`).
 *
 * Phase 1 (no env): base configuration. Phase 2 (CDKD_TEST_UPDATE=true): a new
 * output location, cutoff, enforcement flag, description and tags. Phase 3
 * (also CDKD_TEST_ENGINE=declare): the template declares `EngineVersion`.
 * Phase 4 (CDKD_TEST_UPDATE=true again): the template REMOVES it; Cloud
 * Control still needs the read-only leaf, while CloudFormation resets
 * `SelectedEngineVersion` to `AUTO`. The workgroup's fixed name lets
 * verify.sh read it back across the updates.
 */
export class AthenaWorkgroupUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const updated = process.env.CDKD_TEST_UPDATE === 'true';
    const declareEngine = process.env.CDKD_TEST_ENGINE === 'declare';

    const results = new s3.Bucket(this, 'ResultsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const workGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: `${this.stackName}-wg`,
      description: updated ? 'cdkd athena workgroup update (updated)' : 'cdkd athena workgroup update (base)',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: !updated,
        bytesScannedCutoffPerQuery: updated ? 20_000_000 : 10_000_000,
        publishCloudWatchMetricsEnabled: false,
        ...(declareEngine
          ? { engineVersion: { selectedEngineVersion: 'Athena engine version 3' } }
          : {}),
        resultConfiguration: {
          outputLocation: `s3://${results.bucketName}/${updated ? 'results-v2' : 'results'}/`,
        },
      },
      tags: updated
        ? [
            { key: 'phase', value: 'updated' },
            { key: 'added', value: 'yes' },
          ]
        : [{ key: 'phase', value: 'base' }],
    });

    new cdk.CfnOutput(this, 'WorkGroupName', { value: workGroup.ref });
    new cdk.CfnOutput(this, 'ResultsBucketName', { value: results.bucketName });
  }
}
