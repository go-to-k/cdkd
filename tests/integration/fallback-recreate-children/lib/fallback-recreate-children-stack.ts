import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * Integ fixture for issue #4444: the update-failure fallback re-creates a
 * resource under the same id, and the children stored inside it come back.
 *
 * The parent is a fixed-name log group whose `LogGroupClass` changes with
 * `CDKD_TEST_PHASE=reclass`. CloudWatch Logs cannot change a class in place,
 * so the provider refuses the update (`ResourceUpdateNotSupportedError`) and
 * `--replace` deletes and re-creates the log group under the same name. Its
 * log stream is deleted with it, and the diff never promoted it (the log
 * group was an in-place row), so before the fix the stream was skipped as
 * unchanged and stayed gone while state recorded it. (A log stream, not a
 * metric filter: the Infrequent Access class supports no metric or
 * subscription filters, so a filter could not be re-created on it.)
 *
 * covers: AWS::Logs::LogGroup
 * covers: AWS::Logs::LogStream
 */
export class FallbackRecreateChildrenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const reclass = process.env.CDKD_TEST_PHASE === 'reclass';

    const group = new logs.CfnLogGroup(this, 'ParentLogGroup', {
      logGroupName: `/cdkd-integ/${this.stackName}/parent`,
      logGroupClass: reclass ? 'INFREQUENT_ACCESS' : 'STANDARD',
      retentionInDays: 1,
    });
    group.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new logs.CfnLogStream(this, 'ChildStream', {
      logGroupName: group.ref,
      logStreamName: 'child-stream',
    });
  }
}
