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

    // THE #3094 ARM, depth 2. Two parameters the CHILD hands down as
    // `{Ref: HandoffSecretA}` / `{Ref: HandoffSecretB}` -- an INTRINSIC source
    // on the child's nested-stack row -- each consumed by its own resource
    // (the child's bag is scoped per logical id). The two are two SPELLINGS
    // of one secret, so the parent's bag collapsed them onto one plaintext
    // before the child existed; each leaf must still persist ITS OWN
    // expression (the #2291 shape one level down, which go-to-k/cdkd#3093's
    // review found regressed with no live signal).
    const secretA = new cdk.CfnParameter(this, 'HandoffSecretA', { type: 'String' });
    secretA.overrideLogicalId('HandoffSecretA');
    const secretB = new cdk.CfnParameter(this, 'HandoffSecretB', { type: 'String' });
    secretB.overrideLogicalId('HandoffSecretB');
    const secretParamA = new ssm.StringParameter(this, 'SecretA', {
      stringValue: secretA.valueAsString,
      description:
        'cdkd nested-stack-3level integ - grandchild (depth=2) SSM parameter fed by the secret handed down two nested-stack boundaries (spelling A, issue #3094)',
    });
    (secretParamA.node.defaultChild as ssm.CfnParameter).overrideLogicalId('SecretA');
    const secretParamB = new ssm.StringParameter(this, 'SecretB', {
      stringValue: secretB.valueAsString,
      description:
        'cdkd nested-stack-3level integ - grandchild (depth=2) SSM parameter fed by the secret handed down two nested-stack boundaries (spelling B, issue #3094)',
    });
    (secretParamB.node.defaultChild as ssm.CfnParameter).overrideLogicalId('SecretB');

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

    // THE #3094 ARM, depth 1: the two secret spellings arrive from the ROOT
    // as literal `{{resolve:...}}` strings (the parent resolves them) and are
    // forwarded to the grandchild as `{Ref}` -- `valueAsString` of a
    // CfnParameter synthesizes `{Ref: <LogicalId>}` on the grandchild's row.
    const secretA = new cdk.CfnParameter(this, 'HandoffSecretA', { type: 'String' });
    secretA.overrideLogicalId('HandoffSecretA');
    const secretB = new cdk.CfnParameter(this, 'HandoffSecretB', { type: 'String' });
    secretB.overrideLogicalId('HandoffSecretB');

    const grandchild = new GrandchildNestedStack(this, 'Grandchild', downwardValue, {
      parameters: {
        HandoffSecretA: secretA.valueAsString,
        HandoffSecretB: secretB.valueAsString,
      },
    });

    this.param = new ssm.StringParameter(this, 'Param', {
      stringValue: grandchild.param.parameterName,
      description:
        'cdkd nested-stack-3level integ - child (depth=1) SSM parameter that references the grandchild param name via Fn::GetAtt across the boundary',
    });
  }
}

/**
 * THE #3156 ARM, depth 2: the grandchild of the `Framed` branch. Consumes each
 * of the four parameters the middle hands down in its own SSM parameter,
 * through an `Fn::Join` (`gc-` + the `Ref`), so its three debug lines per
 * parameter -- `Parameter`, `Resolved Ref to parameter`, `Resolved Fn::Join`
 * -- are all emitted.
 */
class FramedGrandchildNestedStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);

    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('FramedGrandchild');

    for (const name of ['SsmPass', 'SsmWrap', 'OutPass', 'OutWrap'] as const) {
      const parameter = new cdk.CfnParameter(this, `Gc${name}`, { type: 'String' });
      parameter.overrideLogicalId(`Gc${name}`);
      const consumer = new ssm.StringParameter(this, `Framed${name}`, {
        stringValue: `gc-${parameter.valueAsString}`,
        description: `cdkd nested-stack-3level integ - #3156 grandchild consumer of Gc${name}`,
      });
      (consumer.node.defaultChild as ssm.CfnParameter).overrideLogicalId(`Framed${name}`);
    }
  }
}

/**
 * THE #3156 ARM, depth 1: the middle stack. Receives the two framed secrets as
 * `MidPinSsm` / `MidPinOut` and hands each down TWICE: PASS-THROUGH
 * (`{Ref}` straight into the grandchild's `Parameters`) and RE-WRAP
 * (`m-` + the `Ref`). Owns nothing else, so the bag of its nested-stack row
 * holds only what the root's carry hands it -- the isolation the issue asks
 * for, which `Child`'s row (holding the #3094 pairs) could not give.
 */
class FramedNestedStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);

    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Framed');

    const pinSsm = new cdk.CfnParameter(this, 'MidPinSsm', { type: 'String' });
    pinSsm.overrideLogicalId('MidPinSsm');
    const pinOut = new cdk.CfnParameter(this, 'MidPinOut', { type: 'String' });
    pinOut.overrideLogicalId('MidPinOut');

    new FramedGrandchildNestedStack(this, 'FramedGrandchild', {
      parameters: {
        GcSsmPass: pinSsm.valueAsString,
        GcSsmWrap: cdk.Fn.join('', ['m-', pinSsm.valueAsString]),
        GcOutPass: pinOut.valueAsString,
        GcOutWrap: cdk.Fn.join('', ['m-', pinOut.valueAsString]),
      },
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

    // THE #3094 ARM, depth 0: two spellings of ONE secret (an empty version
    // stage defaults to AWSCURRENT, so they resolve identically -- the
    // `nested-stack-secret` fixture's trick), spelled as LITERAL strings so
    // the root's own row is a string source. The secret is created OUT OF
    // BAND by verify.sh; the name is kept in sync there.
    const account = cdk.Stack.of(this).account;
    const secretName = `cdkd-3level-secret-${account}`;
    const child = new ChildNestedStack(this, 'Child', rootTopic.topicName, {
      parameters: {
        HandoffSecretA: `{{resolve:secretsmanager:${secretName}:SecretString:handoff::}}`,
        HandoffSecretB: `{{resolve:secretsmanager:${secretName}:SecretString:handoff:AWSCURRENT:}}`,
      },
    });

    // THE #3156 ARM, depth 0: two 2-character secrets in the two intrinsic
    // frames the sub-floor carry refused before the issue -- an `ssm` token
    // (a SecureString verify.sh creates) with the account `Ref` inside it, and
    // a secretsmanager token followed by a region `Ref` OUTSIDE it -- on their
    // own nested-stack row. Names kept in sync with verify.sh. `cdk.Aws`
    // pseudo parameters, never `Stack.of(this).account`: under `cdkd deploy`
    // the stack's env resolves the account, which CDK then folds into the
    // literal text -- a plain string frame, not the intrinsic one this arm is
    // for (measured: verify.sh's premise caught exactly that).
    new FramedNestedStack(this, 'Framed', {
      parameters: {
        MidPinSsm: cdk.Fn.join('', [
          'pin3156s:{{resolve:ssm:cdkd-3level-pinssm-',
          cdk.Aws.ACCOUNT_ID,
          '}}',
        ]),
        MidPinOut: cdk.Fn.join('', [
          'pin3156o:{{resolve:secretsmanager:cdkd-3level-secret-',
          cdk.Aws.ACCOUNT_ID,
          ':SecretString:pin}}@',
          cdk.Aws.REGION,
        ]),
      },
    });

    // Root-side resource that pulls the child's exposed value UP via
    // Fn::GetAtt across the top nested-stack boundary.
    new ssm.StringParameter(this, 'RootRef', {
      stringValue: child.param.parameterName,
      description:
        'cdkd nested-stack-3level integ - root SSM parameter that references the child param name via Fn::GetAtt (transitively pulls the full 4-level chain)',
    });
  }
}
