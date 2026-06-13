import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Intrinsics-torture stack.
 *
 * cdkd resolves EVERY CloudFormation intrinsic function itself in
 * `src/deployment/intrinsic-function-resolver.ts` (unlike the AWS CDK CLI,
 * which hands the unresolved template to CloudFormation and lets the CFn
 * engine resolve them server-side). The less-common intrinsics and deep
 * nesting are exactly where cdkd's hand-rolled resolver is most likely to
 * diverge from CloudFormation's behavior.
 *
 * This fixture computes a real resource property — the `Value` of an
 * `AWS::SSM::Parameter` — via each of the harder intrinsics, so that a wrong
 * resolution produces a wrong parameter value that `verify.sh` reads back
 * from AWS (`aws ssm get-parameter`) and compares against an expected value
 * computed independently in the script. A mismatch pinpoints exactly which
 * intrinsic cdkd resolved incorrectly.
 *
 * Coverage that goes BEYOND the existing `intrinsic-functions` fixture
 * (which exercises only Ref / Fn::GetAtt / Fn::Join / Fn::Sub on an S3 bucket
 * + IAM role): Fn::Cidr, Fn::FindInMap, Fn::GetAZs + Fn::Select, Fn::Base64,
 * deeply-nested Fn::Split/Select/Join, deeply-nested Fn::Sub with a
 * ${Resource.Attr} GetAtt + ${AWS::Region} + a literal variable map, and
 * ALL pseudo-parameters (AWS::AccountId / AWS::Region / AWS::Partition /
 * AWS::StackName / AWS::URLSuffix / AWS::NotificationARNs).
 *
 * The stack is intentionally cheap: an SNS topic + an SQS queue (to give the
 * GetAtt-bearing Fn::Sub a real ARN attribute to resolve) plus a fistful of
 * SSM String parameters. No VPC, no NAT, no Lambda — deploys and destroys in
 * well under a minute.
 *
 * Every SSM parameter is built with the raw CloudFormation escape hatch
 * (`new ssm.CfnParameter` + `addPropertyOverride` carrying a literal intrinsic
 * object) so the synthesized template carries the EXACT intrinsic shape we
 * want to torture — CDK's L2 helpers would otherwise pre-fold some of these
 * at synth time.
 */
export class IntrinsicsTortureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- Mappings: region/env lookup table for Fn::FindInMap ----
    // Hand-written CfnMapping so FindInMap has a real Mappings section to read.
    const envMap = new cdk.CfnMapping(this, 'EnvMap', {
      mapping: {
        'us-east-1': { tier: 'use1-prod', retentionDays: '30' },
        'us-west-2': { tier: 'usw2-prod', retentionDays: '14' },
        'ap-northeast-1': { tier: 'apne1-prod', retentionDays: '7' },
        // Fallback row so the fixture works in any region the integ runs in.
        DEFAULT: { tier: 'default-prod', retentionDays: '1' },
      },
    });

    // ---- A real SNS topic + SQS queue: targets for Fn::GetAtt ----
    // The queue's Arn feeds the deeply-nested Fn::Sub below.
    const topic = new sns.Topic(this, 'TortureTopic', {
      displayName: 'cdkd intrinsics torture topic',
    });
    const queue = new sqs.Queue(this, 'TortureQueue', {
      retentionPeriod: cdk.Duration.days(1),
    });

    // Helper: create an SSM String parameter whose `Value` is a raw intrinsic
    // object. We build the L1 with a placeholder string Value then override
    // the Value property with the literal intrinsic so the synth output is
    // exactly the shape we intend to torture.
    const intrinsicParam = (
      logicalId: string,
      nameSuffix: string,
      valueIntrinsic: unknown,
      description: string
    ): ssm.CfnParameter => {
      const p = new ssm.CfnParameter(this, logicalId, {
        type: 'String',
        name: `/${id}/${nameSuffix}`,
        value: 'placeholder',
        description,
      });
      p.addPropertyOverride('Value', valueIntrinsic);
      return p;
    };

    // -----------------------------------------------------------------
    // 1. Fn::Cidr — carve a /16 VPC CIDR into eight /24 subnet CIDRs.
    //    Pick element [3] and join the whole list so verify.sh can assert
    //    BOTH a single Select-of-Cidr AND the full carved list.
    //    Fn::Cidr args: [ ipBlock, count, cidrBits ]. cidrBits is the number
    //    of *host* bits; a /24 out of a /16 leaves 8 host bits -> cidrBits=8.
    // -----------------------------------------------------------------
    intrinsicParam(
      'CidrSelectParam',
      'cidr-select',
      { 'Fn::Select': [3, { 'Fn::Cidr': ['10.0.0.0/16', 8, 8] }] },
      'Fn::Select of Fn::Cidr (4th /24 carved from 10.0.0.0/16)'
    );
    intrinsicParam(
      'CidrJoinParam',
      'cidr-join',
      { 'Fn::Join': [',', { 'Fn::Cidr': ['10.0.0.0/16', 8, 8] }] },
      'Fn::Join of the full Fn::Cidr list (eight /24 blocks)'
    );

    // -----------------------------------------------------------------
    // 2. Fn::FindInMap — region/env lookup feeding a real property value.
    //    Top-level key is { Ref: AWS::Region }; falls back to DEFAULT via a
    //    second param so the assertion works in any region.
    // -----------------------------------------------------------------
    intrinsicParam(
      'FindInMapDefaultParam',
      'findinmap-default',
      envMap.findInMap('DEFAULT', 'tier'),
      'Fn::FindInMap DEFAULT.tier (region-independent assertion)'
    );
    intrinsicParam(
      'FindInMapRegionParam',
      'findinmap-region',
      // Raw FindInMap with a Ref to the region pseudo param as the top-level
      // key. verify.sh asserts this equals the map row for the run region
      // (or skips if the run region is not a mapped row).
      { 'Fn::FindInMap': ['EnvMap', { Ref: 'AWS::Region' }, 'retentionDays'] },
      'Fn::FindInMap EnvMap[AWS::Region].retentionDays'
    );

    // -----------------------------------------------------------------
    // 3. Fn::GetAZs + Fn::Select — pick the first AZ of the deploy region.
    //    cdkd sorts the AZ list, so element [0] is the alphabetically-first
    //    available zone. verify.sh computes the same from
    //    `aws ec2 describe-availability-zones`.
    // -----------------------------------------------------------------
    intrinsicParam(
      'FirstAzParam',
      'first-az',
      { 'Fn::Select': [0, { 'Fn::GetAZs': '' }] },
      'Fn::Select 0 of Fn::GetAZs (first available AZ, cdkd sorts the list)'
    );

    // -----------------------------------------------------------------
    // 4. Fn::Base64 — encode a literal string. Deterministic.
    // -----------------------------------------------------------------
    intrinsicParam(
      'Base64Param',
      'base64',
      { 'Fn::Base64': 'cdkd-intrinsics-torture' },
      'Fn::Base64 of a literal string'
    );

    // -----------------------------------------------------------------
    // 5. Fn::Split + Fn::Select + Fn::Join nested together.
    //    Split "a-b-c-d-e" on "-", select index 2 ("c"), then join that with
    //    two more selected elements via Fn::Join. Fully deterministic and
    //    exercises Split feeding Select feeding Join inside one expression.
    // -----------------------------------------------------------------
    intrinsicParam(
      'SplitSelectJoinParam',
      'split-select-join',
      {
        'Fn::Join': [
          '|',
          [
            { 'Fn::Select': [0, { 'Fn::Split': ['-', 'a-b-c-d-e'] }] },
            { 'Fn::Select': [2, { 'Fn::Split': ['-', 'a-b-c-d-e'] }] },
            { 'Fn::Select': [4, { 'Fn::Split': ['-', 'a-b-c-d-e'] }] },
          ],
        ],
      },
      'Fn::Join of three Fn::Select-of-Fn::Split picks (expect a|c|e)'
    );

    // -----------------------------------------------------------------
    // 6. Deeply-nested Fn::Sub with a ${Resource.Attr} GetAtt + ${AWS::Region}
    //    + a literal variable map. The two-arg Fn::Sub form: the template
    //    string references the queue ARN via ${TortureQueue.Arn}, the region
    //    pseudo via ${AWS::Region}, and a literal-map variable ${label}. The
    //    literal-map value is itself an Fn::Join, so the Sub variable map
    //    carries a nested intrinsic that must resolve before substitution.
    // -----------------------------------------------------------------
    // Use the queue's REAL logical id (CDK auto-generates it with a hash
    // suffix) so the synthesized ${<LogicalId>.Arn} GetAtt actually resolves.
    const queueLogicalId = (queue.node.defaultChild as sqs.CfnQueue).logicalId;
    intrinsicParam(
      'NestedSubParam',
      'nested-sub',
      {
        'Fn::Sub': [
          `label=\${label};region=\${AWS::Region};queueArn=\${${queueLogicalId}.Arn}`,
          {
            label: { 'Fn::Join': ['-', ['cdkd', 'torture', 'sub']] },
          },
        ],
      },
      'Two-arg Fn::Sub: literal-map var (nested Fn::Join) + ${AWS::Region} + ${Queue.Arn} GetAtt'
    );

    // -----------------------------------------------------------------
    // 7. ALL pseudo-parameters, each fed through Fn::Sub into a parameter
    //    value so verify.sh can read back the resolved concrete value.
    //    AWS::NotificationARNs is a LIST pseudo param that cdkd resolves to
    //    `undefined` (there is no notification ARN list in cdkd's
    //    CloudFormation-free model); inside Fn::Sub that stringifies to the
    //    literal "undefined". verify.sh asserts cdkd's documented behavior.
    // -----------------------------------------------------------------
    intrinsicParam(
      'PseudoParam',
      'pseudo',
      {
        'Fn::Sub':
          'account=${AWS::AccountId};region=${AWS::Region};partition=${AWS::Partition};' +
          'stack=${AWS::StackName};urlsuffix=${AWS::URLSuffix};notif=${AWS::NotificationARNs}',
      },
      'All pseudo-parameters via Fn::Sub (AccountId/Region/Partition/StackName/URLSuffix/NotificationARNs)'
    );

    // -----------------------------------------------------------------
    // 8. Fn::Sub building an ARN-shaped string from ${AWS::Partition},
    //    ${AWS::Region}, ${AWS::AccountId} + a Ref to the topic — exercises
    //    pseudo params and a resource Ref together inside one Fn::Sub. The
    //    topic Ref resolves to the topic ARN (SNS topic physical id IS the
    //    ARN), so verify.sh asserts the value starts with the expected ARN
    //    prefix for the run account/region/partition.
    // -----------------------------------------------------------------
    // The SNS topic's logical id (the CfnTopic child) — referenced by a raw
    // Ref so the synth template carries `{ Ref: <TopicLogicalId> }` literally.
    const topicLogicalId = (topic.node.defaultChild as sns.CfnTopic).logicalId;
    intrinsicParam(
      'TopicRefSubParam',
      'topic-ref-sub',
      {
        'Fn::Sub': [
          'arn-prefix=arn:${AWS::Partition}:sns:${AWS::Region}:${AWS::AccountId};topicRef=${topicArn}',
          {
            topicArn: { Ref: topicLogicalId },
          },
        ],
      },
      'Fn::Sub with pseudo params + a Ref to the SNS topic'
    );

    // Outputs so a human can eyeball the resolved values after deploy.
    new cdk.CfnOutput(this, 'QueueArnOut', {
      value: queue.queueArn,
      description: 'SQS queue ARN (Fn::GetAtt target for the nested Fn::Sub)',
    });
    new cdk.CfnOutput(this, 'TopicArnOut', {
      value: topic.topicArn,
      description: 'SNS topic ARN (Ref target)',
    });
  }
}
