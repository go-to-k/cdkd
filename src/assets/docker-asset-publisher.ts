import {
  ECRClient,
  GetAuthorizationTokenCommand,
  DescribeImagesCommand,
} from '@aws-sdk/client-ecr';
import type { DockerImageAsset } from '../types/assets.js';
import { runDockerStreaming } from '../utils/docker-cmd.js';
import { getLogger } from '../utils/logger.js';
import { AssetError } from '../utils/error-handler.js';
import { buildDockerImage } from './docker-build.js';

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
   * Build a Docker image (public, used by WorkGraph asset-build nodes).
   *
   * For `directory` source mode the build tags the result as `localTag`
   * directly via `docker build -t`. For `executable` source mode the
   * user-supplied script returns its own tag; cdkd re-tags it to `localTag`
   * via `docker tag` so the downstream `push()` step (which is wired to
   * `localTag` at graph-construction time) keeps working unchanged.
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
   * Build Docker image — delegates to the shared `buildDockerImage`
   * helper so this code path stays in sync with `cdkd local invoke`'s
   * container-Lambda build path. `--platform` is read from the asset
   * manifest's `source.platform` (when set); cdkd does not currently
   * inject a publish-side override.
   *
   * `buildDockerImage` returns the actual local tag. For `directory`
   * source mode that's always `tag`. For `executable` source mode the
   * user's script returns its own tag; we re-tag via `docker tag` so the
   * downstream push step finds the image under the deterministic
   * `cdkd-asset-<hash>` name it expects.
   */
  private async buildImage(
    asset: DockerImageAsset,
    cdkOutputDir: string,
    tag: string
  ): Promise<void> {
    const actualTag = await buildDockerImage(asset, cdkOutputDir, {
      tag,
      wrapError: (stderr) => new AssetError(`Docker build failed: ${stderr}`),
    });
    if (actualTag !== tag) {
      this.logger.debug(`Re-tagging executable-built image '${actualTag}' → '${tag}'`);
      try {
        await this.tagImage(actualTag, tag);
      } catch (err) {
        const e = err as { message?: string };
        throw new AssetError(
          `Docker tag failed re-tagging '${actualTag}' → '${tag}': ${e.message ?? String(err)}`
        );
      }
    }
  }

  /**
   * Authenticate with ECR via `docker login --password-stdin`.
   */
  private async ecrLogin(client: ECRClient, accountId: string, region: string): Promise<void> {
    const response = await client.send(new GetAuthorizationTokenCommand({}));
    const authData = response.authorizationData?.[0];

    if (!authData?.authorizationToken) {
      throw new AssetError('Failed to get ECR authorization token');
    }

    const token = Buffer.from(authData.authorizationToken, 'base64').toString();
    const [username, password] = token.split(':');
    if (!username || password === undefined) {
      throw new AssetError(
        'ECR authorization token has unexpected shape (missing username/password)'
      );
    }
    const endpoint =
      authData.proxyEndpoint || `https://${accountId}.dkr.ecr.${region}.amazonaws.com`;

    try {
      await runDockerStreaming(['login', '--username', username, '--password-stdin', endpoint], {
        input: password,
      });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new AssetError(`ECR login failed: ${e.stderr?.trim() || e.message || String(err)}`);
    }
  }

  /**
   * Tag Docker image
   */
  private async tagImage(source: string, target: string): Promise<void> {
    try {
      await runDockerStreaming(['tag', source, target]);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new AssetError(`Docker tag failed: ${e.stderr?.trim() || e.message || String(err)}`);
    }
  }

  /**
   * Push Docker image. Streams progress to stdout/stderr (via
   * `runDockerStreaming`) when the logger is at debug level, otherwise
   * captures silently and surfaces stderr on non-zero exit.
   */
  private async pushImage(uri: string): Promise<void> {
    this.logger.debug(`Pushing: ${uri}`);
    try {
      await runDockerStreaming(['push', uri]);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new AssetError(`Docker push failed: ${e.stderr?.trim() || e.message || String(err)}`);
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
