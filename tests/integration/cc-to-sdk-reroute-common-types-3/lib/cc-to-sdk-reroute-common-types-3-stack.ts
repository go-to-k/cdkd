import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

/**
 * The value each routing phase declares on every resource under test.
 * Consecutive deploys must differ: one the differ calls NO_CHANGE never
 * provisions a resource, so it could not flip. verify.sh runs its `cdkd diff`
 * with `pinned`, because `seed` and `flip` declare the same value.
 */
const VALUE_BY_PHASE: Record<string, 'a' | 'b'> = {
  base: 'a',
  seed: 'b',
  pinned: 'a',
  flip: 'b',
};

/**
 * physicalId-parity arm for issue 6454, batch 3: a resource of each of five
 * types, recorded `provisionedBy: 'cc-api'`, returns to its SDK provider
 * without churn.
 *
 * covers: AWS::CloudFront::CloudFrontOriginAccessIdentity,
 * AWS::ServiceDiscovery::HttpNamespace, AWS::Glue::Database, AWS::Glue::Job,
 * AWS::ECR::Repository
 *
 * Every resource under test is a LEAF: nothing in the stack references it, so
 * verify.sh's `--recreate-via-cc-api` replaces only that resource and no
 * dependent's create-only property changes with it. Each one's logical id is
 * fixed so verify.sh can name it without reading the template. verify.sh holds
 * each type's identity witness and live readback.
 */
export class CcToSdkRerouteCommonTypes3Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const value = VALUE_BY_PHASE[process.env.CDKD_TEST_PHASE ?? 'base'] ?? 'a';
    const phase = `phase-${value}`;
    const fixed = (resource: cdk.CfnResource, logicalId: string): void => {
      resource.overrideLogicalId(logicalId);
    };
    const servicePrincipalRole = (logicalId: string, service: string): iam.CfnRole =>
      new iam.CfnRole(this, logicalId, {
        assumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }],
        },
      });

    fixed(
      new cloudfront.CfnCloudFrontOriginAccessIdentity(this, 'OriginAccessIdentity', {
        cloudFrontOriginAccessIdentityConfig: { comment: phase },
      }),
      'RerouteOriginAccessIdentity'
    );

    fixed(
      new servicediscovery.CfnHttpNamespace(this, 'HttpNamespace', {
        name: `${this.stackName}-ns`,
        description: phase,
      }),
      'RerouteHttpNamespace'
    );

    fixed(
      new glue.CfnDatabase(this, 'GlueDatabase', {
        catalogId: this.account,
        databaseInput: { name: 'cdkd_reroute_common_types_3', description: phase },
      }),
      'RerouteGlueDatabase'
    );

    // The job's role is NOT under test.
    const glueRole = servicePrincipalRole('GlueRole', 'glue.amazonaws.com');
    fixed(
      new glue.CfnJob(this, 'GlueJob', {
        role: glueRole.attrArn,
        description: phase,
        command: { name: 'pythonshell', pythonVersion: '3.9', scriptLocation: 's3://cdkd-reroute-unused/script.py' },
        maxCapacity: 0.0625,
      }),
      'RerouteGlueJob'
    );

    const repository = new ecr.CfnRepository(this, 'Repository', {
      imageTagMutability: value === 'a' ? 'MUTABLE' : 'IMMUTABLE',
    });
    repository.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    fixed(repository, 'RerouteRepository');

    new cdk.CfnOutput(this, 'GlueRoleName', { value: glueRole.ref });
  }
}
