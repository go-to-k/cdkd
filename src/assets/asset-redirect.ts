import { readFileSync } from 'node:fs';
import type {
  AssetManifest,
  DockerImageAsset,
  DockerImageAssetDestination,
  FileAsset,
  FileAssetDestination,
} from '../types/assets.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import { AssetModeResolver, type BootstrapMarker } from './asset-storage.js';
import { isCfnTemplateAssetPath } from './asset-manifest-loader.js';

/**
 * Asset-location redirection to cdkd-owned storage (issue #1002 PR 2, design
 * §6-§8 in docs/design/1002-cdkd-asset-storage.md).
 *
 * When a region is opted in via `cdkd bootstrap` (bootstrap marker present),
 * cdkd publishes assets to the cdkd-owned bucket / ECR repo instead of the
 * CDK bootstrap storage — which `cdk gc` garbage-collects because
 * cdkd-deployed stacks have no CloudFormation stack for gc's in-use scan.
 *
 * The redirection is **destination-driven, not name-heuristic**: the mapping
 * table is built from the concrete `bucketName` / `repositoryName` values in
 * the stack's `*.assets.json`, and only default-bootstrap-shaped destinations
 * (`cdk-<qualifier>-(container-)?assets-<accountId>-<region>` — exactly the
 * population exposed to `cdk gc`) are redirected. User-chosen storage
 * (custom `fileAssetsBucketName`, `AppStagingSynthesizer` staging buckets)
 * and cross-region destinations are left verbatim (design §8).
 *
 * The publishers and the template rewrite consume the SAME table so they
 * cannot diverge (§6); the post-resolution audit (§7 step 3) turns any missed
 * template shape into a loud pre-provisioning error instead of a split-brain
 * deploy (assets in cdkd storage, resource pointing at the CDK bucket).
 */

/** One source → target renaming, in a concrete string form. */
export interface AssetRedirectEntry {
  /** Source name as it may appear in templates / manifests (literal or placeholder form). */
  source: string;
  /** cdkd-owned storage name that replaces it. */
  target: string;
}

/**
 * The §6 asset-location mapping table for one (stack, region) deploy.
 *
 * `buckets` / `repos` are keyed by the FLATTENED source name (placeholders
 * resolved) — the publishers look destinations up here after flattening.
 * `entries` additionally carries the placeholder forms so the template
 * rewrite can substring-replace names that appear un-flattened inside
 * `Fn::Sub` template strings.
 */
export interface AssetRedirectMap {
  /** Flattened source bucket name → cdkd asset bucket. */
  buckets: Map<string, string>;
  /** Flattened source ECR repository name → cdkd container-asset repo. */
  repos: Map<string, string>;
  /** All rewrite pairs (flattened + placeholder forms), longest source first. */
  entries: AssetRedirectEntry[];
  /** Deploy-time constants used for `Fn::Join` pseudo-parameter folding. */
  accountId: string;
  region: string;
  partition: string;
}

/**
 * Resolve `${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}`
 * placeholders in an asset-manifest destination value. Module-level twin of
 * `AssetManifestLoader.resolveAssetDestinationValue` (same substitution set,
 * same `aws` default partition) so the mapping table, the publishers, and
 * the rewrite flatten identically.
 */
export function flattenAssetPlaceholders(
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

/**
 * §8 scope rule, file-asset leg: `true` when a FLATTENED bucket name is
 * default-bootstrap-shaped for this (account, region) — any qualifier
 * (`cdk-hnb659fds-assets-…` default or `cdk-myqual-assets-…` custom; gc can
 * target any bootstrap stack). Everything else (user-chosen names,
 * AppStagingSynthesizer staging buckets, other accounts/regions) is out of
 * scope and left verbatim.
 */
export function isDefaultBootstrapBucketName(
  name: string,
  accountId: string,
  region: string
): boolean {
  return new RegExp(`^cdk-[a-z0-9]+-assets-${accountId}-${escapeRegExp(region)}$`).test(name);
}

/** §8 scope rule, container-image leg (`cdk-<qualifier>-container-assets-…`). */
export function isDefaultBootstrapRepoName(
  name: string,
  accountId: string,
  region: string
): boolean {
  return new RegExp(`^cdk-[a-z0-9]+-container-assets-${accountId}-${escapeRegExp(region)}$`).test(
    name
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the §6 asset-location mapping table from a stack's asset manifest.
 *
 * For every file / docker destination that (a) targets the deploy region and
 * (b) is default-bootstrap-shaped after flattening, the flattened source name
 * maps to the marker's cdkd-owned bucket / repo. `objectKey` / `imageTag`
 * (content hashes, including any `bucketPrefix` baked into `objectKey`) are
 * never part of the table — keys and tags flow through unchanged so the
 * existence-check/skip logic works as-is per storage.
 *
 * Template assets (`*.template.json` sources) contribute their destinations
 * too even though cdkd never publishes them: the parent's `TemplateURL`
 * property references the same bootstrap bucket and must rewrite with it
 * (harmlessly — `NestedStackProvider` never dereferences the URL).
 *
 * Cross-region destinations (`dest.region` ≠ deploy region) are skipped
 * entirely — cdkd asset storage and its marker are per-region (§8).
 */
export function buildAssetRedirectMap(
  manifest: AssetManifest,
  marker: BootstrapMarker,
  accountId: string,
  region: string,
  partition = 'aws'
): AssetRedirectMap {
  const buckets = new Map<string, string>();
  const repos = new Map<string, string>();
  const sources = new Map<string, string>(); // source string form → target

  const addForms = (rawName: string, flattened: string, target: string): void => {
    sources.set(flattened, target);
    if (rawName !== flattened) sources.set(rawName, target);
    // Synthesized placeholder forms: cover templates that reference the
    // name with pseudo-parameter placeholders even when the manifest
    // carried it as a literal — including the mixed single-placeholder
    // shapes (`…-<acct>-${AWS::Region}` / `…-${AWS::AccountId}-<region>`),
    // which would otherwise survive the rewrite unmatched and trip the
    // post-resolution audit as a hard error.
    const suffixRe = new RegExp(`-${accountId}-${escapeRegExp(region)}$`);
    for (const suffix of [
      '-${AWS::AccountId}-${AWS::Region}',
      `-\${AWS::AccountId}-${region}`,
      `-${accountId}-\${AWS::Region}`,
    ]) {
      const form = flattened.replace(suffixRe, suffix);
      if (form !== flattened) sources.set(form, target);
    }
  };

  const destTargetsDeployRegion = (dest: FileAssetDestination | DockerImageAssetDestination) => {
    if (!dest.region) return true;
    return flattenAssetPlaceholders(dest.region, accountId, region, partition) === region;
  };

  for (const asset of Object.values(manifest.files ?? {})) {
    for (const dest of Object.values(asset.destinations ?? {})) {
      if (!destTargetsDeployRegion(dest)) continue;
      const flattened = flattenAssetPlaceholders(dest.bucketName, accountId, region, partition);
      if (!isDefaultBootstrapBucketName(flattened, accountId, region)) continue;
      buckets.set(flattened, marker.assetBucket);
      addForms(dest.bucketName, flattened, marker.assetBucket);
    }
  }

  for (const asset of Object.values(manifest.dockerImages ?? {})) {
    for (const dest of Object.values(asset.destinations ?? {})) {
      if (!destTargetsDeployRegion(dest)) continue;
      const flattened = flattenAssetPlaceholders(dest.repositoryName, accountId, region, partition);
      if (!isDefaultBootstrapRepoName(flattened, accountId, region)) continue;
      repos.set(flattened, marker.containerRepo);
      addForms(dest.repositoryName, flattened, marker.containerRepo);
    }
  }

  // Longest source first so a longer name is never partially eaten by a
  // shorter one that happens to be its prefix.
  const entries = [...sources.entries()]
    .map(([source, target]) => ({ source, target }))
    .sort((a, b) => b.source.length - a.source.length);

  return { buckets, repos, entries, accountId, region, partition };
}

/**
 * Boundary-aware replacement (§7 step 2): a source name only matches when it
 * stands alone as a name token — not preceded by a name character (so a user
 * bucket `my-cdk-hnb659fds-assets-…` is never corrupted) and not followed by
 * one (so `cdk-hnb659fds-assets-<acct>-<region>-backup` is never corrupted).
 * URI delimiters (`/`, `:`, `.`, quotes, whitespace) and end-of-string are
 * boundaries.
 *
 * Known trade-off: a trailing `.` MUST be a boundary for virtual-host-style
 * URLs (`<bucket>.s3.<region>.amazonaws.com`), so a user bucket literally
 * named `cdk-<qualifier>-assets-<acct>-<region>.backup` (dot-suffixed
 * lookalike) would have its prefix rewritten. S3 discourages dots in bucket
 * names (breaks virtual-host TLS) and the name would ALSO have to collide
 * with the deploy account+region bootstrap shape — accepted as pathological.
 */
function buildBoundaryRegex(source: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(source)}(?![A-Za-z0-9_-])`, 'g');
}

function rewriteString(value: string, map: AssetRedirectMap, counter: { n: number }): string {
  let result = value;
  for (const { source, target } of map.entries) {
    if (!result.includes(source)) continue;
    const re = buildBoundaryRegex(source);
    result = result.replace(re, () => {
      counter.n++;
      return target;
    });
  }
  return result;
}

/** True when the string contains any mapped source name at a token boundary. */
function containsAnySource(value: string, map: AssetRedirectMap): boolean {
  for (const { source } of map.entries) {
    if (!value.includes(source)) continue;
    if (buildBoundaryRegex(source).test(value)) return true;
  }
  return false;
}

const FOLDABLE_PSEUDO_PARAMS = new Set([
  'AWS::AccountId',
  'AWS::Region',
  'AWS::Partition',
  'AWS::URLSuffix',
]);

function evaluatePseudoParam(name: string, map: AssetRedirectMap): string {
  switch (name) {
    case 'AWS::AccountId':
      return map.accountId;
    case 'AWS::Region':
      return map.region;
    case 'AWS::Partition':
      return map.partition;
    case 'AWS::URLSuffix':
      // Mirrors IntrinsicFunctionResolver's AWS::URLSuffix resolution.
      return 'amazonaws.com';
    default:
      throw new Error(`Not a foldable pseudo parameter: ${name}`);
  }
}

/** A `Fn::Join` part that partial evaluation can fold to a literal. */
function foldablePartValue(part: unknown, map: AssetRedirectMap): string | undefined {
  if (typeof part === 'string') return part;
  if (part !== null && typeof part === 'object' && !Array.isArray(part)) {
    const keys = Object.keys(part as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === 'Ref') {
      const ref = (part as Record<string, unknown>)['Ref'];
      if (typeof ref === 'string' && FOLDABLE_PSEUDO_PARAMS.has(ref)) {
        return evaluatePseudoParam(ref, map);
      }
    }
  }
  return undefined;
}

/**
 * §7 `Fn::Join` handling: fold maximal runs of pseudo-parameter-only parts
 * (string literals + `{Ref: AWS::AccountId|Region|Partition|URLSuffix}` —
 * all deploy-time constants) into a literal, and KEEP the folded literal only
 * when a source name actually matched inside it — otherwise the original
 * parts are preserved so templates without asset references stay
 * byte-identical. Joins whose relevant runs contain real resource refs are
 * left alone (synthesizer output never splits an asset location across a
 * resource ref).
 *
 * Returns the new parts array (or the original when nothing changed).
 */
function foldAndRewriteJoinParts(
  delimiter: string,
  parts: unknown[],
  map: AssetRedirectMap,
  counter: { n: number }
): unknown[] {
  const out: unknown[] = [];
  let changed = false;
  let i = 0;
  while (i < parts.length) {
    const folded = foldablePartValue(parts[i], map);
    if (folded === undefined) {
      out.push(parts[i]);
      i++;
      continue;
    }
    // Extend the foldable run as far as it goes.
    const runValues: string[] = [folded];
    let j = i + 1;
    for (; j < parts.length; j++) {
      const v = foldablePartValue(parts[j], map);
      if (v === undefined) break;
      runValues.push(v);
    }
    const literal = runValues.join(delimiter);
    if (j - i > 1 && containsAnySource(literal, map)) {
      // A source name spans multiple parts — fold the run and rewrite.
      out.push(rewriteString(literal, map, counter));
      changed = true;
    } else {
      // Single-part runs are handled by the plain string walk; multi-part
      // runs with no match keep their original shape.
      for (let k = i; k < j; k++) out.push(parts[k]);
    }
    i = j;
  }
  return changed ? out : parts;
}

function rewriteNode(node: unknown, map: AssetRedirectMap, counter: { n: number }): unknown {
  if (typeof node === 'string') {
    return rewriteString(node, map, counter);
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = rewriteNode(node[i], map, counter);
    }
    return node;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const joinArgs = obj['Fn::Join'];
    if (
      Object.keys(obj).length === 1 &&
      Array.isArray(joinArgs) &&
      joinArgs.length === 2 &&
      typeof joinArgs[0] === 'string' &&
      Array.isArray(joinArgs[1])
    ) {
      const foldedParts = foldAndRewriteJoinParts(
        joinArgs[0],
        joinArgs[1] as unknown[],
        map,
        counter
      );
      // Recurse into the (possibly folded) parts for names contained
      // entirely inside a single part.
      obj['Fn::Join'] = [joinArgs[0], rewriteNode(foldedParts, map, counter)];
      return obj;
    }
    for (const key of Object.keys(obj)) {
      obj[key] = rewriteNode(obj[key], map, counter);
    }
    return obj;
  }
  return node;
}

/**
 * §7 template reference rewrite: deep-walk the parsed template IN PLACE and
 * replace every boundary-matched source name (both placeholder and flattened
 * forms, incl. inside `Fn::Sub` template strings and across folded `Fn::Join`
 * pseudo-parameter runs) with the cdkd-owned storage name. Returns the number
 * of replacements for logging.
 *
 * Applied per stack before DAG build (deploy), before diff computation
 * (diff, incl. every recursive child template), and before state write
 * (import, incl. the recursive CFn-migration child walk). `cdkd synth` and
 * `cdkd export` output stays unrewritten by design (§7.1).
 */
export function rewriteTemplateAssetReferences(
  template: CloudFormationTemplate,
  map: AssetRedirectMap
): number {
  if (map.entries.length === 0) return 0;
  const counter = { n: 0 };
  rewriteNode(template, map, counter);
  return counter.n;
}

/** One post-resolution audit finding: a resolved value still naming a redirected source. */
export interface UnrewrittenAssetReference {
  /** Dotted property path (e.g. `Code.S3Bucket` or `Environment.Variables.ASSET_URL`). */
  path: string;
  /** The mapped source name found in the resolved value. */
  source: string;
}

function auditNode(
  node: unknown,
  map: AssetRedirectMap,
  path: string,
  findings: UnrewrittenAssetReference[]
): void {
  if (typeof node === 'string') {
    for (const { source } of map.entries) {
      if (!node.includes(source)) continue;
      if (buildBoundaryRegex(source).test(node)) {
        findings.push({ path, source });
        return; // one finding per string node is enough to fail loudly
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => auditNode(item, map, `${path}[${i}]`, findings));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      auditNode(value, map, path ? `${path}.${key}` : key, findings);
    }
  }
}

/**
 * §7 step 3 post-resolution audit (defense in depth): after the intrinsic
 * resolver produces final literals, scan the resolved properties for any
 * remaining mapped SOURCE name. A hit means a template shape the rewrite
 * missed — the deploy engine fails the resource loudly instead of deploying
 * a split-brain reference (assets in cdkd storage, property pointing at the
 * CDK bootstrap bucket that `cdk gc` may have emptied).
 */
export function findUnrewrittenAssetReferences(
  resolvedProperties: Record<string, unknown>,
  map: AssetRedirectMap
): UnrewrittenAssetReference[] {
  const findings: UnrewrittenAssetReference[] = [];
  auditNode(resolvedProperties, map, '', findings);
  return findings;
}

/**
 * Apply the mapping table to one file asset's destinations (§6 publish-time
 * redirection). Returns a shallow-cloned asset when any destination is
 * redirected, or the original object otherwise. `objectKey` is untouched.
 */
export function redirectFileAsset(asset: FileAsset, map: AssetRedirectMap): FileAsset {
  let changed = false;
  const destinations: Record<string, FileAssetDestination> = {};
  for (const [id, dest] of Object.entries(asset.destinations ?? {})) {
    const flattened = flattenAssetPlaceholders(
      dest.bucketName,
      map.accountId,
      map.region,
      map.partition
    );
    const target = map.buckets.get(flattened);
    if (target && destRegionMatches(dest, map)) {
      destinations[id] = { ...dest, bucketName: target };
      changed = true;
    } else {
      destinations[id] = dest;
    }
  }
  return changed ? { ...asset, destinations } : asset;
}

/**
 * Apply the mapping table to one docker-image asset's destinations.
 * Returns a shallow-cloned asset when any destination is redirected.
 * `imageTag` is untouched.
 */
export function redirectDockerAsset(
  asset: DockerImageAsset,
  map: AssetRedirectMap
): DockerImageAsset {
  let changed = false;
  const destinations: Record<string, DockerImageAssetDestination> = {};
  for (const [id, dest] of Object.entries(asset.destinations ?? {})) {
    const flattened = flattenAssetPlaceholders(
      dest.repositoryName,
      map.accountId,
      map.region,
      map.partition
    );
    const target = map.repos.get(flattened);
    if (target && destRegionMatches(dest, map)) {
      destinations[id] = { ...dest, repositoryName: target };
      changed = true;
    } else {
      destinations[id] = dest;
    }
  }
  return changed ? { ...asset, destinations } : asset;
}

function destRegionMatches(
  dest: FileAssetDestination | DockerImageAssetDestination,
  map: AssetRedirectMap
): boolean {
  if (!dest.region) return true;
  return (
    flattenAssetPlaceholders(dest.region, map.accountId, map.region, map.partition) === map.region
  );
}

/**
 * Load a stack's asset manifest and report whether it has anything cdkd
 * would actually publish (file assets excluding CFn template assets, plus
 * docker images). Returns `null` when the manifest file does not exist or
 * has nothing publishable — the caller then skips asset-mode resolution
 * entirely so asset-less deploys stay byte-identical to pre-#1002 behavior
 * (no marker read, no legacy-mode notice).
 *
 * Non-ENOENT read/parse failures propagate — a corrupt manifest must not
 * be mistaken for "no assets".
 */
export function loadPublishableAssetManifest(manifestPath: string): AssetManifest | null {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const manifest = JSON.parse(raw) as AssetManifest;
  const publishableFiles = Object.values(manifest.files ?? {}).filter(
    (asset) => !isCfnTemplateAssetPath(asset.source.path)
  ).length;
  const dockerImages = Object.keys(manifest.dockerImages ?? {}).length;
  if (publishableFiles + dockerImages === 0) return null;
  return manifest;
}

/**
 * Lazily-initializing per-stack redirect resolver for commands that do NOT
 * already resolve the caller account id up front (`diff`, `import`). Returns
 * a function that maps `(manifestPath, region)` to the stack's
 * {@link AssetRedirectMap} — or `undefined` when the stack has nothing
 * publishable, the region is in legacy mode, or the map has no
 * in-scope destinations.
 *
 * The STS `GetCallerIdentity` call and the {@link AssetModeResolver} are
 * created on first need only, so invocations that never touch an
 * asset-bearing stack make no extra AWS calls (byte-identical to pre-#1002
 * behavior). `useCdkBootstrapAssets` short-circuits everything to legacy.
 */
export function createAssetRedirectResolver(opts: {
  stateBackend: S3StateBackend;
  /** Region for the lazy STS client (the CLI's base region). */
  stsRegion: string;
  profile?: string;
  useCdkBootstrapAssets?: boolean;
  /** Forwarded to {@link AssetModeResolver} — see its constructor JSDoc. */
  suppressLegacyNotice?: boolean;
}): (manifestPath: string | undefined, region: string) => Promise<AssetRedirectMap | undefined> {
  let accountIdPromise: Promise<string> | undefined;
  let modeResolver: AssetModeResolver | undefined;

  const getAccountId = (): Promise<string> => {
    accountIdPromise ??= (async () => {
      const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
      const stsClient = new STSClient({
        region: opts.stsRegion,
        ...(opts.profile && { profile: opts.profile }),
      });
      try {
        const identity = await stsClient.send(new GetCallerIdentityCommand({}));
        return identity.Account!;
      } finally {
        stsClient.destroy();
      }
    })();
    return accountIdPromise;
  };

  return async (manifestPath, region) => {
    if (opts.useCdkBootstrapAssets || !manifestPath) return undefined;
    const manifest = loadPublishableAssetManifest(manifestPath);
    if (!manifest) return undefined;
    const accountId = await getAccountId();
    modeResolver ??= new AssetModeResolver(opts.stateBackend, accountId, {
      ...(opts.profile && { profile: opts.profile }),
      ...(opts.suppressLegacyNotice && { suppressLegacyNotice: true }),
    });
    const mode = await modeResolver.resolve(region);
    if (mode.mode !== 'cdkd-assets') return undefined;
    const map = buildAssetRedirectMap(manifest, mode.marker, accountId, region);
    return map.entries.length > 0 ? map : undefined;
  };
}
