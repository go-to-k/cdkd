import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetNamespaceCommand,
  GetTableCommand,
  NotFoundException,
} from '@aws-sdk/client-s3tables';

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

import {
  S3TablesProvider,
  parseNamespaceCompositeId,
  parseTableCompositeId,
} from '../../../src/provisioning/providers/s3-tables-provider.js';

const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:111122223333:bucket/my-bucket';
const TABLE_ARN = `${BUCKET_ARN}/table/abc-123`;

function notFound(): NotFoundException {
  return new NotFoundException({ message: 'not found', $metadata: {} });
}

describe('S3Tables import: verify the composite before adopting (issue #1668)', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3TablesProvider();
  });

  describe('composite id parsers', () => {
    it('accepts the exact arity and rejects everything else', () => {
      expect(parseNamespaceCompositeId(`${BUCKET_ARN}|ns`)).toEqual({
        tableBucketARN: BUCKET_ARN,
        namespace: 'ns',
      });
      expect(parseNamespaceCompositeId(BUCKET_ARN)).toBeUndefined();
      expect(parseNamespaceCompositeId(`${BUCKET_ARN}|ns|extra`)).toBeUndefined();
      expect(parseNamespaceCompositeId(`${BUCKET_ARN}|`)).toBeUndefined();

      expect(parseTableCompositeId(`${BUCKET_ARN}|ns|tbl`)).toEqual({
        tableBucketARN: BUCKET_ARN,
        namespace: 'ns',
        name: 'tbl',
      });
      expect(parseTableCompositeId(`${BUCKET_ARN}|ns`)).toBeUndefined();
      expect(parseTableCompositeId(TABLE_ARN)).toBeUndefined();
    });
  });

  describe('AWS::S3Tables::Namespace', () => {
    const input = {
      logicalId: 'MyNamespace',
      resourceType: 'AWS::S3Tables::Namespace',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { TableBucketARN: BUCKET_ARN, Namespace: 'ns' },
    };

    it('verifies a well-formed composite against AWS before adopting', async () => {
      mockSend.mockResolvedValueOnce({ namespace: ['ns'] });

      const result = await provider.import({
        ...input,
        knownPhysicalId: `${BUCKET_ARN}|ns`,
      });

      expect(result).toEqual({ physicalId: `${BUCKET_ARN}|ns`, attributes: {} });
      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(GetNamespaceCommand);
      expect(call.input).toMatchObject({ tableBucketARN: BUCKET_ARN, namespace: 'ns' });
    });

    it('rebuilds a wrong-arity override from the template instead of recording it verbatim', async () => {
      mockSend.mockResolvedValueOnce({ namespace: ['ns'] });

      // Pre-#1668 this bare id landed in state and broke every later op.
      const result = await provider.import({ ...input, knownPhysicalId: 'ns' });

      expect(result).toEqual({ physicalId: `${BUCKET_ARN}|ns`, attributes: {} });
    });

    it('accepts the CDK singleton-array Namespace shape', async () => {
      mockSend.mockResolvedValueOnce({ namespace: ['ns'] });

      const result = await provider.import({
        ...input,
        properties: { TableBucketARN: BUCKET_ARN, Namespace: ['ns'] },
        knownPhysicalId: 'ns',
      });

      expect(result).toEqual({ physicalId: `${BUCKET_ARN}|ns`, attributes: {} });
    });

    it('returns null when the namespace does not exist', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      const result = await provider.import({
        ...input,
        knownPhysicalId: `${BUCKET_ARN}|ns`,
      });

      expect(result).toBeNull();
    });

    it('returns null when neither the id nor the template identifies a namespace', async () => {
      const result = await provider.import({
        ...input,
        properties: {},
        knownPhysicalId: 'ns',
      });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('declines with no override (override-only)', async () => {
      const result = await provider.import(input);
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('AWS::S3Tables::Table', () => {
    const input = {
      logicalId: 'MyTable',
      resourceType: 'AWS::S3Tables::Table',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { TableBucketARN: BUCKET_ARN, Namespace: 'ns', TableName: 'tbl' },
    };

    it("canonicalizes CloudFormation's TableARN physicalId into cdkd's composite", async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });

      // The registry declares a single-field primaryIdentifier of TableARN,
      // so this is what --migrate-from-cloudformation supplies.
      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toEqual({
        physicalId: `${BUCKET_ARN}|ns|tbl`,
        attributes: { TableARN: TABLE_ARN },
      });
      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(GetTableCommand);
      expect(call.input).toMatchObject({
        tableBucketARN: BUCKET_ARN,
        namespace: 'ns',
        name: 'tbl',
      });
    });

    it('refuses when the supplied ARN names a different table than the template', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: `${BUCKET_ARN}/table/other-999` });

      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toBeNull();
    });

    it('verifies and adopts a well-formed composite, caching the real ARN', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });

      const result = await provider.import({
        ...input,
        knownPhysicalId: `${BUCKET_ARN}|ns|tbl`,
      });

      expect(result).toEqual({
        physicalId: `${BUCKET_ARN}|ns|tbl`,
        attributes: { TableARN: TABLE_ARN },
      });
    });

    it('rebuilds a wrong-arity override from the template instead of recording it verbatim', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });

      // Pre-#1668 a 2-segment id fell through to verbatim adoption.
      const result = await provider.import({
        ...input,
        knownPhysicalId: `${BUCKET_ARN}|ns`,
      });

      expect(result).toEqual({
        physicalId: `${BUCKET_ARN}|ns|tbl`,
        attributes: { TableARN: TABLE_ARN },
      });
    });

    it("mirrors createTable's TableName ?? Name fallback", async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });

      const result = await provider.import({
        ...input,
        properties: { TableBucketARN: BUCKET_ARN, Namespace: 'ns', Name: 'tbl' },
        knownPhysicalId: TABLE_ARN,
      });

      expect(result).toMatchObject({ physicalId: `${BUCKET_ARN}|ns|tbl` });
    });

    it('returns null when the table does not exist', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toBeNull();
    });

    it('returns null when neither the id nor the template identifies a table', async () => {
      const result = await provider.import({
        ...input,
        properties: {},
        knownPhysicalId: TABLE_ARN,
      });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('declines with no override (override-only)', async () => {
      const result = await provider.import(input);
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
