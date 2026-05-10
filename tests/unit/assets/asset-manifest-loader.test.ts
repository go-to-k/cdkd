import { describe, expect, it } from 'vitest';
import { getDockerImageBySourceHash } from '../../../src/assets/asset-manifest-loader.js';
import type { AssetManifest, DockerImageAsset } from '../../../src/types/assets.js';

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
