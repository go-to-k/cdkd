import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

/**
 * Issue #6242: read-only attributes cdkd REFUSED (`Fn::GetAtt` failed the
 * deploy) where CloudFormation answers a value. Each is now recorded from the
 * value AWS returned; verify.sh compares every Output with the live AWS value.
 *
 * - `AWS::IAM::ManagedPolicy` `AttachmentCount` / `PermissionsBoundaryUsageCount`
 *   (numbers), `IsAttachable` (boolean), `CreateDate` / `UpdateDate` (ISO).
 *   The policy is attached to a role BY THIS RESOURCE, so `AttachmentCount`
 *   is 1 only when cdkd records it after the attach (CreatePolicy says 0).
 * - `AWS::WAFv2::WebACL` `Capacity` (number; 0 with no rules).
 * - `AWS::S3Vectors::VectorBucket` `CreationTime`.
 * - `AWS::BedrockAgentCore::Evaluator` `EvaluatorType` / `Provider` (a
 *   code-based evaluator: `CustomCode` / `Custom` on real CloudFormation).
 *
 * Phase 2 (`CDKD_TEST_UPDATE=true`), all in place: the policy document
 * changes (new default version: `UpdateDate` moves) and a second role is
 * attached (`AttachmentCount` 2); the web ACL gains a rule (`Capacity` > 0);
 * the vector bucket gains a tag (its update records nothing, so the record
 * must keep `CreationTime`); the evaluator's Level changes.
 *
 * covers: AWS::IAM::ManagedPolicy
 * covers: AWS::WAFv2::WebACL
 * covers: AWS::S3Vectors::VectorBucket
 * covers: AWS::BedrockAgentCore::Evaluator
 */
export class GetattIamWafS3vectorsEvaluatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // ── IAM ManagedPolicy ──
    const roleA = new iam.Role(this, 'RoleA', {
      roleName: `${id}-role-a`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const roleB = new iam.Role(this, 'RoleB', {
      roleName: `${id}-role-b`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const actions = isUpdate ? ['s3:ListAllMyBuckets', 's3:GetBucketLocation'] : ['s3:ListAllMyBuckets'];
    const policy = new iam.ManagedPolicy(this, 'Policy', {
      managedPolicyName: `${id}-policy`,
      statements: [new iam.PolicyStatement({ actions, resources: ['*'] })],
      roles: isUpdate ? [roleA, roleB] : [roleA],
    });
    const cfnPolicy = policy.node.defaultChild as iam.CfnManagedPolicy;

    // ── WAFv2 WebACL ──
    const visibility = (metricName: string) => ({
      sampledRequestsEnabled: false,
      cloudWatchMetricsEnabled: false,
      metricName,
    });
    const acl = new wafv2.CfnWebACL(this, 'Acl', {
      name: `${id}-acl`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility('acl'),
      rules: isUpdate
        ? [
            {
              name: 'geo',
              priority: 0,
              action: { block: {} },
              statement: { geoMatchStatement: { countryCodes: ['AQ'] } },
              visibilityConfig: visibility('geo'),
            },
          ]
        : [],
    });

    // ── S3 Vectors VectorBucket ──
    const vectorBucket = new cdk.CfnResource(this, 'VectorBucket', {
      type: 'AWS::S3Vectors::VectorBucket',
      properties: {
        VectorBucketName: 'cdkd-getatt-6242-vb',
        ...(isUpdate ? { Tags: [{ Key: 'phase', Value: 'update' }] } : {}),
      },
    });

    // ── BedrockAgentCore Evaluator (code-based, so no model access needed) ──
    const evalFn = new lambda.Function(this, 'EvalFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ score: 1, explanation: "cdkd integ" });'
      ),
    });
    const evaluator = new cdk.CfnResource(this, 'Evaluator', {
      type: 'AWS::BedrockAgentCore::Evaluator',
      properties: {
        EvaluatorName: 'cdkd_getatt_6242_evaluator',
        Level: isUpdate ? 'SESSION' : 'TRACE',
        EvaluatorConfig: {
          CodeBased: {
            LambdaConfig: { LambdaArn: evalFn.functionArn, LambdaTimeoutInSeconds: 60 },
          },
        },
      },
    });

    new cdk.CfnOutput(this, 'PolicyArn', { value: policy.managedPolicyArn });
    new cdk.CfnOutput(this, 'AttachmentCount', { value: cdk.Token.asString(cfnPolicy.getAtt('AttachmentCount')) });
    new cdk.CfnOutput(this, 'PermissionsBoundaryUsageCount', {
      value: cdk.Token.asString(cfnPolicy.getAtt('PermissionsBoundaryUsageCount')),
    });
    new cdk.CfnOutput(this, 'IsAttachable', { value: cdk.Token.asString(cfnPolicy.getAtt('IsAttachable')) });
    new cdk.CfnOutput(this, 'CreateDate', { value: cfnPolicy.attrCreateDate });
    new cdk.CfnOutput(this, 'UpdateDate', { value: cfnPolicy.attrUpdateDate });
    new cdk.CfnOutput(this, 'AclArn', { value: acl.attrArn });
    new cdk.CfnOutput(this, 'AclCapacity', { value: cdk.Token.asString(acl.attrCapacity) });
    new cdk.CfnOutput(this, 'VectorBucketCreationTime', {
      value: vectorBucket.getAtt('CreationTime').toString(),
    });
    new cdk.CfnOutput(this, 'EvaluatorId', { value: evaluator.getAtt('EvaluatorId').toString() });
    new cdk.CfnOutput(this, 'EvaluatorType', { value: evaluator.getAtt('EvaluatorType').toString() });
    new cdk.CfnOutput(this, 'EvaluatorProvider', { value: evaluator.getAtt('Provider').toString() });
  }
}
