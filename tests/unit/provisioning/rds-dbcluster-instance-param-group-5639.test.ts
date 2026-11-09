// go-to-k/cdkd#5639: DBCluster `DBInstanceParameterGroupName`. CreateDBCluster
// has no such member; ModifyDBCluster carries it only beside a changed
// EngineVersion and only when the template changed it, as CloudFormation's
// handler sends it (`Translator.modifyDbClusterRequest`). Nothing on a
// rollback replay, a removal, or a change without an engine-version change.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
import { getPropertyCoverage } from '../../../src/provisioning/property-coverage.js';

type Input = Record<string, unknown>;

function armLive(): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (name === 'DescribeDBClustersCommand') {
      return Promise.resolve({
        DBClusters: [
          {
            DBClusterIdentifier: 'cluster-1',
            DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:cluster-1',
            DBClusterMembers: [],
            Status: 'available',
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

const BASE: Input = {
  DBClusterIdentifier: 'cluster-1',
  Engine: 'aurora-postgresql',
  MasterUsername: 'postgres',
};

const KEY = 'DBInstanceParameterGroupName';

describe('RDSProvider DBCluster DBInstanceParameterGroupName (go-to-k/cdkd#5639)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    armLive();
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

  it('is handled, so a template declaring it keeps the SDK route', () => {
    expect(provider.handledProperties.get('AWS::RDS::DBCluster')?.has(KEY)).toBe(true);
    expect(getPropertyCoverage('AWS::RDS::DBCluster')?.sdkUnwired.has(KEY)).toBe(false);
  });

  it('is never sent on create (CreateDBCluster has no such member), and is recorded', async () => {
    const result = await provider.create('Cluster', 'AWS::RDS::DBCluster', {
      ...BASE,
      EngineVersion: '16.13',
      [KEY]: 'params-16',
    });
    expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty(KEY);
    expect(result.effectiveProperties).toBeUndefined();
  });

  describe('update', () => {
    it('is sent beside a changed EngineVersion with AllowMajorVersionUpgrade, when changed', async () => {
      await update(
        { EngineVersion: '17.10', [KEY]: 'params-17' },
        { EngineVersion: '16.13', [KEY]: 'params-16' }
      );
      expect(modify()).toMatchObject({
        EngineVersion: '17.10',
        AllowMajorVersionUpgrade: true,
        [KEY]: 'params-17',
      });
    });

    it('is sent when newly declared beside a changed EngineVersion', async () => {
      await update({ EngineVersion: '17.10', [KEY]: 'params-17' }, { EngineVersion: '16.13' });
      expect(modify()[KEY]).toBe('params-17');
    });

    // RDS refuses it on a minor upgrade ("can only be specified for a major
    // version upgrade", InvalidParameterCombination; measured us-east-1,
    // 2026-11-09), and refuses CloudFormation's identical request the same way.
    it('is sent beside a minor EngineVersion change too, as CloudFormation sends it', async () => {
      await update(
        { EngineVersion: '16.14', [KEY]: 'params-16b' },
        { EngineVersion: '16.13', [KEY]: 'params-16a' }
      );
      expect(modify()).toMatchObject({ EngineVersion: '16.14', [KEY]: 'params-16b' });
    });

    it('is not sent when unchanged, even beside a changed EngineVersion', async () => {
      await update(
        { EngineVersion: '17.10', [KEY]: 'params-16' },
        { EngineVersion: '16.13', [KEY]: 'params-16' }
      );
      const input = modify();
      expect(input['EngineVersion']).toBe('17.10');
      expect(input).not.toHaveProperty(KEY);
    });

    it('is not sent when changed without an EngineVersion change', async () => {
      const result = await update(
        { EngineVersion: '16.13', [KEY]: 'params-16b', DeletionProtection: true },
        { EngineVersion: '16.13', [KEY]: 'params-16a', DeletionProtection: true }
      );
      const input = modify();
      expect(input).not.toHaveProperty(KEY);
      expect(input).not.toHaveProperty('EngineVersion');
      // The record takes the template's value, as CloudFormation's model does.
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('is not sent on removal, beside a changed EngineVersion', async () => {
      await update({ EngineVersion: '17.10' }, { EngineVersion: '16.13', [KEY]: 'params-16' });
      const input = modify();
      expect(input['EngineVersion']).toBe('17.10');
      expect(input).not.toHaveProperty(KEY);
    });

    it('is not sent on a rollback replay, which sends no EngineVersion', async () => {
      await update(
        { EngineVersion: '16.13', [KEY]: 'params-16' },
        { EngineVersion: '17.10', [KEY]: 'params-17' },
        { replayingState: true }
      );
      const input = modify();
      expect(input).not.toHaveProperty('EngineVersion');
      expect(input).not.toHaveProperty(KEY);
    });
  });

  describe('a value that is not a string', () => {
    it('is refused on create before any call', async () => {
      await expect(
        provider.create('Cluster', 'AWS::RDS::DBCluster', { ...BASE, [KEY]: 42 })
      ).rejects.toThrow(/DBInstanceParameterGroupName must be a string/);
      expect(sent('CreateDBClusterCommand')).toHaveLength(0);
    });

    it('is refused on a template-path update before any call', async () => {
      await expect(
        update({ EngineVersion: '17.10', [KEY]: { Ref: 'P' } }, { EngineVersion: '16.13' })
      ).rejects.toThrow(/DBInstanceParameterGroupName must be a string/);
      expect(sent('ModifyDBClusterCommand')).toHaveLength(0);
    });

    it('is skipped on a replay update, and the record keeps the previous value', async () => {
      const result = await update(
        { DeletionProtection: true, [KEY]: 42 },
        { DeletionProtection: true, [KEY]: 'params-16' },
        { replayingState: true }
      );
      expect(modify()).not.toHaveProperty(KEY);
      expect(result.effectiveProperties?.[KEY]).toBe('params-16');
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('the replayed DBInstanceParameterGroupName is not a string')
      );
    });

    it('is skipped on a replay re-create, and the record drops it', async () => {
      const result = await provider.create(
        'Cluster',
        'AWS::RDS::DBCluster',
        { ...BASE, [KEY]: 42 },
        { replayingState: true }
      );
      expect(sent('CreateDBClusterCommand')).toHaveLength(1);
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty(KEY);
    });
  });

  it('is never compared by cdkd drift: RDS never reports it', () => {
    for (const bag of [undefined, {}, { ...BASE, [KEY]: 'params-16' }]) {
      expect(provider.getDriftUnknownPaths('AWS::RDS::DBCluster', bag)).toContain(KEY);
    }
  });
});
