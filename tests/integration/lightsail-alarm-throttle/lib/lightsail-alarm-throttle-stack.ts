import * as cdk from 'aws-cdk-lib';
import * as lightsail from 'aws-cdk-lib/aws-lightsail';
import type { Construct } from 'constructs';

/**
 * Many Lightsail alarms on one instance, created in one burst (go-to-k/cdkd#6830).
 *
 * `PutAlarm` is limited to 3 requests per second, and the Cloud Control
 * handler fails the create with `ErrorCode: Throttling` once its own SDK
 * retries run out. cdkd must retry that failure instead of rolling back.
 * Lightsail allows two alarms per metric per resource, so the 16 alarms are
 * two per instance metric.
 *
 * covers: AWS::Lightsail::Instance
 * covers: AWS::Lightsail::Alarm
 */
export class LightsailAlarmThrottleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const instance = new lightsail.CfnInstance(this, 'Instance', {
      instanceName: `${this.stackName}-instance`,
      blueprintId: 'amazon_linux_2023',
      bundleId: 'nano_ipv6_3_0',
    });

    const metrics = [
      'CPUUtilization',
      'NetworkIn',
      'NetworkOut',
      'StatusCheckFailed',
      'StatusCheckFailed_Instance',
      'StatusCheckFailed_System',
      'BurstCapacityTime',
      'BurstCapacityPercentage',
    ];
    metrics.forEach((metricName, index) => {
      for (const slot of [1, 2]) {
        new lightsail.CfnAlarm(this, `Alarm${index}x${slot}`, {
          alarmName: `${this.stackName}-alarm-${index}-${slot}`,
          monitoredResourceName: instance.ref,
          metricName,
          comparisonOperator: 'GreaterThanOrEqualToThreshold',
          evaluationPeriods: 1,
          threshold: slot === 1 ? 90 : 99,
        });
      }
    });
  }
}
