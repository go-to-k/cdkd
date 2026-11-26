import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/**
 * A standalone ingress rule whose source is a secret reference
 * (go-to-k/cdkd#7084).
 *
 * The rule's `CidrIp` is `{{resolve:secretsmanager:<name>}}`, so cdkd records
 * it masked and cannot compare the old source with the new one. Moving the
 * rule to another secret replaces it: the create-first create authorizes the
 * new rule under the old physical id and the deploy refuses it as a
 * name-idempotent create. The rule's AWS-minted `sgr-` id proves it was a new
 * rule, so cdkd deletes it again before refusing instead of leaving it open
 * and untracked. `--replace` then completes the move.
 *
 * `CDKD_7084_SECRET` names the secret (verify.sh creates both, outside the
 * stack, so no secret value is in the template).
 *
 * covers: AWS::EC2::SecurityGroup, AWS::EC2::SecurityGroupIngress, AWS::EC2::VPC
 */
export class SgIngressSecretSourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const secretName = process.env.CDKD_7084_SECRET ?? 'cdkd-7084-cidr-a';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.99.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    cdk.Tags.of(vpc).add('cdkd-integ', 'sg-ingress-secret-source');

    const dst = new ec2.CfnSecurityGroup(this, 'Dst', {
      groupDescription: 'cdkd 7084 destination',
      vpcId: vpc.vpcId,
    });
    new ec2.CfnSecurityGroupIngress(this, 'InCidr', {
      groupId: dst.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      cidrIp: cdk.SecretValue.secretsManager(secretName).unsafeUnwrap(),
    });
  }
}
