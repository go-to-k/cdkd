import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';

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
