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
 * Two unnamed thing types ride the same update (go-to-k/cdkd#7083).
 * CloudFormation replaces a thing type when `ThingTypeProperties` changes its
 * `SearchableAttributes` or `ThingTypeDescription`, and updates it in place on
 * a `Mqtt5Configuration` change (measured). `SearchThingType` gains a
 * searchable attribute, so cdkd must replace it; `MqttThingType` changes only
 * its propagated user property key, so cdkd must keep it.
 *
 * covers: AWS::IoT::TopicRule
 * covers: AWS::IoT::ThingType
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

    const propagated = (key: string) => ({
      propagatingAttributes: [{ userPropertyKey: key, thingAttribute: 'serial' }],
    });
    const searchType = new iot.CfnThingType(this, 'SearchThingType', {
      thingTypeProperties: {
        thingTypeDescription: 'cdkd integ',
        searchableAttributes: updating ? ['serial', 'model'] : ['serial'],
      },
    });
    const mqttType = new iot.CfnThingType(this, 'MqttThingType', {
      thingTypeProperties: {
        thingTypeDescription: 'cdkd integ',
        mqtt5Configuration: propagated(updating ? 'k2' : 'k1'),
      },
    });

    new cdk.CfnOutput(this, 'RuleName', { value: rule.ref });
    new cdk.CfnOutput(this, 'SearchThingTypeName', { value: searchType.ref });
    new cdk.CfnOutput(this, 'MqttThingTypeName', { value: mqttType.ref });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
  }
}
