import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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
 * covers: AWS::SSM::Parameter
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

    // go-to-k/cdkd#4978: a PerRegion endpoint whose second region's domain is
    // read through a dotted `Fn::GetAtt` into its `RegionalEndpoints` map. The
    // parameter is the consumer: verify.sh compares its value with the domain
    // AWS reports, so an unresolved GetAtt (served as the endpoint ARN) fails.
    const secondaryRegion = process.env['SECONDARY_REGION'] ?? 'us-west-2';
    const regionalEndpoint = new lambda.CfnWebFunctionEndpoint(this, 'RegionalEndpoint', {
      functionName: fn.ref,
      // A later phase renames it with the release before #4978, so that
      // release CREATES the record this build then heals.
      endpointName: process.env['REGIONAL_ENDPOINT_NAME'] ?? 'regional',
      endpointType: 'PerRegion',
      regions: [this.region, secondaryRegion],
      authType: 'ApplicationManaged',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
    });
    new ssm.CfnParameter(this, 'RegionalDomainParameter', {
      name: '/cdkd-integ/webfn-replace/regional-domain',
      type: 'String',
      value: cdk.Fn.getAtt(regionalEndpoint.logicalId, `RegionalEndpoints.${secondaryRegion}.DomainName`).toString(),
    });

    new cdk.CfnOutput(this, 'RevisionId', { value: revision.attrRevisionId });
    new cdk.CfnOutput(this, 'DomainName', { value: endpoint.attrDomainName });
  }
}
