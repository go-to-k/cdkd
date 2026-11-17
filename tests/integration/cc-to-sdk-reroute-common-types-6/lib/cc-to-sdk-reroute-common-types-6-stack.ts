import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The value each routing phase declares on every resource under test.
 * Consecutive deploys must differ: one the differ calls NO_CHANGE never
 * provisions a resource, so it could not flip. verify.sh runs its `cdkd diff`
 * with `pinned`, because `seed` and `flip` declare the same value.
 */
const VALUE_BY_PHASE: Record<string, 'a' | 'b'> = {
  base: 'a',
  seed: 'b',
  pinned: 'a',
  flip: 'b',
};

/**
 * physicalId-parity arm for issue 6490, batch 6: an
 * `AWS::S3Tables::TableBucket`, an `AWS::BedrockAgentCore::Runtime` and an
 * `AWS::BedrockAgentCore::Evaluator`, each recorded `provisionedBy: 'cc-api'`,
 * return to the SDK provider without churn.
 *
 * covers: AWS::S3Tables::TableBucket
 * covers: AWS::BedrockAgentCore::Runtime
 * covers: AWS::BedrockAgentCore::Evaluator
 *
 * The bucket changes its UnreferencedFileRemoval days; the runtime and the
 * evaluator change their Description. All three are LEAVES, and each logical
 * id is fixed.
 *
 * The two AgentCore names change once, at the `seed` deploy that recreates
 * them on Cloud Control, and stay fixed from then on. cdkd's recreate deletes
 * first and creates next, and AgentCore reports a deleted runtime or evaluator
 * as DELETING for a while, so re-using the name could be refused while the old
 * one is still going. The bucket keeps its name: its ARN is built from the
 * name, which is why verify.sh witnesses it by tableBucketId and createdAt.
 */
export class CcToSdkRerouteCommonTypes6Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phaseName = process.env.CDKD_TEST_PHASE ?? 'base';
    const value = VALUE_BY_PHASE[phaseName] ?? 'a';
    const phase = `phase-${value}`;
    // 1 for the SDK create, 2 from the Cloud Control recreate onwards.
    const generation = phaseName === 'base' ? '1' : '2';
    const fixed = (resource: cdk.CfnResource, logicalId: string): void => {
      resource.overrideLogicalId(logicalId);
    };

    fixed(
      new s3tables.CfnTableBucket(this, 'TableBucket', {
        tableBucketName: 'cdkd-reroute-common-types-6',
        unreferencedFileRemoval: {
          status: 'Enabled',
          unreferencedDays: value === 'a' ? 5 : 6,
          noncurrentDays: 7,
        },
      }),
      'RerouteTableBucket'
    );

    const runtime = new agentcore.Runtime(this, 'Runtime', {
      runtimeName: `cdkd_reroute_ct6_runtime_${generation}`,
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: path.join(__dirname, '..', 'agent-code'),
        runtime: agentcore.AgentCoreRuntime.PYTHON_3_12,
        entrypoint: ['main.py'],
      }),
      description: phase,
    });
    fixed(runtime.node.defaultChild as cdk.CfnResource, 'RerouteRuntime');

    // NOT under test: the code-based evaluator's Lambda and its role.
    const evalFnRole = new iam.Role(this, 'EvalFnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const evalFn = new lambda.Function(this, 'EvalFn', {
      role: evalFnRole,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ score: 1, explanation: "cdkd integ" });'
      ),
    });
    fixed(
      new cdk.CfnResource(this, 'Evaluator', {
        type: 'AWS::BedrockAgentCore::Evaluator',
        properties: {
          EvaluatorName: `cdkd_reroute_ct6_evaluator_${generation}`,
          Description: phase,
          Level: 'TRACE',
          EvaluatorConfig: {
            CodeBased: {
              LambdaConfig: { LambdaArn: evalFn.functionArn, LambdaTimeoutInSeconds: 60 },
            },
          },
        },
      }),
      'RerouteEvaluator'
    );

    new cdk.CfnOutput(this, 'EvalFnName', { value: evalFn.functionName });
    new cdk.CfnOutput(this, 'EvalFnRoleName', { value: evalFnRole.roleName });
    new cdk.CfnOutput(this, 'RuntimeRoleName', { value: runtime.role.roleName });
  }
}
