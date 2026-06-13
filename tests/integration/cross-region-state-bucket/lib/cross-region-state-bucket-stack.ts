import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Trivial stack for the cross-region-state-bucket integration test.
 *
 * The point of this fixture is *not* the resources it creates — it is the
 * combination of a state bucket in one region (e.g. us-west-2) and a CLI
 * invocation under a different default region (e.g. us-east-1). The stack
 * itself just needs at least one cheap resource so deploy/destroy do
 * something observable.
 *
 * Manual run example:
 *
 *   AWS_REGION=us-east-1 cdkd deploy --state-bucket cdkd-state-test-cross-region
 *   AWS_REGION=us-east-1 cdkd state list --state-bucket cdkd-state-test-cross-region
 *   AWS_REGION=us-east-1 cdkd destroy --state-bucket cdkd-state-test-cross-region
 *
 * Pre-PR-3 the second command would surface the AWS SDK v3 synthetic
 * `UnknownError`; post-PR-3 it succeeds silently because the backend
 * resolves the bucket region via GetBucketLocation and rebuilds its
 * S3 client to the bucket's region.
 *
 * Issue #819 extension: the stack also publishes a CloudFormation Output
 * with an `Export.Name`. cdkd's exports index store (`Fn::ImportValue`
 * tracking) writes `_index/{region}/exports.json` after the deploy save
 * and removes the stack's entries after destroy. That store used an S3
 * client pinned to the CLI base region, so against a cross-region bucket
 * its write/remove hit S3's 301 PermanentRedirect — surfacing as
 * `Exports index ... failed (non-retryable): ... must be addressed using
 * the specified endpoint`. The exported Output makes the index non-empty
 * so that path actually runs (an export-less stack short-circuits the
 * index write), and verify.sh asserts the deploy/destroy output carries
 * NO such 301 warning.
 */
export class CrossRegionStateBucketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const marker = new ssm.CfnParameter(this, 'CrossRegionMarker', {
      type: 'String',
      value: 'cdkd cross-region-state-bucket fixture',
      name: `${this.stackName}-marker`,
      description: 'Marker parameter for the cross-region state-bucket integration test',
    });

    // Exported Output → exercises the exports index write (on deploy) and
    // remove (on destroy) against the cross-region state bucket (issue #819).
    new cdk.CfnOutput(this, 'CrossRegionMarkerName', {
      value: marker.ref,
      description: 'The marker parameter name, exported so the exports index store runs',
      exportName: `${this.stackName}-marker-name`,
    });
  }
}
