import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * SDK-provider <-> Cloud Control API cross-reference boundary integ fixture.
 *
 * cdkd's #614 routing (`ProviderRegistry.getProviderFor`) auto-routes a
 * resource through Cloud Control API instead of its registered SDK Provider
 * the moment its template sets a top-level property the SDK Provider would
 * silently drop. That flips the entire resource to the CC path: the SDK
 * Provider's `create()` is bypassed, typed attribute writes never happen,
 * and the physical id becomes whatever CC API returns. Cross-references
 * across that SDK <-> CC boundary — and CC API's physical-id shapes — are a
 * known fragile area (memory `feedback_silent_drop_forces_cc_api_routing`
 * and `feedback_cc_api_routing_bypasses_sdk_delete_logic`).
 *
 * This stack forces a heterogeneous routing mix in ONE stack and crosses the
 * boundary in BOTH directions:
 *
 *   - `KinesisStream` (AWS::Kinesis::Stream) sets `DesiredShardLevelMetrics`,
 *     a silent-drop top-level property in cdkd's Kinesis SDK Provider, so the
 *     stream auto-routes via Cloud Control API (provisionedBy === 'cc-api').
 *   - `CcLambda` (AWS::Lambda::Function) sets `RuntimeManagementConfig`, the
 *     canonical silent-drop CC-fallback example, so it also routes via Cloud
 *     Control API.
 *   - `ExecRole` (AWS::IAM::Role) and `StreamArnParam` (AWS::SSM::Parameter)
 *     have no silent-drop property set, so they stay on the SDK Provider
 *     path (provisionedBy === 'sdk').
 *
 * Cross-references:
 *   (A) SDK -> CC:  `StreamArnParam` (SDK) sets its `Value` to
 *       `Fn::GetAtt(KinesisStream, 'Arn')` — an SDK-routed consumer reading
 *       a CC-routed producer's GetAtt attribute. verify.sh asserts the SSM
 *       parameter's value on AWS equals the real stream ARN.
 *   (B) CC -> SDK:  `CcLambda` (CC) sets its `Role` to
 *       `Fn::GetAtt(ExecRole, 'Arn')` — a CC-routed consumer reading an
 *       SDK-routed producer's GetAtt attribute. verify.sh asserts the
 *       Lambda's configured role ARN on AWS equals the real role ARN.
 *
 * No VPC / NAT — all four resources are cheap and create in seconds.
 */
export class SdkCcApiCrossrefStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- SDK-routed: IAM Role (no silent-drop property) ---
    const execRole = new iam.CfnRole(this, 'ExecRole', {
      roleName: 'cdkd-crossref-exec-role',
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
        'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      ],
    });

    // --- CC-routed: Kinesis Stream (DesiredShardLevelMetrics is silent-drop
    //     in cdkd's Kinesis SDK Provider -> auto-routes via Cloud Control) ---
    const stream = new kinesis.CfnStream(this, 'KinesisStream', {
      name: 'cdkd-crossref-stream',
      shardCount: 1,
      // Silent-drop top-level property: flips the whole resource to CC API.
      desiredShardLevelMetrics: ['IncomingBytes', 'OutgoingBytes'],
    });

    // --- Cross-ref (A) SDK -> CC: SSM Parameter (SDK) whose Value is a
    //     Fn::GetAtt of the CC-routed Kinesis stream's Arn attribute. ---
    new ssm.CfnParameter(this, 'StreamArnParam', {
      name: '/cdkd/crossref/stream-arn',
      type: 'String',
      value: stream.attrArn,
    });

    // --- CC-routed: Lambda Function (RuntimeManagementConfig is silent-drop
    //     -> CC API). Cross-ref (B) CC -> SDK: its Role is a Fn::GetAtt of
    //     the SDK-routed IAM Role's Arn attribute. ---
    const fn = new lambda.CfnFunction(this, 'CcLambda', {
      functionName: 'cdkd-crossref-fn',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: execRole.attrArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd crossref probe"}',
        ].join('\n'),
      },
      // Silent-drop top-level property: flips the whole resource to CC API.
      runtimeManagementConfig: { updateRuntimeOn: 'FunctionUpdate' },
    });

    // The Lambda's role must exist before CreateFunction validates it.
    fn.addDependency(execRole);
  }
}
