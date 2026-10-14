import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * A Lambda Web Function whose revision is REPLACED when its code changes
 * (go-to-k/cdkd#4900): the endpoint still uses the old revision when the
 * replacement first tries to delete it, so AWS refuses that delete until
 * the endpoint has moved to the new revision.
 *
 * The code object is uploaded by verify.sh to a versioned bucket it owns and
 * handed in through CODE_BUCKET / CODE_KEY / CODE_VERSION, so a new version
 * id changes `BuildConfig` (create-only) and forces the replacement.
 *
 * covers: AWS::Lambda::WebFunction
 * covers: AWS::Lambda::WebFunctionRevision
 * covers: AWS::Lambda::WebFunctionEndpoint
 */
export class LambdaWebFunctionRevisionReplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const required = (name: string): string => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} must be set (verify.sh uploads the code)`);
      return value;
    };

    const role = new iam.Role(this, 'ExecutionRole', {
      roleName: `cdkd-integ-webfn-${this.region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const fn = new lambda.CfnWebFunction(this, 'WebFunction', {
      functionName: 'cdkd-integ-webfn-replace',
    });

    const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName: fn.ref,
      buildConfig: {
        codeConfig: {
          s3Object: {
            bucket: required('CODE_BUCKET'),
            key: required('CODE_KEY'),
            versionId: required('CODE_VERSION'),
          },
        },
        runtimeConfig: { runtime: 'nodejs24.x' },
      },
      serviceConfig: { executionRoleArn: role.roleArn },
    });

    const endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName: fn.ref,
      // go-to-k/cdkd#4926: a later phase renames it, replacing the endpoint on the
      // SDK route (create the new one, delete the old one).
      endpointName: process.env['ENDPOINT_NAME'] ?? 'prod',
      endpointType: 'HomeRegion',
      authType: 'ApplicationManaged',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
    });

    new cdk.CfnOutput(this, 'RevisionId', { value: revision.attrRevisionId });
    new cdk.CfnOutput(this, 'DomainName', { value: endpoint.attrDomainName });
  }
}
