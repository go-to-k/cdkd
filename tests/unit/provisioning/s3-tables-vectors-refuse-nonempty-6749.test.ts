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
    S3TablesClient: vi.fn(() => ({
      send: tablesSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-s3vectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3vectors')>();
  return {
    ...actual,
    S3VectorsClient: vi.fn(() => ({
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
    child: vi.fn((): unknown => logger),
  };
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
      // The refusal lists the whole bucket (no `namespace`); the
      // forceDataDelete emptying lists one namespace at a time.
      const only = (cmd.input as { namespace?: string }).namespace;
      return Promise.resolve({
        tables: Object.entries(answers.tables ?? {})
          .filter(([ns]) => only === undefined || ns === only)
          .flatMap(([ns, names]) => names.map((name) => ({ name, namespace: [ns] }))),
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
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // The recheck's wait runs at once; its duration is asserted where it matters.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
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
    expect(message).toContain('table(s) analytics.events, analytics.sessions; namespace(s) analytics');
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
    expect(message).toContain('table(s) n1.a, n1.b, n2.a, n2.b, n3.a; namespace(s) n1, n2, n3, n4, n5, and more');
    expect(message).not.toContain('n6');
    // One bucket-wide ListTables per listing: the first, then five unchanged.
    expect(sent(tablesSend, ListTablesCommand).map((c) => c[0].input)).toEqual(
      Array.from({ length: 6 }, () => ({ tableBucketARN: TABLE_BUCKET_ARN }))
    );
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

  // go-to-k/cdkd#6772: a namespace the stack retained, whose name is
  // secret-derived, is in no bag of the bucket's own.
  it("masks a retained in-stack child's secret-derived name with the stack-wide masker", async () => {
    const run = (maskStackSecretNames?: (text: string) => string) => {
      tablesAnswer({ deleteBucket: notEmpty, namespaces: ['SECRETns'] });
      return provider
        .delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket', undefined, {
          maskSecrets: (text: string) => text,
          ...(maskStackSecretNames && { maskStackSecretNames }),
        })
        .then(() => undefined, (e: unknown) => e);
    };

    const masked = ((await run((text) => text.split('SECRET').join('***'))) as Error).message;
    expect(masked).toContain('namespace(s) ***ns');
    expect(masked).not.toContain('SECRET');
    // Absent, the bucket's own masker alone: the wording is unchanged.
    const plain = ((await run()) as Error).message;
    expect(plain).toBe(masked.replace('***ns', 'SECRETns'));
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
    // Listed empty: the delete is tried once more, and its failure surfaces.
    expect(sent(tablesSend, DeleteTableBucketCommand)).toHaveLength(2);
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

  it('waits while the content drains, then refuses with what stays put for five listings', async () => {
    let listing = 0;
    tablesSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteTableBucketCommand) return Promise.resolve().then(notEmpty);
      if (cmd instanceof ListNamespacesCommand) {
        listing++;
        // The stack's own namespace lingers for three listings.
        return Promise.resolve({
          namespaces: (listing <= 3 ? ['own', 'kept'] : ['kept']).map((ns) => ({ namespace: [ns] })),
        });
      }
      if (cmd instanceof ListTablesCommand) {
        return Promise.resolve({ tables: [{ name: 't', namespace: ['kept'] }] });
      }
      return Promise.resolve({});
    });

    await expect(
      provider.delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
    ).rejects.toThrow(/it holds table\(s\) kept\.t; namespace\(s\) kept\. /);
    // Three listings with `own`, then the first without it and five more unchanged.
    expect(listing).toBe(3 + 1 + 5);
    expect(vi.mocked(setTimeout).mock.calls.map((c) => c[1])).toContain(2000);
  });

  it("the stack's own children listed for several polls, then gone: the delete is retried and succeeds", async () => {
    let listing = 0;
    let deletes = 0;
    tablesSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteTableBucketCommand) {
        deletes++;
        return deletes === 1 ? Promise.resolve().then(notEmpty) : Promise.resolve({});
      }
      if (cmd instanceof ListNamespacesCommand) {
        listing++;
        return Promise.resolve({ namespaces: listing <= 4 ? [{ namespace: ['own'] }] : [] });
      }
      return Promise.resolve({ tables: [] });
    });

    await expect(
      provider.delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
    ).resolves.toBeUndefined();
    expect(listing).toBe(5);
    expect(deletes).toBe(2);
  });

  it('content that keeps changing is refused at the cap with what it holds last', async () => {
    let listing = 0;
    tablesSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteTableBucketCommand) return Promise.resolve().then(notEmpty);
      if (cmd instanceof ListNamespacesCommand) {
        listing++;
        return Promise.resolve({ namespaces: [{ namespace: [`ns${listing}`] }] });
      }
      return Promise.resolve({ tables: [] });
    });

    await expect(
      provider.delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
    ).rejects.toThrow(/it holds namespace\(s\) ns31\. /);
    expect(listing).toBe(31);
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

describe("the stack's own table and namespace deletes wait until the bucket no longer lists them (#6749)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
  });

  /**
   * A bucket whose deleted children stay listed for `lag` listings each, and
   * whose `DeleteTableBucket` refuses while anything is listed: the listing
   * lag the bucket's own delete would otherwise meet.
   */
  function laggingBucket(lag: number, foreign: { namespace?: string } = {}) {
    const listed = { tables: new Map<string, number>(), namespaces: new Map<string, number>() };
    listed.tables.set('ns.own', Infinity);
    listed.namespaces.set('ns', Infinity);
    if (foreign.namespace) listed.namespaces.set(foreign.namespace, Infinity);
    const visible = (m: Map<string, number>) =>
      [...m.entries()].filter(([, left]) => left > 0).map(([k]) => k);
    const tick = (m: Map<string, number>, key: string) => {
      const left = m.get(key);
      if (left !== undefined && left !== Infinity) m.set(key, left - 1);
    };
    tablesSend.mockImplementation((cmd: unknown) => {
      const input = (cmd as { input: Record<string, string> }).input;
      if (cmd instanceof DeleteTableCommand) listed.tables.set(`${input['namespace']}.${input['name']}`, lag);
      if (cmd instanceof DeleteNamespaceCommand) listed.namespaces.set(input['namespace']!, lag);
      if (cmd instanceof ListTablesCommand) {
        const shown = visible(listed.tables).filter(
          (k) => !input['namespace'] || k.startsWith(`${input['namespace']}.`)
        );
        shown.forEach((k) => tick(listed.tables, k));
        return Promise.resolve({
          tables: shown.map((k) => ({ namespace: [k.split('.')[0]], name: k.split('.')[1] })),
        });
      }
      if (cmd instanceof ListNamespacesCommand) {
        const shown = visible(listed.namespaces);
        shown.forEach((k) => tick(listed.namespaces, k));
        return Promise.resolve({ namespaces: shown.map((ns) => ({ namespace: [ns] })) });
      }
      if (cmd instanceof DeleteTableBucketCommand) {
        if (visible(listed.tables).length > 0 || visible(listed.namespaces).length > 0) {
          return Promise.resolve().then(notEmpty);
        }
      }
      return Promise.resolve({});
    });
  }

  it('own children listed for several polls after their delete, then gone: the destroy order succeeds with no refusal', async () => {
    laggingBucket(4);
    const provider = new S3TablesProvider();

    await provider.delete('Table', `${TABLE_BUCKET_ARN}|ns|own`, 'AWS::S3Tables::Table', undefined, {
      stackDestroy: true,
    });
    await provider.delete('Namespace', `${TABLE_BUCKET_ARN}|ns`, 'AWS::S3Tables::Namespace', undefined, {
      stackDestroy: true,
    });
    await expect(
      provider.delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket', undefined, {
        stackDestroy: true,
      })
    ).resolves.toBeUndefined();
    // The bucket delete went through first time: its own children were gone.
    expect(sent(tablesSend, DeleteTableBucketCommand)).toHaveLength(1);
    // The table's wait read the listing with its name as the prefix.
    expect(sent(tablesSend, ListTablesCommand)[0]![0].input).toEqual({
      tableBucketARN: TABLE_BUCKET_ARN,
      namespace: 'ns',
      prefix: 'own',
      continuationToken: undefined,
    });
  });

  it('a foreign namespace left after the own children are gone is refused', async () => {
    laggingBucket(2, { namespace: 'foreign' });
    const provider = new S3TablesProvider();

    await provider.delete('Table', `${TABLE_BUCKET_ARN}|ns|own`, 'AWS::S3Tables::Table');
    await provider.delete('Namespace', `${TABLE_BUCKET_ARN}|ns`, 'AWS::S3Tables::Namespace');
    const error = await provider
      .delete('Bucket', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket')
      .then(() => undefined, (e: unknown) => e);

    expect((error as Error).message).toContain('it holds namespace(s) foreign. ');
    expect((error as Error).message).not.toContain('ns.own');
    expect(isMarkedNonRetryable(error)).toBe(true);
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
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // The recheck's wait runs at once; its duration is asserted where it matters.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
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

  // go-to-k/cdkd#6772: an index the stack retained, whose name is
  // secret-derived, is in no bag of the bucket's own.
  it("masks a retained in-stack index's secret-derived name with the stack-wide masker", async () => {
    const run = (maskStackSecretNames?: (text: string) => string) => {
      vectorsAnswer({ deleteBucket: vectorsNotEmpty, indexes: ['SECRETidx'] });
      return provider
        .delete('Bucket', VECTOR_BUCKET, 'AWS::S3Vectors::VectorBucket', undefined, {
          maskSecrets: (text: string) => text,
          ...(maskStackSecretNames && { maskStackSecretNames }),
        })
        .then(() => undefined, (e: unknown) => e);
    };

    const masked = ((await run((text) => text.split('SECRET').join('***'))) as Error).message;
    expect(masked).toContain('vector index(es) ***idx');
    expect(masked).not.toContain('SECRET');
    // Absent, the bucket's own masker alone: the wording is unchanged.
    const plain = ((await run()) as Error).message;
    expect(plain).toBe(masked.replace('***idx', 'SECRETidx'));
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

  it("the stack's own index listed for several polls, then gone: the delete is retried and succeeds", async () => {
    let listing = 0;
    let deletes = 0;
    vectorsSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteVectorBucketCommand) {
        deletes++;
        return deletes === 1 ? Promise.resolve().then(vectorsNotEmpty) : Promise.resolve({});
      }
      if (cmd instanceof ListIndexesCommand) {
        listing++;
        return Promise.resolve({ indexes: listing <= 4 ? [{ indexName: 'own' }] : [] });
      }
      return Promise.resolve({});
    });

    await expect(
      provider.delete('Bucket', VECTOR_BUCKET, 'AWS::S3Vectors::VectorBucket')
    ).resolves.toBeUndefined();
    expect(listing).toBe(5);
    expect(deletes).toBe(2);
    expect(vi.mocked(setTimeout).mock.calls.map((c) => c[1])).toContain(2000);
  });

  it('waits while the indexes drain, then refuses with what stays put', async () => {
    let listing = 0;
    vectorsSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteVectorBucketCommand) return Promise.resolve().then(vectorsNotEmpty);
      if (cmd instanceof ListIndexesCommand) {
        listing++;
        return Promise.resolve({
          indexes: (listing <= 2 ? ['own', 'kept'] : ['kept']).map((indexName) => ({ indexName })),
        });
      }
      return Promise.resolve({});
    });

    await expect(
      provider.delete('Bucket', VECTOR_BUCKET, 'AWS::S3Vectors::VectorBucket')
    ).rejects.toThrow(/vector index\(es\) kept\. /);
    expect(listing).toBe(2 + 1 + 5);
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
