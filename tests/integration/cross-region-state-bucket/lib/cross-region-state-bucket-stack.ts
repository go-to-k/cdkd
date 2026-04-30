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
 */
export class CrossRegionStateBucketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ssm.CfnParameter(this, 'CrossRegionMarker', {
      type: 'String',
      value: 'cdkd cross-region-state-bucket fixture',
      name: `${this.stackName}-marker`,
      description: 'Marker parameter for the cross-region state-bucket integration test',
    });
  }
}
