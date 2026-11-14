import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * go-to-k/cdkd#6309: the JSON types a custom resource handler receives in
 * `ResourceProperties` / `OldResourceProperties`, on Create, Update and Delete.
 *
 * CloudFormation (measured) stringifies every template LITERAL number and
 * boolean, at any depth and through `Fn::If` / `Fn::Select` /
 * `Fn::FindInMap` / `Ref`, but keeps the JSON type of a value an
 * `Fn::GetAtt` serves (a custom resource's SCALAR attribute excepted, which
 * is a string). The `Echo` custom resource below carries one property per
 * measured case; its handler writes the payload it received to an SSM
 * parameter per request type, and verify.sh compares each with the
 * CloudFormation measurement.
 *
 * `Src` is a second custom resource whose `Data` feeds `Echo` through
 * `Fn::GetAtt`. `CDKD_TEST_PHASE` changes one string literal, so the second
 * deploy is an `Update` carrying `OldResourceProperties`.
 */
export class CrPayloadTypesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const prefix = '/cdkd-integ/cr-payload-types';
    const functionName = 'CdkdIntegCrPayloadTypesEcho';

    const logGroup = new logs.LogGroup(this, 'EchoLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // No `logs:CreateLogGroup` (so no AWSLambdaBasicExecutionRole): a log
    // write delivered after the destroy deleted the group must not re-create
    // it. Streams and events only, on the fixture's own group.
    const role = new iam.Role(this, 'EchoRole', {
      roleName: 'CdkdIntegCrPayloadTypesRole',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        Echo: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [logGroup.logGroupArn],
            }),
            new iam.PolicyStatement({
              actions: ['ssm:PutParameter'],
              resources: [
                `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${prefix}/*`,
              ],
            }),
          ],
        }),
      },
    });

    const handler = new lambda.Function(this, 'EchoFn', {
      functionName,
      role,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      logGroup,
      environment: { PREFIX: prefix },
      code: lambda.Code.fromInline(`
import json, os, urllib.request
import boto3

ssm = boto3.client("ssm")

def handler(event, context):
    status = "SUCCESS"
    reason = "ok"
    try:
        if event["LogicalResourceId"] == "Echo":
            record = {"ResourceProperties": event.get("ResourceProperties")}
            if "OldResourceProperties" in event:
                record["OldResourceProperties"] = event["OldResourceProperties"]
            ssm.put_parameter(
                Name=os.environ["PREFIX"] + "/" + event["RequestType"],
                Value=json.dumps(record, sort_keys=True),
                Type="String",
                Overwrite=True,
            )
    except Exception as error:
        status = "FAILED"
        reason = str(error)[:200]
    body = json.dumps({
        "Status": status,
        "Reason": reason,
        "PhysicalResourceId": event.get("PhysicalResourceId") or event["LogicalResourceId"],
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "Data": {"Num": 5, "Bool": True, "Obj": {"n": 5}},
    }).encode()
    request = urllib.request.Request(
        event["ResponseURL"], data=body, method="PUT",
        headers={"Content-Type": "", "Content-Length": str(len(body))},
    )
    urllib.request.urlopen(request)
`),
    });
    const policy = new iam.ManagedPolicy(this, 'Pol', {
      managedPolicyName: 'CdkdIntegCrPayloadTypesPol',
      statements: [
        new iam.PolicyStatement({ actions: ['sqs:GetQueueUrl'], resources: ['*'] }),
      ],
    });
    const cfnPolicy = policy.node.defaultChild as iam.CfnManagedPolicy;

    const numParam = new cdk.CfnParameter(this, 'NumParam', { type: 'Number', default: 7 });
    const numListParam = new cdk.CfnParameter(this, 'NumListParam', {
      type: 'List<Number>',
      default: '1,2',
    });
    const isOn = new cdk.CfnCondition(this, 'IsOn', {
      expression: cdk.Fn.conditionEquals('a', 'a'),
    });
    const mapping = new cdk.CfnMapping(this, 'M', { mapping: { K: { N: 9, B: true } } });

    const src = new cdk.CfnCustomResource(this, 'Src', { serviceToken: handler.functionArn });

    const count = cfnPolicy.getAtt('AttachmentCount');
    const attachable = cfnPolicy.getAtt('IsAttachable');
    const echo = new cdk.CfnResource(this, 'EchoResource', {
      type: 'Custom::Echo',
      properties: {
        ServiceToken: handler.functionArn,
        Phase: process.env.CDKD_TEST_PHASE ?? 'one',
        // (a) literals
        A_LitNum: 5,
        A_LitFloat: 1.5,
        A_LitBool: true,
        A_LitStr: 'hello',
        // (b) Fn::GetAtt
        B_GaCount: count,
        B_GaBool: attachable,
        B_GaCrNum: src.getAtt('Num'),
        B_GaCrBool: src.getAtt('Bool'),
        B_GaCrObj: src.getAtt('Obj'),
        // (c) Ref of Number parameters
        C_RefNum: numParam.valueAsNumber,
        C_RefNumList: numListParam.valueAsList,
        // (d) Fn::Select / Fn::If / Fn::FindInMap
        D_IfLit: cdk.Fn.conditionIf(isOn.logicalId, 5, 6),
        D_IfBool: cdk.Fn.conditionIf(isOn.logicalId, true, false),
        D_MapNum: mapping.findInMap('K', 'N'),
        D_MapBool: mapping.findInMap('K', 'B'),
        D_SelGa: cdk.Fn.select(0, [count] as never),
        D_IfGa: cdk.Fn.conditionIf(isOn.logicalId, count, 6),
        // (e) literals nested in literal containers
        E_LitObj: { n: 5, b: true, s: 'x', deep: { n: 6 } },
        E_LitList: [5, true, 'x'],
        E_LitListObj: [{ n: 5, b: true }],
        // (f) Fn::GetAtt inside literal containers
        F_GaInList: [count, attachable, 5],
        F_GaInObj: { n: count, b: attachable, lit: 5 },
      },
    });
    // CDK folds an `Fn.select` over a literal list at synth time, so the
    // intrinsic is spelled raw.
    echo.addPropertyOverride('D_SelLit', { 'Fn::Select': [0, [5, 6]] });
    // The logical id the handler keys on.
    echo.overrideLogicalId('Echo');
    echo.node.addDependency(policy);
  }
}
