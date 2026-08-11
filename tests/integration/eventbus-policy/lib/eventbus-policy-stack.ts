import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';

/**
 * Integ probe for `AWS::Events::EventBusPolicy` — the resource-based policy
 * on a custom event bus (cross-account PutEvents grants). No SDK provider,
 * so this exercises the Cloud Control fallback for a policy-shaped resource.
 *
 * Phase 1 (no env): custom bus + a policy statement granting the own
 * account `events:PutEvents`.
 * Phase 2 (CDKD_TEST_UPDATE=true): the SAME statement gains a `Condition`
 * block — a pure key ADDITION inside a nested object. The deployed policy
 * must keep the full statement (Sid / Principal / Action / Resource) WITH
 * the added Condition, and `cdkd diff` must render the addition
 * symmetrically (`old: {}` / `new: {Condition: ...}` — issue #1608, where
 * the old side used to print the full statement and read as a removal of
 * everything else).
 *
 * Destroy exercises the policy-before-bus deletion ordering.
 *
 * covers: AWS::Events::EventBus
 * covers: AWS::Events::EventBusPolicy
 * Found by the 2026-08-11 /hunt-bugs sweep (deploy/update/destroy were all
 * clean; the diff RENDERING was the bug); this fixture is the regression
 * guard for both the CC-fallback update path and the #1608 diff shape.
 */
export class EventbusPolicyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const bus = new events.EventBus(this, 'Bus', {
      eventBusName: 'cdkd-integ-buspolicy-bus',
    });

    new events.CfnEventBusPolicy(this, 'BusPolicy', {
      eventBusName: bus.eventBusName,
      statementId: 'cdkd-integ-buspolicy-stmt',
      statement: {
        Sid: 'cdkd-integ-buspolicy-stmt',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${this.account}:root` },
        Action: 'events:PutEvents',
        Resource: bus.eventBusArn,
        ...(update
          ? {
              Condition: {
                StringEquals: { 'events:detail-type': 'cdkd.integ' },
              },
            }
          : {}),
      },
    });

    new cdk.CfnOutput(this, 'BusArn', { value: bus.eventBusArn });
  }
}
