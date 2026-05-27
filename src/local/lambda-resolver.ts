import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';
import { derivePseudoParametersFromRegion, tryResolveImageFnJoin } from './intrinsic-image.js';
import { stringifyValue } from '../utils/stringify.js';

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
  /**
   * `Properties.EphemeralStorage.Size` (issue #440). CDK 2.x's
   * `lambda.Function({ ephemeralStorageSize: cdk.Size.gibibytes(N) })`
   * synthesizes `Properties.EphemeralStorage: { Size: <N * 1024> }`
   * — the value is the templated `/tmp` cap in **MiB** (CFn property
   * range 512..10240). Threaded through to docker's `--tmpfs
   * /tmp:rw,size=<N>m` so handlers that exceed the deployed cap fail
   * locally with `ENOSPC` the way they would on AWS, and handlers
   * that detect free space via `statvfs` / `df` see the templated
   * size rather than the host's overlay-fs.
   *
   * Undefined when `Properties.EphemeralStorage` is absent — the
   * container's `/tmp` is then whatever the base image provides (AWS
   * Lambda base images don't mount a sized tmpfs themselves, so this
   * preserves the pre-#440 behavior). Applies to both ZIP and IMAGE
   * Lambdas — `--tmpfs` overlays inside container Lambdas just like
   * it does on the public base images.
   */
  ephemeralStorageMb?: number;
}

/**
 * One entry of a Lambda's resolved `Properties.Layers`. Two shapes:
 *
 *   - `kind: 'asset'` — same-stack `AWS::Lambda::LayerVersion`
 *     reference (the original PR 6 path). `assetPath` is the absolute
 *     directory under `cdk.out` ready to bind-mount at `/opt`.
 *   - `kind: 'arn'` — pre-existing literal-ARN entry the CDK template
 *     points at directly (AWS Lambda Powertools, Datadog Extension,
 *     shared internal layers, cross-account / cross-region references).
 *     The layer ZIP is NOT yet on disk; the CLI materializes it via
 *     `materializeLayerFromArn(...)` (issue #448) right before the
 *     docker container starts. Carrying the parsed ARN fields here
 *     keeps the resolver pure-functional (no AWS SDK calls) and lets
 *     the materializer be tested independently.
 */
export type ResolvedLambdaLayer = ResolvedAssetLambdaLayer | ResolvedArnLambdaLayer;

export interface ResolvedAssetLambdaLayer {
  kind: 'asset';
  /**
   * CFn logical ID of the `AWS::Lambda::LayerVersion` resource.
   * Shared field name with the `kind: 'arn'` variant so callers can
   * read a uniform identifier without first narrowing the union.
   */
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

export interface ResolvedArnLambdaLayer {
  kind: 'arn';
  /**
   * Pseudo-logical-id for log lines — set to the literal ARN so
   * iteration code like `layers.map((l) => l.logicalId)` works
   * uniformly across both variants without per-kind narrowing.
   */
  logicalId: string;
  /**
   * Full literal ARN as it appeared in the template
   * (`arn:aws:lambda:<region>:<account>:layer:<name>:<version>`). Kept
   * verbatim alongside `logicalId` because callers (the materializer)
   * need the canonical ARN string for SDK calls and the per-kind
   * branch is the only place where the difference matters.
   */
  arn: string;
  /** Region segment extracted from the ARN (e.g. `us-east-1`). */
  region: string;
  /** Account ID segment extracted from the ARN (12 digits). */
  accountId: string;
  /** Layer name segment (the `:layer:<name>:` middle). */
  name: string;
  /** Numeric version segment, as a string for `LayerName:Version` joins. */
  version: string;
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

  return extractLambdaProperties(stack, logicalId, resource, resources);
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
  resource: TemplateResource,
  resources: Record<string, TemplateResource>
): ResolvedLambda {
  const props = resource.Properties ?? {};
  const memoryMb = typeof props['MemorySize'] === 'number' ? props['MemorySize'] : 128;
  const timeoutSec = typeof props['Timeout'] === 'number' ? props['Timeout'] : 3;
  const ephemeralStorageMb = extractEphemeralStorageMb(props, logicalId);

  const code = (props['Code'] ?? {}) as Record<string, unknown>;
  const imageUri = extractImageUri(
    code['ImageUri'],
    logicalId,
    stack.stackName,
    resources,
    stack.region
  );

  if (imageUri !== undefined) {
    return extractImageLambdaProperties({
      stack,
      logicalId,
      resource,
      memoryMb,
      timeoutSec,
      props,
      imageUri,
      // Spread-and-omit so the optional field stays optional at the
      // callee under `exactOptionalPropertyTypes` — passing `undefined`
      // for `ephemeralStorageMb?: number` would be a type error.
      ...(ephemeralStorageMb !== undefined && { ephemeralStorageMb }),
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
    ...(ephemeralStorageMb !== undefined && { ephemeralStorageMb }),
    ...(inlineCode !== undefined && { inlineCode }),
  };
}

/**
 * Parse `Properties.EphemeralStorage.Size` (issue #440). CFn shape:
 * `{ EphemeralStorage: { Size: <MiB> } }`. CDK's
 * `cdk.Size.gibibytes(N)` serializes to `N * 1024`. AWS-side range is
 * 512..10240 MiB (the deployed function rejects anything outside that
 * range at create time); cdkd rejects > 10240 here so a misconfigured
 * template fails fast at `cdkd local invoke` boot rather than hanging
 * on a `docker run` that AWS would have refused anyway. The 512 floor
 * is AWS's minimum (the default when `EphemeralStorage` is omitted is
 * also 512), but we deliberately accept values DOWN to 1 so users can
 * exercise the cap with a deliberately-small `/tmp` in local tests —
 * `--tmpfs /tmp:size=Nm` itself enforces no lower bound; the only
 * cross-check is "would AWS accept this?", which the deploy side
 * already gates upstream.
 *
 * Returns `undefined` when the property is absent, NaN, < 1, or
 * non-numeric. Hard-rejects > 10240. Intrinsic-valued sizes (the
 * `{ Ref: 'SomeParam' }` shape that's uncommon for EphemeralStorage
 * but theoretically valid) drop to `undefined` with a one-line warn
 * via the calling logger — local invoke can't resolve those without
 * the template's Parameters context the deploy engine has, and the
 * fallback (no `--tmpfs`) is safer than guessing.
 */
export function extractEphemeralStorageMb(
  props: Record<string, unknown>,
  logicalId: string
): number | undefined {
  const raw = props['EphemeralStorage'];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const size = (raw as Record<string, unknown>)['Size'];
  if (typeof size !== 'number') {
    // Intrinsic-valued or otherwise unresolvable. Drop silently and
    // leave `--tmpfs` off — the deploy side enforces the real range
    // upstream. The `logicalId` argument is kept for parity with the
    // sibling extractors (so a future audit can grep call sites).
    void logicalId;
    return undefined;
  }
  if (!Number.isFinite(size) || size < 1) return undefined;
  if (size > 10240) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has Properties.EphemeralStorage.Size = ${size} MiB, ` +
        'which exceeds the AWS limit of 10240 MiB. AWS would reject the function at deploy time; ' +
        'cap the value to <= 10240 (10 GiB) and retry.'
    );
  }
  // CFn templates may carry fractional MiB values (unusual, but the
  // type is `number`). docker's `--tmpfs size=...m` parser accepts
  // integers only — round down to the nearest MiB to be safe; the
  // worst-case effect is a slightly smaller `/tmp` than templated,
  // which still surfaces the ENOSPC the user wants to catch.
  return Math.floor(size);
}

/**
 * Extract the `Code.ImageUri` value across the shapes CDK actually synthesizes.
 *
 * Supported shapes:
 *
 *   1. Flat string — pass through.
 *   2. `Fn::Sub` (string or `[template, vars]`) — the canonical asset
 *      shape for `lambda.DockerImageCode.fromImageAsset(...)`. The
 *      `${AWS::*}` placeholders survive and are substituted at the
 *      cdk-assets lookup site. Critical bug fix C1 from the PR 5 design
 *      doc: CDK synthesizes
 *      `{Fn::Sub: '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}:<hash>'}`,
 *      NOT a flat string. The hash-extraction regex in the asset
 *      manifest loader works against the substituted form.
 *   3. `Fn::Join` (canonical CDK 2.x shape for
 *      `lambda.DockerImageCode.fromEcr(repo, { tagOrDigest })`) — see
 *      [src/local/intrinsic-image.ts](./intrinsic-image.ts), `tryResolveImageFnJoin`.
 *      For IMPORTED repositories (literal acct-id / region + `Ref:
 *      AWS::URLSuffix` + literal repo path) the resolver returns a
 *      complete ECR URI here without state. For SAME-STACK references
 *      the resolver needs cdkd state (`--from-state`) to recover the
 *      repository's account-id / region; without state we surface a
 *      clear error pointing the user at `cdkd local invoke --from-state`
 *      / `ContainerImage.fromAsset` / a public-image alternative.
 *
 * Throws `LocalInvokeResolutionError` for `Fn::Join` shapes the resolver
 * recognizes as ECR-shape-needing-state OR malformed; returns `undefined`
 * for genuinely unrecognized shapes so the caller's downstream ZIP-vs-
 * IMAGE branching can route to its existing error path.
 */
function extractImageUri(
  value: unknown,
  logicalId: string,
  stackName: string,
  resources: Record<string, TemplateResource>,
  region: string | undefined
): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sub = obj['Fn::Sub'];
    if (typeof sub === 'string' && sub.length > 0) return sub;
    // Fn::Sub array form: [template, vars]. The first element is the template.
    if (Array.isArray(sub) && typeof sub[0] === 'string') return sub[0];

    // `Fn::Join` — try the shared ECR-URI resolver. Issue #637 plumbed
    // region-derived pseudo parameters (`urlSuffix` / `partition` /
    // `region`) through here so the canonical
    // `lambda.DockerImageCode.fromImageAsset` shape (only intrinsic in
    // the URI is `${AWS::URLSuffix}`) resolves without `--from-state`.
    // Same-stack ECR refs still return `needs-state`; a Join that
    // genuinely references `${AWS::AccountId}` without state returns
    // `not-applicable` with a more specific error.
    if ('Fn::Join' in obj) {
      const pseudoParameters = derivePseudoParametersFromRegion(region);
      const joinResolved = tryResolveImageFnJoin(
        value,
        resources,
        pseudoParameters ? { pseudoParameters } : undefined
      );
      if (joinResolved.kind === 'resolved') return joinResolved.uri;
      if (joinResolved.kind === 'needs-state') {
        throw new LocalInvokeResolutionError(
          `Lambda '${logicalId}' in ${stackName} references same-stack ECR repository '${joinResolved.repoLogicalId}' via Fn::Join. ` +
            'cdkd local invoke cannot resolve the repository URI without state — ' +
            'deploy the stack first (so cdkd records the repository physical id), ' +
            'rebuild via lambda.DockerImageCode.fromImageAsset, or pin a public image.'
        );
      }
      if (joinResolved.kind === 'unsupported-join') {
        throw new LocalInvokeResolutionError(
          `Lambda '${logicalId}' in ${stackName} has an unsupported Fn::Join Code.ImageUri shape: ${joinResolved.reason}. ` +
            'cdkd local invoke recognizes the canonical CDK 2.x lambda.DockerImageCode.fromEcr Fn::Join shape ' +
            '(delimiter "" with nested Fn::Select/Fn::Split over an ECR Repository Arn GetAtt + Ref to the repo).'
        );
      }
      // `not-applicable` — Join couldn't reduce every element AND no
      // same-stack ECR Repository ref. With #637's pseudo-parameter
      // plumbing the typical remaining cause is `${AWS::AccountId}`
      // (needs an STS call or `--from-state`) or an unknown region.
      const accountIdHint = pseudoParameters
        ? ' (likely \\${AWS::AccountId}, which cdkd cannot derive without --from-state or STS)'
        : ` (cdkd could not derive AWS pseudo parameters because stack.region was undefined)`;
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' in ${stackName} has an Fn::Join Code.ImageUri that cdkd local invoke cannot resolve${accountIdHint}. ` +
          'Workarounds: deploy first and run with --from-state, or pin a fully-literal public image URI.'
      );
    }
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
  ephemeralStorageMb?: number;
  props: Record<string, unknown>;
  imageUri: string;
}): ResolvedImageLambda {
  const { stack, logicalId, resource, memoryMb, timeoutSec, ephemeralStorageMb, props, imageUri } =
    args;

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
    ...(ephemeralStorageMb !== undefined && { ephemeralStorageMb }),
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
 * **Same-stack handling** (`{Ref: <Id>}` / `{Fn::GetAtt: [<Id>, 'Ref']}`):
 *
 *   - Refs that don't point at an `AWS::Lambda::LayerVersion` resource
 *     hard-error — almost always a typo'd logical ID.
 *   - Refs to a `LayerVersion` whose `Metadata['aws:asset:path']` is
 *     missing hard-error — the layer's content is `S3Bucket` / `S3Key`
 *     from outside cdk.out and there's no local directory to bind-mount.
 *
 * **Literal-ARN handling** (issue #448): entries shaped like the string
 * `arn:aws:lambda:<region>:<account>:layer:<name>:<version>` are parsed
 * into a `{kind: 'arn', ...}` resolved layer. The actual
 * `lambda:GetLayerVersion` + presigned-URL download + unzip happens
 * later in the CLI (`materializeLayerFromArn(...)`), which can optionally
 * `sts:AssumeRole` into the layer's account when the dev's default
 * credentials cannot read it. Covers AWS-published public layers (Lambda
 * Powertools, Datadog Extension, etc.) and cross-account / cross-region
 * shared layers.
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

    // Literal-ARN entry (issue #448) — recognized before the
    // logical-ID lookup so users who reference AWS-published layers
    // (Lambda Powertools etc.) or cross-account / cross-region shared
    // layers bypass the same-stack resource scan.
    if (typeof entry === 'string') {
      const parsed = parseLayerVersionArn(entry);
      if (!parsed) {
        throw new LocalInvokeResolutionError(
          `Lambda '${logicalId}' has a Layers entry [${i}] cdkd cannot resolve locally: literal string '${entry}'. ` +
            'Expected a same-stack Ref / Fn::GetAtt to an AWS::Lambda::LayerVersion ' +
            'OR a literal layer-version ARN of the form ' +
            'arn:aws:lambda:<region>:<account>:layer:<name>:<version>.'
        );
      }
      out.push({ kind: 'arn', logicalId: parsed.arn, ...parsed });
      continue;
    }

    const layerLogicalId = pickLayerLogicalId(entry);
    if (!layerLogicalId) {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' has a Layers entry [${i}] cdkd cannot resolve locally: ${describeLayerEntry(entry)}. ` +
          'Expected a same-stack Ref / Fn::GetAtt to an AWS::Lambda::LayerVersion ' +
          'OR a literal layer-version ARN of the form ' +
          'arn:aws:lambda:<region>:<account>:layer:<name>:<version>.'
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
    out.push({ kind: 'asset', logicalId: layerLogicalId, assetPath });
  }
  return out;
}

/**
 * Parse a Lambda layer-version ARN string into its segments.
 *
 * Returns `undefined` for anything that does not match the strict
 * `arn:aws:lambda:<region>:<account>:layer:<name>:<version>` shape so
 * the caller can produce a clearer error than a silent
 * misinterpretation of hand-edited templates. The partition segment
 * accepts `aws` / `aws-cn` / `aws-us-gov` so GovCloud / China-region
 * ARNs work without code changes.
 *
 * Exported for unit testing.
 */
export function parseLayerVersionArn(
  input: string
): { arn: string; region: string; accountId: string; name: string; version: string } | undefined {
  // Region segment accepts up to two interior `<word>-` chunks before
  // the numeric suffix so GovCloud (`us-gov-west-1`) / China
  // (`cn-north-1`) / standard (`us-east-1`) regions all match.
  const m =
    /^arn:(aws|aws-cn|aws-us-gov):lambda:([a-z]{2}-(?:[a-z]+-){1,2}\d+):(\d{12}):layer:([A-Za-z0-9_-]+):(\d+)$/.exec(
      input
    );
  if (!m) return undefined;
  return {
    arn: input,
    region: m[2]!,
    accountId: m[3]!,
    name: m[4]!,
    version: m[5]!,
  };
}

/**
 * Walk a single Layers-array entry and return the referenced layer's
 * logical ID — or `undefined` for shapes we don't try to resolve in v1.
 *
 * Accepted shapes (what CDK actually synthesizes — JSON-only):
 *   - `{Ref: '<LayerLogicalId>'}`
 *   - `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}` (rare; LayerVersion's
 *     Ref form is usually emitted as a flat `Ref`)
 *
 * Intentionally **rejected**: the YAML-only string form
 * `{Fn::GetAtt: '<LogicalId>.<attr>'}`. CloudFormation YAML accepts the
 * dot-shorthand and converts it to the array form on the wire, but
 * CloudFormation JSON (the output of `cdk synth`, which is the only
 * thing cdkd ingests) never emits the string form. Treating it as
 * resolvable here would silently accept hand-edited / malformed templates
 * that no real CDK flow can produce; instead we fall through to the
 * standard "cdkd cannot resolve this Layers entry locally" error so the
 * user sees the offending shape called out.
 */
function pickLayerLogicalId(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const obj = entry as Record<string, unknown>;
  if (typeof obj['Ref'] === 'string') return obj['Ref'];
  if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') return arg[0];
    // Deliberately not: `if (typeof arg === 'string') return arg.split('.')[0]`.
    // See docstring above — the string form is YAML-only and CFn JSON
    // never emits it.
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
  if (typeof entry !== 'object') return stringifyValue(entry);
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
