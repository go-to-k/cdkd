import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/**
 * AWS::EC2::Route extra-target-type fixture (issue #609 backfill).
 *
 * covers: AWS::EC2::Route
 * covers: AWS::EC2::PrefixList
 * covers: AWS::EC2::TransitGateway
 * covers: AWS::EC2::TransitGatewayAttachment
 *
 * Exercises the two formerly silent-drop Route properties that are
 * live-testable without Wavelength / Outposts / Cloud WAN:
 *
 * - `DestinationPrefixListId` — a route whose DESTINATION is a
 *   customer-managed prefix list (also exercises the `rtb|pl-...`
 *   physicalId form on create, update, and delete).
 * - `TransitGatewayId` — a route whose TARGET is a Transit Gateway
 *   (via a VPC attachment the route depends on).
 *
 * Phase 2 (CDKD_TEST_UPDATE=true) swaps the prefix-list route's target from
 * the Internet Gateway to the Transit Gateway, driving updateRoute's
 * delete + re-create through the prefix-list destination form.
 */
export class Ec2RouteTargetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.50.0.0/16',
      tags: [{ key: 'Name', value: 'cdkd-route-targets-vpc' }],
    });

    const subnet = new ec2.CfnSubnet(this, 'Subnet', {
      vpcId: vpc.ref,
      cidrBlock: '10.50.1.0/24',
      tags: [{ key: 'Name', value: 'cdkd-route-targets-subnet' }],
    });

    const igw = new ec2.CfnInternetGateway(this, 'Igw', {
      tags: [{ key: 'Name', value: 'cdkd-route-targets-igw' }],
    });

    const igwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: vpc.ref,
      internetGatewayId: igw.ref,
    });

    const routeTable = new ec2.CfnRouteTable(this, 'RouteTable', {
      vpcId: vpc.ref,
      tags: [{ key: 'Name', value: 'cdkd-route-targets-rtb' }],
    });

    const prefixList = new ec2.CfnPrefixList(this, 'PrefixList', {
      prefixListName: 'cdkd-route-targets-pl',
      addressFamily: 'IPv4',
      maxEntries: 4,
      entries: [{ cidr: '10.100.0.0/16', description: 'integ test destination' }],
      tags: [{ key: 'Name', value: 'cdkd-route-targets-pl' }],
    });

    const tgw = new ec2.CfnTransitGateway(this, 'Tgw', {
      description: 'cdkd ec2-route-targets integ',
      tags: [{ key: 'Name', value: 'cdkd-route-targets-tgw' }],
    });

    const tgwAttachment = new ec2.CfnTransitGatewayAttachment(this, 'TgwAttachment', {
      transitGatewayId: tgw.ref,
      vpcId: vpc.ref,
      subnetIds: [subnet.ref],
      tags: [{ key: 'Name', value: 'cdkd-route-targets-tgw-attachment' }],
    });

    // Route 1: prefix-list DESTINATION. Phase 1 targets the IGW; Phase 2
    // swaps the target to the Transit Gateway (delete + re-create through
    // the `rtb|pl-...` physicalId form).
    const plRoute = new ec2.CfnRoute(this, 'PrefixListRoute', {
      routeTableId: routeTable.ref,
      destinationPrefixListId: prefixList.attrPrefixListId,
      ...(isUpdate ? { transitGatewayId: tgw.ref } : { gatewayId: igw.ref }),
    });
    // A route to an IGW needs the gateway attached; a route to a TGW needs
    // the attachment available. Depend on both so either phase's target is
    // resolvable when CreateRoute fires.
    plRoute.addDependency(igwAttachment);
    plRoute.addDependency(tgwAttachment);

    // Route 2: Transit Gateway TARGET with a plain CIDR destination.
    const tgwRoute = new ec2.CfnRoute(this, 'TgwRoute', {
      routeTableId: routeTable.ref,
      destinationCidrBlock: '10.200.0.0/16',
      transitGatewayId: tgw.ref,
    });
    tgwRoute.addDependency(tgwAttachment);

    new cdk.CfnOutput(this, 'RouteTableId', { value: routeTable.ref });
    new cdk.CfnOutput(this, 'PrefixListId', { value: prefixList.attrPrefixListId });
    new cdk.CfnOutput(this, 'TransitGatewayId', { value: tgw.ref });
  }
}
