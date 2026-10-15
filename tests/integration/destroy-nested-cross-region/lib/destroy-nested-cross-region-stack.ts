import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';

export const STACK_NAME = 'CdkdDestroyNestedXregionExample';
/** The stack's region. verify.sh runs the destroys with AWS_REGION=us-east-1. */
export const STACK_REGION = 'us-west-2';
/** Explicit, so a same-named sentinel can sit in the CLI's region. */
export const CHILD_STREAM_NAME = `${STACK_NAME}-child-stream`;

/**
 * The nested child. Its only resource is an explicitly named Kinesis stream:
 * the Kinesis provider captures `ambientRegion()` when it is constructed, so
 * a child destroyed with a provider built in the CLI's region deletes the
 * same-named stream THERE (go-to-k/cdkd#4941).
 */
class ChildNestedStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);
    // `<parent>~Child` as the child's state key (issue #575).
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');
    new kinesis.Stream(this, 'Stream', {
      streamName: CHILD_STREAM_NAME,
      shardCount: 1,
      streamMode: kinesis.StreamMode.PROVISIONED,
      encryption: kinesis.StreamEncryption.UNENCRYPTED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}

/**
 * A stack pinned to us-west-2 whose nested child holds a named Kinesis stream,
 * destroyed by `cdkd destroy` and `cdkd state destroy` from a shell whose
 * region is us-east-1 (go-to-k/cdkd#4941).
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::Kinesis::Stream
 */
export class CdkdDestroyNestedXregionExample extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    new ChildNestedStack(this, 'Child');
  }
}
