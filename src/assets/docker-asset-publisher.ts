import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ECRClient,
  GetAuthorizationTokenCommand,
  DescribeImagesCommand,
} from '@aws-sdk/client-ecr';
import type { DockerImageAsset } from '../types/assets.js';
import { getLogger } from '../utils/logger.js';
import { AssetError } from '../utils/error-handler.js';

const execFileAsync = promisify(execFile);

/**
 * Publishes Docker image assets to ECR
 *
 * Handles:
 * - Placeholder resolution
 * - Existence check (skip if already pushed)
 * - docker build with Dockerfile, build args, target
 * - ECR authentication
 * - docker tag + docker push
 */
export class DockerAssetPublisher {
  private logger = getLogger().child('DockerAssetPublisher');

  /**
   * Publish a Docker image asset to ECR
   */
  async publish(
    assetHash: string,
    asset: DockerImageAsset,
    cdkOutputDir: string,
    accountId: string,
    region: string
  ): Promise<void> {
    for (const [, dest] of Object.entries(asset.destinations)) {
      const repositoryName = this.resolvePlaceholders(dest.repositoryName, accountId, region);
      const imageTag = this.resolvePlaceholders(dest.imageTag, accountId, region);
      const destRegion = dest.region
        ? this.resolvePlaceholders(dest.region, accountId, region)
        : region;

      const ecrUri = `${accountId}.dkr.ecr.${destRegion}.amazonaws.com/${repositoryName}:${imageTag}`;

      this.logger.debug(`Publishing Docker image ${asset.displayName || assetHash} → ${ecrUri}`);

      const client = new ECRClient({ region: destRegion });

      try {
        // Check if image already exists
        if (await this.imageExists(client, repositoryName, imageTag)) {
          this.logger.debug(`Image already exists, skipping: ${ecrUri}`);
          continue;
        }

        // Build Docker image
        const localTag = `cdkd-asset-${assetHash}`;
        await this.buildImage(asset, cdkOutputDir, localTag);

        // Authenticate with ECR
        await this.ecrLogin(client, accountId, destRegion);

        // Tag and push
        const fullUri = `${accountId}.dkr.ecr.${destRegion}.amazonaws.com/${repositoryName}:${imageTag}`;
        await this.tagImage(localTag, fullUri);
        await this.pushImage(fullUri);

        this.logger.debug(`✅ Published: ${ecrUri}`);
      } finally {
        client.destroy();
      }
    }
  }

  /**
   * Build a Docker image (public, used by WorkGraph asset-build nodes)
   */
  async build(asset: DockerImageAsset, cdkOutputDir: string, localTag: string): Promise<void> {
    await this.buildImage(asset, cdkOutputDir, localTag);
  }

  /**
   * Push a pre-built Docker image to ECR (public, used by WorkGraph asset-publish nodes)
   */
  async push(
    asset: DockerImageAsset,
    accountId: string,
    region: string,
    localTag: string
  ): Promise<void> {
    for (const [, dest] of Object.entries(asset.destinations)) {
      const repositoryName = this.resolvePlaceholders(dest.repositoryName, accountId, region);
      const imageTag = this.resolvePlaceholders(dest.imageTag, accountId, region);
      const destRegion = dest.region
        ? this.resolvePlaceholders(dest.region, accountId, region)
        : region;

      const ecrUri = `${accountId}.dkr.ecr.${destRegion}.amazonaws.com/${repositoryName}:${imageTag}`;

      const client = new ECRClient({ region: destRegion });

      try {
        if (await this.imageExists(client, repositoryName, imageTag)) {
          this.logger.debug(`Image already exists, skipping: ${ecrUri}`);
          continue;
        }

        await this.ecrLogin(client, accountId, destRegion);

        const fullUri = `${accountId}.dkr.ecr.${destRegion}.amazonaws.com/${repositoryName}:${imageTag}`;
        await this.tagImage(localTag, fullUri);
        await this.pushImage(fullUri);

        this.logger.debug(`✅ Published: ${ecrUri}`);
      } finally {
        client.destroy();
      }
    }
  }

  /**
   * Check if image exists in ECR
   */
  private async imageExists(
    client: ECRClient,
    repositoryName: string,
    imageTag: string
  ): Promise<boolean> {
    try {
      const response = await client.send(
        new DescribeImagesCommand({
          repositoryName,
          imageIds: [{ imageTag }],
        })
      );
      return (response.imageDetails?.length ?? 0) > 0;
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'ImageNotFoundException' || err.name === 'RepositoryNotFoundException') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Build Docker image
   */
  private async buildImage(
    asset: DockerImageAsset,
    cdkOutputDir: string,
    tag: string
  ): Promise<void> {
    const args: string[] = ['build', '-t', tag];

    // Dockerfile
    if (asset.source.dockerFile) {
      args.push('-f', asset.source.dockerFile);
    }

    // Build args
    if (asset.source.dockerBuildArgs) {
      for (const [key, value] of Object.entries(asset.source.dockerBuildArgs)) {
        args.push('--build-arg', `${key}=${value}`);
      }
    }

    // Build target
    if (asset.source.dockerBuildTarget) {
      args.push('--target', asset.source.dockerBuildTarget);
    }

    // Build outputs
    if (asset.source.dockerOutputs) {
      for (const output of asset.source.dockerOutputs) {
        args.push('--output', output);
      }
    }

    // Context directory
    const contextDir = `${cdkOutputDir}/${asset.source.directory}`;
    args.push(contextDir);

    this.logger.debug(`docker ${args.join(' ')}`);

    try {
      await execFileAsync('docker', args, {
        maxBuffer: 50 * 1024 * 1024, // 50MB for build output
      });
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new AssetError(`Docker build failed: ${err.stderr || err.message || String(error)}`);
    }
  }

  /**
   * Authenticate with ECR
   */
  private async ecrLogin(client: ECRClient, accountId: string, region: string): Promise<void> {
    const response = await client.send(new GetAuthorizationTokenCommand({}));
    const authData = response.authorizationData?.[0];

    if (!authData?.authorizationToken) {
      throw new AssetError('Failed to get ECR authorization token');
    }

    const token = Buffer.from(authData.authorizationToken, 'base64').toString();
    const [username, password] = token.split(':');
    const endpoint =
      authData.proxyEndpoint || `https://${accountId}.dkr.ecr.${region}.amazonaws.com`;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'docker',
        ['login', '--username', username!, '--password-stdin', endpoint],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      let stderr = '';
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new AssetError(`ECR login failed: ${stderr.trim()}`));
        }
      });

      proc.on('error', (err) => {
        reject(new AssetError(`ECR login failed: ${err.message}`));
      });

      // Write password to stdin and close
      proc.stdin?.write(password);
      proc.stdin?.end();
    });
  }

  /**
   * Tag Docker image
   */
  private async tagImage(source: string, target: string): Promise<void> {
    await execFileAsync('docker', ['tag', source, target]);
  }

  /**
   * Push Docker image
   */
  private async pushImage(uri: string): Promise<void> {
    this.logger.debug(`Pushing: ${uri}`);
    try {
      await execFileAsync('docker', ['push', uri], {
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new AssetError(`Docker push failed: ${err.stderr || err.message || String(error)}`);
    }
  }

  /**
   * Replace placeholders in destination values
   */
  private resolvePlaceholders(
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
