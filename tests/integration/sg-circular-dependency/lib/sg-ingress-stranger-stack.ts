import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Ownership arm for go-to-k/cdkd#4355 — a stack whose only resource is an
 * `AWS::EC2::SecurityGroupIngress` IDENTICAL to a rule that already exists on
 * a security group this stack does not own.
 *
 * verify.sh adds the rule by hand (`aws ec2 authorize-security-group-ingress`)
 * to the ambiguity-arm stack's group, then deploys this stack against that
 * group. `AuthorizeSecurityGroupIngress` answers `InvalidPermission.Duplicate`,
 * and cdkd used to treat that as success: it recorded the hand-made rule as
 * this stack's, and `cdkd destroy` then revoked it. The deploy must now REFUSE
 * naming the existing rule, a second deploy must refuse again (the first
 * refusal must not become evidence that this stack attempted the rule), and
 * the hand-made rule must survive this stack's destroy.
 *
 * The group id comes from context (`strangerGroupId`), as an app importing an
 * existing group passes it, so the stack is
 * only instantiated when verify.sh passes it. The UPDATE arm deploys the rule
 * on another range first, then on the hand-made one: `CidrIp` is create-only,
 * so the replacement's create-first must refuse too, and leave both rules in
 * place.
 */
export class SgIngressStrangerStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { groupId: string; cidr: string; failAfter?: boolean }
  ) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'sg-circular-dependency');

    // L1 with a FIXED construct id rather than the issue's
    // `SecurityGroup.fromSecurityGroupId(...).addIngressRule(...)`: the L2
    // derives the logical id from the peer range, so moving the range would be
    // a DELETE + CREATE and never reach the replacement. Both synthesize the
    // same standalone `AWS::EC2::SecurityGroupIngress`.
    // verify.sh adds 10.63.0.0/16 out of band; the UPDATE arm first deploys
    // another range (`-c strangerCidr=...`) and then moves the rule onto it.
    const stranger = new ec2.CfnSecurityGroupIngress(this, 'StrangerIngress', {
      groupId: props.groupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      cidrIp: props.cidr,
      description: 'Identical to a rule another owner added (go-to-k/cdkd#4355)',
    });

    // go-to-k/cdkd#4402 POP arm (`-c strangerFailAfter=1`): a rule on a group
    // that does not exist, created only AFTER StrangerIngress, so the deploy
    // fails with a definite InvalidGroup.NotFound once StrangerIngress has
    // completed. The clean automatic rollback then reverts StrangerIngress and
    // pops the run's segment — the real carry of `supersededLogicalIds`.
    if (props.failAfter) {
      const fail = new ec2.CfnSecurityGroupIngress(this, 'FailIngress', {
        groupId: 'sg-0000000000000000f',
        ipProtocol: 'tcp',
        fromPort: 5433,
        toPort: 5433,
        cidrIp: '10.63.0.0/16',
      });
      fail.addDependency(stranger);
    }
  }
}
