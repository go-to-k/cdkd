import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integ from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Small CloudFormation stack — its synthesized template is well under the
 * 51,200-byte UpdateStack TemplateBody limit, so retireCloudFormationStack
 * submits the Retain-injected template inline (no S3 round-trip).
 *
 * Resources are deliberately ones cdkd has SDK Provider support for, so the
 * post-migrate `cdkd destroy` exercises the full provider path rather than
 * the Cloud Control API fallback.
 *
 * Extended (PR #332 regression guard) with the sub-resource types whose
 * `delete()` reads intrinsic-valued properties from state — the class of
 * bug fixed by PR #332. Pre-#332 `cdkd import` wrote the synth template's
 * Properties literal (including raw `Fn::GetAtt` / `Ref`) verbatim into
 * `state.properties`, and the post-migrate `cdkd destroy` then passed those
 * raw intrinsics to AWS, which rejected them. Three failure patterns from
 * the original bug report (CdkSampleStack):
 *   - `AWS::Lambda::Permission.FunctionName: {Fn::GetAtt: [<Fn>, 'Arn']}`
 *     (auto-emitted by every API Gateway / HttpApi → Lambda integration)
 *   - `AWS::IAM::Policy.Roles[0]: {Ref: <Role>}`
 *     (auto-emitted by every CDK L2 grant — e.g. `bucket.grantRead(role)`
 *     or the auto-delete-objects Lambda's execution role policy)
 *   - `Custom::S3AutoDeleteObjects.ServiceToken: {Fn::GetAtt: [<Fn>, 'Arn']}`
 *     (auto-emitted by `autoDeleteObjects: true` on an S3 Bucket)
 * Adding all three to this fixture ensures the migrate-from-cfn path is
 * structurally covered against this regression class going forward.
 *
 * Also extended (PR #331 regression guard) with an `AWS::ECR::Repository`
 * referenced via `repo.repositoryArn` in an IAM policy statement. Pre-#331
 * the resolver had no per-type Arn handler for `AWS::ECR::Repository`, so
 * `Fn::GetAtt: [<EcrRepo>, 'Arn']` fell through to the default branch and
 * returned the bare physicalId (the repo name). `cdkd diff` against
 * imported state emitted `Unknown attribute Arn for resource type
 * AWS::ECR::Repository, returning physical ID`, and downstream
 * `Fn::Split(':', physicalId)` produced a 1-element array that triggered
 * `Fn::Select(N, ...)` out-of-bounds warnings. Post-#331 the resolver
 * returns `arn:${partition}:ecr:${region}:${accountId}:repository/${id}`.
 * The integ's `run.sh` adds a `cdkd diff` step that asserts neither
 * warning appears in the output.
 */
export class MigrateSmallStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Bucket with `autoDeleteObjects: true` — auto-emits a
    // `Custom::S3AutoDeleteObjects` resource whose ServiceToken is a raw
    // `Fn::GetAtt` intrinsic. Pre-#332 the post-migrate destroy crashed
    // with `serviceToken.startsWith is not a function`; post-#332 the
    // intrinsic is resolved at import time so destroy sees a real ARN.
    const bucket = new s3.Bucket(this, 'ExampleBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
    });

    // Deliberately NO custom `name` on the Document. SSM Documents with a
    // custom Name + custom Content fail UpdateStack with "custom-named
    // resource requires replacing" because CFn re-serializes Content
    // internally and detects the round-trip as a Content change — and a
    // custom-named Document can't be replaced (the name would collide
    // with itself). Real-user impact is documented in
    // retire-cfn-stack.ts's "fall back to the manual 3-step procedure"
    // failure model. Letting CFn auto-name keeps this test focused on
    // the migrate flow itself rather than that downstream CFn quirk.
    new ssm.CfnDocument(this, 'TestDocument', {
      content: {
        schemaVersion: '2.2',
        description: 'cdkd integ — migrate-from-cfn small path',
        mainSteps: [
          {
            action: 'aws:runShellScript',
            name: 'noop',
            inputs: { runCommand: ['echo "migrate-from-cfn small"'] },
          },
        ],
      },
      documentType: 'Command',
    });

    // Lambda + HttpApi route — the HttpLambdaIntegration auto-emits an
    // `AWS::Lambda::Permission` whose `FunctionName` is `{Fn::GetAtt:
    // [<Fn>, 'Arn']}`. This is the first canonical failure shape — pre-#332
    // the post-migrate destroy crashed with "Value '{Fn::GetAtt: ...}' at
    // 'functionName' failed to satisfy constraint".
    const handler = new lambda.Function(this, 'RouteHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200, body: "ok" });'
      ),
    });

    const httpApi = new apigwv2.HttpApi(this, 'TestHttpApi');
    httpApi.addRoutes({
      path: '/ping',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integ.HttpLambdaIntegration('PingIntegration', handler),
    });

    // CDK L2 grant — auto-emits a standalone `AWS::IAM::Policy`
    // (`RouteHandlerServiceRoleDefaultPolicy*`) whose `Roles[0]` is a raw
    // `{Ref: <RoleLogicalId>}` intrinsic. Pre-#332 the post-migrate destroy
    // crashed with "The specified value for roleName is invalid" because
    // the raw intrinsic was passed verbatim to `DeleteRolePolicy`. This
    // is the third canonical failure shape — and the one most likely to
    // bite any non-trivial CDK app since EVERY L2 grant emits a Policy.
    bucket.grantRead(handler);

    // ECR Repository + IAM grant referencing `repo.repositoryArn` —
    // CDK synthesizes this as `Fn::GetAtt: [<EcrRepo>, 'Arn']` inside
    // the IAM policy's `Resource` field. Pre-#331 the resolver had no
    // per-type handler for `AWS::ECR::Repository.Arn` and fell through
    // to the default branch (return physicalId = bare repo name),
    // producing `Unknown attribute Arn for resource type AWS::ECR::Repository`
    // and downstream `Fn::Select` out-of-bounds errors on any CDK
    // pattern that parses the ARN. Post-#331 the resolver returns the
    // real ARN. The integ's `run.sh` runs `cdkd diff` against the
    // imported state and asserts neither warning appears.
    const ecrRepo = new ecr.Repository(this, 'EcrRepo', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
    const ecrConsumer = new iam.Role(this, 'EcrConsumer', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    ecrConsumer.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken', 'ecr:BatchGetImage'],
        resources: [ecrRepo.repositoryArn],
      })
    );
  }
}
