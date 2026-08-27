import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#2340](https://github.com/go-to-k/cdkd/issues/2340) — the custom
 * resource RESPONSE SIDECAR must not survive its own cleanup.
 *
 * `cdkd bootstrap` enables versioning on the state bucket, so the
 * `DeleteObject` that `cleanupResponseObject` used to issue on its own writes a
 * DELETE MARKER and leaves the previous versions readable through
 * `GetObject?versionId=`. The body at that key is the handler's FULL
 * cfn-response, `Data` included, so a handler-minted secret stayed retrievable
 * after cdkd reported the response object cleaned up.
 *
 * Every assertion below is on the S3 COMMAND STREAM — which command, with which
 * `Bucket` / `Prefix` / `Delete.Objects` — and never on "cleanup did not throw",
 * which the pre-fix code satisfies just as well.
 */

const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
  }),
}));

const childWarnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: childWarnSpy,
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

/** One recorded S3 command: its class name plus the fields under test. */
interface RecordedS3Command {
  name: string;
  bucket: string | undefined;
  key: string | undefined;
  prefix: string | undefined;
  keyMarker: string | undefined;
  objects: { Key?: string; VersionId?: string }[] | undefined;
}

interface VersionEntry {
  Key?: string;
  VersionId?: string;
  IsLatest?: boolean;
}

interface ListPage {
  Versions?: VersionEntry[];
  DeleteMarkers?: VersionEntry[];
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextVersionIdMarker?: string;
}

interface S3CommandLike {
  constructor: { name: string };
  input: {
    Bucket?: string;
    Key?: string;
    Prefix?: string;
    KeyMarker?: string;
    Delete?: { Objects?: { Key?: string; VersionId?: string }[] };
  };
}

describe('CustomResourceProvider response-object cleanup (issue #2340)', () => {
  let recorded: RecordedS3Command[];

  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    childWarnSpy.mockReset();
    recorded = [];
  });

  /**
   * The two `GetFunction` polls the SDK waiters consume before every Invoke.
   * Queued, so they must be primed before the Invoke handler below.
   */
  const mockLambdaReady = (): void => {
    mockLambdaSend
      .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
      .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } });
  };

  /**
   * A handler that replies DIRECTLY (the sync arm) with a `Data` bag holding a
   * secret it minted. That is the value the sidecar's noncurrent version would
   * keep readable, so the fixture carries a real one rather than a placeholder.
   */
  const mockHandlerReplyWithSecret = (): void => {
    mockLambdaSend.mockResolvedValueOnce({
      Payload: Buffer.from(
        JSON.stringify({
          Status: 'SUCCESS',
          PhysicalResourceId: 'cr-physical-id',
          Data: { GeneratedPassword: 'h4ndl3r-m1nt3d-s3cr3t' },
        })
      ),
    });
  };

  /**
   * Record every S3 command and answer `ListObjectVersions` from `pages`,
   * one page per call. Each page is built from the key the provider actually
   * asked about, so the fixture cannot silently disagree with it about the key.
   */
  const stubS3 = (pages: (key: string) => ListPage[], onList?: () => void): void => {
    let listCall = 0;
    mockS3Send.mockImplementation((cmd: S3CommandLike) => {
      recorded.push({
        name: cmd.constructor.name,
        bucket: cmd.input.Bucket,
        key: cmd.input.Key,
        prefix: cmd.input.Prefix,
        keyMarker: cmd.input.KeyMarker,
        objects: cmd.input.Delete?.Objects,
      });
      if (cmd.constructor.name === 'ListObjectVersionsCommand') {
        onList?.();
        const page = pages(cmd.input.Prefix ?? '')[listCall];
        listCall += 1;
        return Promise.resolve(page ?? {});
      }
      return Promise.resolve({});
    });
  };

  const newProvider = (): CustomResourceProvider =>
    new CustomResourceProvider({ responseBucket: 'test-bucket' });

  const invoke = async (provider: CustomResourceProvider): Promise<void> => {
    mockLambdaReady();
    mockHandlerReplyWithSecret();
    const result = await provider.create('MyCustom', 'Custom::MyResource', {
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
    });
    expect(result.physicalId).toBe('cr-physical-id');
  };

  const responseKeyOf = (): string => {
    const put = recorded.find((c) => c.name === 'PutObjectCommand');
    expect(put?.key).toBeDefined();
    return put!.key!;
  };

  it('purges the response key NONCURRENT versions after deleting it', async () => {
    stubS3((key) => [
      {
        Versions: [
          // The handler's own response body — the version holding the secret.
          { Key: key, VersionId: 'v-response-body', IsLatest: false },
          // The empty placeholder cdkd PUT before signing the ResponseURL.
          { Key: key, VersionId: 'v-placeholder', IsLatest: false },
          // A DIFFERENT key that the `Prefix` listing also returns. Purging it
          // would be a prefix sweep of a SHARED top-level prefix, i.e. taking a
          // concurrent lane's object.
          { Key: `${key}.bak`, VersionId: 'v-other-key', IsLatest: false },
        ],
        DeleteMarkers: [
          // Our own delete marker, now CURRENT. It must survive: `noncurrent`
          // semantics are what make this safe to run beside other deploys.
          { Key: key, VersionId: 'v-delete-marker', IsLatest: true },
        ],
        IsTruncated: false,
      },
    ]);

    await invoke(newProvider());
    const responseKey = responseKeyOf();

    // The key is under the SHARED top-level prefix, not under `cdkd/<stack>/`.
    expect(responseKey).toMatch(/^custom-resource-responses\/cdkd-\d+-[a-z0-9]+\.json$/);

    const del = recorded.find((c) => c.name === 'DeleteObjectCommand');
    expect(del).toBeDefined();
    expect(del!.bucket).toBe('test-bucket');
    expect(del!.key).toBe(responseKey);

    const list = recorded.find((c) => c.name === 'ListObjectVersionsCommand');
    expect(list).toBeDefined();
    expect(list!.bucket).toBe('test-bucket');
    // Scoped to the EXACT key, never to `custom-resource-responses/`.
    expect(list!.prefix).toBe(responseKey);

    const purge = recorded.filter((c) => c.name === 'DeleteObjectsCommand');
    expect(purge).toHaveLength(1);
    expect(purge[0]!.bucket).toBe('test-bucket');
    expect(purge[0]!.objects).toEqual([
      { Key: responseKey, VersionId: 'v-response-body' },
      { Key: responseKey, VersionId: 'v-placeholder' },
    ]);

    // Ordering: delete first (so the body stops being CURRENT), purge second.
    const order = recorded.map((c) => c.name);
    expect(order.indexOf('DeleteObjectCommand')).toBeLessThan(
      order.indexOf('ListObjectVersionsCommand')
    );
    expect(order.indexOf('ListObjectVersionsCommand')).toBeLessThan(
      order.indexOf('DeleteObjectsCommand')
    );
  });

  it('purges a noncurrent `null` version (versioning SUSPENDED bucket)', async () => {
    // A suspended-versioning bucket can hold a genuine noncurrent version whose
    // id is the literal string `null`. Filtering on the id rather than on
    // `IsLatest` would leave exactly that one behind.
    stubS3((key) => [
      {
        Versions: [{ Key: key, VersionId: 'null', IsLatest: false }],
        IsTruncated: false,
      },
    ]);

    await invoke(newProvider());
    const responseKey = responseKeyOf();

    const purge = recorded.filter((c) => c.name === 'DeleteObjectsCommand');
    expect(purge).toHaveLength(1);
    expect(purge[0]!.objects).toEqual([{ Key: responseKey, VersionId: 'null' }]);
  });

  it('deletes nothing extra on an UNVERSIONED bucket', async () => {
    // S3 answers an unversioned bucket with the live object carrying
    // `VersionId: 'null'` and `IsLatest: true`. Nothing there is noncurrent, so
    // no DeleteObjects call may be made at all.
    stubS3((key) => [
      {
        Versions: [{ Key: key, VersionId: 'null', IsLatest: true }],
        IsTruncated: false,
      },
    ]);

    await invoke(newProvider());

    expect(recorded.filter((c) => c.name === 'ListObjectVersionsCommand')).toHaveLength(1);
    expect(recorded.filter((c) => c.name === 'DeleteObjectsCommand')).toHaveLength(0);
  });

  it('follows the version-listing pagination markers', async () => {
    stubS3((key) => [
      {
        Versions: [{ Key: key, VersionId: 'v-page1', IsLatest: false }],
        IsTruncated: true,
        NextKeyMarker: key,
        NextVersionIdMarker: 'v-page1',
      },
      {
        Versions: [{ Key: key, VersionId: 'v-page2', IsLatest: false }],
        IsTruncated: false,
      },
    ]);

    await invoke(newProvider());
    const responseKey = responseKeyOf();

    const lists = recorded.filter((c) => c.name === 'ListObjectVersionsCommand');
    expect(lists).toHaveLength(2);
    expect(lists[0]!.keyMarker).toBeUndefined();
    expect(lists[1]!.keyMarker).toBe(responseKey);

    const purge = recorded.filter((c) => c.name === 'DeleteObjectsCommand');
    expect(purge.map((c) => c.objects)).toEqual([
      [{ Key: responseKey, VersionId: 'v-page1' }],
      [{ Key: responseKey, VersionId: 'v-page2' }],
    ]);
  });

  it('warns and does not abort its caller when the purge fails', async () => {
    // Cleanup runs from `finally` arms, so it must never throw. But a swallowed
    // failure here leaves the handler's response body readable, so it must not
    // be silent either.
    stubS3(
      () => [],
      () => {
        throw new Error('AccessDenied: s3:ListBucketVersions');
      }
    );

    await invoke(newProvider());
    const responseKey = responseKeyOf();

    expect(childWarnSpy).toHaveBeenCalledTimes(1);
    const message = String(childWarnSpy.mock.calls[0]![0]);
    expect(message).toContain(responseKey);
    expect(message).toContain('noncurrent');
    expect(message).toContain('s3:DeleteObjectVersion');
    expect(message).toContain('AccessDenied: s3:ListBucketVersions');
  });
});
