import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Integ probe for issue #3645: `cdkd import` wrote records without the
 * template's `DeletionPolicy` / `UpdateReplacePolicy`, and `cdkd destroy`
 * reads the policy from STATE only, so a destroy run before the first deploy
 * DELETED a `Retain` resource.
 *
 * `Kept` declares `DeletionPolicy: Retain` and must survive the destroy;
 * `Gone` declares nothing and must be deleted, which shows the destroy really
 * ran over both records.
 */
export class ImportRetainDestroyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const kept = new ssm.StringParameter(this, 'Kept', { stringValue: 'retained' });
    kept.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    (kept.node.defaultChild as cdk.CfnResource).overrideLogicalId('Kept');

    const gone = new ssm.StringParameter(this, 'Gone', { stringValue: 'deleted' });
    (gone.node.defaultChild as cdk.CfnResource).overrideLogicalId('Gone');
  }
}

/**
 * Integ probe for go-to-k/cdkd#4523: a rollback journal kept from a failed
 * deploy holds a completed CREATE of `Named`, whose explicit name is its
 * physical id. Once `cdkd import` adopts the name under the same logical id,
 * a later `cdkd rollback` must leave the imported parameter alone.
 *
 * `INJECT_FAIL=true` adds `FailingQueue`, which `CreateQueue` rejects (its
 * retention period is out of range) after `Named` completes, so the first
 * deploy under `--no-rollback` keeps a journal whose CREATE of `Named` is the
 * op a pre-fix replay deletes.
 */
export class ImportRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const named = new ssm.CfnParameter(this, 'Named', {
      name: `${this.stackName}-named`,
      type: 'String',
      value: 'adopted',
    });
    named.overrideLogicalId('Named');

    if (process.env.INJECT_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.addDependency(named);
    }
  }
}
