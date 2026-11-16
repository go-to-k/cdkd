import { extname } from 'node:path';
import type { AssetManifest, DockerImageAssetSource, FileAsset } from '../types/assets.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { MetadataEntry } from '../types/assembly.js';
import type { AssetMode } from './asset-storage/marker.js';
import { AssetError } from '../utils/error-handler.js';
import { derivePartitionAndUrlSuffix } from '../utils/aws-partition.js';
import { displayIdent } from '../utils/display-safe.js';
import { lookupCdkToolkitBucket } from './cdk-toolkit-bucket.js';
import {
  ASSET_SUPPORT_VERSION,
  getCdkdAssetBucketName,
  getCdkdContainerRepoName,
} from './asset-storage/names.js';
import { nullPrototypeRecord } from '../utils/own-keys.js';
import { injectiveKey } from '../state/record-keys.js';
import {
  createLazyAssetModeContext,
  loadPublishableAssetManifest,
  type LazyAssetModeContext,
  type LazyAssetModeOptions,
} from './asset-redirect.js';
import type { StackInfo } from '../synthesis/assembly-reader.js';

/**
 * Assets of a stack synthesized with `LegacyStackSynthesizer` (issue #6421).
 *
 * That synthesizer writes no `<Stack>.assets.json`. It describes each asset
 * only as an `aws:cdk:asset` metadata entry and adds CloudFormation
 * parameters with no default (`AssetParameters<hash>S3Bucket…` /
 * `…S3VersionKey…` / `…ArtifactHash…` per file asset, `…ImageName…` per
 * image asset of an older aws-cdk-lib) that the deploying tool must supply.
 *
 * The AWS CDK CLI (`toolkit-lib` `api/deployments/assets.ts`,
 * `addMetadataAssetsToManifest`) builds an IN-MEMORY asset manifest from
 * those entries, publishes it through its normal path and passes the asset
 * coordinates as parameter values. This module is that logic, ported: the
 * manifest it builds goes through `AssetPublisher` like any other, and the
 * parameter values are bound into the in-memory template as `Default`s
 * ({@link bindLegacyAssetParameters}), so every command that resolves the
 * template sees them without a new parameter channel.
 */

/** The one destination id of every in-memory legacy asset (an id, never parsed). */
const LEGACY_DESTINATION_ID = 'legacy-synthesizer';

/** The `aws:cdk:asset` metadata entry type. */
export const LEGACY_ASSET_METADATA_TYPE = 'aws:cdk:asset';

/** `cxapi.ASSET_PREFIX_SEPARATOR` — splits the S3 key parameter into prefix and name. */
export const ASSET_PREFIX_SEPARATOR = '||';

/** The `data` of a file / zip `aws:cdk:asset` entry. */
export interface LegacyFileAssetEntry {
  packaging: 'file' | 'zip';
  id: string;
  path: string;
  sourceHash: string;
  s3BucketParameter: string;
  s3KeyParameter: string;
  artifactHashParameter: string;
}

/** The `data` of a container-image `aws:cdk:asset` entry. */
export interface LegacyContainerImageAssetEntry {
  packaging: 'container-image';
  id: string;
  path: string;
  sourceHash: string;
  imageNameParameter?: string;
  repositoryName?: string;
  imageTag?: string;
  buildArgs?: Record<string, string>;
  buildContexts?: Record<string, string>;
  buildSecrets?: Record<string, string>;
  buildSsh?: string;
  target?: string;
  file?: string;
  networkMode?: string;
  platform?: string;
  outputs?: string[];
  cacheFrom?: DockerImageAssetSource['cacheFrom'];
  cacheTo?: DockerImageAssetSource['cacheTo'];
  cacheDisabled?: boolean;
}

/** One `aws:cdk:asset` entry; `packaging` is validated when a plan is built. */
export type LegacyAssetEntry =
  | LegacyFileAssetEntry
  | LegacyContainerImageAssetEntry
  | ({ packaging: string } & Record<string, unknown>);

/** A stack's legacy assets plus the directory their `path`s resolve against. */
export interface LegacyStackAssets {
  entries: LegacyAssetEntry[];
  /** The assembly directory holding the stack's `manifest.json`. */
  assemblyDir: string;
}

/**
 * Every `aws:cdk:asset` entry in a stack's merged metadata (inline
 * `metadata` plus the `additionalMetadataFile` side file), at any construct
 * path — the CLI reads `CloudFormationStackArtifact.assets`, which is the
 * same whole-stack search. An entry whose `data` is not an object is skipped
 * here and cannot reach a plan.
 */
export function legacyAssetEntriesFromMetadata(
  metadata: Record<string, MetadataEntry[]>
): LegacyAssetEntry[] {
  const entries: LegacyAssetEntry[] = [];
  for (const list of Object.values(metadata)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry?.type !== LEGACY_ASSET_METADATA_TYPE) continue;
      const data = entry.data as unknown;
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
      entries.push(data as LegacyAssetEntry);
    }
  }
  return entries;
}

/** Whether any entry is a file / zip asset, i.e. whether a bucket must be resolved. */
export function legacyEntriesNeedFileBucket(entries: readonly LegacyAssetEntry[]): boolean {
  return entries.some((e) => e.packaging === 'file' || e.packaging === 'zip');
}

/** What a legacy-asset plan publishes and what it binds. */
export interface LegacyAssetPlan {
  /** In-memory asset manifest: destinations are concrete, never placeholders. */
  manifest: AssetManifest;
  /** Template parameter name → value, as the CDK CLI supplies them. */
  parameters: Record<string, string>;
  /** Repositories the publish must create when missing (the CLI creates them). */
  repositoriesToEnsure: Set<string>;
  /**
   * The repositories that are the synthesizer's OWN default — `aws-cdk/assets`
   * with the source hash as tag — and so need no unrecognized-destination
   * warning. A repository or tag the metadata chose otherwise is warned about
   * like a manifest-chosen one.
   */
  recognizedRepositories: Set<string>;
}

/** `LegacyStackSynthesizer`'s default image repository (`ASSETS_ECR_REPOSITORY_NAME`). */
export const LEGACY_DEFAULT_IMAGE_REPOSITORY = 'aws-cdk/assets';

/** An entry's `id` for a message, when it is a string. */
function entryLabel(entry: LegacyAssetEntry): string {
  const id = (entry as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : '<no id>';
}

function requireString(entry: LegacyAssetEntry, field: string): string {
  const value = (entry as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AssetError(
      `Invalid LegacyStackSynthesizer asset metadata: field ${displayIdent(field)} ` +
        `is missing or not a string in asset ${displayIdent(entryLabel(entry))}`
    );
  }
  return value;
}

/**
 * Build the in-memory manifest and the parameter values for a stack's legacy
 * assets — `prepareFileAsset` / `prepareDockerImageAsset` of the CDK CLI.
 *
 * - file / zip: object key `assets/<sourceHash><ext>` (`.zip` for a zip, the
 *   path's own extension otherwise), under `assets/<id>/` when the id is not
 *   the source hash; parameters bucket, `<prefix>||<baseName>`, source hash.
 *   With `rootKeys` (cdkd asset storage) the key is `<sourceHash><ext>` at the
 *   bucket root and the prefix empty: cdkd's own content-addressed layout,
 *   which `cdkd gc`'s content-hash pass recognises wherever a state value
 *   carries it, where a `assets/`-prefixed key is protected only by an exact
 *   match and a key inside an array (a BucketDeployment's
 *   `SourceObjectKeys`) would read as unreferenced. The CDK CLI's layout is
 *   kept in the CDK toolkit bucket, which `cdk gc` owns.
 * - container-image: repository `repositoryName ?? cdk/<id>`, tag
 *   `imageTag ?? sourceHash`; a parameter only when the entry names
 *   `imageNameParameter` (modern aws-cdk-lib bakes the image URI into the
 *   template instead).
 *
 * `fileBucket` is the bucket the objects are published to — already the
 * FINAL one (cdkd asset storage in cdkd-assets mode), so the parameter names
 * the bucket the object actually lands in. Required exactly when
 * {@link legacyEntriesNeedFileBucket} says so.
 */
export function buildLegacyAssetPlan(
  entries: readonly LegacyAssetEntry[],
  target: {
    fileBucket: string | undefined;
    accountId: string;
    region: string;
    /** Content-addressed keys at the bucket root (cdkd asset storage). */
    rootKeys?: boolean;
  }
): LegacyAssetPlan {
  const files = nullPrototypeRecord<FileAsset>();
  const dockerImages: AssetManifest['dockerImages'] = nullPrototypeRecord();
  const parameters = nullPrototypeRecord<string>();
  const repositoriesToEnsure = new Set<string>();
  const recognizedRepositories = new Set<string>();

  for (const entry of entries) {
    switch (entry.packaging) {
      case 'zip':
      case 'file': {
        const id = requireString(entry, 'id');
        const sourceHash = requireString(entry, 'sourceHash');
        const assetPath = requireString(entry, 'path');
        const s3BucketParameter = requireString(entry, 's3BucketParameter');
        const s3KeyParameter = requireString(entry, 's3KeyParameter');
        const artifactHashParameter = requireString(entry, 'artifactHashParameter');
        const bucketName = target.fileBucket;
        if (bucketName === undefined) {
          throw new Error('buildLegacyAssetPlan: a file asset needs fileBucket');
        }
        const extension = entry.packaging === 'zip' ? '.zip' : extname(assetPath);
        const baseName = `${sourceHash}${extension}`;
        const s3Prefix = target.rootKeys ? '' : id === sourceHash ? 'assets/' : `assets/${id}/`;
        files[sourceHash] = {
          displayName: id,
          source: { path: assetPath, packaging: entry.packaging },
          destinations: {
            [LEGACY_DESTINATION_ID]: {
              bucketName,
              objectKey: `${s3Prefix}${baseName}`,
              region: target.region,
            },
          },
        };
        parameters[s3BucketParameter] = bucketName;
        parameters[s3KeyParameter] = `${s3Prefix}${ASSET_PREFIX_SEPARATOR}${baseName}`;
        parameters[artifactHashParameter] = sourceHash;
        break;
      }
      case 'container-image': {
        const image = entry as LegacyContainerImageAssetEntry;
        const id = requireString(entry, 'id');
        const sourceHash = requireString(entry, 'sourceHash');
        const directory = requireString(entry, 'path');
        if (!image.imageNameParameter && (!image.repositoryName || !image.imageTag)) {
          throw new AssetError(
            'Invalid Docker image asset configuration: "repositoryName" and "imageTag" ' +
              `are required when "imageNameParameter" is left out (asset ${displayIdent(id)})`
          );
        }
        const repositoryName =
          image.repositoryName ?? 'cdk/' + id.replace(/[:/]/g, '-').toLowerCase();
        const imageTag = image.imageTag ?? sourceHash;
        const source: DockerImageAssetSource = {
          directory,
          ...(image.buildArgs && { dockerBuildArgs: image.buildArgs }),
          ...(image.buildContexts && { dockerBuildContexts: image.buildContexts }),
          ...(image.buildSecrets && { dockerBuildSecrets: image.buildSecrets }),
          ...(image.buildSsh && { dockerBuildSsh: image.buildSsh }),
          ...(image.target && { dockerBuildTarget: image.target }),
          ...(image.file && { dockerFile: image.file }),
          ...(image.networkMode && { networkMode: image.networkMode }),
          ...(image.platform && { platform: image.platform }),
          ...(image.outputs && { dockerOutputs: image.outputs }),
          ...(image.cacheFrom && { cacheFrom: image.cacheFrom }),
          ...(image.cacheTo && { cacheTo: image.cacheTo }),
          ...(image.cacheDisabled && { cacheDisabled: true }),
        };
        dockerImages[sourceHash] = {
          displayName: id,
          source,
          destinations: {
            [LEGACY_DESTINATION_ID]: {
              repositoryName,
              imageTag,
              region: target.region,
            },
          },
        };
        repositoriesToEnsure.add(repositoryName);
        if (repositoryName === LEGACY_DEFAULT_IMAGE_REPOSITORY && imageTag === sourceHash) {
          recognizedRepositories.add(repositoryName);
        }
        if (image.imageNameParameter) {
          const { urlSuffix } = derivePartitionAndUrlSuffix(target.region);
          parameters[image.imageNameParameter] =
            `${target.accountId}.dkr.ecr.${target.region}.${urlSuffix}/${repositoryName}:${imageTag}`;
        }
        break;
      }
      default: {
        const packaging: unknown = (entry as { packaging?: unknown }).packaging;
        throw new AssetError(
          `Unsupported packaging type: ${displayIdent(typeof packaging === 'string' ? packaging : JSON.stringify(packaging))} in a ` +
            'LegacyStackSynthesizer asset. cdkd publishes file, zip and container-image assets.'
        );
      }
    }
  }

  return {
    manifest: { version: 'legacy-synthesizer', files, dockerImages },
    parameters: { ...parameters },
    repositoriesToEnsure,
    recognizedRepositories,
  };
}

/** True when a plan has nothing to publish (it may still bind parameters). */
export function legacyPlanAssetCount(plan: LegacyAssetPlan): number {
  return Object.keys(plan.manifest.files).length + Object.keys(plan.manifest.dockerImages).length;
}

/**
 * Bind a plan's parameter values into the IN-MEMORY template as each
 * parameter's `Default`. The CDK CLI passes them as supplied parameter
 * values; cdkd's top-level commands take no parameter values, so a default
 * is the one binding every resolver caller (deploy, diff, import, the
 * outputs pass) reads the same way, and it never enters cdkd state — state
 * records resolved properties, never parameters. A name the template does
 * not declare is ignored. The template object is the command's own parsed
 * copy, so `cdkd synth` output is unchanged.
 */
export function bindLegacyAssetParameters(
  template: CloudFormationTemplate,
  parameters: Record<string, string>
): number {
  const declared = template.Parameters;
  if (!declared) return 0;
  let bound = 0;
  for (const [name, value] of Object.entries(parameters)) {
    if (!Object.hasOwn(declared, name)) continue;
    const decl = declared[name];
    if (decl === null || typeof decl !== 'object') continue;
    decl.Default = value;
    bound++;
  }
  return bound;
}

/**
 * The mode a `--dry-run` reports for a region whose asset storage the real
 * deploy would auto-create (#1007): the default cdkd names, which is what
 * auto-creation writes.
 */
export function predictedAutoCreatedAssetMode(accountId: string, region: string): AssetMode {
  return {
    mode: 'cdkd-assets',
    marker: {
      assetBucket: getCdkdAssetBucketName(accountId, region),
      containerRepo: getCdkdContainerRepoName(accountId, region),
      assetSupportVersion: ASSET_SUPPORT_VERSION,
      createdAt: new Date(0).toISOString(),
    },
  };
}

const toolkitBucketCache = new Map<string, Promise<string>>();

/** Test seam: the per-process toolkit-bucket memo. */
export function resetLegacyToolkitBucketCache(): void {
  toolkitBucketCache.clear();
}

/**
 * Turn a `LegacyStackSynthesizer` stack's `aws:cdk:asset` entries into a
 * publish plan and bind its parameter values into `stack.template` (issue
 * #6421). Returns `undefined` for a stack with no such entries, so every
 * other stack is byte-identical and pays no call.
 *
 * `assetMode` is the stack region's mode, resolved by the caller exactly as
 * for a modern stack, so the bucket a parameter names is the bucket the
 * object goes to: cdkd's asset bucket in cdkd-assets mode, the CDK toolkit
 * stack's bucket otherwise (one `DescribeStacks` per region per run, only
 * for a legacy stack with a file asset). Parameters are bound whether or not
 * the caller publishes, as the CDK CLI computes them under any flag.
 *
 * A stack with BOTH legacy entries and a publishable asset manifest cannot
 * come from a stock aws-cdk-lib synthesizer; it is refused rather than
 * guessed at, since one of the two sets would otherwise be ignored.
 */
export async function prepareLegacyStackAssets(
  stack: Pick<StackInfo, 'stackName' | 'template' | 'legacyAssets' | 'assetManifestPath'>,
  opts: {
    /**
     * The region's mode, or a function resolving it: a stack with only image
     * assets needs no bucket, so it never reads (or auto-creates) asset
     * storage for nothing.
     */
    assetMode: AssetMode | (() => Promise<AssetMode>);
    accountId: string;
    region: string;
  }
): Promise<LegacyAssetPlan | undefined> {
  const legacy = stack.legacyAssets;
  if (!legacy || legacy.entries.length === 0) return undefined;
  if (stack.assetManifestPath && loadPublishableAssetManifest(stack.assetManifestPath)) {
    throw new AssetError(
      `Stack ${displayIdent(stack.stackName)} carries both an asset manifest and ` +
        'LegacyStackSynthesizer asset metadata (aws:cdk:asset). No aws-cdk-lib synthesizer ' +
        'writes both; cdkd refuses rather than publish only one of the two sets.'
    );
  }
  let fileBucket: string | undefined;
  let rootKeys = false;
  if (legacyEntriesNeedFileBucket(legacy.entries)) {
    const assetMode =
      typeof opts.assetMode === 'function' ? await opts.assetMode() : opts.assetMode;
    if (assetMode.mode === 'cdkd-assets') {
      fileBucket = assetMode.marker.assetBucket;
      rootKeys = true;
    } else {
      const key = injectiveKey(opts.accountId, opts.region);
      let pending = toolkitBucketCache.get(key);
      if (!pending) {
        pending = lookupCdkToolkitBucket(opts.region, opts.accountId);
        // A failed lookup is not memoized: the next stack re-asks.
        pending.catch(() => toolkitBucketCache.delete(key));
        toolkitBucketCache.set(key, pending);
      }
      fileBucket = await pending;
    }
  }
  const plan = buildLegacyAssetPlan(legacy.entries, {
    fileBucket,
    accountId: opts.accountId,
    region: opts.region,
    rootKeys,
  });
  bindLegacyAssetParameters(stack.template, plan.parameters);
  return plan;
}

/**
 * For the commands that resolve a template without deploying it (`diff`,
 * `import`, `refactor`): bind a legacy stack's asset parameters from the
 * same lazily-resolved account and asset mode their redirect uses, so they
 * see the values `cdkd deploy` binds — a diff shows no false change and an
 * import records what a deploy would. A no-op for every other stack.
 */
export function createLegacyAssetParameterBinder(context: LazyAssetModeContext): (
  stack: Pick<StackInfo, 'stackName' | 'template' | 'legacyAssets' | 'assetManifestPath'>,
  region: string,
  /** Bind as this mode instead of the region's (import's state snapshot). */
  override?: { assetMode: AssetMode }
) => Promise<AssetMode | undefined> {
  return async (stack, region, override) => {
    if (!stack.legacyAssets) return undefined;
    const accountId = await context.accountId();
    // Resolved only when a file asset needs a bucket; `undefined` back means
    // no mode was consulted (no bucket is named).
    let resolved: AssetMode | undefined;
    await prepareLegacyStackAssets(stack, {
      assetMode: async () =>
        (resolved = override?.assetMode ?? (await context.resolveMode(region))),
      accountId,
      region,
    });
    return resolved;
  };
}

/**
 * One-shot {@link createLegacyAssetParameterBinder} for a command that binds a
 * single stack (`cdkd export`, whose changeset parameters must name the
 * objects the adopted resources point at). Builds nothing for a stack
 * without legacy entries.
 */
export async function bindLegacyStackAssetParameters(
  stack: Pick<StackInfo, 'stackName' | 'template' | 'legacyAssets' | 'assetManifestPath'>,
  region: string,
  /** `useCdkBootstrapAssets` as the command resolves it (cdk.json included). */
  opts: Omit<LazyAssetModeOptions, 'suppressLegacyNotice'>
): Promise<void> {
  if (!stack.legacyAssets) return;
  const context = createLazyAssetModeContext({ ...opts, suppressLegacyNotice: true });
  await createLegacyAssetParameterBinder(context)(stack, region);
}
