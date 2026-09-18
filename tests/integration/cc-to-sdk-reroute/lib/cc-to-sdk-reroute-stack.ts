import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';

/** One distinct value per routing phase — see the class docstring. */
const DISPLAY_NAME_BY_PHASE: Record<string, string> = {
  base: 'before-reroute',
  seed: 'seeded-on-cc',
  pinned: 'pinned-on-cc',
  flip: 'after-reroute',
  // The removal phase keeps the flip's DisplayName on purpose: the ONLY change
  // that deploy carries is the dropped MaximumMessageSize, so the provider
  // call it triggers is the removal arm and nothing else.
  removed: 'after-reroute',
};

/**
 * `MaximumMessageSize` by phase (issue #3413). AWS published the member in
 * the 2026-09-18 schema refresh and it was a silent drop on the one type that
 * carries the `'sdk-coverage'` exemption — whose admission premise is an EMPTY
 * silentDrop map. Wiring it restores the premise; this fixture is where the
 * wire is observed: created on the SDK route (base), carried through the
 * Cloud Control recreate (seed / pinned), UPDATED by the SDK provider on the
 * flip (1048576 -> 524288), then REMOVED (`removed` leaves it undeclared),
 * which must reset the live value to SNS's 262144 default rather than send
 * the `''` SNS refuses. An undefined entry means "not declared".
 */
const MAXIMUM_MESSAGE_SIZE_BY_PHASE: Record<string, number | undefined> = {
  base: 1048576,
  seed: 1048576,
  pinned: 1048576,
  flip: 524288,
  removed: undefined,
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

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const topic = new sns.Topic(this, 'RerouteTopic', {
      topicName: `${this.stackName}-topic`,
      displayName: DISPLAY_NAME_BY_PHASE[phase] ?? 'before-reroute',
    });
    // The L2 has no prop for the member yet, so it rides the L1 override; an
    // undefined phase value leaves the property undeclared (the removal shape).
    const maximumMessageSize = MAXIMUM_MESSAGE_SIZE_BY_PHASE[phase];
    if (maximumMessageSize !== undefined) {
      (topic.node.defaultChild as sns.CfnTopic).addPropertyOverride(
        'MaximumMessageSize',
        maximumMessageSize
      );
    }

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
  }
}
