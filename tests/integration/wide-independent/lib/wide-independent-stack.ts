import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/** Resources per type: 4 types x 12 = 48, none depending on another. */
export const PER_TYPE = 12;
/** The Cloud Control mode's resources per type: 2 types x 24 = 48. */
export const CC_PER_TYPE = 24;

/**
 * A wide stack: more independent resources than the default `--concurrency`
 * (10), so some wait for a slot (issue #5209). Every name carries the run's
 * `CDKD_WIDE_RUN` token, so a re-create in the same run never meets a name
 * AWS is still releasing (SQS holds a deleted queue's name for 60s).
 *
 * `CDKD_WIDE_KIND=cc` swaps them for 48 resources of types cdkd has no SDK
 * provider for, so every one goes through Cloud Control (issue #5242).
 *
 * covers: AWS::SQS::Queue
 * covers: AWS::SNS::Topic
 * covers: AWS::SSM::Parameter
 * covers: AWS::Logs::LogGroup
 * covers: AWS::SSM::Document
 * covers: AWS::Athena::WorkGroup
 */
export class WideIndependentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const run = process.env.CDKD_WIDE_RUN ?? 'r0';
    const prefix = `cdkd-wide-${run}`;
    if (process.env.CDKD_WIDE_KIND === 'cc') {
      for (let i = 0; i < CC_PER_TYPE; i++) {
        new ssm.CfnDocument(this, `Document${i}`, {
          name: `${prefix}-doc-${i}`,
          documentType: 'Command',
          content: {
            schemaVersion: '2.2',
            description: `wide-independent document ${i}`,
            mainSteps: [
              {
                action: 'aws:runShellScript',
                name: `step${i}`,
                inputs: { runCommand: [`echo "wide ${i}"`] },
              },
            ],
          },
        });
        new athena.CfnWorkGroup(this, `WorkGroup${i}`, {
          name: `${prefix}-wg-${i}`,
          recursiveDeleteOption: true,
          workGroupConfiguration: {
            enforceWorkGroupConfiguration: false,
            publishCloudWatchMetricsEnabled: false,
            requesterPaysEnabled: false,
          },
        });
      }
      return;
    }
    for (let i = 0; i < PER_TYPE; i++) {
      new sqs.Queue(this, `Queue${i}`, {
        queueName: `${prefix}-q-${i}`,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      new sns.Topic(this, `Topic${i}`, { topicName: `${prefix}-t-${i}` });
      new ssm.StringParameter(this, `Param${i}`, {
        parameterName: `/${prefix}/p-${i}`,
        stringValue: `value-${i}`,
      });
      new logs.LogGroup(this, `LogGroup${i}`, {
        logGroupName: `/${prefix}/lg-${i}`,
        retention: logs.RetentionDays.ONE_DAY,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }
  }
}
