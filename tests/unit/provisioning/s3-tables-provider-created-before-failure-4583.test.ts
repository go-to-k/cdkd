import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTableCommand } from '@aws-sdk/client-s3tables';

// go-to-k/cdkd#4583: a table CreateTable made, whose response then lacked the
// tableARN, is named by its composite id for `cdkd rollback --revert-failed`;
// the create call's own failure and a pre-flight refusal name nothing.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3tables', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-s3tables')>('@aws-sdk/client-s3tables');
  class MockS3TablesClient {
    config = { region: () => Promise.resolve('us-east-1') };
    send = mockSend;
  }
  return { ...actual, S3TablesClient: MockS3TablesClient };
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

import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::S3Tables::Table';
const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket';
const PHYSICAL_ID = `${BUCKET_ARN}|my_namespace|my_table`;
const props = {
  TableBucketARN: BUCKET_ARN,
  Namespace: 'my_namespace',
  TableName: 'my_table',
  OpenTableFormat: 'ICEBERG',
};

async function failure(
  provider: S3TablesProvider,
  properties: Record<string, unknown>
): Promise<unknown> {
  return provider.create('Tbl', TYPE, properties).then(
    () => expect.fail('create resolved'),
    (e: unknown) => e
  );
}

describe('S3TablesProvider createTable createdBeforeFailure mark (go-to-k/cdkd#4583)', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new S3TablesProvider();
  });

  it('marks the composite id when CreateTable returned no tableARN', async () => {
    mockSend.mockResolvedValueOnce({});
    const error = await failure(provider, props);
    expect(String(error)).toContain('did not return a tableARN');
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CreateTableCommand);
    expect(createdBeforeFailure(error, 'Tbl', TYPE)).toBe(PHYSICAL_ID);
  });

  it('does not mark when CreateTable itself fails', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('table exists'), { name: 'ConflictException' })
    );
    expect(createdBeforeFailure(await failure(provider, props), 'Tbl', TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal', async () => {
    const { TableName: _name, ...noName } = props;
    const error = await failure(provider, noName);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Tbl', TYPE)).toBeUndefined();
  });
});
