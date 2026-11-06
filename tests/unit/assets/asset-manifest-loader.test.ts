import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
  isCfnTemplateAssetPath,
} from '../../../src/assets/asset-manifest-loader.js';
import type { AssetManifest, DockerImageAsset, FileAsset } from '../../../src/types/assets.js';

const buildManifest = (
  dockerImages: Record<string, DockerImageAsset>
): AssetManifest => ({
  version: '52.0.0',
  files: {},
  dockerImages,
});

const baseAsset = (directory: string): DockerImageAsset => ({
  displayName: directory,
  source: { directory },
  destinations: {},
});

describe('getDockerImageBySourceHash', () => {
  it('returns the matching asset when the URI tail hash matches a manifest key', () => {
    const manifest = buildManifest({
      abcdef1234567890: baseAsset('asset.abc'),
      ffffffffffffffff: baseAsset('asset.ff'),
    });
    const result = getDockerImageBySourceHash(
      manifest,
      '111111111111.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-x:abcdef1234567890'
    );
    expect(result?.hash).toBe('abcdef1234567890');
    expect(result?.asset.source.directory).toBe('asset.abc');
  });

  it('returns the matching asset for a CDK Fn::Sub-style template body (template not yet rendered)', () => {
    const manifest = buildManifest({
      hashabcd1234: baseAsset('asset.x'),
    });
    // Note: CDK's Fn::Sub body keeps `${AWS::AccountId}` etc. as-is until
    // deploy time. The hash extraction works against the raw template tail
    // because the `:<hash>` is unaffected by upstream substitutions.
    const result = getDockerImageBySourceHash(
      manifest,
      '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}:hashabcd1234'
    );
    expect(result?.hash).toBe('hashabcd1234');
  });

  it('falls back to the single-asset entry when hash extraction misses', () => {
    const manifest = buildManifest({
      onlyOne: baseAsset('asset.solo'),
    });
    const result = getDockerImageBySourceHash(
      manifest,
      'localhost:5000/repo@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );
    expect(result?.hash).toBe('onlyOne');
  });

  it('returns undefined when no manifest entry exists', () => {
    const manifest = buildManifest({});
    expect(getDockerImageBySourceHash(manifest, 'r:abc12345')).toBeUndefined();
  });

  it('returns undefined when 2+ assets and no hash match', () => {
    const manifest = buildManifest({
      a1234567: baseAsset('asset.a'),
      b1234567: baseAsset('asset.b'),
    });
    // The URI tail hash doesn't match either entry, AND there's >1
    // candidate, so the single-asset fallback does not apply.
    const result = getDockerImageBySourceHash(manifest, 'r:cccccccc');
    expect(result).toBeUndefined();
  });

  it('rejects @sha256:<digest> immutable digest pins (no hash to extract)', () => {
    const manifest = buildManifest({
      a1234567: baseAsset('asset.a'),
      b1234567: baseAsset('asset.b'),
    });
    // Digest pins force the single-asset fallback; here it does not apply
    // (>1 asset) so we get undefined.
    const result = getDockerImageBySourceHash(
      manifest,
      'r@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );
    expect(result).toBeUndefined();
  });
});

describe('isCfnTemplateAssetPath', () => {
  it('matches top-level and nested CloudFormation template asset paths only', () => {
    expect(isCfnTemplateAssetPath('MyStack.template.json')).toBe(true);
    expect(isCfnTemplateAssetPath('MyStack.MyNested.nested.template.json')).toBe(true);
    // A legitimate user `.json` file asset is NOT a template.
    expect(isCfnTemplateAssetPath('asset.57e7c7fe.json')).toBe(false);
    expect(isCfnTemplateAssetPath('asset.handler/index.js')).toBe(false);
  });
});

describe('getFileAssets', () => {
  const fileAsset = (path: string): FileAsset => ({
    displayName: path,
    source: { path, packaging: path.endsWith('.json') ? 'file' : 'zip' },
    destinations: {},
  });

  it('publishes non-template .json file assets while excluding template assets', () => {
    const loader = new AssetManifestLoader();
    const manifest: AssetManifest = {
      version: '52.0.0',
      dockerImages: {},
      files: {
        tmpl: fileAsset('MyStack.template.json'),
        nested: fileAsset('MyStack.MyNested.nested.template.json'),
        // A Step Functions DefinitionS3Location ASL document — MUST be published.
        asl: fileAsset('asset.aslhash.json'),
        lambda: fileAsset('asset.lambda/index.js'),
      },
    };

    const result = loader.getFileAssets(manifest);

    expect(new Set(result.keys())).toEqual(new Set(['asl', 'lambda']));
    expect(result.has('tmpl')).toBe(false);
    expect(result.has('nested')).toBe(false);
  });
});

describe('AssetManifestLoader.loadStackManifest (cdkd#5872)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // The layout `cdk synth` writes for a stack inside a `cdk.Stage`: the
  // manifest sits in the nested assembly and is named after the ARTIFACT id
  // (`devlocalApi6B226F7F`), not the stack name (`dev-local-Api`).
  function stageAssembly(): { manifestPath: string; nestedDir: string } {
    const outdir = mkdtempSync(join(tmpdir(), 'cdkd-5872-'));
    dirs.push(outdir);
    const nestedDir = join(outdir, 'assembly-dev-local');
    mkdirSync(nestedDir);
    const manifestPath = join(nestedDir, 'devlocalApi6B226F7F.assets.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: '55.0.0',
        files: {},
        dockerImages: { abc123: { source: { directory: '../asset.abc123' }, destinations: {} } },
      })
    );
    return { manifestPath, nestedDir };
  }

  it('reads a Stage manifest from the file the stack record names', async () => {
    const { manifestPath, nestedDir } = stageAssembly();
    const manifest = await new AssetManifestLoader().loadStackManifest(
      { stackName: 'dev-local-Api', assetManifestPath: manifestPath },
      nestedDir
    );
    expect(Object.keys(manifest?.dockerImages ?? {})).toEqual(['abc123']);
    // The stack-name spelling finds nothing there: the lookup this replaces.
    await expect(
      new AssetManifestLoader().loadManifest(nestedDir, 'dev-local-Api')
    ).resolves.toBeNull();
  });

  it('falls back to <fallbackDir>/<stackName>.assets.json without a manifest path', async () => {
    const { nestedDir } = stageAssembly();
    writeFileSync(
      join(nestedDir, 'Top.assets.json'),
      JSON.stringify({ version: '55.0.0', files: {}, dockerImages: {} })
    );
    const loader = new AssetManifestLoader();
    await expect(loader.loadStackManifest({ stackName: 'Top' }, nestedDir)).resolves.not.toBeNull();
    await expect(
      loader.loadStackManifest({ stackName: 'Absent' }, nestedDir)
    ).resolves.toBeNull();
  });
});
