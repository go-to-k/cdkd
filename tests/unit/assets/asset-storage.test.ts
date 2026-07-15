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

  it('resolves legacy mode when no marker exists, with ONE info line across regions', async () => {
    const getRawObject = vi.fn().mockResolvedValue(null);
    const resolver = new AssetModeResolver(makeBackend(getRawObject), ACCOUNT);

    expect(await resolver.resolve('us-east-1')).toEqual({ mode: 'legacy' });
    expect(await resolver.resolve('ap-northeast-1')).toEqual({ mode: 'legacy' });

    expect(getRawObject).toHaveBeenCalledWith('cdkd-bootstrap/us-east-1.json');
    expect(getRawObject).toHaveBeenCalledWith('cdkd-bootstrap/ap-northeast-1.json');
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
});

describe('ensureAssetStorage', () => {
  function makeOptions(overrides: { region?: string; force?: boolean } = {}) {
    const putRawObject = vi.fn().mockResolvedValue(undefined);
    const region = overrides.region ?? REGION;
    return {
      putRawObject,
      options: {
        s3Client: new S3Client({}) as S3Client,
        ecrClient: new ECRClient({}) as ECRClient,
        stateBackend: { putRawObject } as unknown as S3StateBackend,
        accountId: ACCOUNT,
        region,
        force: overrides.force ?? false,
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
