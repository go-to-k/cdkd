/**
 * `ExportIndexStore.readPersistedEntries` — the READ that does not write
 * (issue [#2667](https://github.com/go-to-k/cdkd/issues/2667)), and
 * `patchEntry`'s success/failure return.
 *
 * `cdkd scrub` audits the exports index under `--dry-run`, where the command
 * performs no S3 write at all. Every other read path in this store goes through
 * `ensureLoaded` -> `doLoad`, which REBUILDS on a missing or corrupt object,
 * and a rebuild is a `listStacks` fan-out plus a PutObject. So the audit needs
 * a read whose only S3 verb is GET.
 *
 * The second half is `patchEntry`'s return. `runWithRetry` swallows a
 * non-retryable failure and an exhausted If-Match budget — right for the deploy
 * path, which treats the index as a derived view — so scrub, for which the
 * entry's value IS what it went to change, has to be able to see that the write
 * did not happen.
 */

import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { S3Client } from '@aws-sdk/client-s3';
import {
  ExportIndexStore,
  EXPORT_INDEX_VERSION,
  type ExportIndexFile,
} from '../../../src/state/export-index-store.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const loggerSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: loggerSpies.info,
    warn: loggerSpies.warn,
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '111111111111' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return { ...actual, S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })) };
});

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/aws-region-resolver.js')>(
    '../../../src/utils/aws-region-resolver.js'
  );
  return { ...actual, resolveBucketRegion: vi.fn() };
});

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/**
 * A client double whose `config.region` is NOT a function, so
 * `ensureClientForBucket` degrades and no GetBucketLocation is issued — the
 * shape the sibling suite uses for its happy paths.
 */
function mockS3(handler: (cmd: Sent) => Promise<unknown>): { client: S3Client; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: vi.fn((cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const record = { name: cmd.constructor.name, input: cmd.input };
      sent.push(record);
      return handler(record);
    }),
    destroy: vi.fn(),
  } as unknown as S3Client;
  return { client, sent };
}

/**
 * A backend whose `listStacks` THROWS. A rebuild cannot complete without it, so
 * any case that reaches one fails loudly here instead of quietly writing —
 * which is the property every case in the first describe is about.
 */
function noRebuildBackend(): S3StateBackend {
  return {
    listStacks: vi.fn(() => {
      throw new Error('listStacks called: this case must not reach a rebuild');
    }),
    getState: vi.fn(),
  } as unknown as S3StateBackend;
}

function indexBody(exports: ExportIndexFile['exports']): string {
  return JSON.stringify({
    indexVersion: EXPORT_INDEX_VERSION,
    region: 'us-east-1',
    exports,
    lastModified: 1,
  } satisfies ExportIndexFile);
}

function notFound(): Error {
  const err = new Error('NoSuchKey');
  err.name = 'NoSuchKey';
  return err;
}

describe('ExportIndexStore.readPersistedEntries issues no PutObject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the persisted entries and sends only a GetObject', async () => {
    const { client, sent } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(
                indexBody({
                  MyExport: {
                    value: 'v1',
                    producerStack: 'Producer',
                    producerRegion: 'us-east-1',
                  },
                })
              ),
          },
          ETag: '"etag-1"',
        });
      }
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    const entries = await store.readPersistedEntries();

    expect(entries?.get('MyExport')).toEqual({
      value: 'v1',
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
    });
    expect(sent.map((s) => s.name)).toEqual(['GetObjectCommand']);
    expect(sent[0]!.input['Key']).toBe('cdkd/_index/us-east-1/exports.json');
  });

  it('returns undefined for a MISSING object and never rebuilds it', async () => {
    // `lookup` here would take `doLoad`'s rebuild arm: a `listStacks` fan-out
    // and a PutObject. `noRebuildBackend` turns that into a thrown error, so
    // this case discriminates between "did not rebuild" and "rebuilt quietly".
    const { client, sent } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') return Promise.reject(notFound());
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    await expect(store.readPersistedEntries()).resolves.toBeUndefined();
    expect(sent.map((s) => s.name)).toEqual(['GetObjectCommand']);
  });

  it('THROWS on a CORRUPT body — never `undefined`, and never a rebuild', async () => {
    // The DISCRIMINATOR against the missing case above, and the reason the two
    // may not share a return value: `undefined` reads as "no index", so a
    // caller reports nothing over bytes it could not interpret — bytes that
    // may still hold the plaintext. That is issue #2667's own failure shape
    // reproduced one level down, and it is what `cdkd scrub` routes into its
    // explicit `SCRUB_EXPORT_INDEX_INCOMPLETE` failure.
    const { client, sent } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: { transformToString: () => Promise.resolve('{ not json') },
          ETag: '"etag-1"',
        });
      }
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    await expect(store.readPersistedEntries()).rejects.toThrow(/could not be parsed/);
    // Still no PUT: `doLoad`'s corrupt arm REBUILDS, and this read must not.
    expect(sent.map((s) => s.name)).toEqual(['GetObjectCommand']);
  });

  it('the corrupt throw carries NO bytes of the body (issue #2667 review)', async () => {
    // V8 embeds a window of the INPUT in its `JSON.parse` message, and this
    // index holds resolved Output VALUES — for the unscrubbed state this
    // command targets, exactly the plaintext. The message reaches a
    // `logger.error` and the command's failure text, i.e. `--dry-run --fail`
    // CI logs. Same class as the `import.ts` parse-snippet leak (#2829).
    //
    // The needle is placed where V8's window lands: adjacent to the syntax
    // error, which is what makes this discriminate rather than assert over a
    // message that never had a chance to carry it.
    const SECRET = 'hunter2SECRETPASSWORD';
    const { client } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(`{"indexVersion":1,"exports":{"K":{"value":${SECRET}}}}`),
          },
          ETag: '"etag-1"',
        });
      }
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    const err = await store.readPersistedEntries().then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    // PREMISE: the raw V8 message really does carry it, so this case is not
    // asserting over an input V8 would never have echoed.
    let rawCarriedIt = false;
    try {
      JSON.parse(`{"indexVersion":1,"exports":{"K":{"value":${SECRET}}}}`);
    } catch (e) {
      rawCarriedIt = (e as Error).message.includes(SECRET.slice(0, 8));
    }
    expect(rawCarriedIt).toBe(true);
    // THE ASSERTION: not one byte of that window survives into cdkd's message.
    expect(err!.message).not.toContain(SECRET.slice(0, 8));
    expect(err!.message).not.toContain('hunter');
    // What DOES survive is content-independent and still locates the damage.
    expect(err!.message).toMatch(/invalid JSON/);
    expect(err!.message).toMatch(/byte\(s\) read/);
  });

  it('the indexVersion refusal renders the TYPE, never a body-controlled value', async () => {
    // `String(x)` renders a JSON string as itself and a one-element array as
    // its element — measured on node v24.19.0 — so only an object degrades to
    // `[object Object]`. The array shape is the one that leaks verbatim.
    const SECRET = 'hunter2SECRETPASSWORD';
    const { client } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(`{"indexVersion":["${SECRET}"],"region":"us-east-1","exports":{}}`),
          },
          ETag: '"etag-1"',
        });
      }
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    const err = await store.readPersistedEntries().then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(SECRET);
    expect(err!.message).toContain('a non-numeric value (object)');
  });

  it('THROWS on an indexVersion this binary cannot interpret', async () => {
    // Not downgraded to the `undefined` the two arms above return: a rebuild —
    // or a caller reading "no index" — would replace a newer binary's object
    // with this binary's view of it.
    const { client } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(
                JSON.stringify({
                  indexVersion: EXPORT_INDEX_VERSION + 1,
                  region: 'us-east-1',
                  exports: {},
                  lastModified: 1,
                })
              ),
          },
          ETag: '"etag-1"',
        });
      }
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    await expect(store.readPersistedEntries()).rejects.toThrow(/newer than this cdkd binary/);
  });

  it('a later patchEntry writes under the etag the read cached', async () => {
    const { client, sent } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(
                indexBody({
                  MyExport: {
                    value: 'plaintext',
                    producerStack: 'Producer',
                    producerRegion: 'us-east-1',
                  },
                })
              ),
          },
          ETag: '"etag-1"',
        });
      }
      if (cmd.name === 'PutObjectCommand') return Promise.resolve({ ETag: '"etag-2"' });
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    await store.readPersistedEntries();
    const written = await store.patchEntry('MyExport', {
      value: '{{resolve:secretsmanager:s:SecretString:p::}}',
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
    });

    expect(written).toBe(true);
    // ONE GetObject total: the patch reused the snapshot rather than re-reading.
    expect(sent.filter((s) => s.name === 'GetObjectCommand')).toHaveLength(1);
    const put = sent.find((s) => s.name === 'PutObjectCommand');
    expect(put?.input['IfMatch']).toBe('"etag-1"');
    const body = JSON.parse(String(put?.input['Body'])) as ExportIndexFile;
    expect(body.exports['MyExport']).toEqual({
      value: '{{resolve:secretsmanager:s:SecretString:p::}}',
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
    });
    // Membership unchanged — the patch replaces one value and adds no name.
    expect(Object.keys(body.exports)).toEqual(['MyExport']);
  });

  it('patchEntry returns FALSE when the PUT fails non-retryably', async () => {
    const { client } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(
                indexBody({
                  MyExport: {
                    value: 'plaintext',
                    producerStack: 'Producer',
                    producerRegion: 'us-east-1',
                  },
                })
              ),
          },
          ETag: '"etag-1"',
        });
      }
      if (cmd.name === 'PutObjectCommand') {
        const err = new Error('Access Denied');
        err.name = 'AccessDenied';
        return Promise.reject(err);
      }
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    await store.readPersistedEntries();

    // It does NOT throw — that is the store's contract, and the reason the
    // return value has to carry the outcome instead.
    await expect(
      store.patchEntry('MyExport', {
        value: 'converged',
        producerStack: 'Producer',
        producerRegion: 'us-east-1',
      })
    ).resolves.toBe(false);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('Exports index patch failed (non-retryable)')
    );
  });

  it('patchEntry REFUSES when the entry it was asked to patch changed owner', async () => {
    // The plan reads a SNAPSHOT; an If-Match conflict reloads the index under
    // the retry, so a concurrent deploy can take the export name over in that
    // window and the store keeps the latest writer with only a warning (issue
    // #2193). Re-asserting the snapshot's owner would resurrect the old value.
    const { client, sent } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(
                indexBody({
                  MyExport: {
                    value: 'theirs',
                    producerStack: 'AnotherProducer',
                    producerRegion: 'us-east-1',
                  },
                })
              ),
          },
          ETag: '"etag-1"',
        });
      }
      if (cmd.name === 'PutObjectCommand') return Promise.resolve({ ETag: '"etag-2"' });
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    await expect(
      store.patchEntry(
        'MyExport',
        { value: 'mine', producerStack: 'Producer', producerRegion: 'us-east-1' },
        { requireOwner: { producerStack: 'Producer', producerRegion: 'us-east-1' } }
      )
    ).resolves.toBe(false);
    // The discriminator is the absence of the PUT, not just the `false`.
    expect(sent.filter((s) => s.name === 'PutObjectCommand')).toHaveLength(0);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('ownership changed under a patch')
    );
  });

  it('patchEntry PROCEEDS when requireOwner still matches the current entry', async () => {
    // The other direction: the guard must not refuse the ordinary case.
    const { client, sent } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(
                indexBody({
                  MyExport: {
                    value: 'legacy',
                    producerStack: 'Producer',
                    producerRegion: 'us-east-1',
                  },
                })
              ),
          },
          ETag: '"etag-1"',
        });
      }
      if (cmd.name === 'PutObjectCommand') return Promise.resolve({ ETag: '"etag-2"' });
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend()
    );

    await expect(
      store.patchEntry(
        'MyExport',
        { value: 'converged', producerStack: 'Producer', producerRegion: 'us-east-1' },
        { requireOwner: { producerStack: 'Producer', producerRegion: 'us-east-1' } }
      )
    ).resolves.toBe(true);
    expect(sent.filter((s) => s.name === 'PutObjectCommand')).toHaveLength(1);
  });

  it('patchEntry returns FALSE when the If-Match budget is exhausted', async () => {
    const { client } = mockS3((cmd) => {
      if (cmd.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(
                indexBody({
                  MyExport: {
                    value: 'plaintext',
                    producerStack: 'Producer',
                    producerRegion: 'us-east-1',
                  },
                })
              ),
          },
          ETag: '"etag-1"',
        });
      }
      if (cmd.name === 'PutObjectCommand') {
        const err = new Error('At least one of the pre-conditions you specified did not hold');
        err.name = 'PreconditionFailed';
        return Promise.reject(err);
      }
      throw new Error(`unexpected ${cmd.name}`);
    });
    const store = new ExportIndexStore(
      client,
      'cdkd-state-bucket',
      'cdkd',
      'us-east-1',
      noRebuildBackend(),
      { maxWriteRetries: 2, initialBackoffMs: 1, maxBackoffMs: 1 }
    );

    await expect(
      store.patchEntry('MyExport', {
        value: 'converged',
        producerStack: 'Producer',
        producerRegion: 'us-east-1',
      })
    ).resolves.toBe(false);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('exhausted 2 retries due to concurrent writers')
    );
  });
});
