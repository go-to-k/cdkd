import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cr from 'aws-cdk-lib/custom-resources';

/**
 * AwsCustomResource (Custom::AWS) stack.
 *
 * `AwsCustomResource` is the canonical "call an SDK API from a custom resource"
 * pattern — extremely common (only `export` used it before, with no dedicated
 * fixture and no UPDATE test). It synthesizes a Custom::AWS resource backed by a
 * Provider-framework Lambda. This fixture exercises all three lifecycle hooks
 * against a real SSM parameter:
 *   - onCreate / onUpdate: PutParameter (Overwrite)
 *   - onDelete: DeleteParameter
 *
 * The UPDATE path is the interesting, previously-untested divergence point:
 * CDKD_TEST_UPDATE flips the value so onUpdate fires on redeploy and verify.sh
 * asserts the new value reached AWS in place.
 *
 * `installLatestAwsSdk: false` keeps the CR provider on Lambda's built-in SDK
 * (PutParameter/DeleteParameter are in it) — no slow runtime npm install.
 *
 * covers: Custom::AWS
 */
export class AwsCustomResourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const paramName = '/cdkd-awscr/value';
    const value = process.env.CDKD_TEST_UPDATE === 'true' ? 'v2-updated' : 'v1-created';

    new cr.AwsCustomResource(this, 'PutParam', {
      installLatestAwsSdk: false,
      onCreate: {
        service: 'SSM',
        action: 'PutParameter',
        parameters: { Name: paramName, Value: value, Type: 'String', Overwrite: true },
        physicalResourceId: cr.PhysicalResourceId.of(paramName),
      },
      onUpdate: {
        service: 'SSM',
        action: 'PutParameter',
        parameters: { Name: paramName, Value: value, Type: 'String', Overwrite: true },
        physicalResourceId: cr.PhysicalResourceId.of(paramName),
      },
      onDelete: {
        service: 'SSM',
        action: 'DeleteParameter',
        parameters: { Name: paramName },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    new cdk.CfnOutput(this, 'ParamName', { value: paramName });
  }
}
