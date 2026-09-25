import { readFileSync } from 'node:fs';
import { isCfnTemplateAssetPath } from './asset-manifest-loader.js';
import { FileAssetPublisher } from './file-asset-publisher.js';
import { DockerAssetPublisher } from './docker-asset-publisher.js';
import {
  flattenAssetPlaceholders,
  isDefaultBootstrapBucketName,
  isDefaultBootstrapRepoName,
  redirectDockerAsset,
  redirectFileAsset,
  type AssetRedirectMap,
} from './asset-redirect.js';
import { warnUnrecognizedAssetDestination } from './manifest-passthrough-warnings.js';
import type { AssetManifest, FileAsset, DockerImageAsset } from '../types/assets.js';
import { WorkGraph, type WorkNode } from '../deployment/work-graph.js';
import { getLogger } from '../utils/logger.js';
import { AssetError } from '../utils/error-handler.js';
import { stringifyValue } from '../utils/stringify.js';
import { ambientClientDefaults } from '../utils/ambient-client-defaults.js';

/**
 * Data attached to a file asset-publish node
 */
export interface FileAssetNodeData {
  kind: 'file';
  hash: string;
  asset: FileAsset;
  /** The manifest's own directory — what `source.path` resolves against. */
  cdkOutputDir: string;
  /** The app's outdir — what it must stay inside (go-to-k/cdkd#3489). */
  assetOutdir: string;
  accountId: string;
  region: string;
}

/**
 * Data attached to a Docker asset-build node
 */
export interface DockerBuildNodeData {
  kind: 'docker-build';
  hash: string;
  asset: DockerImageAsset;
  /** The manifest's own directory — what `source.directory` resolves against. */
  cdkOutputDir: string;
  /** The app's outdir — what it must stay inside (go-to-k/cdkd#3489). */
  assetOutdir: string;
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

  /**
   * §6 asset-location mapping table (issue #1002 PR 2). When present, every
   * default-bootstrap-shaped destination is redirected to the cdkd-owned
   * bucket / ECR repo before the publish nodes are built. `objectKey` /
   * `imageTag` are untouched. Absent in legacy mode — destinations publish
   * verbatim.
   */
  redirect?: AssetRedirectMap;
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
    options: {
      accountId: string;
      region: string;
      profile?: string;
      nodePrefix?: string;
      redirect?: AssetRedirectMap;
      /**
       * The app's outdir. Defaults to the manifest's directory, which is
       * correct for a top-level stack; a STAGE stack must pass the app root
       * or its `../asset.<hash>` paths are refused (go-to-k/cdkd#3489).
       */
      assetOutdir?: string;
    }
  ): string[] {
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as AssetManifest;
    const cdkOutputDir = manifestPath.replace(/\/[^/]+$/, '');
    const assetOutdir = options.assetOutdir ?? cdkOutputDir;
    const prefix = options.nodePrefix || '';
    const redirect = options.redirect;
    const nodeIds: string[] = [];

    // File assets: single publish node
    // Exclude ONLY the CloudFormation template asset(s) — cdkd deploys
    // templates itself. Shared predicate with AssetManifestLoader.getFileAssets
    // so the two file-asset-selection sites cannot drift (see
    // isCfnTemplateAssetPath for why `.template.json`, not a plain `.json`).
    // In cdkd-assets mode (issue #1002 PR 2), each asset's destinations are
    // redirected through the §6 mapping table before the node is built — the
    // same table the template rewrite consumes, so the two cannot diverge.
    const fileAssets = Object.entries(manifest.files || {})
      .filter(([, asset]) => !isCfnTemplateAssetPath(asset.source.path))
      .map(
        ([hash, asset]) => [hash, redirect ? redirectFileAsset(asset, redirect) : asset] as const
      );
    for (const [hash, asset] of fileAssets) {
      // The DESTINATION half of go-to-k/cdkd#3497, judged AFTER the redirect so
      // a cdkd-managed target is silent. Warn, never refuse: a custom
      // bootstrap is a legitimate configuration.
      for (const dest of Object.values(asset.destinations)) {
        // The destination's OWN region, not the deploy region.
        // `buildAssetRedirectMap` deliberately skips a cross-region
        // destination, so it arrives here unrewritten, and judging
        // `cdk-hnb659fds-assets-<acct>-eu-west-1` against `us-east-1` called a
        // perfectly ordinary bootstrap bucket unrecognized.
        // `dest.region` is used UNFLATTENED, and that is self-consistent
        // rather than lucky: the same raw string is both the substitution
        // `flattenAssetPlaceholders` writes in and the literal the shape
        // regex then matches, so a `${AWS::Region}` destination agrees with
        // itself. `buildAssetRedirectMap` flattens it; if this side ever
        // flattens only one of the two, the agreement breaks.
        const destRegion = dest.region ?? options.region;
        const name = flattenAssetPlaceholders(dest.bucketName, options.accountId, destRegion);
        warnUnrecognizedAssetDestination({
          kind: 'bucket',
          name,
          recognized:
            isDefaultBootstrapBucketName(name, options.accountId, destRegion) ||
            // A redirected destination is cdkd's OWN storage: the map's
            // VALUES are the targets it rewrites to.
            (redirect !== undefined && [...redirect.buckets.values()].includes(name)),
        });
      }
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
          assetOutdir,
          accountId: options.accountId,
          region: options.region,
          // No `profile`: `FileAssetPublisher.publish` has no such parameter
          // (go-to-k/cdkd#3532 removed the unused one, whose optional trailing
          // position let a caller bind a profile NAME to the containment
          // bound), so carrying it here would be a field nothing reads.
        } satisfies FileAssetNodeData,
      });
      nodeIds.push(nodeId);
    }

    // Docker assets: build node → publish node
    for (const [hash, rawAsset] of Object.entries(manifest.dockerImages || {})) {
      const asset = redirect ? redirectDockerAsset(rawAsset, redirect) : rawAsset;
      for (const dest of Object.values(asset.destinations)) {
        // `dest.region` unflattened, self-consistently — the same note as the
        // file-asset arm above, repeated rather than cross-referenced because a
        // future edit that flattens only one side would come in HERE, and the
        // reasoning has to be where the edit lands.
        const destRegion = dest.region ?? options.region;
        const name = flattenAssetPlaceholders(dest.repositoryName, options.accountId, destRegion);
        warnUnrecognizedAssetDestination({
          kind: 'repository',
          name,
          recognized:
            isDefaultBootstrapRepoName(name, options.accountId, destRegion) ||
            (redirect !== undefined && [...redirect.repos.values()].includes(name)),
        });
      }
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
          assetOutdir,
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
        data.assetOutdir
      );
    } else if (data.kind === 'docker-build') {
      await this.dockerPublisher.build(
        data.asset,
        data.cdkOutputDir,
        data.localTag,
        data.assetOutdir
      );
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
        const stsClient = new STSClient({ ...ambientClientDefaults(), region });
        const identity = await stsClient.send(new GetCallerIdentityCommand({}));
        accountId = identity.Account!;
        stsClient.destroy();
      }

      const graph = new WorkGraph();
      const nodeIds = this.addAssetsToGraph(graph, manifestPath, {
        accountId,
        region,
        ...(options.profile && { profile: options.profile }),
        ...(options.redirect && { redirect: options.redirect }),
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
      const message = stringifyValue(err['message'] || err['name'] || error);
      const code = stringifyValue(err['Code'] || err['code'] || err['name'] || '');
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
