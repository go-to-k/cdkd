import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * An IoT topic rule whose SQS action role is created in the SAME stack
 * (issue #6559).
 *
 * `AWS::IoT::TopicRule` has no SDK provider, so it is created through Cloud
 * Control seconds after the role, and IoT refuses it with "AWS IoT
 * (iot.amazonaws.com) is unable to assume role (sts:AssumeRole)" until IAM has
 * propagated the role. cdkd now retries that wording as IAM propagation.
 * CDK's stable library has no topic rule L2, so the rule is the L1
 * `CfnTopicRule`, with no `ruleName`, as an app writes it.
 *
 * `CDKD_TEST_UPDATE=true` changes the rule's SQL and description and removes
 * the error action: all mutable, so the rule must be updated in place.
 *
 * covers: AWS::IoT::TopicRule
 */
export class IotTopicRuleRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const updating = process.env.CDKD_TEST_UPDATE === 'true';

    const queue = new sqs.Queue(this, 'RuleQueue');
    const errorQueue = new sqs.Queue(this, 'ErrorQueue');
    const role = new iam.Role(this, 'RuleRole', {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
    });
    queue.grantSendMessages(role);
    errorQueue.grantSendMessages(role);

    const rule = new iot.CfnTopicRule(this, 'Rule', {
      topicRulePayload: {
        sql: updating
          ? "SELECT temp FROM 'cdkd-integ/iot-topic-rule-role/+' WHERE temp > 30"
          : "SELECT * FROM 'cdkd-integ/iot-topic-rule-role/+'",
        awsIotSqlVersion: '2016-03-23',
        description: updating ? 'updated' : 'created',
        actions: [{ sqs: { queueUrl: queue.queueUrl, roleArn: role.roleArn, useBase64: false } }],
        ...(updating
          ? {}
          : { errorAction: { sqs: { queueUrl: errorQueue.queueUrl, roleArn: role.roleArn } } }),
      },
    });

    new cdk.CfnOutput(this, 'RuleName', { value: rule.ref });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
  }
}
