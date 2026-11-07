import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import { derivePseudoParametersFromRegion, tryResolveImageFnJoin } from '../intrinsic-image.js';
import {
  LocalInvokeResolutionError,
  type ResolvedImageLambda,
  type ResolvedLambda,
} from './types.js';
import { resolveAssetCodePath } from './asset-code.js';
import { resolveLambdaLayers } from './layers.js';

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
export function extractLambdaProperties(
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

  const architecture = extractArchitecture(props, logicalId);

  return {
    kind: 'zip',
    stack,
    logicalId,
    resource,
    runtime,
    handler,
    memoryMb,
    timeoutSec,
    architecture,
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
        ? ' (likely ${AWS::AccountId}, which cdkd cannot derive without --from-state or STS)'
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
 * Parse `Properties.Architectures` into the single arch cdkd threads to
 * `--platform`. CFn types it as an array, but CDK / Lambda allow exactly
 * one entry; default `x86_64` matches the AWS-side default when the
 * property is absent. Shared by BOTH the ZIP and IMAGE variants (issue
 * #768) so the ZIP container run pins `--platform` the same way the IMAGE
 * path always has.
 */
function extractArchitecture(
  props: Record<string, unknown>,
  logicalId: string
): 'x86_64' | 'arm64' {
  const arches = props['Architectures'];
  if (Array.isArray(arches) && arches.length > 0) {
    const first: unknown = arches[0];
    if (first === 'arm64') return 'arm64';
    if (first === 'x86_64') return 'x86_64';
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has unsupported Architectures value '${String(first)}'. ` +
        'cdkd local invoke supports x86_64 and arm64.'
    );
  }
  return 'x86_64';
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

  const architecture = extractArchitecture(props, logicalId);

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
