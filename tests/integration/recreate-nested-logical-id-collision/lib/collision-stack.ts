import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ fixture for issue
 * [#2567](https://github.com/go-to-k/cdkd/issues/2567) — a
 * `--recreate-via-cc-api` / `--recreate-via-sdk-provider` target applies ONLY
 * to the stack whose template, state and live emptiness the CLI pre-flight
 * validated it against.
 *
 * THE COLLISION IS THE FIXTURE. The parent and the nested child both declare a
 * resource whose logical id is `SharedTarget` — the natural spelling, since
 * both use the same construct id and CDK derives a top-level L1's logical id
 * from it. That is the shape the issue names (the same construct id in both
 * stacks; an `overrideLogicalId` produces it too).
 *
 *   - PARENT `SharedTarget` — `AWS::Lambda::Function`, STATELESS, so
 *     `--recreate-via-cc-api SharedTarget` clears the pre-flight with no
 *     `--force-stateful-recreation`. This is the resource the user actually
 *     names.
 *   - CHILD `SharedTarget` — `AWS::S3::Bucket`, STATEFUL, and `verify.sh`
 *     seeds an object into it before the flagged deploy. This is the resource
 *     nobody named. Pre-fix the inherited id set matched it in the child
 *     engine, `recreateFlagged` skipped the mid-deploy stateful guard (whose
 *     whole justification is "the pre-flight already validated this target"),
 *     and the bucket was DELETE + CREATEd with neither check having looked at
 *     it.
 *   - CHILD `ChildOnlyParam` — an SSM parameter that exists ONLY in the child.
 *     It pins the other half of the contract: a genuinely nested target is
 *     refused at pre-flight, because the parent's template does not declare
 *     it. That refusal predates #2567 — it is why scoping the target set
 *     removes no capability.
 *
 * `CDKD_TEST_UPDATE` must contain `updated` for the second and later deploys:
 * the recreate flag only acts inside the engine's `case 'UPDATE'`, so BOTH
 * `SharedTarget` resources need a real property change in that deploy or the
 * run is vacuous — the child's bucket would never be visited at all. Only
 * property changes are gated (a Lambda `Description`, a bucket `Tags` entry);
 * no resource appears or disappears with the mode, so no later deploy can
 * delete one by omitting the token.
 *
 * The child's bucket carries no `autoDeleteObjects` custom resource on
 * purpose: cdkd's CloudFormation-parity data guard refuses to delete a bucket
 * holding objects unless CDK's `aws-cdk:auto-delete-objects` tag is present,
 * and `verify.sh` empties the bucket itself before the destroy. A custom
 * resource would also be a second confound for the `provisionedBy`
 * assertions.
 */

/** True when this synth is the post-baseline ("updated") shape. */
function isUpdated(): boolean {
  return (process.env['CDKD_TEST_UPDATE'] ?? '')
    .split(',')
    .map((token) => token.trim())
    .includes('updated');
}

class CollisionChildStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);

    // Pin the AWS::CloudFormation::Stack logical id so the cdkd state key is
    // the documented `<parent>~Child` shape rather than CDK's hashed
    // compound. Per memory rule
    // `feedback_cdk_nested_stack_overridelogical_id.md` + issue #575.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    // THE COLLIDING ID. Same construct id as the parent's Lambda, so both
    // templates declare a `SharedTarget`.
    //
    // The name carries `Aws.ACCOUNT_ID` because bucket names are globally
    // unique; it is resolved by the CHILD engine's intrinsic resolver, which
    // is a full DeployEngine and resolves `AWS::AccountId` exactly as the
    // parent's does.
    const bucket = new s3.CfnBucket(this, 'SharedTarget', {
      bucketName: `cdkd-recreate-nested-collision-${cdk.Aws.ACCOUNT_ID}`,
      // The child's property change for the flagged deploy. In-place
      // updatable (`Tags` is in the S3 provider's handledProperties), so
      // nothing about the child's own diff can drive a replacement — the ONLY
      // thing that could DELETE this bucket in that deploy is the inherited
      // recreate flag matching here, which is exactly what the fixture
      // measures.
      ...(isUpdated() ? { tags: [{ key: 'Phase', value: 'two' }] } : {}),
    });
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // A logical id that exists ONLY in the child — the "genuinely nested
    // target" a user might try to name.
    const childOnly = new ssm.CfnParameter(this, 'ChildOnlyParam', {
      type: 'String',
      name: '/cdkd/recreate-nested-collision/child-only',
      value: 'child-only',
      description: 'cdkd #2567 integ - a resource declared only in the nested child',
    });
    childOnly.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}

export class RecreateNestedCollisionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'FnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // THE NAMED TARGET. Stateless, so `--recreate-via-cc-api SharedTarget`
    // needs no `--force-stateful-recreation` — the flag the user passes says
    // nothing about data loss, which is the point: pre-fix a stateful bucket
    // in the child was recreated under that same consent-free flag.
    const fn = new lambda.CfnFunction(this, 'SharedTarget', {
      functionName: 'cdkd-recreate-nested-collision-fn',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.roleArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd 2567 probe"}',
        ].join('\n'),
      },
      // The parent's property change for the flagged deploy (see the mode
      // note in the file header).
      description: isUpdated()
        ? 'cdkd #2567 integ - phase two'
        : 'cdkd #2567 integ - phase one',
    });
    fn.addDependency(role.node.defaultChild as cdk.CfnElement);

    new CollisionChildStack(this, 'Child');
  }
}
