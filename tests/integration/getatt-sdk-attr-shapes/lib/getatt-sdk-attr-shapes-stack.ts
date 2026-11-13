import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

/**
 * Read-only `Fn::GetAtt` attributes of SDK-provider types that resolved to the
 * resource's physical id before go-to-k/cdkd#6238, each published as an
 * Output: ASG `AutoScalingGroupARN`, WAFv2 WebACL `Capacity`, AppSync ApiKey
 * `ApiKeyId`, S3Tables Table `WarehouseLocation` / `VersionToken`.
 *
 * `CDKD_TEST_UPDATE=true` adds a second managed rule group to the web ACL
 * (its `Capacity` must follow) and raises the ASG's `MaxSize` 0 -> 1, both in
 * place. The ASG keeps a desired capacity of 0, so no instance is launched.
 */
export class GetAttSdkAttrShapesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [{ name: 'pub', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const launchTemplate = new ec2.CfnLaunchTemplate(this, 'Lt', {
      launchTemplateData: {
        imageId: ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId,
        instanceType: 't3.micro',
      },
    });
    const asg = new autoscaling.CfnAutoScalingGroup(this, 'Asg', {
      minSize: '0',
      maxSize: isUpdate ? '1' : '0',
      desiredCapacity: '0',
      vpcZoneIdentifier: vpc.publicSubnets.map((s) => s.subnetId),
      launchTemplate: {
        launchTemplateId: launchTemplate.ref,
        version: launchTemplate.attrLatestVersionNumber,
      },
    });

    const managedRule = (name: string, metricName: string, priority: number) => ({
      name: metricName,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: {
        cloudWatchMetricsEnabled: false,
        metricName,
        sampledRequestsEnabled: false,
      },
    });
    const acl = new wafv2.CfnWebACL(this, 'Acl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: false,
        metricName: 'acl',
        sampledRequestsEnabled: false,
      },
      rules: [
        managedRule('AWSManagedRulesCommonRuleSet', 'common', 0),
        ...(isUpdate ? [managedRule('AWSManagedRulesKnownBadInputsRuleSet', 'badinputs', 1)] : []),
      ],
    });

    const api = new appsync.CfnGraphQLApi(this, 'Api', {
      name: 'cdkd-getatt-sdk-attr-shapes-api',
      authenticationType: 'API_KEY',
    });
    const apiKey = new appsync.CfnApiKey(this, 'Key', { apiId: api.attrApiId });

    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName: 'cdkd-getatt-sdk-attr-shapes',
    });
    const namespace = new s3tables.CfnNamespace(this, 'Namespace', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: 'shapes',
    });
    const table = new s3tables.CfnTable(this, 'Table', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: 'shapes',
      tableName: 'shapes',
      openTableFormat: 'ICEBERG',
      icebergMetadata: {
        icebergSchema: { schemaFieldList: [{ name: 'id', type: 'int', required: true }] },
      },
    });
    table.addDependency(namespace);

    new cdk.CfnOutput(this, 'AsgName', { value: asg.ref });
    new cdk.CfnOutput(this, 'AsgArn', { value: asg.attrAutoScalingGroupArn });
    new cdk.CfnOutput(this, 'AclArn', { value: acl.attrArn });
    new cdk.CfnOutput(this, 'AclCapacity', { value: cdk.Token.asString(acl.attrCapacity) });
    new cdk.CfnOutput(this, 'ApiId', { value: api.attrApiId });
    new cdk.CfnOutput(this, 'KeyApiKeyId', { value: apiKey.attrApiKeyId });
    new cdk.CfnOutput(this, 'TableArn', { value: table.attrTableArn });
    new cdk.CfnOutput(this, 'TableWarehouseLocation', { value: table.attrWarehouseLocation });
    new cdk.CfnOutput(this, 'TableVersionToken', { value: table.attrVersionToken });
  }
}
