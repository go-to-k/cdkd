// go-to-k/cdkd#5640: `AutomaticBackupReplicationRegion`,
// `AutomaticBackupReplicationKmsKeyId` and
// `AutomaticBackupReplicationRetentionPeriod` on the SDK route for
// AWS::RDS::DBInstance, following CloudFormation's RDS handler
// (`ResourceModelHelper.shouldStart/StopAutomaticBackupReplication`,
// `AutomaticBackupReplicationValidator`, `BaseHandlerStd.start/stop...InRegion`,
// `ReadHandler.describeAutomatedBackupsReplication`): once the instance is
// `available`, a replication is started or stopped by a call to the
// DESTINATION region naming the instance's ARN.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, mockWarn, deadline } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockWarn: vi.fn(),
  deadline: { remainingMs: 60_000 },
}));

// A short resource deadline: a wait that never settles fails its test at once
// instead of spinning (the provider's sleep is stubbed below).
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => deadline.remainingMs,
}));

// Each client hands its own region to `mockSend`, so a test reads which
// region every call went to.
vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation((config?: { region?: string }) => ({
      send: (command: unknown) => mockSend(command, config?.region ?? 'us-east-1'),
      destroy: vi.fn(),
      config: { region: () => Promise.resolve(config?.region ?? 'us-east-1') },
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
      warn: mockWarn,
      error: vi.fn(),
    }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { findSdkUnwiredProperties } from '../../../src/provisioning/property-coverage.js';
import { backupReplicationPlan } from '../../../src/provisioning/providers/rds/instance-members.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { isAuxiliaryFailure } from '../../../src/provisioning/auxiliary-failure.js';

type Input = Record<string, unknown>;
type Command = { constructor: { name: string }; input: Input };

const INSTANCE = 'AWS::RDS::DBInstance';
const ARN = 'arn:aws:rds:us-east-1:123456789012:db:db-1';
const KMS = 'arn:aws:kms:us-west-2:123456789012:key/replica-key';
const backupArn = (region: string): string =>
  `arn:aws:rds:${region}:123456789012:auto-backup:ab-1`;

/** What a CDK `DatabaseInstance` with a cross-region backup replication emits. */
const BASE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t4g.micro',
  Engine: 'postgres',
  AllocatedStorage: '20',
  MasterUsername: 'postgres',
  MasterUserPassword: 'password-1',
  BackupRetentionPeriod: 7,
};
const REPLICATED: Input = {
  ...BASE,
  AutomaticBackupReplicationRegion: 'us-west-2',
  AutomaticBackupReplicationKmsKeyId: KMS,
  AutomaticBackupReplicationRetentionPeriod: 3,
};

interface Live {
  /** The region the instance replicates to before the test's calls. */
  replicatingTo?: string;
  /** Statuses DescribeDBInstances answers in turn (the last repeats). */
  statuses?: string[];
  /** A replication call refused with this error. */
  refuse?: { command: string; error: Error };
  /** DescribeDBInstanceAutomatedBackups' answer or refusal. */
  automatedBackup?: Input | Error;
  /** Reads after a stop or start that still show the list as it was. */
  lagReads?: number;
  /** Refusals each replication call answers first, in turn, before it succeeds. */
  busy?: Error[];
  /** DescribeDBInstances leaves the instance's ARN out. */
  noArn?: boolean;
}

/** Whether a start was sent while the instance still listed a replication. */
let startedWhileListed = false;

/**
 * A live instance whose replication list follows the calls: a stop empties
 * it, a start lists the start's own region.
 */
function arm(live: Live = {}): void {
  let replicatingTo = live.replicatingTo;
  // What the list reads after a lagging change, and how many reads lag.
  let pending: { region: string | undefined; reads: number } | undefined;
  const busy = [...(live.busy ?? [])];
  const statuses = [...(live.statuses ?? ['available'])];
  startedWhileListed = false;
  const change = (region: string | undefined): void => {
    if (live.lagReads) pending = { region, reads: live.lagReads };
    else replicatingTo = region;
  };
  mockSend.mockImplementation((command: Command, region: string) => {
    const name = command.constructor.name;
    if (live.refuse?.command === name) return Promise.reject(live.refuse.error);
    if (/AutomatedBackupsReplicationCommand$/.test(name) && busy.length > 0) {
      return Promise.reject(busy.shift()!);
    }
    switch (name) {
      case 'DescribeDBInstancesCommand': {
        if (pending !== undefined && pending.reads-- <= 0) {
          replicatingTo = pending.region;
          pending = undefined;
        }
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: 'db-1',
              ...(live.noArn !== true && { DBInstanceArn: ARN }),
              DBInstanceStatus: status,
              Engine: 'postgres',
              DBInstanceAutomatedBackupsReplications:
                replicatingTo === undefined
                  ? []
                  : [{ DBInstanceAutomatedBackupsArn: backupArn(replicatingTo) }],
            },
          ],
        });
      }
      case 'CreateDBInstanceCommand':
        return Promise.resolve({ DBInstance: { DBInstanceIdentifier: 'db-1' } });
      case 'StopDBInstanceAutomatedBackupsReplicationCommand':
        change(undefined);
        return Promise.resolve({});
      case 'StartDBInstanceAutomatedBackupsReplicationCommand':
        if (replicatingTo !== undefined) startedWhileListed = true;
        change(region);
        return Promise.resolve({});
      case 'DescribeDBInstanceAutomatedBackupsCommand':
        return live.automatedBackup instanceof Error
          ? Promise.reject(live.automatedBackup)
          : Promise.resolve({
              DBInstanceAutomatedBackups: live.automatedBackup ? [live.automatedBackup] : [],
            });
      case 'ListTagsForResourceCommand':
        return Promise.resolve({ TagList: [] });
      default:
        return Promise.resolve({});
    }
  });
}

/** Every call, `<Command>@<region>`, in order. */
function calls(): string[] {
  return mockSend.mock.calls.map(
    ([command, region]) => `${(command as Command).constructor.name}@${region as string}`
  );
}

/** The replication calls alone. */
function replicationCalls(): string[] {
  return calls().filter((call) => /AutomatedBackupsReplication/.test(call));
}

function sent(name: string): Input[] {
  return mockSend.mock.calls
    .map(([command]) => command as Command)
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}

function awsError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

describe('RDS DBInstance automated backup replication (go-to-k/cdkd#5640)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    arm();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
    deadline.remainingMs = 60_000;
  });

  const update = (next: Input, prev: Input, context?: Parameters<RDSProvider['update']>[5]) =>
    provider.update('L', 'db-1', INSTANCE, { ...next }, { ...prev }, context);

  it('routes a template declaring all three to the SDK provider', () => {
    expect(findSdkUnwiredProperties(INSTANCE, REPLICATED)).toEqual([]);
  });

  describe('create', () => {
    it('starts the replication in the destination region, naming the ARN, once available', async () => {
      arm({ statuses: ['creating', 'available'] });
      await provider.create('L', INSTANCE, { ...REPLICATED });
      expect(sent('StartDBInstanceAutomatedBackupsReplicationCommand')).toEqual([
        { SourceDBInstanceArn: ARN, BackupRetentionPeriod: 3, KmsKeyId: KMS },
      ]);
      const order = calls();
      const start = order.indexOf('StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2');
      expect(start).toBeGreaterThan(order.indexOf('CreateDBInstanceCommand@us-east-1'));
      expect(replicationCalls()).toEqual([
        'StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
      ]);
    });

    it('sends only the declared members, a CFn string retention as a number', async () => {
      await provider.create('L', INSTANCE, {
        ...BASE,
        AutomaticBackupReplicationRegion: 'us-west-2',
        AutomaticBackupReplicationRetentionPeriod: '5',
      });
      expect(sent('StartDBInstanceAutomatedBackupsReplicationCommand')).toEqual([
        { SourceDBInstanceArn: ARN, BackupRetentionPeriod: 5 },
      ]);
    });

    it('makes no replication call when no region is declared (an empty one included)', async () => {
      await provider.create('L', INSTANCE, { ...BASE, AutomaticBackupReplicationRegion: '' });
      expect(replicationCalls()).toEqual([]);
    });

    it('waits for the instance to list the started replication', async () => {
      // Two reads after the start still list nothing; the third lists it,
      // and the create's final describe follows.
      arm({ lagReads: 2 });
      await provider.create('L', INSTANCE, { ...REPLICATED });
      const order = calls();
      const start = order.indexOf('StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2');
      expect(order.slice(start + 1).filter((c) => c.startsWith('DescribeDBInstances'))).toHaveLength(4);
    });

    it('marks a replication failure as no name collision of the instance (#3826)', async () => {
      arm({
        refuse: {
          command: 'StartDBInstanceAutomatedBackupsReplicationCommand',
          error: awsError('InvalidParameterCombination', 'bad combination'),
        },
      });
      const error = await provider.create('L', INSTANCE, { ...REPLICATED }).catch((e: unknown) => e);
      expect(isAuxiliaryFailure(error)).toBe(true);
    });

    it('under --no-wait still waits for available before the start, and not after it', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm({ statuses: ['creating', 'creating', 'available'] });
      await provider.create('L', INSTANCE, { ...REPLICATED });
      const order = calls();
      const start = order.indexOf('StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2');
      expect(start).toBeGreaterThan(0);
      // Three reads until available, one for the ARN, then the final describe.
      expect(order.slice(0, start).filter((c) => c.startsWith('DescribeDBInstances'))).toHaveLength(4);
      expect(order.slice(start + 1).filter((c) => c.startsWith('DescribeDBInstances'))).toHaveLength(1);
    });

    it.each([
      [
        'a KMS key with no region',
        { AutomaticBackupReplicationKmsKeyId: KMS },
        /must specify the AutomaticBackupReplicationRegion parameter when setting the AutomaticBackupReplicationKmsKeyId/,
      ],
      [
        'a retention with no region',
        { AutomaticBackupReplicationRetentionPeriod: 3 },
        /must specify the AutomaticBackupReplicationRegion parameter when setting the AutomaticBackupReplicationRetentionPeriod/,
      ],
      [
        'a region beside BackupRetentionPeriod 0',
        { AutomaticBackupReplicationRegion: 'us-west-2', BackupRetentionPeriod: 0 },
        /AutomaticBackupReplicationRegion cannot be specified when BackupRetentionPeriod is 0/,
      ],
      [
        'a retention that is no whole number',
        { AutomaticBackupReplicationRegion: 'us-west-2', AutomaticBackupReplicationRetentionPeriod: 'abc' },
        /AutomaticBackupReplicationRetentionPeriod a whole number/,
      ],
      [
        'a region that is no string',
        { AutomaticBackupReplicationRegion: { Ref: 'AWS::Region' } },
        /AutomaticBackupReplicationRegion and AutomaticBackupReplicationKmsKeyId must be strings/,
      ],
    ])('refuses %s before any call', async (_label, extra, says) => {
      await expect(provider.create('L', INSTANCE, { ...BASE, ...extra })).rejects.toThrow(says);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a rollback replay only warns about a misuse it cannot fix through the template', async () => {
      await provider.create(
        'L',
        INSTANCE,
        { ...BASE, AutomaticBackupReplicationKmsKeyId: KMS },
        { replayingState: true }
      );
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringMatching(/must specify the AutomaticBackupReplicationRegion parameter/)
      );
      expect(sent('CreateDBInstanceCommand')).toHaveLength(1);
      expect(replicationCalls()).toEqual([]);
    });

    it("fails the create when the start fails, naming CloudFormation's KMS key hint", async () => {
      arm({
        refuse: {
          command: 'StartDBInstanceAutomatedBackupsReplicationCommand',
          error: awsError(
            'InvalidParameterValue',
            'Encrypted instances require a valid KMS key ID for the destination AWS Region.'
          ),
        },
      });
      await expect(provider.create('L', INSTANCE, { ...REPLICATED })).rejects.toThrow(
        /Provide a valid value for the AutomaticBackupReplicationKmsKeyId property/
      );
    });

    it('adds no KMS hint to any other refusal', async () => {
      arm({
        refuse: {
          command: 'StartDBInstanceAutomatedBackupsReplicationCommand',
          error: awsError('InvalidParameterCombination', 'bad combination'),
        },
      });
      const error = await provider.create('L', INSTANCE, { ...REPLICATED }).catch((e: unknown) => e);
      expect(String((error as Error).message)).toMatch(/bad combination/);
      expect(String((error as Error).message)).not.toMatch(/Provide a valid value/);
    });
  });

  describe('update', () => {
    it('starts the replication when the template adds a region, stopping nothing', async () => {
      await update(REPLICATED, BASE);
      expect(replicationCalls()).toEqual([
        'StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
      ]);
    });

    it('stops the replication in its region when the template removes it, and waits it out', async () => {
      arm({ replicatingTo: 'us-west-2' });
      await update(BASE, REPLICATED);
      expect(replicationCalls()).toEqual([
        'StopDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
      ]);
      expect(sent('StopDBInstanceAutomatedBackupsReplicationCommand')).toEqual([
        { SourceDBInstanceArn: ARN },
      ]);
      const order = calls();
      const stop = order.indexOf('StopDBInstanceAutomatedBackupsReplicationCommand@us-west-2');
      expect(order.slice(stop + 1)).toContain('DescribeDBInstancesCommand@us-east-1');
    });

    it('a removal under --no-wait stops without waiting', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm({ replicatingTo: 'us-west-2' });
      await update(BASE, REPLICATED);
      const order = calls();
      const stop = order.indexOf('StopDBInstanceAutomatedBackupsReplicationCommand@us-west-2');
      // The update read its attributes before the roles and the replication.
      expect(order.slice(stop + 1).filter((c) => c.startsWith('DescribeDBInstances'))).toHaveLength(0);
    });

    it('moves a replication to another region: stops the old one, then starts the new', async () => {
      arm({ replicatingTo: 'us-west-2' });
      await update(
        { ...REPLICATED, AutomaticBackupReplicationRegion: 'eu-west-1' },
        REPLICATED
      );
      expect(replicationCalls()).toEqual([
        'StopDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
        'StartDBInstanceAutomatedBackupsReplicationCommand@eu-west-1',
      ]);
    });

    it('starts only once the stopped replication has left the list', async () => {
      arm({ replicatingTo: 'us-west-2', lagReads: 2 });
      await update({ ...REPLICATED, AutomaticBackupReplicationRegion: 'eu-west-1' }, REPLICATED);
      expect(startedWhileListed).toBe(false);
      expect(replicationCalls()).toEqual([
        'StopDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
        'StartDBInstanceAutomatedBackupsReplicationCommand@eu-west-1',
      ]);
    });

    it('under --no-wait still waits for the stop before a start', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm({ replicatingTo: 'us-west-2', lagReads: 2 });
      await update({ ...REPLICATED, AutomaticBackupReplicationRegion: 'eu-west-1' }, REPLICATED);
      expect(startedWhileListed).toBe(false);
    });

    it('waits for the started replication to be listed before returning', async () => {
      arm({ lagReads: 2 });
      await update(REPLICATED, BASE);
      const order = calls();
      const start = order.indexOf('StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2');
      // Two lagging reads, then the one listing it.
      expect(order.slice(start + 1).filter((c) => c.startsWith('DescribeDBInstances'))).toHaveLength(3);
    });

    it.each([
      ['InvalidDBInstanceStateFault'],
      ['InvalidDBInstanceAutomatedBackupStateFault'],
    ])('resends a start RDS refused as busy (%s), as CloudFormation waits it out', async (fault) => {
      arm({ busy: [awsError(fault, 'busy')] });
      await update(REPLICATED, BASE);
      expect(replicationCalls()).toEqual([
        'StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
        'StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
      ]);
    });

    it('does not resend a start refused for any other reason', async () => {
      arm({ busy: [awsError('InvalidParameterCombination', 'bad combination')] });
      await expect(update(REPLICATED, BASE)).rejects.toThrow(/bad combination/);
      expect(replicationCalls()).toHaveLength(1);
    });

    it('refuses before any replication call when the resource timeout leaves no time', async () => {
      deadline.remainingMs = 20_000;
      await expect(update(REPLICATED, BASE)).rejects.toThrow(/leaves no more time/);
      expect(replicationCalls()).toEqual([]);
    });

    it('refuses when DescribeDBInstances names no ARN, sending nothing', async () => {
      arm({ noArn: true });
      await expect(update(REPLICATED, BASE)).rejects.toThrow(/no instance ARN/);
      expect(replicationCalls()).toEqual([]);
    });

    it.each([
      ['retention', { AutomaticBackupReplicationRetentionPeriod: 5 }],
      ['KMS key', { AutomaticBackupReplicationKmsKeyId: `${KMS}-2` }],
    ])('restarts the replication in place when its %s changes', async (_label, change) => {
      arm({ replicatingTo: 'us-west-2' });
      await update({ ...REPLICATED, ...change }, REPLICATED);
      expect(replicationCalls()).toEqual([
        'StopDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
        'StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
      ]);
    });

    it('restarts it when BackupRetentionPeriod changes and no replication retention is declared', async () => {
      const prev = { ...BASE, AutomaticBackupReplicationRegion: 'us-west-2' };
      arm({ replicatingTo: 'us-west-2' });
      await update({ ...prev, BackupRetentionPeriod: 14 }, prev);
      expect(replicationCalls()).toEqual([
        'StopDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
        'StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
      ]);
      expect(sent('StartDBInstanceAutomatedBackupsReplicationCommand')).toEqual([
        { SourceDBInstanceArn: ARN },
      ]);
    });

    it('leaves it alone when BackupRetentionPeriod changes beside a declared replication retention', async () => {
      arm({ replicatingTo: 'us-west-2' });
      await update({ ...REPLICATED, BackupRetentionPeriod: 14 }, REPLICATED);
      expect(replicationCalls()).toEqual([]);
    });

    it('makes no replication call on an unchanged template', async () => {
      arm({ replicatingTo: 'us-west-2' });
      await update(REPLICATED, REPLICATED);
      expect(replicationCalls()).toEqual([]);
    });

    it('starts without a stop when the recorded replication is already gone', async () => {
      await update(
        { ...REPLICATED, AutomaticBackupReplicationRetentionPeriod: 5 },
        REPLICATED
      );
      expect(replicationCalls()).toEqual([
        'StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
      ]);
    });

    it('stops one an earlier failed attempt left before starting again', async () => {
      arm({ replicatingTo: 'us-west-2' });
      await update(REPLICATED, BASE);
      expect(replicationCalls()).toEqual([
        'StopDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
        'StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2',
      ]);
    });

    it('refuses a misuse before ModifyDBInstance', async () => {
      await expect(
        update({ ...BASE, AutomaticBackupReplicationRetentionPeriod: 3 }, BASE)
      ).rejects.toThrow(/must specify the AutomaticBackupReplicationRegion parameter/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['a rollback replay', { replayingState: true }],
      ['drift --revert', { desiredFromAwsReadback: true }],
    ])('%s only warns about a misuse', async (_label, context) => {
      await update({ ...BASE, AutomaticBackupReplicationRetentionPeriod: 3 }, BASE, context);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringMatching(/must specify the AutomaticBackupReplicationRegion parameter/)
      );
      expect(replicationCalls()).toEqual([]);
    });

    it('does not refuse a malformed value the record holds unchanged', async () => {
      const prev = { ...BASE, AutomaticBackupReplicationRegion: { Ref: 'Region' } };
      await update(prev, prev);
      expect(replicationCalls()).toEqual([]);
    });

    it('refuses a malformed value it would act on before any call', async () => {
      await expect(
        update({ ...BASE, AutomaticBackupReplicationRegion: { Ref: 'Region' } }, BASE)
      ).rejects.toThrow(/must be strings/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('runs after ModifyDBInstance', async () => {
      await update({ ...REPLICATED, AllocatedStorage: '30' }, BASE);
      const order = calls();
      expect(order.indexOf('ModifyDBInstanceCommand@us-east-1')).toBeLessThan(
        order.indexOf('StartDBInstanceAutomatedBackupsReplicationCommand@us-west-2')
      );
    });
  });

  describe('backupReplicationPlan', () => {
    const plan = (next: Input, prev: Input) =>
      backupReplicationPlan(next, prev, INSTANCE, 'L', 'db-1', false, () => {});

    it('a malformed recorded side counts as a change', () => {
      expect(plan(REPLICATED, { ...REPLICATED, AutomaticBackupReplicationRegion: 7 })).toEqual({
        stop: true,
        start: { region: 'us-west-2', kmsKeyId: KMS, retention: 3 },
      });
    });

    it("reads a region spelled 'malformed' as a region", () => {
      expect(plan({ ...BASE, AutomaticBackupReplicationRegion: 'malformed' }, BASE)).toEqual({
        stop: false,
        start: { region: 'malformed', kmsKeyId: undefined, retention: undefined },
      });
    });

    it('removing the region alone stops, with nothing to start', () => {
      const prev = { ...BASE, AutomaticBackupReplicationRegion: 'us-west-2' };
      expect(plan(BASE, prev)).toEqual({ stop: true, start: undefined });
    });
  });

  describe('readCurrentState and drift', () => {
    it("reads the region off the replication's ARN and the retention there", async () => {
      arm({ replicatingTo: 'us-west-2', automatedBackup: { BackupRetentionPeriod: 3 } });
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(state['AutomaticBackupReplicationRegion']).toBe('us-west-2');
      expect(state['AutomaticBackupReplicationRetentionPeriod']).toBe(3);
      expect(state).not.toHaveProperty('AutomaticBackupReplicationKmsKeyId');
      expect(sent('DescribeDBInstanceAutomatedBackupsCommand')).toEqual([
        { DBInstanceAutomatedBackupsArn: backupArn('us-west-2') },
      ]);
      expect(calls()).toContain('DescribeDBInstanceAutomatedBackupsCommand@us-west-2');
    });

    it('reads nothing, and makes no extra call, for an instance that does not replicate', async () => {
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(state).not.toHaveProperty('AutomaticBackupReplicationRegion');
      expect(state).not.toHaveProperty('AutomaticBackupReplicationRetentionPeriod');
      expect(sent('DescribeDBInstanceAutomatedBackupsCommand')).toEqual([]);
    });

    it('keeps the region when the replicated backup is not found, as the handler soft-fails it', async () => {
      arm({
        replicatingTo: 'us-west-2',
        automatedBackup: awsError('DBInstanceAutomatedBackupNotFoundFault', 'not found'),
      });
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(state['AutomaticBackupReplicationRegion']).toBe('us-west-2');
      expect(state).not.toHaveProperty('AutomaticBackupReplicationRetentionPeriod');
    });

    it('keeps the region on the bare AWS not-found code too', async () => {
      arm({
        replicatingTo: 'us-west-2',
        automatedBackup: awsError('DBInstanceAutomatedBackupNotFound', 'not found'),
      });
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(state['AutomaticBackupReplicationRegion']).toBe('us-west-2');
    });

    it('soft-fails a denied read with a warning, as the handler ignores it', async () => {
      arm({
        replicatingTo: 'us-west-2',
        automatedBackup: awsError('AccessDenied', 'not authorized'),
      });
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(state['AutomaticBackupReplicationRegion']).toBe('us-west-2');
      expect(state).not.toHaveProperty('AutomaticBackupReplicationRetentionPeriod');
      expect(mockWarn).toHaveBeenCalledWith(expect.stringMatching(/AccessDenied/));
    });

    it('propagates any other failure of that read', async () => {
      arm({
        replicatingTo: 'us-west-2',
        automatedBackup: awsError('ThrottlingException', 'rate exceeded'),
      });
      await expect(provider.readCurrentState('db-1', 'L', INSTANCE)).rejects.toThrow(
        /rate exceeded/
      );
    });

    it('reports a replication in another region than declared as drift', async () => {
      const drift = async (live: Input): Promise<number> => {
        const pair = await provider.canonicalizeDriftPair(INSTANCE, REPLICATED, live);
        return calculateResourceDrift(pair.baseline, pair.aws, {
          ignorePaths: provider.getDriftUnknownPaths(INSTANCE, REPLICATED),
          unorderedPaths: provider.getDriftUnorderedPaths(INSTANCE),
        }).length;
      };
      const replicating = {
        AutomaticBackupReplicationRegion: 'us-west-2',
        AutomaticBackupReplicationRetentionPeriod: 3,
      };
      expect(await drift({ ...REPLICATED, ...replicating })).toBe(0);
      expect(
        await drift({ ...REPLICATED, ...replicating, AutomaticBackupReplicationRegion: 'eu-west-1' })
      ).toBeGreaterThan(0);
      expect(
        await drift({ ...REPLICATED, ...replicating, AutomaticBackupReplicationRetentionPeriod: 5 })
      ).toBeGreaterThan(0);
    });

    it('compares the retention only where declared, and never the write-only KMS key', () => {
      expect(provider.getDriftUnknownPaths(INSTANCE, BASE)).toEqual(
        expect.arrayContaining([
          'AutomaticBackupReplicationKmsKeyId',
          'AutomaticBackupReplicationRetentionPeriod',
        ])
      );
      const declared = provider.getDriftUnknownPaths(INSTANCE, REPLICATED);
      expect(declared).toContain('AutomaticBackupReplicationKmsKeyId');
      expect(declared).not.toContain('AutomaticBackupReplicationRetentionPeriod');
      expect(declared).not.toContain('AutomaticBackupReplicationRegion');
    });
  });
});
