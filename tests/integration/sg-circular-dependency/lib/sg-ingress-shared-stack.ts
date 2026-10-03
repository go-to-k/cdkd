import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * go-to-k/cdkd#4492: two `AWS::EC2::SecurityGroupIngress` resources of ONE
 * stack describing the same rule — what an Aurora cluster plus a
 * `DatabaseProxy` on one security group emits, since CDK cannot dedupe a rule
 * whose port is a token. AWS keeps one rule for both; only the descriptions
 * differ. The group is the ambiguity arm's, outside this stack, so a revoke is
 * observable after this stack is gone.
 *
 * - `twin: false` drops `TwinIngress` (the template-removal DELETE of one
 *   holder while the other survives).
 * - `failAfter: true` adds a rule on a group that does not exist, created
 *   after `TwinIngress`, so the deploy fails and the automatic rollback
 *   deletes the twin it just recorded.
 */
export class SgIngressSharedStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { groupId: string; twin: boolean; failAfter: boolean }
  ) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'sg-circular-dependency');

    const rule = {
      groupId: props.groupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      cidrIp: '10.65.0.0/16',
    };
    new ec2.CfnSecurityGroupIngress(this, 'ExplicitIngress', {
      ...rule,
      description: 'Explicit rule (go-to-k/cdkd#4492)',
    });
    if (props.twin) {
      const twin = new ec2.CfnSecurityGroupIngress(this, 'TwinIngress', {
        ...rule,
        description: 'Same rule from another construct (go-to-k/cdkd#4492)',
      });
      if (props.failAfter) {
        const fail = new ec2.CfnSecurityGroupIngress(this, 'FailIngress', {
          groupId: 'sg-0000000000000000f',
          ipProtocol: 'tcp',
          fromPort: 5433,
          toPort: 5433,
          cidrIp: '10.66.0.0/16',
        });
        fail.addDependency(twin);
      }
    }
  }
}
