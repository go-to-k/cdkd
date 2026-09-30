import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ probe for the IAM Role sibling-policy phantom-drift bug.
 *
 * CDK emits a construct's grants as a SEPARATE `AWS::IAM::Policy` resource
 * (the `Default Policy*`) attached to the role via `Roles: [role]`, NOT as an
 * inline `Policies` entry on the role itself. AWS implements that via
 * `iam:PutRolePolicy`, so the inline policy shows up in `ListRolePolicies`.
 *
 * Before the fix, the deploy-time `observedProperties` capture for the role
 * passed NO sibling context, so the `ListRolePolicies` read RACED the
 * sibling policy's `PutRolePolicy`. When the read landed after the write, the
 * sibling-managed `DefaultPolicy*` leaked into `observedProperties.Policies`.
 * A later `cdkd drift` (whose AWS-current side correctly filters
 * sibling-managed inline policies) then reported phantom drift on the role:
 *   `- Policies:[{...DefaultPolicy...}]  + Policies:[]`
 * This fires for essentially every Lambda / L2 construct that has a grant —
 * one of the most common CDK patterns.
 *
 * This fixture exercises both shapes the bug touches:
 *   - A Lambda whose grant emits a service-role `Default Policy` sibling.
 *   - A standalone `iam.Role` with `addToPolicy(...)` (also a sibling Policy)
 *     AND an explicitly-declared inline policy (so the role's own `Policies`
 *     are non-empty), to prove the filter excludes only the sibling-managed
 *     name and keeps the declared one.
 *
 * verify.sh deploys this, runs `cdkd drift`, and asserts NO drift on any
 * `AWS::IAM::Role`. A RENAME phase then renames `RenamedPolicy` in place and
 * asserts the role holds only the NEW-named policy (go-to-k/cdkd#4152). A
 * HAND-OFF phase then moves inline policy names between resources on the same
 * role in one deploy, and asserts the receiving resource keeps each name
 * (go-to-k/cdkd#4156).
 */
export class IamRolePoliciesDriftCleanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const queue = new sqs.Queue(this, 'Queue', {
      queueName: 'cdkd-iam-drift-clean-test-queue',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda with a grant -> its service role gets a `Default Policy` sibling
    // AWS::IAM::Policy (the canonical phantom-drift trigger).
    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-iam-drift-clean-test-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200, body: "ok" });'
      ),
    });
    queue.grantSendMessages(fn);

    // Standalone role with BOTH an explicitly-declared inline policy and an
    // addToPolicy()-emitted sibling Default Policy. The role's own `Policies`
    // is non-empty, so this proves the capture filter excludes only the
    // sibling-managed name (not the declared inline policy).
    // go-to-k/cdkd#4156: the HAND-OFF phase (CDKD_TEST_HANDOFF=true, deployed
    // with CDKD_TEST_RENAME=true) moves inline policy names between resources
    // on this role in ONE deploy. Each resource's document carries its own
    // action, so verify.sh can tell WHOSE policy holds a name. Fixed names.
    const handoff = process.env.CDKD_TEST_HANDOFF === 'true';
    const doc = (action: string): iam.PolicyDocument =>
      new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({ actions: [action], resources: [queue.queueArn] })],
      });
    const role = new iam.Role(this, 'WorkerRole', {
      roleName: 'cdkd-iam-drift-clean-test-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        DeclaredInline: doc('sqs:GetQueueAttributes'),
        // Hand-off 3: the role's own Policies takes the name ToRolePolicy
        // renames away from. ToRolePolicy names the role by Ref, so the role
        // updates (puts the name) BEFORE the policy's rename would remove it.
        ...(handoff ? { 'cdkd-iam-drift-clean-to-role': doc('sqs:ReceiveMessage') } : {}),
      },
    });
    // This addToPolicy lands in a SEPARATE AWS::IAM::Policy (Default Policy).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [queue.queueArn],
      })
    );

    // go-to-k/cdkd#4152: a standalone inline policy on the SAME role, renamed
    // in place by the RENAME phase (CDKD_TEST_RENAME=true). The role stays
    // listed across the rename, which is the principal that used to keep the
    // OLD-named policy. Fixed names, so verify.sh reads each back exactly.
    const renamed = process.env.CDKD_TEST_RENAME === 'true';
    new iam.CfnPolicy(this, 'RenamedPolicy', {
      policyName: renamed
        ? 'cdkd-iam-drift-clean-renamed-new'
        : 'cdkd-iam-drift-clean-renamed-old',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'sqs:GetQueueUrl', Resource: queue.queueArn }],
      },
      roles: [role.roleName],
    });

    const inlinePolicy = (id: string, policyName: string, action: string): iam.CfnPolicy =>
      new iam.CfnPolicy(this, id, {
        policyName,
        policyDocument: doc(action),
        roles: [role.roleName],
      });
    // Hand-off 1: two policies SWAP names. SwapB depends on SwapA, so SwapA
    // renames first; before the fix SwapB's rename then removed the name
    // SwapA had just taken.
    const swapA = inlinePolicy(
      'SwapA',
      handoff ? 'cdkd-iam-drift-clean-swap-y' : 'cdkd-iam-drift-clean-swap-x',
      'sqs:ListQueueTags'
    );
    inlinePolicy(
      'SwapB',
      handoff ? 'cdkd-iam-drift-clean-swap-x' : 'cdkd-iam-drift-clean-swap-y',
      'sqs:ListDeadLetterSourceQueues'
    ).addDependency(swapA);
    // Hand-off 2: a policy is dropped while a NEW one takes its name. The
    // deploy deletes after every create, so before the fix the delete removed
    // the name the create had just put.
    if (handoff) {
      inlinePolicy('HandoffNew', 'cdkd-iam-drift-clean-handoff', 'sqs:DeleteMessage');
    } else {
      inlinePolicy('HandoffOld', 'cdkd-iam-drift-clean-handoff', 'sqs:ChangeMessageVisibility');
    }
    inlinePolicy(
      'ToRolePolicy',
      handoff ? 'cdkd-iam-drift-clean-to-role-moved' : 'cdkd-iam-drift-clean-to-role',
      'sqs:PurgeQueue'
    );

    new cdk.CfnOutput(this, 'FnName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'WorkerRoleName', { value: role.roleName });
  }
}
