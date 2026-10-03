import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StateBackendConfig } from '../../../src/types/config.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';

// The backend's standard-shaped client double passes
// resolveExpectedBucketOwner's structural guard, so STS must be mocked —
// otherwise every test issues a LIVE GetCallerIdentity (PR 1015 reviewer
// catch). With the mock, every state-bucket command is asserted to carry
// ExpectedBucketOwner (the positive pin for the squatting hardening).
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
      destroy: vi.fn(),
    })),
  };
});

// Mock the region resolver so tests don't issue real GetBucketLocation calls.
// Each test case overrides the implementation as needed.
vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/utils/aws-region-resolver.js')
  >('../../../src/utils/aws-region-resolver.js');
  return {
    ...actual,
    resolveBucketRegion: vi.fn(),
  };
});

// The child double is HOISTED and stable rather than a fresh `vi.fn()` per
// `child()` call, so a debug-only side effect is assertable at all. It has to
// be: `listRawObjects` DROPS a malformed `Contents` entry, and the returned
// list is a shorter array with no other signal — the debug line is the only
// place a caller can ever observe the drop.
const { childLoggerMock } = vi.hoisted(() => ({
  childLoggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLoggerMock,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/**
 * Build a fake S3Client whose `.config.region()` returns the given region.
 * Mirrors the shape S3StateBackend reads in `ensureClientForBucket`.
 */
function makeFakeClient(region: string): {
  send: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  config: {
    region: () => Promise<string>;
    credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string }>;
  };
} {
  return {
    send: vi.fn(),
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve(region),
      // Standard-shaped credentials so resolveExpectedBucketOwner resolves
      // via the MOCKED STS above — every command then carries
      // ExpectedBucketOwner: '999999999999' (the positive hardening pin).
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

import {
  CREATE_TOKEN_LEDGER_VERSION,
  emptyCreateTokenLedger,
  parseCreateTokenLedger,
  withStateSavedObserver,
} from '../../../src/state/create-token-ledger.js';
import { StateError } from '../../../src/utils/error-handler.js';
import type { StackState } from '../../../src/types/state.js';

/** go-to-k/cdkd#4438: the per-stack create-token ledger and its lifecycle. */
describe('parseCreateTokenLedger', () => {
  const valid = {
    ledgerVersion: CREATE_TOKEN_LEDGER_VERSION,
    nonce: 'n-1',
    sent: { Fs: { base: 'cdkd-Fs-aaa', token: 'cdkd-Fs-bbb', firstSentAt: 1000 } },
  };

  it('reads a well-formed ledger', () => {
    const doc = parseCreateTokenLedger(JSON.stringify(valid));
    expect(doc?.nonce).toBe('n-1');
    expect(doc?.sent['Fs']).toEqual({ base: 'cdkd-Fs-aaa', token: 'cdkd-Fs-bbb', firstSentAt: 1000 });
  });

  it.each([
    ['not JSON', '{'],
    ['a non-object', '5'],
    ['an unknown version', JSON.stringify({ ...valid, ledgerVersion: 99 })],
    ['an empty nonce', JSON.stringify({ ...valid, nonce: '' })],
    ['no nonce', JSON.stringify({ ledgerVersion: CREATE_TOKEN_LEDGER_VERSION, sent: {} })],
  ])('reads %s as no ledger (a fresh nonce: at worst a re-run creates anew)', (_label, body) => {
    expect(parseCreateTokenLedger(body)).toBeNull();
  });

  it('keeps `stateRecorded` only when it is exactly true', () => {
    expect(parseCreateTokenLedger(JSON.stringify({ ...valid, stateRecorded: true }))?.stateRecorded).toBe(
      true
    );
    for (const odd of [false, 'true', 1]) {
      expect(
        parseCreateTokenLedger(JSON.stringify({ ...valid, stateRecorded: odd }))
      ).not.toHaveProperty('stateRecorded');
    }
  });

  it('drops a malformed sent entry alone', () => {
    const doc = parseCreateTokenLedger(
      JSON.stringify({
        ...valid,
        sent: { ...valid.sent, Bad: { base: 'x', token: 1, firstSentAt: 'later' } },
      })
    );
    expect(Object.keys(doc!.sent)).toEqual(['Fs']);
  });

  it('keeps a `__proto__` / `constructor` logical id an ordinary entry', () => {
    const entry = { base: 'b', token: 't', firstSentAt: 1 };
    const doc = parseCreateTokenLedger(
      `{"ledgerVersion":${CREATE_TOKEN_LEDGER_VERSION},"nonce":"n","sent":{"__proto__":${JSON.stringify(entry)},"constructor":${JSON.stringify(entry)}}}`
    );
    expect(Object.keys(doc!.sent).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(doc!.sent)).toBeNull();
    expect(emptyCreateTokenLedger('n').sent['constructor']).toBeUndefined();
  });
});

describe('S3StateBackend create-token ledger', () => {
  let s3Client: ReturnType<typeof makeFakeClient>;
  let backend: S3StateBackend;
  const config: StateBackendConfig = { bucket: 'state-bucket', prefix: 'cdkd' };
  const KEY = 'cdkd/S/us-east-1/create-tokens.json';

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    s3Client = makeFakeClient('us-east-1');
    backend = new S3StateBackend(s3Client as unknown as S3Client, config);
  });

  const sentOf = <C,>(cls: new (...args: never[]) => C): C[] =>
    s3Client.send.mock.calls.map((c: unknown[]) => c[0]).filter((c: unknown) => c instanceof cls) as C[];

  it('reads the sibling key of state.json, and an absent ledger as null', async () => {
    s3Client.send.mockRejectedValueOnce(new NoSuchKey({ message: 'none', $metadata: {} }));
    await expect(backend.loadCreateTokenLedger('S', 'us-east-1')).resolves.toBeNull();
    expect((sentOf(GetObjectCommand)[0] as GetObjectCommand).input.Key).toBe(KEY);
  });

  it('throws on a failed read (the caller refuses its creates, it does not mint over it)', async () => {
    s3Client.send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(backend.loadCreateTokenLedger('S', 'us-east-1')).rejects.toThrow('denied');
  });

  it('writes the ledger to the sibling key', async () => {
    s3Client.send.mockResolvedValueOnce({});
    await backend.saveCreateTokenLedger('S', 'us-east-1', emptyCreateTokenLedger('n-1'));
    const put = sentOf(PutObjectCommand)[0] as PutObjectCommand;
    expect(put.input.Key).toBe(KEY);
    expect(JSON.parse(String(put.input.Body)).nonce).toBe('n-1');
  });

  it('rotates the nonce and drops only the orphaned ids\' sent entries', async () => {
    const doc = {
      ledgerVersion: CREATE_TOKEN_LEDGER_VERSION,
      nonce: 'old',
      sent: {
        Orphaned: { base: 'b1', token: 't1', firstSentAt: 1 },
        Other: { base: 'b2', token: 't2', firstSentAt: 2 },
      },
    };
    s3Client.send
      .mockResolvedValueOnce({ Body: { transformToString: () => Promise.resolve(JSON.stringify(doc)) } })
      .mockResolvedValueOnce({});
    await backend.rotateCreateTokenNonce('S', 'us-east-1', ['Orphaned']);
    const written = JSON.parse(String((sentOf(PutObjectCommand)[0] as PutObjectCommand).input.Body));
    expect(written.nonce).not.toBe('old');
    expect(Object.keys(written.sent)).toEqual(['Other']);
  });

  it('a rotation whose WRITE fails rejects: `cdkd orphan` relies on it to stop', async () => {
    s3Client.send
      .mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ ledgerVersion: CREATE_TOKEN_LEDGER_VERSION, nonce: 'old', sent: {} })
            ),
        },
      })
      .mockRejectedValueOnce(Object.assign(new Error('put denied'), { name: 'AccessDenied' }));
    await expect(backend.rotateCreateTokenNonce('S', 'us-east-1', ['X'])).rejects.toThrow('put denied');
  });

  it('does not create a ledger when rotating a stack that has none', async () => {
    s3Client.send.mockRejectedValueOnce(new NoSuchKey({ message: 'none', $metadata: {} }));
    await backend.rotateCreateTokenNonce('S', 'us-east-1', ['X']);
    expect(sentOf(PutObjectCommand)).toHaveLength(0);
  });

  it('throws from a rotation that cannot be persisted, so `cdkd orphan` stops before dropping the record', async () => {
    s3Client.send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    const error = await backend.rotateCreateTokenNonce('S', 'us-east-1', ['X']).then(
      () => undefined,
      (e: unknown) => e
    );
    // A StateError naming the stack, not the SDK's raw error.
    expect(error).toBeInstanceOf(StateError);
    expect((error as Error).message).toMatch(/create-token ledger of stack .*S.*: denied/);
  });

  it('tells the bound observer of a state save, and only of one that succeeded', async () => {
    const seen: string[] = [];
    const observer = (stackName: string, region: string): Promise<void> => {
      seen.push(`${stackName}/${region}`);
      return Promise.resolve();
    };
    const state = {
      version: 10,
      stackName: 'S',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    s3Client.send.mockResolvedValueOnce({ ETag: '"e1"' });
    await withStateSavedObserver(observer, () => backend.saveState('S', 'us-east-1', state));
    expect(seen).toEqual(['S/us-east-1']);
    s3Client.send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(
      withStateSavedObserver(observer, () => backend.saveState('S', 'us-east-1', state))
    ).rejects.toThrow();
    expect(seen).toEqual(['S/us-east-1']);
  });

  it('deleteState sweeps the ledger with the record', async () => {
    s3Client.send.mockResolvedValue({});
    await backend.deleteState('S', 'us-east-1');
    const deletedKeys = sentOf(DeleteObjectCommand).map((c) => (c as DeleteObjectCommand).input.Key);
    expect(deletedKeys).toContain(KEY);
  });

  it('deleteState deletes the ledger FIRST: a record left behind by a failed state delete has no ledger', async () => {
    s3Client.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteObjectCommand && cmd.input.Key === 'cdkd/S/us-east-1/state.json') {
        throw Object.assign(new Error('throttled'), { name: 'SlowDown' });
      }
      return {};
    });
    await expect(backend.deleteState('S', 'us-east-1')).rejects.toThrow();
    const deletedKeys = sentOf(DeleteObjectCommand).map((c) => (c as DeleteObjectCommand).input.Key);
    expect(deletedKeys[0]).toBe(KEY);
  });

  it('refuses to read a body it does not understand, so it is never overwritten with a fresh nonce', async () => {
    s3Client.send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve(JSON.stringify({ ledgerVersion: 99, nonce: 'n' })) },
    });
    await expect(backend.loadCreateTokenLedger('S', 'us-east-1')).rejects.toThrow(
      /create-tokens\.json beside its state\.json\) is in a format this cdkd version cannot read; upgrade cdkd/
    );
  });

  it('a failed ledger delete fails deleteState BEFORE the record is touched (fail-closed)', async () => {
    s3Client.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteObjectCommand && cmd.input.Key === KEY) {
        throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      }
      return {};
    });
    await expect(backend.deleteState('S', 'us-east-1')).rejects.toThrow(/create-token ledger/);
    const deletedKeys = sentOf(DeleteObjectCommand).map((c) => (c as DeleteObjectCommand).input.Key);
    expect(deletedKeys).not.toContain('cdkd/S/us-east-1/state.json');
  });

  it('an absent ledger does not fail deleteState', async () => {
    s3Client.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteObjectCommand && cmd.input.Key === KEY) {
        throw new NoSuchKey({ message: 'none', $metadata: {} });
      }
      return {};
    });
    await expect(backend.deleteState('S', 'us-east-1')).resolves.toBeUndefined();
  });
});
