import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';

/**
 * A Cloud Control update inside an object holding a nested create-only path
 * (go-to-k/cdkd#6294).
 *
 * `AWS::Route53::HealthCheck` has no SDK provider, so it goes through Cloud
 * Control. `HealthCheckConfig.MeasureLatency` is create-only and is NOT
 * declared here, so AWS defaults it to `false`. Before the fix, changing
 * `Port` sent `replace /HealthCheckConfig` with the template's object, which
 * drops `MeasureLatency`, and Cloud Control refused the update
 * (`createOnlyProperties [/properties/HealthCheckConfig/MeasureLatency] cannot
 * be updated`). CloudFormation applies the same change in place.
 *
 *   covers: AWS::Route53::HealthCheck
 *
 * Phase 1 deploys Port 8443 / FailureThreshold 5; Phase 2
 * (CDKD_TEST_UPDATE=true) changes them to 443 / 4 in place.
 */
export class CcNestedCreateOnlyUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const updated = process.env.CDKD_TEST_UPDATE === 'true';

    const hc = new route53.CfnHealthCheck(this, 'Hc', {
      healthCheckConfig: {
        type: 'HTTPS',
        fullyQualifiedDomainName: 'example.com',
        resourcePath: '/',
        port: updated ? 443 : 8443,
        requestInterval: 30,
        failureThreshold: updated ? 4 : 5,
        enableSni: true,
      },
      healthCheckTags: [{ key: 'Name', value: `${this.stackName}-hc` }],
    });

    new cdk.CfnOutput(this, 'HealthCheckId', { value: hc.attrHealthCheckId });
  }
}
