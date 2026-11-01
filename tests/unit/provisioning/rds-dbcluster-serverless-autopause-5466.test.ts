// issue #5466: AWS::RDS::DBCluster ServerlessV2ScalingConfiguration
// .SecondsUntilAutoPause reaches CreateDBCluster and ModifyDBCluster, as
// CloudFormation's handler sends it, is read back for drift, and is scoped out
// of drift where the template declares none.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

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
    warn: vi.fn(),
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

const TYPE = 'AWS::RDS::DBCluster';
const LIVE_CLUSTER = {
  DBClusterIdentifier: 'my-cluster',
  DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
  Status: 'available',
  Engine: 'aurora-postgresql',
  ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1, SecondsUntilAutoPause: 1800 },
};

function answerByCommand(): void {
  mockSend.mockImplementation(async (command: object) => {
    switch (command.constructor.name) {
      case 'CreateDBClusterCommand':
        return { DBCluster: LIVE_CLUSTER };
      case 'DescribeDBClustersCommand':
        return { DBClusters: [LIVE_CLUSTER] };
      case 'ListTagsForResourceCommand':
        return { TagList: [] };
      default:
        return {};
    }
  });
}

function sentInput(commandName: string): Record<string, unknown> {
  const call = mockSend.mock.calls.find(
    ([command]) => (command as object).constructor.name === commandName
  );
  if (!call) throw new Error(`${commandName} was not sent`);
  return (call[0] as { input: Record<string, unknown> }).input;
}

const base = { Engine: 'aurora-postgresql', MasterUsername: 'postgres' };

describe('RDSProvider DBCluster SecondsUntilAutoPause (issue #5466)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    answerByCommand();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  it('sends a declared SecondsUntilAutoPause on CreateDBCluster', async () => {
    await provider.create('MyCluster', TYPE, {
      ...base,
      DBClusterIdentifier: 'my-cluster',
      ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1, SecondsUntilAutoPause: 1800 },
    });

    expect(sentInput('CreateDBClusterCommand')['ServerlessV2ScalingConfiguration']).toEqual({
      MinCapacity: 0,
      MaxCapacity: 1,
      SecondsUntilAutoPause: 1800,
    });
  });

  it('coerces a string SecondsUntilAutoPause and sends no key when none is declared', async () => {
    await provider.create('MyCluster', TYPE, {
      ...base,
      DBClusterIdentifier: 'my-cluster',
      ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1, SecondsUntilAutoPause: '600' },
    });
    expect(sentInput('CreateDBClusterCommand')['ServerlessV2ScalingConfiguration']).toEqual({
      MinCapacity: 0,
      MaxCapacity: 1,
      SecondsUntilAutoPause: 600,
    });

    mockSend.mockClear();
    await provider.create('MyCluster', TYPE, {
      ...base,
      DBClusterIdentifier: 'my-cluster',
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 1 },
    });
    expect(sentInput('CreateDBClusterCommand')['ServerlessV2ScalingConfiguration']).toEqual({
      MinCapacity: 0.5,
      MaxCapacity: 1,
    });
  });

  it('sends a changed SecondsUntilAutoPause on ModifyDBCluster', async () => {
    await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { ...base, ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1, SecondsUntilAutoPause: 1800 } },
      { ...base, ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1, SecondsUntilAutoPause: 600 } }
    );

    expect(sentInput('ModifyDBClusterCommand')['ServerlessV2ScalingConfiguration']).toEqual({
      MinCapacity: 0,
      MaxCapacity: 1,
      SecondsUntilAutoPause: 1800,
    });
  });

  it('sends a newly added SecondsUntilAutoPause on ModifyDBCluster', async () => {
    await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { ...base, ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1, SecondsUntilAutoPause: 900 } },
      { ...base, ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1 } }
    );

    expect(sentInput('ModifyDBClusterCommand')['ServerlessV2ScalingConfiguration']).toEqual({
      MinCapacity: 0,
      MaxCapacity: 1,
      SecondsUntilAutoPause: 900,
    });
  });

  it('sends the block without SecondsUntilAutoPause when the template drops it, as CloudFormation does', async () => {
    // Measured (us-east-1): CloudFormation sends the block without the member
    // and AWS resets the delay to its 300-second default.
    await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { ...base, ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1 } },
      { ...base, ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1, SecondsUntilAutoPause: 1800 } }
    );

    const sent = sentInput('ModifyDBClusterCommand')['ServerlessV2ScalingConfiguration'];
    expect(sent).toEqual({ MinCapacity: 0, MaxCapacity: 1 });
    expect(Object.keys(sent as object)).not.toContain('SecondsUntilAutoPause');
  });

  it('reads SecondsUntilAutoPause back for drift', async () => {
    const state = await provider.readCurrentState('my-cluster', 'MyCluster', TYPE);

    expect((state as Record<string, unknown>)['ServerlessV2ScalingConfiguration']).toEqual({
      MinCapacity: 0,
      MaxCapacity: 1,
      SecondsUntilAutoPause: 1800,
    });
  });

  it('compares SecondsUntilAutoPause only where the template declares it', () => {
    const path = 'ServerlessV2ScalingConfiguration.SecondsUntilAutoPause';
    expect(
      provider.getDriftUnknownPaths(TYPE, {
        ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1, SecondsUntilAutoPause: 600 },
      })
    ).toEqual([]);
    expect(
      provider.getDriftUnknownPaths(TYPE, {
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 1 },
      })
    ).toEqual([path]);
    expect(provider.getDriftUnknownPaths(TYPE, { Engine: 'aurora-postgresql' })).toEqual([path]);
    // An absent or empty bag records nothing to scope by: the path is compared.
    expect(provider.getDriftUnknownPaths(TYPE, {})).toEqual([]);
    expect(provider.getDriftUnknownPaths(TYPE)).toEqual([]);
    // The cluster path never reaches a DB instance (whose own unreadable flags
    // are go-to-k/cdkd#2762's).
    expect(provider.getDriftUnknownPaths('AWS::RDS::DBInstance', {})).not.toContain(path);
    expect(
      provider.getDriftUnknownPaths('AWS::RDS::DBInstance', {
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 1 },
      })
    ).not.toContain(path);
  });
});
