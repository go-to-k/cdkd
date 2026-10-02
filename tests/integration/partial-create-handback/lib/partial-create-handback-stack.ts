import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * Fixture for issue #4403: a create API that answers success with a resource
 * already holding the name must not have that resource deleted by the
 * provider's partial-create cleanup when a later step of the same create
 * fails.
 *
 * covers: AWS::ElasticLoadBalancingV2::TargetGroup, AWS::ElasticLoadBalancingV2::LoadBalancer,
 * AWS::SNS::Topic, AWS::Events::Rule, AWS::EC2::VPC, AWS::EC2::Subnet
 *
 * `MODE` (set per phase by verify.sh) picks ONE resource, each with NO
 * explicit name, so cdkd sends its generated `CdkdPcHandback-<logicalId>`.
 * A generated name is never looked up by the deploy's own name probe
 * (#4180 asks only for an explicit name), so an out-of-band resource under it
 * reaches the create. Each declares a wiring step AWS rejects, so the create
 * fails AFTER the main call:
 *
 *   - `tg`: a `lambda` target group (CreateTargetGroup hands back an existing
 *     one of identical settings) with an attribute key AWS does not
 *     recognize, so ModifyTargetGroupAttributes fails.
 *   - `topic`: a topic (CreateTopic hands back an existing one) with a
 *     DataProtectionPolicy missing its required members, so
 *     SetTopicAttributes fails.
 *   - `rule`: a scheduled rule (PutRule overwrites an existing one) with a
 *     target Id past the 64-character limit, so PutTargets fails.
 *   - `lbvpc` / `lb`: the load balancer needs a subnet the out-of-band holder
 *     can share, so it takes two phases. `lbvpc` deploys only a VPC and one
 *     subnet (no internet gateway); `lb` adds an internal network load
 *     balancer in it (CreateLoadBalancer hands back an existing one of
 *     identical settings) with an attribute key AWS does not recognize, so
 *     ModifyLoadBalancerAttributes fails after the `active` wait.
 */
export class PartialCreateHandbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env.MODE;
    if (mode === 'tg') {
      const tg = new elbv2.CfnTargetGroup(this, 'Tg', {
        targetType: 'lambda',
        targetGroupAttributes: [{ key: 'cdkd.not.an.attribute', value: 'x' }],
      });
      tg.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    } else if (mode === 'topic') {
      const topic = new sns.CfnTopic(this, 'Topic', {
        dataProtectionPolicy: { Name: 'cdkd-invalid' },
      });
      topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    } else if (mode === 'rule') {
      const rule = new events.CfnRule(this, 'Rule', {
        scheduleExpression: 'rate(1 day)',
        state: 'DISABLED',
        targets: [
          {
            id: 'x'.repeat(65),
            arn: `arn:${cdk.Aws.PARTITION}:sns:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:cdkd-pc-handback-none`,
          },
        ],
      });
      rule.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    } else if (mode === 'lbvpc' || mode === 'lb') {
      const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.89.0.0/24' });
      const subnet = new ec2.CfnSubnet(this, 'Subnet', {
        vpcId: vpc.ref,
        cidrBlock: '10.89.0.0/26',
        availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs()),
      });
      if (mode === 'lb') {
        const lb = new elbv2.CfnLoadBalancer(this, 'Lb', {
          type: 'network',
          scheme: 'internal',
          subnets: [subnet.ref],
          loadBalancerAttributes: [{ key: 'cdkd.not.an.attribute', value: 'x' }],
        });
        lb.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      }
    } else {
      throw new Error('MODE must be tg, topic, rule, lbvpc or lb (verify.sh sets it per phase)');
    }
  }
}
