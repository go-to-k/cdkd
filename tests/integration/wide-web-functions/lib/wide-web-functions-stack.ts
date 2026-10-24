import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * Web functions in the stack, each with one revision and one endpoint:
 * `WIDE_WEBFN_COUNT`, default 12, at most 50.
 */
export const FUNCTIONS = ((): number => {
  const raw = process.env.WIDE_WEBFN_COUNT ?? '12';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error(`WIDE_WEBFN_COUNT must be an integer from 1 to 50 (got '${raw}')`);
  }
  return n;
})();

/**
 * A wide stack of slow Cloud Control resources (issue #5242): Lambda Web
 * Functions (12 by default), none depending on another, each with one revision and one
 * HomeRegion endpoint routing all traffic to it. One execution role serves
 * every revision. A web function is created through Cloud Control, which
 * returns only once AWS reports it ready, so a slot held by one is held for
 * seconds -- the case the --concurrency setting matters for.
 *
 * The code object is uploaded once by verify.sh to a versioned bucket it owns
 * and handed in through CODE_BUCKET / CODE_KEY / CODE_VERSION; every revision
 * uses it. Every name carries the run's `CDKD_WIDE_RUN` token, so a re-create
 * in the same run never meets a name AWS still holds.
 *
 * covers: AWS::Lambda::WebFunction
 * covers: AWS::Lambda::WebFunctionRevision
 * covers: AWS::Lambda::WebFunctionEndpoint
 * covers: AWS::IAM::Role
 */
export class WideWebFunctionsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const required = (name: string): string => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} must be set (verify.sh uploads the code)`);
      return value;
    };
    const run = process.env.CDKD_WIDE_RUN ?? 'r0';
    const prefix = `cdkd-integ-webfn-wide-${run}`;

    const role = new iam.Role(this, 'ExecutionRole', {
      roleName: `${prefix}-${this.region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const s3Object = {
      bucket: required('CODE_BUCKET'),
      key: required('CODE_KEY'),
      versionId: required('CODE_VERSION'),
    };

    for (let i = 0; i < FUNCTIONS; i++) {
      const fn = new lambda.CfnWebFunction(this, `WebFunction${i}`, {
        functionName: `${prefix}-${i}`,
      });
      const revision = new lambda.CfnWebFunctionRevision(this, `Revision${i}`, {
        functionName: fn.ref,
        buildConfig: {
          codeConfig: { s3Object },
          runtimeConfig: { runtime: 'nodejs24.x' },
        },
        serviceConfig: { executionRoleArn: role.roleArn },
      });
      new lambda.CfnWebFunctionEndpoint(this, `Endpoint${i}`, {
        functionName: fn.ref,
        endpointName: 'prod',
        endpointType: 'HomeRegion',
        authType: 'ApplicationManaged',
        revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      });
    }
  }
}
