import {
  Route53Client,
  ListHostedZonesByNameCommand,
  GetHostedZoneCommand,
} from '@aws-sdk/client-route-53';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Hosted Zone context provider
 *
 * Looks up Route53 hosted zones by domain name.
 * CDK provider type: "hosted-zone"
 */
export class HostedZoneContextProvider implements ContextProvider {
  private logger = getLogger().child('HostedZoneContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<unknown> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const domainName = props['domainName'] as string;
    const privateZone = props['privateZone'] as boolean | undefined;
    const vpcId = props['vpcId'] as string | undefined;

    if (!domainName) {
      throw new Error('Hosted zone context provider requires domainName property');
    }

    this.logger.debug(`Looking up hosted zone: ${domainName} (private: ${privateZone})`);

    const client = new Route53Client({
      ...(region && { region }),
    });

    try {
      const response = await client.send(
        new ListHostedZonesByNameCommand({
          DNSName: domainName,
          MaxItems: 10,
        })
      );

      const zones = response.HostedZones ?? [];

      // Filter by domain name (exact match with trailing dot)
      const normalizedDomain = domainName.endsWith('.') ? domainName : `${domainName}.`;
      const matching = zones.filter((z) => z.Name === normalizedDomain);

      // Filter by private/public
      let filtered = matching;
      if (privateZone !== undefined) {
        filtered = matching.filter((z) => z.Config?.PrivateZone === privateZone);
      }

      // Filter by VPC (for private zones)
      if (vpcId && filtered.length > 0) {
        const vpcFiltered = [];
        for (const zone of filtered) {
          const zoneDetail = await client.send(
            new GetHostedZoneCommand({ Id: zone.Id })
          );
          const zoneVpcs = zoneDetail.VPCs ?? [];
          if (zoneVpcs.some((v) => v.VPCId === vpcId)) {
            vpcFiltered.push(zone);
          }
        }
        filtered = vpcFiltered;
      }

      if (filtered.length === 0) {
        throw new Error(
          `No hosted zone found for domain: ${domainName}` +
          (privateZone !== undefined ? ` (private: ${privateZone})` : '') +
          (vpcId ? ` (vpcId: ${vpcId})` : '')
        );
      }

      if (filtered.length > 1) {
        throw new Error(
          `Multiple hosted zones found for domain: ${domainName}. ` +
          `Found: ${filtered.map((z) => z.Id).join(', ')}`
        );
      }

      const zone = filtered[0]!;
      // Strip /hostedzone/ prefix from ID
      const zoneId = zone.Id!.replace('/hostedzone/', '');

      this.logger.debug(`Resolved hosted zone: ${zoneId} (${zone.Name})`);

      return {
        Id: zoneId,
        Name: zone.Name,
      };
    } finally {
      client.destroy();
    }
  }
}
