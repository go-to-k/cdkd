import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ probe for `cdkd import --migrate-from-cloudformation` recording the
 * attribute maps `create()` records (issue #3627), second batch. Before the
 * fix each of these resolved to the physical id (or was refused) after an
 * import:
 *
 * - ELBv2 LoadBalancer `DNSName` / `CanonicalHostedZoneID` /
 *   `LoadBalancerFullName` / `LoadBalancerName`, TargetGroup
 *   `TargetGroupFullName` / `TargetGroupName` (the resolver has no ELBv2 arm);
 * - EC2 Subnet `AvailabilityZone` (the arm builds only `SubnetId`);
 * - ServiceDiscovery Service `Name`;
 * - EFS AccessPoint `Arn` (refused: the physical id is `fsap-...`);
 * - CloudFront OAI `S3CanonicalUserId`.
 *
 * One SSM parameter per attribute carries the `Fn::GetAtt`; verify.sh compares
 * each imported parameter record against what AWS reports.
 */
export class ImportAttributeReadbackNetworkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pin = (c: cdk.CfnResource, logicalId: string) => c.overrideLogicalId(logicalId);
    const param = (logicalId: string, value: string) => {
      const p = new ssm.StringParameter(this, logicalId, { stringValue: value });
      pin(p.node.defaultChild as cdk.CfnResource, logicalId);
    };

    // L1 VPC + two subnets and NO route tables: a CDK `ec2.Vpc` synthesizes
    // route tables and associations, which `--migrate-from-cloudformation`
    // cannot adopt yet (issue #3661), so the post-import deploy would re-create
    // them. Subnets without an explicit association use the main route table.
    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.42.0.0/16' });
    pin(vpc, 'Vpc');
    const subnetIn = (logicalId: string, index: number, cidr: string) => {
      const s = new ec2.CfnSubnet(this, logicalId, {
        vpcId: vpc.ref,
        cidrBlock: cidr,
        availabilityZone: cdk.Fn.select(index, cdk.Fn.getAzs()),
      });
      pin(s, logicalId);
      return s;
    };
    const subnet = subnetIn('Subnet', 0, '10.42.0.0/24');
    const subnet2 = subnetIn('Subnet2', 1, '10.42.1.0/24');
    param('SubnetAzParam', subnet.attrAvailabilityZone);

    const lb = new elbv2.CfnLoadBalancer(this, 'Lb', {
      type: 'application',
      scheme: 'internal',
      subnets: [subnet.ref, subnet2.ref],
    });
    pin(lb, 'Lb');
    param('LbDnsNameParam', lb.attrDnsName);
    param('LbZoneParam', lb.attrCanonicalHostedZoneId);
    param('LbFullNameParam', lb.attrLoadBalancerFullName);
    param('LbNameParam', lb.attrLoadBalancerName);

    const tg = new elbv2.CfnTargetGroup(this, 'Tg', {
      vpcId: vpc.ref,
      port: 80,
      protocol: 'HTTP',
      targetType: 'ip',
    });
    pin(tg, 'Tg');
    param('TgFullNameParam', tg.attrTargetGroupFullName);
    param('TgNameParam', tg.attrTargetGroupName);

    const ns = new servicediscovery.HttpNamespace(this, 'Ns', { name: 'cdkd-import-readback-net' });
    const svc = ns.createService('Svc');
    const cfnSvc = svc.node.defaultChild as servicediscovery.CfnService;
    pin(cfnSvc, 'Svc');
    param('SvcNameParam', cfnSvc.attrName);

    const fs = new efs.CfnFileSystem(this, 'Fs', {});
    pin(fs, 'Fs');
    const ap = new efs.CfnAccessPoint(this, 'Ap', { fileSystemId: fs.ref });
    pin(ap, 'Ap');
    param('ApArnParam', ap.attrArn);

    const oai = new cloudfront.CfnCloudFrontOriginAccessIdentity(this, 'Oai', {
      cloudFrontOriginAccessIdentityConfig: { comment: 'cdkd import readback integ (#3627)' },
    });
    pin(oai, 'Oai');
    param('OaiCanonParam', oai.attrS3CanonicalUserId);
  }
}
