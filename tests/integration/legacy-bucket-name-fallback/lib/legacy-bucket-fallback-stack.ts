import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Minimal stack used by the legacy-bucket-name-fallback integration test.
 *
 * The test does not exercise resource provisioning at all — it only needs a
 * deployable stack so that `cdkd deploy` reaches the state-backend code path
 * and triggers the legacy-bucket-name fallback in
 * `resolveStateBucketWithDefault`. A single SSM parameter is the cheapest
 * and fastest resource to create + tear down on real AWS.
 */
export class LegacyBucketFallbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ssm.StringParameter(this, 'TestParam', {
      parameterName: '/cdkd/legacy-bucket-fallback/test',
      stringValue: 'fallback-test-marker',
      description: 'Marker for the legacy-bucket-name fallback integ test',
    });
  }
}
