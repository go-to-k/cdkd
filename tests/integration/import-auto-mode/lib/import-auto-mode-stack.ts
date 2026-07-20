import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ probe for `cdkd import` AUTO mode (issue #1128).
 *
 * Auto mode resolves each resource's physical id in stages: the template's own
 * name property first, then an `aws:cdk:path` tag walk, and (since #1128) a
 * CloudFormation `DescribeStackResources` lookup. The tag stage CANNOT match on
 * real AWS — AWS rejects any `aws:`-prefixed tag write ("Tag keys beginning
 * with aws: are reserved for system use") and CloudFormation keeps the value in
 * the template's resource `Metadata` without ever promoting it to a tag.
 *
 * That made auto mode fail for any resource whose physical name CloudFormation
 * generated, which is the usual CDK shape. It survived four rounds of
 * `importTagWalk` work (#1091) because BOTH existing import integs bypass the
 * path: `import-attributes` passes `--resource`, `import-nested-stack` passes
 * `--migrate-from-cloudformation`.
 *
 * The load-bearing property of this fixture is therefore what it does NOT do:
 *
 *   - it does NOT set an explicit physical name (no `managedPolicyName`), so
 *     the name stage cannot resolve it and the resource can ONLY be found via
 *     the CloudFormation lookup;
 *   - `verify.sh` does NOT pass `--resource` or
 *     `--migrate-from-cloudformation`, so nothing short-circuits the path
 *     under test.
 *
 * Adding a physical name here, or an override flag there, would silently
 * restore the green-but-untested state this fixture exists to end.
 *
 * `AWS::IAM::ManagedPolicy` is the resource because it is free, fast, has no
 * VPC/NAT dependency, and deletes cleanly with no recovery window.
 */
export class ImportAutoModeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // NOTE: no `managedPolicyName`. CloudFormation generates
    // `<Stack>-Policy-<suffix>`, which is exactly the shape that used to come
    // back as `not found`.
    const policy = new iam.ManagedPolicy(this, 'Policy', {
      description: 'cdkd import auto-mode integ probe (issue #1128)',
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:ListAllMyBuckets'],
          resources: ['*'],
        }),
      ],
    });

    new cdk.CfnOutput(this, 'PolicyArn', {
      value: policy.managedPolicyArn,
      description: 'ARN of the probe policy (CloudFormation-generated name)',
    });
  }
}
