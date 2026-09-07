import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

/**
 * What a still-SDK resource does when the template gains a property cdkd's SDK
 * provider would silently drop -- issue
 * [2744](https://github.com/go-to-k/cdkd/issues/2744).
 *
 * `docs/cli-deploy-safety.md` answered that question twice, oppositely, about
 * seventy lines apart: the `--allow-unsupported-properties` section said the
 * next deploy AUTO-ROUTES the resource through Cloud Control (and that the
 * flag exists to prevent that), while `--recreate-via-cc-api` said the
 * property "will not reach AWS, because the SDK update path drops it
 * silently" and a destroy-and-recreate is required. A reader acts on the
 * difference: one of them costs downtime.
 *
 * `ProviderRegistry.getProviderFor` enters the sticky rule only for a record
 * already at `'cc-api'`, so a `'sdk'` record falls through to the silent-drop
 * check every deploy -- which reads like the first passage. But reading the
 * routing code does not settle whether the resulting Cloud Control UPDATE
 * SUCCEEDS against a physical id the SDK provider minted, nor whether the
 * property actually lands. This fixture observes it on a live resource.
 *
 * WHY `AWS::CloudWatch::Alarm`. Three conditions, and they are scarce
 * together:
 *
 *  - it has an SDK provider, so a fresh deploy records `provisionedBy: 'sdk'`
 *    -- the state this question is about;
 *  - `EvaluationWindow` sits in its `silentDrop` map with the rationale `not
 *    yet implemented by cdkd`. The type's other two entries are deliberately
 *    NOT used: both say "no CDK app can emit it", so no template can carry
 *    them and neither could drive a routing decision;
 *  - the committed schema's `createOnlyProperties` is `['AlarmName']` alone,
 *    so a failure to apply `EvaluationWindow` cannot be explained away as
 *    create-only semantics -- which is one of the two hypotheses that would
 *    have made the second passage right for a reason it does not state.
 *
 * It is also free and provisions instantly, so the arm costs nothing to re-run.
 *
 * `EvaluationWindow` is set through `addPropertyOverride` because
 * `aws-cdk-lib`'s `CfnAlarm` does not carry it yet (it is a 2026-07 schema
 * addition). That is the escape hatch a real user would reach for, and it is
 * what puts the property in the synthesized template, which is the only input
 * the routing decision reads.
 *
 * Phase env `CDKD_TEST_PHASE`, set by verify.sh:
 *   base      -- handled properties only; the resource must land on the SDK route
 *   drop      -- PLUS EvaluationWindow, deployed with NO flag. THE ARM.
 *   rebase    -- back to handled properties only, so the resource is eligible
 *                for `--recreate-via-sdk-provider`. Control for the IDENTITY
 *                WITNESS: a genuine destroy-and-recreate must kill the
 *                out-of-band tag, or the tag surviving the arm witnesses
 *                nothing.
 *   allowdrop -- PLUS EvaluationWindow, deployed WITH
 *                `--allow-unsupported-properties`. Control for the PREMISE:
 *                proves the SDK route really does drop the property, which the
 *                arm otherwise imports from the generated coverage map.
 *   dropagain -- the same property again with NO flag, after `allowdrop`.
 *                Pins go-to-k/cdkd#2750: the opt-out deploy RECORDED the
 *                property it never wrote, so the Cloud Control patch diffs it
 *                as unchanged and it never reaches AWS. Same operation as the
 *                arm; the only difference is the recorded bag.
 *
 * The threshold moves with the phase for the same reason the sibling
 * `cc-to-sdk-reroute` fixture varies its DisplayName: routing is decided while
 * PROVISIONING, so a deploy the differ classifies NO_CHANGE never calls the
 * provider and never re-routes. Without a real property delta the second phase
 * would be a no-op and every assertion after it would pass vacuously.
 */
const THRESHOLD_BY_PHASE: Record<string, number> = {
  base: 1,
  drop: 2,
  rebase: 3,
  allowdrop: 4,
  dropagain: 5,
};

/** The phases whose template carries the silently-dropped property. */
const PHASES_WITH_DROP = new Set(['drop', 'allowdrop', 'dropagain']);

export class SdkToCcAutorouteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';

    const alarm = new cloudwatch.CfnAlarm(this, 'AutorouteAlarm', {
      alarmName: `${this.stackName}-alarm`,
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      period: 300,
      statistic: 'Sum',
      threshold: THRESHOLD_BY_PHASE[phase] ?? 1,
    });

    if (PHASES_WITH_DROP.has(phase)) {
      // The whole point of the fixture: a top-level CFn property that IS in
      // the committed schema and IS in this type's silentDrop map. The value
      // shape was confirmed against a live Cloud Control create before this
      // fixture was written, so a failure here is cdkd's routing, not a
      // malformed property.
      alarm.addPropertyOverride('EvaluationWindow', { WallClockWindow: { Timezone: 'UTC' } });
    }

    new cdk.CfnOutput(this, 'AlarmName', { value: alarm.ref });
  }
}
