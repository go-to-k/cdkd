import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';

/**
 * Stack-lock renewal stack (issue #2168).
 *
 * The stack itself is uninteresting; what matters is that its deploy takes
 * LONGER THAN ONE LOCK RENEWAL INTERVAL. A single custom resource whose
 * onEvent handler sleeps does that deterministically, for a few hundredths of
 * a cent, without provisioning anything slow or billed by the hour.
 *
 * Why a sleep rather than a genuinely slow resource: the property under test
 * is elapsed WALL-CLOCK time inside one `cdkd deploy` while it holds the stack
 * lock, and every naturally slow AWS resource that would produce it (NAT
 * gateway, RDS, FSx) is either expensive or slow to tear down. This is also
 * the shape of the real-world case issue #2168 describes -- a resource that
 * waits longer than the lock's TTL -- reproduced at a scale a test can afford.
 *
 * `CDKD_LOCK_RENEWAL_SLEEP_SECONDS` lets verify.sh dial the deploy length; it
 * defaults to 150s, comfortably past the 120s renewal cap in
 * `src/state/lock-manager.ts`.
 *
 * covers: Custom::CdkdLockRenewalSleep
 */
export class StackLockRenewalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const sleepSeconds = Number(process.env.CDKD_LOCK_RENEWAL_SLEEP_SECONDS ?? '150');

    const onEvent = new lambda.Function(this, 'SleepOnEvent', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      // Only CREATE sleeps. UPDATE and DELETE return at once, so a re-run and
      // the teardown stay fast -- the deploy is the only phase whose duration
      // this fixture is asserting on.
      code: lambda.Code.fromInline(
        [
          'import time',
          '',
          'def handler(event, context):',
          '    if event.get("RequestType") == "Create":',
          `        time.sleep(${String(sleepSeconds)})`,
          '    return {"PhysicalResourceId": "cdkd-lock-renewal-sleep"}',
        ].join('\n')
      ),
      timeout: cdk.Duration.seconds(Math.min(900, sleepSeconds + 120)),
      memorySize: 128,
    });
    onEvent.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const provider = new cr.Provider(this, 'SleepProvider', {
      onEventHandler: onEvent,
    });

    new cdk.CustomResource(this, 'Sleep', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CdkdLockRenewalSleep',
    });
  }
}
