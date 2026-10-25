import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A deployed Lambda Web Function for `cdkd local start-web-function
 * --from-state --assume-role` (go-to-k/cdkd#5295): one function, one revision
 * whose `ServiceConfig.ExecutionRoleArn` is the `Fn::GetAtt` of a role in the
 * stack, and one endpoint routing all traffic to it.
 *
 * The code is an `s3assets.Asset` of `web/`, which is what the local command
 * runs: it finds the bundle in cdk.out by the revision's literal
 * `S3Object.Key` (`<hash>.zip`). The DEPLOYED revision reads the same key from
 * a versioned bucket verify.sh owns (CODE_BUCKET / CODE_VERSION), as the other
 * web-function fixtures do, because AWS fetches it as the Lambda service and
 * the asset bucket grants that service nothing.
 *
 * The role trusts the account as well as Lambda, so the bare `--assume-role`
 * hop (signed by the caller) can assume it. `ROLE_NAME` is a `Ref`, filled
 * only by `--from-state`.
 *
 * Every name carries the run's `CDKD_WEBFN_RUN` token, so a re-run never meets
 * a name AWS still holds.
 *
 * covers: AWS::Lambda::WebFunction
 * covers: AWS::Lambda::WebFunctionRevision
 * covers: AWS::Lambda::WebFunctionEndpoint
 * covers: AWS::IAM::Role
 */
export class LocalStartWebFunctionFromStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const required = (name: string): string => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} must be set (verify.sh uploads the code)`);
      return value;
    };
    const run = process.env.CDKD_WEBFN_RUN ?? 'r0';
    const prefix = `cdkd-integ-webfn-lsf-${run}`;

    const code = new s3assets.Asset(this, 'Code', { path: path.join(here, '..', 'web') });

    const role = new iam.Role(this, 'ExecutionRole', {
      roleName: `${prefix}-${this.region}`,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.AccountRootPrincipal()
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const fn = new lambda.CfnWebFunction(this, 'WebFunction', { functionName: `${prefix}-fn` });
    const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName: fn.ref,
      buildConfig: {
        codeConfig: {
          s3Object: {
            bucket: required('CODE_BUCKET'),
            key: code.s3ObjectKey,
            versionId: required('CODE_VERSION'),
          },
        },
        runtimeConfig: { runtime: 'nodejs24.x' },
      },
      serviceConfig: {
        executionRoleArn: role.roleArn,
        environmentVariables: { ROLE_NAME: role.roleName },
      },
    });
    new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName: fn.ref,
      endpointName: 'prod',
      endpointType: 'HomeRegion',
      authType: 'ApplicationManaged',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
    });

    new cdk.CfnOutput(this, 'CodeKey', { value: code.s3ObjectKey });
  }
}
