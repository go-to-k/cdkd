import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Fixture for the standalone `cdkd rollback` command (issue #1183).
 *
 * The stack is env-parameterized so verify.sh can drive a clean v1 deploy, a
 * failing v2 deploy (`--no-rollback`, which persists a rollback journal), and
 * a first-ever failing deploy (the `initialDeploy` path) — all from ONE app.
 *
 * Resources (SSM parameters + one deliberately-invalid SQS queue — fast,
 * scalar, and trivial to clean up; no VPC / Lambda / IAM to keep the run
 * quick and the teardown simple):
 *
 *   - `Marker` — an SSM StringParameter whose VALUE is `MARKER_VALUE` (default
 *     `v1`). This is the UPDATE-revert target: v2 changes it to `v2`, and
 *     `cdkd rollback` must restore it to `v1`.
 *   - `Extra` — an SSM StringParameter created ONLY when `WITH_EXTRA=true`
 *     (the v2 deploy). This is the CREATE-rollback target: `cdkd rollback`
 *     must delete it.
 *   - `ReplaceParam` — an SSM StringParameter whose NAME carries
 *     `REPLACE_SUFFIX` (default `a`). Changing the suffix changes the
 *     create-only `Name` property, driving a REPLACEMENT — the
 *     reverse-replacement rollback target (issue #1199): `cdkd rollback`
 *     must re-create the old-named parameter and delete the new-named one.
 *   - `RevertQueue` — an SQS queue whose `messageRetentionPeriod` is valid
 *     (3600) by default and out-of-range (9999999) when
 *     `INJECT_UPDATE_FAIL=true`. AWS rejects the `SetQueueAttributes`
 *     UPDATE, so the deploy fails ON AN UPDATE — the `--revert-failed`
 *     target (issue #1198): the journal records the failed op with its
 *     pre-op state + attempted properties, and
 *     `cdkd rollback --revert-failed` force-reverts it.
 *   - `FailingQueue` — an SQS queue with an out-of-range
 *     `messageRetentionPeriod` (valid range [60, 1209600]) added ONLY when
 *     `INJECT_FAIL=true`. AWS rejects `CreateQueue`, so the deploy fails. It
 *     DEPENDS ON every other resource in the stack so those complete first
 *     (event-driven DAG) — guaranteeing the journal records real work.
 */
export class RollbackCommandStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-command');

    const markerValue = process.env.MARKER_VALUE ?? 'v1';

    const marker = new ssm.StringParameter(this, 'Marker', {
      parameterName: `${this.stackName}-marker`,
      stringValue: markerValue,
      description: 'UPDATE-revert target for the cdkd rollback integ',
    });

    const deps: Construct[] = [marker];

    // Reverse-replacement target (issue #1199): the create-only Name changes
    // with REPLACE_SUFFIX, so a suffix flip drives a REPLACEMENT.
    const replaceSuffix = process.env.REPLACE_SUFFIX ?? 'a';
    const replaceParam = new ssm.StringParameter(this, 'ReplaceParam', {
      parameterName: `${this.stackName}-replace-${replaceSuffix}`,
      stringValue: 'replace-target',
      description: 'reverse-replacement rollback target for the cdkd rollback integ',
    });
    deps.push(replaceParam);

    // --revert-failed target (issue #1198): valid on CREATE, out-of-range on
    // UPDATE when INJECT_UPDATE_FAIL=true (SetQueueAttributes rejects it).
    // Depends on Marker so the Marker update COMPLETES before this fails.
    const revertQueue = new sqs.CfnQueue(this, 'RevertQueue', {
      queueName: `${this.stackName}-revert-queue`,
      messageRetentionPeriod: process.env.INJECT_UPDATE_FAIL === 'true' ? 9999999 : 3600,
    });
    revertQueue.node.addDependency(marker);
    deps.push(revertQueue);

    if (process.env.WITH_EXTRA === 'true') {
      const extra = new ssm.StringParameter(this, 'Extra', {
        parameterName: `${this.stackName}-extra`,
        stringValue: 'created-in-v2',
        description: 'CREATE-rollback target for the cdkd rollback integ',
      });
      deps.push(extra);
    }

    if (process.env.INJECT_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      for (const d of deps) failing.node.addDependency(d);
    }

    new cdk.CfnOutput(this, 'MarkerName', { value: marker.parameterName });
  }
}

/**
 * Minimal first-ever-deploy fixture: a single SSM parameter plus the injected
 * failure. Deployed for the first time with `--no-rollback` so its journal
 * segment carries `initialDeploy: true` — `cdkd rollback` deletes the created
 * parameter AND removes `state.json` entirely.
 */
export class RollbackInitialStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-command');

    const marker = new ssm.StringParameter(this, 'InitMarker', {
      parameterName: `${this.stackName}-marker`,
      stringValue: 'initial',
      description: 'initialDeploy-path target for the cdkd rollback integ',
    });

    if (process.env.INJECT_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(marker);
    }
  }
}
