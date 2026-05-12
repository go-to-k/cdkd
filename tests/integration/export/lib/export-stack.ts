import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * Integ-test stack for `cdkd export`. Covers the four code paths the
 * 5-PR series exercises:
 *
 *   - Single-key importable resources (`AWS::S3::Bucket`,
 *     `AWS::IAM::Role`, `AWS::SNS::Topic`, `AWS::Lambda::Function`).
 *   - Custom Resource (`Custom::*`) that goes through the phase-2
 *     CREATE path when --include-non-importable is set. The backing
 *     Lambda is itself imported in phase 1; the CR's onCreate / onUpdate
 *     handler is idempotent (just returns a fixed PhysicalResourceId).
 *
 * Notable design choices:
 *
 *   - Explicit physical names (`bucketName`, `roleName`, `topicName`,
 *     `functionName`) so the post-export `cdk deploy` does NOT propose
 *     a replacement on the auto-generated-name-vs-stored-name diff
 *     (the replacement-risk caveat documented in `docs/cli-reference.md`).
 *     The 8-char hash suffix uses `node.addr` so multiple integ runs
 *     against the same account don't collide.
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

    const topic = new sns.Topic(this, 'Topic', {
      topicName: `cdkd-export-test-${suffix}`,
    });

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

    // Outputs exercise the cross-stack-consumer scanner in PR5 (no
    // sibling stack here, so the scan returns empty — exercises the
    // empty-case path).
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    // Surfaces the CfnParameter value so the synth template references
    // the parameter (CDK prunes unreferenced Parameters from the output).
    new cdk.CfnOutput(this, 'EnvironmentValue', { value: envParam.valueAsString });
  }
}
