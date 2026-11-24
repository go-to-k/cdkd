import type { VpcEndpoint } from '@aws-sdk/client-ec2';

/**
 * `AWS::EC2::VPCEndpoint`'s `DnsEntries` as CloudFormation (and Cloud
 * Control) reports it (go-to-k/cdkd#6939): one `<HostedZoneId>:<DnsName>`
 * string per entry, in the order EC2 lists them (measured, us-east-1: the
 * regional name, the zonal ones, then the private DNS names, each private name
 * with its own hosted zone). Shared by the provider's record and the
 * `Fn::GetAtt` live read. A LEAF: a type-only SDK import.
 */
export function dnsEntryStrings(endpoint: Pick<VpcEndpoint, 'DnsEntries'>): string[] {
  return (endpoint.DnsEntries ?? [])
    .filter((entry) => typeof entry.DnsName === 'string' && entry.DnsName !== '')
    .map((entry) => `${entry.HostedZoneId ?? ''}:${entry.DnsName}`);
}
