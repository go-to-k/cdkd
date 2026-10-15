import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * A Lambda network connector in the account's default VPC (go-to-k/cdkd#4928).
 * verify.sh looks the subnets and the default security group up and hands them
 * in, so the stack creates no VPC resource a lingering ENI could hold.
 *
 * TAG_KEY / TAG_VALUE change the tag (a tags-only update: untag the old key,
 * tag the new one); a different SUBNET_IDS pair is an UpdateNetworkConnector
 * (a new version). `AssociatedComputeResourceTypes` stays fixed: AWS refuses
 * to change it on an existing connector.
 *
 * covers: AWS::Lambda::NetworkConnector
 */
export class LambdaNetworkConnectorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const required = (name: string): string => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} must be set (verify.sh looks it up)`);
      return value;
    };

    const operatorRole = new iam.Role(this, 'OperatorRole', {
      roleName: `cdkd-integ-nc-operator-${this.region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        eni: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ec2:CreateNetworkInterface'],
              resources: [
                'arn:aws:ec2:*:*:network-interface/*',
                'arn:aws:ec2:*:*:subnet/*',
                'arn:aws:ec2:*:*:security-group/*',
              ],
            }),
            new iam.PolicyStatement({
              actions: ['ec2:CreateTags'],
              resources: ['arn:aws:ec2:*:*:network-interface/*'],
              conditions: {
                StringEquals: {
                  'ec2:ManagedResourceOperator': 'network-connectors.lambda.amazonaws.com',
                },
              },
            }),
          ],
        }),
      },
    });

    // ROLE_ONLY=1 deploys just the role, so a following deploy creates the
    // connector against a role whose permissions have had time to propagate.
    if (process.env['ROLE_ONLY'] === '1') return;

    const connector = new lambda.CfnNetworkConnector(this, 'Connector', {
      name: required('CONNECTOR_NAME'),
      operatorRole: operatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          subnetIds: required('SUBNET_IDS').split(','),
          securityGroupIds: [required('SECURITY_GROUP_ID')],
          networkProtocol: 'IPv4',
          // At most one type (measured: the API refuses two).
          associatedComputeResourceTypes: ['WebFunction'],
        },
      },
      tags: [{ key: process.env['TAG_KEY'] ?? 'cdkd-integ', value: process.env['TAG_VALUE'] ?? 'v1' }],
    });
    // The connector's ENIs are created with the operator role's permissions.
    connector.node.addDependency(operatorRole);

    new cdk.CfnOutput(this, 'ConnectorArn', { value: connector.attrArn });
    new cdk.CfnOutput(this, 'LatestVersionArn', { value: connector.attrLatestVersionArn });
  }
}
