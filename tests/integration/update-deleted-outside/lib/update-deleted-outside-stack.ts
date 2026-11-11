import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6106: an UPDATE of a resource deleted outside cdkd fails on
 * AWS's not-found. The deploy must name the resource as deleted outside cdkd
 * and keep no `--revert-failed` record, which could never succeed.
 *
 * `CDKD_TEST_UPDATE` (comma-separated modes):
 *   - unset:   Target (VisibilityTimeout 30) and Survivor.
 *   - update:  Target's VisibilityTimeout 30 -> 60 (the update that fails once
 *              verify.sh has deleted Target out of band, and the restore step).
 *   - removed: Target leaves the app (the printed remedy's first deploy).
 * Survivor never changes: the deploy's other resource, untouched throughout.
 */
export class UpdateDeletedOutsideStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const modes = new Set((process.env['CDKD_TEST_UPDATE'] ?? '').split(',').filter(Boolean));

    if (!modes.has('removed')) {
      const target = new sqs.Queue(this, 'Target', {
        visibilityTimeout: cdk.Duration.seconds(modes.has('update') ? 60 : 30),
      });
      // Fixed logical ids: verify.sh reads the records and greps the lines by them.
      (target.node.defaultChild as sqs.CfnQueue).overrideLogicalId('Target');
    }
    const survivor = new sqs.Queue(this, 'Survivor');
    (survivor.node.defaultChild as sqs.CfnQueue).overrideLogicalId('Survivor');
  }
}
