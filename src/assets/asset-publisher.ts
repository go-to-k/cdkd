import { readFileSync } from 'node:fs';
import { FileAssetPublisher } from './file-asset-publisher.js';
import { DockerAssetPublisher } from './docker-asset-publisher.js';
import type { AssetManifest, FileAsset, DockerImageAsset } from '../types/assets.js';
import { WorkGraph, type WorkNode } from '../deployment/work-graph.js';
import { getLogger } from '../utils/logger.js';
import { AssetError } from '../utils/error-handler.js';

/**
 * Data attached to a file asset-publish node
 */
export interface FileAssetNodeData {
  kind: 'file';
  hash: string;
  asset: FileAsset;
  cdkOutputDir: string;
  accountId: string;
  region: string;
  profile?: string;
}

/**
 * Data attached to a Docker asset-build node
 */
export interface DockerBuildNodeData {
  kind: 'docker-build';
  hash: string;
  asset: DockerImageAsset;
  cdkOutputDir: string;
  localTag: string;
}

/**
 * Data attached to a Docker asset-publish node
 */
export interface DockerPublishNodeData {
  kind: 'docker-publish';
  asset: DockerImageAsset;
  accountId: string;
  region: string;
  localTag: string;
}

export type AssetNodeData = FileAssetNodeData | DockerBuildNodeData | DockerPublishNodeData;

/**
 * Asset publishing options
 */
export interface AssetPublisherOptions {
  /** AWS profile to use */
  profile?: string;

  /** AWS region */
  region?: string;

  /** AWS account ID */
  accountId?: string;

  /** Concurrency for asset publishing (S3 uploads + ECR push). Default: 8 */
  assetPublishConcurrency?: number;

  /** Concurrency for Docker image builds. Default: 4 */
  imageBuildConcurrency?: number;
}

/**
 * Asset publisher
 *
 * Orchestrates file and Docker image asset publishing via WorkGraph.
 * - File assets: single asset-publish node (S3 upload)
 * - Docker assets: asset-build node → asset-publish node (build then push)
 */
export class AssetPublisher {
  private logger = getLogger().child('AssetPublisher');
  private filePublisher = new FileAssetPublisher();
  private dockerPublisher = new DockerAssetPublisher();

  /**
   * Add asset nodes from a manifest to a WorkGraph.
   * Returns the node IDs that stack deploy should depend on.
   */
  addAssetsToGraph(
    graph: WorkGraph,
    manifestPath: string,
    options: { accountId: string; region: string; profile?: string; nodePrefix?: string }
  ): string[] {
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as AssetManifest;
    const cdkOutputDir = manifestPath.replace(/\/[^/]+$/, '');
    const prefix = options.nodePrefix || '';
    const nodeIds: string[] = [];

    // File assets: single publish node
    const fileAssets = Object.entries(manifest.files || {}).filter(
      ([, asset]) =>
        !asset.source.path.endsWith('.json') && !asset.source.path.endsWith('.template.json')
    );
    for (const [hash, asset] of fileAssets) {
      const nodeId = `asset-publish:${prefix}file:${hash}`;
      graph.addNode({
        id: nodeId,
        type: 'asset-publish',
        dependencies: new Set(),
        state: 'pending',
        data: {
          kind: 'file',
          hash,
          asset,
          cdkOutputDir,
          accountId: options.accountId,
          region: options.region,
          ...(options.profile && { profile: options.profile }),
        } satisfies FileAssetNodeData,
      });
      nodeIds.push(nodeId);
    }

    // Docker assets: build node → publish node
    for (const [hash, asset] of Object.entries(manifest.dockerImages || {})) {
      const localTag = `cdkd-asset-${hash}`;
      const buildNodeId = `asset-build:${prefix}docker:${hash}`;
      const publishNodeId = `asset-publish:${prefix}docker:${hash}`;

      graph.addNode({
        id: buildNodeId,
        type: 'asset-build',
        dependencies: new Set(),
        state: 'pending',
        data: {
          kind: 'docker-build',
          hash,
          asset,
          cdkOutputDir,
          localTag,
        } satisfies DockerBuildNodeData,
      });

      graph.addNode({
        id: publishNodeId,
        type: 'asset-publish',
        dependencies: new Set([buildNodeId]),
        state: 'pending',
        data: {
          kind: 'docker-publish',
          asset,
          accountId: options.accountId,
          region: options.region,
          localTag,
        } satisfies DockerPublishNodeData,
      });

      // Stack depends on the publish node (not build)
      nodeIds.push(publishNodeId);
    }

    this.logger.debug(
      `Added ${fileAssets.length} file + ${Object.keys(manifest.dockerImages || {}).length} docker asset(s) to graph`
    );

    return nodeIds;
  }

  /**
   * Execute an asset node (build or publish)
   */
  async executeNode(node: WorkNode): Promise<void> {
    const data = node.data as AssetNodeData;

    if (data.kind === 'file') {
      await this.filePublisher.publish(
        data.hash,
        data.asset,
        data.cdkOutputDir,
        data.accountId,
        data.region,
        data.profile
      );
    } else if (data.kind === 'docker-build') {
      await this.dockerPublisher.build(data.asset, data.cdkOutputDir, data.localTag);
    } else if (data.kind === 'docker-publish') {
      await this.dockerPublisher.push(data.asset, data.accountId, data.region, data.localTag);
    }

    this.logger.debug(`✅ ${node.id}`);
  }

  /**
   * Publish assets from manifest file (standalone, uses WorkGraph internally)
   */
  async publishFromManifest(
    manifestPath: string,
    options: AssetPublisherOptions = {}
  ): Promise<void> {
    try {
      this.logger.debug('Loading asset manifest:', manifestPath);

      const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
      let accountId = options.accountId;

      if (!accountId) {
        const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
        const stsClient = new STSClient({ region });
        const identity = await stsClient.send(new GetCallerIdentityCommand({}));
        accountId = identity.Account!;
        stsClient.destroy();
      }

      const graph = new WorkGraph();
      const nodeIds = this.addAssetsToGraph(graph, manifestPath, {
        accountId,
        region,
        ...(options.profile && { profile: options.profile }),
      });

      if (nodeIds.length === 0) {
        this.logger.debug('No assets to publish');
        return;
      }

      await graph.execute(
        {
          'asset-build': options.imageBuildConcurrency ?? 4,
          'asset-publish': options.assetPublishConcurrency ?? 8,
          stack: 0,
        },
        (node) => this.executeNode(node)
      );

      this.logger.debug('✅ All assets published successfully');
    } catch (error) {
      if (error instanceof AssetError) {
        throw error;
      }
      const err = error as Record<string, unknown>;
      const message = String(err['message'] || err['name'] || error);
      const code = String(err['Code'] || err['code'] || err['name'] || '');
      const detail = code ? `${code}: ${message}` : message;
      throw new AssetError(
        `Asset publishing failed: ${detail}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if assets need to be published
   */
  hasAssets(manifestPath: string): boolean {
    try {
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as AssetManifest;
      const fileCount = Object.keys(manifest.files || {}).length;
      const dockerCount = Object.keys(manifest.dockerImages || {}).length;
      return fileCount + dockerCount > 0;
    } catch {
      this.logger.warn('Failed to check assets');
      return false;
    }
  }
}
