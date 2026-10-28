import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/** Fixed group names, so verify.sh can read and sweep them by name. */
export const PEER_A = 'cdkd-integ-sgname-peer-a';
export const PEER_B = 'cdkd-integ-sgname-peer-b';
export const MAIN = 'cdkd-integ-sgname-main';

/**
 * Issue #5478: an inline `AWS::EC2::SecurityGroup` ingress rule that names its
 * peer with `SourceSecurityGroupName`. The member reaches only a default-VPC
 * group, so no group here sets `VpcId`: all three land in the region's default
 * VPC (verify.sh skips when the region has none).
 *
 * Phase 1 names PEER_A; the update phase (CDKD_TEST_UPDATE=true) names PEER_B,
 * which CloudFormation applies as a revoke of the old rule and an authorize of
 * the new one on the same group.
 *
 * covers: AWS::EC2::SecurityGroup
 */
export class Ec2SgSourceGroupNameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const peerA = new ec2.CfnSecurityGroup(this, 'PeerA', {
      groupName: PEER_A,
      groupDescription: 'cdkd #5478 peer A',
    });
    const peerB = new ec2.CfnSecurityGroup(this, 'PeerB', {
      groupName: PEER_B,
      groupDescription: 'cdkd #5478 peer B',
    });
    const main = new ec2.CfnSecurityGroup(this, 'Main', {
      groupName: MAIN,
      groupDescription: 'cdkd #5478 group whose ingress names its peer',
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          sourceSecurityGroupName: isUpdate ? PEER_B : PEER_A,
        },
      ],
    });
    // A name is no reference, so the order the rule needs is declared.
    main.addDependency(peerA);
    main.addDependency(peerB);
  }
}
