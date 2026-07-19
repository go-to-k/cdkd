import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ probe for `cdkd import` persisting provider-returned `attributes`
 * into state (issue #1098, PR #1099).
 *
 * Pre-fix, `buildStackState` in src/cli/commands/import.ts hardcoded
 * `attributes: {}` on every imported resource row, so whatever a provider's
 * `import()` returned in its `attributes` map was computed and then dropped.
 * Since `attributes` is what backs `Fn::GetAtt` resolution against state, an
 * adopted resource started life with an empty attribute map while the same
 * resource created by `cdkd deploy` had it populated.
 *
 * The single resource here is an `AWS::IAM::ManagedPolicy` because
 * `IAMManagedPolicyProvider.import()` (src/provisioning/providers/
 * iam-managed-policy-provider.ts) returns a NON-EMPTY attribute map —
 * `{ physicalId: <arn>, attributes: { PolicyArn: <arn> } }` — on the
 * explicit-ARN branch that `--resource Policy=<arn>` drives. That makes the
 * post-import `attributes.PolicyArn` assertion in verify.sh a direct
 * discriminator between fixed and pre-fix cdkd: pre-fix it is absent
 * (attributes is `{}`), post-fix it carries the policy ARN.
 *
 * Contrast with the existing `import-nested-stack` fixture, whose only leaf
 * type is `AWS::SSM::Parameter` — that provider's `import()` returns
 * `attributes: {}`, so the fixture passes identically with and without the
 * fix and cannot cover this path.
 *
 * A customer-managed policy is free and both creates and deletes instantly,
 * and nothing is attached to it, so `DeletePolicy` needs no prior detach.
 * The name is pinned so verify.sh can derive the ARN deterministically for
 * both the import override and the cleanup trap (which must be able to reach
 * the resource during the window where it is live on AWS but no longer in
 * cdkd state).
 */
export class ImportAttributesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const policy = new iam.ManagedPolicy(this, 'Policy', {
      managedPolicyName: 'cdkd-import-attributes-example-policy',
      description: 'cdkd integ probe for import attribute persistence (issue #1098)',
      statements: [
        // Deliberately inert: a read-only allow scoped to a bucket that does
        // not exist. The policy is never attached to any principal.
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: ['arn:aws:s3:::cdkd-import-attributes-example-nonexistent/*'],
        }),
      ],
    });

    // Pin the logical id so verify.sh can pass `--resource Policy=<arn>` and
    // index into `state.resources.Policy` without parsing a CDK-generated
    // hash suffix.
    (policy.node.defaultChild as iam.CfnManagedPolicy).overrideLogicalId('Policy');

    new cdk.CfnOutput(this, 'PolicyArn', { value: policy.managedPolicyArn });
  }
}
