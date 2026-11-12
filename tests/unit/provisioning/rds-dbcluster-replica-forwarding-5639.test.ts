// go-to-k/cdkd#5639: AWS::RDS::DBCluster `EnableGlobalWriteForwarding`,
// `ReplicationSourceIdentifier` and `SourceRegion` on the SDK route, as
// CloudFormation's handler treats them: the forwarding flag rides
// CreateDBCluster (a restore's follow-up ModifyDBCluster) and, when changed,
// ModifyDBCluster, each waited out until forwarding is no longer
// `enabling` / `disabling`; the replica source rides CreateDBCluster alone;
// `SourceRegion` is validated and never sent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();
const warn = vi.fn();

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
    warn: (...args: unknown[]) => warn(...args),
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
import { globalWriteForwardingApplied } from '../../../src/provisioning/providers/rds/cluster-members.js';
import {
  AWS_CN_CROSS_REGION_REPLICA_RATIONALE,
  findActionableSdkUnwired,
  findSdkUnwiredProperties,
} from '../../../src/provisioning/property-coverage.js';

type Input = Record<string, unknown>;

const CLUSTER = 'AWS::RDS::DBCluster';
const ACCOUNT = '123456789012';
const ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:c-1`;
const SOURCE_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:db:mysql-source`;
const CROSS_ARN = `arn:aws:rds:us-west-2:${ACCOUNT}:cluster:source-1`;

/**
 * DescribeDBClusters answers an `available` cluster merged with the next entry
 * of `reads` (the last one repeats); the create and either restore answer the
 * cluster, every other call `{}`.
 */
function arm(reads: Input[] = [{}]): void {
  let read = 0;
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'DescribeDBClustersCommand': {
        const live = reads[Math.min(read, reads.length - 1)];
        read += 1;
        return Promise.resolve({
          DBClusters: [
            {
              DBClusterIdentifier: 'c-1',
              DBClusterArn: ARN,
              Status: 'available',
              DBClusterMembers: [],
              ...live,
            },
          ],
        });
      }
      case 'CreateDBClusterCommand':
      case 'RestoreDBClusterFromSnapshotCommand':
        return Promise.resolve({ DBCluster: { DBClusterIdentifier: 'c-1', DBClusterArn: ARN } });
      case 'DescribeDBClusterSnapshotsCommand':
        return Promise.resolve({ DBClusterSnapshots: [{ EngineVersion: '8.0' }] });
      default:
        return Promise.resolve({});
    }
  });
}

function sent(name: string): Input[] {
  return mockSend.mock.calls
    .map(([command]) => command as { constructor: { name: string }; input: Input })
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}

const BASE: Input = {
  DBClusterIdentifier: 'c-1',
  Engine: 'aurora-mysql',
};

describe('RDSProvider AWS::RDS::DBCluster replica and global write forwarding (go-to-k/cdkd#5639)', () => {
  let provider: RDSProvider;
  let sleeps: number;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = new RDSProvider();
    sleeps = 0;
    // A wait that never settles fails the case instead of spinning.
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
      sleeps += 1;
      if (sleeps > 20) throw new Error('test sleep budget exceeded: a wait never settled');
    };
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const create = (props: Input, replaying = false) =>
    provider.create('L', CLUSTER, { ...BASE, ...props }, replaying ? { replayingState: true } : undefined);
  const update = (next: Input, prev: Input, context?: Record<string, unknown>) =>
    provider.update('L', 'c-1', CLUSTER, { ...BASE, ...next }, { ...BASE, ...prev }, context);

  describe('create', () => {
    it('sends the replica source and the forwarding flag on CreateDBCluster, never SourceRegion', async () => {
      arm();
      await create({
        ReplicationSourceIdentifier: SOURCE_ARN,
        EnableGlobalWriteForwarding: true,
        SourceRegion: 'us-east-1',
      });
      const [input] = sent('CreateDBClusterCommand');
      expect(input).toMatchObject({
        ReplicationSourceIdentifier: SOURCE_ARN,
        EnableGlobalWriteForwarding: true,
      });
      expect(input).not.toHaveProperty('SourceRegion');
    });

    it("sends the CFn string spelling 'false' as false", async () => {
      arm();
      await create({ EnableGlobalWriteForwarding: 'false' });
      expect(sent('CreateDBClusterCommand')[0]!['EnableGlobalWriteForwarding']).toBe(false);
    });

    it('sends neither when absent, nor a blank replica source', async () => {
      arm();
      await create({ ReplicationSourceIdentifier: '  ' });
      const [input] = sent('CreateDBClusterCommand');
      expect(input).not.toHaveProperty('ReplicationSourceIdentifier');
      expect(input).not.toHaveProperty('EnableGlobalWriteForwarding');
    });

    it.each([
      ['ReplicationSourceIdentifier', { 'Fn::GetAtt': ['Source', 'DBInstanceArn'] }, /ReplicationSourceIdentifier must be a string/],
      ['EnableGlobalWriteForwarding', 'yes', /EnableGlobalWriteForwarding must be true or false/],
      ['SourceRegion', 'mars-north-1', /Unknown source region/],
    ])('refuses a malformed %s before any call', async (key, value, says) => {
      arm();
      await expect(create({ [key]: value })).rejects.toThrow(says);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['ReplicationSourceIdentifier', ['arn-1']],
      ['EnableGlobalWriteForwarding', 'yes'],
    ])('a replayed malformed %s warns, is not sent and leaves the record', async (key, value) => {
      arm();
      const result = await create({ [key]: value }, true);
      expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty(key);
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty(key);
      expect(warn.mock.calls.flat().join('\n')).toContain(`the replayed ${key} is not`);
    });

    it('a replayed unknown SourceRegion warns and creates the cluster', async () => {
      arm();
      await create({ SourceRegion: 'mars-north-1' }, true);
      expect(sent('CreateDBClusterCommand')).toHaveLength(1);
      expect(warn.mock.calls.flat().join('\n')).toMatch(/Unknown source region.*never sent/);
    });

    it('waits until requested forwarding is no longer enabling', async () => {
      arm([
        {},
        { GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'enabling' },
        { GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'enabling' },
        { GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'enabled' },
      ]);
      await create({ EnableGlobalWriteForwarding: true });
      // The available wait settles at once; the forwarding wait polls past
      // the two reads while it is enabling.
      expect(sleeps).toBe(2);
    });

    it('ends the wait when RDS reports no request, as CloudFormation does', async () => {
      arm([{ GlobalWriteForwardingRequested: false, GlobalWriteForwardingStatus: 'enabling' }]);
      await create({ EnableGlobalWriteForwarding: true });
      expect(sleeps).toBe(0);
    });

    it('does not wait for forwarding declared false, nor under --no-wait', async () => {
      arm([{ GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'enabling' }]);
      await create({ EnableGlobalWriteForwarding: false });
      expect(sleeps).toBe(0);
      arm([{ GlobalWriteForwardingRequested: false }]);
      process.env['CDKD_NO_WAIT'] = 'true';
      await create({ EnableGlobalWriteForwarding: true });
      expect(sleeps).toBe(0);
    });

    it("a snapshot restore sends the forwarding flag on CloudFormation's follow-up ModifyDBCluster and no replica source", async () => {
      arm();
      await create({
        SnapshotIdentifier: 'snap-1',
        ReplicationSourceIdentifier: SOURCE_ARN,
        EnableGlobalWriteForwarding: true,
      });
      const [restore] = sent('RestoreDBClusterFromSnapshotCommand');
      expect(restore).not.toHaveProperty('ReplicationSourceIdentifier');
      expect(restore).not.toHaveProperty('EnableGlobalWriteForwarding');
      const [followUp] = sent('ModifyDBClusterCommand');
      expect(followUp).toMatchObject({ EnableGlobalWriteForwarding: true });
      expect(followUp).not.toHaveProperty('ReplicationSourceIdentifier');
      expect(warn.mock.calls.flat().join('\n')).toMatch(
        /snapshot restore does not apply ReplicationSourceIdentifier/
      );
    });
  });

  describe('update', () => {
    it('sends a changed forwarding flag and waits for it', async () => {
      arm([
        { GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'enabling' },
        { GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'enabling' },
        { GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'disabled' },
      ]);
      await update({ EnableGlobalWriteForwarding: true }, { EnableGlobalWriteForwarding: false });
      expect(sent('ModifyDBClusterCommand')).toEqual([
        expect.objectContaining({ EnableGlobalWriteForwarding: true }),
      ]);
      // Past the two reads while it is enabling.
      expect(sleeps).toBe(2);
    });

    it('does not wait for a changed flag under --no-wait', async () => {
      arm([{ GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'enabling' }]);
      process.env['CDKD_NO_WAIT'] = 'true';
      await update({ EnableGlobalWriteForwarding: true }, { EnableGlobalWriteForwarding: false });
      expect(sent('ModifyDBClusterCommand')[0]).toMatchObject({ EnableGlobalWriteForwarding: true });
      expect(sleeps).toBe(0);
    });

    it('waits for a turned-off flag only until it is no longer requested', async () => {
      arm([
        { GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'disabling' },
        { GlobalWriteForwardingRequested: false, GlobalWriteForwardingStatus: 'disabling' },
      ]);
      await update({ EnableGlobalWriteForwarding: false }, { EnableGlobalWriteForwarding: true });
      expect(sent('ModifyDBClusterCommand')[0]).toMatchObject({ EnableGlobalWriteForwarding: false });
      expect(sleeps).toBe(1);
    });

    it.each([
      ['unchanged', { EnableGlobalWriteForwarding: true }, { EnableGlobalWriteForwarding: true }],
      ['removed', {}, { EnableGlobalWriteForwarding: true }],
    ])('sends no forwarding flag when %s', async (_, next, prev) => {
      arm();
      await update({ ...next, BackupRetentionPeriod: 3 }, { ...prev, BackupRetentionPeriod: 1 });
      for (const input of sent('ModifyDBClusterCommand')) {
        expect(input).not.toHaveProperty('EnableGlobalWriteForwarding');
      }
    });

    it('refuses a malformed forwarding flag before any call; a replay keeps the previous one', async () => {
      arm();
      await expect(update({ EnableGlobalWriteForwarding: 'yes' }, {})).rejects.toThrow(
        /EnableGlobalWriteForwarding must be true or false/
      );
      expect(mockSend).not.toHaveBeenCalled();
      const result = await update(
        { EnableGlobalWriteForwarding: 'yes' },
        { EnableGlobalWriteForwarding: true },
        { replayingState: true }
      );
      expect(sent('ModifyDBClusterCommand').every((i) => !('EnableGlobalWriteForwarding' in i))).toBe(
        true
      );
      expect(result.effectiveProperties).toMatchObject({ EnableGlobalWriteForwarding: true });
    });

    it.each([
      ['changed', { ReplicationSourceIdentifier: CROSS_ARN }, { ReplicationSourceIdentifier: SOURCE_ARN }],
      ['removed', {}, { ReplicationSourceIdentifier: SOURCE_ARN }],
    ])('a %s replica source sends nothing and warns that it stays', async (_, next, prev) => {
      arm();
      await update(next, prev);
      for (const input of mockSend.mock.calls.map(([c]) => (c as { input: Input }).input)) {
        expect(input).not.toHaveProperty('ReplicationSourceIdentifier');
      }
      expect(sent('PromoteReadReplicaDBClusterCommand')).toEqual([]);
      expect(warn.mock.calls.flat().join('\n')).toMatch(
        /changed ReplicationSourceIdentifier is not applied.*promote-read-replica-db-cluster/
      );
    });

    it('an unchanged or non-string replica source, a replay or a drift revert warns nothing', async () => {
      arm();
      await update({ ReplicationSourceIdentifier: SOURCE_ARN }, { ReplicationSourceIdentifier: SOURCE_ARN });
      await update({ ReplicationSourceIdentifier: ['arn-1'] }, { ReplicationSourceIdentifier: SOURCE_ARN });
      await update({}, { ReplicationSourceIdentifier: SOURCE_ARN }, { replayingState: true });
      await update({}, { ReplicationSourceIdentifier: SOURCE_ARN }, { desiredFromAwsReadback: true });
      expect(warn.mock.calls.flat().join('\n')).not.toContain('ReplicationSourceIdentifier');
    });
  });

  it('drift compares none of the three: none is read back', () => {
    const unknown = provider.getDriftUnknownPaths(CLUSTER, { ...BASE, ReplicationSourceIdentifier: SOURCE_ARN });
    expect(unknown).toEqual(
      expect.arrayContaining(['EnableGlobalWriteForwarding', 'ReplicationSourceIdentifier', 'SourceRegion'])
    );
  });

  describe('globalWriteForwardingApplied', () => {
    it.each([
      [{}, true],
      [{ GlobalWriteForwardingRequested: false }, true],
      [{ GlobalWriteForwardingRequested: false, GlobalWriteForwardingStatus: 'disabling' }, true],
      [{ GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'enabling' }, false],
      [{ GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'disabling' }, false],
      [{ GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'enabled' }, true],
      [{ GlobalWriteForwardingRequested: true, GlobalWriteForwardingStatus: 'disabled' }, true],
      [{ GlobalWriteForwardingRequested: true }, true],
    ] as const)('live %j: %s', (live, expected) => {
      expect(globalWriteForwardingApplied(live)).toBe(expected);
    });
  });

  describe('the cross-region presigned URL (AWS SDK for JavaScript RDS middleware)', () => {
    async function wireBody(source: string, region = 'us-east-1'): Promise<string> {
      const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
      let body = '';
      const client = new actual.RDSClient({
        region,
        credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-secret' },
        requestHandler: {
          handle: async (request: { body?: unknown }) => {
            body = String(request.body);
            throw new Error('captured');
          },
        },
      });
      try {
        await client
          .send(
            new actual.CreateDBClusterCommand({
              DBClusterIdentifier: 'c-1',
              Engine: 'aurora-mysql',
              ReplicationSourceIdentifier: source,
            })
          )
          .catch(() => undefined);
      } finally {
        client.destroy();
      }
      // Twice: the presigned URL is itself a percent-encoded form value.
      return decodeURIComponent(decodeURIComponent(body));
    }

    it('presigns CreateDBCluster for a cross-region source ARN, with no SourceRegion member', async () => {
      const body = await wireBody(CROSS_ARN);
      expect(body).toMatch(/PreSignedUrl=https:\/\/rds\.us-west-2\.amazonaws\.com/);
      expect(body).toContain('Action=CreateDBCluster');
      expect(body).toContain('DestinationRegion=us-east-1');
      expect(body).not.toMatch(/(^|&)SourceRegion=/);
    });

    it('presigns nothing for a same-region source', async () => {
      const body = await wireBody(SOURCE_ARN);
      expect(body).toContain('ReplicationSourceIdentifier=');
      expect(body).not.toContain('PreSignedUrl');
    });

    // Why an aws-cn cross-region replica keeps the Cloud Control route.
    it('signs an aws-cn cross-region source for the commercial host', async () => {
      const body = await wireBody(`arn:aws-cn:rds:cn-northwest-1:${ACCOUNT}:cluster:source-1`, 'cn-north-1');
      expect(body).toMatch(/PreSignedUrl=https:\/\/rds\.cn-northwest-1\.amazonaws\.com\/\?/);
      expect(body).not.toContain('amazonaws.com.cn');
    });
  });

  describe('routing an aws-cn cross-region replica cluster through Cloud Control', () => {
    const CN_SOURCE = `arn:aws-cn:rds:cn-northwest-1:${ACCOUNT}:cluster:source-1`;
    const routeDriving = (bag: Input, allowed: ReadonlySet<string> = new Set()) =>
      findActionableSdkUnwired(CLUSTER, bag, allowed).map((d) => d.property);
    let savedRegion: string | undefined;
    beforeEach(() => {
      savedRegion = process.env['AWS_REGION'];
      process.env['AWS_REGION'] = 'cn-north-1';
    });
    afterEach(() => {
      if (savedRegion === undefined) delete process.env['AWS_REGION'];
      else process.env['AWS_REGION'] = savedRegion;
    });

    it('routes a source ARN in another aws-cn region, SourceRegion declared or not', () => {
      for (const bag of [
        { ...BASE, ReplicationSourceIdentifier: CN_SOURCE },
        { ...BASE, ReplicationSourceIdentifier: CN_SOURCE, SourceRegion: 'cn-northwest-1' },
      ]) {
        expect(routeDriving(bag)).toEqual(['ReplicationSourceIdentifier']);
      }
      expect(findActionableSdkUnwired(CLUSTER, { ReplicationSourceIdentifier: CN_SOURCE }, new Set())).toEqual([
        { property: 'ReplicationSourceIdentifier', rationale: AWS_CN_CROSS_REGION_REPLICA_RATIONALE },
      ]);
    });

    it('routes it when the deploying region is unknown', () => {
      delete process.env['AWS_REGION'];
      expect(routeDriving({ ReplicationSourceIdentifier: CN_SOURCE })).toEqual(['ReplicationSourceIdentifier']);
    });

    it.each([
      ['a same-region aws-cn source', `arn:aws-cn:rds:cn-north-1:${ACCOUNT}:cluster:source-1`],
      ['a commercial cross-region source', CROSS_ARN],
      ['an unresolved intrinsic', { 'Fn::GetAtt': ['Source', 'DBClusterArn'] }],
    ])('keeps the SDK route for %s', (_, source) => {
      expect(routeDriving({ ...BASE, ReplicationSourceIdentifier: source })).toEqual([]);
    });

    it('keeps the SDK route when --prefer-sdk-route names the key', () => {
      expect(
        routeDriving({ ReplicationSourceIdentifier: CN_SOURCE }, new Set([`${CLUSTER}:ReplicationSourceIdentifier`]))
      ).toEqual([]);
    });

    it('narrows nothing away: the three keys are handled ones', () => {
      expect(
        findSdkUnwiredProperties(CLUSTER, {
          ReplicationSourceIdentifier: CN_SOURCE,
          SourceRegion: 'cn-northwest-1',
          EnableGlobalWriteForwarding: true,
        })
      ).toEqual([]);
    });
  });
});
