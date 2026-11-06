// go-to-k/cdkd#5639: AWS::RDS::DBCluster `EngineMode` and `AvailabilityZones`
// on the SDK route. Both ride CreateDBCluster alone, as CloudFormation's create
// sends them (`Translator.createDbClusterRequest`). `EngineMode` is create-only;
// `AvailabilityZones` is schema-mutable, but ModifyDBCluster has no member for
// it and CloudFormation's update sends none (`Translator.modifyDbClusterRequest`),
// so an update keeps the live zones. Neither is read back.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';

type Input = Record<string, unknown>;

const CLUSTER = 'AWS::RDS::DBCluster';
const ARN = 'arn:aws:rds:us-east-1:123456789012:cluster:c-1';
const ZONES = ['us-east-1a', 'us-east-1b'];

/** DescribeDBClusters answers an `available` cluster merged with `live`. */
function arm(live: Input = {}): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'DescribeDBClustersCommand':
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
      case 'CreateDBClusterCommand':
        return Promise.resolve({ DBCluster: { DBClusterIdentifier: 'c-1' } });
      case 'ListTagsForResourceCommand':
        return Promise.resolve({ TagList: [] });
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
  Engine: 'aurora-postgresql',
  MasterUsername: 'admin',
};

describe('RDSProvider AWS::RDS::DBCluster EngineMode and AvailabilityZones (go-to-k/cdkd#5639)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  it.each(['EngineMode', 'AvailabilityZones'])(
    '%s is a handled property, so a template declaring it keeps the SDK route',
    (key) => {
      expect(provider.handledProperties.get(CLUSTER)?.has(key)).toBe(true);
      expect(PROPERTY_COVERAGE_BY_TYPE.get(CLUSTER)?.sdkUnwired.has(key)).toBe(false);
    }
  );

  it('ScalingConfiguration stays unwired by design (Aurora Serverless v1 is retired)', () => {
    expect(provider.handledProperties.get(CLUSTER)?.has('ScalingConfiguration')).toBe(false);
    expect(provider.unhandledByDesign.get(CLUSTER)?.get('ScalingConfiguration')).toMatch(
      /Serverless v1/
    );
    // Still sdkUnwired, so a template declaring it keeps its Cloud Control route.
    expect(PROPERTY_COVERAGE_BY_TYPE.get(CLUSTER)?.sdkUnwired.get('ScalingConfiguration')).toMatch(
      /Serverless v1/
    );
  });

  describe('create', () => {
    it('sends the declared engine mode and zones on CreateDBCluster', async () => {
      arm();
      await provider.create('L', CLUSTER, {
        ...BASE,
        EngineMode: 'provisioned',
        AvailabilityZones: ZONES,
      });
      expect(sent('CreateDBClusterCommand')[0]).toMatchObject({
        EngineMode: 'provisioned',
        AvailabilityZones: ZONES,
      });
      expect(sent('ModifyDBClusterCommand')).toHaveLength(0);
    });

    it('sends neither when the template declares neither', async () => {
      arm();
      await provider.create('L', CLUSTER, { ...BASE });
      const input = sent('CreateDBClusterCommand')[0]!;
      expect(input).not.toHaveProperty('EngineMode');
      expect(input).not.toHaveProperty('AvailabilityZones');
    });

    it('sends no member for a declared empty zone list (RDS picks, as for an absent one)', async () => {
      arm();
      await provider.create('L', CLUSTER, { ...BASE, AvailabilityZones: [] });
      expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty('AvailabilityZones');
    });

    it.each([
      ['us-east-1a'],
      [['us-east-1a', 1]],
      [{ Zone: 'us-east-1a' }],
      [['']],
      [['us-east-1a', '  ']],
    ])(
      'refuses malformed AvailabilityZones %j before any call',
      async (value) => {
        arm();
        await expect(
          provider.create('L', CLUSTER, { ...BASE, AvailabilityZones: value })
        ).rejects.toThrow(/AvailabilityZones must be a list of Availability Zone names/);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it('a rollback re-create leaves malformed zones out, warns, and records none', async () => {
      arm();
      const result = await provider.create(
        'L',
        CLUSTER,
        { ...BASE, AvailabilityZones: 'us-east-1a' },
        { replayingState: true }
      );
      expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty('AvailabilityZones');
      expect(warn.mock.calls.flat().join('\n')).toContain(
        'the replayed AvailabilityZones is not a list of Availability Zone names'
      );
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty('AvailabilityZones');
    });
  });

  describe('update', () => {
    const update = (next: Input, prev: Input, context?: Record<string, unknown>) =>
      provider.update('L', 'c-1', CLUSTER, { ...BASE, ...next }, { ...BASE, ...prev }, context);

    it.each([
      ['changed', { AvailabilityZones: ['us-east-1a'] }, { AvailabilityZones: ZONES }],
      ['added', { AvailabilityZones: ZONES }, {}],
      ['removed', {}, { AvailabilityZones: ZONES }],
    ])('%s zones send no AvailabilityZones member: the live zones are kept', async (_, next, prev) => {
      arm();
      await update(next, prev);
      for (const command of mockSend.mock.calls.map(([c]) => c as { input: Input })) {
        expect(command.input).not.toHaveProperty('AvailabilityZones');
      }
    });

    it.each(['us-east-1a', [''], ['us-east-1a', ' ']])(
      'refuses malformed template zones %j before any call',
      async (value) => {
        arm();
        await expect(
          update({ AvailabilityZones: value }, { AvailabilityZones: ZONES })
        ).rejects.toThrow(/AvailabilityZones must be a list of Availability Zone names/);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it('a rollback replay with a blank zone name records the previous list', async () => {
      arm();
      const result = await update(
        { AvailabilityZones: [''] },
        { AvailabilityZones: ZONES },
        { replayingState: true }
      );
      expect(result.effectiveProperties?.['AvailabilityZones']).toEqual(ZONES);
    });

    it.each([{ replayingState: true }, { desiredFromAwsReadback: true }])(
      'a state-borne malformed list is not refused, and the previous list is recorded (%o)',
      async (context) => {
        arm();
        const result = await update(
          { AvailabilityZones: 'us-east-1a' },
          { AvailabilityZones: ZONES },
          context
        );
        expect(result.effectiveProperties?.['AvailabilityZones']).toEqual(ZONES);
        expect(warn.mock.calls.flat().join('\n')).toContain(
          'the replayed AvailabilityZones is not a list of Availability Zone names'
        );
      }
    );

    it('a state-borne malformed list with no usable previous one records none', async () => {
      arm();
      const result = await update({ AvailabilityZones: 7 }, {}, { replayingState: true });
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty('AvailabilityZones');
    });
  });

  it.each([undefined, {}, { ...BASE, EngineMode: 'provisioned', AvailabilityZones: ZONES }])(
    'drift never compares the keys readCurrentState does not read (bag %o)',
    (bag) => {
      expect(provider.getDriftUnknownPaths(CLUSTER, bag)).toEqual(
        expect.arrayContaining([
          'EngineMode',
          'AvailabilityZones',
          'ClusterScalabilityType',
          'MasterUserAuthenticationType',
        ])
      );
    }
  );

  it('readCurrentState reports neither the engine mode nor the zones', async () => {
    arm({ EngineMode: 'provisioned', AvailabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c'] });
    const state = (await provider.readCurrentState('c-1', 'L', CLUSTER)) as Input;
    expect(state).not.toHaveProperty('EngineMode');
    expect(state).not.toHaveProperty('AvailabilityZones');
  });
});
