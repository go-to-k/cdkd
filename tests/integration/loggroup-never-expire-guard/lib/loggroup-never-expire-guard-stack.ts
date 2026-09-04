import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';

// cdkd never-expire log-group stateful-guard integ probe (issue #2558).
//
// Both log groups declare `retention: RetentionDays.INFINITE`, which
// aws-cdk-lib maps to an ABSENT `RetentionInDays` in the synthesized template
// (`log-group.ts`: an INFINITE retention is turned into `undefined`, and the
// L2's own default would otherwise be TWO_YEARS). That absence IS the feature
// under test: in CloudWatch Logs "no retention policy" means NEVER EXPIRE, and
// the stateful guard used to read it as "this log group holds nothing" and
// DELETE + CREATE the group on a plain `cdkd deploy`. A fixture that let the
// L2 default apply would exercise the `has-retention` branch instead and pass
// vacuously, so verify.sh asserts the deployed groups report no retention.
//
// `DataLg` carries an explicit name so the rename below is a CREATE-ONLY
// property change (`LogGroupName`), which is what drives the property-driven
// replacement a plain deploy reaches with no flag at all:
//
//   base                      -> /cdkd-integ/never-expire-guard/data
//   CDKD_TEST_UPDATE=rename   -> /cdkd-integ/never-expire-guard/data-renamed
//
// `EmptyLg` is never renamed: it is the NEGATIVE polarity, a genuinely
// disposable never-expiring log group that the pre-flight probe must still
// allow through with no consent flag.
export class LoggroupNeverExpireGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const renamed = (process.env.CDKD_TEST_UPDATE ?? '').includes('rename');

    const dataLg = new logs.LogGroup(this, 'DataLg', {
      logGroupName: renamed
        ? '/cdkd-integ/never-expire-guard/data-renamed'
        : '/cdkd-integ/never-expire-guard/data',
      retention: logs.RetentionDays.INFINITE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const emptyLg = new logs.LogGroup(this, 'EmptyLg', {
      logGroupName: '/cdkd-integ/never-expire-guard/empty',
      retention: logs.RetentionDays.INFINITE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'DataLgName', { value: dataLg.logGroupName });
    new cdk.CfnOutput(this, 'EmptyLgName', { value: emptyLg.logGroupName });
  }
}
