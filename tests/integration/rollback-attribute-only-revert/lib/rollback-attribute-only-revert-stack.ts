import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * go-to-k/cdkd#6101: a deploy that changes only a resource's `DeletionPolicy` /
 * `UpdateReplacePolicy` and then fails on another resource must roll the
 * policies back too, as CloudFormation's rollback does.
 *
 * covers: AWS::SSM::Parameter
 *
 * Generation 1 (CDKD_TEST_UPDATE unset):
 *   - `Kept`: RemovalPolicy RETAIN (DeletionPolicy / UpdateReplacePolicy Retain)
 *   - `Dropped`: RemovalPolicy DESTROY (Delete / Delete)
 *
 * Generation 2 (CDKD_TEST_UPDATE=true): the two policies swap, properties stay
 * the same, so both are metadata-only updates. A queue with an out-of-range
 * `MessageRetentionPeriod` (valid range [60, 1209600]) is added; AWS rejects
 * CreateQueue every time. It depends on both parameters, so both updates have
 * completed before its create is sent.
 */
export class RollbackAttributeOnlyRevertStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const flipped = process.env.CDKD_TEST_UPDATE === 'true';

    const kept = new ssm.StringParameter(this, 'Kept', {
      parameterName: `/${this.stackName}/kept`,
      stringValue: 'kept',
    });
    kept.applyRemovalPolicy(flipped ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN);

    const dropped = new ssm.StringParameter(this, 'Dropped', {
      parameterName: `/${this.stackName}/dropped`,
      stringValue: 'dropped',
    });
    dropped.applyRemovalPolicy(flipped ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY);

    if (flipped) {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(kept);
      failing.node.addDependency(dropped);
    }
  }
}
