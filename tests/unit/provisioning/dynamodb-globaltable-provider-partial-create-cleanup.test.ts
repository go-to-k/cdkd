import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DeleteTableCommand,
  ResourceNotFoundException,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
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

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';

describe('DynamoDBGlobalTableProvider partial-create cleanup (Issue #376-class)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new DynamoDBGlobalTableProvider();
  });

  const baseProps = {
    TableName: 'my-test-table-xxx',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
    Replicas: [{ Region: 'us-east-1' }],
  };

  it('issues DeleteTableCommand when waitForTableActive fails after CreateTable succeeded', async () => {
    // CreateTable succeeds → DescribeTable returns a non-ACTIVE / non-CREATING
    // status that throws inside waitForTableActive → cleanup must DeleteTable.
    mockSend.mockResolvedValueOnce({}); // CreateTable
    mockSend.mockResolvedValueOnce({
      Table: { TableName: 'my-test-table-xxx', TableStatus: 'CREATE_FAILED' },
    }); // waitForTableActive -> unexpected status
    mockSend.mockResolvedValueOnce({}); // DeleteTable cleanup

    await expect(provider.create('MyTable', RESOURCE_TYPE, baseProps)).rejects.toThrow(
      'Failed to create DynamoDB GlobalTable'
    );

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names[0]).toBe('CreateTableCommand');
    expect(names).toContain('DeleteTableCommand');
    const deleteCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof DeleteTableCommand
    );
    expect(deleteCall?.[0].input).toEqual({ TableName: 'my-test-table-xxx' });
  });

  it('does NOT issue DeleteTableCommand when CreateTable itself fails', async () => {
    // CreateTable rejects on the first call → AWS never committed the
    // table, so the cleanup path must be skipped (an unconditional Delete
    // would just produce a misleading NotFoundException).
    mockSend.mockRejectedValueOnce(new Error('CreateTable boom'));

    await expect(provider.create('MyTable', RESOURCE_TYPE, baseProps)).rejects.toThrow(
      'Failed to create DynamoDB GlobalTable'
    );

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['CreateTableCommand']);
    expect(names).not.toContain('DeleteTableCommand');
  });

  it('original error propagates with a recovery-command WARN when cleanup itself fails', async () => {
    // CreateTable succeeds → waitForTableActive fails → DeleteTable cleanup
    // ALSO fails. Original wiring error must still propagate, with a WARN
    // line carrying the `aws dynamodb delete-table` recovery hint so the
    // user can clean up the orphaned AWS-side table by hand.
    mockSend.mockResolvedValueOnce({}); // CreateTable
    mockSend.mockResolvedValueOnce({
      Table: { TableName: 'my-test-table-xxx', TableStatus: 'CREATE_FAILED' },
    });
    mockSend.mockRejectedValueOnce(new Error('cleanup boom')); // DeleteTable cleanup fails

    await expect(provider.create('MyTable', RESOURCE_TYPE, baseProps)).rejects.toThrow(
      /Failed to create DynamoDB GlobalTable/
    );

    // Ensure the recovery-hint WARN fired (one of the warn calls' first
    // arg must contain the recovery-command substring).
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('aws dynamodb delete-table');
    expect(warned).toContain('my-test-table-xxx');
  });

  it('cleanup also fires when replica add (UpdateTable) fails post-create', async () => {
    // CreateTable succeeds → waitForTableActive succeeds → UpdateTable
    // for the second replica throws → cleanup runs DeleteTable.
    mockSend.mockResolvedValueOnce({}); // CreateTable
    mockSend.mockResolvedValueOnce({
      Table: { TableName: 'my-test-table-xxx', TableStatus: 'ACTIVE', TableArn: 'a' },
    }); // waitForTableActive
    mockSend.mockRejectedValueOnce(new Error('UpdateTable replica boom'));
    mockSend.mockResolvedValueOnce({}); // DeleteTable cleanup

    await expect(
      provider.create('MyTable', RESOURCE_TYPE, {
        ...baseProps,
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
      })
    ).rejects.toThrow('Failed to create DynamoDB GlobalTable');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toContain('DeleteTableCommand');
  });

  it('drops non-local replicas before DeleteTable when cleanup runs on a multi-replica table (PR #388 review blocker fix)', async () => {
    // Pre-fix: cleanup issued a bare DeleteTable, which AWS rejects
    // on a multi-replica table — orphaning the just-added replica
    // with no cdkd state record. Post-fix: cleanup mirrors delete():
    // DescribeTable → per-region Delete ReplicaUpdates → DeleteTable.
    mockSend.mockResolvedValueOnce({}); // CreateTable
    mockSend.mockResolvedValueOnce({
      Table: { TableName: 'my-test-table-xxx', TableStatus: 'ACTIVE', TableArn: 'a' },
    }); // waitForTableActive
    // addReplica eu-west-1 -> UpdateTable Create -> wait Active happens
    // serially. Simulate the FIRST addReplica succeeds, then the
    // SECOND throws. The test queues:
    //   3. UpdateTable Create eu-west-1 -> ok
    //   4. DescribeTable for waitForReplicaActive eu-west-1 -> ACTIVE
    //   5. UpdateTable Create ap-south-1 -> throw (wiring failure)
    mockSend.mockResolvedValueOnce({}); // UpdateTable Create eu-west-1
    mockSend.mockResolvedValueOnce({
      Table: { Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }] },
    });
    mockSend.mockRejectedValueOnce(new Error('UpdateTable replica ap-south-1 boom'));
    // Cleanup path:
    //   6. DescribeTable -> Replicas[eu-west-1] (the one that partially
    //      succeeded; ap-south-1 didn't because its Create threw)
    //   7. UpdateTable Delete eu-west-1 -> ok
    //   8. waitForReplicaGone DescribeTable -> RNF (replica gone)
    //   9. DeleteTable -> ok
    mockSend.mockResolvedValueOnce({
      Table: { Replicas: [{ RegionName: 'eu-west-1' }] },
    });
    mockSend.mockResolvedValueOnce({}); // UpdateTable Delete eu-west-1
    const rnf = new (ResourceNotFoundException as new (args: {
      message: string;
      $metadata: Record<string, unknown>;
    }) => ResourceNotFoundException)({
      message: 'gone',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(rnf); // waitForReplicaGone -> RNF returns
    mockSend.mockResolvedValueOnce({}); // DeleteTable

    await expect(
      provider.create('MyTable', RESOURCE_TYPE, {
        ...baseProps,
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [
          { Region: 'us-east-1' },
          { Region: 'eu-west-1' },
          { Region: 'ap-south-1' },
        ],
      })
    ).rejects.toThrow('Failed to create DynamoDB GlobalTable');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    // Cleanup must issue a Delete ReplicaUpdates for eu-west-1 BEFORE
    // the final DeleteTable.
    const cleanupDelete = mockSend.mock.calls.find(
      (c) =>
        c[0] instanceof UpdateTableCommand &&
        (c[0].input.ReplicaUpdates?.[0] as { Delete?: { RegionName: string } })?.Delete
          ?.RegionName === 'eu-west-1'
    );
    expect(cleanupDelete).toBeDefined();
    expect(names).toContain('DeleteTableCommand');
    // Order: every UpdateTable(Delete) happens BEFORE the final
    // DeleteTable. Find the last UpdateTable(Delete) and assert it
    // precedes the DeleteTable index.
    const lastReplicaDelete = mockSend.mock.calls.findLastIndex(
      (c) =>
        c[0] instanceof UpdateTableCommand &&
        ((c[0].input.ReplicaUpdates?.[0] as { Delete?: { RegionName: string } })?.Delete
          ?.RegionName ?? '') !== ''
    );
    const finalDelete = mockSend.mock.calls.findIndex((c) => c[0] instanceof DeleteTableCommand);
    expect(lastReplicaDelete).toBeGreaterThan(-1);
    expect(finalDelete).toBeGreaterThan(lastReplicaDelete);
  });

  it('uses CreateTableCommand as the first call (sanity)', async () => {
    // Defensive guard against future refactors accidentally swapping the
    // CreateTable wire order.
    mockSend.mockResolvedValueOnce({}); // CreateTable
    mockSend.mockResolvedValueOnce({
      Table: { TableName: 'my-test-table-xxx', TableStatus: 'ACTIVE', TableArn: 'a' },
    });

    await provider.create('MyTable', RESOURCE_TYPE, baseProps);

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(CreateTableCommand);
  });
});
