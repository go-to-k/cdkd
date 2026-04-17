import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeRouteTablesCommand,
  DescribeVpnGatewaysCommand,
  type Filter,
  type Subnet,
} from '@aws-sdk/client-ec2';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';

/**
 * VPC context provider
 *
 * Discovers VPC details including subnets, route tables, and AZs.
 * CDK provider type: "vpc-provider"
 */
export class VpcContextProvider implements ContextProvider {
  private logger = getLogger().child('VpcContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<unknown> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const filter = props['filter'] as Record<string, string> | undefined;
    const returnAsymmetricSubnets = props['returnAsymmetricSubnets'] as boolean | undefined;
    const subnetGroupNameTag = (props['subnetGroupNameTag'] as string) || 'aws-cdk:subnet-name';
    const returnVpnGateways = props['returnVpnGateways'] as boolean | undefined;

    this.logger.debug(`Looking up VPC (region: ${region}, filter: ${JSON.stringify(filter)})`);

    const client = new EC2Client({
      ...(region && { region }),
    });

    try {
      // 1. Find VPC
      const vpcFilters: Filter[] = filter
        ? Object.entries(filter).map(([name, value]) => ({
            Name: name,
            Values: [String(value)],
          }))
        : [];

      const vpcsResponse = await client.send(new DescribeVpcsCommand({ Filters: vpcFilters }));

      const vpcs = vpcsResponse.Vpcs ?? [];
      if (vpcs.length === 0) {
        throw new Error(`No VPC found matching filter: ${JSON.stringify(filter)}`);
      }
      if (vpcs.length > 1) {
        throw new Error(
          `Multiple VPCs found matching filter: ${JSON.stringify(filter)}. ` +
            `Found: ${vpcs.map((v) => v.VpcId).join(', ')}`
        );
      }

      const vpc = vpcs[0]!;
      const vpcId = vpc.VpcId!;
      this.logger.debug(`Found VPC: ${vpcId}`);

      // 2. Get subnets
      const subnetsResponse = await client.send(
        new DescribeSubnetsCommand({
          Filters: [{ Name: 'vpc-id', Values: [vpcId] }],
        })
      );
      const subnets = subnetsResponse.Subnets ?? [];

      // 3. Get route tables
      const rtResponse = await client.send(
        new DescribeRouteTablesCommand({
          Filters: [{ Name: 'vpc-id', Values: [vpcId] }],
        })
      );
      const routeTables = rtResponse.RouteTables ?? [];

      // Build subnet → route table mapping
      const subnetRouteTableMap = new Map<string, string>();
      let mainRouteTableId: string | undefined;
      for (const rt of routeTables) {
        for (const assoc of rt.Associations ?? []) {
          if (assoc.Main) {
            mainRouteTableId = rt.RouteTableId;
          }
          if (assoc.SubnetId && rt.RouteTableId) {
            subnetRouteTableMap.set(assoc.SubnetId, rt.RouteTableId);
          }
        }
      }

      // 4. Classify subnets
      const routeTableInfos = routeTables.map((rt) => ({
        routeTableId: rt.RouteTableId ?? '',
        routes: (rt.Routes ?? []).map((r) => ({
          gatewayId: r.GatewayId,
          natGatewayId: r.NatGatewayId,
        })),
      }));

      const classifiedSubnets = this.classifySubnets(
        subnets,
        subnetRouteTableMap,
        mainRouteTableId,
        routeTableInfos,
        subnetGroupNameTag
      );

      // Sort by AZ for consistent ordering
      const sortByAz = (a: SubnetInfo, b: SubnetInfo) => a.az.localeCompare(b.az);

      const publicSubnets = classifiedSubnets.filter((s) => s.type === 'Public').sort(sortByAz);
      const privateSubnets = classifiedSubnets.filter((s) => s.type === 'Private').sort(sortByAz);
      const isolatedSubnets = classifiedSubnets.filter((s) => s.type === 'Isolated').sort(sortByAz);

      // 5. Get VPN gateway (optional)
      let vpnGatewayId: string | undefined;
      if (returnVpnGateways !== false) {
        const vpnResponse = await client.send(
          new DescribeVpnGatewaysCommand({
            Filters: [
              { Name: 'attachment.vpc-id', Values: [vpcId] },
              { Name: 'attachment.state', Values: ['attached'] },
            ],
          })
        );
        vpnGatewayId = vpnResponse.VpnGateways?.[0]?.VpnGatewayId;
      }

      // 6. Build result
      const azs = [...new Set(subnets.map((s) => s.AvailabilityZone!))].sort();

      const result: Record<string, unknown> = {
        vpcId,
        vpcCidrBlock: vpc.CidrBlock,
        ownerAccountId: vpc.OwnerId,
        availabilityZones: azs,
        publicSubnetIds: publicSubnets.map((s) => s.subnetId),
        publicSubnetNames: publicSubnets.map((s) => s.name),
        publicSubnetRouteTableIds: publicSubnets.map((s) => s.routeTableId),
        privateSubnetIds: privateSubnets.map((s) => s.subnetId),
        privateSubnetNames: privateSubnets.map((s) => s.name),
        privateSubnetRouteTableIds: privateSubnets.map((s) => s.routeTableId),
        isolatedSubnetIds: isolatedSubnets.map((s) => s.subnetId),
        isolatedSubnetNames: isolatedSubnets.map((s) => s.name),
        isolatedSubnetRouteTableIds: isolatedSubnets.map((s) => s.routeTableId),
      };

      if (vpnGatewayId) {
        result['vpnGatewayId'] = vpnGatewayId;
      }

      if (returnAsymmetricSubnets) {
        result['subnetGroups'] = this.buildSubnetGroups(classifiedSubnets);
      }

      this.logger.debug(
        `VPC ${vpcId}: ${publicSubnets.length} public, ${privateSubnets.length} private, ${isolatedSubnets.length} isolated subnets`
      );

      return result;
    } finally {
      client.destroy();
    }
  }

  /**
   * Classify subnets as Public, Private, or Isolated
   */
  private classifySubnets(
    subnets: Subnet[],
    subnetRouteTableMap: Map<string, string>,
    mainRouteTableId: string | undefined,
    routeTables: {
      routeTableId: string;
      routes: { gatewayId?: string | undefined; natGatewayId?: string | undefined }[];
    }[],
    subnetGroupNameTag: string
  ): SubnetInfo[] {
    // Build route table → has IGW/NAT mapping
    const rtHasIgw = new Map<string, boolean>();
    const rtHasNat = new Map<string, boolean>();
    for (const rt of routeTables) {
      const hasIgw = rt.routes.some((r) => r.gatewayId?.startsWith('igw-'));
      const hasNat = rt.routes.some((r) => r.natGatewayId?.startsWith('nat-'));
      rtHasIgw.set(rt.routeTableId, hasIgw);
      rtHasNat.set(rt.routeTableId, hasNat);
    }

    return subnets.map((subnet) => {
      const subnetId = subnet.SubnetId!;
      const az = subnet.AvailabilityZone!;
      const routeTableId = subnetRouteTableMap.get(subnetId) || mainRouteTableId || '';

      // Determine type from tags first
      const tags = subnet.Tags ?? [];
      const nameTag = tags.find((t) => t.Key === subnetGroupNameTag);
      let name = nameTag?.Value || '';

      // Determine type
      let type: 'Public' | 'Private' | 'Isolated';
      if (nameTag?.Value) {
        // Trust tag-based classification
        const lowerName = nameTag.Value.toLowerCase();
        if (lowerName.includes('public')) {
          type = 'Public';
        } else if (lowerName.includes('private')) {
          type = 'Private';
        } else if (lowerName.includes('isolated')) {
          type = 'Isolated';
        } else {
          // Fall back to route analysis
          type = this.classifyByRoute(routeTableId, rtHasIgw, rtHasNat, subnet);
        }
      } else {
        type = this.classifyByRoute(routeTableId, rtHasIgw, rtHasNat, subnet);
        name = type;
      }

      return { subnetId, az, routeTableId, type, name };
    });
  }

  private classifyByRoute(
    routeTableId: string,
    rtHasIgw: Map<string, boolean>,
    rtHasNat: Map<string, boolean>,
    subnet: Subnet
  ): 'Public' | 'Private' | 'Isolated' {
    if (rtHasIgw.get(routeTableId) || subnet.MapPublicIpOnLaunch) {
      return 'Public';
    }
    if (rtHasNat.get(routeTableId)) {
      return 'Private';
    }
    return 'Isolated';
  }

  /**
   * Build subnet groups for asymmetric subnet support
   */
  private buildSubnetGroups(subnets: SubnetInfo[]): unknown[] {
    const groups = new Map<string, SubnetInfo[]>();
    for (const subnet of subnets) {
      const key = `${subnet.type}/${subnet.name}`;
      const group = groups.get(key) ?? [];
      group.push(subnet);
      groups.set(key, group);
    }

    return Array.from(groups.entries()).map(([, groupSubnets]) => ({
      name: groupSubnets[0]!.name,
      type: groupSubnets[0]!.type,
      subnets: groupSubnets
        .sort((a, b) => a.az.localeCompare(b.az))
        .map((s) => ({
          subnetId: s.subnetId,
          availabilityZone: s.az,
          routeTableId: s.routeTableId,
        })),
    }));
  }
}

interface SubnetInfo {
  subnetId: string;
  az: string;
  routeTableId: string;
  type: 'Public' | 'Private' | 'Isolated';
  name: string;
}
