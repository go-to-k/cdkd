import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import type { Construct } from 'constructs';

/**
 * Issue #6242, measured against CloudFormation: `Fn::GetAtt [Asg,
 * AutoScalingGroupARN]` resolved to the group NAME, and `Fn::GetAtt [Rule,
 * RuleName]` to the whole rule ARN, on the default and a custom bus. The ASG
 * runs no instance (capacity 0), so the fixture costs no compute.
 *
 * covers: AWS::AutoScaling::AutoScalingGroup
 * covers: AWS::Events::Rule
 */
export class GetattAsgArnRuleNameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      natGateways: 0,
      maxAzs: 1,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [{ name: 'pub', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const launchTemplate = new ec2.LaunchTemplate(this, 'Lt', {
      instanceType: new ec2.InstanceType('t4g.nano'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
    });
    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      autoScalingGroupName: `${id}-asg`,
      vpc,
      launchTemplate,
      minCapacity: 0,
      maxCapacity: 0,
      desiredCapacity: 0,
    });

    const bus = new events.EventBus(this, 'Bus', { eventBusName: `${id}-bus` });
    const custom = new events.Rule(this, 'RuleCustom', {
      ruleName: `${id}-custom`,
      eventBus: bus,
      eventPattern: { source: ['cdkd.integ'] },
    });
    const onDefault = new events.Rule(this, 'RuleDefault', {
      ruleName: `${id}-default`,
      eventPattern: { source: ['cdkd.integ'] },
    });

    const att = (c: Construct, a: string) =>
      cdk.Token.asString((c.node.defaultChild as cdk.CfnResource).getAtt(a));
    new cdk.CfnOutput(this, 'AsgArn', { value: att(asg, 'AutoScalingGroupARN') });
    new cdk.CfnOutput(this, 'RuleCustomName', { value: att(custom, 'RuleName') });
    new cdk.CfnOutput(this, 'RuleDefaultName', { value: att(onDefault, 'RuleName') });
  }
}
