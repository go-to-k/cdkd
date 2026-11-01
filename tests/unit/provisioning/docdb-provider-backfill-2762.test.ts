// go-to-k/cdkd#2762: the DBCluster / DBInstance properties backfilled into
// `handledProperties`. sdk-wire-coverage-15 proves each reaches the wire; this
// suite holds the arms a generic probe cannot spell: the secret path, what is
// sent only on a change, the kept removals of the real CloudFormation A/B
// (us-east-1, engine 5.0.0, 2026-11-01), the read-back waits and drift.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());
const debug = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    DocDBClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug, info: vi.fn(), warn, error: vi.fn(), child: () => logger };
  return { getLogger: () => logger };
});

import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import {
  docdbLogExportChange,
  docdbServerlessScaling,
  docdbStringList,
  holdsDocDBPendingValue,
} from '../../../src/provisioning/providers/docdb-shared.js';

const CLUSTER = 'AWS::DocDB::DBCluster';
const INSTANCE = 'AWS::DocDB::DBInstance';
const PASSWORD = 'FAKE-not-a-real-password';
const KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/k';

type Bag = Record<string, unknown>;

function sent(command: string): Bag[] {
  return mockSend.mock.calls
    .filter(([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === command)
    .map(([cmd]) => (cmd as { input: Bag }).input);
}

/** Answers the fake cluster, applying what ModifyDBCluster sends. */
function armCluster(live: Bag = {}): Bag {
  const cluster: Bag = {
    DBClusterIdentifier: 'c',
    Engine: 'docdb',
    Status: 'available',
    DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:c',
    DBClusterMembers: [],
    ...live,
  };
  mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Bag }) => {
    switch (cmd.constructor.name) {
      case 'DescribeDBClustersCommand':
        return Promise.resolve({ DBClusters: [{ ...cluster }] });
      case 'CreateDBClusterCommand':
        return Promise.resolve({ DBCluster: { DbClusterResourceId: 'r' } });
      case 'ModifyDBClusterCommand': {
        const { CloudwatchLogsExportConfiguration: logs, ...rest } = cmd.input as Bag & {
          CloudwatchLogsExportConfiguration?: {
            EnableLogTypes?: string[];
            DisableLogTypes?: string[];
          };
        };
        Object.assign(cluster, rest);
        cluster['EnabledCloudwatchLogsExports'] = [
          ...((cluster['EnabledCloudwatchLogsExports'] as string[] | undefined) ?? []),
          ...(logs?.EnableLogTypes ?? []),
        ].filter((type) => !logs?.DisableLogTypes?.includes(type));
        return Promise.resolve({});
      }
      default:
        return Promise.resolve({ TagList: [] });
    }
  });
  return cluster;
}

function armInstance(live: Bag = {}): Bag {
  const instance: Bag = {
    DBInstanceIdentifier: 'i',
    Engine: 'docdb',
    DBInstanceStatus: 'available',
    DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:i',
    ...live,
  };
  mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Bag }) => {
    switch (cmd.constructor.name) {
      case 'DescribeDBInstancesCommand':
        return Promise.resolve({ DBInstances: [{ ...instance }] });
      case 'CreateDBInstanceCommand':
        return Promise.resolve({ DBInstance: { DbiResourceId: 'r' } });
      case 'ModifyDBInstanceCommand':
        if (cmd.input['CACertificateIdentifier'] !== undefined) {
          instance['CACertificateIdentifier'] = cmd.input['CACertificateIdentifier'];
        }
        if (cmd.input['EnablePerformanceInsights'] !== undefined) {
          instance['PerformanceInsightsEnabled'] = cmd.input['EnablePerformanceInsights'];
        }
        return Promise.resolve({});
      default:
        return Promise.resolve({ TagList: [] });
    }
  });
  return instance;
}

describe('DocDBProvider backfilled properties (go-to-k/cdkd#2762)', () => {
  let provider: DocDBProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    debug.mockReset();
    provider = new DocDBProvider();
    (provider as unknown as { sleep: () => Promise<void> }).sleep = () => Promise.resolve();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const updateCluster = (next: Bag, previous: Bag, context?: Bag) =>
    provider.update('L', 'c', CLUSTER, next, previous, context as never);
  const updateInstance = (next: Bag, previous: Bag, context?: Bag) =>
    provider.update('L', 'i', INSTANCE, next, previous, context as never);

  describe('the master password path', () => {
    it('a create with a managed password sends no MasterUserPassword', async () => {
      armCluster();
      await provider.create('L', CLUSTER, {
        MasterUsername: 'u',
        ManageMasterUserPassword: true,
        MasterUserSecretKmsKeyId: KEY_ARN,
      });
      const input = sent('CreateDBClusterCommand')[0]!;
      expect(input['ManageMasterUserPassword']).toBe(true);
      expect(input['MasterUserSecretKmsKeyId']).toBe(KEY_ARN);
      expect(input['MasterUserPassword']).toBeUndefined();
    });

    it('refuses a create declaring both before any call, printing no value', async () => {
      armCluster();
      const error = (await provider
        .create('L', CLUSTER, { ManageMasterUserPassword: true, MasterUserPassword: PASSWORD })
        .catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(/cannot be set while ManageMasterUserPassword is true/);
      expect(error.message).not.toContain(PASSWORD);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a replayed create leaves the password out with a warning, printing no value', async () => {
      armCluster();
      await provider.create(
        'L',
        CLUSTER,
        { ManageMasterUserPassword: true, MasterUserPassword: PASSWORD },
        { replayingState: true } as never
      );
      expect(sent('CreateDBClusterCommand')[0]!['MasterUserPassword']).toBeUndefined();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(PASSWORD);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('turning management on sends the key and no password, the template keeping it unchanged', async () => {
      armCluster();
      await updateCluster(
        {
          ManageMasterUserPassword: true,
          MasterUserSecretKmsKeyId: KEY_ARN,
          MasterUserPassword: PASSWORD,
        },
        { MasterUserPassword: PASSWORD }
      );
      const input = sent('ModifyDBClusterCommand')[0]!;
      expect(input).toMatchObject({
        ManageMasterUserPassword: true,
        MasterUserSecretKmsKeyId: KEY_ARN,
      });
      expect(input['MasterUserPassword']).toBeUndefined();
    });

    it('refuses an update changing the password while it is managed', async () => {
      armCluster();
      const error = (await updateCluster(
        { ManageMasterUserPassword: true, MasterUserPassword: PASSWORD },
        { ManageMasterUserPassword: true, MasterUserPassword: 'FAKE-older-value' }
      ).catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(/cannot be set while ManageMasterUserPassword is true/);
      expect(error.message).not.toContain(PASSWORD);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('an unchanged managed cluster sends neither the flag nor the key', async () => {
      armCluster();
      const bag = { ManageMasterUserPassword: true, MasterUserSecretKmsKeyId: KEY_ARN };
      await updateCluster({ ...bag, BackupRetentionPeriod: 2 }, bag);
      const input = sent('ModifyDBClusterCommand')[0]!;
      expect(input['ManageMasterUserPassword']).toBeUndefined();
      expect(input['MasterUserSecretKmsKeyId']).toBeUndefined();
    });

    it('turning management off carries the newly declared password', async () => {
      armCluster();
      await updateCluster(
        { ManageMasterUserPassword: false, MasterUserPassword: PASSWORD },
        { ManageMasterUserPassword: true }
      );
      expect(sent('ModifyDBClusterCommand')[0]).toMatchObject({
        ManageMasterUserPassword: false,
        MasterUserPassword: PASSWORD,
      });
    });

    it('a key changed under a managed password goes to AWS, which answers it', async () => {
      armCluster();
      await updateCluster(
        { ManageMasterUserPassword: true, MasterUserSecretKmsKeyId: KEY_ARN },
        { ManageMasterUserPassword: true, MasterUserSecretKmsKeyId: 'alias/old' }
      );
      expect(sent('ModifyDBClusterCommand')[0]).toMatchObject({
        ManageMasterUserPassword: true,
        MasterUserSecretKmsKeyId: KEY_ARN,
      });
    });

    it('a declared false on a cluster that never managed it travels nowhere', async () => {
      armCluster();
      await updateCluster({ ManageMasterUserPassword: false }, {});
      expect(sent('ModifyDBClusterCommand')[0]!['ManageMasterUserPassword']).toBeUndefined();
    });

    it('turning management off never sends the key held beside it (AWS takes one only when on)', async () => {
      armCluster();
      await updateCluster(
        {
          ManageMasterUserPassword: false,
          MasterUserSecretKmsKeyId: KEY_ARN,
          MasterUserPassword: PASSWORD,
        },
        { ManageMasterUserPassword: true, MasterUserSecretKmsKeyId: KEY_ARN }
      );
      const input = sent('ModifyDBClusterCommand')[0]!;
      expect(input).toMatchObject({
        ManageMasterUserPassword: false,
        MasterUserPassword: PASSWORD,
      });
      expect(input['MasterUserSecretKmsKeyId']).toBeUndefined();
    });

    it('a key changed beside turning management off stays unsent too', async () => {
      armCluster();
      await updateCluster(
        {
          ManageMasterUserPassword: false,
          MasterUserSecretKmsKeyId: KEY_ARN,
          MasterUserPassword: PASSWORD,
        },
        { ManageMasterUserPassword: true, MasterUserSecretKmsKeyId: 'alias/old' }
      );
      expect(sent('ModifyDBClusterCommand')[0]!['MasterUserSecretKmsKeyId']).toBeUndefined();
    });

    it('a key held through false -> true goes out with the flag', async () => {
      armCluster();
      await updateCluster(
        { ManageMasterUserPassword: true, MasterUserSecretKmsKeyId: KEY_ARN },
        { ManageMasterUserPassword: false, MasterUserSecretKmsKeyId: KEY_ARN }
      );
      expect(sent('ModifyDBClusterCommand')[0]).toMatchObject({
        ManageMasterUserPassword: true,
        MasterUserSecretKmsKeyId: KEY_ARN,
      });
    });

    describe('the flag gone from the template while the record is managed', () => {
      const next = { MasterUserPassword: PASSWORD };
      const previous = { ManageMasterUserPassword: true };

      it('refuses a password change before any call, printing no value', async () => {
        armCluster();
        const error = (await updateCluster(next, previous).catch((e: unknown) => e)) as Error;
        expect(error.message).toMatch(/declare ManageMasterUserPassword: false beside it/);
        expect(error.message).not.toContain(PASSWORD);
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('a rollback leaves the password and the flag out, and warns by key name', async () => {
        armCluster();
        await updateCluster(next, previous, { replayingState: true });
        const input = sent('ModifyDBClusterCommand')[0]!;
        expect(input['MasterUserPassword']).toBeUndefined();
        expect(input['ManageMasterUserPassword']).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('the cluster stays managed'));
        expect(JSON.stringify(warn.mock.calls)).not.toContain(PASSWORD);
      });

      it('a plain removal keeps management, with the warning that claims no parity', async () => {
        armCluster();
        await updateCluster({}, previous);
        expect(sent('ModifyDBClusterCommand')[0]!['ManageMasterUserPassword']).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('ManageMasterUserPassword was removed')
        );
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('as CloudFormation does'));
      });

      it('an explicit false beside the password still leaves managed mode', async () => {
        armCluster();
        await updateCluster({ ...next, ManageMasterUserPassword: false }, previous);
        expect(sent('ModifyDBClusterCommand')[0]).toMatchObject({
          ManageMasterUserPassword: false,
          MasterUserPassword: PASSWORD,
        });
      });
    });

    it('a {{resolve: password kept beside an added true is neither sent nor refused', async () => {
      armCluster();
      await updateCluster(
        { ManageMasterUserPassword: true, MasterUserPassword: PASSWORD },
        { MasterUserPassword: '{{resolve:secretsmanager:s:SecretString:p}}' },
        { changedProperties: new Set(['ManageMasterUserPassword']) }
      );
      const input = sent('ModifyDBClusterCommand')[0]!;
      expect(input['ManageMasterUserPassword']).toBe(true);
      expect(input['MasterUserPassword']).toBeUndefined();
    });

    it('drift --revert toward false sends no false, which would need a password', async () => {
      armCluster();
      await updateCluster(
        { ManageMasterUserPassword: false },
        { ManageMasterUserPassword: true },
        { desiredFromAwsReadback: true }
      );
      expect(sent('ModifyDBClusterCommand')[0]!['ManageMasterUserPassword']).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('ManageMasterUserPassword stays true')
      );
    });

    it('drift --revert toward true sends it', async () => {
      armCluster();
      await updateCluster(
        { ManageMasterUserPassword: true },
        { ManageMasterUserPassword: false },
        { desiredFromAwsReadback: true }
      );
      expect(sent('ModifyDBClusterCommand')[0]!['ManageMasterUserPassword']).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('a drift --revert unusable flag warns instead of refusing', async () => {
      armCluster();
      await updateCluster({ ManageMasterUserPassword: 'yes' }, {}, { desiredFromAwsReadback: true });
      expect(sent('ModifyDBClusterCommand')[0]!['ManageMasterUserPassword']).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('recorded ManageMasterUserPassword is unusable')
      );
    });

    it('a replayed create warns about an unusable flag instead of refusing', async () => {
      armCluster();
      await provider.create('L', CLUSTER, { ManageMasterUserPassword: 'yes' }, {
        replayingState: true,
      } as never);
      expect(sent('CreateDBClusterCommand')[0]!['ManageMasterUserPassword']).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('refuses a ManageMasterUserPassword that is no boolean, before any call', async () => {
      armCluster();
      await expect(updateCluster({ ManageMasterUserPassword: 'yes' }, {})).rejects.toThrow(
        /ManageMasterUserPassword must be a boolean/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['newly true', { RotateMasterUserPassword: true }, {}, true],
      ['false to true', { RotateMasterUserPassword: 'true' }, { RotateMasterUserPassword: false }, true],
      ['kept true', { RotateMasterUserPassword: true }, { RotateMasterUserPassword: true }, false],
      ['declared false', { RotateMasterUserPassword: false }, {}, false],
      ['removed', {}, { RotateMasterUserPassword: true }, false],
    ])('RotateMasterUserPassword %s', async (_name, next, previous, rotates) => {
      armCluster();
      await updateCluster(next, previous);
      expect(sent('ModifyDBClusterCommand')[0]!['RotateMasterUserPassword']).toBe(
        rotates ? true : undefined
      );
    });

    it.each([
      ['a rollback', { replayingState: true }],
      ['drift --revert', { desiredFromAwsReadback: true }],
    ])('%s restoring a recorded true never rotates', async (_name, context) => {
      armCluster();
      await updateCluster({ RotateMasterUserPassword: true }, {}, context);
      expect(sent('ModifyDBClusterCommand')[0]!['RotateMasterUserPassword']).toBeUndefined();
    });

    it('a repeated update of a kept true does not rotate either', async () => {
      armCluster();
      const bag = { RotateMasterUserPassword: true, ManageMasterUserPassword: true };
      await updateCluster({ ...bag, BackupRetentionPeriod: 3 }, { ...bag, BackupRetentionPeriod: 2 });
      await updateCluster({ ...bag, BackupRetentionPeriod: 4 }, { ...bag, BackupRetentionPeriod: 3 });
      for (const input of sent('ModifyDBClusterCommand')) {
        expect(input['RotateMasterUserPassword']).toBeUndefined();
      }
    });

    it('reads whether a secret is managed, and nothing of the secret', async () => {
      armCluster({
        MasterUserSecret: { SecretArn: 'arn:aws:secretsmanager:x:1:secret:s', KmsKeyId: KEY_ARN },
      });
      const state = await provider.readCurrentState('c', 'L', CLUSTER);
      expect((state as Bag)['ManageMasterUserPassword']).toBe(true);
      expect(JSON.stringify(state)).not.toContain('secretsmanager');
    });
  });

  describe('what is sent only on a change', () => {
    it('re-sends nothing for unchanged keys', async () => {
      armCluster({ StorageType: 'iopt1', NetworkType: 'IPV4' });
      const bag = {
        NetworkType: 'IPV4',
        StorageType: 'iopt1',
        EnableCloudwatchLogsExports: ['audit'],
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
      };
      await updateCluster({ ...bag, BackupRetentionPeriod: 2 }, bag);
      const input = sent('ModifyDBClusterCommand')[0]!;
      for (const key of [
        'NetworkType',
        'StorageType',
        'ServerlessV2ScalingConfiguration',
        'CloudwatchLogsExportConfiguration',
      ]) {
        expect(input[key]).toBeUndefined();
      }
    });

    it('a StorageType the record lacks compares with the live one, where absent is standard', async () => {
      armCluster();
      await updateCluster({ StorageType: 'standard' }, {});
      expect(sent('ModifyDBClusterCommand')[0]!['StorageType']).toBeUndefined();
    });

    it('a changed storage type goes out and is waited on', async () => {
      const cluster = armCluster();
      let reads = 0;
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'DescribeDBClustersCommand' && ++reads === 2) {
          return Promise.resolve({ DBClusters: [{ ...cluster, StorageType: undefined }] });
        }
        return answer(cmd);
      });
      await updateCluster({ StorageType: 'iopt1' }, { StorageType: 'standard' });
      expect(sent('ModifyDBClusterCommand')[0]!['StorageType']).toBe('iopt1');
      expect(reads).toBeGreaterThan(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it('sends a capacity string as a number, and refuses a block missing one', async () => {
      armCluster();
      await updateCluster(
        { ServerlessV2ScalingConfiguration: { MinCapacity: '0.5', MaxCapacity: '4' } },
        { ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 } }
      );
      expect(sent('ModifyDBClusterCommand')[0]!['ServerlessV2ScalingConfiguration']).toEqual({
        MinCapacity: 0.5,
        MaxCapacity: 4,
      });
      await expect(
        updateCluster({ ServerlessV2ScalingConfiguration: { MinCapacity: 1 } }, {})
      ).rejects.toThrow(/ServerlessV2ScalingConfiguration must be/);
    });

    it('a state-borne malformed block is left out with a warning', async () => {
      armCluster();
      await updateCluster(
        { ServerlessV2ScalingConfiguration: 'junk' },
        {},
        { replayingState: true }
      );
      expect(sent('ModifyDBClusterCommand')[0]!['ServerlessV2ScalingConfiguration']).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a create with an empty list sends none', async () => {
      armCluster();
      await provider.create('L', CLUSTER, { EnableCloudwatchLogsExports: [] });
      expect(sent('CreateDBClusterCommand')[0]!['EnableCloudwatchLogsExports']).toBeUndefined();
    });

    it('a replayed create leaves a malformed list out, warned; a template create refuses', async () => {
      armCluster();
      await provider.create('L', CLUSTER, { EnableCloudwatchLogsExports: 'audit' }, {
        replayingState: true,
      } as never);
      expect(sent('CreateDBClusterCommand')[0]!['EnableCloudwatchLogsExports']).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      await expect(
        provider.create('L', CLUSTER, { EnableCloudwatchLogsExports: 'audit' })
      ).rejects.toThrow(/must be a list of strings/);
    });

    it('a drift --revert malformed block is state-borne: left out, warned', async () => {
      armCluster();
      await updateCluster(
        { ServerlessV2ScalingConfiguration: 'junk' },
        {},
        { desiredFromAwsReadback: true }
      );
      expect(sent('ModifyDBClusterCommand')[0]!['ServerlessV2ScalingConfiguration']).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('sends the log delta, and only what is on the two sides', async () => {
      armCluster({ EnabledCloudwatchLogsExports: ['audit', 'oob'] });
      await updateCluster(
        { EnableCloudwatchLogsExports: ['profiler'] },
        { EnableCloudwatchLogsExports: ['audit'] }
      );
      expect(sent('ModifyDBClusterCommand')[0]!['CloudwatchLogsExportConfiguration']).toEqual({
        EnableLogTypes: ['profiler'],
        DisableLogTypes: ['audit'],
      });
    });

    it('a declared empty list disables what the record held', async () => {
      armCluster({ EnabledCloudwatchLogsExports: ['audit'] });
      await updateCluster(
        { EnableCloudwatchLogsExports: [] },
        { EnableCloudwatchLogsExports: ['audit'] }
      );
      expect(sent('ModifyDBClusterCommand')[0]!['CloudwatchLogsExportConfiguration']).toEqual({
        DisableLogTypes: ['audit'],
      });
    });

    it('refuses a malformed log list on every update path, a replay included', async () => {
      armCluster();
      await expect(
        updateCluster(
          { EnableCloudwatchLogsExports: 'audit' },
          { EnableCloudwatchLogsExports: ['audit'] },
          { replayingState: true }
        )
      ).rejects.toThrow(/EnableCloudwatchLogsExports must be a list/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('waits for each cluster change alone to read back', async () => {
      const cluster = armCluster({
        EnabledCloudwatchLogsExports: ['audit'],
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
      });
      const answer = mockSend.getMockImplementation()!;
      const lags: Bag[] = [
        { EnabledCloudwatchLogsExports: ['audit'] },
        { EnabledCloudwatchLogsExports: ['profiler', 'audit'] },
        { ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 } },
        { ServerlessV2ScalingConfiguration: { MinCapacity: 1, MaxCapacity: 2 } },
      ];
      let reads = 0;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name !== 'DescribeDBClustersCommand') return answer(cmd);
        reads += 1;
        // Read 1 is the live read, 2 the attributes read, then the wait.
        const lag = reads >= 3 ? lags[reads - 3] : undefined;
        return Promise.resolve({ DBClusters: [{ ...cluster, ...lag }] });
      });
      await updateCluster(
        {
          EnableCloudwatchLogsExports: ['profiler'],
          ServerlessV2ScalingConfiguration: { MinCapacity: 1, MaxCapacity: 4 },
        },
        {
          EnableCloudwatchLogsExports: ['audit'],
          ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
        }
      );
      expect(reads).toBe(7);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns instead of failing when a change never reads back', async () => {
      const cluster = armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DescribeDBClustersCommand'
          ? Promise.resolve({ DBClusters: [{ ...cluster, NetworkType: 'IPV4' }] })
          : answer(cmd)
      );
      const realNow = Date.now;
      let now = 0;
      Date.now = () => (now += 60_000);
      try {
        await updateCluster({ NetworkType: 'DUAL' }, { NetworkType: 'IPV4' });
      } finally {
        Date.now = realNow;
      }
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NetworkType did not read back'));
    });

    it('--no-wait makes no read-back wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      armCluster();
      await updateCluster({ NetworkType: 'DUAL' }, { NetworkType: 'IPV4' });
      expect(sent('DescribeDBClustersCommand')).toHaveLength(1);
    });
  });

  describe('kept removals (CloudFormation A/B, #2762)', () => {
    it('sends no reset, naming the measured keys and the unmeasured ones apart', async () => {
      armCluster();
      await updateCluster(
        {},
        {
          CopyTagsToSnapshot: true,
          EnableCloudwatchLogsExports: ['audit'],
          StorageType: 'iopt1',
          ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
          MasterUserSecretKmsKeyId: KEY_ARN,
          NetworkType: 'DUAL',
          ManageMasterUserPassword: true,
        }
      );
      const input = sent('ModifyDBClusterCommand')[0]!;
      for (const key of [
        'CopyTagsToSnapshot',
        'CloudwatchLogsExportConfiguration',
        'StorageType',
        'ServerlessV2ScalingConfiguration',
        'MasterUserSecretKmsKeyId',
        'NetworkType',
        'ManageMasterUserPassword',
      ]) {
        expect(input[key]).toBeUndefined();
      }
      const lines = warn.mock.calls.map(([line]) => line as string);
      expect(lines).toEqual([
        'L (AWS::DocDB::DBCluster): properties CopyTagsToSnapshot, EnableCloudwatchLogsExports, StorageType, ServerlessV2ScalingConfiguration, MasterUserSecretKmsKeyId were removed from the template; cdkd leaves the current AWS values in place, as CloudFormation does. Declare them to change them.',
        'L (AWS::DocDB::DBCluster): properties NetworkType, ManageMasterUserPassword were removed from the template; cdkd leaves the current AWS values in place. Declare them to change them.',
      ]);
    });

    it('a rollback restoring a state without the log list disables nothing', async () => {
      armCluster({ EnabledCloudwatchLogsExports: ['audit'] });
      await updateCluster({}, { EnableCloudwatchLogsExports: ['audit'] }, { replayingState: true });
      expect(sent('ModifyDBClusterCommand')[0]!['CloudwatchLogsExportConfiguration']).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('absent from the state'));
    });

    it('sends no instance reset and warns', async () => {
      armInstance();
      await updateInstance(
        {},
        { CACertificateIdentifier: 'rds-ca-rsa4096-g1', EnablePerformanceInsights: true }
      );
      const input = sent('ModifyDBInstanceCommand')[0]!;
      expect(input['CACertificateIdentifier']).toBeUndefined();
      expect(input['EnablePerformanceInsights']).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('CACertificateIdentifier, EnablePerformanceInsights were removed')
      );
    });

    it('declares every new key handled in update()', () => {
      const cluster = provider.removalHandledInUpdate.get(CLUSTER)!;
      for (const key of [
        'AvailabilityZones',
        'CopyTagsToSnapshot',
        'EnableCloudwatchLogsExports',
        'ManageMasterUserPassword',
        'MasterUserSecretKmsKeyId',
        'NetworkType',
        'RotateMasterUserPassword',
        'ServerlessV2ScalingConfiguration',
        'StorageType',
      ]) {
        expect(cluster.has(key)).toBe(true);
      }
    });
  });

  describe('instance certificate and Performance Insights', () => {
    it('create sends both and no restart flag, which CreateDBInstance lacks', async () => {
      armInstance();
      await provider.create('L', INSTANCE, {
        DBInstanceClass: 'db.r6g.large',
        DBClusterIdentifier: 'c',
        CACertificateIdentifier: 'rds-ca-rsa4096-g1',
        CertificateRotationRestart: false,
        EnablePerformanceInsights: true,
      });
      const input = sent('CreateDBInstanceCommand')[0]!;
      expect(input).toMatchObject({
        CACertificateIdentifier: 'rds-ca-rsa4096-g1',
        EnablePerformanceInsights: true,
      });
      expect(input['CertificateRotationRestart']).toBeUndefined();
    });

    it('the restart flag rides a certificate change only', async () => {
      armInstance({ CACertificateIdentifier: 'rds-ca-rsa4096-g1' });
      await updateInstance(
        { CACertificateIdentifier: 'rds-ca-rsa2048-g1', CertificateRotationRestart: false },
        { CACertificateIdentifier: 'rds-ca-rsa4096-g1' }
      );
      expect(sent('ModifyDBInstanceCommand')[0]).toMatchObject({
        CACertificateIdentifier: 'rds-ca-rsa2048-g1',
        CertificateRotationRestart: false,
      });
      mockSend.mockClear();
      armInstance({ CACertificateIdentifier: 'rds-ca-rsa2048-g1' });
      const bag = {
        CACertificateIdentifier: 'rds-ca-rsa2048-g1',
        CertificateRotationRestart: false,
        EnablePerformanceInsights: true,
      };
      await updateInstance({ ...bag, DBInstanceClass: 'db.r6g.xlarge' }, bag);
      const input = sent('ModifyDBInstanceCommand')[0]!;
      expect(input['CACertificateIdentifier']).toBeUndefined();
      expect(input['CertificateRotationRestart']).toBeUndefined();
      expect(input['EnablePerformanceInsights']).toBeUndefined();
    });

    it('a declared false the record lacks equals the unset live default', async () => {
      armInstance();
      await updateInstance({ EnablePerformanceInsights: false }, {});
      expect(sent('ModifyDBInstanceCommand')[0]!['EnablePerformanceInsights']).toBeUndefined();
    });

    it('resends a change refused with the measured not-available text', async () => {
      armInstance();
      mockSend.mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error('Database instance is not in available state.'), {
            name: 'InvalidDBInstanceStateFault',
          })
        )
      );
      await updateInstance(
        { EnablePerformanceInsights: true },
        { EnablePerformanceInsights: false }
      );
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(2);
    });

    it('does not retry a member refused because its cluster is being stopped', async () => {
      mockSend.mockRejectedValue(
        Object.assign(new Error('DB cluster c-zr6jidsdpumw is being stopped.'), {
          name: 'InvalidDBClusterStateFault',
        })
      );
      await expect(
        updateInstance({ EnablePerformanceInsights: true }, { EnablePerformanceInsights: false })
      ).rejects.toThrow(/Failed to update DocDB DBInstance/);
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

    it('waits for a changed certificate and insights to read back, each alone', async () => {
      const instance = armInstance({
        CACertificateIdentifier: 'rds-ca-rsa4096-g1',
        PerformanceInsightsEnabled: false,
      });
      const answer = mockSend.getMockImplementation()!;
      let lagging = 2;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'DescribeDBInstancesCommand' && lagging > 0) {
          lagging -= 1;
          return Promise.resolve({
            DBInstances: [
              {
                ...instance,
                // First read: the certificate alone lags. Second: insights alone.
                ...(lagging === 1 && { CACertificateIdentifier: 'rds-ca-rsa4096-g1' }),
                ...(lagging === 0 && { PerformanceInsightsEnabled: false }),
              },
            ],
          });
        }
        return answer(cmd);
      });
      await updateInstance(
        { CACertificateIdentifier: 'rds-ca-rsa2048-g1', EnablePerformanceInsights: true },
        { CACertificateIdentifier: 'rds-ca-rsa4096-g1', EnablePerformanceInsights: false }
      );
      // Two lagging reads, the settled one, and the attributes read.
      expect(sent('DescribeDBInstancesCommand')).toHaveLength(4);
      expect(warn).not.toHaveBeenCalled();
    });

    it('makes no read-back wait under --no-wait, nor without a change', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      armInstance();
      await updateInstance(
        { CACertificateIdentifier: 'rds-ca-rsa2048-g1' },
        { CACertificateIdentifier: 'rds-ca-rsa4096-g1' }
      );
      expect(sent('DescribeDBInstancesCommand')).toHaveLength(1);
      delete process.env['CDKD_NO_WAIT'];
      mockSend.mockClear();
      armInstance();
      await updateInstance({ DBInstanceClass: 'db.r6g.xlarge' }, {});
      expect(sent('DescribeDBInstancesCommand')).toHaveLength(1);
    });

    it('sends a string true as the boolean, and compares it with the record', async () => {
      armInstance();
      await updateInstance(
        { EnablePerformanceInsights: 'true' },
        { EnablePerformanceInsights: false }
      );
      expect(sent('ModifyDBInstanceCommand')[0]!['EnablePerformanceInsights']).toBe(true);
      mockSend.mockClear();
      armInstance();
      await updateInstance(
        { EnablePerformanceInsights: 'true' },
        { EnablePerformanceInsights: true }
      );
      expect(sent('ModifyDBInstanceCommand')[0]!['EnablePerformanceInsights']).toBeUndefined();
    });

    it.each([
      ['update', () => updateInstance({ EnablePerformanceInsights: 'yes' }, {})],
      [
        'create',
        () =>
          provider.create('L', INSTANCE, {
            DBInstanceClass: 'db.r6g.large',
            DBClusterIdentifier: 'c',
            EnablePerformanceInsights: 'yes',
          }),
      ],
    ])('refuses an EnablePerformanceInsights that is no boolean on %s', async (_name, call) => {
      armInstance();
      await expect(call()).rejects.toThrow(
        /DocDB DBInstance L: EnablePerformanceInsights must be a boolean/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a state-borne update leaves an unusable EnablePerformanceInsights out, warned', async () => {
      armInstance();
      await updateInstance({ EnablePerformanceInsights: 'yes' }, {}, { replayingState: true });
      expect(sent('ModifyDBInstanceCommand')[0]!['EnablePerformanceInsights']).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('recorded EnablePerformanceInsights is unusable')
      );
    });

    it('a replayed create leaves it out with a warning too', async () => {
      armInstance();
      await provider.create(
        'L',
        INSTANCE,
        { DBClusterIdentifier: 'c', DBInstanceClass: 'x', EnablePerformanceInsights: 'yes' },
        { replayingState: true } as never
      );
      expect(sent('CreateDBInstanceCommand')[0]!['EnablePerformanceInsights']).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('drift and convergence', () => {
    it('reads the new keys, with the defaults AWS leaves out', async () => {
      armCluster();
      expect(await provider.readCurrentState('c', 'L', CLUSTER)).toMatchObject({
        CopyTagsToSnapshot: false,
        EnableCloudwatchLogsExports: [],
        ManageMasterUserPassword: false,
        StorageType: 'standard',
      });
      armInstance({ CACertificateIdentifier: 'rds-ca-rsa4096-g1' });
      expect(await provider.readCurrentState('i', 'L', INSTANCE)).toMatchObject({
        CACertificateIdentifier: 'rds-ca-rsa4096-g1',
        EnablePerformanceInsights: false,
      });
    });

    it('leaves per-call flags and spelled keys out of drift', () => {
      expect(provider.getDriftUnknownPaths(CLUSTER)).toEqual([
        'AvailabilityZones',
        'MasterUserSecretKmsKeyId',
        'RotateMasterUserPassword',
      ]);
      expect(provider.getDriftUnknownPaths(INSTANCE)).toEqual(['CertificateRotationRestart']);
    });

    it('marks a sent key unsettled before the call, and no credential key', async () => {
      armCluster();
      const marked: string[] = [];
      await updateCluster(
        {
          StorageType: 'iopt1',
          ManageMasterUserPassword: true,
          MasterUserSecretKmsKeyId: KEY_ARN,
        },
        { StorageType: 'standard' },
        { markUnsettled: (key: string) => marked.push(key) }
      );
      expect(marked).toEqual(['StorageType']);
    });

    it('marks a sent instance key unsettled', async () => {
      armInstance();
      const marked: string[] = [];
      await updateInstance(
        { CACertificateIdentifier: 'rds-ca-rsa2048-g1' },
        { CACertificateIdentifier: 'rds-ca-rsa4096-g1' },
        { markUnsettled: (key: string) => marked.push(key) }
      );
      expect(marked).toEqual(['CACertificateIdentifier']);
    });

    it('reads a reordered log list as no drift', () => {
      expect(
        calculateResourceDrift(
          { EnableCloudwatchLogsExports: ['audit', 'profiler'] },
          { EnableCloudwatchLogsExports: ['profiler', 'audit'] },
          { unorderedPaths: provider.getDriftUnorderedPaths(CLUSTER) }
        )
      ).toEqual([]);
    });

    it('marks a type this call added, not one AWS already held', async () => {
      armCluster({ EnabledCloudwatchLogsExports: ['audit'] });
      const markAttempted = vi.fn();
      await updateCluster(
        { EnableCloudwatchLogsExports: ['audit', 'profiler'] },
        {},
        { markAttempted }
      );
      expect(markAttempted).toHaveBeenCalledWith('EnableCloudwatchLogsExports', ['profiler']);
    });

    it('readUnsettled keeps an out-of-band log type off the previous side', async () => {
      armCluster({ EnabledCloudwatchLogsExports: ['audit', 'oob'] });
      expect(
        await provider.readUnsettled(
          'c',
          'L',
          CLUSTER,
          new Set(['EnableCloudwatchLogsExports']),
          { EnableCloudwatchLogsExports: ['audit'] },
          {},
          new Map()
        )
      ).toMatchObject({ EnableCloudwatchLogsExports: ['audit'] });
    });

    it('readUnsettled keeps what the template or an earlier attempt names', async () => {
      armCluster({ EnabledCloudwatchLogsExports: ['audit', 'profiler', 'attempted', 'oob'] });
      expect(
        await provider.readUnsettled(
          'c',
          'L',
          CLUSTER,
          new Set(['EnableCloudwatchLogsExports']),
          { EnableCloudwatchLogsExports: ['audit'] },
          { EnableCloudwatchLogsExports: ['profiler'] },
          new Map([['EnableCloudwatchLogsExports', new Set(['attempted'])]])
        )
      ).toMatchObject({ EnableCloudwatchLogsExports: ['audit', 'profiler', 'attempted'] });
    });

    it('a gone cluster reads as gone', async () => {
      mockSend.mockRejectedValue(
        Object.assign(new Error('gone'), { name: 'DBClusterNotFoundFault' })
      );
      expect(
        await provider.readUnsettled('c', 'L', CLUSTER, new Set(['EnableCloudwatchLogsExports']))
      ).toBe(RESOURCE_NOT_FOUND);
    });

    it('holds every name while AWS is moving the resource, and none after an update', async () => {
      const names = new Set(['StorageType']);
      armCluster({ Status: 'modifying' });
      expect(await provider.unsettledInTransition('c', 'L', CLUSTER, names)).toBe(names);
      expect((await provider.unsettledInTransition('c', 'L', CLUSTER, names, {}, {})).size).toBe(0);
      armCluster({ Status: 'backing-up' });
      expect((await provider.unsettledInTransition('c', 'L', CLUSTER, names)).size).toBe(0);
      armInstance({ PendingModifiedValues: { CACertificateIdentifier: 'x' } });
      expect(await provider.unsettledInTransition('i', 'L', INSTANCE, names)).toBe(names);
      armInstance({ PendingModifiedValues: {} });
      expect((await provider.unsettledInTransition('i', 'L', INSTANCE, names)).size).toBe(0);
      mockSend.mockRejectedValue(new Error('throttled'));
      expect(await provider.unsettledInTransition('c', 'L', CLUSTER, names)).toBe(names);
    });

    it('reads a nested-empty PendingCloudwatchLogsExports as idle, and a held one as moving', () => {
      expect(
        holdsDocDBPendingValue({
          PendingCloudwatchLogsExports: { LogTypesToEnable: [], LogTypesToDisable: [] },
        })
      ).toBe(false);
      expect(
        holdsDocDBPendingValue({
          PendingCloudwatchLogsExports: { LogTypesToEnable: ['audit'] },
        })
      ).toBe(true);
    });

    it('reads no list out of a non-string member, and an absent one as empty', () => {
      expect(docdbStringList(['audit', 1])).toBeUndefined();
      expect(docdbStringList(null)).toEqual([]);
    });

    it.each([[''], ['  '], [true], [null]])('reads capacity %j as none', (value) => {
      expect(docdbServerlessScaling({ MinCapacity: value, MaxCapacity: 2 })).toBeNull();
    });

    it('dedupes both sides of a log delta', () => {
      expect(docdbLogExportChange(['audit', 'audit'], ['profiler', 'profiler'])).toEqual({
        EnableLogTypes: ['audit'],
        DisableLogTypes: ['profiler'],
      });
    });

    it('compares a repeated log type and a capacity string as what they mean', () => {
      expect(
        provider.canonicalizeUnsettledProperties(CLUSTER, {
          EnableCloudwatchLogsExports: ['audit', 'audit'],
          ServerlessV2ScalingConfiguration: { MinCapacity: '1', MaxCapacity: 2 },
        })
      ).toEqual({
        EnableCloudwatchLogsExports: ['audit'],
        ServerlessV2ScalingConfiguration: { MinCapacity: 1, MaxCapacity: 2 },
      });
      const instanceBag = { Tags: [] };
      expect(provider.canonicalizeDriftProperties(INSTANCE, instanceBag)).toBe(instanceBag);
    });
  });
});
