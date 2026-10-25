import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import {
  CfnWebFunction,
  CfnWebFunctionEndpoint,
  CfnWebFunctionRevision,
} from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A Lambda Web Function written with L1s, its code from an `s3assets.Asset` of
 * a directory: one function, three revisions of the SAME bundle that differ
 * only in their `ServiceConfig` environment, and one endpoint splitting
 * 20 / 80 between V1 and V2. `RevAlt` is outside the endpoint and sets
 * `AWS_LAMBDA_NODEJS_ENTRYPOINT=alt.js`, so it is reachable only through
 * `--revision` and starts a different entry file.
 *
 * Nothing is deployed: `cdkd local start-web-function` reads the synthesized
 * template and the staged asset directory in cdk.out. Modeled on cdk-local's
 * `tests/integration/local-start-web-function` fixture.
 */
export class LocalStartWebFunctionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const code = new s3assets.Asset(this, 'Code', { path: path.join(here, '..', 'web') });
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    const fn = new CfnWebFunction(this, 'WebFn', { functionName: 'cdkd-integ-web-fn' });

    const revision = (rid: string, env: Record<string, string>): CfnWebFunctionRevision =>
      new CfnWebFunctionRevision(this, rid, {
        functionName: fn.ref,
        buildConfig: {
          codeConfig: { s3Object: { bucket: code.s3BucketName, key: code.s3ObjectKey } },
          runtimeConfig: { runtime: 'nodejs24.x' },
        },
        serviceConfig: {
          executionRoleArn: role.roleArn,
          environmentVariables: env,
        },
      });

    const v1 = revision('RevV1', { REVISION_LABEL: 'v1', GREETING: 'hello-from-v1' });
    const v2 = revision('RevV2', { REVISION_LABEL: 'v2', GREETING: 'hello-from-v2' });
    revision('RevAlt', {
      REVISION_LABEL: 'alt',
      GREETING: 'hello-from-alt',
      AWS_LAMBDA_NODEJS_ENTRYPOINT: 'alt.js',
    });

    new CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName: fn.ref,
      endpointName: 'main',
      endpointType: 'HomeRegion',
      authType: 'ApplicationManaged',
      revisionWeights: [
        { revisionId: v1.attrRevisionId, weight: 20 },
        { revisionId: v2.attrRevisionId, weight: 80 },
      ],
    });
  }
}
