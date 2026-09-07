import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';

/** One distinct value per routing phase — see the class docstring. */
const DISPLAY_NAME_BY_PHASE: Record<string, string> = {
  base: 'before-reroute',
  seed: 'seeded-on-cc',
  pinned: 'pinned-on-cc',
  flip: 'after-reroute',
};

/**
 * physicalId-parity arm for issue 2719: a resource pinned to
 * `provisionedBy: 'cc-api'` returns to its SDK provider WITHOUT churn.
 *
 * The `'sdk-coverage'` sticky exemption's whole safety property is condition 2
 * -- both layers address the resource by the same physicalId, so the flip is
 * invisible to the user. That is an empirical per-type fact (Cloud Control
 * mints an `Identifier` from the schema's `primaryIdentifier`; the SDK
 * provider stores whatever its create returns), and it is FALSE in general.
 * Asserting it from provider source is not the same as observing it on a live
 * resource, which is what this fixture does.
 *
 * `AWS::SNS::Topic` is the first admitted type: fully covered (no silent-drop
 * properties), cheap, non-stateful, and CC-provisionable. Its schema's
 * `primaryIdentifier` is `TopicArn` and `SnsTopicProvider.create` stores
 * `topicArn` -- the hypothesis this run tests rather than assumes.
 *
 * Phase env `CDKD_TEST_PHASE`, set by verify.sh, drives `DisplayName`.
 *
 * EVERY phase that must exercise routing needs its OWN value, and that is the
 * whole reason this is a three-valued knob rather than a boolean. The flip
 * happens while PROVISIONING a resource, so a deploy the differ classifies
 * NO_CHANGE never calls the provider and never flips. With one boolean, the
 * pinned phase and the flip phase would render the same template, the second
 * would be a no-op, and the arm would report the record still on `cc-api`
 * followed by a flip that never happened -- passing while testing nothing.
 */
export class CcToSdkRerouteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const topic = new sns.Topic(this, 'RerouteTopic', {
      topicName: `${this.stackName}-topic`,
      displayName: DISPLAY_NAME_BY_PHASE[process.env.CDKD_TEST_PHASE ?? 'base'] ?? 'before-reroute',
    });

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
  }
}
