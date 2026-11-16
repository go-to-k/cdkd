import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';

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
 * physicalId-parity arm for issue 6454, batch 2: a resource of each of eleven
 * types, recorded `provisionedBy: 'cc-api'`, returns to its SDK provider
 * without churn.
 *
 * covers: AWS::EC2::VPC, AWS::EC2::InternetGateway, AWS::EC2::NetworkAcl,
 * AWS::IAM::User, AWS::IAM::Group, AWS::IAM::InstanceProfile,
 * AWS::StepFunctions::StateMachine, AWS::Lambda::Url, AWS::Cognito::UserPool,
 * AWS::CloudFront::OriginAccessControl, AWS::KMS::Alias
 *
 * Every resource under test is a LEAF: nothing in the stack references it, so
 * verify.sh's `--recreate-via-cc-api` replaces only that resource and no
 * dependent's create-only property changes with it. Each one's logical id is
 * fixed so verify.sh can name it without reading the template. verify.sh holds
 * each type's identity witness and live readback.
 */
export class CcToSdkRerouteCommonTypes2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const value = VALUE_BY_PHASE[process.env.CDKD_TEST_PHASE ?? 'base'] ?? 'a';
    const phase = `phase-${value}`;
    const phaseTags = [{ key: 'cdkd-phase', value: phase }];
    const fixed = (resource: cdk.CfnResource, logicalId: string): void => {
      resource.overrideLogicalId(logicalId);
    };

    fixed(new ec2.CfnVPC(this, 'SubjectVpc', { cidrBlock: '10.43.0.0/24', tags: phaseTags }), 'RerouteVpc');
    fixed(new ec2.CfnInternetGateway(this, 'InternetGateway', { tags: phaseTags }), 'RerouteInternetGateway');

    // The network ACL's VPC is NOT under test, so its id holds across every
    // phase and the ACL's create-only VpcId never changes.
    const hostVpc = new ec2.CfnVPC(this, 'HostVpc', { cidrBlock: '10.44.0.0/24' });
    fixed(new ec2.CfnNetworkAcl(this, 'NetworkAcl', { vpcId: hostVpc.ref, tags: phaseTags }), 'RerouteNetworkAcl');

    fixed(new iam.CfnUser(this, 'User', { tags: phaseTags }), 'RerouteUser');
    fixed(new iam.CfnGroup(this, 'Group', { path: `/${phase}/` }), 'RerouteGroup');

    // The instance profile's two candidate roles are NOT under test.
    const ec2Trust = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    };
    const roleA = new iam.CfnRole(this, 'ProfileRoleA', { assumeRolePolicyDocument: ec2Trust });
    const roleB = new iam.CfnRole(this, 'ProfileRoleB', { assumeRolePolicyDocument: ec2Trust });
    fixed(
      new iam.CfnInstanceProfile(this, 'InstanceProfile', { roles: [value === 'a' ? roleA.ref : roleB.ref] }),
      'RerouteInstanceProfile'
    );

    const statesRole = new iam.CfnRole(this, 'StatesRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'states.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      },
    });
    fixed(
      new sfn.CfnStateMachine(this, 'StateMachine', {
        roleArn: statesRole.attrArn,
        definitionString: JSON.stringify({
          StartAt: 'Done',
          States: { Done: { Type: 'Pass', Result: phase, End: true } },
        }),
      }),
      'RerouteStateMachine'
    );

    // The URL's function is NOT under test.
    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 });'),
    });
    fixed(
      new lambda.CfnUrl(this, 'FunctionUrl', {
        targetFunctionArn: handler.functionArn,
        authType: 'AWS_IAM',
        cors: { maxAge: value === 'a' ? 100 : 200 },
      }),
      'RerouteFunctionUrl'
    );

    const userPool = new cognito.CfnUserPool(this, 'UserPool', { userPoolTags: { 'cdkd-phase': phase } });
    userPool.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    fixed(userPool, 'RerouteUserPool');

    fixed(
      new cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
        originAccessControlConfig: {
          name: `${this.stackName}-oac`,
          description: phase,
          originAccessControlOriginType: 's3',
          signingBehavior: 'always',
          signingProtocol: 'sigv4',
        },
      }),
      'RerouteOriginAccessControl'
    );

    // The alias's two candidate keys are NOT under test.
    const keyPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: `arn:${this.partition}:iam::${this.account}:root` },
          Action: 'kms:*',
          Resource: '*',
        },
      ],
    };
    const keyA = new kms.CfnKey(this, 'AliasKeyA', { pendingWindowInDays: 7, keyPolicy });
    const keyB = new kms.CfnKey(this, 'AliasKeyB', { pendingWindowInDays: 7, keyPolicy });
    keyA.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    keyB.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    fixed(
      new kms.CfnAlias(this, 'Alias', {
        aliasName: `alias/${this.stackName}`,
        targetKeyId: value === 'a' ? keyA.ref : keyB.ref,
      }),
      'RerouteAlias'
    );

    new cdk.CfnOutput(this, 'HostVpcId', { value: hostVpc.ref });
    new cdk.CfnOutput(this, 'ProfileRoleAName', { value: roleA.ref });
    new cdk.CfnOutput(this, 'ProfileRoleBName', { value: roleB.ref });
    new cdk.CfnOutput(this, 'StatesRoleName', { value: statesRole.ref });
    new cdk.CfnOutput(this, 'HandlerName', { value: handler.functionName });
    new cdk.CfnOutput(this, 'AliasKeyAId', { value: keyA.ref });
    new cdk.CfnOutput(this, 'AliasKeyBId', { value: keyB.ref });
  }
}
