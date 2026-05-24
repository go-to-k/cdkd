import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Issue #464 — `cdkd import --migrate-from-cloudformation` recursive
 * nested-stack adoption end-to-end integ.
 *
 * Covers `AWS::CloudFormation::Stack` (nested-stack adoption literal —
 * picked up by `scripts/build-integ-coverage-matrix.ts` so this fixture
 * is attributed for the type, closing the existing orphan gap).
 *
 * Shape: one `cdk.Stack` parent containing one `cdk.NestedStack` child.
 * Both stacks carry one `AWS::SSM::Parameter` each (cheap, fast,
 * region-agnostic). The child's parameter is exposed as a nested-stack
 * Output so the parent can reference it via
 * `Fn::GetAtt: [Child, 'Outputs.<key>']` — exercising the same
 * cross-stack-boundary `Ref` shape `NestedStackProvider` resolves at
 * deploy time, so post-import the parent's state has a clean reference
 * to the child's synth ARN.
 *
 * Test flow (see verify.sh):
 *   1. `cdk deploy` parent + child (NOT cdkd — simulates an
 *      already-existing CloudFormation-managed stack).
 *   2. Run `cdkd import --migrate-from-cloudformation <ParentName>`.
 *   3. Assert state files written at v6 keys
 *      (`cdkd/<Parent>/<region>/state.json` AND
 *      `cdkd/<Parent>~<ChildLogicalId>/<region>/state.json`),
 *      with `parentStack` / `parentLogicalId` / `parentRegion` populated
 *      on the child.
 *   4. `cdkd destroy <Parent>` — should cascade-delete both stacks
 *      via `NestedStackProvider.delete`.
 *   5. Assert both source CFn stacks are gone AND both SSM parameters
 *      are gone (no orphan AWS resources).
 */
class ChildNestedStack extends cdk.NestedStack {
  /** Child SSM parameter — exposed via the auto-generated CFn Output below. */
  public readonly param: ssm.StringParameter;

  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);
    this.param = new ssm.StringParameter(this, 'ChildParam', {
      stringValue: 'child-nested-value',
      description: 'cdkd #464 integ - SSM parameter inside the nested child',
    });
    // Override CDK's auto-generated hash suffix so verify.sh's assertions
    // pin the logical id directly.
    (this.param.node.defaultChild as cdk.CfnResource).overrideLogicalId('ChildParam');
  }
}

export class ImportNestedStackExample extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const child = new ChildNestedStack(this, 'Child');
    // Override CDK's auto-generated logical id
    // (`ChildNestedStackChildNestedStackResourceC40294CA` style) to a
    // stable `Child` so the verify.sh assertions can pin both the AWS
    // tree row AND the cdkd state-key shape
    // (`cdkd/<parent>~Child/<region>/state.json`) without parsing the
    // hash suffix.
    if (child.nestedStackResource) {
      (child.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');
    }

    // Parent-side parameter that references the child's parameter name
    // via `Fn::GetAtt: [Child.NestedStackResource, 'Outputs.<key>']`.
    // CDK auto-synthesizes the GetAtt + the matching child Output when
    // a parent construct references an attribute of a NestedStack child.
    const parentParam = new ssm.StringParameter(this, 'ParentParam', {
      stringValue: child.param.parameterName,
      description: 'cdkd #464 integ - parent SSM parameter referencing the child param name',
    });
    (parentParam.node.defaultChild as cdk.CfnResource).overrideLogicalId('ParentParam');
  }
}
