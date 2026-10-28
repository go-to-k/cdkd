import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Bedrock AgentCore tools example stack (issues #1038 / #1039 / #1058)
 *
 * Demonstrates the three AgentCore tool-side SDK Providers:
 * - `AWS::BedrockAgentCore::Browser` — adopt-only singleton for the
 *   AWS-managed default browser (`aws.browser.v1`); declared with NO
 *   properties (every schema property is read-only).
 * - `AWS::BedrockAgentCore::CodeInterpreter` — adopt-only singleton for the
 *   AWS-managed default code interpreter (`aws.codeinterpreter.v1`).
 * - `AWS::BedrockAgentCore::Evaluator` — a custom code-based evaluator
 *   backed by a fixture Lambda (no Bedrock model-access dependency), and an
 *   LLM-as-a-judge evaluator with a multi-dimensional rating scale
 *   (go-to-k/cdkd#5432). Creating it names a model but never invokes one.
 *
 * The Browser / CodeInterpreter types have no L1 constructs in aws-cdk-lib
 * (CDK ships only the *Custom variants), and CfnEvaluator predates the
 * CodeBased config member — all three are therefore declared as raw
 * `cdk.CfnResource`s, which also exercises cdkd's raw-CFn template path.
 *
 * covers: AWS::BedrockAgentCore::Browser
 * covers: AWS::BedrockAgentCore::CodeInterpreter
 * covers: AWS::BedrockAgentCore::Evaluator
 *
 * Phase 1 creates the evaluator at TRACE level; Phase 2
 * (CDKD_TEST_UPDATE=true) must be an in-place `UpdateEvaluator` (new
 * Description + Level + an added tag; the evaluator id must NOT change —
 * EvaluatorName is the type's only createOnly property and stays fixed).
 * Phase 3 (CDKD_TEST_REMOVAL=true) REMOVES Description and moves Level back
 * to TRACE (issue #1160): a CloudFormation A/B (us-east-1) KEPT a removed
 * Evaluator Description, so the live one must survive, while the Level
 * change proves the redeploy reached `UpdateEvaluator`.
 *
 * The judge evaluator's `RatingScale.MultiDimensional` (go-to-k/cdkd#5432)
 * carries two dimensions in Phase 1 and three from Phase 2 on: both the
 * `CreateEvaluator` and the `UpdateEvaluator` must deliver them. Before the
 * SDK bump the client's serializer dropped the member, and AWS refused the
 * create's empty `RatingScale` (measured on 3.1152.0).
 */
export class AgentcoreToolsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';

    // Adopt-only singletons: the AWS-managed default tools.
    const browser = new cdk.CfnResource(this, 'DefaultBrowser', {
      type: 'AWS::BedrockAgentCore::Browser',
    });

    const codeInterpreter = new cdk.CfnResource(this, 'DefaultCodeInterpreter', {
      type: 'AWS::BedrockAgentCore::CodeInterpreter',
    });

    // Fixture Lambda backing the code-based evaluator.
    const evalFnRole = new iam.Role(this, 'EvalFnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const evalFn = new lambda.Function(this, 'EvalFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: evalFnRole,
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ score: 1, explanation: "cdkd integ evaluator" });'
      ),
    });

    const evaluator = new cdk.CfnResource(this, 'CodeEvaluator', {
      type: 'AWS::BedrockAgentCore::Evaluator',
      properties: {
        EvaluatorName: 'cdkd_integ_agentcore_evaluator',
        // Absent under CDKD_TEST_REMOVAL: CDK drops an undefined property.
        Description: isRemoval
          ? undefined
          : isUpdate
            ? 'cdkd integ evaluator (updated)'
            : 'cdkd integ evaluator',
        Level: isUpdate && !isRemoval ? 'SESSION' : 'TRACE',
        EvaluatorConfig: {
          CodeBased: {
            LambdaConfig: {
              LambdaArn: evalFn.functionArn,
              LambdaTimeoutInSeconds: 60,
            },
          },
        },
        Tags:
          isUpdate || isRemoval
            ? [
              { Key: 'cdkd-integ', Value: 'agentcore-tools' },
              { Key: 'phase', Value: 'update' },
            ]
          : [{ Key: 'cdkd-integ', Value: 'agentcore-tools' }],
      },
    });

    // go-to-k/cdkd#5432: a multi-dimensional rating scale, one dimension per
    // DimensionRatingScale member, plus a third from Phase 2 on (the update).
    // aws-cdk-lib's bundled schema predates the member, so synth warns
    // (F3002 / F3018); the live CloudFormation registry schema lists it.
    const dimensions: Record<string, unknown>[] = [
      {
        DimensionName: 'accuracy',
        DimensionInstruction: 'Is the answer factually correct?',
        DimensionRatingScale: {
          Numerical: [
            { Value: 0, Label: 'wrong', Definition: 'The answer is incorrect.' },
            { Value: 1, Label: 'right', Definition: 'The answer is correct.' },
          ],
        },
      },
      {
        DimensionName: 'tone',
        DimensionInstruction: 'Is the answer polite?',
        DimensionRatingScale: {
          Categorical: [
            { Label: 'polite', Definition: 'The answer is courteous.' },
            { Label: 'rude', Definition: 'The answer is not courteous.' },
          ],
        },
      },
    ];
    if (isUpdate || isRemoval) {
      dimensions.push({
        DimensionName: 'brevity',
        DimensionInstruction: 'Is the answer concise?',
        DimensionRatingScale: {
          Categorical: [
            { Label: 'concise', Definition: 'No needless words.' },
            { Label: 'verbose', Definition: 'Needless words.' },
          ],
        },
      });
    }
    new cdk.CfnResource(this, 'JudgeEvaluator', {
      type: 'AWS::BedrockAgentCore::Evaluator',
      properties: {
        EvaluatorName: 'cdkd_integ_agentcore_judge',
        Level: 'TRACE',
        EvaluatorConfig: {
          LlmAsAJudge: {
            // At least one placeholder is required; these two are TRACE-level ones.
            Instructions: 'Given {context}, rate the agent response {assistant_turn} on each dimension.',
            RatingScale: { MultiDimensional: dimensions },
            ModelConfig: {
              BedrockEvaluatorModelConfig: {
                ModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
              },
            },
          },
        },
        Tags: [{ Key: 'cdkd-integ', Value: 'agentcore-tools' }],
      },
    });

    // Outputs exercising Fn::GetAtt through the providers.
    new cdk.CfnOutput(this, 'BrowserArn', {
      value: browser.getAtt('BrowserArn').toString(),
    });
    new cdk.CfnOutput(this, 'BrowserId', {
      value: browser.getAtt('BrowserId').toString(),
    });
    new cdk.CfnOutput(this, 'CodeInterpreterArn', {
      value: codeInterpreter.getAtt('CodeInterpreterArn').toString(),
    });
    new cdk.CfnOutput(this, 'EvaluatorArn', {
      value: evaluator.getAtt('EvaluatorArn').toString(),
    });
    new cdk.CfnOutput(this, 'EvaluatorId', {
      value: evaluator.getAtt('EvaluatorId').toString(),
    });
  }
}
