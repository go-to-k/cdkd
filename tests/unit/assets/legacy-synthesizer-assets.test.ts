import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockCfnSend, mockCfnDestroy } = vi.hoisted(() => ({
  mockCfnSend: vi.fn(),
  mockCfnDestroy: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({
    send: vi.fn(async () => ({ Account: '123456789012' })),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn((input) => ({ ...input })),
}));

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: vi.fn(() => ({
    send: mockCfnSend,
    destroy: mockCfnDestroy,
  })),
  DescribeStacksCommand: vi.fn((input) => ({ ...input, _type: 'DescribeStacks' })),
}));

import {
  bindLegacyStackAssetParameters,
  bindLegacyAssetParameters,
  buildLegacyAssetPlan,
  createLegacyAssetParameterBinder,
  legacyAssetEntriesFromMetadata,
  prepareLegacyStackAssets,
  resetLegacyToolkitBucketCache,
  type LegacyAssetEntry,
  type LegacyFileAssetEntry,
} from '../../../src/assets/legacy-synthesizer-assets.js';
import {
  CdkToolkitBucketMissingError,
  lookupCdkToolkitBucket,
} from '../../../src/assets/cdk-toolkit-bucket.js';
import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { BootstrapMarker } from '../../../src/assets/asset-storage/marker.js';

// The entries `cdk synth` writes for the issue's repro app (aws-cdk-lib 2.x,
// LegacyStackSynthesizer): a `Code.fromAsset` directory and an
// `s3assets.Asset` file.
const ZIP_HASH = '8618294e4c15b42a6a1cccef1d013fd30bdcebc8d171446f2714ef647b698efa';
const FILE_HASH = '580565eda4e7795d6b16858c029cb748e81e8c85c1ddd9f1b7ccd23cca590cbd';
const zipEntry: LegacyFileAssetEntry = {
  path: `asset.${ZIP_HASH}`,
  id: ZIP_HASH,
  packaging: 'zip',
  sourceHash: ZIP_HASH,
  s3BucketParameter: `AssetParameters${ZIP_HASH}S3BucketE1DD80B4`,
  s3KeyParameter: `AssetParameters${ZIP_HASH}S3VersionKey51687BDC`,
  artifactHashParameter: `AssetParameters${ZIP_HASH}ArtifactHashA9EAD8FD`,
};
const fileEntry: LegacyFileAssetEntry = {
  path: `asset.${FILE_HASH}.txt`,
  id: FILE_HASH,
  packaging: 'file',
  sourceHash: FILE_HASH,
  s3BucketParameter: `AssetParameters${FILE_HASH}S3Bucket9FA88B79`,
  s3KeyParameter: `AssetParameters${FILE_HASH}S3VersionKeyA81B631F`,
  artifactHashParameter: `AssetParameters${FILE_HASH}ArtifactHashDBFF76A3`,
};

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const marker = { assetBucket: 'cdkd-assets-123456789012-us-east-1' } as BootstrapMarker;

/** The template shape LegacyStackSynthesizer emits for the zip asset. */
function legacyTemplate(): CloudFormationTemplate {
  const p = (name: string) => ({ Type: 'String', Description: name });
  return {
    Parameters: {
      [zipEntry['s3BucketParameter'] as string]: p('bucket'),
      [zipEntry['s3KeyParameter'] as string]: p('key'),
      [zipEntry['artifactHashParameter'] as string]: p('hash'),
      [fileEntry['s3BucketParameter'] as string]: p('bucket'),
      [fileEntry['s3KeyParameter'] as string]: p('key'),
      [fileEntry['artifactHashParameter'] as string]: p('hash'),
    },
    Resources: {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          Code: {
            S3Bucket: { Ref: zipEntry['s3BucketParameter'] },
            S3Key: {
              'Fn::Join': [
                '',
                [
                  {
                    'Fn::Select': [0, { 'Fn::Split': ['||', { Ref: zipEntry['s3KeyParameter'] }] }],
                  },
                  {
                    'Fn::Select': [1, { 'Fn::Split': ['||', { Ref: zipEntry['s3KeyParameter'] }] }],
                  },
                ],
              ],
            },
          },
        },
      },
    },
  } as unknown as CloudFormationTemplate;
}

beforeEach(() => {
  mockCfnSend.mockReset();
  mockCfnDestroy.mockReset();
  resetLegacyToolkitBucketCache();
});

describe('buildLegacyAssetPlan (CDK CLI prepareFileAsset parity)', () => {
  it('keys a zip under assets/<hash>.zip and a file under assets/<hash><ext>', () => {
    const plan = buildLegacyAssetPlan([zipEntry, fileEntry], {
      fileBucket: 'the-bucket',
      accountId: ACCOUNT,
      region: REGION,
    });
    expect(plan.manifest.files[ZIP_HASH]!.source).toEqual({
      path: `asset.${ZIP_HASH}`,
      packaging: 'zip',
    });
    expect(Object.values(plan.manifest.files[ZIP_HASH]!.destinations)).toEqual([
      { bucketName: 'the-bucket', objectKey: `assets/${ZIP_HASH}.zip`, region: REGION },
    ]);
    expect(Object.values(plan.manifest.files[FILE_HASH]!.destinations)[0]!.objectKey).toBe(
      `assets/${FILE_HASH}.txt`
    );
    expect(plan.parameters).toEqual({
      [zipEntry['s3BucketParameter'] as string]: 'the-bucket',
      [zipEntry['s3KeyParameter'] as string]: `assets/||${ZIP_HASH}.zip`,
      [zipEntry['artifactHashParameter'] as string]: ZIP_HASH,
      [fileEntry['s3BucketParameter'] as string]: 'the-bucket',
      [fileEntry['s3KeyParameter'] as string]: `assets/||${FILE_HASH}.txt`,
      [fileEntry['artifactHashParameter'] as string]: FILE_HASH,
    });
  });

  it('prefixes assets/<id>/ when the id differs from the source hash', () => {
    const plan = buildLegacyAssetPlan([{ ...zipEntry, id: 'custom-id' }], {
      fileBucket: 'b',
      accountId: ACCOUNT,
      region: REGION,
    });
    expect(Object.values(plan.manifest.files[ZIP_HASH]!.destinations)[0]!.objectKey).toBe(
      `assets/custom-id/${ZIP_HASH}.zip`
    );
    expect(plan.parameters[zipEntry['s3KeyParameter'] as string]).toBe(
      `assets/custom-id/||${ZIP_HASH}.zip`
    );
  });

  it('maps a modern container-image entry to its repository and tag, binding no parameter', () => {
    const plan = buildLegacyAssetPlan(
      [
        {
          packaging: 'container-image',
          id: 'img',
          path: 'asset.img',
          sourceHash: 'img',
          repositoryName: 'aws-cdk/assets',
          imageTag: 'img',
          buildArgs: { A: '1' },
          file: 'Dockerfile.x',
          platform: 'linux/arm64',
        },
      ],
      { fileBucket: undefined, accountId: ACCOUNT, region: REGION }
    );
    expect(plan.manifest.dockerImages['img']).toEqual({
      displayName: 'img',
      source: {
        directory: 'asset.img',
        dockerBuildArgs: { A: '1' },
        dockerFile: 'Dockerfile.x',
        platform: 'linux/arm64',
      },
      destinations: {
        'legacy-synthesizer': { repositoryName: 'aws-cdk/assets', imageTag: 'img', region: REGION },
      },
    });
    expect(plan.parameters).toEqual({});
    expect([...plan.repositoriesToEnsure]).toEqual(['aws-cdk/assets']);
  });

  it('binds imageNameParameter to the repository URI, defaulting repo and tag like the CLI', () => {
    const plan = buildLegacyAssetPlan(
      [
        {
          packaging: 'container-image',
          id: 'My:Image/x',
          path: 'asset.x',
          sourceHash: 'abc',
          imageNameParameter: 'AssetParametersImageName',
        },
      ],
      { fileBucket: undefined, accountId: ACCOUNT, region: 'cn-north-1' }
    );
    expect(plan.parameters).toEqual({
      AssetParametersImageName: `${ACCOUNT}.dkr.ecr.cn-north-1.amazonaws.com.cn/cdk/my-image-x:abc`,
    });
  });

  it('refuses an image entry with neither imageNameParameter nor repositoryName + imageTag', () => {
    expect(() =>
      buildLegacyAssetPlan(
        [{ packaging: 'container-image', id: 'i', path: 'p', sourceHash: 'h', repositoryName: 'r' }],
        { fileBucket: undefined, accountId: ACCOUNT, region: REGION }
      )
    ).toThrow(/"repositoryName" and "imageTag" are required/);
  });

  it('refuses an unknown packaging and a file entry missing a parameter name', () => {
    expect(() =>
      buildLegacyAssetPlan([{ packaging: 'tarball', id: 'x' }], {
        fileBucket: 'b',
        accountId: ACCOUNT,
        region: REGION,
      })
    ).toThrow(/Unsupported packaging type: tarball/);
    const { s3KeyParameter: _dropped, ...noKey } = zipEntry as unknown as Record<string, unknown>;
    expect(() =>
      buildLegacyAssetPlan([noKey as LegacyAssetEntry], {
        fileBucket: 'b',
        accountId: ACCOUNT,
        region: REGION,
      })
    ).toThrow(/s3KeyParameter/);
  });
});

describe('bindLegacyAssetParameters', () => {
  it('sets each declared parameter Default, ignores undeclared names, and the template resolves', async () => {
    const template = legacyTemplate();
    const resolver = new IntrinsicFunctionResolver();
    // The issue's failure, before anything is bound.
    await expect(resolver.resolveParameters(template, undefined)).rejects.toThrow(
      /is required but no value was provided and no default exists/
    );
    const plan = buildLegacyAssetPlan([zipEntry, fileEntry], {
      fileBucket: 'the-bucket',
      accountId: ACCOUNT,
      region: REGION,
    });
    expect(bindLegacyAssetParameters(template, { ...plan.parameters, Undeclared: 'x' })).toBe(6);
    expect(template.Parameters!['Undeclared']).toBeUndefined();

    const parameters = await resolver.resolveParameters(template, undefined);
    const code = await resolver.resolve(template.Resources['Fn']!.Properties!['Code'], {
      template,
      resources: {},
      parameters,
    } as never);
    expect(code).toEqual({ S3Bucket: 'the-bucket', S3Key: `assets/${ZIP_HASH}.zip` });
  });
});

describe('prepareLegacyStackAssets', () => {
  const stack = () => ({
    stackName: 'Legacy',
    template: legacyTemplate(),
    legacyAssets: { entries: [zipEntry, fileEntry], assemblyDir: '/cdk.out' },
  });

  it('is a no-op for a stack without legacy entries', async () => {
    const plain = { stackName: 'S', template: legacyTemplate() };
    expect(
      await prepareLegacyStackAssets(plain, {
        assetMode: { mode: 'legacy' },
        accountId: ACCOUNT,
        region: REGION,
      })
    ).toBeUndefined();
    expect(mockCfnSend).not.toHaveBeenCalled();
  });

  it('names cdkd asset storage in cdkd-assets mode, with no CloudFormation call', async () => {
    const s = stack();
    const plan = await prepareLegacyStackAssets(s, {
      assetMode: { mode: 'cdkd-assets', marker },
      accountId: ACCOUNT,
      region: REGION,
    });
    expect(mockCfnSend).not.toHaveBeenCalled();
    // Root content-addressed keys in cdkd storage (what `cdkd gc` recognises).
    expect(Object.values(plan!.manifest.files[ZIP_HASH]!.destinations)[0]).toMatchObject({
      bucketName: marker.assetBucket,
      objectKey: `${ZIP_HASH}.zip`,
    });
    expect(s.template.Parameters![zipEntry.s3KeyParameter]!.Default).toBe(`||${ZIP_HASH}.zip`);
    expect(s.template.Parameters![zipEntry['s3BucketParameter'] as string]!.Default).toBe(
      marker.assetBucket
    );
  });

  it("reads the CDKToolkit stack's BucketName in legacy mode, once per region", async () => {
    mockCfnSend.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'BucketName', OutputValue: 'cdk-custom-assets' }] }],
    });
    const s = stack();
    await prepareLegacyStackAssets(s, { assetMode: { mode: 'legacy' }, accountId: ACCOUNT, region: REGION });
    await prepareLegacyStackAssets(stack(), {
      assetMode: { mode: 'legacy' },
      accountId: ACCOUNT,
      region: REGION,
    });
    expect(mockCfnSend).toHaveBeenCalledTimes(1);
    expect(mockCfnSend.mock.calls[0]![0]).toMatchObject({ StackName: 'CDKToolkit' });
    expect(s.template.Parameters![fileEntry['s3BucketParameter'] as string]!.Default).toBe(
      'cdk-custom-assets'
    );
  });

  it('names cdk bootstrap and cdkd bootstrap when the toolkit stack is missing', async () => {
    mockCfnSend.mockRejectedValue(
      Object.assign(new Error('Stack with id CDKToolkit does not exist'), { name: 'ValidationError' })
    );
    await expect(
      prepareLegacyStackAssets(stack(), {
        assetMode: { mode: 'legacy' },
        accountId: ACCOUNT,
        region: REGION,
      })
    ).rejects.toThrow(/cdk bootstrap aws:\/\/123456789012\/us-east-1.*cdkd bootstrap/);
  });

  it('does not memoize a failed toolkit lookup: the next stack asks again', async () => {
    mockCfnSend.mockRejectedValueOnce(new Error('Throttling: Rate exceeded'));
    mockCfnSend.mockResolvedValueOnce({
      Stacks: [{ Outputs: [{ OutputKey: 'BucketName', OutputValue: 'after-retry' }] }],
    });
    const opts = { assetMode: { mode: 'legacy' } as const, accountId: ACCOUNT, region: REGION };
    await expect(prepareLegacyStackAssets(stack(), opts)).rejects.toThrow(/Throttling/);
    const s = stack();
    await prepareLegacyStackAssets(s, opts);
    expect(mockCfnSend).toHaveBeenCalledTimes(2);
    expect(s.template.Parameters![zipEntry.s3BucketParameter]!.Default).toBe('after-retry');
  });

  it('resolves no asset mode for a stack whose only legacy assets are images', async () => {
    const assetMode = vi.fn();
    const plan = await prepareLegacyStackAssets(
      {
        stackName: 'Img',
        template: { Resources: {} },
        legacyAssets: {
          assemblyDir: '/x',
          entries: [
            {
              packaging: 'container-image',
              id: 'i',
              path: 'asset.i',
              sourceHash: 'i',
              repositoryName: 'aws-cdk/assets',
              imageTag: 'i',
            },
          ],
        },
      },
      { assetMode, accountId: ACCOUNT, region: REGION }
    );
    expect(assetMode).not.toHaveBeenCalled();
    expect(plan!.recognizedImageDestinations.size).toBe(1);
  });

  it('refuses a stack that carries a publishable asset manifest as well', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-both-'));
    const manifestPath = join(dir, 'S.assets.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: '1',
        files: {
          h: {
            displayName: 'h',
            source: { path: 'asset.h', packaging: 'zip' },
            destinations: { d: { bucketName: 'b', objectKey: 'h.zip' } },
          },
        },
        dockerImages: {},
      })
    );
    await expect(
      prepareLegacyStackAssets(
        { ...stack(), assetManifestPath: manifestPath },
        { assetMode: { mode: 'cdkd-assets', marker }, accountId: ACCOUNT, region: REGION }
      )
    ).rejects.toThrow(/both an asset manifest and LegacyStackSynthesizer asset metadata/);
  });
});

describe('createLegacyAssetParameterBinder', () => {
  it('binds from the shared context, and an override mode wins over the region mode', async () => {
    mockCfnSend.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'BucketName', OutputValue: 'toolkit-bucket' }] }],
    });
    const resolveMode = vi.fn().mockResolvedValue({ mode: 'cdkd-assets', marker });
    const bind = createLegacyAssetParameterBinder({
      accountId: () => Promise.resolve(ACCOUNT),
      resolveMode,
    });
    const live = { stackName: 'L', template: legacyTemplate(), legacyAssets: { entries: [zipEntry], assemblyDir: '/x' } };
    expect(await bind(live, REGION)).toEqual({ mode: 'cdkd-assets', marker });
    expect(live.template.Parameters![zipEntry['s3BucketParameter'] as string]!.Default).toBe(
      marker.assetBucket
    );
    const snapshot = { ...live, template: legacyTemplate() };
    await bind(snapshot, REGION, { assetMode: { mode: 'legacy' } });
    expect(snapshot.template.Parameters![zipEntry['s3BucketParameter'] as string]!.Default).toBe(
      'toolkit-bucket'
    );
    expect(resolveMode).toHaveBeenCalledTimes(1);
    // A stack without legacy entries asks nothing.
    expect(await bind({ stackName: 'M', template: legacyTemplate() }, REGION)).toBeUndefined();
    expect(resolveMode).toHaveBeenCalledTimes(1);
  });
});

describe('AssemblyReader: aws:cdk:asset metadata', () => {
  it('collects the entries from the additionalMetadataFile side file into StackInfo.legacyAssets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-assembly-'));
    mkdirSync(join(dir, `asset.${ZIP_HASH}`));
    writeFileSync(join(dir, 'Legacy.template.json'), JSON.stringify(legacyTemplate()));
    writeFileSync(
      join(dir, 'Legacy.metadata.json'),
      JSON.stringify({
        '/Legacy': [
          { type: 'aws:cdk:asset', data: zipEntry },
          { type: 'aws:cdk:asset', data: fileEntry },
          { type: 'aws:cdk:warning', data: 'w' },
        ],
        '/Legacy/Fn/Resource': [{ type: 'aws:cdk:logicalId', data: 'Fn' }],
      })
    );
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '55.0.0',
        artifacts: {
          Legacy: {
            type: 'aws:cloudformation:stack',
            environment: 'aws://123456789012/us-east-1',
            properties: { templateFile: 'Legacy.template.json' },
            additionalMetadataFile: 'Legacy.metadata.json',
          },
        },
      })
    );
    const reader = new AssemblyReader();
    const [info] = reader.getAllStacks(dir, reader.readManifest(dir));
    expect(info!.assetManifestPath).toBeUndefined();
    expect(info!.legacyAssets).toEqual({ entries: [zipEntry, fileEntry], assemblyDir: dir });
    expect(info!.messages).toEqual([{ level: 'warning', path: '/Legacy', message: 'w' }]);
  });

  it('leaves legacyAssets unset on a stack without the entries', () => {
    expect(
      legacyAssetEntriesFromMetadata({ '/S': [{ type: 'aws:cdk:logicalId', data: 'X' }] })
    ).toEqual([]);
  });
});

describe('lookupCdkToolkitBucket', () => {
  it('wraps an error other than a missing stack, naming the stack and region', async () => {
    mockCfnSend.mockRejectedValueOnce(
      Object.assign(new Error('User is not authorized to perform: DescribeStacks'), {
        name: 'AccessDenied',
      })
    );
    const failure = lookupCdkToolkitBucket(REGION, ACCOUNT);
    await expect(failure).rejects.toThrow(/Could not read the CDKToolkit stack in us-east-1.*not authorized/);
    await expect(failure).rejects.not.toBeInstanceOf(CdkToolkitBucketMissingError);
  });

  it('refuses a toolkit stack without a BucketName output', async () => {
    mockCfnSend.mockResolvedValueOnce({ Stacks: [{ Outputs: [{ OutputKey: 'Other' }] }] });
    await expect(lookupCdkToolkitBucket(REGION, ACCOUNT)).rejects.toThrow(
      /needs the CDKToolkit stack's asset bucket in us-east-1, and none was found/
    );
    mockCfnSend.mockRejectedValueOnce(new Error('Stack with id CDKToolkit does not exist'));
    await expect(lookupCdkToolkitBucket(REGION, ACCOUNT)).rejects.toBeInstanceOf(
      CdkToolkitBucketMissingError
    );
  });
});

describe('bindLegacyStackAssetParameters with the real lazy context', () => {
  it('binds the CDK toolkit bucket under useCdkBootstrapAssets, reading no marker', async () => {
    mockCfnSend.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'BucketName', OutputValue: 'pinned-toolkit' }] }],
    });
    const getState = vi.fn();
    const t = legacyTemplate();
    await bindLegacyStackAssetParameters(
      { stackName: 'L', template: t, legacyAssets: { entries: [zipEntry], assemblyDir: '/x' } },
      REGION,
      { stateBackend: { getState } as never, stsRegion: REGION, useCdkBootstrapAssets: true }
    );
    expect(t.Parameters![zipEntry.s3BucketParameter]!.Default).toBe('pinned-toolkit');
    expect(t.Parameters![zipEntry.s3KeyParameter]!.Default).toBe(`assets/||${ZIP_HASH}.zip`);
    expect(getState).not.toHaveBeenCalled();
  });
});

describe('AssemblyReader: inline aws:cdk:asset metadata', () => {
  it('reads entries from the artifact metadata in manifest.json too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-inline-'));
    writeFileSync(join(dir, 'Legacy.template.json'), JSON.stringify(legacyTemplate()));
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '55.0.0',
        artifacts: {
          Legacy: {
            type: 'aws:cloudformation:stack',
            environment: 'aws://123456789012/us-east-1',
            properties: { templateFile: 'Legacy.template.json' },
            metadata: { '/Legacy': [{ type: 'aws:cdk:asset', data: fileEntry }] },
          },
        },
      })
    );
    const reader = new AssemblyReader();
    const [info] = reader.getAllStacks(dir, reader.readManifest(dir));
    expect(info!.legacyAssets).toEqual({ entries: [fileEntry], assemblyDir: dir });
  });
});
