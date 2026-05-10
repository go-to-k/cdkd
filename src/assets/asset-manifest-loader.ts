import { readFile } from 'fs/promises';
import { join } from 'path';
import type { AssetManifest, DockerImageAsset, FileAsset } from '../types/assets.js';
import { getLogger } from '../utils/logger.js';

/**
 * Asset manifest loader
 *
 * Loads and parses CDK asset manifests from the CDK output directory
 */
export class AssetManifestLoader {
  private logger = getLogger().child('AssetManifestLoader');

  /**
   * Load asset manifest from CDK output directory
   *
   * @param cdkOutputDir CDK output directory (e.g., "cdk.out")
   * @param stackName Stack name
   * @returns Asset manifest or null if not found
   */
  async loadManifest(cdkOutputDir: string, stackName: string): Promise<AssetManifest | null> {
    const manifestPath = join(cdkOutputDir, `${stackName}.assets.json`);

    try {
      this.logger.debug(`Loading asset manifest from: ${manifestPath}`);
      const content = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as AssetManifest;

      this.logger.debug(
        `Loaded asset manifest: ${Object.keys(manifest.files).length} file assets, ` +
          `${Object.keys(manifest.dockerImages).length} docker image assets`
      );

      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug(`Asset manifest not found: ${manifestPath}`);
        return null;
      }

      throw new Error(
        `Failed to load asset manifest from ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get file assets from manifest (excludes CloudFormation templates)
   *
   * @param manifest Asset manifest
   * @returns Map of asset hash to file asset
   */
  getFileAssets(manifest: AssetManifest): Map<string, FileAsset> {
    const fileAssets = new Map<string, FileAsset>();

    for (const [assetHash, asset] of Object.entries(manifest.files)) {
      // Skip CloudFormation templates (they have .json extension)
      if (asset.source.path.endsWith('.json') || asset.source.path.endsWith('.template.json')) {
        this.logger.debug(`Skipping CloudFormation template asset: ${asset.displayName}`);
        continue;
      }

      fileAssets.set(assetHash, asset);
    }

    this.logger.debug(`Found ${fileAssets.size} file assets (excluding templates)`);
    return fileAssets;
  }

  /**
   * Get asset source path (absolute path)
   *
   * @param cdkOutputDir CDK output directory
   * @param asset File asset
   * @returns Absolute path to asset source
   */
  getAssetSourcePath(cdkOutputDir: string, asset: FileAsset): string {
    return join(cdkOutputDir, asset.source.path);
  }

  /**
   * Resolve asset destination values (replace ${AWS::AccountId}, ${AWS::Region}, etc.)
   *
   * @param value Value with placeholders
   * @param accountId AWS account ID
   * @param region AWS region
   * @param partition AWS partition (default: "aws")
   * @returns Resolved value
   */
  resolveAssetDestinationValue(
    value: string,
    accountId: string,
    region: string,
    partition = 'aws'
  ): string {
    return value
      .replace(/\$\{AWS::AccountId\}/g, accountId)
      .replace(/\$\{AWS::Region\}/g, region)
      .replace(/\$\{AWS::Partition\}/g, partition);
  }
}

/**
 * Look up the docker-image asset that backs a Lambda's `Code.ImageUri`.
 *
 * The CDK template synthesizes `Code.ImageUri` as a `Fn::Sub` whose body
 * references the bootstrap ECR repo and ends in `:<hash>` — that hash is
 * the same key used in `manifest.dockerImages[<hash>]`. cdkd extracts the
 * hash by walking known image-URI shapes; on miss, when the manifest has
 * exactly one Docker image, we fall back to it (single-asset heuristic) so
 * locally-built non-bootstrapped images still work. This is documented as
 * a v1 limitation; immutable digest pins (`@sha256:<digest>`) hit the same
 * fallback path.
 *
 * Returns the `(hash, asset)` pair when matched, or `undefined` when both
 * the regex AND the single-asset fallback miss (typically: 0 docker assets,
 * or 2+ docker assets with no hash match — the caller should treat this as
 * "fall through to the ECR-pull path").
 *
 * Exported as a free function (not a method) so the local-invoke modules
 * can reuse it without depending on the `AssetManifestLoader` instance —
 * the manifest itself is a plain JSON shape.
 */
export function getDockerImageBySourceHash(
  manifest: AssetManifest,
  imageUri: string
): { hash: string; asset: DockerImageAsset } | undefined {
  const dockerImages = manifest.dockerImages ?? {};
  const entries = Object.entries(dockerImages);
  if (entries.length === 0) return undefined;

  // Try to extract the hash from the ImageUri tail. Match `:<hash>` (NOT
  // `@sha256:<digest>` — those are immutable digest pins which never carry
  // the source hash; we fall through to the single-asset heuristic for
  // those). The hash itself is hex-only in CDK's bootstrap layout.
  const hash = extractHashFromImageUri(imageUri);
  if (hash !== undefined) {
    const asset = dockerImages[hash];
    if (asset) {
      return { hash, asset };
    }
  }

  // Single-asset fallback: when the user has exactly one Docker image in
  // the stack, it's almost certainly the one being invoked. Avoids
  // hard-failing on hash-extraction misses that would otherwise be common
  // (digest pins, custom Code.fromAssetImage forms, etc.).
  if (entries.length === 1) {
    const [singleHash, singleAsset] = entries[0]!;
    return { hash: singleHash, asset: singleAsset };
  }

  return undefined;
}

/**
 * Extract the source hash from a Lambda `Code.ImageUri` string. CDK's
 * bootstrap layout ends every image URI in `:<hex-hash>`, and that hash
 * is the same key used in the asset manifest's `dockerImages` map.
 *
 * Returns `undefined` for shapes we can't parse (digest pins, missing tag,
 * etc.) — the caller falls back to the single-asset heuristic.
 */
function extractHashFromImageUri(imageUri: string): string | undefined {
  // Reject digest-pinned URIs. `<repo>@sha256:<digest>` carries no hash.
  if (imageUri.includes('@sha256:')) return undefined;

  // Match `:<hex-hash>` at the very end of the URI. `cdk-hnb659fds-container-assets-...:<64-hex>`
  // is the typical shape; we accept any 8+-character hex tail to be lenient.
  const match = /:([a-f0-9]{8,})$/.exec(imageUri);
  return match?.[1];
}
