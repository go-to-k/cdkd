import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DeleteTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * go-to-k/cdkd#6367: without `--remove-protection`, `delete()` dropped every
 * cross-region replica first and only then sent `DeleteTable`. A protected
 * LOCAL table refused that call after the other regions' copies were already
 * gone, and a protected cross-region replica refused its own drop after the
 * replicas before it. The delete now reads every copy's flag before its first
 * write and refuses as a whole.
 *
 * The harness mirrors `dynamodb-globaltable-provider-replica-settings-5355`:
 * the source region is `us-east-1` (`mockSend`), the region-scoped client for
 * `eu-west-1` is `regionalSend`.
 */

const { mockSend, regionalSend, mockAutoScalingSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  regionalSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn((cfg: { region?: string } | undefined) => ({
      send: cfg?.region === 'eu-west-1' ? regionalSend : mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { InterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import { protectedDeleteMessage } from '../../../src/provisioning/providers/dynamodb-globaltable/protection-preflight.js';
import { replicaDeleteGoneWait } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'gt-6367';

type Sent = { constructor: { name: string }; input: Record<string, any> };
const writes = (fn: ReturnType<typeof vi.fn>): string[] =>
  fn.mock.calls
    .map((c) => (c[0] as Sent).constructor.name)
    .filter((n) => n !== DescribeTableCommand.name);

/** The source table: `eu-west-1` listed until dropped, gone after DeleteTable. */
const sourceTable = (localProtected: boolean): void => {
  let replicaGone = false;
  let tableGone = false;
  mockSend.mockImplementation(async (command: Sent) => {
    const name = command.constructor.name;
    if (name === UpdateTableCommand.name && command.input['ReplicaUpdates']?.[0]?.Delete) {
      replicaGone = true;
      return {};
    }
    if (name === DeleteTableCommand.name) {
      tableGone = true;
      return {};
    }
    if (name === DescribeTableCommand.name && tableGone) {
      throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
    }
    return {
      Table: {
        TableName: TABLE,
        TableStatus: 'ACTIVE',
        DeletionProtectionEnabled: localProtected,
        Replicas: [
          { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
          ...(replicaGone ? [] : [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }]),
        ],
      },
    };
  });
};

/** The eu-west-1 copy, read in its own region; RNF once the drop landed. */
const regionalTable = (answer: { protected: boolean } | Error): void => {
  let dropped = false;
  regionalSend.mockImplementation(async (command: Sent) => {
    if (command.constructor.name !== DescribeTableCommand.name) return {};
    if (answer instanceof Error) throw answer;
    if (dropped || mockSend.mock.calls.some((c) => (c[0] as Sent).input['ReplicaUpdates'])) {
      dropped = true;
      throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
    }
    return { Table: { TableName: TABLE, TableStatus: 'ACTIVE', DeletionProtectionEnabled: answer.protected } };
  });
};

describe('GlobalTable delete refuses BEFORE any write when a copy is protected (go-to-k/cdkd#6367)', () => {
  const waitDefaults = { ...replicaDeleteGoneWait };
  afterEach(() => {
    Object.assign(replicaDeleteGoneWait, waitDefaults);
  });
  beforeEach(() => {
    mockSend.mockReset();
    regionalSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    replicaDeleteGoneWait.pollIntervalMs = 0;
  });

  it('a protected LOCAL table: no replica is dropped, no DeleteTable is sent', async () => {
    sourceTable(true);
    regionalTable({ protected: false });

    const error = await new DynamoDBGlobalTableProvider()
      .delete('T', TABLE, RESOURCE_TYPE, undefined, { stackDestroy: true })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(error?.message).toMatch(
      /deletion protection enabled in us-east-1; cdkd changed nothing, so no replica was dropped/
    );
    expect(error?.message).toContain('Re-run the destroy with --remove-protection');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(writes(mockSend)).toEqual([]);
    expect(writes(regionalSend)).toEqual([]);
    expect(mockAutoScalingSend).not.toHaveBeenCalled();
  });

  it('a protected CROSS-REGION replica: refused the same way, naming that region', async () => {
    sourceTable(false);
    regionalTable({ protected: true });

    const error = await new DynamoDBGlobalTableProvider()
      .delete('T', TABLE, RESOURCE_TYPE)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(error?.message).toMatch(/deletion protection enabled in eu-west-1; cdkd changed nothing/);
    // Not a destroy: the remedy names no destroy re-run.
    expect(error?.message).toContain('Turn deletion protection off in those regions');
    expect(error?.message).not.toContain('Re-run the destroy');
    expect(writes(mockSend)).toEqual([]);
    expect(writes(regionalSend)).toEqual([]);
    expect(mockAutoScalingSend).not.toHaveBeenCalled();
  });

  it('a THROTTLED replica read is rethrown before any write, so the destroy loop reads again', async () => {
    sourceTable(false);
    regionalTable(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }));

    const error = await new DynamoDBGlobalTableProvider()
      .delete('T', TABLE, RESOURCE_TYPE, undefined, { stackDestroy: true })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    // Still retryable, so the destroy loop re-enters and reads again.
    expect(error).toBeInstanceOf(Error);
    expect(isMarkedNonRetryable(error)).toBe(false);
    // Reading a throttle as "not protected" would reopen the partial strip.
    expect(writes(mockSend)).toEqual([]);
    expect(writes(regionalSend)).toEqual([]);
    expect(mockAutoScalingSend).not.toHaveBeenCalled();
  });

  it('a replica that reads ResourceNotFound is skipped, not refused', async () => {
    sourceTable(false);
    regionalTable(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));

    await expect(
      new DynamoDBGlobalTableProvider().delete('T', TABLE, RESOURCE_TYPE)
    ).resolves.toBeUndefined();

    expect(writes(mockSend)).toContain(DeleteTableCommand.name);
  });

  it('an interrupt during the replica read is rethrown before any write', async () => {
    sourceTable(false);
    regionalTable(new InterruptedWaitError('DescribeTable'));

    await expect(
      new DynamoDBGlobalTableProvider().delete('T', TABLE, RESOURCE_TYPE)
    ).rejects.toThrow(/interrupted by user/);

    expect(writes(mockSend)).toEqual([]);
    expect(writes(regionalSend)).toEqual([]);
  });

  it('an UNREADABLE replica flag proceeds, so a least-privilege destroy still runs', async () => {
    sourceTable(false);
    regionalTable(Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }));

    await expect(
      new DynamoDBGlobalTableProvider().delete('T', TABLE, RESOURCE_TYPE, undefined, {
        stackDestroy: true,
      })
    ).resolves.toBeUndefined();

    // Proceeding is announced, naming the region it could not read.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Could not read DeletionProtectionEnabled on the eu-west-1 replica'
    );
    // The drop and the DeleteTable both went out.
    expect(
      mockSend.mock.calls.some((c) => (c[0] as Sent).input['ReplicaUpdates']?.[0]?.Delete)
    ).toBe(true);
    expect(writes(mockSend)).toContain(DeleteTableCommand.name);
  });

  it('nothing protected: the delete runs as before', async () => {
    sourceTable(false);
    regionalTable({ protected: false });

    await expect(
      new DynamoDBGlobalTableProvider().delete('T', TABLE, RESOURCE_TYPE)
    ).resolves.toBeUndefined();

    expect(writes(mockSend)).toContain(DeleteTableCommand.name);
  });

  it('a re-entry after an earlier attempt dropped a replica does not claim none was dropped', () => {
    const text = protectedDeleteMessage('T', TABLE, ['us-east-1'], true, ['eu-west-1']);
    expect(text).toContain('an earlier attempt already dropped the replica in eu-west-1');
    expect(text).not.toContain('no replica was dropped');
    expect(protectedDeleteMessage('T', TABLE, ['us-east-1'], true, [])).toContain(
      'no replica was dropped'
    );
  });
});
