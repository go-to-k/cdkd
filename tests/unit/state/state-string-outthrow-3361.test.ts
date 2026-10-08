import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { DeploymentEventsStore } from '../../../src/state/deployment-events-store.js';
import { ExportIndexStore, type ExportIndexFile } from '../../../src/state/export-index-store.js';
import {
  purgeNoncurrentKeyVersions,
  purgeNoncurrentVersionsUnderPrefix,
} from '../../../src/state/s3-noncurrent-version-purge.js';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the `src/state`
 * slice: a SWALLOWING handler that stringified its caught value with a bare
 * `String()` turned a graceful degradation into a hard failure when the value
 * could not be converted -- `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value`.
 *
 * Every case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the call resolves, the work after the failure still runs), never
 * merely "it did not throw". The placeholder is asserted too, so a fix that
 * swallowed the failure without reporting it would not pass.
 */

const loggerSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: loggerSpies.debug,
    info: vi.fn(),
    warn: loggerSpies.warn,
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

// The S3 doubles below lack the SDK `config` shape, so neither the owner probe
// nor the region resolver should run; mocked anyway so a regression there
// fails here rather than issuing a live call.
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '111111111111' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const warnings = (): string[] => loggerSpies.warn.mock.calls.map((c) => String(c[0]));
const debugs = (): string[] => loggerSpies.debug.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  clearReplicationProbeCache();
});

describe('DeploymentEventsStore (#3361)', () => {
  function backend(overrides: {
    putRawObject?: (key: string, body: string) => Promise<void>;
    getRawObject?: (key: string) => Promise<string | null>;
  }): { backend: S3StateBackend; puts: string[] } {
    const puts: string[] = [];
    const b = {
      prefix: 'cdkd',
      putRawObject: vi.fn(async (key: string, body: string) => {
        if (overrides.putRawObject) return overrides.putRawObject(key, body);
        puts.push(key);
      }),
      getRawObject: vi.fn(async (key: string) =>
        overrides.getRawObject ? overrides.getRawObject(key) : null
      ),
      listRawKeys: vi.fn(async () => []),
      deleteRawObjects: vi.fn(async () => {}),
      purgeNoncurrentVersions: vi.fn(async () => {}),
      purgeNoncurrentVersionsUnderPrefix: vi.fn(async () => {}),
    } as unknown as S3StateBackend;
    return { backend: b, puts };
  }

  const store = (b: S3StateBackend): DeploymentEventsStore => {
    const s = new DeploymentEventsStore(b, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: 'run-3361',
    });
    s.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    return s;
  };

  it('a write rejecting with an unconvertible value still resolves finalize, and warns', async () => {
    // The write chain's own `.catch` built the warning with `String(err)`, so
    // the handler threw, the chain REJECTED, and `finalize` -- documented
    // "best-effort: never throws" and awaited in the deploy and destroy
    // runners' `finally` -- rejected with a TypeError instead.
    const { backend: b } = backend({ putRawObject: () => Promise.reject(unconvertible()) });

    await expect(store(b).finalize('SUCCEEDED')).resolves.toBeUndefined();

    const persistWarn = warnings().filter((w) => w.includes('Failed to persist deployment events'));
    expect(persistWarn).toHaveLength(1);
    expect(persistWarn[0]).toContain(PLACEHOLDER);
  });

  it('an index read rejecting with an unconvertible value still writes the index for this run', async () => {
    // `readIndexRuns` degrades an unreadable index to "start from this run
    // alone". Its debug line used `String(err)`, so the degradation threw
    // instead and the index PUT after it never ran.
    const { backend: b, puts } = backend({ getRawObject: () => Promise.reject(unconvertible()) });

    await expect(store(b).finalize('SUCCEEDED')).resolves.toBeUndefined();

    expect(puts).toEqual([
      'cdkd/S/us-east-1/deployments/run-3361.jsonl',
      'cdkd/S/us-east-1/deployments/index.json',
    ]);
    const unreadable = debugs().filter((d) => d.includes('Deployment-events index unreadable'));
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain(PLACEHOLDER);
    expect(warnings()).toEqual([]);
  });
});

describe('ExportIndexStore (#3361)', () => {
  const INDEX: ExportIndexFile = {
    indexVersion: 1,
    region: 'us-east-1',
    exports: {},
    lastModified: 1,
  };

  /** An S3 double: GET answers from `get`, PUT from `put`. */
  function s3(handlers: {
    get: () => Promise<unknown>;
    put: (body: string) => Promise<unknown>;
  }): S3Client {
    return {
      send: vi.fn((cmd: { constructor: { name: string }; input: { Body?: string } }) => {
        if (cmd.constructor.name === 'GetObjectCommand') return handlers.get();
        if (cmd.constructor.name === 'PutObjectCommand') return handlers.put(cmd.input.Body ?? '');
        return Promise.reject(new Error(`unexpected command ${cmd.constructor.name}`));
      }),
      destroy: vi.fn(),
    } as unknown as S3Client;
  }

  const existingIndex = (): Promise<unknown> =>
    Promise.resolve({
      Body: { transformToString: async () => JSON.stringify(INDEX) },
      ETag: '"e1"',
    });

  it('a rebuild still indexes the readable stacks when one getState rejects unconvertibly', async () => {
    // Each stack's read is one member of a `Promise.all`; its catch degrades
    // that ONE stack to "skipped" with a warning. Built with `String(err)`,
    // the warning threw, the whole `Promise.all` rejected, and so did every
    // lookup -- one damaged read took the index down for every producer.
    const notFound = Object.assign(new Error('NoSuchKey'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    let saved = '';
    const client = s3({
      get: () => Promise.reject(notFound),
      put: (body) => {
        saved = body;
        return Promise.resolve({ ETag: '"e2"' });
      },
    });
    const stateBackend = {
      listStacks: vi.fn(async () => [
        { stackName: 'Broken', region: 'us-east-1' },
        { stackName: 'Producer', region: 'us-east-1' },
      ]),
      getState: vi.fn(async (stackName: string) => {
        if (stackName === 'Broken') throw unconvertible();
        return {
          state: {
            version: 4,
            stackName,
            region: 'us-east-1',
            resources: {},
            outputs: { BucketArn: 'arn1' },
            lastModified: 1,
          },
          etag: 'x',
        };
      }),
    } as unknown as S3StateBackend;
    const store = new ExportIndexStore(client, 'b', 'cdkd', 'us-east-1', stateBackend);

    await expect(store.lookup('BucketArn')).resolves.toEqual({
      value: 'arn1',
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
    });
    expect((JSON.parse(saved) as ExportIndexFile).exports['BucketArn']).toBeDefined();
    const skipped = warnings().filter((w) => w.includes('Failed to read state for Broken'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain(PLACEHOLDER);
  });

  it('a non-retryable index write rejecting unconvertibly still continues without the index', async () => {
    const client = s3({ get: existingIndex, put: () => Promise.reject(unconvertible()) });
    const store = new ExportIndexStore(client, 'b', 'cdkd', 'us-east-1', {} as S3StateBackend, {
      maxWriteRetries: 3,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });

    await expect(store.updateForStack('Me', 'us-east-1', { X: 'v' })).resolves.toBeUndefined();

    const bail = warnings().filter((w) => w.includes('failed (non-retryable)'));
    expect(bail).toHaveLength(1);
    expect(bail[0]).toContain(PLACEHOLDER);
  });

  it('retries exhausted on an unconvertible PreconditionFailed still continue without the index', async () => {
    // The retry arm keys on `name`, so a value carrying `name:
    // 'PreconditionFailed'` on a null prototype is retried to exhaustion and
    // then reaches the "Last error" warning -- the parameter-shaped site.
    const conflict = (): unknown =>
      Object.assign(Object.create(null) as object, { name: 'PreconditionFailed' });
    const client = s3({ get: existingIndex, put: () => Promise.reject(conflict()) });
    const store = new ExportIndexStore(client, 'b', 'cdkd', 'us-east-1', {} as S3StateBackend, {
      maxWriteRetries: 2,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });

    await expect(store.updateForStack('Me', 'us-east-1', { X: 'v' })).resolves.toBeUndefined();

    const exhausted = warnings().filter((w) => w.includes('exhausted 2 retries'));
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toContain(`Last error: ${PLACEHOLDER}`);
  });
});

describe('noncurrent-version purge (#3361)', () => {
  const BUCKET = 'cdkd-state-123456789012';
  const KEY_A = 'cdkd/S/us-east-1/rollback-journal.json';
  const KEY_B = 'cdkd/S/us-east-1/lock.json';

  /**
   * `list(prefix)` answers `ListObjectVersions`, `del()` answers
   * `DeleteObjects`; the replication probe that ends every purge answers "no
   * configuration".
   */
  function client(handlers: {
    list: (prefix: string) => Promise<unknown>;
    del?: () => Promise<unknown>;
  }): { send: (cmd: unknown) => Promise<unknown>; lists: string[] } {
    const lists: string[] = [];
    return {
      lists,
      send: (cmd: unknown) => {
        const c = cmd as { constructor: { name: string }; input: { Prefix?: string } };
        if (c.constructor.name === 'ListObjectVersionsCommand') {
          lists.push(c.input.Prefix ?? '');
          return handlers.list(c.input.Prefix ?? '');
        }
        if (c.constructor.name === 'DeleteObjectsCommand') {
          return handlers.del ? handlers.del() : Promise.resolve({});
        }
        return Promise.resolve({});
      },
    };
  }

  it('a listing rejecting unconvertibly is recorded, and the walk moves on to the next key', async () => {
    // The listing catch records the failure and continues to the next prefix.
    // Its reason was the bare ternary, so the record threw, the walk stopped
    // at the first key, and the purge -- documented as never throwing --
    // rejected out of the caller's cleanup path.
    const warn = vi.fn();
    const c = client({
      list: (prefix) =>
        prefix === KEY_A
          ? Promise.reject(unconvertible())
          : Promise.resolve({ Versions: [], IsTruncated: false }),
    });

    await expect(
      purgeNoncurrentKeyVersions(c, BUCKET, [KEY_A, KEY_B], { logger: { warn } })
    ).resolves.toBeUndefined();

    expect(c.lists).toEqual([KEY_A, KEY_B]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`${KEY_A} (${PLACEHOLDER})`);
  });

  it('a whole-batch delete rejecting unconvertibly is reported against its own keys', async () => {
    // Unlike the listing arm, this one did not reject the purge: the batch
    // catch's throw escaped into the per-prefix catch above it, which abandoned
    // the rest of the prefix and recorded the PREFIX with the converter's
    // TypeError as its reason. So the discriminator is the key and the
    // placeholder in the warning, not the resolution.
    const warn = vi.fn();
    const prefix = 'cdkd/S/us-east-1/deployments/';
    const key = `${prefix}run-1.jsonl`;
    const c = client({
      list: () =>
        Promise.resolve({
          Versions: [{ Key: key, VersionId: 'v1', IsLatest: false }],
          IsTruncated: false,
        }),
      del: () => Promise.reject(unconvertible()),
    });

    await expect(
      purgeNoncurrentVersionsUnderPrefix(c, BUCKET, prefix, { logger: { warn } })
    ).resolves.toEqual({ deletedBodies: 0, complete: false });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`${key} (${PLACEHOLDER})`);
  });
});
