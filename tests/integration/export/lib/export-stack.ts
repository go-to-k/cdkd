import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2_integ from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * Integ-test stack for `cdkd export`. Covers the code paths the export
 * series exercises:
 *
 *   - Single-key importable resources (`AWS::S3::Bucket`,
 *     `AWS::IAM::Role`, `AWS::SNS::Topic`, `AWS::Lambda::Function`).
 *   - Composite-id splitters via an HTTP API: `AWS::ApiGatewayV2::Api`
 *     (single-key), `AWS::ApiGatewayV2::Integration` / `Route` /
 *     `AWS::Lambda::Permission` (composite, narrow propertiesOverlay).
 *   - IMPORT-unsupported but CFn-createable types via the same HTTP API:
 *     `AWS::ApiGatewayV2::Stage` (handlers: [] in CFn schema). Exercises
 *     the pre-delete + phase-2 CREATE path closed by cdkd issue #307.
 *   - Custom Resource (`Custom::*`) that goes through the phase-2
 *     CREATE path when --include-non-importable is set. The backing
 *     Lambda is itself imported in phase 1; the CR's onCreate / onUpdate
 *     handler is idempotent (just returns a fixed PhysicalResourceId).
 *
 * Notable design choices:
 *
 *   - Most resources use explicit physical names (`bucketName`,
 *     `roleName`, `functionName`, `apiName`) so the post-export `cdk
 *     deploy` does NOT propose a replacement on the
 *     auto-generated-name-vs-stored-name diff. The 8-char hash suffix
 *     uses `node.addr` so multiple integ runs against the same account
 *     don't collide.
 *
 *   - **`Topic` has NO explicit `topicName`** — exercises the auto-gen
 *     name path that issue [#319] fixed. Pre-#319 cdkd's overlay baked
 *     the cdkd-prefixed auto-gen name into the post-export CFn template
 *     (`Properties.TopicName: 'CdkdExportExample-...'`), while CDK
 *     synth produced `Properties.TopicName: <absent>` → post-export
 *     `cdk diff` proposed REPLACE on the Topic (and every other
 *     auto-named resource in a real-world stack). Post-#319 the overlay
 *     is conditional and skipped when synth's Properties value is
 *     absent → diff is clean. The HttpApi sub-resources (Integration /
 *     Route / Permission) similarly exercise the composite-id intrinsic
 *     path: pre-#319 their `Properties.ApiId: {Ref: 'HttpApi...'}`
 *     intrinsic was overwritten with the resolved literal `'u0phtuyyde'`
 *     → cdk diff saw literal vs intrinsic shape mismatch → REPLACE.
 *     Post-#319 the intrinsic is preserved → diff is clean.
 *
 *   - RemovalPolicy.DESTROY everywhere so the CFn DeleteStack at the
 *     end of `verify.sh` tears down every AWS resource. Without this,
 *     CFn would leak S3 buckets / Lambdas across integ runs.
 */
export class ExportStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 8-char suffix tied to the construct tree's address — stable across
    // a single `cdk deploy`, unique across stack renames or branch tests.
    const suffix = cdk.Names.uniqueResourceName(this, { maxLength: 8 }).toLowerCase();

    // Template-declared parameter used by the `parameter-override` variant
    // of `verify.sh` to exercise `cdkd export --parameter Key=Value`.
    // The default value covers every other variant (deploy / export uses
    // the default, no override needed). Emitted as a CfnOutput so the
    // synth template references the parameter and CDK doesn't prune it.
    const envParam = new cdk.CfnParameter(this, 'Environment', {
      type: 'String',
      default: 'test',
      description: 'Environment name (used by parameter-override variant).',
    });

    // ── Single-key importable resources ────────────────────────────
    const bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `cdkd-export-test-${suffix}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
      versioned: false,
    });

    // No `topicName` — tests the auto-gen-name path that #319 fixed.
    // cdkd's deploy generates a prefixed name like
    // `cdkdexportexample-topic12345` on AWS; without the #319 fix, the
    // post-export cdk diff would propose REPLACE on `TopicName`
    // (cdkd-prefixed literal in CFn template vs absent in CDK synth).
    const topic = new sns.Topic(this, 'Topic');

    // ── Custom Resource backing Lambda (phase 1 import) ─────────────
    // The Provider framework generates an additional CR Lambda; we
    // pick the simpler `AwsCustomResource` path which uses a SINGLE
    // SDK-call Lambda for both onCreate and onDelete.
    const role = new iam.Role(this, 'CRRole', {
      roleName: `cdkd-export-test-${suffix}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // ── Inline IAM Policy (IMPORT-unsupported recreate path) ───────
    // `AWS::IAM::Policy` is the type CDK emits for L2 grants like ECS
    // Task Execution Role's ECR-pull policy. CFn schema reports it with
    // `handlers: ['create', 'delete', 'update']` — no read/list, so it's
    // not IMPORT-able. cdkd auto-handles via pre-delete + phase-2-CREATE
    // (same mechanism as Stage). Inline `new iam.Policy(...)` with
    // `roles: [role]` produces this exact CFn type. Brief permission gap
    // between the SDK DeleteRolePolicy and CFn's phase-2 PutRolePolicy.
    new iam.Policy(this, 'InlinePolicy', {
      policyName: `cdkd-export-inline-${suffix}`,
      statements: [
        new iam.PolicyStatement({
          actions: ['logs:PutLogEvents'],
          resources: ['*'],
        }),
      ],
      roles: [role],
    });

    // Trivial idempotent backing Lambda. Works under BOTH cdkd's
    // Custom Resource invocation (which can use the return value as
    // the response payload) AND real CloudFormation's Custom Resource
    // protocol — the handler PUTs a cfn-response to event.ResponseURL
    // so the CFn-side phase-2 UPDATE / rollback / future cdk-deploy
    // can finish without timing out at the 1-hour ceiling.
    const handler = new lambda.Function(this, 'CRHandler', {
      functionName: `cdkd-export-test-${suffix}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      role,
      code: lambda.Code.fromInline(`
        const https = require('https');
        const url = require('url');
        exports.handler = async (event) => {
          console.log('CR event:', JSON.stringify(event));
          const physicalId = 'cdkd-export-test-cr-${suffix}';
          if (event.ResponseURL) {
            const responseBody = JSON.stringify({
              Status: 'SUCCESS',
              Reason: 'OK',
              PhysicalResourceId: physicalId,
              StackId: event.StackId,
              RequestId: event.RequestId,
              LogicalResourceId: event.LogicalResourceId,
              Data: { Ack: 'ok' },
            });
            const parsedUrl = url.parse(event.ResponseURL);
            await new Promise((resolve, reject) => {
              const req = https.request(
                {
                  hostname: parsedUrl.hostname,
                  port: 443,
                  path: parsedUrl.path,
                  method: 'PUT',
                  headers: {
                    'content-type': '',
                    'content-length': responseBody.length,
                  },
                },
                (res) => {
                  res.on('data', () => {});
                  res.on('end', () => resolve());
                }
              );
              req.on('error', reject);
              req.write(responseBody);
              req.end();
            });
          }
          // Idempotent return value (cdkd's return-value fast path).
          return { PhysicalResourceId: physicalId, Data: { Ack: 'ok' } };
        };
      `),
      timeout: cdk.Duration.seconds(30),
    });

    // ── The Custom::* resource itself (phase 2 CREATE) ──────────────
    // Forces a Custom:: resource type via a Provider with explicit
    // serviceToken pointing at the same-stack Lambda. The cdkd
    // Custom Resource provider invokes the Lambda directly via the
    // same protocol CFn uses, so the phase-2 CREATE in CFn just
    // re-runs the same onCreate.
    new cdk.CustomResource(this, 'TestCR', {
      serviceToken: handler.functionArn,
      properties: {
        // Pinning a property so any future template-shape regression
        // surfaces as a CFn UPDATE rejection rather than silent drift.
        Marker: 'cdkd-export-integ',
        BucketName: bucket.bucketName,
        TopicArn: topic.topicArn,
      },
    });

    // ── HTTP API (composite-id splitters + Stage pre-delete path) ──
    // Minimal HttpApi → 1 ApiGwV2::Api (single-key import), 1
    // ApiGwV2::Stage ($default, IMPORT-unsupported → pre-delete + phase-2
    // CREATE), 1 ApiGwV2::Integration (composite import), 1
    // ApiGwV2::Route (composite import), 1 Lambda::Permission (composite
    // import). The CR handler Lambda is reused as the integration target
    // — same Lambda already imports in phase 1, the Permission grants
    // ApiGwV2 invoke. Exercises every piece of the export pipeline:
    // composite-id resolution + readOnlyProperties narrowing +
    // IMPORT-unsupported pre-delete + phase-2 CFn CREATE of the deleted
    // Stage. Brief unavailability of the $default Stage between the
    // SDK DeleteStage call and CFn CreateStage; the apiEndpoint URL is
    // unchanged across the migration (it embeds ApiId, not StageName).
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `cdkd-export-test-${suffix}`,
    });
    httpApi.addRoutes({
      path: '/echo',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integ.HttpLambdaIntegration('EchoIntegration', handler),
    });

    // Outputs exercise the cross-stack-consumer scanner in PR5 (no
    // sibling stack here, so the scan returns empty — exercises the
    // empty-case path).
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    // Surfaces the CfnParameter value so the synth template references
    // the parameter (CDK prunes unreferenced Parameters from the output).
    new cdk.CfnOutput(this, 'EnvironmentValue', { value: envParam.valueAsString });
  }
}
