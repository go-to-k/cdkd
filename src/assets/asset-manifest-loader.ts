import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import type { AssetManifest, FileAsset } from '../types/assets.js';
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

      this.logger.info(
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
