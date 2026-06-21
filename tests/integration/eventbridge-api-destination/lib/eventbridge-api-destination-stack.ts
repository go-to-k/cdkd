import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

/**
 * Integ probe for the EventBridge `AWS::Events::Connection` Arn GetAtt
 * enrichment gap (the daily webhook pattern).
 *
 * `AWS::Events::Connection` is CC-API-provisioned (no SDK provider) and its
 * primaryIdentifier is `Name`, so the cdkd physicalId is the connection NAME,
 * not the ARN. The readOnly `Arn` attribute was NOT enriched, so an
 * `AWS::Events::ApiDestination` whose `ConnectionArn` is
 * `Fn::GetAtt(Connection, 'Arn')` (the canonical CDK shape) received the bare
 * name instead of an ARN, and the ApiDestination CREATE failed CC model
 * validation (`#/ConnectionArn: failed validation constraint for keyword
 * [pattern]`). The whole webhook pattern was unusable.
 *
 * This fixture wires the full chain so the deploy exercises every enriched
 * attribute:
 *   - ApiDestination.ConnectionArn  -> Fn::GetAtt(Connection, 'Arn')
 *   - Rule target Arn               -> Fn::GetAtt(ApiDestination, 'Arn')
 *   - Rule invoke-role policy       -> Fn::GetAtt(ApiDestination, 'ArnForPolicy')
 *
 * A successful deploy (the ApiDestination CREATE no longer fails) IS the proof;
 * verify.sh additionally asserts the resolved ConnectionArn reaching AWS is a
 * real ARN, not the bare connection name.
 */
export class EventbridgeApiDestinationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const connection = new events.Connection(this, 'Connection', {
      connectionName: `${this.stackName.toLowerCase()}-conn`,
      authorization: events.Authorization.apiKey(
        'x-api-key',
        cdk.SecretValue.unsafePlainText('cdkd-integ-api-key')
      ),
    });

    const destination = new events.ApiDestination(this, 'Destination', {
      apiDestinationName: `${this.stackName.toLowerCase()}-dest`,
      connection,
      endpoint: 'https://example.com/cdkd-integ-webhook',
      httpMethod: events.HttpMethod.POST,
    });

    // A scheduled rule targeting the ApiDestination exercises the
    // ApiDestination Arn / ArnForPolicy enrichment (target arn + invoke-role
    // policy) on top of the Connection Arn used by the ApiDestination itself.
    const rule = new events.Rule(this, 'Rule', {
      ruleName: `${this.stackName.toLowerCase()}-rule`,
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
    });
    rule.addTarget(new targets.ApiDestination(destination));
  }
}
