import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Failure-seeking fixture for LONG GetAtt resolution chains.
 *
 * Goal: surface computed-attribute resolution bugs where each resource's
 * POST-CREATE attribute (an ARN / generated name only known after the
 * AWS create call) feeds the NEXT resource's property. The chain is
 * 5 resources deep and deliberately MIXES the two provisioning paths so a
 * wrong/late attribute resolution on EITHER path (SDK provider's
 * `attributes` write, or CC-API's stored attributes + `constructAttribute`
 * fallback) is pinpointed by the failing link.
 *
 * Chain topology (each arrow = "left's post-create attribute feeds right"):
 *
 *   A  SNS::Topic              (SDK)    --TopicArn-->            B  AlarmActions[0]
 *   B  CloudWatch::Alarm       (SDK)    --AlarmName(Ref)-->      C  AlarmRule
 *   C  CloudWatch::CompositeAlarm (CC-API, unregistered) --Arn--> D  SSM Parameter Value
 *   D  SSM::Parameter          (SDK)    --Name(Ref)/Value-->     E  Lambda env
 *   E  Lambda::Function        (SDK)    -- terminal multi-attr Fn::Sub consumer
 *
 * E's environment is a multi-attribute Fn::Sub that pulls A.TopicArn,
 * C.Arn (the CC-API post-create attribute), and D (Ref name) at once, so
 * the terminal link exercises several upstream attributes in one
 * resolution pass.
 *
 * The CRITICAL link is C -> D / C -> E: `AWS::CloudWatch::CompositeAlarm`
 * is NOT a registered SDK provider, so it routes via Cloud Control API and
 * its `Arn` attribute comes purely from CC-API's stored attributes (there
 * is no `constructAttribute` synthesis case for it). A regression in the
 * CC-API attribute capture / resolution path shows up as a malformed or
 * empty `${C.Arn}` substitution downstream.
 *
 * Cheap-by-design: SNS / CloudWatch / SSM / IAM / Lambda / Logs only, no
 * VPC, no NAT, no asset publishing (Lambda uses inline code).
 *
 * Every named resource carries a `cdkd:integ-fixture` tag so the destroy
 * assertions can confirm removal by an OWN tag (NOT `aws:cdk:path`).
 */
export class DeepGetAttChainsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const FIXTURE_TAG_KEY = 'cdkd:integ-fixture';
    const FIXTURE_TAG_VALUE = 'deep-getatt-chains';
    cdk.Tags.of(this).add(FIXTURE_TAG_KEY, FIXTURE_TAG_VALUE);

    // Fixed names so verify.sh can locate the AWS resources deterministically.
    const TOPIC_NAME = 'cdkd-getatt-chain-topic';
    const ALARM_NAME = 'cdkd-getatt-chain-alarm';
    const COMPOSITE_ALARM_NAME = 'cdkd-getatt-chain-composite';
    const PARAM_NAME = '/cdkd/getatt-chain/composite-and-alarm-arns';
    const FUNCTION_NAME = 'cdkd-getatt-chain-fn';

    // --- A: SNS Topic (SDK). Post-create attribute: TopicArn -----------
    const topic = new sns.CfnTopic(this, 'ChainTopic', {
      topicName: TOPIC_NAME,
    });

    // --- B: CloudWatch Alarm (SDK). Consumes A.TopicArn as an alarm
    // action (A.attr -> B prop). Post-create attribute: Arn; Ref = name. --
    const alarm = new cloudwatch.CfnAlarm(this, 'ChainAlarm', {
      alarmName: ALARM_NAME,
      alarmDescription: 'GetAtt-chain link B (consumes SNS TopicArn)',
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      threshold: 1,
      // Metric on the SNS topic so the alarm has a meaningful subject.
      namespace: 'AWS/SNS',
      metricName: 'NumberOfMessagesPublished',
      period: 300,
      statistic: 'Sum',
      treatMissingData: 'notBreaching',
      dimensions: [
        {
          // Fn::GetAtt(A, 'TopicName') -> dimension value (A.attr -> B prop).
          name: 'TopicName',
          value: topic.attrTopicName,
        },
      ],
      // Fn::GetAtt(A, 'TopicArn') -> AlarmActions[0] (A.attr -> B prop).
      alarmActions: [topic.ref],
    });

    // --- C: CloudWatch CompositeAlarm (CC-API; unregistered SDK type).
    // Consumes B via its name (Ref) inside the AlarmRule Fn::Sub
    // (B.attr -> C prop). Post-create attribute: Arn (CC-API stored). -----
    const composite = new cloudwatch.CfnCompositeAlarm(this, 'ChainComposite', {
      alarmName: COMPOSITE_ALARM_NAME,
      alarmDescription: 'GetAtt-chain link C (CC-API; references alarm B by name)',
      // Fn::Sub("ALARM(${ChainAlarm})") — ${ChainAlarm} is a Ref to B's name.
      alarmRule: cdk.Fn.sub('ALARM(${AlarmName})', {
        AlarmName: alarm.ref,
      }),
    });

    // --- D: SSM Parameter (SDK). Value is a multi-attr Fn::Sub joining
    // C.Arn (CC-API post-create attr) + B.Arn (SDK post-create attr)
    // (C.attr + B.attr -> D prop). Post-create attribute: Ref = name. ------
    const param = new ssm.CfnParameter(this, 'ChainParam', {
      name: PARAM_NAME,
      type: 'String',
      description: 'GetAtt-chain link D (joins composite-alarm Arn + alarm Arn)',
      // Fn::Sub joining two upstream post-create ARNs.
      value: cdk.Fn.sub('composite=${CompositeArn};alarm=${AlarmArn}', {
        CompositeArn: composite.attrArn,
        AlarmArn: alarm.attrArn,
      }),
    });

    // --- E: Lambda Function (SDK). Terminal multi-attribute consumer.
    // Its environment Fn::Subs pull A.TopicArn, C.Arn, D(Ref name), and
    // D's Value-derived param name all at once. -------------------------
    const fnRole = new iam.CfnRole(this, 'ChainFnRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [
        // Fn::Sub with the AWS::Partition pseudo parameter.
        cdk.Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const fn = new lambda.CfnFunction(this, 'ChainFn', {
      functionName: FUNCTION_NAME,
      runtime: 'nodejs20.x',
      handler: 'index.handler',
      // Fn::GetAtt(E-role, 'Arn') (role.attr -> Lambda prop).
      role: fnRole.attrArn,
      code: {
        zipFile: [
          'exports.handler = async () => {',
          '  return {',
          '    statusCode: 200,',
          '    body: JSON.stringify({',
          '      topicArn: process.env.UPSTREAM_TOPIC_ARN,',
          '      compositeArn: process.env.UPSTREAM_COMPOSITE_ARN,',
          '      paramName: process.env.UPSTREAM_PARAM_NAME,',
          '      joined: process.env.UPSTREAM_JOINED,',
          '    }),',
          '  };',
          '};',
        ].join('\n'),
      },
      environment: {
        variables: {
          // Fn::GetAtt(A, 'TopicArn') — SDK post-create attr.
          UPSTREAM_TOPIC_ARN: topic.ref,
          // Fn::GetAtt(C, 'Arn') — CC-API post-create attr (the critical link).
          UPSTREAM_COMPOSITE_ARN: composite.attrArn,
          // Ref(D) — SSM parameter name.
          UPSTREAM_PARAM_NAME: param.ref,
          // Multi-attribute Fn::Sub pulling A.TopicArn + C.Arn + D(Ref) at once.
          UPSTREAM_JOINED: cdk.Fn.sub('topic=${TopicArn}|composite=${CompositeArn}|param=${ParamName}', {
            TopicArn: topic.ref,
            CompositeArn: composite.attrArn,
            ParamName: param.ref,
          }),
        },
      },
    });

    // Outputs surface each chained attribute for cross-checking in verify.sh.
    new cdk.CfnOutput(this, 'TopicArnOut', { value: topic.ref });
    new cdk.CfnOutput(this, 'AlarmArnOut', { value: alarm.attrArn });
    new cdk.CfnOutput(this, 'CompositeArnOut', { value: composite.attrArn });
    new cdk.CfnOutput(this, 'ParamNameOut', { value: param.ref });
    new cdk.CfnOutput(this, 'FunctionNameOut', { value: fn.ref });
  }
}
