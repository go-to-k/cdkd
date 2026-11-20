import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

/**
 * Two listener rules whose conditions CDK synthesizes in the
 * `PathPatternConfig` / `HostHeaderConfig` / `HttpHeaderConfig` form
 * (go-to-k/cdkd#6663).
 * `CDKD_TEST_UPDATE=true` changes RuleA's action and RuleB's priority while
 * the conditions stay the same: the update the Cloud Control read model's
 * duplicate `Values` used to make `ModifyRule` refuse.
 */
export class AlbListenerRuleUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env['CDKD_TEST_UPDATE'] === 'true';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'pub', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const lb = new elbv2.ApplicationLoadBalancer(this, 'Lb', { vpc, internetFacing: true });
    const listener = lb.addListener('Http', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'none',
      }),
    });

    new elbv2.ApplicationListenerRule(this, 'RuleA', {
      listener,
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/a*']),
        elbv2.ListenerCondition.httpHeader('X-Fixture', ['yes']),
      ],
      action: elbv2.ListenerAction.fixedResponse(200, {
        contentType: 'text/plain',
        messageBody: isUpdate ? 'rule-a-v2' : 'rule-a-v1',
      }),
    });
    new elbv2.ApplicationListenerRule(this, 'RuleB', {
      listener,
      priority: isUpdate ? 25 : 20,
      conditions: [
        elbv2.ListenerCondition.hostHeaders(['b.example.com']),
        elbv2.ListenerCondition.pathPatterns(['/b*']),
      ],
      action: elbv2.ListenerAction.fixedResponse(200, {
        contentType: 'text/plain',
        messageBody: 'rule-b',
      }),
    });

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'LoadBalancerArn', { value: lb.loadBalancerArn });
    new cdk.CfnOutput(this, 'ListenerArn', { value: listener.listenerArn });
  }
}
