import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
  S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send, destroy: vi.fn() })),
  HeadBucketCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'HeadBucket' })),
  CreateBucketCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'CreateBucket' })),
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
  AssetModeResolver,
  type BootstrapMarker,
} from '../../../src/assets/asset-storage.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

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
    expect(String(gcNotices[0]![0])).toContain("Run 'cdkd bootstrap --region us-east-1'");
    expect(String(gcNotices[1]![0])).toContain("Run 'cdkd bootstrap --region ap-northeast-1'");
  });

  it('shows the legacy notice only once per region across repeated resolves', async () => {
    const getRawObject = vi.fn().mockResolvedValue(null);
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    await resolver.resolve('us-east-1');
    await resolver.resolve('us-east-1');

    const gcNotices = mockLoggerInfo.mock.calls.filter((c) => String(c[0]).includes('cdk gc'));
    expect(gcNotices).toHaveLength(1);
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
    } = {}
  ) {
    const putRawObject = vi.fn().mockResolvedValue(undefined);
    const getRawObject = vi.fn().mockResolvedValue(overrides.existingMarkerBody ?? null);
    const region = overrides.region ?? REGION;
    return {
      putRawObject,
      getRawObject,
      options: {
        s3Client: new S3Client({}) as S3Client,
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
        s3Client: new S3Client({}) as S3Client,
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
    expect(String(warns[0]![0])).toContain(`cdkd bootstrap --region ${REGION}`);
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
