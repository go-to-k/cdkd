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

const { mockSend, regionalSend, mockAutoScalingSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  regionalSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
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
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
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
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
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
    expect(error?.message).toContain('Re-run cdkd destroy --remove-protection');
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
    // Not a destroy: a deploy's replacement or removal delete cannot take the flag.
    expect(error?.message).toContain('a deploy never removes it');
    expect(error?.message).not.toContain('--remove-protection');
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
});
