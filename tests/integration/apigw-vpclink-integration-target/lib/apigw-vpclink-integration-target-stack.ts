import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';

/**
 * A REST API method with a private integration through a VPC link v2, routed
 * to an internal Application Load Balancer by `Integration.IntegrationTarget`
 * (issue #5391). Before the fix cdkd never sent `integrationTarget` to
 * `PutIntegration`, so the integration had no load balancer to route to.
 *
 * Two internal ALBs answer with different fixed bodies. The baseline routes
 * the method to ALB A; CDKD_TEST_UPDATE=true switches `IntegrationTarget` to
 * ALB B (and swaps the Deployment, since a stage serves the deployment it
 * points at, not the live method). The integration's `Uri` is the same in
 * both phases, so the body the stage answers with can only come from the
 * target. verify.sh reads `integrationTarget` back and curls the stage.
 *
 * The VPC has no NAT gateway: everything is in isolated subnets.
 *
 * covers: AWS::ApiGateway::Method
 * covers: AWS::ApiGatewayV2::VpcLink
 */
export class ApigwVpclinkIntegrationTargetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });

    // One group for the load balancers and the VPC link's network interfaces;
    // the self-reference lets the link reach the listeners.
    const sg = new ec2.SecurityGroup(this, 'Sg', { vpc, description: 'cdkd #5391 VPC link to ALB' });
    sg.addIngressRule(sg, ec2.Port.tcp(80), 'VPC link to the load balancers');

    // Fixed names, so verify.sh can backstop-delete exactly these two.
    const albFor = (name: string, lbName: string, body: string): elbv2.ApplicationLoadBalancer => {
      const alb = new elbv2.ApplicationLoadBalancer(this, name, {
        loadBalancerName: lbName,
        vpc,
        internetFacing: false,
        securityGroup: sg,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });
      alb.addListener(`${name}Listener`, {
        port: 80,
        open: false,
        defaultAction: elbv2.ListenerAction.fixedResponse(200, {
          contentType: 'text/plain',
          messageBody: body,
        }),
      });
      return alb;
    };
    const albA = albFor('AlbA', 'cdkd-5391-alb-a', 'from-alb-a');
    const albB = albFor('AlbB', 'cdkd-5391-alb-b', 'from-alb-b');

    const vpcLink = new apigatewayv2.CfnVpcLink(this, 'VpcLink', {
      name: 'cdkd-5391-vpclink',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
      securityGroupIds: [sg.securityGroupId],
    });

    const api = new apigateway.CfnRestApi(this, 'Api', {
      name: 'cdkd-5391-vpclink-api',
      endpointConfiguration: { types: ['REGIONAL'] },
    });

    const method = new apigateway.CfnMethod(this, 'Method', {
      restApiId: api.ref,
      resourceId: api.attrRootResourceId,
      httpMethod: 'GET',
      authorizationType: 'NONE',
      integration: {
        type: 'HTTP_PROXY',
        integrationHttpMethod: 'GET',
        connectionType: 'VPC_LINK',
        connectionId: vpcLink.ref,
        uri: 'http://cdkd-5391.example.com/',
      },
    });
    // An override, so the fixture does not depend on the aws-cdk-lib version
    // that added `integrationTarget` to the L1 props.
    method.addPropertyOverride(
      'Integration.IntegrationTarget',
      (update ? albB : albA).loadBalancerArn
    );
    // Both listeners exist before the method routes to either load balancer.
    for (const alb of [albA, albB]) {
      for (const listener of alb.listeners) method.node.addDependency(listener);
    }

    const deployment = new apigateway.CfnDeployment(this, update ? 'DeploymentB' : 'DeploymentA', {
      restApiId: api.ref,
    });
    deployment.addDependency(method);

    new apigateway.CfnStage(this, 'Stage', {
      restApiId: api.ref,
      deploymentId: deployment.ref,
      stageName: 'prod',
    });

    new cdk.CfnOutput(this, 'ApiId', { value: api.ref });
    new cdk.CfnOutput(this, 'RootResourceId', { value: api.attrRootResourceId });
    new cdk.CfnOutput(this, 'AlbAArn', { value: albA.loadBalancerArn });
    new cdk.CfnOutput(this, 'AlbBArn', { value: albB.loadBalancerArn });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
  }
}
