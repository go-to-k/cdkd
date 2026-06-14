import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Intrinsics Torture Test #2.
 *
 * The sibling `intrinsics-torture` fixture surfaced bug #838 (`Fn::Join`
 * over a list-returning intrinsic crashed). This fixture goes after the
 * NEXT tier of intrinsic arg-shapes that the resolver in
 * `src/deployment/intrinsic-function-resolver.ts` is likely to mishandle:
 * the less-common / harder forms each LIST-returning or NESTED-intrinsic
 * variant, the FindInMap enhanced 4th-arg default, a `Ref`-valued
 * `Fn::GetAtt` attribute name, the `${!Literal}` Sub escape, `Fn::Base64`
 * of an intrinsic, a triple-nested `If`-in-`Sub`-in-`Join`, and `Fn::Cidr`
 * for IPv6.
 *
 * Each torture intrinsic feeds a REAL `AWS::SSM::Parameter.Value`, written
 * via the raw L1 `CfnParameter` (SSM) + `addPropertyOverride` escape hatch
 * so the synthesized template carries the LITERAL intrinsic (not a value
 * CDK pre-folded at synth time). `verify.sh` reads each SSM parameter back
 * and asserts the concrete value, so a wrong/failed resolution is caught
 * by name.
 *
 * Cheap by design: one SNS topic + a handful of SSM String parameters. No
 * VPC, no Lambda, no IAM beyond what SNS implies.
 */
export class IntrinsicsTorture2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- Template-level CfnParameters (drive the Ref-based arg shapes) ----

    // A CommaDelimitedList-shaped string we Fn::Split + Fn::Select over.
    const csvParam = new cdk.CfnParameter(this, 'CsvParam', {
      type: 'String',
      default: 'alpha,bravo,charlie',
    });

    // The attribute name we Fn::GetAtt by Ref (CFn allows the attribute
    // name itself to be a Ref to a parameter).
    const attrNameParam = new cdk.CfnParameter(this, 'AttrNameParam', {
      type: 'String',
      default: 'TopicArn',
    });

    // A scalar value we Fn::Base64-encode (through a Ref, so the resolver
    // must resolve the Ref to a string BEFORE base64-encoding it).
    const base64SourceParam = new cdk.CfnParameter(this, 'Base64SourceParam', {
      type: 'String',
      default: 'cdkd-base64-source',
    });

    // Drives the nested Fn::Sub variable.
    const nestedSubVarParam = new cdk.CfnParameter(this, 'NestedSubVarParam', {
      type: 'String',
      default: 'mid',
    });

    // ---- Conditions (for the nested Fn::If inside Sub inside Join) ----
    // Always-true condition: AWS::Region equals itself via a param default.
    const alwaysTrue = new cdk.CfnCondition(this, 'AlwaysTrue', {
      expression: cdk.Fn.conditionEquals('on', 'on'),
    });

    // ---- A Mapping for FindInMap (enhanced 4-arg default + Ref key) ----
    new cdk.CfnMapping(this, 'RegionMap', {
      mapping: {
        // Deliberately keyed by a region that is NOT us-east-1 so a
        // {Ref: AWS::Region} top-level key MISSES and forces the
        // 4th-arg DefaultValue path.
        'ap-northeast-1': { theKey: 'tokyo-hit' },
        // A present key so the "hit" assertion has something to land on.
        'us-east-1': { theKey: 'nvirginia-hit' },
      },
    });

    // ---- The single real dependency resource: an SNS Topic ----
    const topic = new sns.Topic(this, 'Topic', {
      displayName: 'cdkd-intrinsics-torture-2',
    });
    const topicL1 = topic.node.defaultChild as sns.CfnTopic;

    // Helper: create a raw L1 SSM String parameter whose `Value` is set to
    // a literal intrinsic via addPropertyOverride, so synth does NOT
    // pre-fold it. Returns the logical-id-friendly construct.
    const namePrefix = '/cdkd-integ/intrinsics-torture-2';
    const makeParam = (id: string, ssmName: string, valueIntrinsic: unknown): void => {
      const p = new ssm.CfnParameter(this, id, {
        type: 'String',
        // Placeholder; overridden below with the literal intrinsic.
        value: 'PLACEHOLDER',
        name: `${namePrefix}/${ssmName}`,
      });
      // addPropertyOverride with a token-bearing object writes the raw
      // intrinsic straight into the template's Properties.Value.
      p.addPropertyOverride('Value', valueIntrinsic);
    };

    // 1) Fn::Select whose LIST arg is a list-returning intrinsic.
    //    1a) Fn::Select[1, Fn::GetAZs('')]  -> 2nd AZ of the deploy region.
    makeParam('SelectGetAzs', 'select-getazs', {
      'Fn::Select': [1, { 'Fn::GetAZs': '' }],
    });
    //    1b) Fn::Select[0, Fn::Split(',', <Ref CsvParam>)] -> 'alpha'.
    makeParam('SelectSplit', 'select-split', {
      'Fn::Select': [0, { 'Fn::Split': [',', { Ref: csvParam.logicalId }] }],
    });

    // 2) Fn::FindInMap enhanced 4th-arg DefaultValue + Ref-driven top key.
    //    2a) Top key = {Ref: AWS::Region}; us-east-1 IS in the map -> 'nvirginia-hit'.
    //        (Run in us-east-1, this is the HIT path.)
    makeParam('FindInMapRefKey', 'findinmap-refkey', {
      'Fn::FindInMap': ['RegionMap', { Ref: 'AWS::Region' }, 'theKey'],
    });
    //    2b) Top key = a literal MISSING region -> 4th-arg DefaultValue fires.
    makeParam('FindInMapDefault', 'findinmap-default', {
      'Fn::FindInMap': [
        'RegionMap',
        'eu-west-3',
        'theKey',
        { DefaultValue: 'fallback-value' },
      ],
    });

    // 3) Fn::GetAtt where the ATTRIBUTE NAME is a Ref to a parameter.
    //    AttrNameParam defaults to 'TopicArn' -> resolves to the topic ARN.
    makeParam('GetAttRefAttr', 'getatt-refattr', {
      'Fn::GetAtt': [topicL1.logicalId, { Ref: attrNameParam.logicalId }],
    });

    // 4) Fn::Sub with the ${!Literal} escape -> renders a literal ${Literal}.
    makeParam('SubEscape', 'sub-escape', {
      'Fn::Sub': 'before-${!NotAVar}-after',
    });

    // 5) Fn::Base64 of a non-literal (Ref resolves to a string first).
    makeParam('Base64Intrinsic', 'base64-intrinsic', {
      'Fn::Base64': { Ref: base64SourceParam.logicalId },
    });

    // 6) Deeply NESTED Fn::If inside Fn::Sub inside Fn::Join.
    //    Join('-', ['head', Sub('seg-${NestedSubVarParam}'), If(AlwaysTrue, 'yes', 'no')])
    //    -> 'head-seg-mid-yes'.
    makeParam('NestedIfSubJoin', 'nested-if-sub-join', {
      'Fn::Join': [
        '-',
        [
          'head',
          { 'Fn::Sub': ['seg-${V}', { V: { Ref: nestedSubVarParam.logicalId } }] },
          { 'Fn::If': [alwaysTrue.logicalId, 'yes', 'no'] },
        ],
      ],
    });

    // 7) Fn::Cidr — IPv6 and a 2nd IPv4 edge (different cidrBits).
    //    7a) IPv6: Cidr('2001:db8::/56', 4, 64) -> first block '2001:db8::/64'.
    //        We Select[0] so the SSM String parameter gets a scalar.
    makeParam('CidrIpv6', 'cidr-ipv6', {
      'Fn::Select': [0, { 'Fn::Cidr': ['2001:db8::/56', 4, 64] }],
    });
    //    7b) IPv4 with cidrBits=4 (16 addrs/block): Cidr('10.0.0.0/24', 4, 4)
    //        -> Select[2] = '10.0.0.32/28'.
    makeParam('CidrIpv4', 'cidr-ipv4', {
      'Fn::Select': [2, { 'Fn::Cidr': ['10.0.0.0/24', 4, 4] }],
    });

    // Surface the topic ARN as an output for cross-checking in verify.sh.
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
  }
}
