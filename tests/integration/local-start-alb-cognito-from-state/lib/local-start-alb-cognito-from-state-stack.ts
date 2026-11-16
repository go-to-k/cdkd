import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

/**
 * Fixture stack for `cdkd local start-alb --from-state` behind an
 * `authenticate-cognito` action whose config is the shape
 * `ListenerAction.authenticateCognito` emits (go-to-k/cdkd#6458):
 * `UserPoolArn: Fn::GetAtt <Pool>.Arn`, `UserPoolClientId: Ref <Client>`,
 * `UserPoolDomain: Ref <Domain>`. Only a state source can resolve them, and
 * cdkd records the client as `<poolId>|<clientId>`, so the guard's audience
 * is right only when the S3 state provider hands over the bare client id.
 *
 * The user pool, client and domain are deployed. The ALB and its listener are
 * NOT: a deployed ALB accepts an authenticate-* action only on an HTTPS
 * listener with a certificate, which this fixture cannot provision. They are
 * gated behind a condition that is always false, so cdkd skips them while the
 * synthesized template `cdkd local start-alb` reads still carries them. The
 * listener's terminal action is a fixed-response, so no container image is
 * needed.
 *
 * covers: AWS::Cognito::UserPool
 * covers: AWS::Cognito::UserPoolClient
 * covers: AWS::Cognito::UserPoolDomain
 */
export class LocalStartAlbCognitoFromStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pool = new cognito.UserPool(this, 'Pool', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const client = pool.addClient('Client', { authFlows: { adminUserPassword: true } });
    // A Cognito domain prefix is unique per region across accounts and may not
    // contain "cognito", "aws" or "amazon".
    const domain = pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `cdkd-albauth-${this.account}` },
    });

    const localOnly = new cdk.CfnCondition(this, 'LocalOnly', {
      expression: cdk.Fn.conditionEquals('deploy-the-alb', 'never'),
    });

    const alb = new elbv2.CfnLoadBalancer(this, 'WebLB', { type: 'application' });
    alb.cfnOptions.condition = localOnly;

    const listener = new elbv2.CfnListener(this, 'WebListener', {
      loadBalancerArn: alb.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [
        {
          type: 'authenticate-cognito',
          order: 1,
          authenticateCognitoConfig: {
            userPoolArn: pool.userPoolArn,
            userPoolClientId: client.userPoolClientId,
            userPoolDomain: domain.domainName,
          },
        },
        {
          type: 'fixed-response',
          order: 2,
          fixedResponseConfig: {
            statusCode: '200',
            contentType: 'text/plain',
            messageBody: 'secret',
          },
        },
      ],
    });
    listener.cfnOptions.condition = localOnly;

    new cdk.CfnOutput(this, 'PoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
  }
}
