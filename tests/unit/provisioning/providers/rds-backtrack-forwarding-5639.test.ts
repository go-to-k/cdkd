// go-to-k/cdkd#5639: AWS::RDS::DBCluster `BacktrackWindow`,
// `EnableLocalWriteForwarding` and `ClusterScalabilityType` on the SDK route.
// Create sends each declared value; an update sends a changed backtrack window
// and decides write forwarding as CloudFormation's update translation does
// (`Translator.modifyDbClusterRequest`: a removed `true` sends `false`), then
// waits for the forwarding status to settle on the value sent
// (`BaseHandlerStd.isLocalWriteForwardingStabilized`); the readback reports
// the window and the projected flag, never the write-only scalability type.
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

vi.mock('../../../../src/utils/logger.js', () => {
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

import { RDSProvider } from '../../../../src/provisioning/providers/rds-provider.js';

type Input = Record<string, unknown>;

const CLUSTER = 'AWS::RDS::DBCluster';
const ARN = 'arn:aws:rds:us-east-1:123456789012:cluster:c-1';

/**
 * DescribeDBClusters answers an `available` cluster merged with `live`. Its
 * `LocalWriteForwardingStatus` is read off `statuses` one describe at a time
 * (the last one repeating), and otherwise follows what the last Create /
 * ModifyDBCluster sent; every other call answers `{}`.
 */
function arm(options: { live?: Input; statuses?: string[]; windows?: number[] } = {}): void {
  const statuses = [...(options.statuses ?? [])];
  const windows = [...(options.windows ?? [])];
  let forwarding: string | undefined;
  const follow = (input: Input): void => {
    const sentFlag = input['EnableLocalWriteForwarding'];
    if (typeof sentFlag === 'boolean') forwarding = sentFlag ? 'enabled' : 'disabled';
  };
  mockSend.mockImplementation(
    (command: { constructor: { name: string }; input: Input }) => {
      switch (command.constructor.name) {
        case 'DescribeDBClustersCommand': {
          const status = statuses.length > 1 ? statuses.shift() : (statuses[0] ?? forwarding);
          const window = windows.length > 1 ? windows.shift() : windows[0];
          return Promise.resolve({
            DBClusters: [
              {
                DBClusterIdentifier: 'c-1',
                DBClusterArn: ARN,
                Status: 'available',
                DBClusterMembers: [],
                ...(status !== undefined && { LocalWriteForwardingStatus: status }),
                ...(window !== undefined && { BacktrackWindow: window }),
                ...options.live,
              },
            ],
          });
        }
        case 'CreateDBClusterCommand':
          follow(command.input);
          return Promise.resolve({ DBCluster: { DBClusterIdentifier: 'c-1' } });
        case 'ModifyDBClusterCommand':
          follow(command.input);
          return Promise.resolve({});
        case 'ListTagsForResourceCommand':
          return Promise.resolve({ TagList: [] });
        default:
          return Promise.resolve({});
      }
    }
  );
}

function sent(name: string): Input[] {
  return mockSend.mock.calls
    .map(([command]) => command as { constructor: { name: string }; input: Input })
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}

const describes = (): number => sent('DescribeDBClustersCommand').length;

const BASE: Input = {
  DBClusterIdentifier: 'c-1',
  Engine: 'aurora-mysql',
  MasterUsername: 'admin',
};

describe('RDSProvider AWS::RDS::DBCluster backtracking, write forwarding, scalability type (go-to-k/cdkd#5639)', () => {
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

  it.each(['BacktrackWindow', 'EnableLocalWriteForwarding', 'ClusterScalabilityType'])(
    '%s is a handled property, so a template declaring it keeps the SDK route',
    (key) => {
      expect(provider.handledProperties.get(CLUSTER)?.has(key)).toBe(true);
    }
  );

  describe('create', () => {
    it('sends each declared value, the CFn string spellings as a number and a boolean', async () => {
      arm();
      await provider.create('L', CLUSTER, {
        ...BASE,
        BacktrackWindow: '3600',
        EnableLocalWriteForwarding: 'true',
        ClusterScalabilityType: 'standard',
      });
      expect(sent('CreateDBClusterCommand')[0]).toMatchObject({
        BacktrackWindow: 3600,
        EnableLocalWriteForwarding: true,
        ClusterScalabilityType: 'standard',
      });
      // Nothing is left for a follow-up ModifyDBCluster.
      expect(sent('ModifyDBClusterCommand')).toHaveLength(0);
    });

    it('sends none of them when the template declares none', async () => {
      arm();
      await provider.create('L', CLUSTER, { ...BASE });
      const input = sent('CreateDBClusterCommand')[0]!;
      for (const member of [
        'BacktrackWindow',
        'EnableLocalWriteForwarding',
        'ClusterScalabilityType',
      ]) {
        expect(input).not.toHaveProperty(member);
      }
    });

    it('sends a declared 0 window and a declared false flag', async () => {
      arm();
      await provider.create('L', CLUSTER, {
        ...BASE,
        BacktrackWindow: 0,
        EnableLocalWriteForwarding: false,
      });
      expect(sent('CreateDBClusterCommand')[0]).toMatchObject({
        BacktrackWindow: 0,
        EnableLocalWriteForwarding: false,
      });
    });

    it('waits while write forwarding is still enabling', async () => {
      arm({ statuses: ['enabling', 'enabling', 'enabled'] });
      await provider.create('L', CLUSTER, { ...BASE, EnableLocalWriteForwarding: true });
      expect(sleeps).toBeGreaterThan(0);
    });

    it('does not wait for write forwarding under CDKD_NO_WAIT', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm({ statuses: ['enabling'] });
      await provider.create('L', CLUSTER, { ...BASE, EnableLocalWriteForwarding: true });
      expect(sleeps).toBe(0);
    });

    it.each([
      ['BacktrackWindow', '1h', /BacktrackWindow must be a whole number of seconds/],
      ['EnableLocalWriteForwarding', 'yes', /EnableLocalWriteForwarding must be true or false/],
    ])('refuses a malformed %s before any call', async (key, value, message) => {
      arm();
      await expect(provider.create('L', CLUSTER, { ...BASE, [key]: value })).rejects.toThrow(
        message
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['BacktrackWindow', -1],
      ['EnableLocalWriteForwarding', 'yes'],
    ])(
      'a rollback re-create leaves a malformed %s out, warns, and records none',
      async (key, value) => {
        arm();
        const result = await provider.create(
          'L',
          CLUSTER,
          { ...BASE, [key]: value },
          { replayingState: true }
        );
        expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty(key);
        expect(warn.mock.calls.flat().join('\n')).toContain(`the replayed ${key} is not`);
        expect(result.effectiveProperties).toBeDefined();
        expect(result.effectiveProperties).not.toHaveProperty(key);
      }
    );
  });

  describe('update: BacktrackWindow', () => {
    it('sends a changed window', async () => {
      arm();
      await update({ BacktrackWindow: 7200 }, { BacktrackWindow: 3600 });
      expect(modify()['BacktrackWindow']).toBe(7200);
    });

    it('sends an added window, which RDS accepts only on a cluster created with backtracking', async () => {
      arm();
      await update({ BacktrackWindow: 3600 }, {});
      expect(modify()['BacktrackWindow']).toBe(3600);
    });

    it('does not re-send an unchanged window, its string spelling included', async () => {
      arm();
      await update({ BacktrackWindow: '3600' }, { BacktrackWindow: 3600 });
      expect(modify()).not.toHaveProperty('BacktrackWindow');
    });

    it('a removal sends nothing and RDS keeps the live window', async () => {
      arm();
      await update({}, { BacktrackWindow: 3600 });
      expect(modify()).not.toHaveProperty('BacktrackWindow');
    });

    it('waits until the cluster reports the window sent', async () => {
      // RDS applies the window after ModifyDBCluster returns.
      arm({ windows: [3600, 3600, 7200] });
      await update({ BacktrackWindow: 7200 }, { BacktrackWindow: 3600 });
      expect(modify()['BacktrackWindow']).toBe(7200);
      expect(sleeps).toBe(2);
    });

    it('ends the wait when DescribeDBClusters reports no window', async () => {
      arm();
      await update({ BacktrackWindow: 7200 }, { BacktrackWindow: 3600 });
      expect(sleeps).toBe(0);
    });

    it('adds no window wait when no window is sent, or under CDKD_NO_WAIT', async () => {
      arm({ windows: [3600] });
      await update({}, { BacktrackWindow: 3600 });
      expect(sleeps).toBe(0);
      mockSend.mockClear();
      process.env['CDKD_NO_WAIT'] = 'true';
      await update({ BacktrackWindow: 7200 }, { BacktrackWindow: 3600 });
      expect(sleeps).toBe(0);
    });

    it('refuses a malformed template window before any call', async () => {
      arm();
      await expect(update({ BacktrackWindow: '1.5' }, { BacktrackWindow: 3600 })).rejects.toThrow(
        /BacktrackWindow must be a whole number of seconds/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([{ replayingState: true }, { desiredFromAwsReadback: true }])(
      'a state-borne malformed window is skipped and the previous one recorded (%o)',
      async (context) => {
        arm();
        const result = await update(
          { BacktrackWindow: 'x' },
          { BacktrackWindow: 3600 },
          context
        );
        expect(modify()).not.toHaveProperty('BacktrackWindow');
        expect(result.effectiveProperties?.['BacktrackWindow']).toBe(3600);
        expect(warn.mock.calls.flat().join('\n')).toContain(
          'the replayed BacktrackWindow is not a whole number of seconds'
        );
      }
    );
  });

  describe('update: EnableLocalWriteForwarding', () => {
    // [previous, desired, sent] — CloudFormation's Translator.modifyDbClusterRequest.
    it.each([
      [true, undefined, false],
      ['true', undefined, false],
      [undefined, false, undefined],
      [undefined, true, true],
      [true, false, false],
      [false, true, true],
      [true, true, undefined],
      [true, 'true', undefined],
      [false, undefined, undefined],
      [undefined, undefined, undefined],
    ])('previous %s, desired %s sends %s', async (previous, desired, expected) => {
      arm();
      await update(
        desired === undefined ? {} : { EnableLocalWriteForwarding: desired },
        previous === undefined ? {} : { EnableLocalWriteForwarding: previous }
      );
      if (expected === undefined) {
        expect(modify()).not.toHaveProperty('EnableLocalWriteForwarding');
      } else {
        expect(modify()['EnableLocalWriteForwarding']).toBe(expected);
      }
    });

    it('a malformed previous value reads as absent: a removal then sends nothing', async () => {
      arm();
      await update({}, { EnableLocalWriteForwarding: 'maybe' });
      expect(modify()).not.toHaveProperty('EnableLocalWriteForwarding');
    });

    it('waits for the status to settle on the value sent, past a stale first read', async () => {
      // The first describe still reads the old setting, then the transition.
      arm({ statuses: ['enabled', 'disabling', 'disabled'] });
      await update({}, { EnableLocalWriteForwarding: true });
      expect(modify()['EnableLocalWriteForwarding']).toBe(false);
      expect(sleeps).toBe(2);
    });

    it('treats requested as on', async () => {
      arm({ statuses: ['enabling', 'requested'] });
      await update({ EnableLocalWriteForwarding: true }, {});
      expect(sleeps).toBe(1);
    });

    it('does not wait when DescribeDBClusters never reports a forwarding status', async () => {
      arm();
      // Answer every describe without LocalWriteForwardingStatus.
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        const out = (await base(command)) as { DBClusters?: Array<Record<string, unknown>> };
        for (const c of out.DBClusters ?? []) delete c['LocalWriteForwardingStatus'];
        return out;
      });
      await update({ EnableLocalWriteForwarding: true }, {});
      expect(modify()['EnableLocalWriteForwarding']).toBe(true);
      expect(sleeps).toBe(0);
    });

    it('adds no wait when nothing about write forwarding is sent', async () => {
      arm({ statuses: ['enabling'] });
      await update({ AutoMinorVersionUpgrade: true }, { AutoMinorVersionUpgrade: false });
      expect(sleeps).toBe(0);
      expect(describes()).toBe(1);
    });

    it('does not wait under CDKD_NO_WAIT', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm({ statuses: ['enabling'] });
      await update({ EnableLocalWriteForwarding: true }, {});
      expect(sleeps).toBe(0);
    });

    it('refuses a malformed template flag before any call', async () => {
      arm();
      await expect(update({ EnableLocalWriteForwarding: 'on' }, {})).rejects.toThrow(
        /EnableLocalWriteForwarding must be true or false/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a rollback replay skips a malformed flag and records the previous one', async () => {
      arm();
      const result = await update(
        { EnableLocalWriteForwarding: 'on' },
        { EnableLocalWriteForwarding: true },
        { replayingState: true }
      );
      expect(modify()).not.toHaveProperty('EnableLocalWriteForwarding');
      expect(result.effectiveProperties?.['EnableLocalWriteForwarding']).toBe(true);
    });

    it('a drift revert does not turn forwarding on when the template never declared it', async () => {
      arm();
      const result = await update(
        { EnableLocalWriteForwarding: true },
        { EnableLocalWriteForwarding: false },
        { desiredFromAwsReadback: true, declaredTrueProperties: new Set<string>() }
      );
      expect(modify()).not.toHaveProperty('EnableLocalWriteForwarding');
      expect(result.effectiveProperties?.['EnableLocalWriteForwarding']).toBe(false);
      expect(warn.mock.calls.flat().join('\n')).toContain(
        'drift --revert does not turn local write forwarding (EnableLocalWriteForwarding) back on'
      );
      expect(sleeps).toBe(0);
    });

    it('a drift revert turns forwarding on when the template declares it', async () => {
      arm();
      await update(
        { EnableLocalWriteForwarding: true },
        { EnableLocalWriteForwarding: false },
        {
          desiredFromAwsReadback: true,
          declaredTrueProperties: new Set(['EnableLocalWriteForwarding']),
        }
      );
      expect(modify()['EnableLocalWriteForwarding']).toBe(true);
    });

    it('a drift revert still turns undeclared forwarding off', async () => {
      arm();
      await update(
        { EnableLocalWriteForwarding: false },
        { EnableLocalWriteForwarding: true },
        { desiredFromAwsReadback: true, declaredTrueProperties: new Set<string>() }
      );
      expect(modify()['EnableLocalWriteForwarding']).toBe(false);
    });

    it('a rollback replay with no usable previous flag records none', async () => {
      arm();
      const result = await update(
        { EnableLocalWriteForwarding: 'on' },
        {},
        { replayingState: true }
      );
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty('EnableLocalWriteForwarding');
    });
  });

  describe('readCurrentState', () => {
    it.each([
      ['enabled', true],
      ['requested', true],
      ['enabling', false],
      ['disabling', false],
      ['disabled', false],
    ])('reads LocalWriteForwardingStatus %s as %s', async (status, expected) => {
      arm({ live: { LocalWriteForwardingStatus: status } });
      const state = (await provider.readCurrentState('c-1', 'L', CLUSTER)) as Input;
      expect(state['EnableLocalWriteForwarding']).toBe(expected);
    });

    it('reads the backtrack window, and never the write-only scalability type', async () => {
      arm({ live: { BacktrackWindow: 3600, ClusterScalabilityType: 'standard' } });
      const state = (await provider.readCurrentState('c-1', 'L', CLUSTER)) as Input;
      expect(state['BacktrackWindow']).toBe(3600);
      expect(state).not.toHaveProperty('ClusterScalabilityType');
    });

    it('omits both when DescribeDBClusters reports neither', async () => {
      arm();
      const state = (await provider.readCurrentState('c-1', 'L', CLUSTER)) as Input;
      expect(state).not.toHaveProperty('BacktrackWindow');
      expect(state).not.toHaveProperty('EnableLocalWriteForwarding');
    });
  });

  it('drift folds the CFn string spellings to the readback types', () => {
    expect(
      provider.canonicalizeDriftProperties(CLUSTER, {
        BacktrackWindow: '3600',
        EnableLocalWriteForwarding: 'false',
      })
    ).toEqual({ BacktrackWindow: 3600, EnableLocalWriteForwarding: false });
  });
});
