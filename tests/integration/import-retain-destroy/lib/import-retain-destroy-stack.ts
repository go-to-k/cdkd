import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

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
