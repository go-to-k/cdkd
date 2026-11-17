import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

/**
 * Issue 6484: AWS refuses UpdateService for a service in an HTTP (API-only)
 * namespace, and CloudFormation reports that update as applied while changing
 * nothing. cdkd must keep deploying, warn, and record what AWS still holds.
 *
 * covers: AWS::ServiceDiscovery::HttpNamespace, AWS::ServiceDiscovery::Service
 *
 * `CDKD_TEST_UPDATE=true` changes only the service's Description.
 */
export class ServiceDiscoveryHttpNamespaceUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const namespace = new servicediscovery.CfnHttpNamespace(this, 'Namespace', {
      name: `${this.stackName}-ns`,
    });
    const service = new servicediscovery.CfnService(this, 'Service', {
      name: 'api',
      namespaceId: namespace.attrId,
      description: update ? 'description-b' : 'description-a',
    });
    service.overrideLogicalId('HttpService');

    new cdk.CfnOutput(this, 'NamespaceId', { value: namespace.attrId });
  }
}
