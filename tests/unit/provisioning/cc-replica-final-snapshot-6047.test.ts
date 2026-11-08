import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6047: a Cloud Control-routed `AWS::RDS::DBInstance` under
 * `DeletionPolicy: Snapshot` (or `UpdateReplacePolicy: Snapshot`) that is a
 * LIVE read replica, or a live cluster member, is deleted without a final
 * snapshot, as CloudFormation's RDS delete handler does, instead of being refused because Cloud Control has
 * no final-snapshot parameter. Anything the live read cannot confirm keeps the
 * refusal. The destroy site is pinned in
 * `tests/unit/cli/destroy-runner-deletion-policy-snapshot.test.ts`; this file
 * pins the shared predicate and the replacement and rollback sites.
 */

const mockSend = vi.hoisted(() => vi.fn());
const mockRdsClientCtor = vi.hoisted(() => vi.fn());
const mockDestroy = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation((config: unknown) => {
      mockRdsClientCtor(config);
      return { send: mockSend, destroy: mockDestroy };
    }),
  };
});

import {
  ccRoutedInstanceTakesNoSnapshot,
  ccRoutedFinalSnapshotError,
} from '../../../src/provisioning/final-snapshot.js';
import { prepareFinalSnapshotForDelete } from '../../../src/deployment/deploy-engine/replacement/delete-context.js';
import type { ReplacementDeps } from '../../../src/deployment/deploy-engine/replacement/run-state.js';
import { prepareCreateRollbackFinalSnapshot } from '../../../src/deployment/rollback-executor/names.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor/types.js';

const REGION = 'eu-west-1';

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function liveInstance(fields: Record<string, unknown>) {
  mockSend.mockResolvedValue({ DBInstances: [{ DBInstanceIdentifier: 'db-1', ...fields }] });
}

function sentIdentifier(): unknown {
  expect(mockSend).toHaveBeenCalledTimes(1);
  const command = mockSend.mock.calls[0]![0] as { constructor: { name: string }; input: unknown };
  expect(command.constructor.name).toBe('DescribeDBInstancesCommand');
  return (command.input as { DBInstanceIdentifier?: unknown }).DBInstanceIdentifier;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ccRoutedInstanceTakesNoSnapshot', () => {
  const base = {
    resourceType: 'AWS::RDS::DBInstance',
    logicalId: 'Replica',
    physicalId: 'db-1',
    region: REGION,
  };

  it.each([
    ['an instance', { ReadReplicaSourceDBInstanceIdentifier: 'source-db' }],
    ['a cluster', { ReadReplicaSourceDBClusterIdentifier: 'source-cluster' }],
  ])('a live replica of %s: true, read in the stack region, and says so', async (_l, fields) => {
    liveInstance(fields);
    const log = logger();
    expect(await ccRoutedInstanceTakesNoSnapshot({ ...base, logger: log })).toBe(true);
    expect(sentIdentifier()).toBe('db-1');
    expect(mockRdsClientCtor).toHaveBeenCalledWith(expect.objectContaining({ region: REGION }));
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Deleting Replica without a final snapshot: it is a read replica')
    );
    // Neutral on the attribute: a replacement's delete reads UpdateReplacePolicy.
    const line = String(log.info.mock.calls[0]![0]);
    expect(line).toContain('whose Snapshot policy CloudFormation ignores');
    expect(line).not.toContain('DeletionPolicy');
  });

  it("a live cluster member (the handler's other no-snapshot case): true", async () => {
    liveInstance({ DBClusterIdentifier: 'my-cluster' });
    const log = logger();
    expect(await ccRoutedInstanceTakesNoSnapshot({ ...base, logger: log })).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('without a final snapshot: it is a DB cluster member')
    );
  });

  it.each([
    ['a standalone instance (a replica promoted outside cdkd)', [{ DBInstanceIdentifier: 'db-1' }]],
    [
      'empty source and cluster fields',
      [
        {
          ReadReplicaSourceDBInstanceIdentifier: '',
          ReadReplicaSourceDBClusterIdentifier: '',
          DBClusterIdentifier: '',
        },
      ],
    ],
    ['no instance listed', []],
  ])('%s: false, nothing logged at info', async (_l, instances) => {
    mockSend.mockResolvedValue({ DBInstances: instances });
    const log = logger();
    expect(await ccRoutedInstanceTakesNoSnapshot({ ...base, logger: log })).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('a failed read fails closed: false, the reason WARNED (masked), not only at debug', async () => {
    const error = Object.assign(new Error('Access denied reading secret-db-name'), {
      name: 'AccessDenied',
    });
    mockSend.mockRejectedValue(error);
    const log = logger();
    const mask = (text: string) => text.replaceAll('secret-db-name', '***');
    expect(await ccRoutedInstanceTakesNoSnapshot({ ...base, logger: log, mask })).toBe(false);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const warned = String(log.warn.mock.calls[0]![0]);
    expect(warned).toContain('Could not read whether Replica is a read replica or cluster member');
    expect(warned).toContain('so its delete is refused');
    // AWS's reason, through the masker.
    expect(warned).toContain('Access denied reading ***');
    expect(warned).not.toContain('secret-db-name');
  });

  it.each([
    ['another atomic type', { resourceType: 'AWS::RDS::DBCluster' }],
    ['an unresolved region', { region: undefined }],
    ['an empty region', { region: '' }],
  ])('%s: false without any AWS call', async (_l, override) => {
    expect(await ccRoutedInstanceTakesNoSnapshot({ ...base, ...override, logger: logger() })).toBe(
      false
    );
    expect(mockRdsClientCtor).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('replacement / engine delete: prepareFinalSnapshotForDelete', () => {
  function deps(): ReplacementDeps {
    return {
      options: {},
      stackRegion: REGION,
      logger: logger(),
    } as unknown as ReplacementDeps;
  }
  const record = { physicalId: 'db-1', provisionedBy: 'cc-api' as const };

  it('a cc-api live replica: no identifier, no refusal', async () => {
    liveInstance({ ReadReplicaSourceDBInstanceIdentifier: 'source-db' });
    await expect(
      prepareFinalSnapshotForDelete(deps(), 'Replica', 'AWS::RDS::DBInstance', record, 'Snapshot')
    ).resolves.toBeUndefined();
    expect(sentIdentifier()).toBe('db-1');
  });

  it('a cc-api standalone instance: still refused with the Cloud Control error', async () => {
    liveInstance({});
    await expect(
      prepareFinalSnapshotForDelete(deps(), 'Db', 'AWS::RDS::DBInstance', record, 'Snapshot')
    ).rejects.toThrow(
      ccRoutedFinalSnapshotError('Db', 'AWS::RDS::DBInstance', '--skip-final-snapshot').message
    );
  });

  it('a cc-api instance whose read fails: still refused, the reason warned', async () => {
    mockSend.mockRejectedValue(new Error('Rate exceeded'));
    const d = deps();
    await expect(
      prepareFinalSnapshotForDelete(d, 'Db', 'AWS::RDS::DBInstance', record, 'Snapshot')
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_UNSUPPORTED' });
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Rate exceeded'));
  });

  it('another cc-api atomic type is refused without a read', async () => {
    await expect(
      prepareFinalSnapshotForDelete(deps(), 'Cl', 'AWS::RDS::DBCluster', record, 'Snapshot')
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_UNSUPPORTED' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the SDK route keeps its identifier and reads nothing here', async () => {
    const id = await prepareFinalSnapshotForDelete(
      deps(),
      'Replica',
      'AWS::RDS::DBInstance',
      { physicalId: 'db-1', provisionedBy: 'sdk' },
      'Snapshot'
    );
    expect(id).toEqual(expect.any(String));
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('rollback of a CREATE: prepareCreateRollbackFinalSnapshot', () => {
  function ctx(): RollbackExecutorContext {
    return { region: REGION, logger: logger() } as unknown as RollbackExecutorContext;
  }
  const op = { logicalId: 'Replica', resourceType: 'AWS::RDS::DBInstance', physicalId: 'db-1' };
  const identity = (text: string) => text;

  it('a cc-api live replica: no identifier, no refusal', async () => {
    liveInstance({ ReadReplicaSourceDBInstanceIdentifier: 'source-db' });
    await expect(
      prepareCreateRollbackFinalSnapshot(op, 'cc-api', ctx(), identity)
    ).resolves.toBeUndefined();
    expect(sentIdentifier()).toBe('db-1');
  });

  it('a cc-api standalone instance: still refused', async () => {
    liveInstance({});
    await expect(
      prepareCreateRollbackFinalSnapshot(op, 'cc-api', ctx(), identity)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_UNSUPPORTED' });
  });

  it('a cc-api instance whose read fails: still refused', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));
    await expect(
      prepareCreateRollbackFinalSnapshot(op, 'cc-api', ctx(), identity)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_UNSUPPORTED' });
  });
});
