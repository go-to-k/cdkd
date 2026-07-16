import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';

/**
 * Integ probe for `AWS::Events::Archive` — the "keep events for replay"
 * pattern on a custom event bus.
 *
 * Phase 1 (no env): custom bus + archive with 3-day retention filtering a
 * single source.
 * Phase 2 (CDKD_TEST_UPDATE=true): retention grows to 7 days and the event
 * pattern gains a second source — both in-place updatable per CFn; the
 * archive must keep its identity (CreationTime unchanged).
 *
 * Destroy exercises the archive-before-bus deletion ordering (the archive
 * references the bus via SourceArn).
 *
 * covers: AWS::Events::EventBus
 * covers: AWS::Events::Archive
 * Confirmed CLEAN by a /hunt-bugs sweep (2026-07-17); this fixture is the
 * regression guard.
 */
export class EventbridgeArchiveStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const bus = new events.EventBus(this, 'Bus', {
      eventBusName: 'cdkd-integ-archive-bus',
    });

    new events.Archive(this, 'Archive', {
      sourceEventBus: bus,
      archiveName: 'cdkd-integ-archive',
      retention: update ? cdk.Duration.days(7) : cdk.Duration.days(3),
      eventPattern: {
        source: update ? ['integ.app', 'integ.worker'] : ['integ.app'],
      },
      description: 'cdkd integ archive',
    });

    new cdk.CfnOutput(this, 'BusName', { value: bus.eventBusName });
  }
}
