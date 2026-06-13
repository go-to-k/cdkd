import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Tiny stack for the `deployment-events` integration test (issue #808).
 *
 * The point of this fixture is *not* the resources it creates — it is the
 * structured deployment-event stream cdkd writes to S3 alongside (but in a
 * separate key family from) `state.json`, and the `cdkd events` command that
 * reads it back. The stack just needs a couple of cheap, fast resources so
 * deploy/destroy each emit RUN_STARTED / RESOURCE_* / RUN_FINISHED events
 * with real per-resource lifecycle rows.
 *
 * The SSM parameter's value is a deliberate marker
 * (`events-integ-secret-value`): verify.sh asserts this string NEVER appears
 * in the `cdkd events --format json` output, proving the #808 "no resource
 * properties in events" (no-secrets) guarantee — properties live only in
 * state.json, never in the events sidecar.
 */
export class DeploymentEventsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Cheap, fast-to-create/destroy resources (no VPC / NAT / long polling).
    new sns.Topic(this, 'EventsTopic', {
      topicName: `${this.stackName}-topic`,
      displayName: 'cdkd deployment-events fixture topic',
    });

    // The value is a secret-shaped marker the no-secrets assertion greps for.
    new ssm.StringParameter(this, 'EventsParameter', {
      parameterName: `${this.stackName}-marker`,
      stringValue: 'events-integ-secret-value',
      description: 'Marker parameter for the deployment-events integration test',
    });
  }
}
