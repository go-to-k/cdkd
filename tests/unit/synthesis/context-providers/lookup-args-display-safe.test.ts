import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#3479: the lookup ARGUMENTS a context provider renders —
 * `parameterName`, `aliasName`, `domainName`, a VPC filter, an ARN — come from
 * the manifest's `missing[].props`, i.e. from whoever wrote the assembly. The
 * registry already sanitizes the provider's failure text where it prints it;
 * these cases pin the renders INSIDE the modules: every `debug` line, and the
 * thrown message itself for a caller other than the registry.
 *
 * Each interpolated argument carries its OWN marker, so one sanitized value
 * cannot pass for another. Built from code points so no control character
 * sits in this file's source.
 */

const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const RLO = String.fromCharCode(0x202e);
const LF = '\n';

/** A newline or any character of the forging class. */
function forging(text: string): string[] {
  return [...text].filter((ch) => {
    const c = ch.codePointAt(0)!;
    return (
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    );
  });
}

const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: debugSpy, info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const send = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => vi.fn().mockImplementation(() => ({ send, destroy: vi.fn() })));
const command = vi.hoisted(() => vi.fn().mockImplementation((input: unknown) => ({ input })));
vi.mock('@aws-sdk/client-ssm', () => ({ SSMClient: client, GetParameterCommand: command }));
vi.mock('@aws-sdk/client-kms', () => ({ KMSClient: client, ListAliasesCommand: command }));
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: client,
  DescribeSecurityGroupsCommand: command,
  DescribeVpcsCommand: command,
  DescribeSubnetsCommand: command,
  DescribeRouteTablesCommand: command,
  DescribeVpnGatewaysCommand: command,
  DescribeAvailabilityZonesCommand: command,
  DescribeImagesCommand: command,
}));
vi.mock('@aws-sdk/client-cloudcontrol', () => ({
  CloudControlClient: client,
  GetResourceCommand: command,
  ListResourcesCommand: command,
}));
vi.mock('@aws-sdk/client-route-53', () => ({
  Route53Client: client,
  ListHostedZonesByNameCommand: command,
  GetHostedZoneCommand: command,
}));
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: client,
  DescribeLoadBalancersCommand: command,
  DescribeListenersCommand: command,
}));

import { SSMContextProvider } from '../../../../src/synthesis/context-providers/ssm-provider.js';
import { KeyContextProvider } from '../../../../src/synthesis/context-providers/key-provider.js';
import { SecurityGroupContextProvider } from '../../../../src/synthesis/context-providers/security-group-provider.js';
import { HostedZoneContextProvider } from '../../../../src/synthesis/context-providers/hosted-zone-provider.js';
import { VpcContextProvider } from '../../../../src/synthesis/context-providers/vpc-provider.js';
import {
  LoadBalancerContextProvider,
  LoadBalancerListenerContextProvider,
} from '../../../../src/synthesis/context-providers/load-balancer-provider.js';
import { AZContextProvider } from '../../../../src/synthesis/context-providers/az-provider.js';
import { AmiContextProvider } from '../../../../src/synthesis/context-providers/ami-provider.js';
import { CcApiContextProvider } from '../../../../src/synthesis/context-providers/cc-api-provider.js';

async function thrownMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the lookup to throw');
}

function debugLines(): string[] {
  return debugSpy.mock.calls.map((c) => String(c[0]));
}

/** Every debug line and the thrown message are free of the forging class, and name each marker. */
function expectSanitized(message: string, markers: string[]): void {
  for (const line of [...debugLines(), message]) {
    expect(forging(line), line).toEqual([]);
  }
  const all = [...debugLines(), message].join(' | ');
  for (const marker of markers) expect(all, marker).toContain(marker);
}

beforeEach(() => {
  debugSpy.mockReset();
  send.mockReset();
});

describe('context-provider lookup arguments render display-safe (go-to-k/cdkd#3479)', () => {
  it('ssm: parameterName and region', async () => {
    send.mockResolvedValue({});
    const message = await thrownMessage(() =>
      new SSMContextProvider().resolve({
        parameterName: `/p${LF}PARAMFORGED`,
        region: `us-east-1${NEL}REGIONFORGED`,
      })
    );
    expect(message).toBe('SSM parameter not found: /p PARAMFORGED');
    expectSanitized(message, ['PARAMFORGED', 'REGIONFORGED']);
  });

  it('ssm: a legitimate name renders byte-identically', async () => {
    send.mockResolvedValue({});
    const message = await thrownMessage(() =>
      new SSMContextProvider().resolve({ parameterName: '/my/param', region: 'us-east-1' })
    );
    expect(message).toBe('SSM parameter not found: /my/param');
    expect(debugLines()).toContain('Reading SSM parameter: /my/param (region: us-east-1)');
  });

  it('key: aliasName on the not-found and the no-target-key throws', async () => {
    send.mockResolvedValue({ Aliases: [] });
    const notFound = await thrownMessage(() =>
      new KeyContextProvider().resolve({ aliasName: `alias/k${LS}ALIASFORGED` })
    );
    expect(notFound).toBe('No KMS key found with alias: alias/k ALIASFORGED');
    expectSanitized(notFound, ['ALIASFORGED']);

    send.mockResolvedValue({ Aliases: [{ AliasName: `alias/k${LF}X` }] });
    const noTarget = await thrownMessage(() =>
      new KeyContextProvider().resolve({ aliasName: `alias/k${LF}X` })
    );
    expect(noTarget).toBe('KMS alias alias/k X found but has no target key');
  });

  it('security-group: id, name and region', async () => {
    send.mockResolvedValue({ SecurityGroups: [] });
    const message = await thrownMessage(() =>
      new SecurityGroupContextProvider().resolve({
        securityGroupId: `sg-1${LF}IDFORGED`,
        securityGroupName: `n${RLO}NAMEFORGED`,
        region: `r${NEL}REGIONFORGED`,
      })
    );
    expect(message).toBe('No security group found (id: sg-1 IDFORGED, name: n NAMEFORGED)');
    expectSanitized(message, ['IDFORGED', 'NAMEFORGED', 'REGIONFORGED']);
  });

  it('hosted-zone: domainName, privateZone and vpcId', async () => {
    send.mockResolvedValue({ HostedZones: [] });
    const message = await thrownMessage(() =>
      new HostedZoneContextProvider().resolve({
        domainName: `example.com${LF}DOMAINFORGED`,
        privateZone: `true${NEL}PRIVATEFORGED`,
        vpcId: `vpc-1${LS}VPCFORGED`,
      })
    );
    expect(message).toBe(
      'No hosted zone found for domain: example.com DOMAINFORGED (private: true PRIVATEFORGED) (vpcId: vpc-1 VPCFORGED)'
    );
    expectSanitized(message, ['DOMAINFORGED', 'PRIVATEFORGED', 'VPCFORGED']);
  });

  it('hosted-zone: the multiple-match throw', async () => {
    send.mockResolvedValue({
      HostedZones: [
        { Id: '/hostedzone/Z1', Name: 'example.com.' },
        { Id: '/hostedzone/Z2', Name: 'example.com.' },
      ],
    });
    const message = await thrownMessage(() =>
      new HostedZoneContextProvider().resolve({ domainName: `example.com` })
    );
    expect(message).toBe(
      'Multiple hosted zones found for domain: example.com. Found: /hostedzone/Z1, /hostedzone/Z2'
    );
  });

  it('vpc: the filter, which JSON.stringify does not make terminal-safe', async () => {
    send.mockResolvedValue({ Vpcs: [] });
    const message = await thrownMessage(() =>
      new VpcContextProvider().resolve({
        filter: { 'tag:Name': `main${LS}FILTERFORGED${NEL}` },
        region: `r${LF}REGIONFORGED`,
      })
    );
    expect(message).toBe('No VPC found matching filter: {"tag:Name":"main FILTERFORGED "}');
    expectSanitized(message, ['FILTERFORGED', 'REGIONFORGED']);
  });

  it('load-balancer: arn and region', async () => {
    send.mockResolvedValue({ LoadBalancers: [] });
    const message = await thrownMessage(() =>
      new LoadBalancerContextProvider().resolve({
        loadBalancerArn: `arn:lb${LF}ARNFORGED`,
        region: `r${NEL}REGIONFORGED`,
      })
    );
    expect(message).toBe('No load balancer found (arn: arn:lb ARNFORGED)');
    expectSanitized(message, ['ARNFORGED', 'REGIONFORGED']);
  });

  it('load-balancer-listener: listener arn, lb arn, port and region', async () => {
    send.mockResolvedValue({ Listeners: [] });
    const message = await thrownMessage(() =>
      new LoadBalancerListenerContextProvider().resolve({
        listenerArn: `arn:l${LF}LISTENERFORGED`,
        loadBalancerArn: `arn:lb${RLO}LBFORGED`,
        listenerPort: `443${NEL}PORTFORGED`,
        region: `r${LS}REGIONFORGED`,
      })
    );
    expect(message).toBe(
      'No listener found (arn: arn:l LISTENERFORGED, lb: arn:lb LBFORGED, port: 443 PORTFORGED)'
    );
    expectSanitized(message, ['LISTENERFORGED', 'LBFORGED', 'PORTFORGED', 'REGIONFORGED']);
  });
  it('az and ami: the region on their debug lines', async () => {
    send.mockResolvedValue({ AvailabilityZones: [{ ZoneName: 'a', State: 'available' }] });
    await new AZContextProvider().resolve({ region: `r${LF}AZFORGED` });
    send.mockResolvedValue({ Images: [{ ImageId: 'ami-1', CreationDate: '2026' }] });
    await new AmiContextProvider().resolve({ region: `r${NEL}AMIFORGED` });
    expectSanitized('', ['AZFORGED', 'AMIFORGED']);
    expect(debugLines()).toContain('Fetching availability zones for region: r AZFORGED');
  });

  it('cc-api: typeName, identifier and region on the lookup line and every match-count throw', async () => {
    const typeName = `AWS::IAM::Role${LF}TYPEFORGED`;
    const exactIdentifier = `role${LS}IDFORGED`;
    send.mockResolvedValue({});
    const exactly = await thrownMessage(() =>
      new CcApiContextProvider().resolve({ typeName, exactIdentifier, region: `r${NEL}REGIONFORGED` })
    );
    expect(exactly).toBe(
      'Expected exactly one AWS::IAM::Role TYPEFORGED with identifier role IDFORGED, found 0'
    );
    expectSanitized(exactly, ['TYPEFORGED', 'IDFORGED', 'REGIONFORGED']);

    const atLeast = await thrownMessage(() =>
      new CcApiContextProvider().resolve({ typeName, exactIdentifier, expectedMatchCount: 'at-least-one' })
    );
    expect(atLeast).toBe('Expected at least one AWS::IAM::Role TYPEFORGED with identifier role IDFORGED, found none');

    const none = await thrownMessage(() =>
      new CcApiContextProvider().resolve({ typeName, exactIdentifier, expectedMatchCount: 'any' })
    );
    expect(none).toBe('No AWS::IAM::Role TYPEFORGED resource found with identifier role IDFORGED');

    send.mockResolvedValue({
      ResourceDescriptions: [{ Properties: '{}' }, { Properties: '{}' }],
    });
    const atMost = await thrownMessage(() =>
      new CcApiContextProvider().resolve({ typeName, expectedMatchCount: 'at-most-one' })
    );
    expect(atMost).toBe('Expected at most one AWS::IAM::Role TYPEFORGED, found 2');
  });
  it('success-path debug lines: ssm, key (with its region) and hosted-zone', async () => {
    send.mockResolvedValue({ Parameter: { Value: 'v' } });
    await new SSMContextProvider().resolve({ parameterName: `/p${LF}OKPARAMFORGED` });
    send.mockResolvedValue({ Aliases: [{ AliasName: `alias/k${NEL}OKALIASFORGED`, TargetKeyId: 'kid' }] });
    await new KeyContextProvider().resolve({
      aliasName: `alias/k${NEL}OKALIASFORGED`,
      region: `r${LS}KEYREGIONFORGED`,
    });
    send.mockResolvedValue({ HostedZones: [{ Id: '/hostedzone/Z1', Name: `example.com${LF}ZONEFORGED.` }] });
    await new HostedZoneContextProvider().resolve({ domainName: `example.com${LF}ZONEFORGED` });
    expectSanitized('', ['OKPARAMFORGED', 'OKALIASFORGED', 'KEYREGIONFORGED', 'ZONEFORGED']);
    expect(debugLines()).toContain('SSM parameter resolved: /p OKPARAMFORGED');
    expect(debugLines()).toContain('Resolved KMS key: kid (alias: alias/k OKALIASFORGED)');
    expect(debugLines()).toContain('Resolved hosted zone: Z1 (example.com ZONEFORGED.)');
  });

  it('the multiple-match throws with a hostile lookup argument: hosted-zone and vpc', async () => {
    send.mockResolvedValue({
      HostedZones: [
        { Id: '/hostedzone/Z1', Name: `example.com${LF}MULTIFORGED.` },
        { Id: '/hostedzone/Z2', Name: `example.com${LF}MULTIFORGED.` },
      ],
    });
    const zones = await thrownMessage(() =>
      new HostedZoneContextProvider().resolve({ domainName: `example.com${LF}MULTIFORGED` })
    );
    expect(zones).toBe(
      'Multiple hosted zones found for domain: example.com MULTIFORGED. Found: /hostedzone/Z1, /hostedzone/Z2'
    );

    send.mockResolvedValue({ Vpcs: [{ VpcId: 'vpc-1' }, { VpcId: 'vpc-2' }] });
    const vpcs = await thrownMessage(() =>
      new VpcContextProvider().resolve({ filter: { 'tag:Name': `x${NEL}VPCMULTIFORGED` } })
    );
    expect(vpcs).toBe(
      'Multiple VPCs found matching filter: {"tag:Name":"x VPCMULTIFORGED"}. Found: vpc-1, vpc-2'
    );
    expectSanitized(zones + vpcs, ['MULTIFORGED', 'VPCMULTIFORGED']);
  });
});
