import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
 *   - `SkipBucket` + `SkipDoomed` — added ONLY when `WITH_SKIP_PAIR=true`
 *     (go-to-k/cdkd#3338). Removing the pair from the template makes the
 *     deploy DELETE both: `SkipDoomed` (an SSM parameter) first, since it
 *     depends on the bucket, then `SkipBucket`, which verify.sh has put an
 *     object into and which has no `autoDeleteObjects`, so its delete FAILS.
 *     The automatic rollback then meets a COMPLETED DELETE it cannot undo — a
 *     skipped op — which must be recorded as an event and keep the journal.
 *   - `OrphanStream` — a Kinesis stream added ONLY when
 *     `INJECT_ORPHAN_CREATE=true` (go-to-k/cdkd#1710). `CreateStream`
 *     succeeds, then the retention follow-up is rejected, so the CREATE fails
 *     with the stream already in AWS and no state record. The journal must
 *     carry its physical id so every rollback path and `cdkd destroy` delete it
 *     (go-to-k/cdkd#4584); `ORPHAN_RETAIN=true` gives it `DeletionPolicy: Retain`.
 *   - `ReplaceStream` — a Kinesis stream added ONLY when
 *     `WITH_REPLACE_STREAM=true` (go-to-k/cdkd#4604). A `REPLACE_STREAM_SUFFIX`
 *     flip replaces it, and `REPLACE_STREAM_FAIL=true` makes the NEW stream's
 *     retention follow-up fail after `CreateStream`: the journal must name the
 *     new stream beside the replacement's UPDATE so every rollback path
 *     deletes it, leaving the old stream and its state record intact.
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

    if (process.env.INJECT_ORPHAN_CREATE === 'true') {
      // go-to-k/cdkd#1710: a create that SUCCEEDS at AWS and then fails.
      // `CreateStream` accepts the stream; the follow-up
      // `IncreaseStreamRetentionPeriod` rejects 9000 hours (AWS's maximum is
      // 8760), which cdkd does not pre-flight. The L1 is used because the L2
      // `Stream` refuses the value at synth. Marker is unchanged in this phase,
      // so the segment is failed-only, the shape a lone failed create leaves.
      // go-to-k/cdkd#4600: ORPHAN_FIX_FORWARD is the fix-forward — the same
      // logical id under another name with a valid retention, so the CREATE
      // succeeds and the earlier failed attempt's stream is the orphan.
      const fixForward = process.env.ORPHAN_FIX_FORWARD === 'true';
      const orphanStream = new kinesis.CfnStream(this, 'OrphanStream', {
        name: `${this.stackName}-orphan-stream${fixForward ? '-b' : ''}`,
        shardCount: 1,
        retentionPeriodHours: fixForward ? 24 : 9000,
      });
      // go-to-k/cdkd#4584: the Retain arm — every rollback path, and a later
      // successful deploy (go-to-k/cdkd#4600), keeps the stream in AWS
      // instead of deleting it.
      if (process.env.ORPHAN_RETAIN === 'true') {
        orphanStream.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      }
    }

    if (process.env.WITH_REPLACE_STREAM === 'true') {
      // go-to-k/cdkd#4604: a REPLACEMENT whose new resource is created and then
      // fails. The create-only `Name` changes with REPLACE_STREAM_SUFFIX, so
      // the suffix flip replaces the stream (create-first: the new name
      // differs); REPLACE_STREAM_FAIL gives the NEW stream 9000 hours, which
      // `IncreaseStreamRetentionPeriod` rejects after `CreateStream` returned.
      // The journal must carry the new stream so every rollback path deletes
      // it while the old stream, still in state, stays intact.
      const replaceStream = new kinesis.CfnStream(this, 'ReplaceStream', {
        name: `${this.stackName}-replace-stream-${process.env.REPLACE_STREAM_SUFFIX ?? 'a'}`,
        shardCount: 1,
        retentionPeriodHours: process.env.REPLACE_STREAM_FAIL === 'true' ? 9000 : 24,
      });
      // An explicit `DeletionPolicy: Delete`, which the journal must carry.
      replaceStream.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    if (process.env.WITH_SKIP_PAIR === 'true') {
      // DESTROY so the template's removal is a real DELETE (s3.Bucket defaults
      // to RETAIN), and no autoDeleteObjects so a non-empty bucket refuses it.
      const skipBucket = new s3.Bucket(this, 'SkipBucket', {
        bucketName: `${this.stackName.toLowerCase()}-skip-${this.account}-${this.region}`,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const doomed = new ssm.StringParameter(this, 'SkipDoomed', {
        parameterName: `${this.stackName}-skip-doomed`,
        stringValue: 'deleted-then-unrecoverable',
        description: 'completed-DELETE (unrecoverable) target for the cdkd rollback integ',
      });
      // A dependent is deleted BEFORE its dependency: SkipDoomed's delete
      // completes, then SkipBucket's fails.
      doomed.node.addDependency(skipBucket);
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
