import { EcsTaskResolutionError } from 'cdk-local/internal';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import {
  hasEcrRegistryHostLabels,
  looksLikeEcrHostWithForeignSuffix,
  parseEcrRegistryHost,
} from '../../utils/ecr-uri.js';
import { getLogger } from '../../utils/logger.js';
import { substituteImagePlaceholders, tryResolveImageFnJoin } from '../intrinsic-image.js';
import type { ResolvedEcsTask, ResolvedEcsImage, EcsImageResolutionContext } from './types.js';

/**
 * A container-image URI that points at a CDK-bootstrap OR cdkd-owned assets
 * ECR repository:
 *
 *   - `cdk-<qualifier>-container-assets-<acct>-<region>` — the CDK bootstrap
 *     repo (default qualifier `hnb659fds`, or a custom `cdk bootstrap
 *     --qualifier` value);
 *   - `cdkd-container-assets-<acct>-<region>` — the repo `cdkd bootstrap`
 *     creates and `cdkd deploy` publishes into once a bootstrap marker exists
 *     (issue #1002; a migrated stack's template / `--from-state` state carries
 *     this shape).
 *
 * Either is a CDK asset image the ECS runner resolves back to the on-disk
 * `cdk.out` build, so both must classify as `kind: 'cdk-asset'`. The `cdk-`
 * qualifier is generalized to `[a-z0-9]+` so a custom-qualifier bootstrap is
 * matched too (previously only the hardcoded `hnb659fds` default was).
 *
 * Since `cdkd bootstrap --container-repo <name>` (issue #1011) the
 * cdkd-owned repo can carry ANY name — the per-region bootstrap marker is
 * the source of truth. The regex therefore cannot recognize images
 * published to a custom-named repo; `isCdkAssetImageUri` additionally
 * matches an ECR-hosted URI whose repository path component equals the
 * marker-resolved name when the caller supplies it (issue #1025). The
 * regex stays as the no-marker fallback — `cdkd local run-task` can run
 * without AWS access, where no marker read is possible.
 */
export const CDK_ASSET_IMAGE_REPO_RE = /(?:cdk-[a-z0-9]+|cdkd)-container-assets-/;

/**
 * Extract the repository path component of an ECR-hosted image URI.
 *
 * The host part (before the first `/`) must carry an ECR form's label run
 * (`hasEcrRegistryHostLabels`, issue #1846: plain, FIPS or dual-stack, any
 * case) — this tolerates both concrete hosts
 * (`123456789012.dkr.ecr.us-east-1.amazonaws.com`) and placeholder-bearing
 * hosts (`${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}`). The repo
 * component is the substring after the first `/`, stripped of a trailing
 * `@<digest>` (first `@`) and then a trailing `:<tag>` (last `:` — ECR
 * repo names cannot contain `:` but CAN contain `/`, so the last colon is
 * the tag separator). Stripping the digest FIRST handles the combined
 * `name:tag@digest` form Docker accepts. Returns `undefined` for non-ECR
 * hosts and empty results.
 */
export function extractEcrRepoComponent(uri: string): string | undefined {
  const slash = uri.indexOf('/');
  if (slash <= 0) return undefined;
  const host = uri.slice(0, slash);
  if (!hasEcrRegistryHostLabels(host)) return undefined;
  let repo = uri.slice(slash + 1);
  const at = repo.indexOf('@');
  if (at !== -1) repo = repo.slice(0, at);
  const colon = repo.lastIndexOf(':');
  if (colon !== -1) repo = repo.slice(0, colon);
  return repo.length > 0 ? repo : undefined;
}

/**
 * True when `uri` embeds a CDK-bootstrap or cdkd-owned container-assets
 * repo — either via the conventional-name regex, or (issue #1025) via an
 * exact match between the URI's ECR repository path component and the
 * bootstrap-marker-resolved `cdkAssetContainerRepo` name, which covers
 * regions bootstrapped with `cdkd bootstrap --container-repo <name>`.
 */
function isCdkAssetImageUri(uri: string, cdkAssetContainerRepo?: string): boolean {
  if (CDK_ASSET_IMAGE_REPO_RE.test(uri)) return true;
  if (cdkAssetContainerRepo === undefined) return false;
  return extractEcrRepoComponent(uri) === cdkAssetContainerRepo;
}

/**
 * Parse the `Image` field of an ECS container definition.
 *
 * Three shapes:
 *   - `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` — an ECR image
 *     URI. Cross-account and cross-region are BOTH supported; see the #455
 *     paragraph below for how each is authenticated.
 *   - `Fn::Sub` / `Fn::Join` / `Ref` referencing a `Code.fromAsset`-style
 *     CDK asset image. Surfaces `kind: 'cdk-asset'` with the optional
 *     asset hash so the runner can route through `docker-build.ts`.
 *   - Any other public URI (`public.ecr.aws/...`, `docker.io/...`,
 *     `nginx:latest`, etc.) — `kind: 'public'`, runner does a `docker pull`.
 *
 * Two-tier substitution (issue #264):
 *   - **Tier 1** — when `context.pseudoParameters` is populated, AWS pseudo
 *     parameters in `Fn::Sub` bodies (`${AWS::AccountId}` / `${AWS::Region}` /
 *     `${AWS::Partition}` / `${AWS::URLSuffix}`) are substituted before
 *     regex matching. The CLI resolves these via STS + region env once
 *     per invocation.
 *   - **Tier 2** — when `context.stateResources` is populated
 *     (`--from-state`), `${<LogicalId>}` placeholders that resolve to an
 *     `AWS::ECR::Repository` are substituted with the state-recorded
 *     `physicalId`, and `Fn::GetAtt: [<Repo>, 'RepositoryUri']` shapes
 *     are resolved via the same state record.
 *
 * Cross-account / cross-region pull (#455): `pullEcrImage` auto-detects
 * cross-account from `sts:GetCallerIdentity` and authenticates against
 * the URI's region directly. Pass `--ecr-role-arn <arn>` when the caller
 * does not already have cross-account `ecr:GetAuthorizationToken` /
 * `ecr:BatchGetImage` access on the target repository.
 */
export function parseContainerImage(
  raw: unknown,
  containerName: string,
  taskLogicalId: string,
  resources: Record<string, TemplateResource>,
  _stack: StackInfo,
  context?: EcsImageResolutionContext
): ResolvedEcsImage {
  // Tier 2: handle `Fn::GetAtt: [<Repo>, 'RepositoryUri']` directly — it
  // produces a complete `<acct>.dkr.ecr.<region>.amazonaws.com/<name>` URI
  // we can match against the ECR regex below. The tag is whatever the
  // template provides; for the bare GetAtt shape there is none, which is
  // unusual but we surface the resulting tagless URI rather than guess.
  const getAttImage = tryResolveImageGetAtt(raw, resources, context);
  if (getAttImage?.kind === 'resolved') {
    return classifyResolvedImage(getAttImage.uri, context?.cdkAssetContainerRepo);
  }
  if (getAttImage?.kind === 'needs-state') {
    return sameStackEcrImage(containerName, taskLogicalId, getAttImage.repoLogicalId);
  }

  // Issue #271: CDK 2.x synthesizes `ContainerImage.fromEcrRepository(repo)`
  // as a `Fn::Join` that builds the ECR URI from nested `Fn::Select` /
  // `Fn::Split` over the repository's `Arn` GetAtt plus a `Ref` to the
  // repo and `Ref: AWS::URLSuffix`. The repository's account-id and
  // region only exist in cdkd's S3 state (set at deploy time), so this
  // shape inherently requires `--from-state` (Tier 2).
  const joinResolved = tryResolveImageFnJoin(raw, resources, context);
  if (joinResolved.kind === 'resolved') {
    return classifyResolvedImage(joinResolved.uri, context?.cdkAssetContainerRepo);
  }
  if (joinResolved.kind === 'needs-state') {
    return sameStackEcrImage(
      containerName,
      taskLogicalId,
      joinResolved.repoLogicalId,
      ' via Fn::Join'
    );
  }
  if (joinResolved.kind === 'unsupported-join') {
    throw new EcsTaskResolutionError(
      `Container '${containerName}' in task '${taskLogicalId}' has an unsupported Fn::Join Image shape: ${joinResolved.reason}. ` +
        'cdkd local run-task recognizes the canonical CDK 2.x ContainerImage.fromEcrRepository Fn::Join shape ' +
        '(delimiter "" with nested Fn::Select/Fn::Split over an ECR Repository Arn GetAtt + Ref to the repo).'
    );
  }

  const flat = extractImageString(raw);
  if (!flat) {
    throw new EcsTaskResolutionError(
      `Container '${containerName}' in task '${taskLogicalId}' has an unparseable Image property. ` +
        'cdkd local run-task v1 supports flat string images, single-key Fn::Sub bodies, and CDK-asset Image references.'
    );
  }

  // CDK asset shape: contains a CDK-bootstrap or cdkd-owned container-assets
  // repo, or targets the marker-named custom repo when the CLI resolved one
  // (see `isCdkAssetImageUri`, issue #1025). The tail `:<hash>` is the asset
  // hash (same shape used by Lambda container images — see
  // `getDockerImageBySourceHash`).
  if (isCdkAssetImageUri(flat, context?.cdkAssetContainerRepo)) {
    const hashMatch = /:([a-f0-9]{8,})$/.exec(flat);
    const out: ResolvedEcsImage = { kind: 'cdk-asset' };
    if (hashMatch) out.assetHash = hashMatch[1]!;
    return out;
  }

  // Substitute pseudo parameters + same-stack ECR Ref placeholders into
  // the flat string when context is supplied. Pure string-rewrite —
  // unresolved placeholders pass through verbatim so the post-walk
  // diagnostics below can route to the precise error message.
  const substituted = substituteImagePlaceholders(flat, resources, context);

  // Unresolved `${...}` placeholders survived substitution. Surface a
  // precise hint BEFORE the ECR regex match — otherwise a leftover
  // `${MyRepo}` in the path portion would still match the host-portion
  // regex and silently produce a broken URI for `docker pull` to fail on.
  if (substituted.includes('${')) {
    const unresolvedRepoRef = findUnresolvedEcrRepositoryRef(substituted, resources);
    if (unresolvedRepoRef) {
      return sameStackEcrImage(containerName, taskLogicalId, unresolvedRepoRef);
    }
    if (substituted.includes('AWS::')) {
      throw new EcsTaskResolutionError(
        `Container '${containerName}' in task '${taskLogicalId}' has an Image that references AWS pseudo parameters (${substituted}). ` +
          'cdkd could not resolve them: confirm AWS credentials are configured so STS GetCallerIdentity succeeds, ' +
          'and that --region / AWS_REGION names the target region. ' +
          'Workaround: build the image locally (ContainerImage.fromAsset) or pin a public image.'
      );
    }
    // Some other placeholder survived (e.g. a Parameter ref). Surface as
    // a generic resolver failure rather than letting it slip through as
    // a "public" image.
    throw new EcsTaskResolutionError(
      `Container '${containerName}' in task '${taskLogicalId}' has an Image with unresolved \${...} placeholders (${substituted}). ` +
        'cdkd local run-task v1 only resolves AWS pseudo parameters and same-stack AWS::ECR::Repository refs.'
    );
  }

  // Account-scoped ECR repo. The host suffix is DERIVED from the region via the
  // shared helper (issue #1758) rather than matched against a hardcoded
  // `amazonaws.com`: outside the commercial partition the old pattern missed,
  // the image classified as `public`, and `ecs-task-runner`'s `case 'ecr'`
  // never ran -- so `cdkd local run-task` attempted an anonymous `docker pull`
  // with no `docker login`.
  const ecrHost = parseEcrRegistryHost(substituted);
  if (ecrHost) {
    return { kind: 'ecr', uri: substituted, account: ecrHost.accountId, region: ecrHost.region };
  }
  // An ECR-SHAPED host AWS does not serve for its region falls through to
  // `public` below, which means an anonymous pull and, for a real registry, an
  // opaque docker auth error. Saying so makes the partition-table gap (issue
  // #1764) diagnosable from cdkd's side rather than only docker's. Since issue
  // #3670 that also covers a form served only in other partitions (FIPS or
  // dual-stack outside aws / aws-us-gov) and a region cdkd does not know, so the
  // wording names the host, not only its suffix.
  if (looksLikeEcrHostWithForeignSuffix(substituted)) {
    getLogger()
      .child('ecs-task-resolver')
      .debug(
        `Image '${substituted}' has an ECR host shape, but that host form and suffix are ` +
          `not an ECR registry endpoint for its region; treating it as a public image (no docker login).`
      );
  }

  return { kind: 'public', uri: substituted };
}

/**
 * When the flat string still contains `${X}` after substitution, check
 * whether `X` (or `X.<attr>`) names a same-stack `AWS::ECR::Repository`.
 * Returns the logical ID of the offending repo for a precise error
 * message; `undefined` otherwise.
 */
function findUnresolvedEcrRepositoryRef(
  substituted: string,
  resources: Record<string, TemplateResource>
): string | undefined {
  const placeholderRegex = /\$\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = placeholderRegex.exec(substituted)) !== null) {
    const key = m[1]!;
    if (key.startsWith('AWS::')) continue;
    const dot = key.indexOf('.');
    const lid = dot === -1 ? key : key.slice(0, dot);
    if (resources[lid]?.Type === 'AWS::ECR::Repository') return lid;
  }
  return undefined;
}

/**
 * Classify a fully-substituted image URI (Tier 1 / Tier 2 produced a
 * concrete string) into the `ResolvedEcsImage` shape. Splits out so the
 * `Fn::GetAtt` path can share the regex-match branches.
 * `cdkAssetContainerRepo` is the optional marker-resolved custom repo
 * name (issue #1025) threaded through from the resolution context.
 */
function classifyResolvedImage(uri: string, cdkAssetContainerRepo?: string): ResolvedEcsImage {
  if (isCdkAssetImageUri(uri, cdkAssetContainerRepo)) {
    const hashMatch = /:([a-f0-9]{8,})$/.exec(uri);
    const out: ResolvedEcsImage = { kind: 'cdk-asset' };
    if (hashMatch) out.assetHash = hashMatch[1]!;
    return out;
  }
  // Same derivation as the sibling site above (issue #1758).
  const ecrHost = parseEcrRegistryHost(uri);
  if (ecrHost) {
    return { kind: 'ecr', uri, account: ecrHost.accountId, region: ecrHost.region };
  }
  return { kind: 'public', uri };
}

/**
 * The image for a same-stack ECR repository the resolver cannot turn into a
 * URI. Returned rather than thrown so `--image-override` can replace it;
 * {@link assertEcsTaskImagesResolvable} raises `unresolvedReason` for a
 * container no override covers (go-to-k/cdkd#5768).
 */
function sameStackEcrImage(
  containerName: string,
  taskLogicalId: string,
  repoLogicalId: string,
  via = ''
): ResolvedEcsImage {
  return {
    kind: 'same-stack-ecr',
    repoLogicalId,
    unresolvedReason:
      `Container '${containerName}' in task '${taskLogicalId}' references same-stack ECR repository '${repoLogicalId}'${via}. ` +
      'cdkd local run-task cannot resolve the repository URI without state — ' +
      'pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed), ' +
      'build via ContainerImage.fromAsset, pin a public image, or pass --image-override to build it from a local Dockerfile.',
  };
}

/**
 * Refuse a task whose container image is still a `same-stack-ecr` image no
 * `--image-override` covers (go-to-k/cdkd#5768, mirroring cdk-local's
 * `assertEcsTaskImagesResolvable`). `coveredContainers` names the containers
 * whose image an override replaces. Throws {@link EcsTaskResolutionError}
 * carrying each uncovered container's reason, before any network or container
 * exists.
 */
export function assertEcsTaskImagesResolvable(
  task: Pick<ResolvedEcsTask, 'containers'>,
  coveredContainers: ReadonlySet<string> | ReadonlyMap<string, unknown> = new Set()
): void {
  const reasons: string[] = [];
  for (const c of task.containers) {
    if (c.image.kind !== 'same-stack-ecr' || coveredContainers.has(c.name)) continue;
    reasons.push(c.image.unresolvedReason);
  }
  if (reasons.length > 0) throw new EcsTaskResolutionError(reasons.join('\n'));
}

/**
 * Handle the discrete `Fn::GetAtt: [<Repo>, 'RepositoryUri']` /
 * `'<Repo>.RepositoryUri'` shape against state-recorded resources. CDK
 * occasionally emits this instead of `Fn::Sub` when the user writes
 * `ContainerImage.fromEcrRepository(repo, tag)` and the tag is a literal.
 * Returns `resolved` with the state-recorded URI, `needs-state` for a
 * `RepositoryUri` the state does not carry (a same-stack pin
 * `--image-override` can cover), or `undefined` when the shape does not apply
 * (the caller falls through to `Fn::Sub` / `Fn::Join` / `Ref`).
 */
function tryResolveImageGetAtt(
  raw: unknown,
  resources: Record<string, TemplateResource>,
  context: EcsImageResolutionContext | undefined
): { kind: 'resolved'; uri: string } | { kind: 'needs-state'; repoLogicalId: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const arg = obj['Fn::GetAtt'];
  if (arg === undefined) return undefined;

  let logicalId: string | undefined;
  let attr: string | undefined;
  if (
    Array.isArray(arg) &&
    arg.length === 2 &&
    typeof arg[0] === 'string' &&
    typeof arg[1] === 'string'
  ) {
    logicalId = arg[0];
    attr = arg[1];
  } else if (typeof arg === 'string') {
    const dot = arg.indexOf('.');
    if (dot > 0 && dot < arg.length - 1) {
      logicalId = arg.slice(0, dot);
      attr = arg.slice(dot + 1);
    }
  }
  if (!logicalId || !attr) return undefined;

  const refResource = resources[logicalId];
  if (refResource?.Type !== 'AWS::ECR::Repository') return undefined;
  if (attr !== 'RepositoryUri' && attr !== 'Arn') return undefined;

  const cached = context?.stateResources?.[logicalId]?.attributes?.[attr];
  if (typeof cached === 'string' && cached.length > 0) return { kind: 'resolved', uri: cached };
  // A `RepositoryUri` GetAtt with no state-recorded value is the same
  // unresolvable same-stack pin as the `Fn::Join` shape. (`Arn` is not an
  // image URI, so it keeps falling through to the unparseable-Image error.)
  if (attr === 'RepositoryUri') return { kind: 'needs-state', repoLogicalId: logicalId };
  return undefined;
}

export function extractImageString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sub = obj['Fn::Sub'];
    if (typeof sub === 'string' && sub.length > 0) return sub;
    if (Array.isArray(sub) && typeof sub[0] === 'string') return sub[0];
    const join = obj['Fn::Join'];
    if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
      const sep = typeof join[0] === 'string' ? join[0] : '';
      const parts = (join[1] as unknown[])
        .map((p) => (typeof p === 'string' ? p : extractImageString(p)))
        .filter((p): p is string => p !== undefined);
      if (parts.length === (join[1] as unknown[]).length) return parts.join(sep);
    }
  }
  return undefined;
}

// `tryResolveImageFnJoin` (plus supporting helpers `findEcrRepositoryRefInTree` /
// `resolveImageIntrinsic` / `resolveImageIntrinsicAny`) and the
// `FnJoinResolveOutcome` type were extracted to `intrinsic-image.ts` so
// `lambda-resolver.ts` can reuse them for container Lambdas (`Code.ImageUri`).
// Both call sites import the shared helper at the top of their respective
// resolver. See issue #286 Gap 2 and PR #280 for the original ECS shape.
