import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * A function with its `currentVersion` and an alias `live`, whose ARN CDK
 * exports to the consumer. Phase 2 renames the function: that replaces the
 * function and the alias, and the version's logical id (a hash covering the
 * function name) changes, so the old version is REMOVED from the template
 * while the old alias still points at it (go-to-k/cdkd#6977's shape).
 *
 * covers: AWS::Lambda::Alias
 * covers: AWS::Lambda::Version
 */
export class ProducerStack extends cdk.Stack {
  readonly alias: lambda.Alias;
  constructor(scope: Construct, id: string, props: cdk.StackProps & { updated: boolean }) {
    super(scope, id, props);
    const fn = new lambda.Function(this, 'Fn', {
      functionName: `cdkd-integ-xs-early-del-${props.updated ? 'v2' : 'v1'}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => "ok";'),
    });
    this.alias = new lambda.Alias(this, 'Live', { aliasName: 'live', version: fn.currentVersion });
  }
}

/**
 * A function whose environment imports the producer's alias ARN. With `fail`,
 * a queue AWS refuses (`MessageRetentionPeriod` above its 14-day maximum),
 * created after the function, so the deploy fails once the function moved
 * onto the new alias and rolls back to phase 1's ARN.
 *
 * covers: AWS::Lambda::Function
 */
export class ConsumerStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { alias: lambda.Alias; fail: boolean }
  ) {
    super(scope, id, props);
    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-integ-xs-early-del-cons',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      environment: { ALIAS_ARN: props.alias.functionArn },
    });
    if (props.fail) {
      new sqs.CfnQueue(this, 'Boom', {
        queueName: 'cdkd-integ-xs-early-del-boom',
        messageRetentionPeriod: 9999999,
      }).node.addDependency(fn);
    }
  }
}
