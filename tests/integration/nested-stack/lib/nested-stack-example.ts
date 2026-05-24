import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Nested stack containing exactly 3 resources — covers the main PR's
 * verification surface for issue #459:
 *
 *  1. S3 Bucket — exercises the `Bucket.bucketName` attribute path, which
 *     CDK lifts into the nested stack's `Outputs` so the parent can
 *     reference it via `Fn::GetAtt: [Child, 'Outputs.<key>']`.
 *  2. IAM Role — exercises a no-deps-on-output resource to verify the
 *     child's DAG independently completes its non-output resources.
 *  3. SSM Parameter — exercises a third resource whose physical name is
 *     scoped under the nested stack's namespace, so an accidental name
 *     collision with the parent's parameter would surface as a CFn-side
 *     conflict (and validates cdkd's `<parent>~<child>` state-key split).
 */
class ChildNestedStack extends cdk.NestedStack {
  /** S3 bucket exposed as a nested-stack Output for the parent to consume. */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);

    // Pin the AWS::CloudFormation::Stack logical id so the cdkd state key
    // (`<parent>~<logicalId>`) matches the README's documented `~Child`
    // shape instead of the CDK auto-generated `~<Name>NestedStack<Name>
    // NestedStackResource<hash>` compound. See memory rule
    // `feedback_cdk_nested_stack_overridelogical_id.md` + issue #575.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    this.bucket = new s3.Bucket(this, 'Bucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'cdkd nested-stack integ - IAM role under the child',
    });

    new ssm.StringParameter(this, 'Param', {
      stringValue: 'child-nested-value',
      description: 'cdkd nested-stack integ - SSM parameter under the child',
    });
  }
}

/**
 * Top-level stack containing 1 nested stack plus 1 own resource that
 * references the child's output. Exercises end-to-end:
 *
 *  - cdkd reads parent template + nested template via AssemblyReader.
 *  - DAG builder treats `Child` as a single node; the parent's own
 *    SSM Parameter has an edge to it via `Fn::GetAtt: [Child, 'Outputs.<key>']`.
 *  - NestedStackProvider recursively dispatches a child DeployEngine.
 *  - On destroy, the parent's reverse-DAG visits its own resource first,
 *    then the nested stack's delete walk teardowns the child's three
 *    resources in reverse-DAG order.
 */
export class NestedStackExample extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const child = new ChildNestedStack(this, 'Child');

    // Parent-side resource that pulls a value out of the child via
    // `Fn::GetAtt: [Child.NestedStackResource, 'Outputs.<key>']`. CDK
    // synthesizes the GetAtt automatically when we reference an attribute
    // of a construct that lives inside a NestedStack.
    new ssm.StringParameter(this, 'ParentReferenceToChildBucket', {
      stringValue: child.bucket.bucketName,
      description:
        'cdkd nested-stack integ - parent SSM parameter that references the child bucket name (verifies Fn::GetAtt across the nested stack boundary)',
    });
  }
}
