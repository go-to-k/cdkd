import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';

/**
 * Result of resolving a `cdkd local invoke <target>` argument back to a
 * concrete Lambda function in the synthesized assembly.
 *
 * Discriminated union (PR 5, D5.3): `kind === 'zip'` for traditional
 * Node.js / Python ZIP-packaged Lambdas; `kind === 'image'` for container
 * Lambdas (`Code.ImageUri`). The two variants have meaningfully different
 * fields — `runtime` / `handler` / `codePath` are zip-only, while
 * `dockerSource` / `imageConfig` / `architecture` are image-only — so the
 * compiler can enforce exhaustive handling at the consumer (the
 * `local-invoke.ts` CLI command branch).
 *
 * Orthogonal future fields (e.g. PR 6 layers) live on the base interface
 * so they apply to both variants without each adding a copy.
 */
export type ResolvedLambda = ResolvedZipLambda | ResolvedImageLambda;

interface ResolvedLambdaBase {
  /** Stack the function belongs to. */
  stack: StackInfo;
  /** CloudFormation logical ID of the function. */
  logicalId: string;
  /** Raw template entry (for property reads beyond what's surfaced here). */
  resource: TemplateResource;
  /** `MemorySize` from the template, or 128 when omitted (Lambda default). */
  memoryMb: number;
  /** `Timeout` (seconds) from the template, or 3 when omitted (Lambda default). */
  timeoutSec: number;
  /**
   * Resolved Lambda layers (PR 6 of #224, issue #232). Each entry points
   * at an `AWS::Lambda::LayerVersion` resource in the same stack — the
   * `logicalId` lets the caller emit clearer error messages, `assetPath`
   * is the absolute directory under `cdk.out` (resolved via the same
   * `Metadata['aws:asset:path']` hint Lambda code uses) that bind-mounts
   * at `/opt`. `[]` when the function declares no Layers.
   *
   * **Order is load-bearing**: AWS layer semantics are "last layer wins
   * on file collision", so this array preserves the template's input
   * order. cdkd implements the last-wins rule by `cpSync`-merging every
   * layer's asset directory into a single host tmpdir IN TEMPLATE ORDER
   * (later layers overwrite earlier files via `recursive: true, force:
   * true`), then bind-mounting the merged tmpdir at `/opt:ro`. Docker
   * rejects multiple `-v ...:/opt:ro` entries at the same target path
   * (`Error response from daemon: Duplicate mount point: /opt`) — bind
   * mounts are NOT layered the way the OCI image stack is — so the
   * merge happens on the host, not via overlay layering. The single-
   * layer case skips the copy and bind-mounts the asset dir directly.
   *
   * Out of scope for v1 (any of these hard-error at resolution time):
   *   - Cross-stack / cross-account / cross-region layer ARNs (anything
   *     that isn't a same-stack `Ref` / `Fn::GetAtt[..., Ref]` pointing
   *     at an `AWS::Lambda::LayerVersion`).
   *   - Layers without `Metadata['aws:asset:path']` (i.e. layers whose
   *     content is `S3Bucket`/`S3Key` from outside cdk.out — there's no
   *     local directory to bind-mount).
   */
  layers: ResolvedLambdaLayer[];
}

export interface ResolvedLambdaLayer {
  /** CFn logical ID of the `AWS::Lambda::LayerVersion` resource. */
  logicalId: string;
  /**
   * Absolute path on disk to the layer's unzipped asset directory. Will
   * be bind-mounted at `/opt` inside the container (read-only). The
   * directory is laid out per AWS's runtime-specific load-path
   * conventions (`opt/python/...`, `opt/nodejs/...`, etc.) — cdkd does
   * NOT inspect the contents, just hands the directory to docker.
   */
  assetPath: string;
}

export interface ResolvedZipLambda extends ResolvedLambdaBase {
  kind: 'zip';
  /** Lambda runtime string (e.g. `nodejs20.x`). */
  runtime: string;
  /** Lambda handler string (e.g. `index.handler`). */
  handler: string;
  /**
   * Resolved local code path. For asset-backed functions, this is the
   * absolute directory under `cdk.out` named by the resource's
   * `Metadata['aws:asset:path']`. For inline `Code.ZipFile` functions,
   * this is `null` and the caller is expected to materialize a temp dir
   * before bind-mounting (handled in the command layer to keep this
   * module side-effect-free).
   */
  codePath: string | null;
  /**
   * For inline Lambdas only: the inline source body. The command layer
   * writes this into a temp dir at the path implied by `handler`.
   */
  inlineCode?: string;
}

export interface ResolvedImageLambda extends ResolvedLambdaBase {
  kind: 'image';
  /**
   * Raw `Code.ImageUri` from the template. Used to extract the asset hash
   * for the local-build path AND for the ECR-pull fallback path (when the
   * URI doesn't match any cdk.out asset). Already resolved through
   * cdk-assets bootstrap-placeholder substitution upstream — `${AWS::*}`
   * pseudo-parameters are still present (cdkd substitutes them at the
   * lookup site since it knows the calling account/region).
   */
  imageUri: string;
  /**
   * `ImageConfig` from the template. All fields are optional — the
   * common case is just `Command: [<handler>]`. Empty `[]` for
   * `entryPoint` means "use the image's default entrypoint" (typically
   * `/lambda-entrypoint.sh` on AWS base images, which routes to RIE).
   */
  imageConfig: {
    command?: string[];
    entryPoint?: string[];
    workingDirectory?: string;
  };
  /**
   * `Architectures: [x86_64]` (default) or `[arm64]`. Threaded through to
   * `--platform linux/amd64` / `linux/arm64` on BOTH `docker build` AND
   * `docker run`. Without this, an arm64 host running an x86_64 Lambda
   * hits emulation; an x86_64 host running arm64 fails with
   * `exec format error`.
   */
  architecture: 'x86_64' | 'arm64';
}

export class LocalInvokeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalInvokeResolutionError';
    Object.setPrototypeOf(this, LocalInvokeResolutionError.prototype);
  }
}

/**
 * Parse a `target` argument into (optional stack pattern, path-or-id).
 *
 * Two accepted forms:
 *   - `Stack:LogicalId` — colon delimits stack from logical ID. Logical
 *     IDs cannot contain `/` or `:`, so the parse is unambiguous.
 *   - `Stack/Path/...` — display-path form. The stack prefix is the first
 *     `/`-delimited segment; everything after is the construct path
 *     (which itself starts with the same stack name in CDK output, e.g.
 *     `MyStack/MyApi/Handler`).
 *
 * For single-stack apps the stack prefix may be omitted entirely:
 *   - Bare `Handler` is treated as a logical ID in the only stack.
 *   - Bare `MyApi/Handler` is treated as a construct path; the only
 *     stack's name is prepended at lookup time.
 *
 * Returns the raw split. The actual stack-resolution + auto-detect logic
 * lives in `resolveLambdaTarget` so `parseTarget` stays a pure string
 * splitter.
 */
export interface ParsedTarget {
  /**
   * Stack pattern if explicit, else `null`. When `null` the resolver
   * auto-detects the single stack in the app.
   */
  stackPattern: string | null;
  /** Path-or-id portion of the target. */
  pathOrId: string;
  /** `true` iff `pathOrId` looks like a construct path (contains `/`). */
  isPath: boolean;
}

export function parseTarget(target: string): ParsedTarget {
  if (typeof target !== 'string' || target.length === 0) {
    throw new LocalInvokeResolutionError(
      "Empty target. Pass a CDK display path (e.g. 'MyStack/MyApi/Handler') or stack-qualified logical ID (e.g. 'MyStack:MyApiHandler1234ABCD')."
    );
  }

  // Stack:LogicalId form. The colon must precede every slash for this to
  // be the colon form (otherwise `Stack:Foo/bar` is ambiguous and we
  // prefer the path form).
  const colonIdx = target.indexOf(':');
  const slashIdx = target.indexOf('/');
  if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
    const stackPattern = target.substring(0, colonIdx);
    const pathOrId = target.substring(colonIdx + 1);
    if (pathOrId.length === 0) {
      throw new LocalInvokeResolutionError(`Target '${target}' has no logical ID after ':'.`);
    }
    return { stackPattern, pathOrId, isPath: pathOrId.includes('/') };
  }

  // Path form with explicit stack: stack is the first segment.
  if (slashIdx > 0) {
    return { stackPattern: target.substring(0, slashIdx), pathOrId: target, isPath: true };
  }

  // Bare logical ID — single-stack auto-detect path.
  return { stackPattern: null, pathOrId: target, isPath: false };
}

/**
 * Resolve a parsed target against the synthesized stacks. Throws
 * {@link LocalInvokeResolutionError} with an actionable message (listing
 * available Lambdas) on any miss.
 */
export function resolveLambdaTarget(target: string, stacks: StackInfo[]): ResolvedLambda {
  if (stacks.length === 0) {
    throw new LocalInvokeResolutionError('No stacks found in the synthesized assembly.');
  }

  const parsed = parseTarget(target);
  const stack = pickStack(parsed, stacks);

  const template = stack.template;
  const resources = template.Resources ?? {};

  let match: { logicalId: string; resource: TemplateResource } | undefined;

  if (parsed.isPath) {
    // Build the path index once so we can list every available Lambda
    // when the lookup misses.
    const index = buildCdkPathIndex(template);
    const resolvedPaths = resolveCdkPathToLogicalIds(parsed.pathOrId, index);

    // Filter to Lambda functions; keep the rest for an error path.
    const lambdaMatches = resolvedPaths.filter(
      ({ logicalId }) => resources[logicalId]?.Type === 'AWS::Lambda::Function'
    );

    if (lambdaMatches.length === 0) {
      throw notFoundError(target, stack, resources);
    }
    if (lambdaMatches.length > 1) {
      throw new LocalInvokeResolutionError(
        `Target '${target}' matches ${lambdaMatches.length} Lambda functions in ${stack.stackName}: ` +
          lambdaMatches.map((m) => m.logicalId).join(', ') +
          '. Refine the path or use the stack:LogicalId form.'
      );
    }
    const m = lambdaMatches[0]!;
    match = { logicalId: m.logicalId, resource: resources[m.logicalId]! };
  } else {
    const resource = resources[parsed.pathOrId];
    if (!resource) {
      throw notFoundError(target, stack, resources);
    }
    match = { logicalId: parsed.pathOrId, resource };
  }

  const { logicalId, resource } = match;

  if (resource.Type !== 'AWS::Lambda::Function') {
    if (resource.Type.startsWith('Custom::')) {
      throw new LocalInvokeResolutionError(
        `Resource '${logicalId}' in ${stack.stackName} is a Custom Resource (${resource.Type}), not a Lambda function. ` +
          `Custom Resources are invoked by the deploy framework, not by users. ` +
          `If you want to test the underlying handler, target the ServiceToken Lambda directly.`
      );
    }
    throw new LocalInvokeResolutionError(
      `Resource '${logicalId}' in ${stack.stackName} is ${resource.Type}, not a Lambda function. ` +
        `cdkd local invoke only works on AWS::Lambda::Function resources in v1.`
    );
  }

  return extractLambdaProperties(stack, logicalId, resource);
}

/**
 * Single-stack auto-detect (D4): if the app has exactly one stack, the
 * user may omit the stack prefix. Otherwise an explicit stack pattern is
 * required.
 */
function pickStack(parsed: ParsedTarget, stacks: StackInfo[]): StackInfo {
  if (parsed.stackPattern === null) {
    if (stacks.length === 1) return stacks[0]!;
    throw new LocalInvokeResolutionError(
      `Multiple stacks in app, target '${parsed.pathOrId}' is missing a stack prefix. ` +
        `Use 'StackName:${parsed.pathOrId}' or 'StackName/...' (path form). ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }

  // Reuse the shared stack-matcher so display-path / wildcard semantics
  // line up with deploy / diff / destroy.
  const matched = matchStacks(stacks, [parsed.stackPattern]);
  if (matched.length === 0) {
    throw new LocalInvokeResolutionError(
      `Stack '${parsed.stackPattern}' not found. ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }
  if (matched.length > 1) {
    throw new LocalInvokeResolutionError(
      `Stack pattern '${parsed.stackPattern}' matched ${matched.length} stacks: ` +
        matched.map((s) => s.stackName).join(', ') +
        '. Use a more specific pattern.'
    );
  }
  return matched[0]!;
}

/**
 * Pull the Lambda properties this command cares about out of the
 * template. Validates required fields up front so the docker-runner can
 * assume a fully-typed `ResolvedLambda`.
 *
 * Branches on `Code.ImageUri`: when set the function is a container
 * Lambda (PR 5, D5.3) and the discriminator flips to `kind: 'image'`;
 * `Runtime` / `Handler` are NOT required on this path (D5.5 — AWS
 * contract: container Lambdas don't have `Handler`; invocation is
 * driven by `ImageConfig.Command` or the image's own CMD).
 */
function extractLambdaProperties(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource
): ResolvedLambda {
  const props = resource.Properties ?? {};
  const memoryMb = typeof props['MemorySize'] === 'number' ? props['MemorySize'] : 128;
  const timeoutSec = typeof props['Timeout'] === 'number' ? props['Timeout'] : 3;

  const code = (props['Code'] ?? {}) as Record<string, unknown>;
  const imageUri = extractImageUri(code['ImageUri']);

  if (imageUri !== undefined) {
    return extractImageLambdaProperties({
      stack,
      logicalId,
      resource,
      memoryMb,
      timeoutSec,
      props,
      imageUri,
    });
  }

  // ZIP path (D5.5): Runtime + Handler are mandatory.
  const runtime = typeof props['Runtime'] === 'string' ? props['Runtime'] : '';
  const handler = typeof props['Handler'] === 'string' ? props['Handler'] : '';

  if (!runtime) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has no Runtime property and no Code.ImageUri. ` +
        'cdkd cannot tell if this is a ZIP or a container Lambda.'
    );
  }
  if (!handler) {
    throw new LocalInvokeResolutionError(`Lambda '${logicalId}' has no Handler property.`);
  }

  const inlineCode = typeof code['ZipFile'] === 'string' ? code['ZipFile'] : undefined;

  let codePath: string | null = null;
  if (!inlineCode) {
    codePath = resolveAssetCodePath(stack, logicalId, resource);
  }

  // PR 6 (#232): resolve same-stack `Layers` references. Out-of-scope
  // shapes (literal ARNs, cross-stack refs, layers without an asset
  // path) hard-error here so the user sees a clear pointer at the
  // offending entry instead of a silently-missing `/opt/<lib>` at
  // invoke time.
  const layers = resolveLambdaLayers(stack, logicalId, props);

  return {
    kind: 'zip',
    stack,
    logicalId,
    resource,
    runtime,
    handler,
    memoryMb,
    timeoutSec,
    codePath,
    layers,
    ...(inlineCode !== undefined && { inlineCode }),
  };
}

/**
 * Extract the `Code.ImageUri` value when the template entry is either
 * a flat string OR a single-key `Fn::Sub` object (the shape CDK actually
 * synthesizes). Returns `undefined` when the field is absent or some
 * other intrinsic shape we don't try to resolve in v1.
 *
 * Critical bug fix C1 from the design doc: CDK synthesizes
 * `{Fn::Sub: '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}:<hash>'}`,
 * NOT a flat string. The hash-extraction regex in the asset manifest
 * loader works against the substituted form (the `${...}` placeholders
 * are still present but the `:<hash>` tail is unaffected by them).
 */
function extractImageUri(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sub = obj['Fn::Sub'];
    if (typeof sub === 'string' && sub.length > 0) return sub;
    // Fn::Sub array form: [template, vars]. The first element is the template.
    if (Array.isArray(sub) && typeof sub[0] === 'string') return sub[0];
  }
  return undefined;
}

/**
 * Build the IMAGE-variant `ResolvedLambda` from a Lambda template entry
 * with `Code.ImageUri`. `ImageConfig` and `Architectures` are both
 * optional in CFn — the defaults match the AWS-side defaults.
 */
function extractImageLambdaProperties(args: {
  stack: StackInfo;
  logicalId: string;
  resource: TemplateResource;
  memoryMb: number;
  timeoutSec: number;
  props: Record<string, unknown>;
  imageUri: string;
}): ResolvedImageLambda {
  const { stack, logicalId, resource, memoryMb, timeoutSec, props, imageUri } = args;

  const rawImageConfig = (props['ImageConfig'] ?? {}) as Record<string, unknown>;
  const imageConfig: ResolvedImageLambda['imageConfig'] = {};
  if (Array.isArray(rawImageConfig['Command'])) {
    imageConfig.command = rawImageConfig['Command'].filter(
      (s): s is string => typeof s === 'string'
    );
  }
  if (Array.isArray(rawImageConfig['EntryPoint'])) {
    imageConfig.entryPoint = rawImageConfig['EntryPoint'].filter(
      (s): s is string => typeof s === 'string'
    );
  }
  if (typeof rawImageConfig['WorkingDirectory'] === 'string') {
    imageConfig.workingDirectory = rawImageConfig['WorkingDirectory'];
  }

  // Architectures is an array (CFn). CDK never sets more than one entry.
  // Default x86_64 matches AWS.
  const arches = props['Architectures'];
  let architecture: 'x86_64' | 'arm64' = 'x86_64';
  if (Array.isArray(arches) && arches.length > 0) {
    const first: unknown = arches[0];
    if (first === 'arm64') architecture = 'arm64';
    else if (first === 'x86_64') architecture = 'x86_64';
    else {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' has unsupported Architectures value '${String(first)}'. ` +
          'cdkd local invoke supports x86_64 and arm64.'
      );
    }
  }

  // PR 6 (#232): container Lambdas reject `Layers` at deploy time on
  // the AWS side — layers are baked into the image at build time, not
  // overlaid at runtime. We silently ignore any `Layers` property here
  // (matches AWS behavior at invoke time) by passing an empty list.
  return {
    kind: 'image',
    stack,
    logicalId,
    resource,
    memoryMb,
    timeoutSec,
    imageUri,
    imageConfig,
    architecture,
    layers: [],
  };
}

/**
 * Resolve the local directory that corresponds to a function's deployed
 * asset, using the CDK-blessed `Metadata['aws:asset:path']` hint (D2). The
 * value is a directory path relative to `cdk.out` (e.g. `asset.abc123def`)
 * and CDK has already unzipped it for us — we bind-mount the directory
 * directly, no re-zipping.
 *
 * Falls back to a clear error when the metadata is missing OR the resolved
 * directory does not exist (CDK should always emit it for asset-backed
 * Lambdas; absence usually means the user pre-synthesized with a different
 * cdk.out and pointed `--output` at a stale one).
 */
function resolveAssetCodePath(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource
): string {
  const meta = resource.Metadata;
  const assetPath = meta?.['aws:asset:path'];
  if (typeof assetPath !== 'string' || assetPath.length === 0) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has no Metadata['aws:asset:path']. ` +
        'cdkd local invoke needs this hint to find the local asset directory. ' +
        'Re-synthesize the app (without `--output <stale-dir>`) and retry.'
    );
  }

  // Asset paths are typically relative to cdk.out. The stack's
  // `assetManifestPath` is `<cdk.out>/<stack>.assets.json`; we strip the
  // filename to get the assembly directory. As a fallback (e.g. for
  // stacks with no asset manifest), use the dirname of the template
  // path implicit in the stack info — but in v1 every Lambda-bearing
  // stack has an asset manifest, so the fallback is mostly defensive.
  const cdkOutDir = stack.assetManifestPath ? dirname(stack.assetManifestPath) : process.cwd();

  const abs = isAbsolute(assetPath) ? assetPath : resolve(cdkOutDir, assetPath);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' asset directory '${abs}' does not exist or is not a directory. ` +
        'Re-synthesize the app and retry.'
    );
  }
  return abs;
}

/**
 * Resolve a Lambda's `Properties.Layers` references to local asset
 * directories (PR 6 of #224, issue #232).
 *
 * Each entry in the synthesized template is an intrinsic pointing at an
 * `AWS::Lambda::LayerVersion` resource in the same stack — most commonly
 * `{Ref: '<LayerLogicalId>'}` (which CDK uses for `LayerVersion.layerArn`)
 * or `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}`. Once we have the
 * layer's logical ID we look up its `aws:asset:path` Metadata the same
 * way function code is located (the layer asset is unzipped under
 * `cdk.out/asset.<hash>/` ready to bind-mount).
 *
 * **Order is preserved**: `Properties.Layers` is iterated left-to-right
 * and the resulting `ResolvedLambdaLayer[]` carries the same order. The
 * caller (`local-invoke.ts`'s `materializeLambdaLayers` and
 * `local-start-api.ts`'s server-boot pre-merge) `cpSync`-merges every
 * entry into one host tmpdir in template order to honor AWS's
 * "last-layer-wins" file-collision semantics — Docker rejects multiple
 * bind mounts at the same target so cdkd cannot rely on overlay
 * layering.
 *
 * **Out of scope (hard-errors)**:
 *
 *   - Literal ARN strings (`arn:aws:lambda:...`) — these are external /
 *     pre-existing layers (no asset on disk to mount) including
 *     cross-account / cross-region.
 *   - Same-stack refs that don't point at an `AWS::Lambda::LayerVersion`
 *     resource — almost always a typo'd logical ID.
 *   - Same-stack refs to a `LayerVersion` whose `Metadata['aws:asset:path']`
 *     is missing — the layer's content is `S3Bucket` / `S3Key` from
 *     outside cdk.out and there's no local directory to bind-mount.
 */
export function resolveLambdaLayers(
  stack: StackInfo,
  logicalId: string,
  props: Record<string, unknown>
): ResolvedLambdaLayer[] {
  const layers = props['Layers'];
  if (layers === undefined) return [];
  if (!Array.isArray(layers)) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has a non-array Layers property. Expected an array of LayerVersion references.`
    );
  }
  if (layers.length === 0) return [];

  const resources = stack.template.Resources ?? {};
  const out: ResolvedLambdaLayer[] = [];
  for (let i = 0; i < layers.length; i++) {
    const entry: unknown = layers[i];
    const layerLogicalId = pickLayerLogicalId(entry);
    if (!layerLogicalId) {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' has a Layers entry [${i}] cdkd cannot resolve locally: ${describeLayerEntry(entry)}. ` +
          'Only same-stack Ref / Fn::GetAtt to an AWS::Lambda::LayerVersion are supported in v1; ' +
          'cross-account / cross-region / pre-existing-ARN layers are deferred to a follow-up PR.'
      );
    }

    const layerResource = resources[layerLogicalId];
    if (!layerResource) {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' Layers entry [${i}] references '${layerLogicalId}', ` +
          `but no resource with that logical ID exists in stack '${stack.stackName}'.`
      );
    }
    if (layerResource.Type !== 'AWS::Lambda::LayerVersion') {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' Layers entry [${i}] references '${layerLogicalId}' (${layerResource.Type}), ` +
          'which is not an AWS::Lambda::LayerVersion.'
      );
    }

    const assetPath = resolveAssetCodePath(stack, layerLogicalId, layerResource);
    out.push({ logicalId: layerLogicalId, assetPath });
  }
  return out;
}

/**
 * Walk a single Layers-array entry and return the referenced layer's
 * logical ID — or `undefined` for shapes we don't try to resolve in v1.
 *
 * Accepted shapes (what CDK actually synthesizes):
 *   - `{Ref: '<LayerLogicalId>'}`
 *   - `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}` (rare; LayerVersion's
 *     Ref form is usually emitted as a flat `Ref`)
 */
function pickLayerLogicalId(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const obj = entry as Record<string, unknown>;
  if (typeof obj['Ref'] === 'string') return obj['Ref'];
  if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') return arg[0];
    if (typeof arg === 'string') return arg.split('.')[0];
  }
  return undefined;
}

/**
 * Stringify a Layers-array entry for use in error messages. Truncates
 * literal ARNs to a short form so the message stays one-line.
 */
function describeLayerEntry(entry: unknown): string {
  if (typeof entry === 'string') return `literal ARN '${entry}'`;
  if (entry === null) return 'null';
  if (typeof entry !== 'object') return String(entry);
  try {
    const json = JSON.stringify(entry);
    return json.length > 120 ? json.substring(0, 117) + '...' : json;
  } catch {
    return Object.prototype.toString.call(entry);
  }
}

/**
 * Build a "target not found" error that lists every Lambda function in
 * the resolved stack so the user can copy/paste a valid target. Mirrors
 * the format the issue spec calls out.
 */
function notFoundError(
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): LocalInvokeResolutionError {
  const lambdas: { displayPath: string; logicalId: string }[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const meta = resource.Metadata;
    const cdkPath = typeof meta?.['aws:cdk:path'] === 'string' ? meta['aws:cdk:path'] : '';
    lambdas.push({ displayPath: cdkPath || logicalId, logicalId });
  }

  let msg = `target '${target}' did not match any Lambda function in ${stack.stackName}.\n\n`;
  if (lambdas.length === 0) {
    msg += `Stack ${stack.stackName} has no Lambda functions.`;
  } else {
    const width = Math.max(...lambdas.map((l) => l.displayPath.length));
    msg += `Available Lambda functions in ${stack.stackName}:\n`;
    for (const l of lambdas) {
      msg += `  ${l.displayPath.padEnd(width)}  (${l.logicalId})\n`;
    }
  }
  return new LocalInvokeResolutionError(msg.trimEnd());
}
