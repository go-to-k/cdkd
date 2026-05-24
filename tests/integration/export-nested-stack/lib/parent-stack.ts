import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Issue #464 PR B1.5 — `cdkd export` recursive nested-stack
 * state-tree walker + hard-error path end-to-end integ.
 *
 * PR B1 (already merged) added `buildCdkdStateStackTree` + the
 * dedicated `nestedStackRows` branch in `buildImportPlan` plus the
 * orchestrator's leaf-first preview + hard-error gate. This fixture
 * verifies the walker correctly handles a REAL cdkd-state nested
 * tree (not the synthetic mocks in unit tests) AND that the hard-error
 * path surfaces the documented PR B2-follow-up workaround message —
 * a regression test for the "deferred to PR B2" UX so future code
 * changes can't accidentally re-block the path with a cryptic error.
 *
 * Covers `AWS::CloudFormation::Stack` (nested-stack export literal —
 * picked up by `scripts/build-integ-coverage-matrix.ts` so this
 * fixture is attributed for the type in `docs/integ-coverage.md`).
 *
 * The actual CFn-side `--include-nested-stacks` IMPORT changeset
 * submission is deferred to a follow-up PR per the 2 AWS-API
 * constraints empirically discovered 2026-05-24 (see
 * [docs/design/464-nested-stacks-export-import.md](../../../docs/design/464-nested-stacks-export-import.md)
 * §4 "AWS-API design constraints"). Once that lands, this fixture's
 * verify.sh should switch from "expect hard-error" to "expect success".
 *
 * Shape: one `cdk.Stack` parent containing one `cdk.NestedStack`
 * child. Both stacks carry one `AWS::SSM::Parameter` each (cheap,
 * fast, region-agnostic) — same shape as PR A's
 * `import-nested-stack` fixture so the verification topology is
 * identical to the proven import direction.
 *
 * Test flow (see verify.sh):
 *   1. `cdkd deploy` parent + child (cdkd state under both v6 keys).
 *   2. Run `cdkd export <Parent> --dry-run` → expect WARN with PR B2
 *      pointer + leaf-first migration preview, exit 0.
 *   3. Run `cdkd export <Parent> --yes` → expect hard-ERROR with the
 *      same message, exit non-zero. State is unchanged.
 *   4. `cdkd destroy <Parent>` to clean up.
 */
class ChildNestedStack extends cdk.NestedStack {
  /** Child SSM parameter — exposed via the auto-generated CFn Output below. */
  public readonly param: ssm.StringParameter;

  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);
    this.param = new ssm.StringParameter(this, 'ChildParam', {
      stringValue: 'child-nested-value',
      description: 'cdkd #464 PR B1.5 integ - SSM parameter inside the nested child',
    });
    // Override CDK's auto-generated hash suffix so verify.sh's
    // assertions pin the logical id directly. See memory rule
    // `feedback_cdk_nested_stack_overridelogical_id.md`.
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
      description: 'cdkd #464 PR B1.5 integ - parent SSM parameter referencing the child param name',
    });
    (parentParam.node.defaultChild as cdk.CfnResource).overrideLogicalId('ParentParam');
  }
}
