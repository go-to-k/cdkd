import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Issue #464 PR B2 — `cdkd export` recursive nested-stack adoption
 * (per-stack IMPORT loop per design doc §4.3) end-to-end integ.
 *
 * Covers `AWS::CloudFormation::Stack` (nested-stack export literal —
 * picked up by `scripts/build-integ-coverage-matrix.ts` so this fixture
 * is attributed for the type's export-side coverage).
 *
 * Shape: one `cdk.Stack` parent containing one `cdk.NestedStack` child.
 * Both stacks carry one `AWS::SSM::Parameter` each (cheap, fast,
 * region-agnostic, no cross-stack consumer plumbing needed).
 *
 * Test flow (see verify.sh):
 *   1. `cdkd deploy` parent + child (NOT `cdk deploy` — PR B2 exercises
 *      the cdkd → CFn direction, the mirror of the cdkd ← CFn
 *      `import-nested-stack` integ shipped in PR A).
 *   2. Assert state files written at v6 keys
 *      (`cdkd/<Parent>/<region>/state.json` AND
 *      `cdkd/<Parent>~Child/<region>/state.json`),
 *      with `parentStack` / `parentLogicalId` / `parentRegion` populated
 *      on the child.
 *   3. Run `cdkd export <Parent> --yes` — the per-stack IMPORT loop
 *      should:
 *        - IMPORT the leaf child first (as a fresh standalone CFn stack
 *          named `<Parent>-Child` per cdkd2cfnStackName)
 *        - IMPORT the root parent, adopting the just-IMPORTed child as a
 *          nested reference via `ResourceIdentifier: { StackId: <child arn> }`
 *          and the "Nest an existing stack" `DeletionPolicy: Retain`
 *          requirement
 *        - Delete cdkd state for both stacks (leaf-first).
 *   4. Assert: both stacks visible in CFn (parent has the child in its
 *      DescribeStackResources output as a nested-stack row pointing at
 *      the child's StackId); both SSM parameters still alive on AWS.
 *   5. `aws cloudformation delete-stack <Parent>` — should cascade-delete
 *      both stacks AND the underlying SSM parameters (no Retain on the
 *      AWS-side SSM resources in this fixture; the Retain injection is
 *      ONLY on the parent's `AWS::CloudFormation::Stack` row, ensuring
 *      a parent-side rollback during IMPORT would not cascade-delete
 *      the just-imported child).
 *   6. Assert: both SSM parameters gone; both CFn stacks gone.
 */
class ChildNestedStack extends cdk.NestedStack {
  /** Child SSM parameter — pinned logical id so the verify.sh assertions can match. */
  public readonly param: ssm.StringParameter;

  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);
    this.param = new ssm.StringParameter(this, 'ChildParam', {
      stringValue: 'child-nested-value',
      description: 'cdkd #464 PR B2 export integ - SSM parameter inside the nested child',
    });
    (this.param.node.defaultChild as cdk.CfnResource).overrideLogicalId('ChildParam');
  }
}

export class ExportNestedStackExample extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const child = new ChildNestedStack(this, 'Child');
    // Override CDK's auto-generated logical id
    // (`ChildNestedStackChildNestedStackResourceC40294CA` style) to a
    // stable `Child` so the verify.sh assertions can pin both the AWS
    // tree row AND the cdkd state-key shape
    // (`cdkd/<parent>~Child/<region>/state.json`) without parsing the
    // hash suffix. Per memory rule `feedback_cdk_nested_stack_overridelogical_id.md`.
    if (child.nestedStackResource) {
      (child.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');
    }

    const parentParam = new ssm.StringParameter(this, 'ParentParam', {
      stringValue: 'parent-value',
      description: 'cdkd #464 PR B2 export integ - parent SSM parameter',
    });
    (parentParam.node.defaultChild as cdk.CfnResource).overrideLogicalId('ParentParam');
  }
}
