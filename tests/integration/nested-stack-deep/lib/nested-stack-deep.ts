import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Grandchild (depth = 2). Owns 1 resource — an SSM Parameter — whose
 * name is exposed via a nested-stack Output so the middle child can
 * `Fn::GetAtt: [Grandchild, 'Outputs.<key>']` it across the bottom
 * boundary.
 *
 * SSM is the cheapest cdkd-supported resource (one synchronous API
 * call create + delete, no eventual-consistency window, no IAM
 * dependencies), keeping the 3-level real-AWS run fast.
 */
class GrandchildNestedStack extends cdk.NestedStack {
  public readonly param: ssm.StringParameter;

  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);

    // Pin the AWS::CloudFormation::Stack logical id to a friendly value so
    // the state key (`<parent>~<logicalId>`) stays readable for assertions.
    // Without this, CDK auto-generates the compound id
    // `<Name>NestedStack<Name>NestedStackResource<hash>` — see memory rule
    // `feedback_cdk_nested_stack_overridelogical_id.md`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Grandchild');

    this.param = new ssm.StringParameter(this, 'Param', {
      // The value is env-overridable so the A5 `verify.sh` can re-synth with a
      // changed grandchild value and assert `cdkd diff --recursive` detects the
      // UPDATE deep in the tree (synth-vs-state) without a second deploy. Unset
      // (the deploy default) keeps the stable baseline value.
      stringValue:
        process.env['CDKD_INTEG_GRANDCHILD_VALUE'] ?? 'cdkd-nested-stack-deep-grandchild-value',
      description: 'cdkd nested-stack-deep integ - grandchild SSM parameter',
    });
  }
}

/**
 * Middle child (depth = 1). Owns 2 things:
 *
 *  - 1 own resource (SSM Parameter) whose value is the grandchild's
 *    parameter name, exercising `Fn::GetAtt` from middle → grandchild.
 *  - 1 grandchild nested stack.
 *
 * Its own `param.parameterName` is then exposed as a middle-level
 * Output so the parent can read it via `Fn::GetAtt: [Child, 'Outputs.<key>']`.
 */
class ChildNestedStack extends cdk.NestedStack {
  public readonly param: ssm.StringParameter;

  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);

    // Pin AWS::CloudFormation::Stack logical id; see GrandchildNestedStack.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    const grandchild = new GrandchildNestedStack(this, 'Grandchild');

    this.param = new ssm.StringParameter(this, 'Param', {
      // Reference the grandchild's parameter name — CDK synthesizes a
      // `Fn::GetAtt: [Grandchild.NestedStackResource, 'Outputs.<key>']`
      // on the middle child's template, which cdkd's
      // IntrinsicFunctionResolver must resolve through the grandchild's
      // recorded `attributes['Outputs.<key>']` map.
      stringValue: grandchild.param.parameterName,
      description:
        'cdkd nested-stack-deep integ - middle-child SSM parameter that references the grandchild param name via Fn::GetAtt across the bottom boundary',
    });
  }
}

/**
 * Top-level parent (depth = 0). Owns 1 own resource (SSM Parameter)
 * that references the middle child's exposed parameter name, plus the
 * middle child itself.
 *
 * The full reference chain: parent → middle → grandchild.
 *
 *   parent.ParentRef.stringValue = middle.Param.parameterName
 *   middle.Param.stringValue     = grandchild.Param.parameterName
 *
 * This deploys to verify cdkd handles `cdk.NestedStack` at depth = 2:
 *
 *  1. Recursive deploy: parent fires → NestedStackProvider.create reads
 *     middle template → middle deploy fires its own NestedStackProvider.create
 *     for the grandchild → grandchild deploys 1 resource → returns →
 *     middle's own param deploys with the grandchild's resolved value →
 *     returns → parent's own param deploys with the middle's resolved value.
 *  2. State key derivation under v6 schema:
 *       cdkd/NestedStackDeep/<region>/state.json                     (parent)
 *       cdkd/NestedStackDeep~Child/<region>/state.json               (middle child)
 *       cdkd/NestedStackDeep~Child~Grandchild/<region>/state.json    (grandchild)
 *     The `~` separator nests naturally for deeper trees because each
 *     level's parent name (used as the join prefix) already contains
 *     the prior `~`s — see [.claude/rules/state-schema.md](../../../.claude/rules/state-schema.md).
 *  3. Output propagation across two boundaries: the grandchild's
 *     `Fn::GetAtt` resolves into the middle's deploy, and the middle's
 *     `Fn::GetAtt` resolves into the parent's deploy. Both are exercised
 *     through cdkd's `attributes['Outputs.<key>']` flat-key fast path.
 *  4. Recursive destroy: parent reverse-DAG visits its own param first,
 *     then the middle's NestedStackProvider.delete fires, which itself
 *     reverse-DAG destroys middle's own param then recurses into the
 *     grandchild's destroy for the grandchild's 1 resource. State files
 *     for all 3 levels are removed in reverse order.
 */
export class NestedStackDeep extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const child = new ChildNestedStack(this, 'Child');

    new ssm.StringParameter(this, 'ParentRef', {
      // Reference the middle child's parameter name — CDK synthesizes a
      // `Fn::GetAtt: [Child.NestedStackResource, 'Outputs.<key>']` on the
      // parent's template. cdkd resolves it through the middle's
      // recorded `attributes['Outputs.<key>']` map.
      stringValue: child.param.parameterName,
      description:
        'cdkd nested-stack-deep integ - parent SSM parameter that references the middle-child param name via Fn::GetAtt (transitively pulls through the grandchild)',
    });
  }
}
