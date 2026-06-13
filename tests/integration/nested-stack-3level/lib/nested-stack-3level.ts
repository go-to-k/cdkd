import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * Depth = 3, the bottom of the tree (great-grandchild). This is one level
 * DEEPER than the existing `nested-stack-deep` fixture, which stops at the
 * grandchild (depth = 2). Owns 1 SSM Parameter whose value is fed DOWN from
 * the root via a CDK-synthesized nested-stack `Parameter` (top-down passing),
 * and exposes its own parameter name as an Output that bubbles back UP the
 * tree via `Fn::GetAtt`.
 *
 * `downwardValue` is a token that resolves to a value owned by the ROOT
 * stack (the root SNS topic name). Referencing a parent-stack value inside a
 * NestedStack makes CDK synthesize a `Parameters` entry on the great-
 * grandchild's `AWS::CloudFormation::Stack` resource in the grandchild's
 * template — exercising cdkd's `NestedStackProvider` `Parameters` extraction
 * + `DeployEngineOptions.parameters` forwarding, which the bottom-up-only
 * `nested-stack-deep` fixture never touches.
 */
class GreatGrandchildNestedStack extends cdk.NestedStack {
  public readonly param: ssm.StringParameter;

  constructor(
    scope: Construct,
    id: string,
    downwardValue: string,
    props?: cdk.NestedStackProps
  ) {
    super(scope, id, props);

    // Pin the AWS::CloudFormation::Stack logical id so the cdkd state key
    // (`<parent>~<logicalId>`) stays readable for the verify.sh assertions.
    // Without this, CDK auto-generates the compound id
    // `<Name>NestedStack<Name>NestedStackResource<hash>` — see memory rule
    // `feedback_cdk_nested_stack_overridelogical_id.md`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('GreatGrandchild');

    this.param = new ssm.StringParameter(this, 'Param', {
      // `downwardValue` is the ROOT topic name, passed DOWN three boundaries
      // (root -> child -> grandchild -> great-grandchild) as a nested-stack
      // Parameter at each hop. The value is env-overridable so verify.sh can
      // re-synth a changed value and assert `cdkd diff --recursive` surfaces a
      // deep UPDATE without a second deploy.
      stringValue:
        process.env['CDKD_INTEG_GGC_VALUE'] ??
        `cdkd-3level-ggc-uses-root-topic:${downwardValue}`,
      description:
        'cdkd nested-stack-3level integ - great-grandchild (depth=3) SSM parameter; value carries the root topic name passed DOWN three nested-stack boundaries',
    });
  }
}

/**
 * Depth = 2 (grandchild). A BRANCHING node — owns 2 own resources (an SSM
 * Parameter AND an SNS Topic) PLUS the great-grandchild nested stack. The
 * existing `nested-stack-deep` levels each own exactly 1 resource; the extra
 * own-resource here widens the tree so the per-level DAG has to order a
 * sibling resource alongside the nested-stack node.
 */
class GrandchildNestedStack extends cdk.NestedStack {
  public readonly param: ssm.StringParameter;

  constructor(
    scope: Construct,
    id: string,
    downwardValue: string,
    props?: cdk.NestedStackProps
  ) {
    super(scope, id, props);

    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Grandchild');

    // Own SNS topic — a second resource type at this level (the existing deep
    // fixture is SSM-only) and a sibling of the nested-stack node in the DAG.
    const topic = new sns.Topic(this, 'Topic', {
      displayName: 'cdkd nested-stack-3level grandchild topic',
    });

    // Pass the root value DOWN one more boundary into the great-grandchild.
    const greatGrandchild = new GreatGrandchildNestedStack(this, 'GreatGrandchild', downwardValue);

    // Own SSM parameter — value pulls the great-grandchild's parameter name
    // back UP via Fn::GetAtt (bottom-up output) AND concatenates this level's
    // own topic name, so the parameter depends on BOTH a sibling resource and
    // a nested-stack output.
    this.param = new ssm.StringParameter(this, 'Param', {
      stringValue: `${greatGrandchild.param.parameterName}|${topic.topicName}`,
      description:
        'cdkd nested-stack-3level integ - grandchild (depth=2) SSM parameter; references the great-grandchild param name (Fn::GetAtt UP) and the sibling topic name',
    });
  }
}

/**
 * Depth = 1 (child). Owns 1 SSM Parameter that references the grandchild's
 * exposed parameter name via `Fn::GetAtt` (UP), and forwards the root value
 * DOWN to the grandchild.
 */
class ChildNestedStack extends cdk.NestedStack {
  public readonly param: ssm.StringParameter;

  constructor(
    scope: Construct,
    id: string,
    downwardValue: string,
    props?: cdk.NestedStackProps
  ) {
    super(scope, id, props);

    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    const grandchild = new GrandchildNestedStack(this, 'Grandchild', downwardValue);

    this.param = new ssm.StringParameter(this, 'Param', {
      stringValue: grandchild.param.parameterName,
      description:
        'cdkd nested-stack-3level integ - child (depth=1) SSM parameter that references the grandchild param name via Fn::GetAtt across the boundary',
    });
  }
}

/**
 * Top-level root (depth = 0). Owns:
 *
 *  - 1 SNS Topic — the source of the DOWNWARD reference. Its `topicName` is
 *    threaded down all three nested-stack boundaries as a synthesized
 *    `Parameter`, exercising cdkd's nested-stack `Parameters` forwarding
 *    (the existing `nested-stack-deep` fixture only does bottom-up GetAtt).
 *  - 1 SSM Parameter that references the child's exposed parameter name via
 *    `Fn::GetAtt` (UP) — transitively pulling the whole 4-level chain.
 *  - the child nested stack itself.
 *
 * The bidirectional reference shape:
 *
 *   DOWN (Parameters):  root.Topic.topicName -> child -> grandchild -> great-grandchild.Param
 *   UP   (GetAtt):       great-grandchild.Param.name -> grandchild.Param -> child.Param -> root.RootRef
 *
 * This is a strictly deeper + wider + bidirectional superset of the existing
 * 3-level `nested-stack-deep` fixture (which is 3 levels, 1 resource/level,
 * bottom-up GetAtt only).
 */
export class NestedStack3Level extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Root-owned topic; its name is the DOWNWARD value threaded into the tree.
    const rootTopic = new sns.Topic(this, 'RootTopic', {
      displayName: 'cdkd nested-stack-3level root topic',
    });

    const child = new ChildNestedStack(this, 'Child', rootTopic.topicName);

    // Root-side resource that pulls the child's exposed value UP via
    // Fn::GetAtt across the top nested-stack boundary.
    new ssm.StringParameter(this, 'RootRef', {
      stringValue: child.param.parameterName,
      description:
        'cdkd nested-stack-3level integ - root SSM parameter that references the child param name via Fn::GetAtt (transitively pulls the full 4-level chain)',
    });
  }
}
