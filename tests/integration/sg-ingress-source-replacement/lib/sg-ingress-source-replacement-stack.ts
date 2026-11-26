import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * A standalone ingress rule whose source changes (go-to-k/cdkd#7071).
 *
 * The rule's physical id is `<GroupId>|<IpProtocol>|<FromPort>|<ToPort>`, with
 * no source, so the new rule of a source change has the old rule's id. cdkd
 * read that as "the create returned the existing rule" and refused the deploy,
 * leaving the new rule authorized and recorded nowhere, even after the
 * rollback. CloudFormation replaces the rule.
 *
 * Two groups: `Src` (its description changes, which replaces it) and `Dst`.
 * `Dst` holds two standalone rules, `InSg` (2049 from `Src`) and `InCidr` (443
 * from a TEST-NET CIDR, so nothing is opened to the internet).
 * `CDKD_TEST_UPDATE` picks the version: unset is v1; `v2` replaces `Src` and
 * moves `InCidr` to another CIDR; `fail` is `v2` plus a queue AWS refuses
 * (`MessageRetentionPeriod: 10`), created after `InCidr`, so the deploy rolls
 * back after both rules were replaced.
 *
 * covers: AWS::EC2::SecurityGroup, AWS::EC2::SecurityGroupIngress, AWS::EC2::VPC, AWS::SQS::Queue
 */
export class SgIngressSourceReplacementStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env.CDKD_TEST_UPDATE ?? '';
    const v2 = mode === 'v2' || mode === 'fail';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.98.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    cdk.Tags.of(vpc).add('cdkd-integ', 'sg-ingress-source-replacement');

    const src = new ec2.CfnSecurityGroup(this, 'Src', {
      groupDescription: `cdkd 7071 source ${v2 ? 'v2' : 'v1'}`,
      vpcId: vpc.vpcId,
    });
    const dst = new ec2.CfnSecurityGroup(this, 'Dst', {
      groupDescription: 'cdkd 7071 destination',
      vpcId: vpc.vpcId,
    });
    new ec2.CfnSecurityGroupIngress(this, 'InSg', {
      groupId: dst.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 2049,
      toPort: 2049,
      sourceSecurityGroupId: src.attrGroupId,
    });
    const inCidr = new ec2.CfnSecurityGroupIngress(this, 'InCidr', {
      groupId: dst.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      cidrIp: v2 ? '192.0.2.0/24' : '198.51.100.0/24',
    });

    if (mode === 'fail') {
      const bad = new sqs.CfnQueue(this, 'Bad', { messageRetentionPeriod: 10 });
      bad.addDependency(inCidr);
    }
  }
}
