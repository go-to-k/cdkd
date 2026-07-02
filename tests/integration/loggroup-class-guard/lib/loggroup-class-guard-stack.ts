import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';

// cdkd LogGroupClass update-guard integ probe.
//
// Phase 1 (base): LogGroupClass STANDARD.
// Phase 2 (CDKD_TEST_UPDATE=true): LogGroupClass INFREQUENT_ACCESS.
//
// CloudFormation documents LogGroupClass as "Update requires: Updates are not
// supported" — there is no CloudWatch Logs API to change a log group's class
// after creation, and a CFn stack update carrying the change FAILS. cdkd
// previously silently DROPPED the change (deploy reported success while AWS
// kept the old class, and state recorded the new one so the next diff saw no
// change and it could never self-heal). The fix throws the typed
// ResourceUpdateNotSupportedError with an actionable message; `--replace`
// (plus `--force-stateful-recreation`, since a log group retains data)
// recreates the group under the new class. verify.sh exercises BOTH paths.
export class LoggroupClassGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const toInfrequentAccess = process.env.CDKD_TEST_UPDATE === 'true';

    const lg = new logs.LogGroup(this, 'ClassLg', {
      retention: logs.RetentionDays.ONE_DAY,
      logGroupClass: toInfrequentAccess
        ? logs.LogGroupClass.INFREQUENT_ACCESS
        : logs.LogGroupClass.STANDARD,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'LgName', { value: lg.logGroupName });
  }
}
