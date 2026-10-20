import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';

export const STACK_NAME = 'CdkdDestroyNestedXregionExample';
/** The stack's region. verify.sh runs the destroys with AWS_REGION=us-east-1. */
export const STACK_REGION = 'us-west-2';
/** Explicit, so a same-named sentinel can sit in the CLI's region. */
export const CHILD_STREAM_NAME = `${STACK_NAME}-child-stream`;
/** The parent's Cloud Control-routed resource (go-to-k/cdkd#5115). */
export const PARENT_API_NAME = `${STACK_NAME}-api`;

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
 * The parent also holds a REST API, a type cdkd routes through Cloud Control:
 * the registry's Cloud Control fallback is built in its constructor, so a
 * registry built outside the stack's AWS scope deletes it with a CLI-region
 * client, which the region check refuses (go-to-k/cdkd#5115).
 *
 * covers: AWS::ApiGateway::RestApi
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::Kinesis::Stream
 */
export class CdkdDestroyNestedXregionExample extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    new apigateway.CfnRestApi(this, 'Api', { name: PARENT_API_NAME });
    new ChildNestedStack(this, 'Child');
  }
}
