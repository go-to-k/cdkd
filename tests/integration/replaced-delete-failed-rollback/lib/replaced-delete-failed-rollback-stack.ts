import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#2631: a replacement whose delete of the OLD resource fails,
 * followed by a failure later in the same deploy, is rolled back WITHOUT
 * re-creating the old resource while it is still alive.
 *
 * - `Target` is a managed policy whose `ManagedPolicyName` (create-only) is
 *   `cdkd-rdfr-target-${TARGET_SUFFIX ?? 'a'}`, so `TARGET_SUFFIX=b` replaces
 *   it: the new policy is created first, then the old one's delete runs.
 * - `BREAK=true` adds `Breaker`, a managed policy that depends on `Target`.
 *
 * verify.sh deploys `TARGET_SUFFIX=b BREAK=true` as a role that may not
 * delete `cdkd-rdfr-target-a` nor create `cdkd-rdfr-breaker`: the old
 * policy's delete is refused, and `Breaker`'s create then fails the deploy
 * before the post-deploy retry of that delete (go-to-k/cdkd#4900). The
 * automatic rollback must find the old policy alive and re-adopt it, not
 * re-create it (which collides on its name).
 *
 * L1 resources with explicit names, on the SDK route.
 *
 * covers: AWS::IAM::ManagedPolicy
 */
export class ReplacedDeleteFailedRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const document = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: 'logs:CreateLogGroup', Resource: '*' }],
    };

    const target = new iam.CfnManagedPolicy(this, 'Target', {
      managedPolicyName: `cdkd-rdfr-target-${process.env.TARGET_SUFFIX ?? 'a'}`,
      policyDocument: document,
    });

    if (process.env.BREAK === 'true') {
      const breaker = new iam.CfnManagedPolicy(this, 'Breaker', {
        managedPolicyName: 'cdkd-rdfr-breaker',
        policyDocument: document,
      });
      breaker.addDependency(target);
    }
  }
}
