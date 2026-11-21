import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6749: a table bucket / vector bucket that still holds content
// the stack did not create is refused on delete (CloudFormation parity: its
// delete handlers hold only the bucket's own delete permission), and is
// emptied only under `DeleteContext.forceDataDelete`.

const tablesSend = vi.hoisted(() => vi.fn());
const vectorsSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3tables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3tables')>();
  return {
    ...actual,
    S3TablesClient: vi.fn().mockImplementation(() => ({
      send: tablesSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-s3vectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3vectors')>();
  return {
    ...actual,
    S3VectorsClient: vi.fn().mockImplementation(() => ({
      send: vectorsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { getLogger: () => logger };
});

import {
  BadRequestException,
  ConflictException as TablesConflictException,
  DeleteNamespaceCommand,
  DeleteTableBucketCommand,
  DeleteTableCommand,
  ListNamespacesCommand,
  ListTablesCommand,
} from '@aws-sdk/client-s3tables';
import {
  ConflictException as VectorsConflictException,
  DeleteIndexCommand,
  DeleteVectorBucketCommand,
  ListIndexesCommand,
} from '@aws-sdk/client-s3vectors';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TABLE_BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/data-bucket';
const VECTOR_BUCKET = 'vector-bucket';

const sent = (send: ReturnType<typeof vi.fn>, ctor: abstract new (...args: never[]) => unknown) =>
  send.mock.calls.filter((call: unknown[]) => call[0] instanceof ctor);

function tablesAnswer(answers: {
  deleteBucket: () => unknown;
  namespaces?: string[];
  namespacesToken?: string;
  tables?: Record<string, string[]>;
  listFails?: boolean;
}): void {
  tablesSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DeleteTableBucketCommand) return Promise.resolve().then(answers.deleteBucket);
    if (cmd instanceof ListNamespacesCommand) {
      if (answers.listFails) {
        return Promise.reject(new Error('AccessDenied: s3tables:ListNamespaces'));
      }
      return Promise.resolve({
        namespaces: (answers.namespaces ?? []).map((ns) => ({ namespace: [ns] })),
        // One extra (empty) page at most, so a full walk ends.
        continuationToken: (cmd.input as { continuationToken?: string }).continuationToken
          ? undefined
          : answers.namespacesToken,
      });
    }
    if (cmd instanceof ListTablesCommand) {
      const ns = (cmd.input as { namespace: string }).namespace;
      return Promise.resolve({
        tables: (answers.tables?.[ns] ?? []).map((name) => ({ name })),
      });
    }
    return Promise.resolve({});
  });
}

const notEmpty = () => {
  throw new BadRequestException({ message: 'The bucket that you tried to delete is not empty.', $metadata: {} });
};

describe('S3 Tables table bucket delete refuses a non-empty bucket (#6749)', () => {
  let provider: S3TablesProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3TablesProvider();
  });

  it('refuses, non-retryably, naming the tables and namespaces it holds, and deletes none of them', async () => {
    tablesAnswer({
      deleteBucket: notEmpty,
      namespaces: ['analytics'],
      tables: { analytics: ['events', 'sessions'] },
    });

    const error = await provider
      .delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
      .then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).toContain(`table bucket ${TABLE_BUCKET_ARN} is not empty`);
    expect(message).toContain('table(s) analytics.events, analytics.sessions in namespace(s) analytics');
    expect(message).not.toContain('and more');
    expect(message).toContain('aws s3tables delete-table');
    expect(message).toContain('--force-stateful-recreation');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(sent(tablesSend, DeleteTableCommand)).toHaveLength(0);
    expect(sent(tablesSend, DeleteNamespaceCommand)).toHaveLength(0);
    expect(sent(tablesSend, DeleteTableBucketCommand)).toHaveLength(1);
  });

  it('refuses a bucket holding only an empty namespace', async () => {
    tablesAnswer({ deleteBucket: notEmpty, namespaces: ['scratch'] });

    await expect(
      provider.delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
    ).rejects.toThrow(/it holds namespace\(s\) scratch\. /);
  });

  it('names at most five of each and says there is more, without walking the rest', async () => {
    const namespaces = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    tablesAnswer({
      deleteBucket: notEmpty,
      namespaces,
      tables: Object.fromEntries(namespaces.map((ns) => [ns, ['a', 'b']])),
    });

    const error = await provider
      .delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
      .then(() => undefined, (e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain('table(s) n1.a, n1.b, n2.a, n2.b, n3.a in namespace(s) n1, n2, n3, n4, n5, and more');
    expect(message).not.toContain('n6');
    // Stopped at the fifth table: n3 was the last namespace listed.
    expect(sent(tablesSend, ListTablesCommand)).toHaveLength(3);
  });

  it('says there is more when the namespace listing has another page', async () => {
    tablesAnswer({ deleteBucket: notEmpty, namespaces: ['n1'], namespacesToken: 'next' });

    await expect(
      provider.delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
    ).rejects.toThrow(/it holds namespace\(s\) n1, and more\./);
  });

  it('masks a secret-derived name in the refusal', async () => {
    tablesAnswer({ deleteBucket: notEmpty, namespaces: ['SECRETns'] });

    const error = await provider
      .delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket', undefined, {
        maskSecrets: (text: string) => text.split('SECRET').join('***'),
      })
      .then(() => undefined, (e: unknown) => e);

    expect((error as Error).message).toContain('namespace(s) ***ns');
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('a failure on a bucket listed as empty keeps the original error, retryable', async () => {
    tablesAnswer({
      deleteBucket: () => {
        throw new TablesConflictException({ message: 'A conflicting operation is in progress', $metadata: {} });
      },
    });

    const error = await provider
      .delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
      .then(() => undefined, (e: unknown) => e);

    expect((error as Error).message).toMatch(/^Failed to delete S3 Table Bucket Bucket: /);
    expect((error as Error).message).not.toContain('is not empty: it holds');
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('a listing that fails keeps the original error', async () => {
    tablesAnswer({ deleteBucket: notEmpty, listFails: true });

    const error = await provider
      .delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
      .then(() => undefined, (e: unknown) => e);

    expect((error as Error).message).toMatch(/^Failed to delete S3 Table Bucket Bucket: /);
    expect((error as Error).message).not.toContain('it holds');
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('under forceDataDelete, empties the bucket first and never refuses', async () => {
    tablesAnswer({
      deleteBucket: () => ({}),
      namespaces: ['analytics'],
      tables: { analytics: ['events'] },
    });

    await provider.delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket', undefined, {
      forceDataDelete: true,
    });

    expect(sent(tablesSend, DeleteTableCommand).map((c) => c[0].input)).toEqual([
      { tableBucketARN: TABLE_BUCKET_ARN, namespace: 'analytics', name: 'events' },
    ]);
    expect(sent(tablesSend, DeleteNamespaceCommand)).toHaveLength(1);
    const order = tablesSend.mock.calls.map((c: unknown[]) => (c[0] as object).constructor.name);
    expect(order.indexOf('DeleteTableBucketCommand')).toBe(order.length - 1);
  });
});

function vectorsAnswer(answers: {
  deleteBucket: () => unknown;
  indexes?: string[];
  nextToken?: string;
  listFails?: boolean;
}): void {
  vectorsSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DeleteVectorBucketCommand) return Promise.resolve().then(answers.deleteBucket);
    if (cmd instanceof ListIndexesCommand) {
      if (answers.listFails) return Promise.reject(new Error('AccessDenied: s3vectors:ListIndexes'));
      return Promise.resolve({
        indexes: (answers.indexes ?? []).map((indexName) => ({ indexName })),
        nextToken: (cmd.input as { nextToken?: string }).nextToken ? undefined : answers.nextToken,
      });
    }
    return Promise.resolve({});
  });
}

const vectorsNotEmpty = () => {
  throw new VectorsConflictException({ message: 'The vector bucket is not empty.', $metadata: {} });
};

describe('S3 Vectors vector bucket delete refuses a non-empty bucket (#6749)', () => {
  let provider: S3VectorsProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3VectorsProvider();
  });

  it('refuses, non-retryably, naming the indexes it holds, and deletes none of them', async () => {
    vectorsAnswer({ deleteBucket: vectorsNotEmpty, indexes: ['embeddings', 'faq'] });

    const error = await provider
      .delete('Bucket', VECTOR_BUCKET, 'AWS::S3Vectors::VectorBucket')
      .then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).toContain(
      `vector bucket ${VECTOR_BUCKET} is not empty: it holds vector index(es) embeddings, faq. `
    );
    expect(message).toContain('aws s3vectors delete-index');
    expect(message).toContain('--force-stateful-recreation');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(sent(vectorsSend, DeleteIndexCommand)).toHaveLength(0);
    expect(sent(vectorsSend, DeleteVectorBucketCommand)).toHaveLength(1);
  });

  it('names at most five indexes and says there is more', async () => {
    vectorsAnswer({ deleteBucket: vectorsNotEmpty, indexes: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'] });

    await expect(
      provider.delete('Bucket', VECTOR_BUCKET, 'AWS::S3Vectors::VectorBucket')
    ).rejects.toThrow(/vector index\(es\) i1, i2, i3, i4, i5, and more\. /);
  });

  it('says there is more when the listing has another page', async () => {
    vectorsAnswer({ deleteBucket: vectorsNotEmpty, indexes: ['i1'], nextToken: 'next' });

    await expect(
      provider.delete('Bucket', VECTOR_BUCKET, 'AWS::S3Vectors::VectorBucket')
    ).rejects.toThrow(/vector index\(es\) i1, and more\. /);
  });

  it('masks a secret-derived name in the refusal', async () => {
    vectorsAnswer({ deleteBucket: vectorsNotEmpty, indexes: ['SECRETidx'] });

    const error = await provider
      .delete('Bucket', `SECRET-${VECTOR_BUCKET}`, 'AWS::S3Vectors::VectorBucket', undefined, {
        maskSecrets: (text: string) => text.split('SECRET').join('***'),
      })
      .then(() => undefined, (e: unknown) => e);

    expect((error as Error).message).toContain(`vector bucket ***-${VECTOR_BUCKET} is not empty`);
    expect((error as Error).message).toContain('vector index(es) ***idx');
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('a failure on a bucket listed as empty keeps the original error, retryable', async () => {
    vectorsAnswer({ deleteBucket: vectorsNotEmpty });

    const error = await provider
      .delete('Bucket', VECTOR_BUCKET, 'AWS::S3Vectors::VectorBucket')
      .then(() => undefined, (e: unknown) => e);

    expect((error as Error).message).toMatch(/^Failed to delete S3 VectorBucket Bucket: /);
    expect((error as Error).message).not.toContain('it holds');
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('a listing that fails keeps the original error', async () => {
    vectorsAnswer({ deleteBucket: vectorsNotEmpty, listFails: true });

    const error = await provider
      .delete('Bucket', VECTOR_BUCKET, 'AWS::S3Vectors::VectorBucket')
      .then(() => undefined, (e: unknown) => e);

    expect((error as Error).message).not.toContain('it holds');
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('under forceDataDelete, deletes the indexes first and never refuses', async () => {
    vectorsAnswer({ deleteBucket: () => ({}), indexes: ['embeddings'] });

    await provider.delete('Bucket', VECTOR_BUCKET, 'AWS::S3Vectors::VectorBucket', undefined, {
      forceDataDelete: true,
    });

    expect(sent(vectorsSend, DeleteIndexCommand).map((c) => c[0].input)).toEqual([
      { vectorBucketName: VECTOR_BUCKET, indexName: 'embeddings' },
    ]);
    const order = vectorsSend.mock.calls.map((c: unknown[]) => (c[0] as object).constructor.name);
    expect(order.indexOf('DeleteVectorBucketCommand')).toBe(order.length - 1);
  });
});
