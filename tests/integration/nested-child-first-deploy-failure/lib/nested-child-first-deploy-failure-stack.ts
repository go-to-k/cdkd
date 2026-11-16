import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export interface FailingChildParentStackProps extends cdk.StackProps {
  /** Whether the parent holds an SSM parameter of its own. */
  parentResource: boolean;
}

/**
 * go-to-k/cdkd#6396: a nested child whose FIRST deploy fails rolls back to an
 * empty record, while the parent's row records no physical id, so the
 * parent's destroy used to leave the child's state.json and rollback journal
 * behind. The child creates an SSM parameter, then fails on an SQS queue whose
 * `MessageRetentionPeriod` is out of range (SQS refuses 59 seconds), which
 * fails the same way on every run.
 */
export class FailingChildParentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FailingChildParentStackProps) {
    super(scope, id, props);
    if (props.parentResource) {
      new ssm.StringParameter(this, 'ParentParam', {
        parameterName: `/cdkd-integ/${id}/parent`,
        stringValue: 'parent',
      });
    }
    const child = new cdk.NestedStack(this, 'Child');
    const param = new ssm.StringParameter(child, 'ChildParam', {
      parameterName: `/cdkd-integ/${id}/child`,
      stringValue: 'child',
    });
    const queue = new sqs.CfnQueue(child, 'BadQueue', { messageRetentionPeriod: 59 });
    // After the parameter, so the child has something to roll back.
    queue.addDependency(param.node.defaultChild as cdk.CfnResource);
  }
}
