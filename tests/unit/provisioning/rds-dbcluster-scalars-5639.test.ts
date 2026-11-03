// go-to-k/cdkd#5639: AWS::RDS::DBCluster `AutoMinorVersionUpgrade`,
// `NetworkType`, the Performance Insights trio and `EnableHttpEndpoint` on the
// SDK route. Create sends each declared value (the trio renamed on the wire);
// an update sends a changed scalar, the whole declared trio when any member of
// it changed, and turns the Data API on or off with EnableHttpEndpoint /
// DisableHttpEndpoint as CloudFormation's update handler does; the readback
// reports each under its CFn name.
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

type Input = Record<string, unknown>;

const CLUSTER = 'AWS::RDS::DBCluster';
const ARN = 'arn:aws:rds:us-east-1:123456789012:cluster:c-1';
const KMS = 'arn:aws:kms:us-east-1:123456789012:key/k1';
const KMS_2 = 'arn:aws:kms:us-east-1:123456789012:key/k2';

/**
 * DescribeDBClusters answers an `available` cluster whose `HttpEndpointEnabled`
 * follows the Enable / Disable calls (starting at `httpEndpoint`), merged with
 * `live`; the create answers the cluster, every other call `{}`.
 */
function arm(options: { httpEndpoint?: boolean; live?: Input; noArn?: boolean } = {}): void {
  let httpEndpoint = options.httpEndpoint ?? false;
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'DescribeDBClustersCommand':
        return Promise.resolve({
          DBClusters: [
            {
              DBClusterIdentifier: 'c-1',
              ...(options.noArn !== true && { DBClusterArn: ARN }),
              Status: 'available',
              DBClusterMembers: [],
              HttpEndpointEnabled: httpEndpoint,
              ...options.live,
            },
          ],
        });
      case 'CreateDBClusterCommand':
        return Promise.resolve({ DBCluster: { DBClusterIdentifier: 'c-1' } });
      case 'EnableHttpEndpointCommand':
        httpEndpoint = true;
        return Promise.resolve({});
      case 'DisableHttpEndpointCommand':
        httpEndpoint = false;
        return Promise.resolve({});
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

const SCALARS = [
  'AutoMinorVersionUpgrade',
  'NetworkType',
  'PerformanceInsightsEnabled',
  'PerformanceInsightsKmsKeyId',
  'PerformanceInsightsRetentionPeriod',
  'EnableHttpEndpoint',
];

describe('RDSProvider AWS::RDS::DBCluster scalars (go-to-k/cdkd#5639)', () => {
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

  const update = (next: Input, prev: Input, context?: Record<string, unknown>) =>
    provider.update('L', 'c-1', CLUSTER, { ...BASE, ...next }, { ...BASE, ...prev }, context);
  const modify = (): Input => {
    const calls = sent('ModifyDBClusterCommand');
    expect(calls).toHaveLength(1);
    return calls[0]!;
  };

  it.each(SCALARS)('%s is a handled property, so a template declaring it keeps the SDK route', (key) => {
    expect(provider.handledProperties.get(CLUSTER)?.has(key)).toBe(true);
  });

  describe('create', () => {
    it('sends every declared value, the Performance Insights trio under its SDK names', async () => {
      arm();
      await provider.create('L', CLUSTER, {
        ...BASE,
        AutoMinorVersionUpgrade: false,
        NetworkType: 'DUAL',
        PerformanceInsightsEnabled: true,
        PerformanceInsightsKmsKeyId: KMS,
        PerformanceInsightsRetentionPeriod: '465',
        EnableHttpEndpoint: true,
      });
      expect(sent('CreateDBClusterCommand')[0]).toMatchObject({
        AutoMinorVersionUpgrade: false,
        NetworkType: 'DUAL',
        EnablePerformanceInsights: true,
        PerformanceInsightsKMSKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 465,
        EnableHttpEndpoint: true,
      });
      // CreateDBCluster carries the Data API flag: no separate call.
      expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
    });

    it('sends none of them when the template declares none', async () => {
      arm();
      await provider.create('L', CLUSTER, { ...BASE });
      const input = sent('CreateDBClusterCommand')[0]!;
      for (const member of [
        'AutoMinorVersionUpgrade',
        'NetworkType',
        'EnablePerformanceInsights',
        'PerformanceInsightsKMSKeyId',
        'PerformanceInsightsRetentionPeriod',
        'EnableHttpEndpoint',
      ]) {
        expect(input).not.toHaveProperty(member);
      }
    });

    it('refuses a malformed flag before any call', async () => {
      arm();
      await expect(
        provider.create('L', CLUSTER, { ...BASE, EnableHttpEndpoint: 'TRUE' })
      ).rejects.toThrow(/EnableHttpEndpoint must be true or false/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('sends the CFn string spelling as a boolean', async () => {
      arm();
      await provider.create('L', CLUSTER, { ...BASE, EnableHttpEndpoint: 'true' });
      expect(sent('CreateDBClusterCommand')[0]!['EnableHttpEndpoint']).toBe(true);
    });

    it('a rollback re-create leaves a malformed flag out, warns, and records no flag', async () => {
      arm();
      const result = await provider.create(
        'L',
        CLUSTER,
        { ...BASE, EnableHttpEndpoint: 'TRUE' },
        { replayingState: true }
      );
      expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty('EnableHttpEndpoint');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/created with the Data API off/));
      expect(result.effectiveProperties).toEqual(BASE);
    });

    it('records no effectiveProperties for a usable flag', async () => {
      arm();
      const result = await provider.create('L', CLUSTER, { ...BASE, EnableHttpEndpoint: true });
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('sends a declared false (no truthiness gate)', async () => {
      arm();
      await provider.create('L', CLUSTER, {
        ...BASE,
        PerformanceInsightsEnabled: false,
        EnableHttpEndpoint: false,
      });
      expect(sent('CreateDBClusterCommand')[0]).toMatchObject({
        EnablePerformanceInsights: false,
        EnableHttpEndpoint: false,
      });
    });
  });

  describe('update: ModifyDBCluster scalars', () => {
    it('sends a changed AutoMinorVersionUpgrade and NetworkType', async () => {
      arm();
      await update(
        { AutoMinorVersionUpgrade: false, NetworkType: 'DUAL' },
        { AutoMinorVersionUpgrade: true, NetworkType: 'IPV4' }
      );
      expect(modify()).toMatchObject({ AutoMinorVersionUpgrade: false, NetworkType: 'DUAL' });
    });

    it('sends an unchanged one nothing', async () => {
      arm();
      await update(
        { AutoMinorVersionUpgrade: false, NetworkType: 'DUAL' },
        { AutoMinorVersionUpgrade: false, NetworkType: 'DUAL' }
      );
      expect(modify()).not.toHaveProperty('AutoMinorVersionUpgrade');
      expect(modify()).not.toHaveProperty('NetworkType');
    });

    it('sends nothing for a removed one, so RDS keeps the live value', async () => {
      arm();
      await update({}, { AutoMinorVersionUpgrade: false, NetworkType: 'DUAL' });
      expect(modify()).not.toHaveProperty('AutoMinorVersionUpgrade');
      expect(modify()).not.toHaveProperty('NetworkType');
    });

    it('sends the whole declared Performance Insights trio when only the retention changed', async () => {
      arm();
      const trio = { PerformanceInsightsEnabled: true, PerformanceInsightsKmsKeyId: KMS };
      await update(
        { ...trio, PerformanceInsightsRetentionPeriod: 731 },
        { ...trio, PerformanceInsightsRetentionPeriod: 7 }
      );
      expect(modify()).toMatchObject({
        EnablePerformanceInsights: true,
        PerformanceInsightsKMSKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 731,
      });
    });

    it.each([
      ['the flag', { PerformanceInsightsEnabled: false }, { PerformanceInsightsEnabled: true }],
      [
        'the key',
        { PerformanceInsightsEnabled: true, PerformanceInsightsKmsKeyId: KMS_2 },
        { PerformanceInsightsEnabled: true, PerformanceInsightsKmsKeyId: KMS },
      ],
    ])('sends the declared trio when %s changed', async (_label, next, prev) => {
      arm();
      await update(next, prev);
      const input = modify();
      expect(input['EnablePerformanceInsights']).toBe(next.PerformanceInsightsEnabled);
      if ('PerformanceInsightsKmsKeyId' in next) {
        expect(input['PerformanceInsightsKMSKeyId']).toBe(next.PerformanceInsightsKmsKeyId);
      }
    });

    it('sends no Performance Insights member when the trio is unchanged or removed', async () => {
      arm();
      const trio = {
        PerformanceInsightsEnabled: true,
        PerformanceInsightsKmsKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 7,
      };
      await update(trio, trio);
      await update({}, trio);
      for (const input of sent('ModifyDBClusterCommand')) {
        expect(input).not.toHaveProperty('EnablePerformanceInsights');
        expect(input).not.toHaveProperty('PerformanceInsightsKMSKeyId');
        expect(input).not.toHaveProperty('PerformanceInsightsRetentionPeriod');
      }
    });

    it('defers to changedProperties for a recorded stand-in', async () => {
      arm();
      await update(
        { NetworkType: 'DUAL' },
        { NetworkType: 'IPV4' },
        { changedProperties: new Set<string>() }
      );
      expect(modify()).not.toHaveProperty('NetworkType');
    });
  });

  describe('update: EnableHttpEndpoint', () => {
    it('turns the Data API on with EnableHttpEndpoint on the cluster ARN, then waits for it', async () => {
      arm({ httpEndpoint: false });
      await update({ EnableHttpEndpoint: true }, { EnableHttpEndpoint: false });
      expect(sent('EnableHttpEndpointCommand')).toEqual([{ ResourceArn: ARN }]);
      expect(sent('DisableHttpEndpointCommand')).toHaveLength(0);
      // ModifyDBCluster's own member is Serverless v1 only: never sent.
      expect(modify()).not.toHaveProperty('EnableHttpEndpoint');
    });

    it('turns it off with DisableHttpEndpoint when the template now declares false', async () => {
      arm({ httpEndpoint: true });
      await update({ EnableHttpEndpoint: false }, { EnableHttpEndpoint: true });
      expect(sent('DisableHttpEndpointCommand')).toEqual([{ ResourceArn: ARN }]);
      expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
    });

    it('turns it off when a declared true is removed, as CloudFormation does', async () => {
      arm({ httpEndpoint: true });
      await update({}, { EnableHttpEndpoint: true });
      expect(sent('DisableHttpEndpointCommand')).toEqual([{ ResourceArn: ARN }]);
    });

    it('turns it on when true is added', async () => {
      arm({ httpEndpoint: false });
      await update({ EnableHttpEndpoint: 'true' }, {});
      expect(sent('EnableHttpEndpointCommand')).toEqual([{ ResourceArn: ARN }]);
    });

    it('makes no call for an unchanged flag, its string spelling included', async () => {
      arm({ httpEndpoint: true });
      await update({ EnableHttpEndpoint: 'true' }, { EnableHttpEndpoint: true });
      await update({}, {});
      expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
      expect(sent('DisableHttpEndpointCommand')).toHaveLength(0);
    });

    it.each(['mysql', 'postgres'])(
      'makes no call on a %s Multi-AZ DB cluster, as CloudFormation does',
      async (engine) => {
        arm({ httpEndpoint: false });
        await update(
          { Engine: engine, EnableHttpEndpoint: true },
          { Engine: engine, EnableHttpEndpoint: false }
        );
        expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
      }
    );

    it('waits for the cluster to report the new setting', async () => {
      // The cluster reports the old setting until the second read after the call.
      let reads = 0;
      let enabled = false;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        switch (command.constructor.name) {
          case 'DescribeDBClustersCommand':
            reads += 1;
            return Promise.resolve({
              DBClusters: [
                {
                  DBClusterIdentifier: 'c-1',
                  DBClusterArn: ARN,
                  Status: 'available',
                  DBClusterMembers: [],
                  HttpEndpointEnabled: enabled && reads > 3,
                },
              ],
            });
          case 'EnableHttpEndpointCommand':
            enabled = true;
            return Promise.resolve({});
          default:
            return Promise.resolve({});
        }
      });
      await update({ EnableHttpEndpoint: true }, { EnableHttpEndpoint: false });
      expect(sleeps).toBeGreaterThan(0);
    });

    it('does not wait under --no-wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      // The cluster never reports the setting: a wait would exhaust the budget.
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        Promise.resolve(
          command.constructor.name === 'DescribeDBClustersCommand'
            ? {
                DBClusters: [
                  {
                    DBClusterIdentifier: 'c-1',
                    DBClusterArn: ARN,
                    Status: 'available',
                    HttpEndpointEnabled: false,
                  },
                ],
              }
            : {}
        )
      );
      await update({ EnableHttpEndpoint: true }, { EnableHttpEndpoint: false });
      expect(sent('EnableHttpEndpointCommand')).toHaveLength(1);
      expect(sleeps).toBe(0);
    });

    it('fails when the cluster ARN is not reported, before any Data API call', async () => {
      arm({ noArn: true });
      await expect(update({ EnableHttpEndpoint: true }, {})).rejects.toThrow(
        /did not report the cluster ARN, which EnableHttpEndpoint needs/
      );
      expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
    });

    it('refuses a malformed template flag before any call', async () => {
      arm();
      await expect(update({ EnableHttpEndpoint: 'yes' }, { EnableHttpEndpoint: true })).rejects.toThrow(
        /EnableHttpEndpoint must be true or false/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([{ replayingState: true }, { desiredFromAwsReadback: true }])(
      'skips a malformed flag with a warning on %o',
      async (context) => {
        arm({ httpEndpoint: true });
        await update({ EnableHttpEndpoint: 'yes' }, { EnableHttpEndpoint: true }, context);
        expect(sent('DisableHttpEndpointCommand')).toHaveLength(0);
        expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Data API setting is left as it is/));
      }
    );

    it.each([false, true])(
      'waits for the cluster to be available before the Data API call (--no-wait %s)',
      async (noWait) => {
        if (noWait) process.env['CDKD_NO_WAIT'] = 'true';
        // The cluster reads `modifying` (from the same update's ModifyDBCluster)
        // for the first three reads, then `available`.
        let reads = 0;
        let readsAtCall = -1;
        let enabled = false;
        mockSend.mockImplementation((command: { constructor: { name: string } }) => {
          switch (command.constructor.name) {
            case 'DescribeDBClustersCommand':
              reads += 1;
              return Promise.resolve({
                DBClusters: [
                  {
                    DBClusterIdentifier: 'c-1',
                    DBClusterArn: ARN,
                    Status: reads <= 3 ? 'modifying' : 'available',
                    DBClusterMembers: [],
                    HttpEndpointEnabled: enabled,
                  },
                ],
              });
            case 'EnableHttpEndpointCommand':
              readsAtCall = reads;
              enabled = true;
              return Promise.resolve({});
            default:
              return Promise.resolve({});
          }
        });
        await update({ EnableHttpEndpoint: true }, { EnableHttpEndpoint: false });
        expect(readsAtCall).toBeGreaterThan(3);
      }
    );

    it('treats a HttpEndpointEnabled the cluster does not report as off', async () => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        Promise.resolve(
          command.constructor.name === 'DescribeDBClustersCommand'
            ? {
                DBClusters: [{ DBClusterIdentifier: 'c-1', DBClusterArn: ARN, Status: 'available' }],
              }
            : {}
        )
      );
      await update({ EnableHttpEndpoint: false }, { EnableHttpEndpoint: true });
      expect(sent('DisableHttpEndpointCommand')).toHaveLength(1);
      expect(sleeps).toBe(0);
    });

    it.each([
      ['a usable previous value', { EnableHttpEndpoint: true }, { EnableHttpEndpoint: true }],
      ['no previous value', {}, {}],
      ['an unusable previous value', { EnableHttpEndpoint: 'no' }, {}],
    ])('a skipped flag records %s', async (_label, prev, kept) => {
      arm({ httpEndpoint: true });
      const result = await update({ EnableHttpEndpoint: 'yes' }, prev, { replayingState: true });
      expect(result.effectiveProperties).toEqual({ ...BASE, ...kept });
    });

    it('records no effectiveProperties when nothing was skipped', async () => {
      arm({ httpEndpoint: false });
      const result = await update({ EnableHttpEndpoint: true }, {});
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('refuses a malformed template flag on a Multi-AZ DB cluster too, as create does', async () => {
      arm();
      await expect(
        update({ Engine: 'mysql', EnableHttpEndpoint: 'yes' }, { Engine: 'mysql' })
      ).rejects.toThrow(/EnableHttpEndpoint must be true or false/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each(['InvalidResourceStateFault', 'InvalidDBClusterStateFault'])(
      'resends the Data API call refused as busy (%s) once the cluster is available again',
      async (fault) => {
        arm({ httpEndpoint: false });
        const base = mockSend.getMockImplementation()!;
        let refusals = 0;
        mockSend.mockImplementation((command: { constructor: { name: string } }) => {
          if (command.constructor.name === 'EnableHttpEndpointCommand' && refusals < 2) {
            refusals += 1;
            return Promise.reject(Object.assign(new Error('busy'), { name: fault }));
          }
          return base(command);
        });
        await update({ EnableHttpEndpoint: true }, { EnableHttpEndpoint: false });
        expect(sent('EnableHttpEndpointCommand')).toHaveLength(3);
      }
    );

    it('gives up after a bounded number of busy refusals', async () => {
      arm({ httpEndpoint: false });
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'EnableHttpEndpointCommand'
          ? Promise.reject(Object.assign(new Error('busy'), { name: 'InvalidResourceStateFault' }))
          : base(command)
      );
      await expect(
        update({ EnableHttpEndpoint: true }, { EnableHttpEndpoint: false })
      ).rejects.toThrow(/busy/);
      expect(sent('EnableHttpEndpointCommand')).toHaveLength(8);
    });

    it('does not resend on any other failure', async () => {
      arm({ httpEndpoint: false });
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'EnableHttpEndpointCommand'
          ? Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }))
          : base(command)
      );
      await expect(
        update({ EnableHttpEndpoint: true }, { EnableHttpEndpoint: false })
      ).rejects.toThrow(/denied/);
      expect(sent('EnableHttpEndpointCommand')).toHaveLength(1);
    });

    it('a drift revert with no template side never turns the Data API on: it warns and records the live setting', async () => {
      arm({ httpEndpoint: false });
      const result = await update(
        { EnableHttpEndpoint: true },
        { EnableHttpEndpoint: false },
        { desiredFromAwsReadback: true }
      );
      expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/does not turn the Data API \(EnableHttpEndpoint\) back on/)
      );
      expect(result.effectiveProperties).toEqual({ ...BASE, EnableHttpEndpoint: false });
    });

    // go-to-k/cdkd#5707: the template's declaration, not the readback
    // baseline, decides whether a revert may turn the Data API on.
    it('a drift revert turns the Data API back on when the template declares it', async () => {
      arm({ httpEndpoint: false });
      const result = await update(
        { EnableHttpEndpoint: true },
        { EnableHttpEndpoint: false },
        {
          desiredFromAwsReadback: true,
          declaredTrueProperties: new Set(['EnableHttpEndpoint']),
        }
      );
      expect(sent('EnableHttpEndpointCommand')).toEqual([{ ResourceArn: ARN }]);
      expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/Data API/));
      expect(result.effectiveProperties).toBeUndefined();
    });

    it.each([
      ['declares nothing true', new Set<string>()],
      ['declares only other flags true', new Set(['AutoMinorVersionUpgrade', 'EnableHttpEndpointX'])],
    ])(
      'a drift revert keeps it withheld when the template side %s',
      async (_label, declaredTrueProperties) => {
        arm({ httpEndpoint: false });
        const result = await update(
          { EnableHttpEndpoint: true },
          { EnableHttpEndpoint: false },
          { desiredFromAwsReadback: true, declaredTrueProperties }
        );
        expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/does not declare EnableHttpEndpoint: true/)
        );
        expect(result.effectiveProperties).toEqual({ ...BASE, EnableHttpEndpoint: false });
      }
    );

    it('a template declaring true does not turn it on when the baseline holds false', async () => {
      arm({ httpEndpoint: false });
      await update(
        { EnableHttpEndpoint: false },
        { EnableHttpEndpoint: false },
        {
          desiredFromAwsReadback: true,
          declaredTrueProperties: new Set(['EnableHttpEndpoint']),
        }
      );
      expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
      expect(sent('DisableHttpEndpointCommand')).toHaveLength(0);
    });

    it('a template declaring true still lets a revert turn it off', async () => {
      arm({ httpEndpoint: true });
      await update(
        { EnableHttpEndpoint: false },
        { EnableHttpEndpoint: true },
        {
          desiredFromAwsReadback: true,
          declaredTrueProperties: new Set(['EnableHttpEndpoint']),
        }
      );
      expect(sent('DisableHttpEndpointCommand')).toEqual([{ ResourceArn: ARN }]);
    });

    it('a drift revert still turns the Data API off', async () => {
      arm({ httpEndpoint: true });
      const result = await update(
        { EnableHttpEndpoint: false },
        { EnableHttpEndpoint: true },
        { desiredFromAwsReadback: true }
      );
      expect(sent('DisableHttpEndpointCommand')).toEqual([{ ResourceArn: ARN }]);
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('a rollback replay may turn it back on (the record is a template)', async () => {
      arm({ httpEndpoint: false });
      await update({ EnableHttpEndpoint: true }, { EnableHttpEndpoint: false }, { replayingState: true });
      expect(sent('EnableHttpEndpointCommand')).toEqual([{ ResourceArn: ARN }]);
    });

    it('reads a malformed recorded flag as absent', async () => {
      arm({ httpEndpoint: false });
      await update({ EnableHttpEndpoint: true }, { EnableHttpEndpoint: 'yes' });
      expect(sent('EnableHttpEndpointCommand')).toEqual([{ ResourceArn: ARN }]);
    });
  });

  describe('PerformanceInsightsRetentionPeriod validation', () => {
    it('sends a numeric string as a number', async () => {
      arm();
      await provider.create('L', CLUSTER, { ...BASE, PerformanceInsightsRetentionPeriod: '31' });
      expect(sent('CreateDBClusterCommand')[0]!['PerformanceInsightsRetentionPeriod']).toBe(31);
    });

    it.each(['seven', 7.5, -1, true])('refuses %o on create before any call', async (value) => {
      arm();
      await expect(
        provider.create('L', CLUSTER, { ...BASE, PerformanceInsightsRetentionPeriod: value })
      ).rejects.toThrow(/PerformanceInsightsRetentionPeriod must be a whole number of days/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a rollback re-create leaves a malformed one out, warns, and records none', async () => {
      arm();
      const result = await provider.create(
        'L',
        CLUSTER,
        { ...BASE, PerformanceInsightsEnabled: true, PerformanceInsightsRetentionPeriod: 'x' },
        { replayingState: true }
      );
      expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty(
        'PerformanceInsightsRetentionPeriod'
      );
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/AWS's default retention/));
      expect(result.effectiveProperties).toEqual({ ...BASE, PerformanceInsightsEnabled: true });
    });

    it('refuses a malformed one on a template update before any call', async () => {
      arm();
      await expect(
        update(
          { PerformanceInsightsRetentionPeriod: 'x' },
          { PerformanceInsightsRetentionPeriod: 7 }
        )
      ).rejects.toThrow(/PerformanceInsightsRetentionPeriod must be a whole number of days/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([{ replayingState: true }, { desiredFromAwsReadback: true }])(
      'skips a malformed one on %o, sends no NaN and records the previous value',
      async (context) => {
        arm();
        const result = await update(
          { PerformanceInsightsEnabled: true, PerformanceInsightsRetentionPeriod: 'x' },
          { PerformanceInsightsEnabled: false, PerformanceInsightsRetentionPeriod: 7 },
          context
        );
        expect(modify()).not.toHaveProperty('PerformanceInsightsRetentionPeriod');
        expect(modify()['EnablePerformanceInsights']).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/retention period is left/));
        expect(result.effectiveProperties).toEqual({
          ...BASE,
          PerformanceInsightsEnabled: true,
          PerformanceInsightsRetentionPeriod: 7,
        });
      }
    );
  });

  describe('drift canonicalization', () => {
    it('folds the CFn string spellings to the readback types', () => {
      expect(
        provider.canonicalizeDriftProperties(CLUSTER, {
          AutoMinorVersionUpgrade: 'false',
          PerformanceInsightsEnabled: 'true',
          EnableHttpEndpoint: 'true',
          PerformanceInsightsRetentionPeriod: '465',
          NetworkType: 'IPV4',
        })
      ).toEqual({
        AutoMinorVersionUpgrade: false,
        PerformanceInsightsEnabled: true,
        EnableHttpEndpoint: true,
        PerformanceInsightsRetentionPeriod: 465,
        NetworkType: 'IPV4',
      });
    });

    it('returns an unaffected bag, or another type, by identity', () => {
      const bag = { EnableHttpEndpoint: true, PerformanceInsightsRetentionPeriod: 'x' };
      expect(provider.canonicalizeDriftProperties(CLUSTER, bag)).toBe(bag);
      const str = { EnableHttpEndpoint: 'true' };
      expect(provider.canonicalizeDriftProperties('AWS::RDS::DBInstance', str)).toBe(str);
    });

  });

  describe('readCurrentState', () => {
    it('reports each under its CFn name', async () => {
      arm({
        httpEndpoint: true,
        live: {
          AutoMinorVersionUpgrade: false,
          NetworkType: 'DUAL',
          PerformanceInsightsEnabled: true,
          PerformanceInsightsKMSKeyId: KMS,
          PerformanceInsightsRetentionPeriod: 465,
        },
      });
      const state = (await provider.readCurrentState('c-1', 'L', CLUSTER)) as Input;
      expect(state).toMatchObject({
        AutoMinorVersionUpgrade: false,
        NetworkType: 'DUAL',
        PerformanceInsightsEnabled: true,
        PerformanceInsightsKmsKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 465,
        EnableHttpEndpoint: true,
      });
      expect(state).not.toHaveProperty('PerformanceInsightsKMSKeyId');
      expect(state).not.toHaveProperty('HttpEndpointEnabled');
    });

    it('omits what the cluster does not report', async () => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        Promise.resolve(
          command.constructor.name === 'DescribeDBClustersCommand'
            ? { DBClusters: [{ DBClusterIdentifier: 'c-1', DBClusterArn: ARN }] }
            : { TagList: [] }
        )
      );
      const state = (await provider.readCurrentState('c-1', 'L', CLUSTER)) as Input;
      for (const key of SCALARS) expect(state).not.toHaveProperty(key);
    });
  });
});
