import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockLoggerInfo, mockLoggerDebug, mockStsSend } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerDebug: vi.fn(),
  mockStsSend: vi.fn(),
}));

// createAssetRedirectResolver lazily imports the STS client to resolve the
// caller account id; intercept it so the happy-path test needs no AWS.
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend, destroy: vi.fn() })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

// AssetModeResolver's marker verification constructs region-scoped S3 / ECR
// clients — mock them so cdkd-assets-mode resolution succeeds offline.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn().mockResolvedValue({}), destroy: vi.fn() })),
  HeadBucketCommand: vi.fn().mockImplementation((input) => ({ ...input })),
  CreateBucketCommand: vi.fn().mockImplementation((input) => ({ ...input })),
  PutBucketEncryptionCommand: vi.fn().mockImplementation((input) => ({ ...input })),
  PutPublicAccessBlockCommand: vi.fn().mockImplementation((input) => ({ ...input })),
  PutBucketPolicyCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn().mockResolvedValue({}), destroy: vi.fn() })),
  DescribeRepositoriesCommand: vi.fn().mockImplementation((input) => ({ ...input })),
  CreateRepositoryCommand: vi.fn().mockImplementation((input) => ({ ...input })),
  PutImageTagMutabilityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: mockLoggerDebug,
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: mockLoggerDebug,
      info: mockLoggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import {
  buildAssetRedirectMap,
  createAssetRedirectResolver,
  findUnrewrittenAssetReferences,
  flattenAssetPlaceholders,
  isDefaultBootstrapBucketName,
  isDefaultBootstrapRepoName,
  loadPublishableAssetManifest,
  redirectDockerAsset,
  redirectFileAsset,
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../../src/assets/asset-redirect.js';
import type { BootstrapMarker } from '../../../src/assets/asset-storage.js';
import type { AssetManifest } from '../../../src/types/assets.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const CDK_BUCKET_PLACEHOLDER = 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}';
const CDK_BUCKET_LITERAL = `cdk-hnb659fds-assets-${ACCOUNT}-${REGION}`;
const CDK_REPO_PLACEHOLDER = 'cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}';
const CDK_REPO_LITERAL = `cdk-hnb659fds-container-assets-${ACCOUNT}-${REGION}`;
const CDKD_BUCKET = `cdkd-assets-${ACCOUNT}-${REGION}`;
const CDKD_REPO = `cdkd-container-assets-${ACCOUNT}-${REGION}`;

function marker(): BootstrapMarker {
  return {
    assetBucket: CDKD_BUCKET,
    containerRepo: CDKD_REPO,
    assetSupportVersion: 1,
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function manifestWith(args: {
  fileDest?: Partial<{ bucketName: string; objectKey: string; region: string }>;
  dockerDest?: Partial<{ repositoryName: string; imageTag: string; region: string }>;
  templateAsset?: boolean;
}): AssetManifest {
  const files: AssetManifest['files'] = {};
  const dockerImages: AssetManifest['dockerImages'] = {};
  if (args.fileDest) {
    files['aaaa1111'] = {
      displayName: 'Code',
      source: { path: 'asset.aaaa1111', packaging: 'zip' },
      destinations: {
        'current_account-current_region': {
          bucketName: args.fileDest.bucketName ?? CDK_BUCKET_PLACEHOLDER,
          objectKey: args.fileDest.objectKey ?? 'aaaa1111.zip',
          ...(args.fileDest.region && { region: args.fileDest.region }),
        },
      },
    };
  }
  if (args.templateAsset) {
    files['tttt2222'] = {
      displayName: 'Stack Template',
      source: { path: 'Stack.template.json', packaging: 'file' },
      destinations: {
        'current_account-current_region': {
          bucketName: CDK_BUCKET_PLACEHOLDER,
          objectKey: 'tttt2222.json',
        },
      },
    };
  }
  if (args.dockerDest) {
    dockerImages['bbbb3333'] = {
      displayName: 'Image',
      source: { directory: 'asset.bbbb3333' },
      destinations: {
        'current_account-current_region': {
          repositoryName: args.dockerDest.repositoryName ?? CDK_REPO_PLACEHOLDER,
          imageTag: args.dockerDest.imageTag ?? 'bbbb3333',
          ...(args.dockerDest.region && { region: args.dockerDest.region }),
        },
      },
    };
  }
  return { version: '38.0.0', files, dockerImages };
}

function buildMap(manifest: AssetManifest): AssetRedirectMap {
  return buildAssetRedirectMap(manifest, marker(), ACCOUNT, REGION);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scope predicates (§8)', () => {
  it('matches default and custom qualifiers for this account+region', () => {
    expect(isDefaultBootstrapBucketName(CDK_BUCKET_LITERAL, ACCOUNT, REGION)).toBe(true);
    expect(
      isDefaultBootstrapBucketName(`cdk-myqual1-assets-${ACCOUNT}-${REGION}`, ACCOUNT, REGION)
    ).toBe(true);
    expect(isDefaultBootstrapRepoName(CDK_REPO_LITERAL, ACCOUNT, REGION)).toBe(true);
  });

  it('rejects user-chosen names, foreign accounts/regions, and suffixed lookalikes', () => {
    expect(isDefaultBootstrapBucketName('my-company-assets-bucket', ACCOUNT, REGION)).toBe(false);
    expect(
      isDefaultBootstrapBucketName(`cdk-hnb659fds-assets-999999999999-${REGION}`, ACCOUNT, REGION)
    ).toBe(false);
    expect(
      isDefaultBootstrapBucketName(`cdk-hnb659fds-assets-${ACCOUNT}-eu-west-1`, ACCOUNT, REGION)
    ).toBe(false);
    expect(
      isDefaultBootstrapBucketName(`${CDK_BUCKET_LITERAL}-backup`, ACCOUNT, REGION)
    ).toBe(false);
    // The bucket predicate must not swallow container repos and vice versa.
    expect(isDefaultBootstrapBucketName(CDK_REPO_LITERAL, ACCOUNT, REGION)).toBe(false);
    expect(isDefaultBootstrapRepoName(CDK_BUCKET_LITERAL, ACCOUNT, REGION)).toBe(false);
  });
});

describe('buildAssetRedirectMap (§6 + §8 rows)', () => {
  it('maps default-bootstrap-shaped file + docker destinations (placeholder form)', () => {
    const map = buildMap(manifestWith({ fileDest: {}, dockerDest: {} }));
    expect(map.buckets.get(CDK_BUCKET_LITERAL)).toBe(CDKD_BUCKET);
    expect(map.repos.get(CDK_REPO_LITERAL)).toBe(CDKD_REPO);
    // Entries carry the placeholder AND flattened source forms.
    const sources = map.entries.map((e) => e.source);
    expect(sources).toContain(CDK_BUCKET_PLACEHOLDER);
    expect(sources).toContain(CDK_BUCKET_LITERAL);
    expect(sources).toContain(CDK_REPO_PLACEHOLDER);
    expect(sources).toContain(CDK_REPO_LITERAL);
  });

  it('maps custom-qualifier destinations (§8 row 2)', () => {
    const map = buildMap(
      manifestWith({ fileDest: { bucketName: 'cdk-myqual1-assets-${AWS::AccountId}-${AWS::Region}' } })
    );
    expect(map.buckets.get(`cdk-myqual1-assets-${ACCOUNT}-${REGION}`)).toBe(CDKD_BUCKET);
  });

  it('leaves custom fileAssetsBucketName / staging-bucket names verbatim (§8 rows 4+6)', () => {
    const map = buildMap(manifestWith({ fileDest: { bucketName: 'my-app-staging-bucket' } }));
    expect(map.buckets.size).toBe(0);
    expect(map.entries).toHaveLength(0);
  });

  it('leaves cross-region destinations verbatim (§8 row 5)', () => {
    const map = buildMap(
      manifestWith({
        fileDest: { bucketName: `cdk-hnb659fds-assets-${ACCOUNT}-eu-west-1`, region: 'eu-west-1' },
      })
    );
    expect(map.buckets.size).toBe(0);
  });

  it('includes template-asset destinations so TemplateURL rewrites uniformly', () => {
    const map = buildMap(manifestWith({ templateAsset: true }));
    expect(map.buckets.get(CDK_BUCKET_LITERAL)).toBe(CDKD_BUCKET);
  });

  it('synthesizes mixed single-placeholder source forms (review M1)', () => {
    const map = buildMap(manifestWith({ fileDest: {} }));
    const sources = map.entries.map((e) => e.source);
    expect(sources).toContain(`cdk-hnb659fds-assets-\${AWS::AccountId}-${REGION}`);
    expect(sources).toContain(`cdk-hnb659fds-assets-${ACCOUNT}-\${AWS::Region}`);
  });

  it('leaves custom docker repositoryName / cross-region docker destinations verbatim (§8)', () => {
    expect(
      buildMap(manifestWith({ dockerDest: { repositoryName: 'my-app-repo' } })).repos.size
    ).toBe(0);
    expect(
      buildMap(
        manifestWith({
          dockerDest: {
            repositoryName: `cdk-hnb659fds-container-assets-${ACCOUNT}-eu-west-1`,
            region: 'eu-west-1',
          },
        })
      ).repos.size
    ).toBe(0);
  });
});

describe('rewriteTemplateAssetReferences (§7)', () => {
  it('rewrites Fn::Sub template strings (placeholder form) and literal strings', () => {
    const template = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Code: {
              S3Bucket: { 'Fn::Sub': CDK_BUCKET_PLACEHOLDER },
              S3Key: 'aaaa1111.zip',
            },
            Environment: {
              Variables: {
                ASSET_URL: `https://s3.${REGION}.amazonaws.com/${CDK_BUCKET_LITERAL}/aaaa1111.zip`,
              },
            },
          },
        },
      },
    } as unknown as CloudFormationTemplate;
    const map = buildMap(manifestWith({ fileDest: {} }));
    const n = rewriteTemplateAssetReferences(template, map);
    expect(n).toBe(2);
    const props = (template.Resources!['Fn'] as { Properties: Record<string, unknown> })
      .Properties as {
      Code: { S3Bucket: { 'Fn::Sub': string }; S3Key: string };
      Environment: { Variables: { ASSET_URL: string } };
    };
    expect(props.Code.S3Bucket['Fn::Sub']).toBe(CDKD_BUCKET);
    expect(props.Code.S3Key).toBe('aaaa1111.zip');
    expect(props.Environment.Variables.ASSET_URL).toBe(
      `https://s3.${REGION}.amazonaws.com/${CDKD_BUCKET}/aaaa1111.zip`
    );
  });

  it('folds pseudo-parameter-only Fn::Join runs and rewrites across parts', () => {
    const template = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            CodeUri: {
              'Fn::Join': [
                '',
                [
                  'https://s3.',
                  { Ref: 'AWS::Region' },
                  '.',
                  { Ref: 'AWS::URLSuffix' },
                  '/cdk-hnb659fds-assets-',
                  { Ref: 'AWS::AccountId' },
                  '-',
                  { Ref: 'AWS::Region' },
                  '/aaaa1111.zip',
                ],
              ],
            },
          },
        },
      },
    } as unknown as CloudFormationTemplate;
    const map = buildMap(manifestWith({ fileDest: {} }));
    const n = rewriteTemplateAssetReferences(template, map);
    expect(n).toBe(1);
    const codeUri = (
      (template.Resources!['Fn'] as { Properties: Record<string, unknown> }).Properties as {
        CodeUri: { 'Fn::Join': [string, unknown[]] };
      }
    ).CodeUri;
    expect(codeUri['Fn::Join'][1]).toEqual([
      `https://s3.${REGION}.amazonaws.com/${CDKD_BUCKET}/aaaa1111.zip`,
    ]);
  });

  it('leaves Fn::Join runs containing real resource refs alone', () => {
    const parts = ['arn:aws:s3:::', { Ref: 'MyBucket' }, '/key'];
    const template = {
      Resources: {
        R: { Type: 'AWS::IAM::Policy', Properties: { Res: { 'Fn::Join': ['', [...parts]] } } },
      },
    } as unknown as CloudFormationTemplate;
    const map = buildMap(manifestWith({ fileDest: {} }));
    expect(rewriteTemplateAssetReferences(template, map)).toBe(0);
    const joined = (
      (template.Resources!['R'] as { Properties: Record<string, unknown> }).Properties as {
        Res: { 'Fn::Join': [string, unknown[]] };
      }
    ).Res['Fn::Join'][1];
    expect(joined).toEqual(parts);
  });

  it('does not persist folds when no source matched (byte-identical no-op)', () => {
    const template = {
      Resources: {
        R: {
          Type: 'AWS::SNS::Topic',
          Properties: {
            Name: {
              'Fn::Join': ['-', ['prefix', { Ref: 'AWS::AccountId' }, { Ref: 'AWS::Region' }]],
            },
          },
        },
      },
    } as unknown as CloudFormationTemplate;
    const before = JSON.stringify(template);
    const map = buildMap(manifestWith({ fileDest: {} }));
    expect(rewriteTemplateAssetReferences(template, map)).toBe(0);
    expect(JSON.stringify(template)).toBe(before);
  });

  it('rewrites a mixed single-placeholder Fn::Sub reference (review M1)', () => {
    const template = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Code: {
              S3Bucket: { 'Fn::Sub': `cdk-hnb659fds-assets-${ACCOUNT}-\${AWS::Region}` },
            },
          },
        },
      },
    } as unknown as CloudFormationTemplate;
    const map = buildMap(manifestWith({ fileDest: {} }));
    expect(rewriteTemplateAssetReferences(template, map)).toBe(1);
    const bucket = (
      (template.Resources!['Fn'] as { Properties: Record<string, unknown> }).Properties as {
        Code: { S3Bucket: { 'Fn::Sub': string } };
      }
    ).Code.S3Bucket['Fn::Sub'];
    expect(bucket).toBe(CDKD_BUCKET);
  });

  it('is boundary-aware: lookalike names are never corrupted (§7 addendum 4)', () => {
    const template = {
      Resources: {
        R: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            A: `${CDK_BUCKET_LITERAL}-backup`,
            B: `my-${CDK_BUCKET_LITERAL}`,
            C: `arn:aws:s3:::${CDK_BUCKET_LITERAL}/key`,
            D: `${CDK_BUCKET_LITERAL}.s3.${REGION}.amazonaws.com`,
          },
        },
      },
    } as unknown as CloudFormationTemplate;
    const map = buildMap(manifestWith({ fileDest: {} }));
    const n = rewriteTemplateAssetReferences(template, map);
    expect(n).toBe(2);
    const props = (template.Resources!['R'] as { Properties: Record<string, string> }).Properties;
    expect(props['A']).toBe(`${CDK_BUCKET_LITERAL}-backup`);
    expect(props['B']).toBe(`my-${CDK_BUCKET_LITERAL}`);
    expect(props['C']).toBe(`arn:aws:s3:::${CDKD_BUCKET}/key`);
    expect(props['D']).toBe(`${CDKD_BUCKET}.s3.${REGION}.amazonaws.com`);
  });

  it('rewrites ECR image URIs to the cdkd container repo (tag untouched)', () => {
    const template = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Code: {
              ImageUri: {
                'Fn::Sub': `\${AWS::AccountId}.dkr.ecr.\${AWS::Region}.\${AWS::URLSuffix}/${CDK_REPO_PLACEHOLDER}:bbbb3333`,
              },
            },
          },
        },
      },
    } as unknown as CloudFormationTemplate;
    const map = buildMap(manifestWith({ dockerDest: {} }));
    expect(rewriteTemplateAssetReferences(template, map)).toBe(1);
    const uri = (
      (template.Resources!['Fn'] as { Properties: Record<string, unknown> }).Properties as {
        Code: { ImageUri: { 'Fn::Sub': string } };
      }
    ).Code.ImageUri['Fn::Sub'];
    expect(uri).toBe(
      `\${AWS::AccountId}.dkr.ecr.\${AWS::Region}.\${AWS::URLSuffix}/${CDKD_REPO}:bbbb3333`
    );
  });
});

describe('findUnrewrittenAssetReferences (§7 step 3 audit)', () => {
  it('reports the property path of a surviving source name', () => {
    const map = buildMap(manifestWith({ fileDest: {} }));
    const findings = findUnrewrittenAssetReferences(
      {
        Code: { S3Bucket: CDK_BUCKET_LITERAL, S3Key: 'aaaa1111.zip' },
        Env: { List: ['ok', `s3://${CDK_BUCKET_LITERAL}/x`] },
      },
      map
    );
    expect(findings).toEqual([
      { path: 'Code.S3Bucket', source: CDK_BUCKET_LITERAL },
      { path: 'Env.List[1]', source: CDK_BUCKET_LITERAL },
    ]);
  });

  it('returns no findings for clean / rewritten properties', () => {
    const map = buildMap(manifestWith({ fileDest: {} }));
    expect(
      findUnrewrittenAssetReferences({ Code: { S3Bucket: CDKD_BUCKET } }, map)
    ).toHaveLength(0);
    // Lookalike names are not findings either (boundary-aware).
    expect(
      findUnrewrittenAssetReferences({ A: `${CDK_BUCKET_LITERAL}-backup` }, map)
    ).toHaveLength(0);
  });
});

describe('redirectFileAsset / redirectDockerAsset (§6 publish-time)', () => {
  it('redirects mapped destinations, keeping objectKey / imageTag (incl. bucketPrefix keys, §8 row 3)', () => {
    const manifest = manifestWith({
      fileDest: { objectKey: 'my-prefix/aaaa1111.zip' },
      dockerDest: {},
    });
    const map = buildMap(manifest);
    const file = redirectFileAsset(manifest.files['aaaa1111']!, map);
    const fileDest = file.destinations['current_account-current_region']!;
    expect(fileDest.bucketName).toBe(CDKD_BUCKET);
    expect(fileDest.objectKey).toBe('my-prefix/aaaa1111.zip');
    const docker = redirectDockerAsset(manifest.dockerImages['bbbb3333']!, map);
    const dockerDest = docker.destinations['current_account-current_region']!;
    expect(dockerDest.repositoryName).toBe(CDKD_REPO);
    expect(dockerDest.imageTag).toBe('bbbb3333');
  });

  it('returns the original asset when nothing is in scope', () => {
    const manifest = manifestWith({ fileDest: { bucketName: 'user-picked-bucket' } });
    const map = buildMap(manifest);
    const asset = manifest.files['aaaa1111']!;
    expect(redirectFileAsset(asset, map)).toBe(asset);
  });

  it('redirects only the deploy-region destination when a name is shared with a cross-region one', () => {
    // Both destinations flatten to the SAME in-scope repo name (the
    // placeholder resolves against the deploy region), but only the
    // deploy-region destination may redirect — the cross-region copy stays
    // verbatim (§8 row 5) via the destRegionMatches guard.
    const asset = {
      displayName: 'Image',
      source: { directory: 'asset.bbbb3333' },
      destinations: {
        same: { repositoryName: CDK_REPO_PLACEHOLDER, imageTag: 't1' },
        cross: { repositoryName: CDK_REPO_PLACEHOLDER, imageTag: 't1', region: 'eu-west-1' },
      },
    };
    const map = buildMap({ version: '38.0.0', files: {}, dockerImages: { bbbb3333: asset } });
    const redirected = redirectDockerAsset(asset, map);
    expect(redirected.destinations['same']!.repositoryName).toBe(CDKD_REPO);
    expect(redirected.destinations['cross']!.repositoryName).toBe(CDK_REPO_PLACEHOLDER);
  });
});

describe('flattenAssetPlaceholders', () => {
  it('resolves account/region/partition placeholders', () => {
    expect(
      flattenAssetPlaceholders(
        'cdk-x-assets-${AWS::AccountId}-${AWS::Region}-${AWS::Partition}',
        ACCOUNT,
        REGION
      )
    ).toBe(`cdk-x-assets-${ACCOUNT}-${REGION}-aws`);
  });
});

describe('loadPublishableAssetManifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-asset-redirect-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the manifest when it has publishable assets', () => {
    const p = join(dir, 'Stack.assets.json');
    writeFileSync(p, JSON.stringify(manifestWith({ fileDest: {} })));
    expect(loadPublishableAssetManifest(p)).not.toBeNull();
  });

  it('returns null for a missing manifest (ENOENT)', () => {
    expect(loadPublishableAssetManifest(join(dir, 'nope.assets.json'))).toBeNull();
  });

  it('returns null when only CFn template assets exist', () => {
    const p = join(dir, 'Stack.assets.json');
    writeFileSync(p, JSON.stringify(manifestWith({ templateAsset: true })));
    expect(loadPublishableAssetManifest(p)).toBeNull();
  });

  it('propagates non-ENOENT failures (corrupt manifest is not "no assets")', () => {
    const p = join(dir, 'Stack.assets.json');
    writeFileSync(p, 'not json{');
    expect(() => loadPublishableAssetManifest(p)).toThrow();
  });
});

describe('createAssetRedirectResolver (diff / import gating)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-asset-redirect-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(): string {
    const p = join(dir, 'Stack.assets.json');
    writeFileSync(p, JSON.stringify(manifestWith({ fileDest: {} })));
    return p;
  }

  function backend(markerBody: string | null): S3StateBackend {
    return { getRawObject: vi.fn().mockResolvedValue(markerBody) } as unknown as S3StateBackend;
  }

  it('returns undefined without any AWS call for asset-less stacks', async () => {
    const getRawObject = vi.fn();
    const resolve = createAssetRedirectResolver({
      stateBackend: { getRawObject } as unknown as S3StateBackend,
      stsRegion: REGION,
    });
    expect(await resolve(undefined, REGION)).toBeUndefined();
    expect(await resolve(join(dir, 'missing.assets.json'), REGION)).toBeUndefined();
    expect(getRawObject).not.toHaveBeenCalled();
  });

  it('returns undefined in legacy mode (marker absent)', async () => {
    mockStsSend.mockResolvedValue({ Account: ACCOUNT });
    const resolve = createAssetRedirectResolver({
      stateBackend: backend(null),
      stsRegion: REGION,
      suppressLegacyNotice: true,
    });
    expect(await resolve(writeManifest(), REGION)).toBeUndefined();
  });

  it('short-circuits to undefined under useCdkBootstrapAssets (no marker read)', async () => {
    const stateBackend = backend(JSON.stringify(marker()));
    const resolve = createAssetRedirectResolver({
      stateBackend,
      stsRegion: REGION,
      useCdkBootstrapAssets: true,
    });
    expect(await resolve(writeManifest(), REGION)).toBeUndefined();
    expect(stateBackend.getRawObject).not.toHaveBeenCalled();
  });

  it('builds the map in cdkd-assets mode, resolving the account id once via STS', async () => {
    mockStsSend.mockResolvedValue({ Account: ACCOUNT });
    // Marker verification (S3 HeadBucket / ECR DescribeRepositories) runs
    // inside AssetModeResolver against real clients — stub it by making the
    // marker verification pass through mocked SDK clients is out of scope
    // here, so use a marker body and mock the SDK clients too.
    const resolve = createAssetRedirectResolver({
      stateBackend: backend(JSON.stringify(marker())),
      stsRegion: REGION,
      suppressLegacyNotice: true,
    });
    const manifestPath = writeManifest();
    const map = await resolve(manifestPath, REGION);
    expect(map).toBeDefined();
    expect(map!.buckets.get(CDK_BUCKET_LITERAL)).toBe(CDKD_BUCKET);
    await resolve(manifestPath, REGION);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });
});
