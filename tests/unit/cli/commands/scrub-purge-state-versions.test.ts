/**
 * go-to-k/cdkd#2624, site 1: a real `cdkd scrub` purges the noncurrent versions
 * of every `state.json` it rewrites.
 *
 * `scrubStack` runs here against a REAL `S3StateBackend` over a fake S3
 * client, so what is asserted is what reaches the wire: the `PutObject` of the
 * scrubbed record, then the `ListObjectVersions` / `DeleteObjects` pair that
 * only the purge emits. A mocked backend would pin only what scrub PASSES.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import { clearReplicationProbeCache } from '../../../../src/state/s3-replication-purge-gap.js';

vi.mock('../../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: vi.fn().mockResolvedValue({}),
}));

const backendWarn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: backendWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({ ...child, child: () => child, setLevel: vi.fn() }),
  };
});

const SECRET_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
const SECRET_PLAINTEXT = 'the-real-resolved-db-password';

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/deployment/intrinsic-function-resolver.js')>()),
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const walk = (v: unknown): unknown => {
          if (v === SECRET_EXPR) {
            ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, SECRET_EXPR);
            return SECRET_PLAINTEXT;
          }
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
            return out;
          }
          return v;
        };
        return Promise.resolve(walk(value));
      }),
  })),
}));

import {
  scrubStack,
  scrubbedStateKey,
  scrubbedLegacyStateKey,
  scrubbedExportIndexKey,
} from '../../../../src/cli/commands/scrub.js';
import { S3StateBackend } from '../../../../src/state/s3-state-backend.js';
import { ExportIndexStore } from '../../../../src/state/export-index-store.js';

const BUCKET = 'cdkd-state-test';
const REGION = 'us-east-1';
const STACK = 'MyStack';
const STATE_KEY = `cdkd/${STACK}/${REGION}/state.json`;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const stackInfo = {
  stackName: STACK,
  template: {
    Resources: {
      Db: {
        Type: 'AWS::RDS::DBInstance',
        Properties: { DBInstanceIdentifier: 'app-db', MasterUserPassword: SECRET_EXPR },
      },
    },
  } as CloudFormationTemplate,
};

function record(password: string): StackState {
  return {
    version: 10,
    stackName: STACK,
    region: REGION,
    resources: {
      Db: {
        physicalId: 'app-db',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { DBInstanceIdentifier: 'app-db', MasterUserPassword: password },
      },
    },
    outputs: {},
    lastModified: 1,
  };
}

interface Sent {
  name: string;
  input: {
    Key?: string;
    Prefix?: string;
    Body?: string;
    Delete?: { Objects?: { Key?: string; VersionId?: string }[] };
  };
}

/** One bucket's behaviour: the listing it returns, and how each write fares. */
interface Bucket {
  versions: Array<{ Key: string; VersionId: string; IsLatest: boolean }>;
  putError?: Error;
  listError?: Error;
  replication?: unknown;
}

describe('cdkd scrub purges the superseded state.json versions (go-to-k/cdkd#2624)', () => {
  let sent: Sent[];
  let bucket: Bucket;

  const client = (): S3Client =>
    ({
      send: (cmd: unknown): Promise<unknown> => {
        const c = cmd as { constructor: { name: string }; input: Sent['input'] };
        sent.push({ name: c.constructor.name, input: c.input });
        switch (c.constructor.name) {
          case 'PutObjectCommand':
            return bucket.putError ? Promise.reject(bucket.putError) : Promise.resolve({ ETag: '"e2"' });
          case 'ListObjectVersionsCommand':
            return bucket.listError
              ? Promise.reject(bucket.listError)
              : Promise.resolve({ Versions: bucket.versions, IsTruncated: false });
          case 'GetBucketReplicationCommand':
            if (bucket.replication) return Promise.resolve(bucket.replication);
            return Promise.reject(
              Object.assign(new Error('none'), { name: 'ReplicationConfigurationNotFoundError' })
            );
          default:
            return Promise.resolve({});
        }
      },
      destroy: vi.fn(),
    }) as unknown as S3Client;

  async function scrub(stored: StackState, dryRun = false) {
    const backend = new S3StateBackend(client(), { bucket: BUCKET, prefix: 'cdkd' });
    vi.spyOn(backend, 'getState').mockResolvedValue({ state: stored, etag: '"e1"' });
    const lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    return scrubStack(stackInfo as never, REGION, backend, lockManager as never, {
      dryRun,
      logger: logger as never,
    });
  }

  const names = (): string[] => sent.map((s) => s.name);
  const warnings = (): string => backendWarn.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    clearReplicationProbeCache();
    sent = [];
    backendWarn.mockReset();
    bucket = {
      versions: [
        { Key: STATE_KEY, VersionId: 'pre-scrub-1', IsLatest: false },
        { Key: STATE_KEY, VersionId: 'pre-scrub-2', IsLatest: false },
        { Key: STATE_KEY, VersionId: 'scrubbed', IsLatest: true },
      ],
    };
  });

  it('VERSIONED: purges every pre-scrub version of the rewritten key, after the write', async () => {
    const result = await scrub(record(SECRET_PLAINTEXT));
    expect(result.recordsChanged).toBeGreaterThan(0);

    expect(names()).toEqual([
      'PutObjectCommand',
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
      'GetBucketReplicationCommand',
    ]);
    const put = sent[0]!;
    expect(put.input.Key).toBe(STATE_KEY);
    expect(put.input.Body).not.toContain(SECRET_PLAINTEXT);
    // Scoped to the state KEY, never the stack prefix (the journal and the
    // deployment events live beside it).
    expect(sent[1]!.input.Prefix).toBe(STATE_KEY);
    // The version ids, not a count: taking `scrubbed` too would delete the
    // record scrub just wrote.
    expect(sent[2]!.input.Delete?.Objects).toEqual([
      { Key: STATE_KEY, VersionId: 'pre-scrub-1' },
      { Key: STATE_KEY, VersionId: 'pre-scrub-2' },
    ]);
    expect(warnings()).toBe('');
  });

  it('UNVERSIONED: the listing holds only the current object, so nothing extra is deleted', async () => {
    bucket.versions = [{ Key: STATE_KEY, VersionId: 'null', IsLatest: true }];

    await scrub(record(SECRET_PLAINTEXT));

    expect(names()).toEqual(['PutObjectCommand', 'ListObjectVersionsCommand']);
    expect(warnings()).toBe('');
  });

  it('a FAILED purge only warns: the scrub still succeeds, and the warning names the object', async () => {
    bucket.listError = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });

    const result = await scrub(record(SECRET_PLAINTEXT));

    expect(result.recordsChanged).toBeGreaterThan(0);
    expect(names()[0]).toBe('PutObjectCommand');
    expect(warnings()).toContain('Could not purge noncurrent versions of 1 key(s)');
    expect(warnings()).toContain("the stack's earlier state.json versions");
    expect(warnings()).toContain('s3:ListBucketVersions and s3:DeleteObjectVersion');
  });

  it('a REPLICATED bucket warns that the replica keeps its copies', async () => {
    bucket.replication = {
      ReplicationConfiguration: {
        Role: 'arn:aws:iam::111122223333:role/r',
        Rules: [
          {
            Status: 'Enabled',
            Filter: { Prefix: '' },
            Destination: { Bucket: 'arn:aws:s3:::replica-bucket' },
          },
        ],
      },
    };

    await scrub(record(SECRET_PLAINTEXT));

    expect(names()).toContain('DeleteObjectsCommand');
    expect(warnings()).toContain('S3 replication is enabled');
    expect(warnings()).toContain("the stack's earlier state.json versions");
  });

  it('an AMBIGUOUS save failure (a 5xx: the PUT may have landed) still purges, and the save error is what escapes', async () => {
    bucket.putError = Object.assign(new Error('Service Unavailable'), {
      name: 'ServiceUnavailable',
      $metadata: { httpStatusCode: 503 },
    });

    // The SAVE's error, not one from the `finally`: a purge that threw there
    // would replace it.
    await expect(scrub(record(SECRET_PLAINTEXT))).rejects.toThrow(
      /Failed to save state for stack .*Service Unavailable/
    );

    expect(names()).toEqual([
      'PutObjectCommand',
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
      'GetBucketReplicationCommand',
    ]);
    // The current version is never in the delete, whatever the save did.
    expect(sent[2]!.input.Delete?.Objects?.map((o) => o.VersionId)).not.toContain('scrubbed');
  });

  it.each([
    ['PreconditionFailed', 412],
    ['AccessDenied', 403],
  ])(
    'a DEFINITE save failure (%s) wrote nothing, so the history is KEPT',
    async (name, httpStatusCode) => {
      bucket.putError = Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

      await expect(scrub(record(SECRET_PLAINTEXT))).rejects.toThrow();

      // The record was not rewritten: no listing, no delete, no warning.
      expect(names()).toEqual(['PutObjectCommand']);
      expect(warnings()).toBe('');
    }
  );

  it('a 412 the SDK reached after RETRYING (a committed attempt answered 5xx) still purges', async () => {
    bucket.putError = Object.assign(new Error('PreconditionFailed'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412, attempts: 2 },
    });

    await expect(scrub(record(SECRET_PLAINTEXT))).rejects.toThrow();

    expect(names()).toEqual([
      'PutObjectCommand',
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
      'GetBucketReplicationCommand',
    ]);
  });

  it('...while a FIRST-attempt 412 purges nothing', async () => {
    bucket.putError = Object.assign(new Error('PreconditionFailed'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412, attempts: 1 },
    });

    await expect(scrub(record(SECRET_PLAINTEXT))).rejects.toThrow();

    expect(names()).toEqual(['PutObjectCommand']);
  });

  it('--dry-run never purges (nor writes)', async () => {
    const result = await scrub(record(SECRET_PLAINTEXT), true);

    expect(result.recordsChanged).toBeGreaterThan(0);
    expect(names()).toEqual([]);
  });

  it('a record with nothing to rewrite is not purged: the purge follows a write only', async () => {
    const result = await scrub(record(SECRET_EXPR));

    expect(result.recordsChanged).toBe(0);
    expect(names()).toEqual([]);
  });
});

describe('--purge-history purges every EXAMINED record, rewritten or not (go-to-k/cdkd#2624)', () => {
  let sent: Sent[];

  const client = (): S3Client =>
    ({
      send: (cmd: unknown): Promise<unknown> => {
        const c = cmd as { constructor: { name: string }; input: Sent['input'] };
        sent.push({ name: c.constructor.name, input: c.input });
        if (c.constructor.name === 'PutObjectCommand') return Promise.resolve({ ETag: '"e2"' });
        if (c.constructor.name === 'ListObjectVersionsCommand') {
          return Promise.resolve({
            Versions: [
              { Key: STATE_KEY, VersionId: 'legacy-plaintext', IsLatest: false },
              { Key: STATE_KEY, VersionId: 'current', IsLatest: true },
            ],
            IsTruncated: false,
          });
        }
        if (c.constructor.name === 'GetBucketReplicationCommand') {
          return Promise.reject(
            Object.assign(new Error('none'), { name: 'ReplicationConfigurationNotFoundError' })
          );
        }
        return Promise.resolve({});
      },
      destroy: vi.fn(),
    }) as unknown as S3Client;

  async function scrub(stored: StackState, o: { dryRun?: boolean; purgeHistory?: boolean; info?: unknown }) {
    const backend = new S3StateBackend(client(), { bucket: BUCKET, prefix: 'cdkd' });
    vi.spyOn(backend, 'getState').mockResolvedValue({ state: stored, etag: '"e1"' });
    const lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    return scrubStack((o.info ?? stackInfo) as never, REGION, backend, lockManager as never, {
      dryRun: o.dryRun ?? false,
      purgeHistory: o.purgeHistory ?? false,
      logger: logger as never,
    }).catch((e: unknown) => e);
  }
  const names = (): string[] => sent.map((s) => s.name);

  beforeEach(() => {
    clearReplicationProbeCache();
    sent = [];
  });

  it('a CLEAN record (a deploy already rewrote it) is purged with the flag, never written', async () => {
    const result = (await scrub(record(SECRET_EXPR), { purgeHistory: true })) as {
      recordsChanged: number;
      historyPurged?: true;
    };

    expect(result.recordsChanged).toBe(0);
    expect(result.historyPurged).toBe(true);
    expect(names()).toEqual([
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
      'GetBucketReplicationCommand',
    ]);
    expect(sent[0]!.input.Prefix).toBe(STATE_KEY);
    expect(sent[1]!.input.Delete?.Objects).toEqual([
      { Key: STATE_KEY, VersionId: 'legacy-plaintext' },
    ]);
  });

  it('...and WITHOUT the flag the same clean record is left alone (recovery history kept)', async () => {
    const result = (await scrub(record(SECRET_EXPR), {})) as { historyPurged?: true };

    expect(result.historyPurged).toBeUndefined();
    expect(names()).toEqual([]);
  });

  it('a record whose template names NO secret (the zero-needle return) is purged with the flag', async () => {
    const noSecret = {
      stackName: STACK,
      template: {
        Resources: {
          Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: 'app-db' } },
        },
      } as CloudFormationTemplate,
    };
    const result = (await scrub(record('some-literal'), { purgeHistory: true, info: noSecret })) as {
      secretsFound: number;
      historyPurged?: true;
    };

    expect(result.secretsFound).toBe(0);
    expect(result.historyPurged).toBe(true);
    expect(names()).toContain('DeleteObjectsCommand');
  });

  it('a REWRITTEN record is purged once, by the write, not twice', async () => {
    const result = (await scrub(record(SECRET_PLAINTEXT), { purgeHistory: true })) as {
      historyPurged?: true;
    };

    expect(result.historyPurged).toBeUndefined();
    expect(names().filter((n) => n === 'ListObjectVersionsCommand')).toHaveLength(1);
    expect(names()[0]).toBe('PutObjectCommand');
  });

  it('--dry-run with the flag purges nothing (scrubStack ignores it there too)', async () => {
    await scrub(record(SECRET_EXPR), { dryRun: true, purgeHistory: true });

    expect(names()).toEqual([]);
  });

  it('a REFUSED record is never purged: its history may be the only evidence', async () => {
    const malformed = { ...record(SECRET_EXPR), resources: 'abc' as never };
    const result = await scrub(malformed, { purgeHistory: true });

    expect(result).toBeInstanceOf(Error);
    expect(names()).toEqual([]);
  });
});

describe('a LEGACY pre-region-layout record is migrated and both keys purged (go-to-k/cdkd#2624)', () => {
  const LEGACY_KEY = `cdkd/${STACK}/state.json`;
  let sent: Sent[];
  let putRequests: Array<{ Key?: string; IfMatch?: string }>;
  let legacyDeleteFails: boolean;
  let legacyReadDenied: boolean;

  const client = (): S3Client =>
    ({
      send: (cmd: unknown): Promise<unknown> => {
        const c = cmd as {
          constructor: { name: string };
          input: Sent['input'] & { IfMatch?: string };
        };
        sent.push({ name: c.constructor.name, input: c.input });
        switch (c.constructor.name) {
          case 'PutObjectCommand':
            putRequests.push({ Key: c.input.Key, IfMatch: c.input.IfMatch });
            // What S3 does with an If-Match against a key that does not exist.
            if (c.input.IfMatch !== undefined) {
              return Promise.reject(
                Object.assign(new Error('Precondition Failed'), { name: 'PreconditionFailed' })
              );
            }
            return Promise.resolve({ ETag: '"new"' });
          case 'ListObjectVersionsCommand': {
            const key = c.input.Prefix;
            return Promise.resolve({
              Versions:
                key === LEGACY_KEY
                  ? [{ Key: LEGACY_KEY, VersionId: 'legacy-plaintext', IsLatest: false }]
                  : [
                      { Key: STATE_KEY, VersionId: 'new-old', IsLatest: false },
                      { Key: STATE_KEY, VersionId: 'new-current', IsLatest: true },
                    ],
              DeleteMarkers:
                key === LEGACY_KEY
                  ? [{ Key: LEGACY_KEY, VersionId: 'legacy-marker', IsLatest: true }]
                  : [],
              IsTruncated: false,
            });
          }
          case 'GetBucketReplicationCommand':
            return Promise.reject(
              Object.assign(new Error('none'), { name: 'ReplicationConfigurationNotFoundError' })
            );
          case 'DeleteObjectCommand':
            return legacyDeleteFails
              ? Promise.reject(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }))
              : Promise.resolve({});
          case 'GetObjectCommand':
            // The post-migration check of the legacy key: gone unless the
            // delete failed.
            if (legacyReadDenied) {
              return Promise.reject(
                Object.assign(new Error('Service Unavailable'), {
                  name: 'ServiceUnavailable',
                  $metadata: { httpStatusCode: 503 },
                })
              );
            }
            return legacyDeleteFails
              ? Promise.resolve({ Body: { transformToString: () => Promise.resolve('{}') } })
              : Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
          default:
            return Promise.resolve({});
        }
      },
      destroy: vi.fn(),
    }) as unknown as S3Client;

  async function scrub(stored: StackState, purgeHistory = false, info: unknown = stackInfo) {
    const backend = new S3StateBackend(client(), { bucket: BUCKET, prefix: 'cdkd' });
    // `getState`'s legacy fallback: the etag is the LEGACY key's.
    vi.spyOn(backend, 'getState').mockResolvedValue({
      state: stored,
      etag: '"legacy-etag"',
      migrationPending: true,
    });
    const lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    return scrubStack(info as never, REGION, backend, lockManager as never, {
      dryRun: false,
      purgeHistory,
      logger: logger as never,
    });
  }
  const deleted = (): string[] =>
    sent
      .filter((x) => x.name === 'DeleteObjectsCommand')
      .flatMap((x) => (x.input.Delete?.Objects ?? []).map((o) => `${o.Key}@${o.VersionId}`));

  beforeEach(() => {
    clearReplicationProbeCache();
    sent = [];
    putRequests = [];
    legacyDeleteFails = false;
    legacyReadDenied = false;
    backendWarn.mockReset();
  });

  it('a legacy key whose survival cannot be CHECKED (a 5xx) is a refusal naming the key, still purging', async () => {
    legacyReadDenied = true;

    // Not the raw SDK error: the write landed, a re-run would never look at
    // the legacy key again, so the failure says what is unverified.
    const err = (await scrub(record(SECRET_PLAINTEXT)).then(
      () => undefined,
      (e: unknown) => e
    )) as (Error & { code?: string }) | undefined;
    expect(err).toMatchObject({ code: 'SCRUB_LEGACY_STATE_KEY_UNVERIFIED' });
    expect(err!.message).toContain(LEGACY_KEY);
    expect(err!.message).toContain('could not be verified');
    expect(err!.message).toContain('Service Unavailable');
    expect(putRequests).toEqual([{ Key: STATE_KEY, IfMatch: undefined }]);
    expect(deleted().sort()).toEqual([`${LEGACY_KEY}@legacy-plaintext`, `${STATE_KEY}@new-old`]);
  });

  it('a LEGACY record whose template names no secret (the zero-needle return) purges both keys with --purge-history', async () => {
    const noSecret = {
      stackName: STACK,
      template: {
        Resources: {
          Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: 'app-db' } },
        },
      } as CloudFormationTemplate,
    };
    const result = (await scrub(record('some-literal'), true, noSecret)) as {
      secretsFound: number;
      historyPurged?: true;
    };

    expect(result.secretsFound).toBe(0);
    expect(result.historyPurged).toBe(true);
    expect(putRequests).toEqual([]);
    expect(deleted().sort()).toEqual([`${LEGACY_KEY}@legacy-plaintext`, `${STATE_KEY}@new-old`]);
  });

  it('a legacy key that SURVIVES the migration delete fails the stack, and both histories are still purged', async () => {
    legacyDeleteFails = true;

    await expect(scrub(record(SECRET_PLAINTEXT))).rejects.toMatchObject({
      code: 'SCRUB_LEGACY_STATE_KEY_SURVIVES',
    });
    const getLegacy = sent.find((x) => x.name === 'GetObjectCommand');
    expect(getLegacy?.input.Key).toBe(LEGACY_KEY);
    expect(deleted().sort()).toEqual([`${LEGACY_KEY}@legacy-plaintext`, `${STATE_KEY}@new-old`]);
  });

  it('a REWRITE migrates: no If-Match on the new key, the legacy key deleted, both histories purged', async () => {
    const result = await scrub(record(SECRET_PLAINTEXT));

    expect(result.recordsChanged).toBeGreaterThan(0);
    // The pre-fix shape: an If-Match carrying the LEGACY key's etag against the
    // new key, which S3 refuses, so the stack failed and the plaintext stayed.
    expect(putRequests).toEqual([{ Key: STATE_KEY, IfMatch: undefined }]);
    const deleteObject = sent.find((x) => x.name === 'DeleteObjectCommand');
    expect(deleteObject?.input.Key).toBe(LEGACY_KEY);
    // Both keys' noncurrent bodies go; the current object and the legacy
    // delete marker stay.
    expect(deleted().sort()).toEqual([`${LEGACY_KEY}@legacy-plaintext`, `${STATE_KEY}@new-old`]);
  });

  it('a CLEAN legacy record is left alone without the flag: no write, no migration, no purge', async () => {
    await scrub(record(SECRET_EXPR));

    expect(sent).toEqual([]);
  });

  it('...and with --purge-history both keys are purged, still without a write', async () => {
    const result = (await scrub(record(SECRET_EXPR), true)) as { historyPurged?: true };

    expect(result.historyPurged).toBe(true);
    expect(putRequests).toEqual([]);
    expect(sent.find((x) => x.name === 'DeleteObjectCommand')).toBeUndefined();
    expect(deleted().sort()).toEqual([`${LEGACY_KEY}@legacy-plaintext`, `${STATE_KEY}@new-old`]);
  });
});

describe('the keys scrub purges are the keys the stores write (go-to-k/cdkd#2624)', () => {
  // Bracket access reaches the private key builders, so a layout change in
  // either store fails here instead of leaving scrub purging a key nothing
  // writes.
  const backend = new S3StateBackend({} as S3Client, { bucket: BUCKET, prefix: 'my-prefix' });

  it('state.json, including a nested child state name', () => {
    for (const name of [STACK, 'Parent~Child']) {
      expect(scrubbedStateKey(backend, name, 'eu-west-1')).toBe(
        backend['getStateKey'](name, 'eu-west-1')
      );
    }
  });

  it('the legacy pre-region state.json', () => {
    expect(scrubbedLegacyStateKey(backend, STACK)).toBe(backend['getLegacyStateKey'](STACK));
  });

  it('the region exports index', () => {
    const store = new ExportIndexStore({} as S3Client, BUCKET, 'my-prefix', 'eu-west-1', backend);
    expect(scrubbedExportIndexKey(backend, 'eu-west-1')).toBe(store['indexKey']());
  });
});
