/**
 * go-to-k/cdkd#5212: the refactor marker's S3 surface on `S3StateBackend` --
 * `refactorMarkerKey`, `getRefactorMarker` and `saveRefactorMarker`. Harness
 * copied from the smallest existing S3StateBackend double
 * (`s3-state-backend-cross-prefix-4705.test.ts`): a fake client dispatching by
 * command type, with `resolveBucketRegion` mocked so no real
 * `GetBucketLocation` call is made.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  type S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/utils/aws-region-resolver.js')
  >('../../../src/utils/aws-region-resolver.js');
  return { ...actual, resolveBucketRegion: vi.fn() };
});

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...quiet, child: () => quiet }) };
});

const noSuchKey = (): Error =>
  Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
const preconditionFailed = (): Error =>
  Object.assign(new Error('PreconditionFailed'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 },
  });

/** Body text for the marker key, or an error GET/PUT/DELETE answers with instead. */
let body: string | undefined;
let bodyError: Error | undefined;

function makeClient(): { send: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; config: unknown } {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetObjectCommand) {
      if (bodyError) throw bodyError;
      if (body === undefined) throw noSuchKey();
      return { Body: { transformToString: async () => body }, ETag: '"e1"' };
    }
    if (cmd instanceof PutObjectCommand) {
      if (bodyError) throw bodyError;
      body = String(cmd.input.Body);
      return { ETag: '"e2"' };
    }
    if (cmd instanceof DeleteObjectCommand) {
      if (bodyError) throw bodyError;
      body = undefined;
      return {};
    }
    throw new Error(`unexpected command ${String(cmd)}`);
  });
  return {
    send,
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve('us-east-1'),
      credentials: () => Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'x' }),
    },
  };
}

let client: ReturnType<typeof makeClient>;
let backend: S3StateBackend;

function commandsOf<T>(ctor: new (...args: never[]) => T): T[] {
  return client.send.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearBucketRegionCache();
  const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
  vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
  body = undefined;
  bodyError = undefined;
  client = makeClient();
  backend = new S3StateBackend(
    client as unknown as S3Client,
    { bucket: 'b', prefix: 'team-a' },
    { region: 'us-east-1' }
  );
});

describe('refactorMarkerKey', () => {
  it('is `<prefix>/_refactor/pending.json` for a custom prefix', () => {
    expect(backend.refactorMarkerKey()).toBe('team-a/_refactor/pending.json');
  });
});

describe('getRefactorMarker', () => {
  it('returns null on NoSuchKey', async () => {
    await expect(backend.getRefactorMarker()).resolves.toBeNull();
  });

  it('returns {body, etag} on success', async () => {
    body = JSON.stringify({ moves: [] });
    await expect(backend.getRefactorMarker()).resolves.toEqual({
      body: { moves: [] },
      etag: '"e1"',
    });
  });

  it('returns {body: undefined, etag} on non-JSON text', async () => {
    body = 'not json';
    await expect(backend.getRefactorMarker()).resolves.toEqual({ body: undefined, etag: '"e1"' });
  });

  it('every GET carries ExpectedBucketOwner', async () => {
    body = JSON.stringify({ moves: [] });
    await backend.getRefactorMarker();
    const [get] = commandsOf(GetObjectCommand);
    expect(get.input).toMatchObject({
      Bucket: 'b',
      Key: 'team-a/_refactor/pending.json',
      ExpectedBucketOwner: '999999999999',
    });
  });
});

describe('saveRefactorMarker', () => {
  it('sends PutObject with IfNoneMatch "*" when etag is null', async () => {
    await expect(
      backend.saveRefactorMarker({ moves: [{ from: 'A' }] }, null)
    ).resolves.toBe('saved');
    const [put] = commandsOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'b',
      Key: 'team-a/_refactor/pending.json',
      IfNoneMatch: '*',
      ExpectedBucketOwner: '999999999999',
    });
    expect(put.input.IfMatch).toBeUndefined();
  });

  it('sends PutObject with IfMatch when an etag is given', async () => {
    await expect(
      backend.saveRefactorMarker({ moves: [{ from: 'A' }] }, '"e1"')
    ).resolves.toBe('saved');
    const [put] = commandsOf(PutObjectCommand);
    expect(put.input).toMatchObject({ IfMatch: '"e1"' });
    expect(put.input.IfNoneMatch).toBeUndefined();
  });

  it('sends DeleteObject with IfMatch when moves is empty and an etag is given', async () => {
    await expect(backend.saveRefactorMarker({ moves: [] }, '"e1"')).resolves.toBe('saved');
    const [del] = commandsOf(DeleteObjectCommand);
    expect(del.input).toMatchObject({
      Bucket: 'b',
      Key: 'team-a/_refactor/pending.json',
      IfMatch: '"e1"',
      ExpectedBucketOwner: '999999999999',
    });
  });

  it('sends nothing when moves is empty and etag is null', async () => {
    await expect(backend.saveRefactorMarker({ moves: [] }, null)).resolves.toBe('saved');
    expect(commandsOf(PutObjectCommand)).toHaveLength(0);
    expect(commandsOf(DeleteObjectCommand)).toHaveLength(0);
  });

  it('returns "conflict" on a PreconditionFailed (412) error from Put', async () => {
    bodyError = preconditionFailed();
    await expect(backend.saveRefactorMarker({ moves: [{ from: 'A' }] }, '"stale"')).resolves.toBe(
      'conflict'
    );
  });

  it('returns "conflict" on a PreconditionFailed (412) error from Delete', async () => {
    bodyError = preconditionFailed();
    await expect(backend.saveRefactorMarker({ moves: [] }, '"stale"')).resolves.toBe('conflict');
  });
});
