import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Fixture for `cdkd rollback` of a replacement that deleted the old resource
 * first and re-created it under the SAME physical id (issue #5096).
 *
 * covers: AWS::DynamoDB::Table
 * covers: AWS::Logs::LogGroup
 * covers: AWS::Logs::LogStream
 *
 * Env-parameterized so verify.sh drives every phase from one app:
 *
 *   - `Table` -- a fixed-name table whose partition key is `TABLE_KEY`
 *     (default `pk`). A key change is create-only; under
 *     `cdkd deploy --replace --force-stateful-recreation` the create-first
 *     attempt collides on the name, so the old table is deleted first and the
 *     new one created under the same name. The rollback must REVERSE that
 *     (delete, re-create with key `pk`), not revert it in place.
 *   - `LogGroup` + `LogStream` -- a fixed-name log group of class `LOG_CLASS`
 *     (default `STANDARD`) holding a fixed-name log stream. A class change is
 *     not updatable, so `--replace` re-creates the group under the same name,
 *     and the stream (stored inside it) with it. Reversing that would delete
 *     the group again and take the stream with it, so the rollback must
 *     REFUSE it before deleting anything. A stream, not a metric filter: the
 *     INFREQUENT_ACCESS class supports no metric filter.
 *   - `FailingQueue` -- added only when `INJECT_FAIL=true`: an out-of-range
 *     `messageRetentionPeriod` AWS rejects. It depends on every other
 *     resource, so the replacements complete and are journaled first.
 */
export class RollbackSameIdRecreateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-same-id-recreate');

    const key = process.env.TABLE_KEY ?? 'pk';
    const table = new dynamodb.Table(this, 'Table', {
      tableName: `${this.stackName}-table`,
      partitionKey: { name: key, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroupClass =
      process.env.LOG_CLASS === 'INFREQUENT_ACCESS'
        ? logs.LogGroupClass.INFREQUENT_ACCESS
        : logs.LogGroupClass.STANDARD;
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/cdkd-integ/${this.stackName}`,
      logGroupClass,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const stream = new logs.LogStream(this, 'LogStream', {
      logGroup,
      logStreamName: 'cdkd-integ-stream',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    if (process.env.INJECT_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(table, logGroup, stream);
    }
  }
}
