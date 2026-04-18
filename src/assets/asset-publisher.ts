import { readFileSync } from 'node:fs';
import { FileAssetPublisher } from './file-asset-publisher.js';
import { DockerAssetPublisher } from './docker-asset-publisher.js';
import type { AssetManifest, FileAsset, DockerImageAsset } from '../types/assets.js';
import { WorkGraph, type WorkNode } from '../deployment/work-graph.js';
import { getLogger } from '../utils/logger.js';
import { AssetError } from '../utils/error-handler.js';

/**
 * Data attached to an asset-publish WorkNode
 */
export interface AssetNodeData {
  kind: 'file' | 'docker';
  hash: string;
  asset: FileAsset | DockerImageAsset;
  cdkOutputDir: string;
  accountId: string;
  region: string;
  profile?: string;
}

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

  /**
   * Concurrency for asset publishing.
   * Default: 8
   */
  assetPublishConcurrency?: number;
}

/**
 * Asset publisher
 *
 * Orchestrates file and Docker image asset publishing via WorkGraph.
 * Used both by `deploy` (nodes added to shared graph) and `publish-assets` (standalone).
 */
export class AssetPublisher {
  private logger = getLogger().child('AssetPublisher');
  private filePublisher = new FileAssetPublisher();
  private dockerPublisher = new DockerAssetPublisher();

  /**
   * Add asset-publish nodes from a manifest to a WorkGraph.
   * Returns the node IDs added (for wiring as dependencies).
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

    // File assets
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
        } satisfies AssetNodeData,
      });
      nodeIds.push(nodeId);
    }

    // Docker assets
    for (const [hash, asset] of Object.entries(manifest.dockerImages || {})) {
      const nodeId = `asset-publish:${prefix}docker:${hash}`;
      graph.addNode({
        id: nodeId,
        type: 'asset-publish',
        dependencies: new Set(),
        state: 'pending',
        data: {
          kind: 'docker',
          hash,
          asset,
          cdkOutputDir,
          accountId: options.accountId,
          region: options.region,
          ...(options.profile && { profile: options.profile }),
        } satisfies AssetNodeData,
      });
      nodeIds.push(nodeId);
    }

    this.logger.debug(
      `Added ${fileAssets.length} file + ${Object.keys(manifest.dockerImages || {}).length} docker asset(s) to graph`
    );

    return nodeIds;
  }

  /**
   * Execute an asset-publish node
   */
  async executeNode(node: WorkNode): Promise<void> {
    const data = node.data as AssetNodeData;
    if (data.kind === 'file') {
      await this.filePublisher.publish(
        data.hash,
        data.asset as FileAsset,
        data.cdkOutputDir,
        data.accountId,
        data.region,
        data.profile
      );
    } else {
      await this.dockerPublisher.publish(
        data.hash,
        data.asset as DockerImageAsset,
        data.cdkOutputDir,
        data.accountId,
        data.region,
        data.profile
      );
    }
    this.logger.debug(`✅ Published: ${node.id}`);
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

      // Resolve account and region
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

      const concurrency = options.assetPublishConcurrency ?? 8;
      await graph.execute({ 'asset-publish': concurrency, stack: 0 }, (node) =>
        this.executeNode(node)
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
