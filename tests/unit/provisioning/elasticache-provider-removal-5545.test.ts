// issue #5545 (#1160): CacheCluster properties CloudFormation KEEPS on removal.
// Real CloudFormation A/B (us-east-1, redis 7.0 and memcached 1.6.17 clusters,
// alone and beside another change): removing EngineVersion,
// CacheParameterGroupName, PreferredMaintenanceWindow, SnapshotWindow or
// IpDiscovery sent a ModifyCacheCluster without the member, and each live
// value stayed. cdkd sends nothing for them either and names them in one
// warning. AZMode / PreferredAvailabilityZones removals REPLACE the cluster
// under CloudFormation (go-to-k/cdkd#5558); cdkd leaves it unchanged and names
// them in a second line. The type declares removalHandledInUpdate, so the
// shared caller's "CloudFormation would reset it" line names no CacheCluster
// property.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('@aws-sdk/client-elasticache', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elasticache');
  return {
    ...actual,
    ElastiCacheClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

const TYPE = 'AWS::ElastiCache::CacheCluster';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };
const modifyInput = (): Record<string, unknown> => {
  const modify = mockSend.mock.calls
    .map((c) => c[0] as Sent)
    .filter((c) => c.constructor.name === 'ModifyCacheClusterCommand');
  expect(modify).toHaveLength(1);
  return modify[0].input;
};
const warnings = (): string[] => warn.mock.calls.map((c) => String(c[0]));

const MEASURED = {
  EngineVersion: '7.0',
  CacheParameterGroupName: 'my-params',
  PreferredMaintenanceWindow: 'wed:10:00-wed:11:00',
  SnapshotWindow: '20:00-21:00',
  IpDiscovery: 'ipv6',
};
const MEASURED_MEMBERS = [
  'EngineVersion',
  'CacheParameterGroupName',
  'PreferredMaintenanceWindow',
  'SnapshotWindow',
  'IpDiscovery',
];

describe('ElastiCacheProvider CacheCluster removals CloudFormation keeps (issue #5545)', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new ElastiCacheProvider();
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockResolvedValue(undefined);
    mockSend.mockImplementation((cmd: Sent) =>
      Promise.resolve(
        cmd.constructor.name === 'DescribeCacheClustersCommand'
          ? { CacheClusters: [{ CacheClusterStatus: 'available', CacheNodeType: 'cache.t4g.micro' }] }
          : {}
      )
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base = { Engine: 'redis', CacheNodeType: 'cache.t4g.micro', NumCacheNodes: 1 };
  const update = (
    next: Record<string, unknown>,
    prev: Record<string, unknown>,
    context?: Parameters<ElastiCacheProvider['update']>[5]
  ) =>
    provider.update(
      'Cache',
      'my-cluster',
      TYPE,
      { ...base, ...next },
      { ...base, ...prev },
      context
    );

  it('sends none of the removed members and names each in one warning', async () => {
    await update({}, MEASURED);

    const input = modifyInput();
    for (const member of MEASURED_MEMBERS) expect(input[member]).toBeUndefined();
    const lines = warnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      'properties EngineVersion, CacheParameterGroupName, PreferredMaintenanceWindow, SnapshotWindow, IpDiscovery were removed from the template'
    );
    expect(lines[0]).toContain('as CloudFormation leaves them');
    expect(lines[0]).toContain('To change a value, declare it explicitly.');
    expect(lines[0]).not.toContain('would reset');
  });

  it('warns about nothing when no property was ever set', async () => {
    await update({}, {});

    const input = modifyInput();
    for (const member of MEASURED_MEMBERS) expect(input[member]).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('passes kept and changed values through, with no warning', async () => {
    await update(
      { ...MEASURED, EngineVersion: '7.1', PreferredMaintenanceWindow: 'thu:10:00-thu:11:00' },
      MEASURED
    );

    const input = modifyInput();
    expect(input['EngineVersion']).toBe('7.1');
    expect(input['CacheParameterGroupName']).toBe('my-params');
    expect(input['PreferredMaintenanceWindow']).toBe('thu:10:00-thu:11:00');
    expect(input['SnapshotWindow']).toBe('20:00-21:00');
    expect(input['IpDiscovery']).toBe('ipv6');
    expect(warnings()).toEqual([]);
  });

  it('names a removed TransitEncryptionEnabled / PreferredAvailabilityZone (kept in place)', async () => {
    await update({}, { TransitEncryptionEnabled: true, PreferredAvailabilityZone: 'us-east-1a' });

    const input = modifyInput();
    expect(input['PreferredAvailabilityZone']).toBeUndefined();
    expect(input['TransitEncryptionEnabled']).toBeUndefined();
    expect(warnings()).toEqual([
      expect.stringContaining(
        'properties TransitEncryptionEnabled, PreferredAvailabilityZone were removed from the template'
      ),
    ]);
    // ModifyCacheCluster has no member for either: declaring a value cannot
    // change them, so the remedy says so.
    expect(warnings()[0]).toContain(
      'To change a value, declare it explicitly (TransitEncryptionEnabled, PreferredAvailabilityZone change only by replacing the cluster).'
    );
  });

  it('names an AZMode / PreferredAvailabilityZones removal as a CloudFormation replacement', async () => {
    await update({}, { AZMode: 'single-az', PreferredAvailabilityZones: ['us-east-1a'] });

    const input = modifyInput();
    expect(input['AZMode']).toBeUndefined();
    expect(input['NewAvailabilityZones']).toBeUndefined();
    expect(warnings()).toEqual([
      expect.stringContaining(
        'properties AZMode, PreferredAvailabilityZones were removed from the template; cdkd leaves the cluster unchanged.'
      ),
    ]);
    expect(warnings()[0]).toContain('CloudFormation replaces the cluster for an AZMode removal');
    expect(warnings()[0]).toContain(
      'for a PreferredAvailabilityZones removal CloudFormation replaced a 1-node cluster (go-to-k/cdkd#5558) and updated a 2-node cluster in place (go-to-k/cdkd#5458)'
    );
    expect(warnings()[0]).not.toContain('would reset');
  });

  it('names the #5004 / #5491 kept properties in the same line', async () => {
    await update(
      {},
      { SnapshotRetentionLimit: 3, VpcSecurityGroupIds: ['sg-a'], AutoMinorVersionUpgrade: false }
    );

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(
      'properties SnapshotRetentionLimit, AutoMinorVersionUpgrade, VpcSecurityGroupIds were removed'
    );
  });

  it('reads the caller-computed removed set when it is given', async () => {
    // The caller's set is template-to-template: a key it does not list is
    // not named, even though the two bags differ.
    await update({}, MEASURED, { removedProperties: new Set(['SnapshotWindow']) });

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('property SnapshotWindow was removed from the template');
  });

  it('says only what a rollback does', async () => {
    await update({}, { EngineVersion: '7.1', AZMode: 'single-az' }, { replayingState: true });

    expect(warnings()).toEqual([
      expect.stringContaining(
        'property EngineVersion is absent from the state being restored; the rollback sends nothing for it, so the cluster keeps the value it holds now.'
      ),
      expect.stringContaining(
        'property AZMode is absent from the state being restored; the rollback leaves the cluster unchanged.'
      ),
    ]);
  });

  it('warns about nothing on drift --revert (the previous side is a readback)', async () => {
    await update({}, MEASURED, { desiredFromAwsReadback: true });

    expect(warnings()).toEqual([]);
  });

  it('declares every handled property removal-handled, so the caller warns about none', () => {
    const handled = provider.handledProperties.get(TYPE);
    expect(handled).toBeDefined();
    const baseline = Object.fromEntries([...(handled ?? [])].map((key) => [key, 'x']));
    const prepared = prepareRemovalForUpdate(provider, TYPE, {}, baseline);
    expect(prepared.unhandled).toEqual([]);
    expect(prepared.injected).toEqual([]);
    for (const key of provider.unhandledByDesign.get(TYPE)?.keys() ?? []) {
      expect(provider.removalHandledInUpdate.get(TYPE)?.has(key)).toBe(true);
    }
  });

  it('declares nothing for SubnetGroup, whose update() was not audited', () => {
    expect(provider.removalHandledInUpdate.has('AWS::ElastiCache::SubnetGroup')).toBe(false);
  });
});
