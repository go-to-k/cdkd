// go-to-k/cdkd#5639: a Multi-AZ DB cluster's `DBClusterInstanceClass`,
// `AllocatedStorage` and `Iops`. Create sends what the template declares;
// update sends a changed instance class, and the size and IOPS together when
// any storage member changed; a removal sends nothing (RDS keeps the live
// value), as CloudFormation's handler does. The update then waits for the
// change to apply, and the readback reports what the cluster holds.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();
const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
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

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import {
  multiAzMembersApplied,
  multiAzAppliedProbe,
  MULTI_AZ_IOPS_CONFIRM_READS,
} from '../../../src/provisioning/providers/rds/cluster-members.js';
import { getPropertyCoverage } from '../../../src/provisioning/property-coverage.js';

type Input = Record<string, unknown>;

/**
 * DescribeDBClusters answers `live`. A ModifyDBCluster leaves its class and
 * storage pending for `lag` describes (the cluster `modifying`, the size and
 * IOPS under `PendingModifiedValues`), then applies them.
 */
function armLive(live: Input, lag = 0): void {
  let pending: Input | undefined;
  let describesLeft = 0;
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Input }) => {
    const name = command.constructor.name;
    if (name === 'ModifyDBClusterCommand') {
      const { DBClusterInstanceClass, AllocatedStorage, Iops } = command.input;
      pending = Object.fromEntries(
        Object.entries({ DBClusterInstanceClass, AllocatedStorage, Iops }).filter(
          ([, v]) => v !== undefined
        )
      );
      describesLeft = lag;
      if (lag === 0) {
        Object.assign(live, pending);
        pending = undefined;
      }
      return Promise.resolve({});
    }
    if (name === 'DescribeDBClustersCommand') {
      let view: Input = { Status: 'available', ...live };
      if (pending !== undefined) {
        if (describesLeft > 0) {
          describesLeft -= 1;
          const { DBClusterInstanceClass: _c, ...storage } = pending;
          view = { ...view, Status: 'modifying', PendingModifiedValues: storage };
        } else {
          Object.assign(live, pending);
          pending = undefined;
          view = { Status: 'available', ...live };
        }
      }
      return Promise.resolve({
        DBClusters: [
          {
            DBClusterIdentifier: 'cluster-1',
            DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:cluster-1',
            DBClusterMembers: [],
            ...view,
          },
        ],
      });
    }
    if (name === 'CreateDBClusterCommand') {
      return Promise.resolve({ DBCluster: { DBClusterIdentifier: 'cluster-1' } });
    }
    return Promise.resolve({});
  });
}

function sent(name: string): Input[] {
  return mockSend.mock.calls
    .map(([command]) => command as { constructor: { name: string }; input: Input })
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}

const describes = (): number => sent('DescribeDBClustersCommand').length;

const BASE: Input = {
  DBClusterIdentifier: 'cluster-1',
  Engine: 'postgres',
  MasterUsername: 'postgres',
};

const MULTI_AZ: Input = {
  DBClusterInstanceClass: 'db.m6gd.large',
  StorageType: 'io1',
  AllocatedStorage: 100,
  Iops: 1000,
};

const MEMBERS = ['DBClusterInstanceClass', 'AllocatedStorage', 'Iops'] as const;

describe('RDSProvider Multi-AZ DB cluster members (go-to-k/cdkd#5639)', () => {
  let provider: RDSProvider;
  let sleeps: number;

  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = new RDSProvider();
    sleeps = 0;
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
      sleeps += 1;
      if (sleeps > 20) throw new Error('test sleep budget exceeded: a wait never settled');
    };
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const update = (next: Input, prev: Input, context?: Parameters<RDSProvider['update']>[5]) =>
    provider.update(
      'Cluster',
      'cluster-1',
      'AWS::RDS::DBCluster',
      { ...BASE, ...next },
      { ...BASE, ...prev },
      context
    );
  const modify = (): Input => {
    const calls = sent('ModifyDBClusterCommand');
    expect(calls).toHaveLength(1);
    return calls[0]!;
  };

  it('every member is handled, so a template declaring one keeps the SDK route', () => {
    const handled = provider.handledProperties.get('AWS::RDS::DBCluster');
    const coverage = getPropertyCoverage('AWS::RDS::DBCluster');
    for (const key of MEMBERS) {
      expect(handled?.has(key), key).toBe(true);
      expect(coverage?.sdkUnwired.has(key), key).toBe(false);
    }
  });

  describe('create', () => {
    it('sends every declared member under its CFn name', async () => {
      armLive({ ...MULTI_AZ });
      await provider.create('Cluster', 'AWS::RDS::DBCluster', { ...BASE, ...MULTI_AZ });
      const [input] = sent('CreateDBClusterCommand');
      expect(input).toMatchObject({
        DBClusterInstanceClass: 'db.m6gd.large',
        StorageType: 'io1',
        AllocatedStorage: 100,
        Iops: 1000,
      });
    });

    it('sends the numeric-string spelling of a size as a number', async () => {
      armLive({});
      await provider.create('Cluster', 'AWS::RDS::DBCluster', {
        ...BASE,
        AllocatedStorage: '200',
        Iops: '3000',
      });
      const [input] = sent('CreateDBClusterCommand');
      expect(input!['AllocatedStorage']).toBe(200);
      expect(input!['Iops']).toBe(3000);
    });

    it('sends none of them when the template declares none', async () => {
      armLive({});
      await provider.create('Cluster', 'AWS::RDS::DBCluster', { ...BASE });
      const [input] = sent('CreateDBClusterCommand');
      for (const key of MEMBERS) expect(input, key).not.toHaveProperty(key);
    });
  });

  describe('update', () => {
    it('sends a changed instance class alone', async () => {
      armLive({ ...MULTI_AZ });
      await update({ ...MULTI_AZ, DBClusterInstanceClass: 'db.m6gd.xlarge' }, MULTI_AZ);
      const input = modify();
      expect(input['DBClusterInstanceClass']).toBe('db.m6gd.xlarge');
      expect(input).not.toHaveProperty('AllocatedStorage');
      expect(input).not.toHaveProperty('Iops');
    });

    it('sends the declared IOPS beside a changed size, and the size beside changed IOPS', async () => {
      armLive({ ...MULTI_AZ });
      await update({ ...MULTI_AZ, AllocatedStorage: 200 }, MULTI_AZ);
      expect(modify()).toMatchObject({ AllocatedStorage: 200, Iops: 1000 });
      expect(modify()).not.toHaveProperty('DBClusterInstanceClass');

      mockSend.mockReset();
      armLive({ ...MULTI_AZ });
      await update({ ...MULTI_AZ, Iops: 2000 }, MULTI_AZ);
      expect(modify()).toMatchObject({ AllocatedStorage: 100, Iops: 2000 });
    });

    it('sends the declared size and IOPS beside a changed storage type', async () => {
      armLive({ ...MULTI_AZ });
      await update({ ...MULTI_AZ, StorageType: 'gp3' }, MULTI_AZ);
      expect(modify()).toMatchObject({ StorageType: 'gp3', AllocatedStorage: 100, Iops: 1000 });
    });

    it('sends none of them when nothing changed', async () => {
      armLive({ ...MULTI_AZ });
      await update({ ...MULTI_AZ, DeletionProtection: true }, MULTI_AZ);
      const input = modify();
      for (const key of MEMBERS) expect(input, key).not.toHaveProperty(key);
    });

    it('compares a numeric-string size against a recorded number as unchanged', async () => {
      armLive({ ...MULTI_AZ });
      await update({ ...MULTI_AZ, AllocatedStorage: '100', Iops: '1000' }, MULTI_AZ);
      const input = modify();
      expect(input).not.toHaveProperty('AllocatedStorage');
      expect(input).not.toHaveProperty('Iops');
    });

    it.each(MEMBERS)('a removed %s sends nothing, so RDS keeps the live value', async (key) => {
      armLive({ ...MULTI_AZ });
      const next = { ...MULTI_AZ };
      delete next[key];
      await update(next, MULTI_AZ);
      const input = modify();
      for (const member of MEMBERS) expect(input, member).not.toHaveProperty(member);
    });

    it('a rollback replay never sends a smaller size: the kept size rides beside the reverted IOPS and class', async () => {
      const grown = { ...MULTI_AZ, AllocatedStorage: 200, Iops: 2000, DBClusterInstanceClass: 'db.m6gd.xlarge' };
      armLive({ ...grown });
      const result = await update(MULTI_AZ, grown, { replayingState: true });
      // The pair CloudFormation always sends: the size kept, never the old one.
      expect(modify()).toMatchObject({
        AllocatedStorage: 200,
        Iops: 1000,
        DBClusterInstanceClass: 'db.m6gd.large',
      });
      expect(result.effectiveProperties?.['AllocatedStorage']).toBe(200);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(String(mockWarn.mock.calls[0]?.[0])).toMatch(/AllocatedStorage stays at 200 GiB/);
    });

    it('a template-path update sends a smaller size, which RDS refuses as CloudFormation sees it', async () => {
      const grown = { ...MULTI_AZ, AllocatedStorage: 200 };
      armLive({ ...grown });
      await update(MULTI_AZ, grown);
      expect(modify()).toMatchObject({ AllocatedStorage: 100 });
    });

    it('a rollback replay growing the size sends it', async () => {
      armLive({ ...MULTI_AZ });
      await update({ ...MULTI_AZ, AllocatedStorage: 200 }, MULTI_AZ, { replayingState: true });
      expect(modify()).toMatchObject({ AllocatedStorage: 200, Iops: 1000 });
    });
  });

  describe('state-borne updates and forced re-puts', () => {
    it('a re-put naming every key re-sends no unchanged size or IOPS (go-to-k/cdkd#4411)', async () => {
      armLive({ ...MULTI_AZ });
      await update(MULTI_AZ, MULTI_AZ, {
        changedProperties: new Set(['AllocatedStorage', 'Iops', 'StorageType', 'DBClusterInstanceClass']),
      });
      const input = modify();
      expect(input).not.toHaveProperty('AllocatedStorage');
      expect(input).not.toHaveProperty('Iops');
      expect(input).not.toHaveProperty('StorageType');
      // An unchanged class re-sent is a no-op RDS accepts.
      expect(input['DBClusterInstanceClass']).toBe('db.m6gd.large');
    });

    it.each([{ replayingState: true }, { desiredFromAwsReadback: true }])(
      'a shrink-only %o sends no size, records the size AWS keeps, and does not wait',
      async (context) => {
        const grown = { ...MULTI_AZ, AllocatedStorage: 200 };
        armLive({ ...grown }, 3);
        const result = await update(MULTI_AZ, grown, context);
        const input = modify();
        for (const key of MEMBERS) expect(input, key).not.toHaveProperty(key);
        expect(sleeps).toBe(0);
        expect(result.effectiveProperties?.['AllocatedStorage']).toBe(200);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(String(mockWarn.mock.calls[0]?.[0])).toMatch(
          /AllocatedStorage stays at 200 GiB rather than going back to 100 GiB, because RDS cannot shrink storage/
        );
      }
    );

    it('a template-path update records no effectiveProperties for a usable size', async () => {
      armLive({ ...MULTI_AZ });
      const result = await update({ ...MULTI_AZ, AllocatedStorage: 200 }, MULTI_AZ);
      expect(result.effectiveProperties).toBeUndefined();
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('a malformed instance class', () => {
    it('is refused on create before any call', async () => {
      armLive({});
      await expect(
        provider.create('Cluster', 'AWS::RDS::DBCluster', {
          ...BASE,
          ...MULTI_AZ,
          DBClusterInstanceClass: { 'Fn::If': ['c', 'a', 'b'] },
        })
      ).rejects.toThrow(/DBClusterInstanceClass must be a string/);
      expect(sent('CreateDBClusterCommand')).toHaveLength(0);
    });

    it('is refused on a template-path update before any call', async () => {
      armLive({ ...MULTI_AZ });
      await expect(update({ ...MULTI_AZ, DBClusterInstanceClass: 42 }, MULTI_AZ)).rejects.toThrow(
        /DBClusterInstanceClass must be a string/
      );
      expect(sent('ModifyDBClusterCommand')).toHaveLength(0);
    });

    it('is skipped on a replay update, and the record keeps the previous class', async () => {
      armLive({ ...MULTI_AZ });
      const result = await update(
        { ...MULTI_AZ, DeletionProtection: true, DBClusterInstanceClass: 42 },
        MULTI_AZ,
        { replayingState: true }
      );
      expect(modify()).not.toHaveProperty('DBClusterInstanceClass');
      expect(result.effectiveProperties?.['DBClusterInstanceClass']).toBe('db.m6gd.large');
    });

    it('is skipped on a replay re-create, and the record drops it', async () => {
      armLive({});
      const result = await provider.create(
        'Cluster',
        'AWS::RDS::DBCluster',
        { ...BASE, ...MULTI_AZ, DBClusterInstanceClass: 42 },
        { replayingState: true }
      );
      expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty('DBClusterInstanceClass');
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty('DBClusterInstanceClass');
    });
  });

  describe('a malformed size or IOPS', () => {
    it.each(['AllocatedStorage', 'Iops'])('%s is refused on create before any call', async (key) => {
      armLive({});
      await expect(
        provider.create('Cluster', 'AWS::RDS::DBCluster', { ...BASE, ...MULTI_AZ, [key]: 'abc' })
      ).rejects.toThrow(new RegExp(`${key} must be a whole number`));
      expect(sent('CreateDBClusterCommand')).toHaveLength(0);
    });

    it.each(['AllocatedStorage', 'Iops'])(
      '%s is skipped on a replay re-create, and the record drops it',
      async (key) => {
        armLive({});
        const result = await provider.create(
          'Cluster',
          'AWS::RDS::DBCluster',
          { ...BASE, ...MULTI_AZ, [key]: 'abc' },
          { replayingState: true }
        );
        expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty(key);
        expect(result.effectiveProperties).toBeDefined();
        expect(result.effectiveProperties).not.toHaveProperty(key);
      }
    );

    it.each(['AllocatedStorage', 'Iops'])(
      '%s is refused on a template-path update before any call',
      async (key) => {
        armLive({ ...MULTI_AZ });
        await expect(update({ ...MULTI_AZ, [key]: 'abc' }, MULTI_AZ)).rejects.toThrow(
          new RegExp(`${key} must be a whole number`)
        );
        expect(sent('ModifyDBClusterCommand')).toHaveLength(0);
      }
    );

    it.each(['AllocatedStorage', 'Iops'])(
      '%s is skipped on a replay update, and the record keeps the previous value',
      async (key) => {
        armLive({ ...MULTI_AZ });
        const result = await update(
          { ...MULTI_AZ, StorageType: 'gp3', [key]: 'abc' },
          MULTI_AZ,
          { replayingState: true }
        );
        expect(modify()).not.toHaveProperty(key);
        expect(result.effectiveProperties?.[key]).toBe(MULTI_AZ[key]);
      }
    );
  });

  describe('the wait for the change to apply', () => {
    it('polls until the new class and size are in place', async () => {
      armLive({ ...MULTI_AZ }, 3);
      await update(
        { ...MULTI_AZ, DBClusterInstanceClass: 'db.m6gd.xlarge', AllocatedStorage: 200 },
        MULTI_AZ
      );
      expect(sleeps).toBe(3);
    });

    it('by default settles in storage-optimization; --full-wait waits for available', async () => {
      const live: Record<string, unknown> = { ...MULTI_AZ };
      let reads = 0;
      mockSend.mockImplementation((command: { constructor: { name: string }; input: Input }) => {
        const name = command.constructor.name;
        if (name === 'ModifyDBClusterCommand') {
          live['AllocatedStorage'] = command.input['AllocatedStorage'];
          live['Iops'] = command.input['Iops'];
          reads = 0;
          return Promise.resolve({});
        }
        if (name === 'DescribeDBClustersCommand') {
          reads += 1;
          // Storage in place at once; optimization ends on the 4th read.
          const status = reads >= 4 ? 'available' : 'storage-optimization';
          return Promise.resolve({
            DBClusters: [{ DBClusterIdentifier: 'cluster-1', DBClusterMembers: [], ...live, Status: status }],
          });
        }
        return Promise.resolve({});
      });
      await update({ ...MULTI_AZ, AllocatedStorage: 200 }, MULTI_AZ);
      expect(sleeps).toBe(0);

      mockSend.mockClear();
      live['AllocatedStorage'] = 100;
      process.env['CDKD_FULL_WAIT'] = 'true';
      try {
        await update({ ...MULTI_AZ, AllocatedStorage: 200 }, MULTI_AZ);
      } finally {
        delete process.env['CDKD_FULL_WAIT'];
      }
      expect(sleeps).toBeGreaterThan(0);
    });

    it('on gp3, an IOPS that never reads back settles after the confirming reads, not on the first', async () => {
      // RDS reports another IOPS figure than the one sent, with nothing pending.
      const live: Record<string, unknown> = { ...MULTI_AZ, StorageType: 'gp3', Iops: 3000 };
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        Promise.resolve(
          command.constructor.name === 'DescribeDBClustersCommand'
            ? {
                DBClusters: [
                  { DBClusterIdentifier: 'cluster-1', DBClusterMembers: [], Status: 'available', ...live },
                ],
              }
            : {}
        )
      );
      const gp3 = { ...MULTI_AZ, StorageType: 'gp3', Iops: 3000 };
      await update({ ...gp3, Iops: 4000 }, gp3);
      expect(modify()).toMatchObject({ Iops: 4000 });
      expect(sleeps).toBe(MULTI_AZ_IOPS_CONFIRM_READS - 1);
    });

    it('outside a resource deadline (a rollback replay) the wait gets the 90-minute DBCluster update budget', async () => {
      armLive({ ...MULTI_AZ });
      const spy = vi.spyOn(provider, 'waitForClusterState');
      await update(
        { ...MULTI_AZ, DBClusterInstanceClass: 'db.m6gd.xlarge' },
        MULTI_AZ,
        { replayingState: true }
      );
      const call = spy.mock.calls.find((c) => c[3] === 'instance class or storage change');
      expect(call?.[4]).toBe(90 * 60 * 1000);
    });

    it('waitForClusterState polls up to the limit it is given when no resource deadline encloses it', async () => {
      armLive({ ...MULTI_AZ });
      const MIN = 60 * 1000;
      let now = 0;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 31 * MIN) - 31 * MIN);
      try {
        await expect(
          provider.waitForClusterState('Cluster', 'cluster-1', () => false, 'test change', 90 * MIN)
        ).rejects.toThrow(/Timed out waiting/);
      } finally {
        clock.mockRestore();
      }
      // Reads at 31 and 62 minutes, then 93 passes the 90-minute limit; the
      // generic 30-minute limit would read nothing.
      expect(describes()).toBe(2);
    });

    it('does not wait when nothing Multi-AZ changed', async () => {
      armLive({ ...MULTI_AZ }, 3);
      await update({ ...MULTI_AZ, DeletionProtection: true }, MULTI_AZ);
      expect(sleeps).toBe(0);
    });

    it('does not wait under --no-wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      armLive({ ...MULTI_AZ }, 3);
      const before = describes();
      await update({ ...MULTI_AZ, AllocatedStorage: 200 }, MULTI_AZ);
      expect(sleeps).toBe(0);
      expect(describes() - before).toBeLessThan(3);
    });

    it('settles a class change on the class AND `available`, a storage change on the size with nothing pending', () => {
      const sentClass = { DBClusterInstanceClass: 'db.m6gd.xlarge' };
      expect(multiAzMembersApplied({ DBClusterInstanceClass: 'db.m6gd.xlarge', Status: 'available' }, sentClass)).toBe(true);
      expect(multiAzMembersApplied({ DBClusterInstanceClass: 'db.m6gd.xlarge', Status: 'modifying' }, sentClass)).toBe(false);
      // A class change beside (or after) a storage change: RDS can hold the
      // cluster in storage-optimization for hours. The default settles there;
      // --full-wait waits for available, as CloudFormation does.
      const optimizing = { DBClusterInstanceClass: 'db.m6gd.xlarge', Status: 'storage-optimization' };
      expect(multiAzMembersApplied(optimizing, sentClass)).toBe(true);
      expect(multiAzMembersApplied(optimizing, sentClass, true)).toBe(false);
      expect(multiAzMembersApplied({ DBClusterInstanceClass: 'db.m6gd.large', Status: 'available' }, sentClass)).toBe(false);

      const sentStorage = { AllocatedStorage: 200, Iops: 2000 };
      expect(multiAzMembersApplied({ AllocatedStorage: 200, Iops: 2000, StorageType: 'io1', Status: 'storage-optimization' }, sentStorage)).toBe(true);
      expect(multiAzMembersApplied({ AllocatedStorage: 100, StorageType: 'io1', Status: 'available' }, sentStorage)).toBe(false);
      // An IOPS-only change resends the unchanged size: the size alone cannot
      // tell a read taken before RDS lists the change as pending.
      expect(multiAzMembersApplied({ AllocatedStorage: 200, Iops: 1000, StorageType: 'io1', Status: 'available' }, sentStorage)).toBe(false);
      expect(multiAzMembersApplied({ AllocatedStorage: 200, Iops: 2000, StorageType: 'io1', Status: 'available' }, sentStorage)).toBe(true);
      for (const storageType of ['io2', 'IO1']) {
        expect(
          multiAzMembersApplied(
            { AllocatedStorage: 200, Iops: 1000, StorageType: storageType, Status: 'available' },
            sentStorage
          ),
          storageType
        ).toBe(false);
      }
      // Off io1/io2 an IOPS that does not read back is not applied on one read
      // (it may be a read before RDS lists the change as pending) ...
      const gp3 = { AllocatedStorage: 200, Iops: 3000, StorageType: 'gp3', Status: 'available' };
      expect(multiAzMembersApplied(gp3, sentStorage)).toBe(false);
      // ... but RDS may report another figure there, so the probe accepts it
      // after MULTI_AZ_IOPS_CONFIRM_READS settled reads in a row.
      const probe = multiAzAppliedProbe(sentStorage, false);
      const verdicts = Array.from({ length: MULTI_AZ_IOPS_CONFIRM_READS }, () => probe(gp3));
      expect(verdicts).toEqual([...Array(MULTI_AZ_IOPS_CONFIRM_READS - 1).fill(false), true]);
      // A pending read in between restarts the count.
      const restarted = multiAzAppliedProbe(sentStorage, false);
      for (let i = 0; i < MULTI_AZ_IOPS_CONFIRM_READS - 1; i++) restarted(gp3);
      restarted({ ...gp3, PendingModifiedValues: { Iops: 2000 } });
      expect(restarted(gp3)).toBe(false);
      // A gp3 IOPS that reads back is applied at once.
      expect(multiAzAppliedProbe(sentStorage, false)({ ...gp3, Iops: 2000 })).toBe(true);
      for (const pending of [{ AllocatedStorage: 200 }, { Iops: 2000 }, { StorageType: 'gp3' }]) {
        expect(
          multiAzMembersApplied(
            { AllocatedStorage: 200, Iops: 2000, StorageType: 'io1', Status: 'available', PendingModifiedValues: pending },
            sentStorage
          ),
          JSON.stringify(pending)
        ).toBe(false);
      }
      expect(multiAzMembersApplied({ Iops: 2000, StorageType: 'io1', Status: 'available', PendingModifiedValues: { Iops: 2000 } }, { Iops: 2000 })).toBe(false);
      expect(multiAzMembersApplied({ Status: 'modifying' }, {})).toBe(true);
    });
  });

  describe('readCurrentState', () => {
    const readBack = (cluster: Input): Promise<Record<string, unknown>> => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        Promise.resolve(
          command.constructor.name === 'DescribeDBClustersCommand'
            ? { DBClusters: [{ DBClusterIdentifier: 'cluster-1', ...cluster }] }
            : {}
        )
      );
      return provider.readCurrentState('cluster-1', 'Cluster', 'AWS::RDS::DBCluster') as Promise<
        Record<string, unknown>
      >;
    };

    it('reports a Multi-AZ cluster class, size and IOPS, the pending ones first', async () => {
      expect(
        await readBack({
          Engine: 'postgres',
          DBClusterInstanceClass: 'db.m6gd.large',
          AllocatedStorage: 100,
          Iops: 1000,
          PendingModifiedValues: { AllocatedStorage: 200, Iops: 2000 },
        })
      ).toMatchObject({ DBClusterInstanceClass: 'db.m6gd.large', AllocatedStorage: 200, Iops: 2000 });
      expect(
        await readBack({ Engine: 'mysql', AllocatedStorage: 100, Iops: 1000 })
      ).toMatchObject({ AllocatedStorage: 100, Iops: 1000 });
    });

    it('reports them when DescribeDBClusters names no engine', async () => {
      expect(
        await readBack({ DBClusterInstanceClass: 'db.m6gd.large', AllocatedStorage: 100, Iops: 1000 })
      ).toMatchObject({ DBClusterInstanceClass: 'db.m6gd.large', AllocatedStorage: 100, Iops: 1000 });
    });

    it('reports none of them on an Aurora engine', async () => {
      const state = await readBack({
        Engine: 'aurora-postgresql',
        DBClusterInstanceClass: 'db.r6g.large',
        AllocatedStorage: 1,
        Iops: 1000,
      });
      for (const key of MEMBERS) expect(state, key).not.toHaveProperty(key);
    });
  });

  it('drift folds a numeric-string size and IOPS to the readback number', () => {
    const folded = provider.canonicalizeDriftProperties('AWS::RDS::DBCluster', {
      AllocatedStorage: '100',
      Iops: '1000',
      DBClusterInstanceClass: 'db.m6gd.large',
    });
    expect(folded).toEqual({
      AllocatedStorage: 100,
      Iops: 1000,
      DBClusterInstanceClass: 'db.m6gd.large',
    });
  });
});
