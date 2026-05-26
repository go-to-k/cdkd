import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3tables', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3tables')>(
    '@aws-sdk/client-s3tables'
  );
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

const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket';
const NAMESPACE_PHYSICAL_ID = `${BUCKET_ARN}|my-namespace`;
const TABLE_PHYSICAL_ID = `${BUCKET_ARN}|my-namespace|my-table`;

describe('S3TablesProvider read-update round-trip', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3TablesProvider();
  });

  // Mechanical guard for the 3 latent bug classes documented in
  // docs/provider-development.md § 3b "Read-update round-trip test".
  //
  // S3 Tables resources are immutable: update() is a documented no-op
  // that returns { physicalId, wasReplaced: false } without touching
  // AWS. The round-trip therefore must:
  //   - Class 1 (discriminator-dependent): N/A — no FIFO-style flags.
  //   - Class 2 (structurally-incomplete-when-empty): N/A — no nested
  //     placeholder objects (RedrivePolicy / VpcConfig style).
  //   - Truthy gate: N/A — update() does not gate on properties.
  // The structural assertion is "round-trip never sends ANY SDK call"
  // — any future regression that adds a real update() must explicitly
  // confirm round-trip safety here.

  it('AWS::S3Tables::TableBucket — no-op update fires zero SDK calls on round-trip', async () => {
    // readCurrentState mock: GetTableBucket
    mockSend.mockResolvedValueOnce({
      name: 'my-bucket',
      arn: BUCKET_ARN,
    });

    const observed = await provider.readCurrentState(
      BUCKET_ARN,
      'L',
      'AWS::S3Tables::TableBucket'
    );
    expect(observed).toEqual({ TableBucketName: 'my-bucket' });

    vi.clearAllMocks();

    // Round-trip: pass observed as both new and previous.
    const result = await provider.update(
      'L',
      BUCKET_ARN,
      'AWS::S3Tables::TableBucket',
      observed!,
      observed!
    );

    expect(result).toEqual({ physicalId: BUCKET_ARN, wasReplaced: false });
    // Immutable resource: update() must not call AWS at all.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('AWS::S3Tables::Namespace — no-op update fires zero SDK calls on round-trip', async () => {
    // readCurrentState for Namespace does no SDK call (physical id is
    // the source of truth).
    const observed = await provider.readCurrentState(
      NAMESPACE_PHYSICAL_ID,
      'L',
      'AWS::S3Tables::Namespace'
    );
    expect(observed).toEqual({
      TableBucketARN: BUCKET_ARN,
      Namespace: ['my-namespace'],
    });

    vi.clearAllMocks();

    const result = await provider.update(
      'L',
      NAMESPACE_PHYSICAL_ID,
      'AWS::S3Tables::Namespace',
      observed!,
      observed!
    );

    expect(result).toEqual({ physicalId: NAMESPACE_PHYSICAL_ID, wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('AWS::S3Tables::Table — no-op update fires zero SDK calls on round-trip', async () => {
    // readCurrentState mock: GetTable
    mockSend.mockResolvedValueOnce({
      name: 'my-table',
      format: 'ICEBERG',
      namespace: ['my-namespace'],
    });

    const observed = await provider.readCurrentState(
      TABLE_PHYSICAL_ID,
      'L',
      'AWS::S3Tables::Table'
    );
    expect(observed).toEqual({
      TableBucketARN: BUCKET_ARN,
      Namespace: 'my-namespace',
      Name: 'my-table',
      // CFn-canonical alias (#613 B-bucket fix).
      TableName: 'my-table',
      Format: 'ICEBERG',
    });

    vi.clearAllMocks();

    const result = await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::S3Tables::Table',
      observed!,
      observed!
    );

    expect(result).toEqual({ physicalId: TABLE_PHYSICAL_ID, wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('AWS::S3Tables::TableBucket — Format-less Table response: no Format key leaks to round-trip', async () => {
    // Defensive: if AWS GetTable ever returned without `format`,
    // readCurrentState must not synthesize a placeholder that
    // round-trips into a future update(). Today update() is a no-op so
    // the assertion is trivially satisfied; this test pins the contract
    // for any future provider that adds a real update().
    mockSend.mockResolvedValueOnce({
      name: 'my-table',
      // format intentionally undefined
      namespace: ['my-namespace'],
    });

    const observed = await provider.readCurrentState(
      TABLE_PHYSICAL_ID,
      'L',
      'AWS::S3Tables::Table'
    );

    // Format is create-only (Iceberg is the only legal value), so the
    // skip-emit on undefined is justified per § 3b "Immutable on create".
    expect(observed).toEqual({
      TableBucketARN: BUCKET_ARN,
      Namespace: 'my-namespace',
      Name: 'my-table',
      // CFn-canonical alias (#613 B-bucket fix).
      TableName: 'my-table',
    });
    expect(observed).not.toHaveProperty('Format');

    vi.clearAllMocks();

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::S3Tables::Table',
      observed!,
      observed!
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});
