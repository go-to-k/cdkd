/**
 * go-to-k/cdkd#6854 (lane B): the boundary of every drift / diff equivalence
 * the RDS, DocumentDB, Neptune, FSx, Auto Scaling, EC2, ELBv2, CodeBuild and
 * Lambda providers apply, one positive and one NEGATIVE case per rule (a pair
 * AWS treats differently, which must not compare equal). The rule inventory,
 * with the AWS evidence for each equivalence, is
 * `docs/design/6854-b-db-compute-normalization-rules.md`.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ lambda: { send: vi.fn() }, lambdaCore: { send: vi.fn() } }),
}));

import {
  canonicalizeDriftProperties as rdsCanonical,
  canonicalizeDriftPair as rdsPair,
  getDriftUnorderedPaths as rdsUnordered,
} from '../../../src/provisioning/providers/rds/drift.js';
import { sameReplicaSource } from '../../../src/provisioning/providers/rds/read-replica.js';
import { canonicalAssociatedRoles } from '../../../src/provisioning/providers/db-associated-roles.js';
import {
  canonicalizeDriftProperties as docdbCanonical,
  getDriftUnorderedPaths as docdbUnordered,
} from '../../../src/provisioning/providers/docdb/read-state.js';
import {
  canonicalizeDriftProperties as neptuneCanonical,
  getDriftUnorderedPaths as neptuneUnordered,
} from '../../../src/provisioning/providers/neptune/read-state.js';
import {
  canonicalizeDriftProperties as fsxCanonical,
  canonicalizeWindowsAliases,
  getDriftUnorderedPaths as fsxUnordered,
} from '../../../src/provisioning/providers/fsx-filesystem/read-state.js';
import {
  canonicalizeDriftProperties as asgCanonical,
  canonicalizeDriftPair as asgPair,
} from '../../../src/provisioning/providers/asg/read-state.js';
import { ALL_GROUP_METRICS } from '../../../src/provisioning/providers/asg/shared.js';
import { changedTriggers } from '../../../src/provisioning/providers/asg/update-policy.js';
import {
  canonicalizeDriftPair as ec2Pair,
  canonicalizeDesiredProperties as ec2Desired,
} from '../../../src/provisioning/providers/ec2/drift.js';
import {
  sgCidrKey as cidrKey,
  reconcileSgRules,
  sgRuleKey,
  withRecordedCidrSpelling,
  comparableIngressIdentity,
} from '../../../src/provisioning/providers/ec2/sg-support.js';
import { sgRuleOwnershipIdentity } from '../../../src/provisioning/sg-sibling-rules.js';
import { sgSettleRuleKey } from '../../../src/provisioning/sg-own-write-rules.js';
import {
  canonicalizeDriftPair as elbv2Pair,
  getDriftUnorderedPaths as elbv2Unordered,
} from '../../../src/provisioning/providers/elbv2/read-state.js';
import { canonicalizeDriftPair as codebuildPair } from '../../../src/provisioning/providers/codebuild/drift.js';
import { canonicalizeDriftPair as esmPair } from '../../../src/provisioning/providers/lambda-eventsource/read-state.js';
import { LambdaEventInvokeConfigProvider } from '../../../src/provisioning/providers/lambda-event-invoke-config-provider.js';
import { LambdaNetworkConnectorProvider } from '../../../src/provisioning/providers/lambda-network-connector-provider.js';

type Bag = Record<string, unknown>;
const stub = {} as never;
const rdsStub = {
  getClient: () => ({ config: { region: () => Promise.resolve('us-east-1') } }),
} as never;
const fsxStub = { canonicalizeWindowsAliases } as never;
const json = (v: unknown): string => JSON.stringify(v);

/** Both sides through one per-side canonicalizer, compared as JSON. */
function sameAfter(canon: (bag: Bag) => Bag, a: Bag, b: Bag): boolean {
  return json(canon(a)) === json(canon(b));
}

describe('RDS / Neptune AssociatedRoles (db-associated-roles.ts)', () => {
  const role = (RoleArn: string, FeatureName?: string): Bag => ({
    RoleArn,
    ...(FeatureName !== undefined && { FeatureName }),
  });
  const same = (a: unknown[], b: unknown[]): boolean =>
    json(canonicalAssociatedRoles(a)) === json(canonicalAssociatedRoles(b));

  it('equates a repeated entry and an empty FeatureName with the list AWS holds', () => {
    expect(same([role('arn:r1'), role('arn:r1')], [role('arn:r1')])).toBe(true);
    expect(same([role('arn:r1', '')], [role('arn:r1')])).toBe(true);
  });

  it('keeps another feature, another role, and a role ARN in another case apart', () => {
    expect(same([role('arn:r1', 's3Import')], [role('arn:r1')])).toBe(false);
    expect(same([role('arn:r1', 's3Import')], [role('arn:r1', 's3Export')])).toBe(false);
    expect(same([role('arn:aws:iam::1:role/A')], [role('arn:aws:iam::1:role/a')])).toBe(false);
    expect(same([role('arn:r1'), role('arn:r2')], [role('arn:r1')])).toBe(false);
  });
});

describe('RDS DBCluster scalar spellings (rds/drift.ts)', () => {
  const canon = (bag: Bag): Bag => rdsCanonical.call(stub, 'AWS::RDS::DBCluster', bag);

  it("equates 'true' / 'false' and a whole-number string with the readback's type", () => {
    expect(sameAfter(canon, { EnableHttpEndpoint: 'true' }, { EnableHttpEndpoint: true })).toBe(true);
    expect(sameAfter(canon, { BacktrackWindow: '7' }, { BacktrackWindow: 7 })).toBe(true);
  });

  it('keeps another value, a non-canonical boolean spelling and a fraction apart', () => {
    expect(sameAfter(canon, { EnableHttpEndpoint: 'false' }, { EnableHttpEndpoint: true })).toBe(false);
    expect(sameAfter(canon, { EnableHttpEndpoint: 'True' }, { EnableHttpEndpoint: true })).toBe(false);
    expect(sameAfter(canon, { BacktrackWindow: '7.5' }, { BacktrackWindow: 7 })).toBe(false);
    expect(sameAfter(canon, { BacktrackWindow: '8' }, { BacktrackWindow: 7 })).toBe(false);
  });

  it('folds nothing on a type it does not own', () => {
    const bag = { EnableHttpEndpoint: 'true' };
    expect(rdsCanonical.call(stub, 'AWS::RDS::DBProxy', bag)).toBe(bag);
  });
});

describe('RDS DBInstance AdditionalStorageVolumes / ProcessorFeatures (rds/drift.ts)', () => {
  const canon = (bag: Bag): Bag => rdsCanonical.call(stub, 'AWS::RDS::DBInstance', bag);
  const vol = (extra: Bag): Bag => ({ AdditionalStorageVolumes: [{ VolumeName: 'v1', ...extra }] });

  it('equates a numeric string and a storage type in another case', () => {
    expect(sameAfter(canon, vol({ AllocatedStorage: '100' }), vol({ AllocatedStorage: 100 }))).toBe(true);
    expect(sameAfter(canon, vol({ StorageType: 'GP3' }), vol({ StorageType: 'gp3' }))).toBe(true);
  });

  it('keeps another size, an exponent spelling and another storage type apart', () => {
    expect(sameAfter(canon, vol({ AllocatedStorage: '200' }), vol({ AllocatedStorage: 100 }))).toBe(false);
    expect(sameAfter(canon, vol({ AllocatedStorage: '1e2' }), vol({ AllocatedStorage: 100 }))).toBe(false);
    expect(sameAfter(canon, vol({ StorageType: 'io2' }), vol({ StorageType: 'gp3' }))).toBe(false);
  });

  it('narrows the live features to the declared names, but a declared value that differs stays', async () => {
    const baseline = { ProcessorFeatures: [{ Name: 'threadsPerCore', Value: '1' }] };
    const live = (threads: string): Bag => ({
      ProcessorFeatures: [
        { Name: 'coreCount', Value: '4' },
        { Name: 'threadsPerCore', Value: threads },
      ],
    });
    const same = await rdsPair.call(rdsStub, 'AWS::RDS::DBInstance', baseline, live('1'));
    expect(same.aws['ProcessorFeatures']).toEqual(baseline.ProcessorFeatures);
    const differs = await rdsPair.call(rdsStub, 'AWS::RDS::DBInstance', baseline, live('2'));
    expect(differs.aws['ProcessorFeatures']).not.toEqual(baseline.ProcessorFeatures);
  });

  it('keeps a live volume the baseline does not name whole (an added volume drifts)', async () => {
    const baseline = { AdditionalStorageVolumes: [{ VolumeName: 'v1', AllocatedStorage: 100 }] };
    const aws = {
      AdditionalStorageVolumes: [
        { VolumeName: 'v1', AllocatedStorage: 100, Iops: 3000 },
        { VolumeName: 'v2', AllocatedStorage: 50 },
      ],
    };
    const out = await rdsPair.call(rdsStub, 'AWS::RDS::DBInstance', baseline, aws);
    expect(out.aws['AdditionalStorageVolumes']).toEqual([
      { VolumeName: 'v1', AllocatedStorage: 100 },
      { VolumeName: 'v2', AllocatedStorage: 50 },
    ]);
  });
});

describe('RDS read replica source (rds/read-replica.ts sameReplicaSource)', () => {
  const own = { region: 'us-east-1' };
  const arn = (region: string, account: string, name: string): string =>
    `arn:aws:rds:${region}:${account}:db:${name}`;

  it('equates a bare identifier with its same-region ARN, in any case (RDS stores it lower-cased)', () => {
    expect(sameReplicaSource('MySource', arn('us-east-1', '111111111111', 'mysource'), own)).toBe(true);
  });

  it('keeps another name, another region and another account apart', () => {
    expect(sameReplicaSource('other', arn('us-east-1', '111111111111', 'mysource'), own)).toBe(false);
    expect(sameReplicaSource('mysource', arn('eu-west-1', '111111111111', 'mysource'), own)).toBe(false);
    expect(
      sameReplicaSource(
        arn('us-east-1', '111111111111', 'mysource'),
        arn('us-east-1', '222222222222', 'mysource'),
        own
      )
    ).toBe(false);
  });
});

describe('DocumentDB / Neptune DBCluster (docdb/read-state.ts, neptune/read-state.ts)', () => {
  const doc = (bag: Bag): Bag => docdbCanonical.call(stub, 'AWS::DocDB::DBCluster', bag);
  const nep = (bag: Bag): Bag => neptuneCanonical.call(stub, 'AWS::Neptune::DBCluster', bag);

  it('equates a repeated log type and a numeric-string capacity', () => {
    const logs = (l: string[]): Bag => ({ EnableCloudwatchLogsExports: l });
    expect(sameAfter(doc, logs(['audit', 'audit']), logs(['audit']))).toBe(true);
    expect(sameAfter(nep, logs(['audit', 'audit']), logs(['audit']))).toBe(true);
    const scaling = (min: unknown): Bag => ({
      ServerlessV2ScalingConfiguration: { MinCapacity: min, MaxCapacity: 4 },
    });
    expect(sameAfter(doc, scaling('0.5'), scaling(0.5))).toBe(true);
  });

  it('keeps another log set and another capacity apart', () => {
    const logs = (l: string[]): Bag => ({ EnableCloudwatchLogsExports: l });
    expect(sameAfter(doc, logs(['audit', 'profiler']), logs(['audit']))).toBe(false);
    expect(sameAfter(nep, logs(['audit', 'slowquery']), logs(['audit']))).toBe(false);
    const scaling = (min: unknown): Bag => ({
      ServerlessV2ScalingConfiguration: { MinCapacity: min, MaxCapacity: 4 },
    });
    expect(sameAfter(doc, scaling('1'), scaling(0.5))).toBe(false);
    expect(sameAfter(doc, scaling(''), scaling(0))).toBe(false);
  });

  it('declares only the documented sets unordered', () => {
    expect(docdbUnordered.call(stub, 'AWS::DocDB::DBCluster')).toEqual(['EnableCloudwatchLogsExports']);
    expect(neptuneUnordered.call(stub, 'AWS::Neptune::DBCluster')).toEqual([
      'AssociatedRoles',
      'EnableCloudwatchLogsExports',
      'VpcSecurityGroupIds',
    ]);
    expect(rdsUnordered.call(stub, 'AWS::RDS::DBCluster')).toEqual([
      'EnableCloudwatchLogsExports',
      'AssociatedRoles',
    ]);
  });
});

describe('FSx FileSystem (fsx-filesystem/read-state.ts)', () => {
  const canon = (bag: Bag): Bag => fsxCanonical.call(fsxStub, 'AWS::FSx::FileSystem', bag);
  const lustre = (log?: Bag): Bag => ({
    LustreConfiguration: { DeploymentType: 'PERSISTENT_2', ...(log && { LogConfiguration: log }) },
  });
  const aliases = (a: string[]): Bag => ({ WindowsConfiguration: { Aliases: a } });

  it('equates logging off with no LogConfiguration, and an alias in another case', () => {
    expect(sameAfter(canon, lustre({ Level: 'DISABLED' }), lustre())).toBe(true);
    expect(sameAfter(canon, aliases(['Files.Corp.Example.com']), aliases(['files.corp.example.com']))).toBe(
      true
    );
  });

  it('keeps logging on, a disabled block with a destination, and another alias apart', () => {
    expect(sameAfter(canon, lustre({ Level: 'WARN_ERROR' }), lustre())).toBe(false);
    expect(
      sameAfter(canon, lustre({ Level: 'DISABLED', Destination: 'arn:aws:logs:x' }), lustre())
    ).toBe(false);
    expect(sameAfter(canon, aliases(['a.corp.example.com']), aliases(['b.corp.example.com']))).toBe(false);
  });

  it('declares only the alias list unordered (DNS server order may be a preference)', () => {
    expect(fsxUnordered.call(stub, 'AWS::FSx::FileSystem')).toEqual(['WindowsConfiguration.Aliases']);
  });
});

describe('Auto Scaling group (asg/read-state.ts, asg/update-policy.ts)', () => {
  const canon = (bag: Bag): Bag => asgCanonical.call(stub, 'AWS::AutoScaling::AutoScalingGroup', bag);
  const mc = (...entries: Bag[]): Bag => ({ MetricsCollection: entries });

  it('equates one granularity split over entries with its union', () => {
    expect(
      sameAfter(
        canon,
        mc(
          { Granularity: '1Minute', Metrics: ['GroupMinSize'] },
          { Granularity: '1Minute', Metrics: ['GroupMaxSize'] }
        ),
        mc({ Granularity: '1Minute', Metrics: ['GroupMaxSize', 'GroupMinSize'] })
      )
    ).toBe(true);
  });

  it('keeps another metric set apart', () => {
    expect(
      sameAfter(
        canon,
        mc({ Granularity: '1Minute', Metrics: ['GroupMinSize'] }),
        mc({ Granularity: '1Minute', Metrics: ['GroupMaxSize'] })
      )
    ).toBe(false);
  });

  it('reads an ALL baseline against the readback as every known metric, so a missing one differs', async () => {
    const baseline = mc({ Granularity: '1Minute' });
    const full = mc({ Granularity: '1Minute', Metrics: [...ALL_GROUP_METRICS] });
    const short = mc({ Granularity: '1Minute', Metrics: ALL_GROUP_METRICS.slice(1) });
    const pairFull = await asgPair.call(stub, 'AWS::AutoScaling::AutoScalingGroup', baseline, full);
    expect(json(pairFull.baseline)).toBe(json(full));
    const pairShort = await asgPair.call(stub, 'AWS::AutoScaling::AutoScalingGroup', baseline, short);
    expect(json(pairShort.baseline)).not.toBe(json(short));
  });

  it('reads a launch template version as text and subnets as a set, but a different subnet as a change', () => {
    const lt = (Version: unknown): Bag => ({ LaunchTemplate: { LaunchTemplateId: 'lt-1', Version } });
    expect(changedTriggers(['LaunchTemplate'], lt(2), lt('2'))).toEqual([]);
    expect(changedTriggers(['LaunchTemplate'], lt(3), lt('2'))).toEqual(['LaunchTemplate']);
    const vpc = (v: unknown): Bag => ({ VPCZoneIdentifier: v });
    expect(changedTriggers(['VPCZoneIdentifier'], vpc(['subnet-a', 'subnet-b']), vpc('subnet-b,subnet-a'))).toEqual(
      []
    );
    expect(changedTriggers(['VPCZoneIdentifier'], vpc(['subnet-a', 'subnet-c']), vpc(['subnet-a', 'subnet-b']))).toEqual(
      ['VPCZoneIdentifier']
    );
  });
});

describe('EC2 (ec2/drift.ts, ec2/sg-rule-by-id.ts)', () => {
  it('equates an IPv6 subnet block spelled with host bits or expanded (EC2 stores the network, measured)', async () => {
    const out = await ec2Pair.call(
      stub,
      'AWS::EC2::Subnet',
      { Ipv6CidrBlock: '2600:1F18:7033:E001:0000:0000:0000:0005/64' },
      { Ipv6CidrBlock: '2600:1f18:7033:e001::/64' }
    );
    expect(out.baseline['Ipv6CidrBlock']).toBe('2600:1f18:7033:e001::/64');
  });

  it('keeps another IPv6 network and another prefix length apart', async () => {
    for (const recorded of ['2600:1f18:7033:e002::/64', '2600:1f18:7033:e001::/63']) {
      const out = await ec2Pair.call(
        stub,
        'AWS::EC2::Subnet',
        { Ipv6CidrBlock: recorded },
        { Ipv6CidrBlock: '2600:1f18:7033:e001::/64' }
      );
      expect(out.baseline['Ipv6CidrBlock']).toBe(recorded);
    }
  });

  it('folds a security group rule CIDR to its network, as EC2 stores it (measured)', () => {
    expect(cidrKey('10.0.0.5/24')).toBe(cidrKey('10.0.0.0/24'));
    expect(cidrKey('2001:db8::5/64')).toBe(cidrKey('2001:db8::/64'));
  });

  it('keeps another network, another prefix, and a malformed prefix apart', () => {
    expect(cidrKey('10.0.1.0/24')).not.toBe(cidrKey('10.0.0.0/24'));
    expect(cidrKey('10.0.0.0/16')).not.toBe(cidrKey('10.0.0.0/24'));
    expect(cidrKey('2001:db8:0:1::/64')).not.toBe(cidrKey('2001:db8::/64'));
    // EC2 refuses `10.0.0.0/` as malformed; it is not 0.0.0.0/0.
    expect(cidrKey('10.0.0.0/')).not.toBe(cidrKey('0.0.0.0/0'));
    expect(cidrKey('10.0.0.0/ 8')).toBe('10.0.0.0/ 8');
  });

  it('equates a subnet boolean and netmask spelling, but not another value', () => {
    const canon = (bag: Bag): Bag => ec2Desired.call(stub, 'AWS::EC2::Subnet', bag);
    expect(sameAfter(canon, { EnableDns64: 'true' }, { EnableDns64: true })).toBe(true);
    expect(sameAfter(canon, { Ipv6NetmaskLength: '64' }, { Ipv6NetmaskLength: 64 })).toBe(true);
    expect(sameAfter(canon, { EnableDns64: 'false' }, { EnableDns64: true })).toBe(false);
    expect(sameAfter(canon, { Ipv6NetmaskLength: '60' }, { Ipv6NetmaskLength: 64 })).toBe(false);
  });

  it('equates a standalone ingress protocol number with its name, but not another protocol', () => {
    const canon = (bag: Bag): Bag => ec2Desired.call(stub, 'AWS::EC2::SecurityGroupIngress', bag);
    expect(sameAfter(canon, { IpProtocol: 6 }, { IpProtocol: 'tcp' })).toBe(true);
    expect(sameAfter(canon, { IpProtocol: 'TCP' }, { IpProtocol: 'tcp' })).toBe(true);
    expect(sameAfter(canon, { IpProtocol: 17 }, { IpProtocol: 'tcp' })).toBe(false);
    expect(sameAfter(canon, { IpProtocol: '-1' }, { IpProtocol: 'all' })).toBe(false);
  });
});

describe('Security group rule identity by CIDR (ec2/sg-support.ts sgCidrKey / sgRuleKey)', () => {
  const rule = (CidrIp: string, extra: Bag = {}): Bag => ({
    IpProtocol: 'tcp',
    FromPort: 443,
    ToPort: 443,
    CidrIp,
    ...extra,
  });

  it('keys the spellings EC2 stores as one rule alike (measured: host bits, IPv6 case and compression)', () => {
    expect(sgRuleKey(rule('10.0.0.5/24'), 'ingress')).toBe(sgRuleKey(rule('10.0.0.0/24'), 'ingress'));
    expect(
      sgRuleKey({ IpProtocol: 'tcp', CidrIpv6: '2001:DB8:0:2:0:0:0:5/64' }, 'ingress')
    ).toBe(sgRuleKey({ IpProtocol: 'tcp', CidrIpv6: '2001:db8:0:2::/64' }, 'ingress'));
  });

  it('never keys two different rules alike', () => {
    // Distinct networks (host bits already clear) never share a key.
    const networks: string[] = [];
    for (let prefix = 0; prefix <= 32; prefix++) {
      for (const base of [0x0a000000, 0x0a000080, 0x0a000100, 0xc0a80000, 0xffffffff]) {
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        const n = (base & mask) >>> 0;
        networks.push(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${prefix}`);
      }
    }
    const distinct = [...new Set(networks)];
    expect(new Set(distinct.map((c) => String(cidrKey(c)))).size).toBe(distinct.length);
    // Concrete pairs AWS keeps apart.
    expect(sgRuleKey(rule('10.0.0.0/24'), 'ingress')).not.toBe(sgRuleKey(rule('10.0.0.0/25'), 'ingress'));
    expect(sgRuleKey(rule('10.0.0.0/24'), 'ingress')).not.toBe(sgRuleKey(rule('10.0.1.0/24'), 'ingress'));
    expect(sgRuleKey(rule('0.0.0.0/0'), 'ingress')).not.toBe(sgRuleKey(rule('10.0.0.0/'), 'ingress'));
    expect(sgRuleKey(rule('10.0.0.10/32'), 'ingress')).not.toBe(sgRuleKey(rule('10.0.0.010/32'), 'ingress'));
    expect(sgRuleKey(rule('10.0.0.0/24'), 'ingress')).not.toBe(sgRuleKey(rule(' 10.0.0.0/24'), 'ingress'));
  });

  it('pairs a group inline rule and a sibling standalone rule spelled two ways (holder and sibling strip)', () => {
    const host = rule('10.0.0.5/24');
    const net = rule('10.0.0.0/24');
    expect(comparableIngressIdentity('sg-1', host)).toBe(comparableIngressIdentity('sg-1', net));
    expect(sgRuleOwnershipIdentity(host, 'ingress')).toBe(sgRuleOwnershipIdentity(net, 'ingress'));
    expect(sgRuleOwnershipIdentity(rule('10.0.0.0/24'), 'egress')).toBe(
      sgRuleOwnershipIdentity(rule('10.0.0.9/24'), 'egress')
    );
    expect(sgSettleRuleKey(host, 'ingress')).toBe(sgSettleRuleKey(net, 'ingress'));
    expect(sgSettleRuleKey(rule('10.0.1.0/24'), 'ingress')).not.toBe(sgSettleRuleKey(net, 'ingress'));
    // Another network, prefix, or a group name that only looks like a CIDR stay apart.
    expect(comparableIngressIdentity('sg-1', rule('10.0.1.0/24'))).not.toBe(comparableIngressIdentity('sg-1', net));
    expect(sgRuleOwnershipIdentity(rule('10.0.0.0/25'), 'ingress')).not.toBe(sgRuleOwnershipIdentity(net, 'ingress'));
    const named = (SourceSecurityGroupName: string): Bag => ({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupName });
    expect(sgRuleOwnershipIdentity(named('2001:db8::5/64'), 'ingress')).not.toBe(
      sgRuleOwnershipIdentity(named('2001:db8::/64'), 'ingress')
    );
  });

  it('pairs a host-bit record with its live rule and reads it back in the record spelling', () => {
    const live = [rule('10.0.1.0/24'), rule('10.0.0.0/24')];
    const out = reconcileSgRules(live as never, [rule('10.0.0.5/24')], 'ingress');
    expect(out).toEqual([rule('10.0.0.5/24'), rule('10.0.1.0/24')]);
    // Only the CIDR is echoed; every other member stays AWS's.
    expect(withRecordedCidrSpelling(rule('10.0.0.0/24', { Description: 'aws' }) as never, rule('10.0.0.5/24'))).toEqual(
      rule('10.0.0.5/24', { Description: 'aws' })
    );
  });
});

describe('ELBv2 attribute bags (elbv2/read-state.ts)', () => {
  const TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
  const bag = (...keys: string[]): Bag => ({
    LoadBalancerAttributes: keys.map((Key) => ({ Key, Value: 'v' })),
  });

  it('drops an undeclared key the readback no longer reports', async () => {
    const out = await elbv2Pair.call(stub, TYPE, bag('a', 'gone'), bag('a'), bag());
    expect(out.baseline).toEqual(bag('a'));
  });

  it('keeps a DECLARED key that vanished, and every key on an empty readback', async () => {
    const declared = await elbv2Pair.call(stub, TYPE, bag('a', 'gone'), bag('a'), bag('gone'));
    expect(declared.baseline).toEqual(bag('a', 'gone'));
    const empty = await elbv2Pair.call(stub, TYPE, bag('a'), bag(), bag());
    expect(empty.baseline).toEqual(bag('a'));
  });

  it('declares only Targets unordered', () => {
    expect(elbv2Unordered.call(stub, 'AWS::ElasticLoadBalancingV2::TargetGroup')).toEqual(['Targets']);
    expect(elbv2Unordered.call(stub, 'AWS::ElasticLoadBalancingV2::Listener')).toEqual([]);
  });
});

describe('CodeBuild S3Logs.EncryptionDisabled (codebuild/drift.ts)', () => {
  const TYPE = 'AWS::CodeBuild::Project';
  const logs = (value?: boolean): Bag => ({
    LogsConfig: { S3Logs: { Status: 'ENABLED', ...(value !== undefined && { EncryptionDisabled: value }) } },
  });

  it('equates an absent value with the documented default false', () => {
    const out = codebuildPair(TYPE, logs(), logs(false));
    expect(json(out.baseline)).toBe(json(out.aws));
  });

  it('keeps true against absent apart', () => {
    const out = codebuildPair(TYPE, logs(), logs(true));
    expect(json(out.baseline)).not.toBe(json(out.aws));
  });
});

describe('Lambda event source mapping ConsumptionMode (lambda-eventsource/read-state.ts)', () => {
  const TYPE = 'AWS::Lambda::EventSourceMapping';
  const kafka = (mode?: string): Bag => ({
    SelfManagedKafkaEventSourceConfig: { ConsumerGroupId: 'g', ...(mode && { ConsumptionMode: mode }) },
  });

  it('completes a baseline lacking the mode with the default Stream when the live block holds Stream', async () => {
    const out = await esmPair.call(stub, TYPE, kafka(), kafka('Stream'), kafka());
    expect(json(out.baseline)).toBe(json(out.aws));
  });

  it('keeps a live Queue apart', async () => {
    const out = await esmPair.call(stub, TYPE, kafka(), kafka('Queue'), kafka());
    expect(json(out.baseline)).not.toBe(json(out.aws));
  });
});

describe('Lambda EventInvokeConfig (lambda-event-invoke-config-provider.ts)', () => {
  const p = new LambdaEventInvokeConfigProvider();
  const canon = (bag: Bag): Bag => p.canonicalizeDriftProperties('AWS::Lambda::EventInvokeConfig', bag);

  it('equates a function name with its unqualified ARN, and an empty destination member with none', () => {
    expect(
      sameAfter(canon, { FunctionName: 'arn:aws:lambda:us-east-1:123456789012:function:fn' }, { FunctionName: 'fn' })
    ).toBe(true);
    expect(
      sameAfter(canon, { FunctionName: 'fn', DestinationConfig: { OnSuccess: {} } }, { FunctionName: 'fn' })
    ).toBe(true);
  });

  it('keeps a qualified ARN, another function and a set destination apart', () => {
    expect(
      sameAfter(canon, { FunctionName: 'arn:aws:lambda:us-east-1:123456789012:function:fn:live' }, { FunctionName: 'fn' })
    ).toBe(false);
    expect(sameAfter(canon, { FunctionName: 'other' }, { FunctionName: 'fn' })).toBe(false);
    expect(
      sameAfter(
        canon,
        { FunctionName: 'fn', DestinationConfig: { OnSuccess: { Destination: 'arn:aws:sqs:x' } } },
        { FunctionName: 'fn' }
      )
    ).toBe(false);
  });
});

describe('Lambda network connector ElasticIpConfiguration (lambda-network-connector-provider.ts)', () => {
  const p = new LambdaNetworkConnectorProvider();
  const bag = (type?: string): Bag => ({
    Configuration: {
      VpcEgressConfiguration: { SubnetIds: ['subnet-1'], ...(type && { ElasticIpConfiguration: { Type: type } }) },
    },
  });

  it('equates a None type with no member', async () => {
    const out = await p.canonicalizeDriftPair('AWS::Lambda::NetworkConnector', bag('None'), bag());
    expect(json(out.baseline)).toBe(json(out.aws));
  });

  it('keeps None against ServiceManaged apart', async () => {
    const out = await p.canonicalizeDriftPair('AWS::Lambda::NetworkConnector', bag('None'), bag('ServiceManaged'));
    expect(json(out.baseline)).not.toBe(json(out.aws));
  });
});
