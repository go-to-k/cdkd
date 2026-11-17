import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

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

/** The proxy's IdleClientTimeout (seconds) for each value. */
const IDLE_TIMEOUT: Record<'a' | 'b', number> = { a: 1800, b: 1700 };

/**
 * physicalId-parity arm for issue 6490, batch 11: an `AWS::RDS::DBProxy` and
 * an `AWS::RDS::DBProxyEndpoint` on it, each recorded `provisionedBy:
 * 'cc-api'`, return to the SDK provider without churn.
 *
 * covers: AWS::RDS::DBProxy
 * covers: AWS::RDS::DBProxyEndpoint
 *
 * Both layers record the same id (measured us-east-1, 2026-11-18): the proxy
 * name and the endpoint name, each its schema primaryIdentifier. The proxy has
 * no target: a proxy and its endpoints reach `available` without one, so the
 * fixture needs no database. The proxy changes its IdleClientTimeout, the
 * endpoint its security group.
 *
 * Both names change once, at the `seed` deploy that recreates them on Cloud
 * Control, and stay fixed from then on: the recreate is then create-first, so
 * the old endpoint is never left on a proxy being deleted. The endpoint is the
 * proxy's only dependent; nothing else references a resource under test, and
 * each logical id is fixed.
 */
export class CcToSdkRerouteCommonTypes11Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phaseName = process.env.CDKD_TEST_PHASE ?? 'base';
    const value = VALUE_BY_PHASE[phaseName] ?? 'a';
    // 1 for the SDK create, 2 from the Cloud Control recreate onwards.
    const generation = phaseName === 'base' ? '1' : '2';

    // NOT under test: the network, the proxy's secret and role, and the
    // endpoint's two security groups. No NAT gateway: nothing leaves the VPC.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });
    const subnetIds = vpc.isolatedSubnets.map((s) => s.subnetId);
    const securityGroup = (sgId: string) =>
      new ec2.SecurityGroup(this, sgId, { vpc, description: `cdkd reroute ct11 ${sgId}` });
    const groupA = securityGroup('EndpointSgA');
    const groupB = securityGroup('EndpointSgB');

    // The proxy reads it only when a client connects; it holds no real
    // credentials. Deleted with the stack.
    const secret = new secretsmanager.Secret(this, 'ProxySecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'cdkd' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, 'ProxyRole', {
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
    });
    secret.grantRead(role);

    const proxy = new rds.CfnDBProxy(this, 'RerouteDBProxy', {
      dbProxyName: `cdkd-reroute-ct11-proxy-${generation}`,
      engineFamily: 'MYSQL',
      auth: [{ authScheme: 'SECRETS', secretArn: secret.secretArn, iamAuth: 'DISABLED' }],
      roleArn: role.roleArn,
      vpcSubnetIds: subnetIds,
      idleClientTimeout: IDLE_TIMEOUT[value],
    });
    proxy.overrideLogicalId('RerouteDBProxy');
    // The proxy reads the secret through the role, so the grant must land first.
    proxy.node.addDependency(role);

    const endpoint = new rds.CfnDBProxyEndpoint(this, 'RerouteDBProxyEndpoint', {
      dbProxyEndpointName: `cdkd-reroute-ct11-ep-${generation}`,
      dbProxyName: proxy.ref,
      vpcSubnetIds: subnetIds,
      vpcSecurityGroupIds: [(value === 'a' ? groupA : groupB).securityGroupId],
    });
    endpoint.overrideLogicalId('RerouteDBProxyEndpoint');

    // Ref of a proxy is its name and of an endpoint its name, on both layers;
    // the GetAtts are read beside them.
    new cdk.CfnOutput(this, 'ProxyRef', { value: proxy.ref });
    new cdk.CfnOutput(this, 'ProxyArn', { value: proxy.attrDbProxyArn });
    new cdk.CfnOutput(this, 'ProxyEndpoint', { value: proxy.attrEndpoint });
    new cdk.CfnOutput(this, 'EndpointRef', { value: endpoint.ref });
    new cdk.CfnOutput(this, 'EndpointArn', { value: endpoint.attrDbProxyEndpointArn });
    new cdk.CfnOutput(this, 'EndpointEndpoint', { value: endpoint.attrEndpoint });
    new cdk.CfnOutput(this, 'EndpointSgAId', { value: groupA.securityGroupId });
    new cdk.CfnOutput(this, 'EndpointSgBId', { value: groupB.securityGroupId });
    new cdk.CfnOutput(this, 'ProxySecretArn', { value: secret.secretArn });
  }
}
