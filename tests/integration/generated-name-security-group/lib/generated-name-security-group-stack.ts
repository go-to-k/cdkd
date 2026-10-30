import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

export interface GeneratedNameSecurityGroupStackProps extends cdk.StackProps {
  /** Join this VPC instead of creating one (the peer stack). */
  readonly sharedVpcId?: string;
}

/**
 * An un-named `AWS::EC2::SecurityGroup` (issue #5095).
 *
 * Its SDK provider used to send the bare logical id as `GroupName`, which is
 * unique per VPC: a replacement asked for the name the old group still held,
 * and a second stack with the same logical id in the same VPC collided. On a
 * stack with a stack instance id the name is now `{stack}-{logicalId}-{suffix}`,
 * the suffix hashing the id and the name generation.
 *
 * The first stack creates a bare VPC (no subnets: free) and the group in it;
 * the peer stack, the same class, puts its own `Group` in that VPC.
 * `GNSG_DESCRIPTION` sets `GroupDescription`, a create-only property, so a
 * new value replaces the group.
 *
 * covers: AWS::EC2::SecurityGroup, AWS::EC2::VPC
 */
export class GeneratedNameSecurityGroupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GeneratedNameSecurityGroupStackProps = {}) {
    super(scope, id, props);

    let vpcId = props.sharedVpcId;
    if (vpcId === undefined) {
      const vpc = new ec2.CfnVPC(this, 'Vpc', {
        cidrBlock: '10.95.0.0/16',
        tags: [{ key: 'cdkd-integ', value: 'generated-name-security-group' }],
      });
      vpcId = vpc.ref;
    }

    new ec2.CfnSecurityGroup(this, 'Group', {
      groupDescription: process.env.GNSG_DESCRIPTION ?? 'cdkd 5095 v1',
      vpcId,
    });
  }
}
