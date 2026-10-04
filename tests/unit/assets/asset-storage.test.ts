import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ENUM_ABSENT_REGION } from '../_enum-absent-region.js';

const { mockS3Send, mockEcrSend, mockLoggerInfo, mockLoggerDebug, mockLoggerWarn } = vi.hoisted(
  () => ({
    mockS3Send: vi.fn(),
    mockEcrSend: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockLoggerDebug: vi.fn(),
    mockLoggerWarn: vi.fn(),
  })
);

// Mock @aws-sdk/client-s3 — verifyAssetStorageExists constructs its own
// region-scoped client, so the module constructor must return the shared
// mock `send`.
vi.mock('@aws-sdk/client-s3', () => ({
  // `config.region()` reports whatever region the client was constructed with
  // (the SDK's own behavior). The asset-bucket policy's partition is derived
  // from it rather than from the `region` OPTION, because `cdkd bootstrap`
  // passes a shared client whose region can differ from that option — see the
  // comment at the `PutBucketPolicyCommand` call site (issue #1794 review).
  S3Client: vi.fn().mockImplementation((cfg?: { region?: string }) => ({
    send: mockS3Send,
    destroy: vi.fn(),
    config: { region: async () => cfg?.region ?? 'us-east-1' },
  })),
  HeadBucketCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'HeadBucket' })),
  CreateBucketCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'CreateBucket' })),
  GetBucketLocationCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'GetBucketLocation' })),
  PutBucketEncryptionCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'PutBucketEncryption' })),
  PutPublicAccessBlockCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'PutPublicAccessBlock' })),
  PutBucketPolicyCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'PutBucketPolicy' })),
}));

vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi.fn().mockImplementation(() => ({ send: mockEcrSend, destroy: vi.fn() })),
  DescribeRepositoriesCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'DescribeRepositories' })),
  CreateRepositoryCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'CreateRepository' })),
  PutImageTagMutabilityCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'PutImageTagMutability' })),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: mockLoggerDebug,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: vi.fn(),
    child: () => ({
      debug: mockLoggerDebug,
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: vi.fn(),
    }),
  }),
}));

import { S3Client } from '@aws-sdk/client-s3';
import { ECRClient } from '@aws-sdk/client-ecr';
import {
  ASSET_SUPPORT_VERSION,
  BOOTSTRAP_MARKER_PREFIX,
  getCdkdAssetBucketName,
  getCdkdContainerRepoName,
  getBootstrapMarkerKey,
  parseBootstrapMarker,
  verifyAssetStorageExists,
  ensureAssetStorage,
  validateAssetBucketName,
  validateContainerRepoName,
  readBootstrapMarkerBody,
  AssetModeResolver,
  assertAssetBucketRegion,
  type BootstrapMarker,
} from '../../../src/assets/asset-storage.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { displayIdent, STACK_REF_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';
import {
  CLAUSE_BREAK_PAYLOAD,
  PASTE_PAYLOADS,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

/** Every family, the opt-in clause break included (go-to-k/cdkd#3950). */
const PAYLOADS = [...PASTE_PAYLOADS, CLAUSE_BREAK_PAYLOAD];

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

function validMarker(region = REGION): BootstrapMarker {
  return {
    assetBucket: getCdkdAssetBucketName(ACCOUNT, region),
    containerRepo: getCdkdContainerRepoName(ACCOUNT, region),
    assetSupportVersion: ASSET_SUPPORT_VERSION,
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function awsError(name: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(name), {
    name,
    ...(httpStatusCode && { $metadata: { httpStatusCode } }),
  });
}

/**
 * An AWS error carrying the `x-amz-bucket-region` response header, which real
 * S3 sets on BOTH cross-region shapes this module meets (issue #2240): the
 * `301` from `HeadBucket` and the `409 BucketAlreadyOwnedByYou` from
 * `CreateBucket`. Measured against real S3 on 2026-08-26.
 */
function awsErrorInRegion(
  name: string,
  httpStatusCode: number,
  bucketRegion: string,
  /** Spell the header canonically, to make the reader's `toLowerCase()` load-bearing. */
  canonicalCase = false
): Error {
  // A REALISTIC bag, in the order real S3 sends it (measured 2026-08-26:
  // x-amz-bucket-region, x-amz-request-id, x-amz-id-2, content-type,
  // transfer-encoding, date, server). The region header is deliberately NOT
  // first and NOT alone -- a single-entry object lets a reader that ignores the
  // KEY entirely ("return the first truthy value") pass, and in production that
  // returns a date string as the bucket's region.
  const headers: Record<string, string> = {
    'x-amz-request-id': 'ZZZ0000000000001',
    'x-amz-id-2': 'abcdefghijklmnopqrstuvwxyz0123456789',
    'content-type': 'application/xml',
    date: 'Wed, 26 Aug 2026 06:00:00 GMT',
    server: 'AmazonS3',
  };
  headers[canonicalCase ? 'X-Amz-Bucket-Region' : 'x-amz-bucket-region'] = bucketRegion;
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode },
    $response: { headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockS3Send.mockResolvedValue({});
  mockEcrSend.mockResolvedValue({});
});

describe('naming helpers', () => {
  it('builds the per-region asset bucket / container repo names and marker key', () => {
    expect(getCdkdAssetBucketName(ACCOUNT, 'ap-northeast-1')).toBe(
      'cdkd-assets-123456789012-ap-northeast-1'
    );
    expect(getCdkdContainerRepoName(ACCOUNT, 'ap-northeast-1')).toBe(
      'cdkd-container-assets-123456789012-ap-northeast-1'
    );
    expect(getBootstrapMarkerKey('ap-northeast-1')).toBe('cdkd-bootstrap/ap-northeast-1.json');
    expect(getBootstrapMarkerKey(REGION).startsWith(BOOTSTRAP_MARKER_PREFIX)).toBe(true);
  });
});

describe('parseBootstrapMarker', () => {
  it('parses a valid marker', () => {
    const marker = parseBootstrapMarker(JSON.stringify(validMarker()), 'cdkd-bootstrap/x.json');
    expect(marker.assetBucket).toBe('cdkd-assets-123456789012-us-east-1');
    expect(marker.containerRepo).toBe('cdkd-container-assets-123456789012-us-east-1');
    expect(marker.assetSupportVersion).toBe(1);
    expect(marker.createdAt).toBe('2026-07-15T00:00:00.000Z');
  });

  it('tolerates a missing createdAt (degrades to empty string)', () => {
    const { createdAt: _omitted, ...rest } = validMarker();
    const marker = parseBootstrapMarker(JSON.stringify(rest), 'k');
    expect(marker.createdAt).toBe('');
  });

  it('throws INVALID_BOOTSTRAP_MARKER on non-JSON', () => {
    expect(() => parseBootstrapMarker('not json{', 'cdkd-bootstrap/x.json')).toThrowError(
      /not valid JSON/
    );
  });

  it.each(['assetBucket', 'containerRepo', 'assetSupportVersion'] as const)(
    'throws INVALID_BOOTSTRAP_MARKER when %s is missing',
    (field) => {
      const body = { ...validMarker() } as Record<string, unknown>;
      delete body[field];
      expect(() => parseBootstrapMarker(JSON.stringify(body), 'k')).toThrowError(/malformed/);
    }
  );

  it('rejects a marker written by a newer cdkd (assetSupportVersion above ours)', () => {
    const body = { ...validMarker(), assetSupportVersion: ASSET_SUPPORT_VERSION + 1 };
    expect(() => parseBootstrapMarker(JSON.stringify(body), 'k')).toThrowError(/Upgrade cdkd/);
  });

  it('classifies a newer-version marker MISSING the v1 fields as UNSUPPORTED, not malformed', () => {
    // A future marker version may rename / remove the v1 required fields.
    // If that classified as "malformed", ensureAssetStorage's corrupt-marker
    // rewrite path would clobber it with v1 semantics — the version check
    // must win over field validation.
    const body = { assetSupportVersion: ASSET_SUPPORT_VERSION + 1, storage: { v2: 'shape' } };
    expect(() => parseBootstrapMarker(JSON.stringify(body), 'k')).toThrowError(/Upgrade cdkd/);
  });
});

describe('verifyAssetStorageExists', () => {
  it('resolves when both bucket and repo exist', async () => {
    await expect(verifyAssetStorageExists(validMarker(), ACCOUNT, REGION)).resolves.toBeUndefined();
    const headCall = mockS3Send.mock.calls[0]![0];
    expect(headCall._type).toBe('HeadBucket');
    expect(headCall.ExpectedBucketOwner).toBe(ACCOUNT);
    expect(mockEcrSend.mock.calls[0]![0]._type).toBe('DescribeRepositories');
  });

  it('hard-errors when the asset bucket is missing', async () => {
    mockS3Send.mockRejectedValueOnce(awsError('NotFound', 404));
    await expect(verifyAssetStorageExists(validMarker(), ACCOUNT, REGION)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_MISSING',
      message: expect.stringContaining('cdkd-assets-123456789012-us-east-1'),
    });
  });

  it('hard-errors on a foreign-owned bucket (403)', async () => {
    mockS3Send.mockRejectedValueOnce(awsError('Forbidden', 403));
    await expect(verifyAssetStorageExists(validMarker(), ACCOUNT, REGION)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_BUCKET',
    });
  });

  it('hard-errors when the container repo is missing', async () => {
    mockEcrSend.mockRejectedValueOnce(awsError('RepositoryNotFoundException'));
    await expect(verifyAssetStorageExists(validMarker(), ACCOUNT, REGION)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_MISSING',
      message: expect.stringContaining('cdkd-container-assets-123456789012-us-east-1'),
    });
  });

  it('threads --profile into the verification clients', async () => {
    await verifyAssetStorageExists(validMarker(), ACCOUNT, REGION, { profile: 'dev' });
    expect(vi.mocked(S3Client)).toHaveBeenCalledWith({ region: REGION, profile: 'dev' });
    expect(vi.mocked(ECRClient)).toHaveBeenCalledWith({ region: REGION, profile: 'dev' });
  });
});

describe('AssetModeResolver', () => {
  function makeBackend(getRawObject: ReturnType<typeof vi.fn>): S3StateBackend {
    return { getRawObject } as unknown as S3StateBackend;
  }

  it('resolves legacy mode when no marker exists, with ONE region-naming info line PER legacy region', async () => {
    const getRawObject = vi.fn().mockResolvedValue(null);
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    expect(await resolver.resolve('us-east-1')).toEqual({ mode: 'legacy' });
    expect(await resolver.resolve('ap-northeast-1')).toEqual({ mode: 'legacy' });

    expect(getRawObject).toHaveBeenCalledWith('cdkd-bootstrap/us-east-1.json');
    expect(getRawObject).toHaveBeenCalledWith('cdkd-bootstrap/ap-northeast-1.json');
    // One notice per legacy region, each naming the exact opt-in command for
    // ITS region — a region-less notice reads as a false negative to a user
    // who just bootstrapped a different region (their CLI default) while the
    // stack's env.region stayed legacy.
    const gcNotices = mockLoggerInfo.mock.calls.filter((c) => String(c[0]).includes('cdk gc'));
    expect(gcNotices).toHaveLength(2);
    // The command is pinned as the whole trailing line AND as the END of the
    // message (go-to-k/cdkd#3436): `toContain` accepts it back inside a prose
    // sentence, and a line anchor alone accepts it ABOVE the explanation, where
    // a copy through the line end takes the next sentence with it.
    expect(String(gcNotices[0]![0])).toMatch(
      /\nBootstrap with: cdkd bootstrap --region us-east-1$/
    );
    expect(String(gcNotices[1]![0])).toMatch(
      /\nBootstrap with: cdkd bootstrap --region ap-northeast-1$/
    );
  });

  it('shows the legacy notice only once per region across repeated resolves', async () => {
    const getRawObject = vi.fn().mockResolvedValue(null);
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    await resolver.resolve('us-east-1');
    await resolver.resolve('us-east-1');

    const gcNotices = mockLoggerInfo.mock.calls.filter((c) => String(c[0]).includes('cdk gc'));
    expect(gcNotices).toHaveLength(1);
  });

  it('refuses a marker naming an invalid bucket before any AWS call (go-to-k/cdkd#4114)', async () => {
    const getRawObject = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ ...validMarker(), assetBucket: 'Some Other Bucket' }));
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);
    mockS3Send.mockClear();
    mockEcrSend.mockClear();

    await expect(resolver.resolve(REGION)).rejects.toMatchObject({ code: 'INVALID_BOOTSTRAP_MARKER' });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockEcrSend).not.toHaveBeenCalled();
  });

  it('resolves cdkd-assets mode when the marker exists and resources verify', async () => {
    const getRawObject = vi.fn().mockResolvedValue(JSON.stringify(validMarker()));
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    const mode = await resolver.resolve(REGION);
    expect(mode.mode).toBe('cdkd-assets');
    if (mode.mode === 'cdkd-assets') {
      expect(mode.marker.assetBucket).toBe('cdkd-assets-123456789012-us-east-1');
    }
    // Verification ran.
    expect(mockS3Send).toHaveBeenCalled();
    expect(mockEcrSend).toHaveBeenCalled();
    // No legacy info line.
    const gcNotices = mockLoggerInfo.mock.calls.filter((c) => String(c[0]).includes('cdk gc'));
    expect(gcNotices).toHaveLength(0);
  });

  it('propagates a hard error when the marker names deleted resources', async () => {
    const getRawObject = vi.fn().mockResolvedValue(JSON.stringify(validMarker()));
    mockS3Send.mockRejectedValue(awsError('NotFound', 404));
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);
    await expect(resolver.resolve(REGION)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_MISSING',
    });
  });

  it('caches per region (one marker read for repeated resolves)', async () => {
    const getRawObject = vi.fn().mockResolvedValue(null);
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);
    await resolver.resolve(REGION);
    await resolver.resolve(REGION);
    expect(getRawObject).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures (transient marker-read error retries)', async () => {
    const getRawObject = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(null);
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);
    await expect(resolver.resolve(REGION)).rejects.toThrow('transient');
    expect(await resolver.resolve(REGION)).toEqual({ mode: 'legacy' });
    expect(getRawObject).toHaveBeenCalledTimes(2);
  });

  it('useCdkBootstrapAssets pins legacy mode: no marker read, no gc notice, even with a marker present', async () => {
    const getRawObject = vi.fn().mockResolvedValue(JSON.stringify(validMarker()));
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT, {
      useCdkBootstrapAssets: true,
    });
    expect(await resolver.resolve(REGION)).toEqual({ mode: 'legacy' });
    expect(getRawObject).not.toHaveBeenCalled();
    const gcNotices = mockLoggerInfo.mock.calls.filter((c) => String(c[0]).includes('cdk gc'));
    expect(gcNotices).toHaveLength(0);
  });

  it('suppressLegacyNotice skips the gc info line in legacy mode', async () => {
    const getRawObject = vi.fn().mockResolvedValue(null);
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT, {
      suppressLegacyNotice: true,
    });
    expect(await resolver.resolve(REGION)).toEqual({ mode: 'legacy' });
    expect(getRawObject).toHaveBeenCalledTimes(1);
    const gcNotices = mockLoggerInfo.mock.calls.filter((c) => String(c[0]).includes('cdk gc'));
    expect(gcNotices).toHaveLength(0);
  });
});

describe('ensureAssetStorage', () => {
  function makeOptions(
    overrides: {
      region?: string;
      force?: boolean;
      /** Pre-existing marker body returned by the getRawObject read (default: none). */
      existingMarkerBody?: string;
      assetBucketName?: string;
      containerRepoName?: string;
      /**
       * Region of the CLIENT, when it must differ from the `region` OPTION.
       * `cdkd bootstrap` really can pass a client whose region the SDK chain
       * resolved from the profile while its `region` option fell back to a
       * hardcoded `us-east-1` (issue #1820) — and the bucket policy's partition
       * is derived from the CLIENT. Defaults to `region`, matching the
       * auto-create path, which builds its own client for it.
       */
      clientRegion?: string;
    } = {}
  ) {
    const putRawObject = vi.fn().mockResolvedValue(undefined);
    const getRawObject = vi.fn().mockResolvedValue(overrides.existingMarkerBody ?? null);
    const region = overrides.region ?? REGION;
    return {
      putRawObject,
      getRawObject,
      options: {
        s3Client: new S3Client({ region: overrides.clientRegion ?? region }) as S3Client,
        ecrClient: new ECRClient({}) as ECRClient,
        stateBackend: { putRawObject, getRawObject } as unknown as S3StateBackend,
        accountId: ACCOUNT,
        region,
        force: overrides.force ?? false,
        ...(overrides.assetBucketName && { assetBucketName: overrides.assetBucketName }),
        ...(overrides.containerRepoName && { containerRepoName: overrides.containerRepoName }),
      },
    };
  }

  function s3CallTypes(): string[] {
    return mockS3Send.mock.calls.map((c) => c[0]._type as string);
  }
  function ecrCallTypes(): string[] {
    return mockEcrSend.mock.calls.map((c) => c[0]._type as string);
  }

  it('creates bucket + repo + marker on a fresh region (us-east-1: no LocationConstraint)', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    const { putRawObject, options } = makeOptions();

    const result = await ensureAssetStorage(options);

    expect(result).toEqual({
      assetBucket: 'cdkd-assets-123456789012-us-east-1',
      containerRepo: 'cdkd-container-assets-123456789012-us-east-1',
    });
    expect(s3CallTypes()).toEqual([
      'HeadBucket',
      'CreateBucket',
      'PutBucketEncryption',
      'PutPublicAccessBlock',
      'PutBucketPolicy',
    ]);
    const createCall = mockS3Send.mock.calls[1]![0];
    expect(createCall.CreateBucketConfiguration).toBeUndefined();
    expect(ecrCallTypes()).toEqual(['DescribeRepositories', 'CreateRepository']);
    expect(mockEcrSend.mock.calls[1]![0].imageTagMutability).toBe('IMMUTABLE');

    // Marker written LAST, after both resources, with a parseable body.
    expect(putRawObject).toHaveBeenCalledTimes(1);
    const [key, body] = putRawObject.mock.calls[0]! as [string, string];
    expect(key).toBe('cdkd-bootstrap/us-east-1.json');
    const marker = parseBootstrapMarker(body, key);
    expect(marker.assetBucket).toBe('cdkd-assets-123456789012-us-east-1');
    expect(marker.assetSupportVersion).toBe(ASSET_SUPPORT_VERSION);
    const lastS3Order = Math.max(...mockS3Send.mock.invocationCallOrder);
    const lastEcrOrder = Math.max(...mockEcrSend.mock.invocationCallOrder);
    expect(putRawObject.mock.invocationCallOrder[0]!).toBeGreaterThan(lastS3Order);
    expect(putRawObject.mock.invocationCallOrder[0]!).toBeGreaterThan(lastEcrOrder);
  });

  // Issue #1794: the asset-bucket policy hardcoded `arn:aws:s3:::`, so in
  // `aws-cn` the Deny statement named a resource that does not exist there and
  // protected nothing — while `PutBucketPolicy` succeeded and the command
  // reported the bucket configured.
  it.each([
    ['us-east-1', 'aws'],
    ['cn-north-1', 'aws-cn'],
    ['us-gov-west-1', 'aws-us-gov'],
  ])('derives the asset-bucket policy ARN partition from region %s', async (region, partition) => {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    const { options } = makeOptions({ region });

    await ensureAssetStorage(options);

    const policyCall = mockS3Send.mock.calls.find((c) => c[0]._type === 'PutBucketPolicy')![0];
    const bucket = `cdkd-assets-${ACCOUNT}-${region}`;
    expect(JSON.parse(policyCall.Policy).Statement[0].Resource).toEqual([
      `arn:${partition}:s3:::${bucket}`,
      `arn:${partition}:s3:::${bucket}/*`,
    ]);
  });

  // The case the `it.each` above CANNOT catch: it builds the client from the
  // same `region` it passes as the option, so the two never diverge and the
  // rows stay green even with the partition derived from the option. That is
  // the vacuity the PR review flagged. `cdkd bootstrap` really does hand this
  // function a client whose region came from the SDK chain (the profile) while
  // its `region` option fell back to a hardcoded `us-east-1`, and the bucket
  // then physically lives in the CLIENT's partition.
  it('derives the partition from the client when it disagrees with the region option', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    const { options } = makeOptions({ region: 'us-east-1', clientRegion: 'us-gov-west-1' });

    await ensureAssetStorage(options);

    const policyCall = mockS3Send.mock.calls.find((c) => c[0]._type === 'PutBucketPolicy')![0];
    // The bucket is NAMED after the option (`…-us-east-1`) — that mis-naming is
    // issue #1820 and is deliberately not fixed here — but its ARN must name
    // the partition it actually lives in.
    const bucket = `cdkd-assets-${ACCOUNT}-us-east-1`;
    expect(JSON.parse(policyCall.Policy).Statement[0].Resource).toEqual([
      `arn:aws-us-gov:s3:::${bucket}`,
      `arn:aws-us-gov:s3:::${bucket}/*`,
    ]);
  });

  it('passes LocationConstraint for non-us-east-1 regions', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    const { options } = makeOptions({ region: 'ap-northeast-1' });
    await ensureAssetStorage(options);
    const createCall = mockS3Send.mock.calls.find((c) => c[0]._type === 'CreateBucket')![0];
    expect(createCall.CreateBucketConfiguration).toEqual({
      LocationConstraint: 'ap-northeast-1',
    });
  });

  // Issue [#2322](https://github.com/go-to-k/cdkd/issues/2322).
  //
  // The row above pins `ap-northeast-1`, which IS a member of the SDK's
  // `BucketLocationConstraint` enum -- so it stays GREEN under the one
  // regression this cast invites, and the site LOOKS covered while being
  // inert. `src/assets/asset-storage.ts:778` casts with
  // `as BucketLocationConstraint` exactly as the S3 provider does; a future
  // "soundness fix" filtering the region to enum members would omit
  // `CreateBucketConfiguration` here, and on a REGIONAL endpoint an omitted
  // constraint answers `IllegalLocationConstraintException` -- the deploy
  // fails. (Not, as an earlier revision of the sibling suite claimed, a quiet
  // bucket in us-east-1: that default belongs to the GLOBAL endpoint, which
  // this path does not use.) The region must be one the enum OMITS, or this
  // row is no better than the `ap-northeast-1` one above. It is not spelled
  // here: this row pinned `ca-west-1` until the SDK enum grew and took it,
  // leaving the row silently inert (issue #2862). `ENUM_ABSENT_REGION` carries
  // the choice, and the guard that fails when it stops being absent lives in
  // `tests/unit/provisioning/`
  // `s3-bucket-provider-location-constraint-case.test.ts` -- it cannot live
  // here, because this file mocks `@aws-sdk/client-s3` with a factory that
  // carries no enum, so a guard written here would assert against the mock.
  it('passes LocationConstraint for a region ABSENT from the SDK enum (issue #2322)', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    const { options } = makeOptions({ region: ENUM_ABSENT_REGION });
    await ensureAssetStorage(options);
    const createCall = mockS3Send.mock.calls.find((c) => c[0]._type === 'CreateBucket')![0];
    expect(createCall.CreateBucketConfiguration).toEqual({
      LocationConstraint: ENUM_ABSENT_REGION,
    });
  });

  it('is idempotent: existing bucket + repo are left untouched (no --force), marker still written', async () => {
    // HeadBucket 200 + DescribeRepositories 200 (defaults).
    const { putRawObject, options } = makeOptions();
    await ensureAssetStorage(options);
    expect(s3CallTypes()).toEqual(['HeadBucket']);
    expect(ecrCallTypes()).toEqual(['DescribeRepositories']);
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });

  it('reconfigures existing resources under --force', async () => {
    const { options } = makeOptions({ force: true });
    await ensureAssetStorage(options);
    expect(s3CallTypes()).toEqual([
      'HeadBucket',
      'PutBucketEncryption',
      'PutPublicAccessBlock',
      'PutBucketPolicy',
    ]);
    expect(ecrCallTypes()).toEqual(['DescribeRepositories', 'PutImageTagMutability']);
    // Every configuration PUT is owner-pinned.
    for (const call of mockS3Send.mock.calls.slice(1)) {
      expect(call[0].ExpectedBucketOwner).toBe(ACCOUNT);
    }
  });

  it('refuses a foreign-owned bucket on the HeadBucket probe (403) and writes no marker', async () => {
    mockS3Send.mockRejectedValueOnce(awsError('Forbidden', 403));
    const { putRawObject, options } = makeOptions();
    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_BUCKET',
    });
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('refuses when CreateBucket loses the name to another account (BucketAlreadyExists)', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket') return Promise.reject(awsError('BucketAlreadyExists'));
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions();
    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_BUCKET',
    });
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('tolerates a same-account CreateBucket race (BucketAlreadyOwnedByYou)', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsError('BucketAlreadyOwnedByYou'));
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions();
    await ensureAssetStorage(options);
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });

  it('tolerates a concurrent CreateRepository race (RepositoryAlreadyExistsException)', async () => {
    mockEcrSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'DescribeRepositories')
        return Promise.reject(awsError('RepositoryNotFoundException'));
      if (cmd._type === 'CreateRepository')
        return Promise.reject(awsError('RepositoryAlreadyExistsException'));
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions();
    await ensureAssetStorage(options);
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });
});

describe('cross-region asset-bucket adoption (issue #2240)', () => {
  const FOREIGN = 'ap-northeast-1';

  function makeOptions(
    overrides: { region?: string; force?: boolean; assetBucketName?: string } = {}
  ) {
    const putRawObject = vi.fn().mockResolvedValue(undefined);
    const getRawObject = vi.fn().mockResolvedValue(null);
    const region = overrides.region ?? REGION;
    return {
      putRawObject,
      options: {
        s3Client: new S3Client({ region }) as S3Client,
        ecrClient: new ECRClient({}) as ECRClient,
        stateBackend: { putRawObject, getRawObject } as unknown as S3StateBackend,
        accountId: ACCOUNT,
        region,
        force: overrides.force ?? false,
        // The region-FREE custom name is what makes this reachable at all: the
        // default `cdkd-assets-<acct>-<region>` embeds the region, which is why
        // this class first read as structurally unreachable.
        ...(overrides.assetBucketName !== undefined && {
          assetBucketName: overrides.assetBucketName,
        }),
      },
    };
  }

  function s3CallTypes(): string[] {
    return mockS3Send.mock.calls.map((c) => c[0]._type as string);
  }

  it('refuses on the HeadBucket 301 and applies NO configuration to the foreign-region bucket', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket'
        ? Promise.reject(awsErrorInRegion('Unknown', 301, FOREIGN))
        : Promise.resolve({})
    );
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });

    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    });
    await expect(ensureAssetStorage(options)).rejects.toThrowError(
      new RegExp(`resolves to a bucket in ${FOREIGN}.*targets ${REGION}`, 's')
    );
    // NOTE on what discriminates here. `putRawObject` not being called is a
    // CONFLUENCE point on this arm -- pre-fix the 301 threw too (through
    // `normalizeAwsError`, whose wording tells the user to file a bug), so no
    // PUT happened either way. The real discriminator is the `code` and the
    // `resolves to a bucket in ... targets ...` message asserted above. The call-type
    // assertion below IS the discriminator on the 409 arm, where the pre-fix
    // code swallowed and went on to PUT.
    expect(s3CallTypes()).toEqual(['HeadBucket', 'HeadBucket']);
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('--force does not license adopting a foreign-region bucket', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket'
        ? Promise.reject(awsErrorInRegion('Unknown', 301, FOREIGN))
        : Promise.resolve({})
    );
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets', force: true });

    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    });
    // `--force` means "re-apply configuration to the bucket you INTENDED", never
    // "write to a bucket in another region" — so the PUT gate stays shut.
    expect(s3CallTypes()).toEqual(['HeadBucket']);
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('refuses a CROSS-REGION BucketAlreadyOwnedByYou instead of configuring that bucket', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsErrorInRegion('BucketAlreadyOwnedByYou', 409, FOREIGN));
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });

    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    });
    expect(s3CallTypes()).toEqual(['HeadBucket', 'CreateBucket']);
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: a SAME-region BucketAlreadyOwnedByYou race is still tolerated', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsErrorInRegion('BucketAlreadyOwnedByYou', 409, REGION));
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });

    await ensureAssetStorage(options);

    // A guard that refuses everything would satisfy every positive assertion
    // above; this is the arm that says it does not.
    expect(s3CallTypes()).toEqual([
      'HeadBucket',
      'CreateBucket',
      'PutBucketEncryption',
      'PutPublicAccessBlock',
      'PutBucketPolicy',
    ]);
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });

  it('falls back to GetBucketLocation when the 409 carries no region header', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsError('BucketAlreadyOwnedByYou', 409));
      if (cmd._type === 'GetBucketLocation')
        return Promise.resolve({ LocationConstraint: FOREIGN });
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });

    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    });
    expect(s3CallTypes()).toEqual(['HeadBucket', 'CreateBucket', 'GetBucketLocation']);
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('folds the legacy EU LocationConstraint to eu-west-1 rather than refusing', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsError('BucketAlreadyOwnedByYou', 409));
      if (cmd._type === 'GetBucketLocation') return Promise.resolve({ LocationConstraint: 'EU' });
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({
      region: 'eu-west-1',
      assetBucketName: 'shared-assets',
    });

    await ensureAssetStorage(options);
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });

  it('folds an EMPTY LocationConstraint to us-east-1 rather than refusing', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsError('BucketAlreadyOwnedByYou', 409));
      if (cmd._type === 'GetBucketLocation') return Promise.resolve({});
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });

    await ensureAssetStorage(options);
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED when the region cannot be determined at all', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsError('BucketAlreadyOwnedByYou', 409));
      if (cmd._type === 'GetBucketLocation') return Promise.reject(awsError('AccessDenied', 403));
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });

    // `resolveBucketRegion` would have returned its fallbackRegion here and let
    // the adoption through — which is why this guard does not use it.
    await expect(ensureAssetStorage(options)).rejects.toThrowError(/could not.*determine/s);
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('reads the region header by KEY, not by position, and case-insensitively', async () => {
    // Pins `readBucketRegionHeader`'s key match AND its `toLowerCase()`: the
    // bag carries five decoy headers and spells the region one canonically.
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket'
        ? Promise.reject(awsErrorInRegion('Unknown', 301, FOREIGN, true))
        : Promise.resolve({})
    );
    const { options } = makeOptions({ assetBucketName: 'shared-assets' });
    await expect(ensureAssetStorage(options)).rejects.toThrow(
      new RegExp(`resolves to a bucket in ${FOREIGN}`)
    );
  });

  it('treats a 400 carrying the region header as a cross-region redirect', async () => {
    // The SDK's own `regionRedirectMiddleware` fires on 301 OR 400-with-header;
    // a status-301-only gate misses this spelling entirely.
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket'
        ? Promise.reject(awsErrorInRegion('AuthorizationHeaderMalformed', 400, FOREIGN))
        : Promise.resolve({})
    );
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });
    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    });
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('does NOT adopt on a redirect whose header names THIS region', async () => {
    // Without an arm here, replacing the post-guard `throw` with
    // `bucketExists = true` passes: the guard returns (regions match) and the
    // caller would sail on to the configuration PUTs.
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket'
        ? Promise.reject(awsErrorInRegion('Unknown', 301, REGION))
        : Promise.resolve({})
    );
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });
    await expect(ensureAssetStorage(options)).rejects.toThrow(/different region than the client/);
    expect(s3CallTypes()).toEqual(['HeadBucket']);
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('folds an EMPTY LocationConstraint to us-east-1 and REFUSES a non-us-east-1 target', async () => {
    // The tolerated EMPTY arm above targets us-east-1, so the fold's output
    // equals `want` there and it cannot separate "folds to us-east-1" from
    // "folds to whatever we wanted" -- i.e. it would pass a fail-OPEN
    // `?? want`. This arm targets ap-northeast-1, so only the real fold refuses.
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsError('BucketAlreadyOwnedByYou', 409));
      if (cmd._type === 'GetBucketLocation') return Promise.resolve({});
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({
      region: FOREIGN,
      assetBucketName: 'shared-assets',
    });
    await expect(ensureAssetStorage(options)).rejects.toThrow(
      new RegExp(`resolves to a bucket in us-east-1.*targets ${FOREIGN}`, 's')
    );
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('canonicalizes BOTH sides before comparing, so a raw --region spelling still matches', async () => {
    // `bootstrap.ts` passes the user's RAW `--region` spelling, so dropping the
    // canonicalization would refuse a bucket that is in the right region.
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsErrorInRegion('BucketAlreadyOwnedByYou', 409, 'US-EAST-1'));
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });
    await ensureAssetStorage(options);
    expect(putRawObject).toHaveBeenCalledTimes(1);
    // Fence the FALLBACK out. Without this the arm passes even when the header
    // is ignored entirely, because `GetBucketLocation` answers `{}` here and
    // that folds to `us-east-1`, which equals `want` -- so it could not tell
    // "header read and canonicalized" from "header not read at all".
    expect(s3CallTypes()).toEqual([
      'HeadBucket',
      'CreateBucket',
      'PutBucketEncryption',
      'PutPublicAccessBlock',
      'PutBucketPolicy',
    ]);
  });

  it('canonicalizes the TARGET region too, so a raw --region does not self-refuse', async () => {
    // `bootstrap.ts` passes `rawRegion ?? region` DELIBERATELY -- the raw
    // spelling is scoped to that one argument while every client is built from
    // the canonical one. So dropping `canonicalizeRegion` on the `want` side
    // turns the NORMAL same-region 409 race (see the provider comment: a 409 is
    // how it arrives in every region but us-east-1) into a hard refusal reading
    // "resolves to a bucket in us-east-1, while this operation targets
    // US-EAST-1". The sibling arm above only feeds the raw spelling on the
    // header (`actual`) side, so it cannot catch this.
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsErrorInRegion('BucketAlreadyOwnedByYou', 409, 'us-east-1'));
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({
      region: 'US-EAST-1',
      assetBucketName: 'shared-assets',
    });
    await ensureAssetStorage(options);
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });

  it('does NOT treat an arbitrary status carrying the header as a redirect', async () => {
    // Negative arm for the 301-or-400 gate: widening it to `status !== undefined`
    // must not pass. A 500 with a stray region header is a server error, not a
    // cross-region answer, and must keep its own handling.
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket'
        ? Promise.reject(awsErrorInRegion('InternalError', 500, FOREIGN))
        : Promise.resolve({})
    );
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });
    await expect(ensureAssetStorage(options)).rejects.not.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    });
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('a HEADER-LESS 301 still reaches the guard via the GetBucketLocation fallback', async () => {
    // Requiring the header on the 301 arm regressed this case: it stopped
    // reaching the guard and fell back to the "please report it" wording.
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('Unknown', 301));
      if (cmd._type === 'GetBucketLocation')
        return Promise.resolve({ LocationConstraint: FOREIGN });
      return Promise.resolve({});
    });
    const { putRawObject, options } = makeOptions({ assetBucketName: 'shared-assets' });
    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    });
    expect(s3CallTypes()).toEqual(['HeadBucket', 'GetBucketLocation']);
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('owner-pins the GetBucketLocation fallback probe', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsError('BucketAlreadyOwnedByYou', 409));
      if (cmd._type === 'GetBucketLocation')
        return Promise.resolve({ LocationConstraint: FOREIGN });
      return Promise.resolve({});
    });
    const { options } = makeOptions({ assetBucketName: 'shared-assets' });
    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    });
    const probe = mockS3Send.mock.calls.map((c) => c[0]).find((c) => c._type === 'GetBucketLocation');
    expect(probe.ExpectedBucketOwner).toBe(ACCOUNT);
  });

  it('recovers the region when the GetBucketLocation FALLBACK itself redirects', async () => {
    // The probe runs on a deploy-region client, so for this very bucket it can
    // answer a redirect of its own -- which carries the region we wanted.
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket')
        return Promise.reject(awsError('BucketAlreadyOwnedByYou', 409));
      if (cmd._type === 'GetBucketLocation')
        return Promise.reject(awsErrorInRegion('PermanentRedirect', 301, FOREIGN));
      return Promise.resolve({});
    });
    const { options } = makeOptions({ assetBucketName: 'shared-assets' });
    await expect(ensureAssetStorage(options)).rejects.toThrow(
      new RegExp(`resolves to a bucket in ${FOREIGN}`)
    );
  });

  it('verifyAssetStorageExists still THROWS on a redirect naming THIS region', async () => {
    // The guard returns without throwing when the regions match, so the code
    // AFTER it is what stops a redirect being read as "verification passed".
    // Without this arm, replacing that `throw` with a bare `return` lets a
    // deploy proceed against a bucket the client cannot even reach.
    mockS3Send.mockImplementation(() =>
      Promise.reject(awsErrorInRegion('Unknown', 301, REGION))
    );
    await expect(verifyAssetStorageExists(validMarker(), ACCOUNT, REGION)).rejects.toThrow(
      /different region than the client/
    );
  });

  it('verifyAssetStorageExists refuses a marker bucket that now lives elsewhere', async () => {
    // `mockImplementation`, not `mockRejectedValueOnce`: the arm asserts twice
    // and a `*Once` primer would be drained by the first call, leaving the
    // second to resolve.
    mockS3Send.mockImplementation(() => Promise.reject(awsErrorInRegion('Unknown', 301, FOREIGN)));
    // Pre-fix this path did not even reach `normalizeAwsError` — it rethrew the
    // SDK's bare synthetic `UnknownError` with no context at all.
    await expect(verifyAssetStorageExists(validMarker(), ACCOUNT, REGION)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    });
    // Name the BUCKET and both regions, not just the code: asserting the code
    // alone lets the fallback probe read `marker.containerRepo` instead of
    // `marker.assetBucket` and still pass.
    await expect(
      verifyAssetStorageExists(validMarker(), ACCOUNT, REGION)
    ).rejects.toThrow(
      new RegExp(`'${validMarker().assetBucket}'.*resolves to a bucket in ${FOREIGN}.*targets ${REGION}`, 's')
    );
    expect(mockEcrSend).not.toHaveBeenCalled();
  });
});

describe('ensureAssetStorage — custom names (issue #1011)', () => {
  const CUSTOM_BUCKET = 'my-org-cdkd-assets';
  const CUSTOM_REPO = 'my-org/cdkd-assets';

  function makeOptions(
    overrides: {
      existingMarkerBody?: string;
      assetBucketName?: string;
      containerRepoName?: string;
    } = {}
  ) {
    const putRawObject = vi.fn().mockResolvedValue(undefined);
    const getRawObject = vi.fn().mockResolvedValue(overrides.existingMarkerBody ?? null);
    return {
      putRawObject,
      getRawObject,
      options: {
        s3Client: new S3Client({ region: REGION }) as S3Client,
        ecrClient: new ECRClient({}) as ECRClient,
        stateBackend: { putRawObject, getRawObject } as unknown as S3StateBackend,
        accountId: ACCOUNT,
        region: REGION,
        force: false,
        ...(overrides.assetBucketName && { assetBucketName: overrides.assetBucketName }),
        ...(overrides.containerRepoName && { containerRepoName: overrides.containerRepoName }),
      },
    };
  }

  /** Script S3/ECR for a fresh region: nothing exists, every create succeeds. */
  function scriptFreshRegion(): void {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
  }

  it('threads custom names into the probe, the create calls, and the marker body', async () => {
    scriptFreshRegion();
    const { putRawObject, options } = makeOptions({
      assetBucketName: CUSTOM_BUCKET,
      containerRepoName: CUSTOM_REPO,
    });

    const result = await ensureAssetStorage(options);

    expect(result).toEqual({ assetBucket: CUSTOM_BUCKET, containerRepo: CUSTOM_REPO });
    // Probe + create + every configuration PUT target the custom bucket.
    for (const call of mockS3Send.mock.calls) {
      expect(call[0].Bucket).toBe(CUSTOM_BUCKET);
    }
    const policyCall = mockS3Send.mock.calls.find((c) => c[0]._type === 'PutBucketPolicy')![0];
    expect(policyCall.Policy).toContain(`arn:aws:s3:::${CUSTOM_BUCKET}`);
    // ECR probe + create target the custom repo.
    expect(mockEcrSend.mock.calls[0]![0].repositoryNames).toEqual([CUSTOM_REPO]);
    expect(mockEcrSend.mock.calls[1]![0].repositoryName).toBe(CUSTOM_REPO);
    // The marker carries the custom names — the single source of truth for
    // deploy redirect, publish, verification, state info, and teardown.
    const [key, body] = putRawObject.mock.calls[0]! as [string, string];
    const marker = parseBootstrapMarker(body, key);
    expect(marker.assetBucket).toBe(CUSTOM_BUCKET);
    expect(marker.containerRepo).toBe(CUSTOM_REPO);
  });

  it('keeps conventional defaults when no custom names are passed (no marker)', async () => {
    scriptFreshRegion();
    const { putRawObject, options } = makeOptions();
    const result = await ensureAssetStorage(options);
    expect(result).toEqual({
      assetBucket: `cdkd-assets-${ACCOUNT}-${REGION}`,
      containerRepo: `cdkd-container-assets-${ACCOUNT}-${REGION}`,
    });
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });

  it('resolves per field: only --asset-bucket set, no marker → repo stays conventional', async () => {
    scriptFreshRegion();
    const { putRawObject, options } = makeOptions({ assetBucketName: CUSTOM_BUCKET });

    const result = await ensureAssetStorage(options);

    expect(result).toEqual({
      assetBucket: CUSTOM_BUCKET,
      containerRepo: `cdkd-container-assets-${ACCOUNT}-${REGION}`,
    });
    const [key, body] = putRawObject.mock.calls[0]! as [string, string];
    const marker = parseBootstrapMarker(body, key);
    expect(marker.assetBucket).toBe(CUSTOM_BUCKET);
    expect(marker.containerRepo).toBe(`cdkd-container-assets-${ACCOUNT}-${REGION}`);
  });

  it('resolves per field: marker custom names + only a MATCHING --asset-bucket → repo from the marker', async () => {
    scriptFreshRegion();
    const existing = JSON.stringify({
      assetBucket: CUSTOM_BUCKET,
      containerRepo: CUSTOM_REPO,
      assetSupportVersion: 1,
      createdAt: '2026-07-15T00:00:00.000Z',
    });
    const { options } = makeOptions({
      existingMarkerBody: existing,
      assetBucketName: CUSTOM_BUCKET,
    });

    const result = await ensureAssetStorage(options);

    // No conflict (names match), and the unspecified repo resolves from the
    // marker — never falls through to the conventional default.
    expect(result).toEqual({ assetBucket: CUSTOM_BUCKET, containerRepo: CUSTOM_REPO });
  });

  it('hard-errors (never rewrites) an existing newer-version marker even when its v1 fields are missing', async () => {
    scriptFreshRegion();
    const v2Marker = JSON.stringify({
      assetSupportVersion: 2,
      storage: { renamed: 'shape' },
    });
    const { putRawObject, options } = makeOptions({ existingMarkerBody: v2Marker });

    await expect(ensureAssetStorage(options)).rejects.toThrowError(/Upgrade cdkd/);
    expect(putRawObject).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockEcrSend).not.toHaveBeenCalled();
  });

  it('hard-errors when a custom name differs from an existing marker (points at --destroy)', async () => {
    const existing = { ...validMarker(), assetBucket: 'already-bootstrapped-bucket' };
    const { putRawObject, options } = makeOptions({
      existingMarkerBody: JSON.stringify(existing),
      assetBucketName: CUSTOM_BUCKET,
    });

    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_NAME_CONFLICT',
      message: expect.stringContaining(`cdkd bootstrap --destroy --region ${REGION}`),
    });
    // Refused before ANY AWS call and before any marker write.
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockEcrSend).not.toHaveBeenCalled();
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('same custom names as the marker stay the idempotent verify path', async () => {
    const existing = {
      ...validMarker(),
      assetBucket: CUSTOM_BUCKET,
      containerRepo: CUSTOM_REPO,
    };
    const { putRawObject, options } = makeOptions({
      existingMarkerBody: JSON.stringify(existing),
      assetBucketName: CUSTOM_BUCKET,
      containerRepoName: CUSTOM_REPO,
    });

    // HeadBucket 200 + DescribeRepositories 200 (defaults) — nothing created.
    const result = await ensureAssetStorage(options);
    expect(result).toEqual({ assetBucket: CUSTOM_BUCKET, containerRepo: CUSTOM_REPO });
    expect(mockS3Send.mock.calls.map((c) => c[0]._type)).toEqual(['HeadBucket']);
    expect(mockEcrSend.mock.calls.map((c) => c[0]._type)).toEqual(['DescribeRepositories']);
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });

  it('plain re-bootstrap of a custom-named region reuses the marker names (never creates a second, conventional set)', async () => {
    const existing = {
      ...validMarker(),
      assetBucket: CUSTOM_BUCKET,
      containerRepo: CUSTOM_REPO,
    };
    const { putRawObject, options } = makeOptions({
      existingMarkerBody: JSON.stringify(existing),
    });

    const result = await ensureAssetStorage(options);
    expect(result).toEqual({ assetBucket: CUSTOM_BUCKET, containerRepo: CUSTOM_REPO });
    expect(mockS3Send.mock.calls[0]![0].Bucket).toBe(CUSTOM_BUCKET);
    expect(mockEcrSend.mock.calls[0]![0].repositoryNames).toEqual([CUSTOM_REPO]);
    const [key, body] = putRawObject.mock.calls[0]! as [string, string];
    expect(parseBootstrapMarker(body, key).assetBucket).toBe(CUSTOM_BUCKET);
  });

  it('applies the squatting defense to a custom name (HeadBucket 403 → hard refusal, no marker)', async () => {
    mockS3Send.mockRejectedValueOnce(awsError('Forbidden', 403));
    const { putRawObject, options } = makeOptions({ assetBucketName: CUSTOM_BUCKET });

    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'ASSET_STORAGE_FOREIGN_BUCKET',
      message: expect.stringContaining(CUSTOM_BUCKET),
    });
    expect(putRawObject).not.toHaveBeenCalled();
  });

  it('rewrites a corrupt marker instead of failing (re-running bootstrap is the documented fix)', async () => {
    scriptFreshRegion();
    const { putRawObject, options } = makeOptions({
      existingMarkerBody: 'not json{',
      assetBucketName: CUSTOM_BUCKET,
    });

    const result = await ensureAssetStorage(options);
    expect(result.assetBucket).toBe(CUSTOM_BUCKET);
    expect(mockLoggerWarn.mock.calls.some((c) => String(c[0]).includes('malformed'))).toBe(true);
    expect(putRawObject).toHaveBeenCalledTimes(1);
  });

  it('refuses to clobber a marker written by a newer cdkd (assetSupportVersion above ours)', async () => {
    const newer = { ...validMarker(), assetSupportVersion: ASSET_SUPPORT_VERSION + 1 };
    const { putRawObject, options } = makeOptions({
      existingMarkerBody: JSON.stringify(newer),
    });

    await expect(ensureAssetStorage(options)).rejects.toMatchObject({
      code: 'UNSUPPORTED_BOOTSTRAP_MARKER_VERSION',
    });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(putRawObject).not.toHaveBeenCalled();
  });
});

describe('custom asset storage name validation (issue #1011)', () => {
  it.each(['my-org-assets', 'a1b', 'bucket.with.dots', 'a'.repeat(63)])(
    'accepts valid bucket name %s',
    (name) => {
      expect(() => validateAssetBucketName(name)).not.toThrow();
    }
  );

  it.each([
    'ab', // too short
    'a'.repeat(64), // too long
    'MyBucket', // uppercase
    '-leading-hyphen',
    'trailing-hyphen-',
    '.leading-dot',
    'trailing-dot.',
    'under_score',
  ])('rejects invalid bucket name %s', (name) => {
    expect(() => validateAssetBucketName(name)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ASSET_STORAGE_NAME' })
    );
  });

  it.each(['my-repo', 'my-org/cdkd-assets', 'a.b_c-d/e2', 'ab'])(
    'accepts valid repo name %s',
    (name) => {
      expect(() => validateContainerRepoName(name)).not.toThrow();
    }
  );

  it.each([
    'a', // too short
    'a'.repeat(257), // too long
    'MyRepo', // uppercase
    '/leading-slash',
    'trailing-slash/',
    'double//slash',
    'double--ok-but-doubled..dot', // doubled separators
  ])('rejects invalid repo name %s', (name) => {
    expect(() => validateContainerRepoName(name)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ASSET_STORAGE_NAME' })
    );
  });
});
describe('AssetModeResolver auto-create (issue #1007)', () => {
  /**
   * Backend double whose marker read reflects what ensureAssetStorage wrote:
   * read #1 (mode resolution) returns null, and after the auto-create path's
   * putRawObject lands, the re-read returns the stored marker body.
   */
  function makeAutoCreateBackend() {
    let stored: string | null = null;
    const putRawObject = vi.fn().mockImplementation(async (_key: string, body: string) => {
      stored = body;
    });
    const getRawObject = vi.fn().mockImplementation(async () => stored);
    return {
      backend: { getRawObject, putRawObject } as unknown as S3StateBackend,
      putRawObject,
      getRawObject,
    };
  }

  /** Script S3/ECR for a fresh region: nothing exists, every create succeeds. */
  function scriptFreshRegion(): void {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
  }

  function gcNotices(): unknown[] {
    return mockLoggerInfo.mock.calls.filter((c) => String(c[0]).includes('cdk gc'));
  }

  it('creates storage and returns cdkd-assets mode when confirm approves (no gc notice)', async () => {
    scriptFreshRegion();
    const { backend, putRawObject } = makeAutoCreateBackend();
    const confirm = vi.fn().mockResolvedValue(true);
    const resolver = new AssetModeResolver(backend, ACCOUNT, { autoCreate: { confirm } });

    const mode = await resolver.resolve(REGION);

    expect(confirm).toHaveBeenCalledWith(REGION);
    expect(mode.mode).toBe('cdkd-assets');
    if (mode.mode === 'cdkd-assets') {
      expect(mode.marker.assetBucket).toBe(`cdkd-assets-${ACCOUNT}-${REGION}`);
    }
    // The marker was written by the same ensureAssetStorage path bootstrap uses.
    expect(putRawObject).toHaveBeenCalledWith(
      `cdkd-bootstrap/${REGION}.json`,
      expect.stringContaining(`cdkd-assets-${ACCOUNT}-${REGION}`)
    );
    expect(gcNotices()).toHaveLength(0);
  });

  it('declined confirm stays legacy: no creation calls, gc notice shown', async () => {
    scriptFreshRegion();
    const { backend, putRawObject } = makeAutoCreateBackend();
    const confirm = vi.fn().mockResolvedValue(false);
    const resolver = new AssetModeResolver(backend, ACCOUNT, { autoCreate: { confirm } });

    expect(await resolver.resolve(REGION)).toEqual({ mode: 'legacy' });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockEcrSend).not.toHaveBeenCalled();
    expect(putRawObject).not.toHaveBeenCalled();
    expect(gcNotices()).toHaveLength(1);
  });

  it('creation failure falls back to legacy with an actionable warning + gc notice (never hard-fails the deploy)', async () => {
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
      if (cmd._type === 'CreateBucket') return Promise.reject(awsError('AccessDenied', 403));
      return Promise.resolve({});
    });
    const { backend } = makeAutoCreateBackend();
    const confirm = vi.fn().mockResolvedValue(true);
    const resolver = new AssetModeResolver(backend, ACCOUNT, { autoCreate: { confirm } });

    expect(await resolver.resolve(REGION)).toEqual({ mode: 'legacy' });
    const warns = mockLoggerWarn.mock.calls.filter((c) =>
      String(c[0]).includes('Failed to auto-create cdkd asset storage')
    );
    expect(warns).toHaveLength(1);
    expect(String(warns[0]![0])).toMatch(
      new RegExp(`\nBootstrap with: cdkd bootstrap --region ${REGION}$`)
    );
    expect(gcNotices()).toHaveLength(1);
  });

  it('a throwing confirm is treated as a decline (legacy, no throw)', async () => {
    scriptFreshRegion();
    const { backend } = makeAutoCreateBackend();
    const confirm = vi.fn().mockRejectedValue(new Error('stdin closed'));
    const resolver = new AssetModeResolver(backend, ACCOUNT, { autoCreate: { confirm } });

    expect(await resolver.resolve(REGION)).toEqual({ mode: 'legacy' });
    expect(gcNotices()).toHaveLength(1);
  });

  it('never fires when the marker already exists', async () => {
    const getRawObject = vi.fn().mockResolvedValue(JSON.stringify(validMarker()));
    const confirm = vi.fn();
    const resolver = new AssetModeResolver(
      { getRawObject } as unknown as S3StateBackend,
      ACCOUNT,
      { autoCreate: { confirm } }
    );

    const mode = await resolver.resolve(REGION);
    expect(mode.mode).toBe('cdkd-assets');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('never fires under the useCdkBootstrapAssets legacy pin (marker not even read)', async () => {
    const { backend, getRawObject } = makeAutoCreateBackend();
    const confirm = vi.fn();
    const resolver = new AssetModeResolver(backend, ACCOUNT, {
      useCdkBootstrapAssets: true,
      autoCreate: { confirm },
    });

    expect(await resolver.resolve(REGION)).toEqual({ mode: 'legacy' });
    expect(confirm).not.toHaveBeenCalled();
    expect(getRawObject).not.toHaveBeenCalled();
  });

  it('single-flights the confirm across concurrent same-region resolves', async () => {
    scriptFreshRegion();
    const { backend } = makeAutoCreateBackend();
    const confirm = vi.fn().mockResolvedValue(true);
    const resolver = new AssetModeResolver(backend, ACCOUNT, { autoCreate: { confirm } });

    const [a, b] = await Promise.all([resolver.resolve(REGION), resolver.resolve(REGION)]);
    expect(a.mode).toBe('cdkd-assets');
    expect(b.mode).toBe('cdkd-assets');
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

/**
 * Issue #2021 — the shared canonical-then-raw marker read.
 *
 * Three hand-written copies of this probe existed (`local-state-loader.ts`,
 * `gc.ts`, `bootstrap-destroy.ts`) before `AssetModeResolver` needed a fourth.
 * They already differed in ways that are easy to get wrong, so the RULE lives
 * here and each caller's POLICY on top of it stays fenced in that caller's own
 * suite.
 */
describe('readBootstrapMarkerBody (issue #2021)', () => {
  const CANONICAL_KEY = 'cdkd-bootstrap/us-east-1.json';
  const RAW_KEY = 'cdkd-bootstrap/US-EAST-1.json';

  function makeBackend(getRawObject: ReturnType<typeof vi.fn>) {
    return { getRawObject } as unknown as Parameters<typeof readBootstrapMarkerBody>[0];
  }

  it('costs exactly ONE probe when the region is already canonical', async () => {
    const getRawObject = vi.fn().mockResolvedValue(null);
    const read = await readBootstrapMarkerBody(makeBackend(getRawObject), 'us-east-1');

    expect(getRawObject.mock.calls.map((c) => c[0])).toEqual([CANONICAL_KEY]);
    expect(read).toEqual({ body: null, resolvedKey: CANONICAL_KEY });
  });

  it('probes the CANONICAL key FIRST for an upper-cased region, and stops on a hit', async () => {
    // The order is the discriminator: an implementation that probed the RAW
    // spelling first would still find this marker, but would resolve the raw
    // key for a marker that lives at the canonical one.
    const getRawObject = vi
      .fn()
      .mockImplementation(async (key: string) => (key === CANONICAL_KEY ? 'body' : null));

    const read = await readBootstrapMarkerBody(makeBackend(getRawObject), 'US-EAST-1');

    expect(getRawObject.mock.calls.map((c) => c[0])).toEqual([CANONICAL_KEY]);
    expect(read).toEqual({ body: 'body', resolvedKey: CANONICAL_KEY });
  });

  it('falls back to the RAW spelling and reports THAT key as the resolved one', async () => {
    // The pre-#1820 population: `AWS_REGION=US-EAST-1 cdkd bootstrap` really
    // wrote the un-folded key. `resolvedKey` is what every caller's message,
    // plan line and DELETE target follows, so it must name the file actually
    // read — not the canonical key that missed.
    const getRawObject = vi
      .fn()
      .mockImplementation(async (key: string) => (key === RAW_KEY ? 'raw-body' : null));

    const read = await readBootstrapMarkerBody(makeBackend(getRawObject), 'US-EAST-1');

    expect(getRawObject.mock.calls.map((c) => c[0])).toEqual([CANONICAL_KEY, RAW_KEY]);
    expect(read).toEqual({ body: 'raw-body', resolvedKey: RAW_KEY });
  });

  it('reports the CANONICAL key when neither spelling holds a marker', async () => {
    const getRawObject = vi.fn().mockResolvedValue(null);

    const read = await readBootstrapMarkerBody(makeBackend(getRawObject), 'US-EAST-1');

    expect(getRawObject.mock.calls.map((c) => c[0])).toEqual([CANONICAL_KEY, RAW_KEY]);
    expect(read).toEqual({ body: null, resolvedKey: CANONICAL_KEY });
  });

  it('announces a raw-key hit at debug, naming BOTH keys so the miss is diagnosable', async () => {
    // The raw-key arm is the whole reason probe 2 exists, and its ONLY runtime
    // trace is this line — without it a marker resolved from the un-folded key
    // looks identical to one resolved from the canonical key.
    const getRawObject = vi
      .fn()
      .mockImplementation(async (key: string) => (key === RAW_KEY ? 'raw-body' : null));

    await readBootstrapMarkerBody(makeBackend(getRawObject), 'US-EAST-1');

    const line = mockLoggerDebug.mock.calls.map((c) => String(c[0])).find((l) => l.includes(RAW_KEY));
    expect(line).toBeDefined();
    expect(line).toContain(CANONICAL_KEY);
    // No caller prefix supplied -> the standalone subject, capitalized.
    expect(line).toMatch(/^Bootstrap marker found at the un-folded key/);
  });

  it('prefixes that line with the caller log prefix when one is supplied', async () => {
    // `loadBootstrapContainerRepo` is best-effort and prefixes every line it
    // emits with `--from-state` (or the caller's override). Folding its probe
    // into the shared helper must not silently drop that prefix, or its debug
    // output stops being attributable to the flag that produced it.
    const getRawObject = vi
      .fn()
      .mockImplementation(async (key: string) => (key === RAW_KEY ? 'raw-body' : null));

    await readBootstrapMarkerBody(makeBackend(getRawObject), 'US-EAST-1', {
      logPrefix: '--from-state',
    });

    const line = mockLoggerDebug.mock.calls.map((c) => String(c[0])).find((l) => l.includes(RAW_KEY));
    expect(line).toMatch(/^--from-state: bootstrap marker found at the un-folded key/);
  });

  it('does NOT catch — every caller keeps its own error policy on top', async () => {
    // `gc` / `bootstrap --destroy` translate NoSuchBucket into their own
    // never-bootstrapped message and hard-error on anything else, while
    // `loadBootstrapContainerRepo` warns and falls back. Swallowing here would
    // silently collapse all three into "no marker".
    const getRawObject = vi.fn().mockRejectedValue(awsError('NoSuchBucket'));

    await expect(readBootstrapMarkerBody(makeBackend(getRawObject), 'US-EAST-1')).rejects.toThrow(
      'NoSuchBucket'
    );
  });
});

/**
 * Issue #2021 — the deploy-time asset-mode resolver folds region CASE.
 *
 * Both deploy-time callers hand this resolver an un-canonicalized region
 * (`options.region || AWS_REGION || 'us-east-1'`, then `stack.region ||
 * baseRegion`), so an env-agnostic stack — the CDK default — under
 * `--region US-EAST-1` reached the marker read with the upper-cased spelling.
 * The miss took the `body === null` arm and silently downgraded the region to
 * LEGACY asset mode, i.e. to the CDK bootstrap bucket/repo that `cdk gc` DOES
 * collect. Nothing failed at deploy time; the assets vanished later.
 */
describe('AssetModeResolver region-case fold (issue #2021)', () => {
  const REGION_UPPER = 'US-EAST-1';
  const CANONICAL_KEY = `cdkd-bootstrap/${REGION}.json`;
  const RAW_KEY = `cdkd-bootstrap/${REGION_UPPER}.json`;

  function makeBackend(getRawObject: ReturnType<typeof vi.fn>): S3StateBackend {
    return { getRawObject } as unknown as S3StateBackend;
  }

  function probedKeys(getRawObject: ReturnType<typeof vi.fn>): string[] {
    return getRawObject.mock.calls.map((c) => c[0] as string);
  }

  function gcNotices(): unknown[][] {
    return mockLoggerInfo.mock.calls.filter((c) => String(c[0]).includes('cdk gc'));
  }

  it('resolves cdkd-assets mode for an UPPER-cased region whose marker is canonical', async () => {
    // The headline defect. Pre-fix this probed `cdkd-bootstrap/US-EAST-1.json`,
    // missed, and returned `{ mode: 'legacy' }` — publishing the stack's assets
    // to cdk-gc-collectable storage while printing a reassuring notice.
    const getRawObject = vi
      .fn()
      .mockImplementation(async (key: string) =>
        key === CANONICAL_KEY ? JSON.stringify(validMarker()) : null
      );
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    const mode = await resolver.resolve(REGION_UPPER);

    // `mode.mode` is the discriminator: pre-fix this probed the RAW key, missed,
    // and returned `legacy`. Deliberately NOT asserting `marker.assetBucket` —
    // that only re-reads `validMarker()`'s own fixture back out and fences
    // nothing, since the marker is returned verbatim.
    expect(probedKeys(getRawObject)).toEqual([CANONICAL_KEY]);
    expect(mode.mode).toBe('cdkd-assets');
    expect(gcNotices()).toHaveLength(0);
  });

  it('builds the verification clients with the CANONICAL region', async () => {
    // SDK endpoint resolution is case-sensitive, and the region also names the
    // bucket / repo the marker points at.
    const getRawObject = vi.fn().mockResolvedValue(JSON.stringify(validMarker()));
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT, {
      profile: 'dev',
    });

    await resolver.resolve(REGION_UPPER);

    expect(vi.mocked(S3Client)).toHaveBeenCalledWith({ region: REGION, profile: 'dev' });
    expect(vi.mocked(ECRClient)).toHaveBeenCalledWith({ region: REGION, profile: 'dev' });
  });

  it('shares ONE cache slot between US-EAST-1 and us-east-1 (probe count, not just the mode)', async () => {
    // The quieter half of the same defect: the cache is keyed by region, so the
    // two spellings occupied two slots and each re-probed S3. A returned-mode
    // assertion alone passes with that bug fully intact — both spellings answer
    // `cdkd-assets` once the read is folded — so the fence has to be the CALL
    // COUNT.
    const getRawObject = vi.fn().mockResolvedValue(JSON.stringify(validMarker()));
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    const upper = await resolver.resolve(REGION_UPPER);
    const lower = await resolver.resolve(REGION);

    expect(getRawObject).toHaveBeenCalledTimes(1);
    expect(upper).toEqual(lower);
  });

  it('still reaches a marker written under the RAW upper-cased spelling', async () => {
    // Folding the read must never LOSE a marker the pre-fold read found:
    // `cdkd bootstrap` does not fold its own region (issue #1820), so the raw
    // key really can be the only one that exists.
    const getRawObject = vi
      .fn()
      .mockImplementation(async (key: string) =>
        key === RAW_KEY ? JSON.stringify(validMarker()) : null
      );
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    const mode = await resolver.resolve(REGION_UPPER);

    expect(probedKeys(getRawObject)).toEqual([CANONICAL_KEY, RAW_KEY]);
    expect(mode.mode).toBe('cdkd-assets');
    expect(gcNotices()).toHaveLength(0);
  });

  it('names the key the body actually came from when a RAW-keyed marker is malformed', async () => {
    // `parseBootstrapMarker`'s message is the user's only pointer at the file to
    // repair, so it must follow `resolvedKey` rather than the canonical key that
    // returned nothing.
    const getRawObject = vi
      .fn()
      .mockImplementation(async (key: string) => (key === RAW_KEY ? 'not json{' : null));
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    await expect(resolver.resolve(REGION_UPPER)).rejects.toThrow(RAW_KEY);
  });

  it('names the CANONICAL region in the legacy notice, so the remediation command works', async () => {
    // `cdkd bootstrap --region US-EAST-1` would write the raw key again; the
    // notice has to point at the spelling the canonical-first probe finds.
    const getRawObject = vi.fn().mockResolvedValue(null);
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    expect(await resolver.resolve(REGION_UPPER)).toEqual({ mode: 'legacy' });

    const notices = gcNotices();
    expect(notices).toHaveLength(1);
    expect(String(notices[0]![0])).toMatch(
      new RegExp(`\nBootstrap with: cdkd bootstrap --region ${REGION}$`)
    );
    expect(String(notices[0]![0])).not.toContain(REGION_UPPER);
  });

  // NOTE deliberately no "shows the legacy notice once across both spellings"
  // case here, and the reason is narrower than an earlier revision of this
  // comment claimed. That case DOES discriminate the shipped defect — measured,
  // it goes RED against a de-folded `resolve()` (two notices instead of one) —
  // so it is not unfalsifiable; it is REDUNDANT with the CALL-COUNT assertion in
  // the cache-slot case above, which fences the same fold one step earlier.
  // What it cannot fence is `legacyNoticeShownRegions` itself: re-keying that
  // Set on the raw spelling leaves the whole suite green, because the cache
  // makes `doResolve` unreachable a second time (see the Set's own comment in
  // `asset-storage.ts`). Stated precisely because a wrong "cannot be fenced"
  // note suppresses the retest that would have caught the difference.

  it('auto-creates under the CANONICAL name and key for an upper-cased region', async () => {
    // `ensureAssetStorage` names the bucket / repo from the region it is handed
    // and writes the marker at that key, so an unfolded region here would create
    // `cdkd-assets-<acct>-US-EAST-1` in us-east-1 and key it un-findably.
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    let stored: string | null = null;
    const putRawObject = vi.fn().mockImplementation(async (_key: string, body: string) => {
      stored = body;
    });
    const getRawObject = vi.fn().mockImplementation(async () => stored);
    const backend = { getRawObject, putRawObject } as unknown as S3StateBackend;
    const confirm = vi.fn().mockResolvedValue(true);
    const resolver = new AssetModeResolver(backend, ACCOUNT, { autoCreate: { confirm } });

    const mode = await resolver.resolve(REGION_UPPER);

    expect(confirm).toHaveBeenCalledWith(REGION);
    expect(putRawObject).toHaveBeenCalledWith(
      CANONICAL_KEY,
      expect.stringContaining(`cdkd-assets-${ACCOUNT}-${REGION}`)
    );
    expect(mode.mode).toBe('cdkd-assets');
    if (mode.mode === 'cdkd-assets') {
      expect(mode.marker.assetBucket).toBe(`cdkd-assets-${ACCOUNT}-${REGION}`);
    }
  });
});

/**
 * Issue #2021 — HOW REACHABLE the raw bootstrap-marker key actually is.
 *
 * `readBootstrapMarkerBody`'s second probe is justified in prose, and the
 * earlier per-caller copies of it overstated the justification ("`AWS_REGION=
 * US-EAST-1 cdkd bootstrap` really wrote `cdkd-bootstrap/US-EAST-1.json`").
 * That claim is FALSE on the default path, and prose cannot hold itself
 * honest — so the two mechanisms that make it false are pinned here. If a
 * later change makes an upper-cased bootstrap succeed on the default path,
 * these go red and the helper's doc gets revisited rather than silently
 * becoming wrong again.
 */
describe('raw bootstrap-marker key reachability (issue #2021)', () => {
  const REGION_UPPER = 'US-EAST-1';

  function freshRegionScript(): void {
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
  }

  function optionsFor(region: string, extra: Record<string, unknown> = {}) {
    const putRawObject = vi.fn().mockResolvedValue(undefined);
    const getRawObject = vi.fn().mockResolvedValue(null);
    return {
      putRawObject,
      options: {
        s3Client: new S3Client({ region }) as S3Client,
        ecrClient: new ECRClient({}) as ECRClient,
        stateBackend: { putRawObject, getRawObject } as unknown as S3StateBackend,
        accountId: ACCOUNT,
        region,
        force: false,
        ...extra,
      },
    };
  }

  it('derives an INVALID bucket name and LocationConstraint from an upper-cased region', async () => {
    // Both defects at once, and either alone is enough to stop the default path
    // before the marker write: S3 bucket names cannot contain uppercase, and
    // `region !== 'us-east-1'` is TRUE for `US-EAST-1`, so CreateBucket is also
    // handed a LocationConstraint that is not a valid enum member.
    freshRegionScript();
    const { options } = optionsFor(REGION_UPPER);

    await ensureAssetStorage(options);

    const createCall = mockS3Send.mock.calls.find((c) => c[0]._type === 'CreateBucket')![0];
    expect(createCall.Bucket).toBe(`cdkd-assets-${ACCOUNT}-${REGION_UPPER}`);
    expect(createCall.Bucket).toMatch(/[A-Z]/); // S3 rejects this outright
    expect(createCall.CreateBucketConfiguration?.LocationConstraint).toBe(REGION_UPPER);
  });

  it('reaches the RAW marker key only with BOTH custom names against an EXISTING bucket', async () => {
    // The one flow that does write `cdkd-bootstrap/US-EAST-1.json`: custom
    // lowercase names mean no conventional name is derived from the raw region,
    // and an already-existing bucket means the bad-LocationConstraint
    // CreateBucket is never issued. This is the state probe 2 exists to rescue.
    mockS3Send.mockResolvedValue({}); // HeadBucket succeeds => bucket exists
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    const { putRawObject, options } = optionsFor(REGION_UPPER, {
      assetBucketName: 'my-assets-bucket',
      containerRepoName: 'my-container-assets',
    });

    await ensureAssetStorage(options);

    expect(mockS3Send.mock.calls.some((c) => c[0]._type === 'CreateBucket')).toBe(false);
    const [key] = putRawObject.mock.calls[0]! as [string, string];
    expect(key).toBe(`cdkd-bootstrap/${REGION_UPPER}.json`);
  });
});

/**
 * go-to-k/cdkd#3950: the marker refusals printed the marker KEY, and the
 * storage refusals the marker's bucket and repository names, inside cdkd's
 * own `'...'`. The key comes from an S3 listing and the names from the
 * marker's body, so whoever can `s3:PutObject` on the state bucket chooses
 * them, and a `'` closed the quote. A plain value keeps its quotes; any other
 * is described, since these sentences name `cdkd bootstrap`. Every message is
 * pasted whole.
 */
describe('marker-derived values are never inside cdkd quotes (go-to-k/cdkd#3950)', () => {
  function isValidMarkerName(value: string): boolean {
    try {
      validateAssetBucketName(value);
      validateContainerRepoName(value);
      return true;
    } catch {
      return false;
    }
  }

  async function messagesFor(value: string): Promise<Array<{ site: string; message: string }>> {
    const out: Array<{ site: string; message: string }> = [];
    const key = `${BOOTSTRAP_MARKER_PREFIX}${value}.json`;
    const thrown = async (fn: () => unknown): Promise<string> => {
      try {
        await fn();
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected a throw');
    };
    out.push({ site: 'not JSON', message: await thrown(() => parseBootstrapMarker('{', key)) });
    out.push({
      site: 'malformed',
      message: await thrown(() => parseBootstrapMarker(JSON.stringify({ assetSupportVersion: 1 }), key)),
    });
    out.push({
      site: 'newer version',
      message: await thrown(() =>
        parseBootstrapMarker(
          JSON.stringify({ ...validMarker(), assetSupportVersion: ASSET_SUPPORT_VERSION + 1 }),
          key
        )
      ),
    });
    mockS3Send.mockRejectedValueOnce(awsError('NotFound', 404));
    out.push({
      site: 'bucket missing',
      message: await thrown(() =>
        verifyAssetStorageExists({ ...validMarker(), assetBucket: value }, ACCOUNT, REGION)
      ),
    });
    mockS3Send.mockRejectedValueOnce(awsError('Forbidden', 403));
    out.push({
      site: 'foreign bucket',
      message: await thrown(() =>
        verifyAssetStorageExists({ ...validMarker(), assetBucket: value }, ACCOUNT, REGION)
      ),
    });
    mockEcrSend.mockRejectedValueOnce(awsError('RepositoryNotFoundException'));
    out.push({
      site: 'repo missing',
      message: await thrown(() =>
        verifyAssetStorageExists({ ...validMarker(), containerRepo: value }, ACCOUNT, REGION)
      ),
    });
    // `assertAssetBucketRegion`, reached from the verify path's HeadBucket
    // redirect: once with the bucket's region known, once with the probe
    // failing.
    mockS3Send.mockRejectedValueOnce(awsErrorInRegion('Unknown', 301, 'ap-northeast-1'));
    out.push({
      site: 'verify: bucket in another region',
      message: await thrown(() =>
        verifyAssetStorageExists({ ...validMarker(), assetBucket: value }, ACCOUNT, REGION)
      ),
    });
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      Promise.reject(
        cmd._type === 'HeadBucket' ? awsError('PermanentRedirect', 301) : awsError('AccessDenied', 403)
      )
    );
    out.push({
      site: 'verify: bucket region unknown',
      message: await thrown(() =>
        verifyAssetStorageExists({ ...validMarker(), assetBucket: value }, ACCOUNT, REGION)
      ),
    });
    mockS3Send.mockResolvedValue({});
    // `ensureAssetStorage`'s bucket-name sites. A marker naming a non-plain
    // bucket is refused as malformed before it gets here (go-to-k/cdkd#4114),
    // so the name arrives through the option instead; the render guards are
    // the second layer and stay pinned.
    const reuse = (name: string) => ({
      s3Client: new S3Client({ region: REGION }) as S3Client,
      ecrClient: new ECRClient({}) as ECRClient,
      stateBackend: {
        putRawObject: vi.fn(),
        getRawObject: vi.fn().mockResolvedValue(null),
      } as unknown as S3StateBackend,
      accountId: ACCOUNT,
      region: REGION,
      force: false,
      assetBucketName: name,
    });
    const reused = value;
    mockS3Send.mockRejectedValueOnce(awsError('Forbidden', 403));
    out.push({
      site: 'ensure: bucket name taken (403)',
      message: await thrown(() => ensureAssetStorage(reuse(reused))),
    });
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket'
        ? Promise.reject(awsError('NotFound', 404))
        : cmd._type === 'CreateBucket'
          ? Promise.reject(awsError('BucketAlreadyExists', 409))
          : Promise.resolve({})
    );
    out.push({
      site: 'ensure: bucket name taken (BucketAlreadyExists)',
      message: await thrown(() => ensureAssetStorage(reuse(reused))),
    });
    mockS3Send.mockResolvedValue({});
    // The conflict names the EXISTING marker's names, which only a marker that
    // parses can carry: a non-plain one is malformed and rewritten instead.
    if (!isValidMarkerName(value)) return out;
    const existing = JSON.stringify({ ...validMarker(), assetBucket: value, containerRepo: value });
    out.push({
      site: 'name conflict',
      message: await thrown(() =>
        ensureAssetStorage({
          s3Client: new S3Client({ region: REGION }) as S3Client,
          ecrClient: new ECRClient({}) as ECRClient,
          stateBackend: {
            putRawObject: vi.fn(),
            getRawObject: vi.fn().mockResolvedValue(existing),
          } as unknown as S3StateBackend,
          accountId: ACCOUNT,
          region: REGION,
          force: false,
          assetBucketName: 'my-org-cdkd-assets',
          containerRepoName: 'my-org/cdkd-assets',
        })
      ),
    });
    return out;
  }

  it('keeps a plain value quoted, byte-identical to before', async () => {
    const messages = await messagesFor('plain-value');
    expect(messages).toHaveLength(11);
    const bySite = Object.fromEntries(messages.map((m) => [m.site, m.message]));
    const key = `'${BOOTSTRAP_MARKER_PREFIX}plain-value.json'`;
    expect(bySite['not JSON']).toContain(`Bootstrap marker ${key} in the state bucket is not valid JSON.`);
    expect(bySite['malformed']).toContain(`Bootstrap marker ${key} in the state bucket is malformed`);
    expect(bySite['newer version']).toContain(`Bootstrap marker ${key} has assetSupportVersion`);
    expect(bySite['bucket missing']).toContain("but the asset bucket 'plain-value' is missing.");
    expect(bySite['foreign bucket']).toContain("Asset bucket 'plain-value' exists but is not owned");
    expect(bySite['repo missing']).toContain("ECR repository 'plain-value' is missing.");
    expect(bySite['name conflict']).toContain(
      "already bootstrapped with asset bucket 'plain-value' (requested 'my-org-cdkd-assets') and " +
        "container repo 'plain-value' (requested 'my-org/cdkd-assets')."
    );
    expect(bySite['verify: bucket in another region']).toContain(
      "Asset bucket name 'plain-value' resolves to a bucket in ap-northeast-1"
    );
    expect(bySite['verify: bucket region unknown']).toContain(
      "Asset bucket 'plain-value' is claimed by an existing bucket"
    );
    expect(bySite['ensure: bucket name taken (403)']).toContain(
      "Asset bucket name 'plain-value' is already taken by a bucket this account"
    );
    expect(bySite['ensure: bucket name taken (BucketAlreadyExists)']).toContain(
      "Asset bucket name 'plain-value' is already taken by another AWS account."
    );
    // A real repository name carries `/`, which a plain name admits.
    mockEcrSend.mockRejectedValueOnce(awsError('RepositoryNotFoundException'));
    await expect(
      verifyAssetStorageExists({ ...validMarker(), containerRepo: 'my-org/cdkd-assets' }, ACCOUNT, REGION)
    ).rejects.toThrowError("ECR repository 'my-org/cdkd-assets' is missing.");
    // The corrupt-marker rewrite warning names the key it rewrites.
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    mockLoggerWarn.mockClear();
    await ensureAssetStorage({
      s3Client: new S3Client({ region: REGION }) as S3Client,
      ecrClient: new ECRClient({}) as ECRClient,
      stateBackend: {
        putRawObject: vi.fn().mockResolvedValue(undefined),
        getRawObject: vi.fn().mockResolvedValue('{'),
      } as unknown as S3StateBackend,
      accountId: ACCOUNT,
      region: REGION,
      force: false,
    });
    expect(mockLoggerWarn.mock.calls.map((c) => String(c[0]))).toContain(
      `Bootstrap marker '${getBootstrapMarkerKey(REGION)}' is malformed — rewriting it as part of this bootstrap.`
    );
  });

  it('describes every non-plain payload, names none of it, and no pasted span runs', async () => {
    const rendered: Array<{ value: string; site: string; message: string }> = [];
    for (const { value } of PAYLOADS) {
      for (const m of await messagesFor(value)) rendered.push({ value, ...m });
    }
    expect(rendered).toHaveLength(PAYLOADS.length * 10);
    withPasteDir((dir) => {
      for (const { value, site, message } of rendered) {
        const label = `${site}: ${value}`;
        expect(message, label).not.toContain(value);
        expect(message, label).not.toContain(JSON.stringify(value));
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
    const first = (site: string): string => rendered.find((r) => r.site === site)!.message;
    expect(first('not JSON')).toContain(
      'A bootstrap marker whose key is not a plain identifier in the state bucket is not valid JSON.'
    );
    expect(first('bucket missing')).toContain('but the asset bucket named by its marker is missing.');
    expect(first('foreign bucket')).toMatch(/^The asset bucket named by the marker exists but/);
    expect(first('repo missing')).toContain('ECR repository named by its marker is missing.');
    expect(first('verify: bucket in another region')).toMatch(
      /^An asset bucket name that is not a plain identifier resolves to a bucket in ap-northeast-1/
    );
    expect(first('verify: bucket region unknown')).toMatch(
      /^An asset bucket whose name is not a plain identifier is claimed by an existing bucket/
    );
    expect(first('ensure: bucket name taken (403)')).toMatch(
      /^An asset bucket name that is not a plain identifier is already taken by a bucket this account/
    );
    expect(first('ensure: bucket name taken (BucketAlreadyExists)')).toMatch(
      /^An asset bucket name that is not a plain identifier is already taken by another AWS account\./
    );
  }, 120_000);

  it("describes a value forged as displayIdent's own cut output (go-to-k/cdkd#4109)", async () => {
    // The pre-go-to-k/cdkd#4002 marker: it rendered unchanged until the marker
    // carried a digest of the withheld tail, and the whitespace test refuses it
    // either way.
    const suffix = ' [cut: 35 more characters withheld]';
    const forged = 'a'.repeat(STACK_REF_MAX_CODE_POINTS) + suffix;
    expect(displayIdent(forged, { maxCodePoints: STACK_REF_MAX_CODE_POINTS })).not.toBe(forged);
    // The bucket / repo sites. `messagesFor`'s marker-key sites prefix the value,
    // which pushes it past the cap, so they are driven directly below.
    const messages = await messagesFor(forged);
    expect(messages).toHaveLength(10);
    for (const { site, message } of messages) {
      expect(message, site).not.toContain(suffix);
    }
    expect(messages.find((m) => m.site === 'bucket missing')!.message).toContain(
      'but the asset bucket named by its marker is missing.'
    );

    // `markerSubject`, with the forged value as the whole key.
    let markerMessage = '';
    try {
      parseBootstrapMarker('{', forged);
    } catch (error) {
      markerMessage = (error as Error).message;
    }
    expect(markerMessage).toContain(
      'A bootstrap marker whose key is not a plain identifier in the state bucket is not valid JSON.'
    );
    expect(markerMessage).not.toContain(suffix);

    // The region-probe debug line, which logs only when AWS's text was withheld.
    mockLoggerDebug.mockClear();
    const denied = Object.assign(
      new Error(
        'User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized to perform: s3:GetBucketLocation'
      ),
      { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }
    );
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      Promise.reject(cmd._type === 'HeadBucket' ? awsError('PermanentRedirect', 301) : denied)
    );
    await expect(
      verifyAssetStorageExists({ ...validMarker(), assetBucket: forged }, ACCOUNT, REGION)
    ).rejects.toThrow();
    const debugLine = mockLoggerDebug.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith('GetBucketLocation failed for asset bucket'));
    expect(debugLine).toContain('asset bucket with a name that is not a plain identifier while');
    expect(debugLine).not.toContain(suffix);
  });

  it("renders a bucket / repository name through displayIdent in ensureAssetStorage's progress lines (go-to-k/cdkd#4109)", async () => {
    // Through the options: a marker carrying this name is refused as
    // malformed (go-to-k/cdkd#4114), and the render guard is the second layer.
    const forged = 'x (operation: deploy), expired 3h ago';
    const run = () =>
      ensureAssetStorage({
        s3Client: new S3Client({ region: REGION }) as S3Client,
        ecrClient: new ECRClient({}) as ECRClient,
        stateBackend: {
          putRawObject: vi.fn().mockResolvedValue(undefined),
          getRawObject: vi.fn().mockResolvedValue(null),
        } as unknown as S3StateBackend,
        accountId: ACCOUNT,
        region: REGION,
        force: false,
        assetBucketName: forged,
        containerRepoName: forged,
      });
    const infoLines = (): string[] => mockLoggerInfo.mock.calls.map((c) => String(c[0]));

    // Both absent: the "Creating" and "Created" lines.
    mockLoggerInfo.mockClear();
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    await run();
    const created = infoLines();
    expect(created).toContain(`Creating asset bucket: ${JSON.stringify(forged)} in region ${REGION}`);
    expect(created).toContain(`✓ Created asset bucket: ${JSON.stringify(forged)}`);
    expect(created).toContain(`Creating container-asset ECR repository: ${JSON.stringify(forged)}`);
    expect(created).toContain(`✓ Created container-asset ECR repository: ${JSON.stringify(forged)}`);

    // Both present: the "already exists" lines.
    mockLoggerInfo.mockClear();
    mockS3Send.mockResolvedValue({});
    mockEcrSend.mockResolvedValue({ repositories: [{ repositoryName: forged }] });
    await run();
    const existing = infoLines();
    expect(existing).toContain(`Asset bucket ${JSON.stringify(forged)} already exists`);
    expect(existing).toContain(`Container-asset repository ${JSON.stringify(forged)} already exists`);

    // A create race: the same "already exists" text from the create arms, told
    // apart from the probe arms above by the "Creating" line with no "Created".
    mockLoggerInfo.mockClear();
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket'
        ? Promise.reject(awsError('NotFound', 404))
        : cmd._type === 'CreateBucket'
          ? Promise.reject(awsError('BucketAlreadyOwnedByYou'))
          : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : cmd._type === 'CreateRepository'
          ? Promise.reject(awsError('RepositoryAlreadyExistsException'))
          : Promise.resolve({})
    );
    await run();
    const raced = infoLines();
    expect(raced).toContain(`Creating asset bucket: ${JSON.stringify(forged)} in region ${REGION}`);
    expect(raced).not.toContain(`✓ Created asset bucket: ${JSON.stringify(forged)}`);
    expect(raced).toContain(`Asset bucket ${JSON.stringify(forged)} already exists`);
    expect(raced).not.toContain(`✓ Created container-asset ECR repository: ${JSON.stringify(forged)}`);
    expect(raced).toContain(`Container-asset repository ${JSON.stringify(forged)} already exists`);

    for (const line of [...created, ...existing, ...raced]) expect(line).not.toContain(` ${forged}`);
  });
});

describe('a marker naming an invalid bucket or repository is malformed (go-to-k/cdkd#4114)', () => {
  const key = `${BOOTSTRAP_MARKER_PREFIX}${REGION}.json`;
  const invalid: Array<[string, Partial<BootstrapMarker>]> = [
    ['bucket with a space', { assetBucket: 'my bucket' }],
    ['bucket in upper case', { assetBucket: 'My-Bucket' }],
    ['bucket too short', { assetBucket: 'ab' }],
    ['repo with a quote', { containerRepo: "org/it's" }],
    ['repo with a doubled separator', { containerRepo: 'org//repo' }],
    ['repo too short', { containerRepo: 'a' }],
    ['repo too long', { containerRepo: 'a'.repeat(257) }],
  ];

  it('parseBootstrapMarker refuses it with the malformed-marker code', () => {
    for (const [label, fields] of invalid) {
      let caught: unknown;
      try {
        parseBootstrapMarker(JSON.stringify({ ...validMarker(), ...fields }), key);
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(CdkdError);
      expect((caught as CdkdError).code, label).toBe('INVALID_BOOTSTRAP_MARKER');
      expect((caught as Error).message, label).toContain('is not a valid name');
    }
    // A marker cdkd writes itself still parses.
    expect(parseBootstrapMarker(JSON.stringify(validMarker()), key)).toMatchObject({
      assetBucket: validMarker().assetBucket,
    });
    expect(
      parseBootstrapMarker(
        JSON.stringify({ ...validMarker(), assetBucket: 'my-org.assets-1', containerRepo: 'my-org/cdkd_assets' }),
        key
      )
    ).toMatchObject({ assetBucket: 'my-org.assets-1', containerRepo: 'my-org/cdkd_assets' });
  });

  it('ensureAssetStorage warns and rewrites it with the conventional names, never touching the marker-named storage', async () => {
    const body = JSON.stringify({ ...validMarker(), assetBucket: 'my bucket', containerRepo: "org/it's" });
    const putRawObject = vi.fn().mockResolvedValue(undefined);
    mockS3Send.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'HeadBucket' ? Promise.reject(awsError('NotFound', 404)) : Promise.resolve({})
    );
    mockEcrSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'DescribeRepositories'
        ? Promise.reject(awsError('RepositoryNotFoundException'))
        : Promise.resolve({})
    );
    mockLoggerWarn.mockClear();

    const result = await ensureAssetStorage({
      s3Client: new S3Client({ region: REGION }) as S3Client,
      ecrClient: new ECRClient({}) as ECRClient,
      stateBackend: {
        putRawObject,
        getRawObject: vi.fn().mockResolvedValue(body),
      } as unknown as S3StateBackend,
      accountId: ACCOUNT,
      region: REGION,
      force: false,
    });

    // The warning names what the marker recorded, so storage it tracked can
    // still be found: both names, each through displayIdent's boundary.
    expect(mockLoggerWarn.mock.calls.map((c) => String(c[0]))).toContain(
      `Bootstrap marker '${getBootstrapMarkerKey(REGION)}' is malformed — rewriting it as part of this bootstrap.` +
        ` It recorded asset bucket "my bucket" and container repository "org/it's"; storage under those names is no longer tracked by cdkd.`
    );
    expect(result.assetBucket).toBe(getCdkdAssetBucketName(ACCOUNT, REGION));
    expect(result.containerRepo).toBe(getCdkdContainerRepoName(ACCOUNT, REGION));
    const written = JSON.parse(String(putRawObject.mock.calls[0]![1])) as BootstrapMarker;
    expect(written.assetBucket).toBe(getCdkdAssetBucketName(ACCOUNT, REGION));
    // The command doubles spread their input, so `Bucket` sits on the command.
    const sentBuckets = mockS3Send.mock.calls
      .map((c) => (c[0] as { Bucket?: string }).Bucket)
      .filter((b): b is string => b !== undefined);
    expect(sentBuckets.length).toBeGreaterThan(0);
    expect(sentBuckets).not.toContain('my bucket');
    expect(sentBuckets).toContain(getCdkdAssetBucketName(ACCOUNT, REGION));
    const sentRepos = mockEcrSend.mock.calls.flatMap((c) => {
      const cmd = c[0] as { repositoryName?: string; repositoryNames?: string[] };
      return [...(cmd.repositoryName ? [cmd.repositoryName] : []), ...(cmd.repositoryNames ?? [])];
    });
    expect(sentRepos.length).toBeGreaterThan(0);
    expect(new Set(sentRepos)).toEqual(new Set([getCdkdContainerRepoName(ACCOUNT, REGION)]));
  });

  it('names no dropped storage when the rewrite writes the same names back', async () => {
    // Malformed only by a missing assetSupportVersion, with the conventional
    // names: the rewrite keeps both, so nothing is untracked.
    const { assetSupportVersion: _dropped, ...rest } = validMarker();
    const body = JSON.stringify(rest);
    mockS3Send.mockResolvedValue({});
    mockEcrSend.mockResolvedValue({ repositories: [{ repositoryName: getCdkdContainerRepoName(ACCOUNT, REGION) }] });
    mockLoggerWarn.mockClear();

    await ensureAssetStorage({
      s3Client: new S3Client({ region: REGION }) as S3Client,
      ecrClient: new ECRClient({}) as ECRClient,
      stateBackend: {
        putRawObject: vi.fn().mockResolvedValue(undefined),
        getRawObject: vi.fn().mockResolvedValue(body),
      } as unknown as S3StateBackend,
      accountId: ACCOUNT,
      region: REGION,
      force: false,
    });

    expect(mockLoggerWarn.mock.calls.map((c) => String(c[0]))).toContain(
      `Bootstrap marker '${getBootstrapMarkerKey(REGION)}' is malformed — rewriting it as part of this bootstrap.`
    );
  });

  it('names only the dropped name, and keeps a flag-supplied one that matches the record', async () => {
    const run = async (body: string, flags: { assetBucketName?: string; containerRepoName?: string }) => {
      mockS3Send.mockResolvedValue({});
      mockEcrSend.mockResolvedValue({ repositories: [{ repositoryName: 'x' }] });
      mockLoggerWarn.mockClear();
      await ensureAssetStorage({
        s3Client: new S3Client({ region: REGION }) as S3Client,
        ecrClient: new ECRClient({}) as ECRClient,
        stateBackend: {
          putRawObject: vi.fn().mockResolvedValue(undefined),
          getRawObject: vi.fn().mockResolvedValue(body),
        } as unknown as S3StateBackend,
        accountId: ACCOUNT,
        region: REGION,
        force: false,
        ...flags,
      });
      return mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    };
    const head = `Bootstrap marker '${getBootstrapMarkerKey(REGION)}' is malformed — rewriting it as part of this bootstrap.`;

    // A valid custom bucket beside an invalid repository: both are dropped for
    // the conventional names, and both are named.
    const oneInvalid = JSON.stringify({ ...validMarker(), assetBucket: 'my-org-assets', containerRepo: "org/it's" });
    expect(await run(oneInvalid, {})).toContain(
      `${head} It recorded asset bucket my-org-assets and container repository "org/it's"; storage under those names is no longer tracked by cdkd.`
    );

    // The same marker with --asset-bucket naming the recorded bucket: only the
    // repository is dropped.
    expect(await run(oneInvalid, { assetBucketName: 'my-org-assets' })).toContain(
      `${head} It recorded container repository "org/it's"; storage under those names is no longer tracked by cdkd.`
    );
  });
});

describe('the bootstrap hints name no shell-active region (go-to-k/cdkd#4205)', () => {
  // Each message below printed a planted region shell-quoted in its
  // `Bootstrap with:` / `Tear it down with:` command. What flips the quote
  // parity differs by message: `bucket's` in `assertAssetBucketRegion`'s
  // remedy; `region's` in the name-conflict refusal; an AWS error that may
  // carry a `'` in the auto-create warning; and in the legacy notice (whose
  // only quotes are the paired `'cdk gc'`) nothing of cdkd's own, so there it
  // is the text the operator pastes ABOVE the message, the harness's
  // OPERATOR_FLIP. Three of them also wrapped the raw region in cdkd's own
  // `'...'` in the prose itself, so `x'$(touch OWNED)` ran from that one line.
  // A region reaches these from a stack's `env.region`, which a prebuilt cloud
  // assembly can plant.
  const run = (label: string, message: string, dir: string): void => {
    expect(spansThatRun(message, dir), label).toEqual([]);
  };

  it('assertAssetBucketRegion: both refusals hole the region and run nothing pasted', async () => {
    const messages: Array<[string, string]> = [];
    for (const { label, value } of PASTE_PAYLOADS) {
      // The region ANSWERED by S3 differs from the one requested.
      const foreign = await assertAssetBucketRegion(
        { send: vi.fn() },
        'shared-assets',
        value,
        ACCOUNT,
        awsErrorInRegion('Unknown', 301, 'ap-northeast-1')
      ).catch((e: Error) => e.message);
      // No region header, and the probe cannot determine one.
      const unknown = await assertAssetBucketRegion(
        { send: vi.fn().mockRejectedValue(awsError('AccessDenied', 403)) },
        'shared-assets',
        value,
        ACCOUNT,
        awsError('Unknown', 400)
      ).catch((e: Error) => e.message);
      for (const [arm, message] of [
        ['foreign', foreign],
        ['unknown', unknown],
      ] as const) {
        expect(message, `${arm} ${label}`).toMatch(
          /\nBootstrap with: cdkd bootstrap --region '<region>' --asset-bucket '<name>'$/
        );
        expect(message, `${arm} ${label}`).toContain('this deploy region');
        messages.push([`${arm} ${label}`, message as string]);
      }
    }
    withPasteDir((dir) => {
      for (const [label, message] of messages) run(label, message, dir);
    });
  }, 120_000);

  it('ensureAssetStorage: the name-conflict refusal holes the region and runs nothing pasted', async () => {
    const messages: Array<[string, string]> = [];
    for (const { label, value } of PASTE_PAYLOADS) {
      const message = await ensureAssetStorage({
        s3Client: new S3Client({ region: REGION }) as S3Client,
        ecrClient: new ECRClient({}) as ECRClient,
        stateBackend: {
          putRawObject: vi.fn(),
          getRawObject: vi.fn().mockResolvedValue(JSON.stringify(validMarker())),
        } as unknown as S3StateBackend,
        accountId: ACCOUNT,
        region: value,
        force: false,
        assetBucketName: 'my-org-cdkd-assets',
      }).then(
        () => '',
        (e: Error) => e.message
      );
      expect(message, label).toContain('Region that is not a plain identifier is already bootstrapped');
      expect(message, label).toMatch(/\nTear it down with: cdkd bootstrap --destroy --region '<region>'$/);
      messages.push([label, message]);
    }
    // A plain region is still quoted in the prose and named in the command.
    const plain = await ensureAssetStorage({
      s3Client: new S3Client({ region: REGION }) as S3Client,
      ecrClient: new ECRClient({}) as ECRClient,
      stateBackend: {
        putRawObject: vi.fn(),
        getRawObject: vi.fn().mockResolvedValue(JSON.stringify(validMarker())),
      } as unknown as S3StateBackend,
      accountId: ACCOUNT,
      region: REGION,
      force: false,
      assetBucketName: 'my-org-cdkd-assets',
    }).then(
      () => '',
      (e: Error) => e.message
    );
    expect(plain).toContain(`Region '${REGION}' is already bootstrapped`);
    expect(plain).toMatch(new RegExp(`\\nTear it down with: cdkd bootstrap --destroy --region ${REGION}$`));
    withPasteDir((dir) => {
      for (const [label, message] of messages) run(label, message, dir);
    });
  }, 120_000);

  it('AssetModeResolver: the legacy notice and the auto-create warning hole the region and run nothing pasted', async () => {
    const messages: Array<[string, string]> = [];
    for (const { label, value } of PASTE_PAYLOADS) {
      mockLoggerInfo.mockClear();
      mockLoggerWarn.mockClear();
      // The legacy notice: no marker, no auto-create.
      await new AssetModeResolver(
        { getRawObject: vi.fn().mockResolvedValue(null) } as unknown as S3StateBackend,
        ACCOUNT
      ).resolve(value);
      const notice = mockLoggerInfo.mock.calls.map((c) => String(c[0])).find((m) => m.includes('cdk gc'));
      expect(notice, label).toMatch(/\nBootstrap with: cdkd bootstrap --region '<region>'$/);
      expect(notice, label).toContain('Assets for region that is not a plain identifier are published');
      messages.push([`notice ${label}`, notice!]);
      // The auto-create warning, with an AWS error whose text carries a `'`,
      // the shape the issue marks conditional on AWS's wording.
      mockS3Send.mockImplementation((cmd: { _type: string }) => {
        if (cmd._type === 'HeadBucket') return Promise.reject(awsError('NotFound', 404));
        if (cmd._type === 'CreateBucket') {
          return Promise.reject(awsError("AccessDenied: the principal's policy denies it", 403));
        }
        return Promise.resolve({});
      });
      let stored: string | null = null;
      await new AssetModeResolver(
        {
          getRawObject: vi.fn().mockImplementation(async () => stored),
          putRawObject: vi.fn().mockImplementation(async (_k: string, b: string) => {
            stored = b;
          }),
        } as unknown as S3StateBackend,
        ACCOUNT,
        { autoCreate: { confirm: vi.fn().mockResolvedValue(true) } }
      ).resolve(value);
      const warned = mockLoggerWarn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('Failed to auto-create cdkd asset storage'));
      expect(warned, label).toMatch(/\nBootstrap with: cdkd bootstrap --region '<region>'$/);
      expect(warned, label).toContain('for region that is not a plain identifier:');
      messages.push([`auto-create ${label}`, warned!]);
    }
    withPasteDir((dir) => {
      for (const [label, message] of messages) run(label, message, dir);
    });
  }, 120_000);
});
