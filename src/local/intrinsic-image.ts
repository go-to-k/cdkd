import type { ResourceState } from '../types/state.js';
import type { TemplateResource } from '../types/resource.js';

/**
 * Shared resolver for CFn intrinsic-function shapes that show up in
 * container-image URI fields — both ECS `ContainerDefinition.Image`
 * (`cdkd local run-task`) and Lambda `Code.ImageUri` (`cdkd local
 * invoke` container Lambdas). CDK 2.x synthesizes the same canonical
 * `Fn::Join` shape for `ContainerImage.fromEcrRepository(repo, tag)` and
 * `lambda.DockerImageCode.fromEcr(repo, { tagOrDigest })` — so both call
 * sites share the resolver.
 *
 * Originally introduced as a private helper inside `ecs-task-resolver.ts`
 * (PR #280 / issue #271) and extracted here when `lambda-resolver.ts`
 * needed the same shape (issue #286 Gap 2). The extraction keeps the two
 * call sites bit-identical so a future change in the canonical CDK shape
 * gets fixed once.
 *
 * Scope is intentionally narrow: the resolver only handles the subset of
 * intrinsics needed to reconstruct an ECR image URI. `Fn::If` /
 * `Fn::FindInMap` / etc. are out of scope — this is a minimal resolver
 * for image URIs, not a general-purpose deploy-time resolver.
 */

/**
 * Substitution context for `tryResolveImageFnJoin` and `substituteImagePlaceholders`.
 *
 * Both blocks are optional: `pseudoParameters` covers Tier 1 (no state
 * needed — works against the developer's shell creds / region for
 * `${AWS::Region}` / `${AWS::AccountId}` / `${AWS::URLSuffix}` /
 * `${AWS::Partition}`); `stateResources` covers Tier 2 (`--from-state`
 * — substitutes same-stack ECR `Ref` / `Fn::GetAtt: [<Repo>, 'Arn']`
 * against cdkd's recorded `physicalId` / `attributes`).
 *
 * The CLI command resolves both blocks lazily — STS is only invoked when
 * at least one image references the pseudo parameters — and passes the
 * resolved shape here. The resolver itself stays pure and synchronous.
 */
export interface ImageResolutionContext {
  /**
   * Resolved AWS pseudo parameters. When undefined for a given key, the
   * substitution is treated as missing and the value passes through
   * verbatim. Caller is expected to populate every key when it populates
   * any (we derive partition / URL suffix from region in the CLI layer).
   */
  pseudoParameters?: {
    accountId?: string;
    region?: string;
    partition?: string;
    urlSuffix?: string;
  };
  /**
   * `state.resources` from cdkd's S3 state record for the target stack,
   * loaded by the CLI command before resolution when `--from-state` is
   * passed. Used to substitute `${<LogicalId>}` against an
   * `AWS::ECR::Repository` and the `Fn::GetAtt` `Arn` / `RepositoryUri`
   * shapes. Undefined when `--from-state` is not in effect.
   */
  stateResources?: Record<string, ResourceState>;
}

/**
 * Derive the AWS pseudo parameters that are trivially knowable from the
 * deploy region alone, without any STS call or cdkd state load.
 * `urlSuffix` and `partition` follow the canonical AWS partition rules:
 *
 *   - region prefix `cn-*`        → partition `aws-cn`,     urlSuffix `amazonaws.com.cn`
 *   - region prefix `us-gov-*`    → partition `aws-us-gov`, urlSuffix `amazonaws.com`
 *   - region prefix `us-iso-*`    → partition `aws-iso`,    urlSuffix `c2s.ic.gov`
 *   - region prefix `us-isob-*`   → partition `aws-iso-b`,  urlSuffix `sc2s.sgov.gov`
 *   - everything else (`us-east-1` / `eu-west-2` / `ap-northeast-1` / etc.)
 *                                 → partition `aws`,        urlSuffix `amazonaws.com`
 *
 * `accountId` is optional pass-through (caller decides whether to populate
 * it). The bootstrap-ECR URI shape that `lambda.DockerImageCode.fromImageAsset`
 * synthesizes carries account-id + region as literal strings in the template,
 * so only `urlSuffix` / `partition` / `region` are required to resolve it
 * (issue #637).
 *
 * Returns `undefined` when `region` is undefined / empty so the caller can
 * fall through cleanly. The shape mirrors `ImageResolutionContext.pseudoParameters`
 * so the result drops straight into a context literal.
 */
export function derivePseudoParametersFromRegion(
  region: string | undefined,
  accountId?: string
): { accountId?: string; region: string; partition: string; urlSuffix: string } | undefined {
  if (!region || typeof region !== 'string' || region.length === 0) return undefined;
  let partition: string;
  let urlSuffix: string;
  if (region.startsWith('cn-')) {
    partition = 'aws-cn';
    urlSuffix = 'amazonaws.com.cn';
  } else if (region.startsWith('us-gov-')) {
    partition = 'aws-us-gov';
    urlSuffix = 'amazonaws.com';
  } else if (region.startsWith('us-isob-')) {
    partition = 'aws-iso-b';
    urlSuffix = 'sc2s.sgov.gov';
  } else if (region.startsWith('us-iso-')) {
    partition = 'aws-iso';
    urlSuffix = 'c2s.ic.gov';
  } else {
    partition = 'aws';
    urlSuffix = 'amazonaws.com';
  }
  return {
    ...(accountId !== undefined && { accountId }),
    region,
    partition,
    urlSuffix,
  };
}

/**
 * Outcome of attempting to resolve a `Fn::Join`-shaped image URI against
 * the substitution context. Discriminated so the caller can route each
 * case to the right error / classification path.
 */
export type FnJoinResolveOutcome =
  | { kind: 'not-applicable' }
  | { kind: 'resolved'; uri: string }
  | { kind: 'needs-state'; repoLogicalId: string }
  | { kind: 'unsupported-join'; reason: string };

/**
 * Resolve the canonical CDK 2.x `Fn::Join` shape emitted by
 * `ContainerImage.fromEcrRepository(repo, tag)` (ECS) and
 * `lambda.DockerImageCode.fromEcr(repo, { tagOrDigest })` (Lambda
 * container).
 *
 * The shape is a `Fn::Join` with delimiter `""` whose elements include
 * nested `Fn::Select` / `Fn::Split` over an `Fn::GetAtt: [<Repo>, 'Arn']`
 * plus a `Ref` to the same `AWS::ECR::Repository` and a
 * `Ref: AWS::URLSuffix`. For SAME-STACK references the account-id +
 * region only exist in cdkd's S3 state (recorded at deploy time on the
 * Repository's `Arn` attribute), so the resolver inherently requires
 * `--from-state` (Tier 2) for that variant. For IMPORTED repositories
 * the URI components are flat strings + `Ref: AWS::URLSuffix` and
 * resolve cleanly without state (Tier 1).
 *
 * Returns `not-applicable` when `raw` isn't an `Fn::Join` (the caller
 * falls through to its existing `Fn::Sub` / flat-string handling).
 * Returns `needs-state` when the `Fn::Join` references a same-stack ECR
 * Repository but no state was supplied (the caller surfaces a
 * `--from-state` hint). Returns `unsupported-join` when the join shape
 * doesn't fit the canonical CDK 2.x pattern (e.g. delimiter != "",
 * non-recognized nested intrinsic) so the caller can route to a precise
 * error.
 */
export function tryResolveImageFnJoin(
  raw: unknown,
  resources: Record<string, TemplateResource>,
  context: ImageResolutionContext | undefined
): FnJoinResolveOutcome {
  if (!raw || typeof raw !== 'object') return { kind: 'not-applicable' };
  const obj = raw as Record<string, unknown>;
  const arg = obj['Fn::Join'];
  if (arg === undefined) return { kind: 'not-applicable' };

  if (!Array.isArray(arg) || arg.length !== 2 || !Array.isArray(arg[1])) {
    return { kind: 'unsupported-join', reason: 'Fn::Join must be [delimiter, [elements]]' };
  }
  const [delimiter, elements] = arg as [unknown, unknown[]];
  if (typeof delimiter !== 'string') {
    return {
      kind: 'unsupported-join',
      reason: `Fn::Join delimiter must be a string, got ${typeof delimiter}`,
    };
  }

  // Find a same-stack ECR::Repository referenced by either a `Ref` or
  // `Fn::GetAtt` somewhere in the element tree. The presence of such a
  // reference is the load-bearing signal that this Fn::Join is an ECR
  // image URI (rather than an unrelated Join that happens to be the
  // Image field).
  const repoLogicalId = findEcrRepositoryRefInTree(elements, resources);

  const stateResources = context?.stateResources;
  if (repoLogicalId && !stateResources) {
    return { kind: 'needs-state', repoLogicalId };
  }

  // Walk every element through the generic intrinsic resolver. Any
  // unresolvable element aborts with `unsupported-join`.
  const parts: string[] = [];
  for (const element of elements) {
    const r = resolveImageIntrinsic(element, resources, context);
    if (r === undefined) {
      // No ECR Repository reference AND we could not produce a string —
      // this isn't a canonical CDK 2.x ECR Fn::Join. Surface
      // `not-applicable` so the caller falls back to its existing
      // flat-string / Fn::Sub path.
      if (!repoLogicalId) return { kind: 'not-applicable' };
      return {
        kind: 'unsupported-join',
        reason: 'one or more Fn::Join elements could not be resolved',
      };
    }
    parts.push(r);
  }

  return { kind: 'resolved', uri: parts.join(delimiter) };
}

/**
 * Walk a tree of intrinsic nodes and return the logical ID of the first
 * `AWS::ECR::Repository` referenced via `Ref` or `Fn::GetAtt`. Used to
 * detect whether a `Fn::Join` image shape is an ECR image URI (and so
 * needs Tier 2 / `--from-state` resolution).
 */
function findEcrRepositoryRefInTree(
  node: unknown,
  resources: Record<string, TemplateResource>
): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findEcrRepositoryRefInTree(item, resources);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;

  if (typeof obj['Ref'] === 'string') {
    const target = obj['Ref'];
    if (resources[target]?.Type === 'AWS::ECR::Repository') return target;
    return undefined;
  }

  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    let lid: string | undefined;
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') lid = getAtt[0];
    else if (typeof getAtt === 'string') lid = getAtt.split('.')[0];
    if (lid && resources[lid]?.Type === 'AWS::ECR::Repository') return lid;
    return undefined;
  }

  for (const value of Object.values(obj)) {
    const hit = findEcrRepositoryRefInTree(value, resources);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Generic recursive resolver for the intrinsic-function subset needed to
 * construct an ECR image URI from a `Fn::Join` tree. Handles:
 *
 *   - literal strings / numbers / booleans (returned as their string form)
 *   - `Ref: AWS::URLSuffix` / `AWS::Partition` / `AWS::Region` /
 *     `AWS::AccountId` against `context.pseudoParameters`
 *   - `Ref: <ECRRepoLogicalId>` against `context.stateResources` →
 *     `physicalId`
 *   - `Fn::GetAtt: [<ECRRepoLogicalId>, 'Arn'|'RepositoryUri']` against
 *     `context.stateResources.attributes`
 *   - `Fn::Split: [delimiter, str]` (where `str` resolves to a string)
 *   - `Fn::Select: [index, list]` (where `list` resolves to an array)
 *   - `Fn::Join: [delimiter, [elements]]` (recursive — each element
 *     resolved via this function)
 *   - `Fn::Sub: <template>` (string-replace via `substituteImagePlaceholders`)
 *
 * Returns `undefined` when any sub-resolution fails so the caller can
 * route the outer Fn::Join to `unsupported-join`. Deliberately tight
 * scope — `Fn::If` / `Fn::FindInMap` / etc. are out of scope here.
 */
function resolveImageIntrinsic(
  node: unknown,
  resources: Record<string, TemplateResource>,
  context: ImageResolutionContext | undefined
): string | undefined {
  const v = resolveImageIntrinsicAny(node, resources, context);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * Same resolver as `resolveImageIntrinsic` but returns the raw resolved
 * value (string / number / boolean / array of strings). Used by
 * `Fn::Select` over a `Fn::Split` (which produces a string[]).
 */
function resolveImageIntrinsicAny(
  node: unknown,
  resources: Record<string, TemplateResource>,
  context: ImageResolutionContext | undefined
): string | number | boolean | string[] | undefined {
  if (node === null || node === undefined) return undefined;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return node;
  }
  if (Array.isArray(node)) {
    // A bare array isn't a valid intrinsic at this layer.
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return undefined;
  const intrinsic = keys[0]!;
  const arg = obj[intrinsic];

  if (intrinsic === 'Ref') {
    if (typeof arg !== 'string') return undefined;
    if (arg.startsWith('AWS::')) {
      const p = context?.pseudoParameters;
      if (!p) return undefined;
      if (arg === 'AWS::URLSuffix') return p.urlSuffix;
      if (arg === 'AWS::Partition') return p.partition;
      if (arg === 'AWS::Region') return p.region;
      if (arg === 'AWS::AccountId') return p.accountId;
      return undefined;
    }
    const refResource = resources[arg];
    if (refResource?.Type !== 'AWS::ECR::Repository') return undefined;
    const stateEntry = context?.stateResources?.[arg];
    if (!stateEntry) return undefined;
    return stateEntry.physicalId;
  }

  if (intrinsic === 'Fn::GetAtt') {
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
    if (resources[logicalId]?.Type !== 'AWS::ECR::Repository') return undefined;
    const cached = context?.stateResources?.[logicalId]?.attributes?.[attr];
    if (typeof cached === 'string' && cached.length > 0) return cached;
    return undefined;
  }

  if (intrinsic === 'Fn::Split') {
    if (!Array.isArray(arg) || arg.length !== 2) return undefined;
    const argArr = arg as unknown[];
    const delim = argArr[0];
    if (typeof delim !== 'string') return undefined;
    const src = resolveImageIntrinsicAny(argArr[1], resources, context);
    if (typeof src !== 'string') return undefined;
    return src.split(delim);
  }

  if (intrinsic === 'Fn::Select') {
    if (!Array.isArray(arg) || arg.length !== 2) return undefined;
    const argArr = arg as unknown[];
    const rawIndex = argArr[0];
    let index: number | undefined;
    if (typeof rawIndex === 'number') {
      index = rawIndex;
    } else if (typeof rawIndex === 'string' && /^-?\d+$/.test(rawIndex)) {
      index = Number.parseInt(rawIndex, 10);
    }
    if (index === undefined || !Number.isFinite(index)) return undefined;
    const list = resolveImageIntrinsicAny(argArr[1], resources, context);
    if (Array.isArray(list)) {
      if (index < 0 || index >= list.length) return undefined;
      const picked = list[index];
      if (typeof picked === 'string') return picked;
      return undefined;
    }
    // Some templates pass a literal array of intrinsics directly under
    // Fn::Select. Resolve each element on the fly.
    if (Array.isArray(argArr[1])) {
      const listLiteral = argArr[1] as unknown[];
      if (index < 0 || index >= listLiteral.length) return undefined;
      return resolveImageIntrinsic(listLiteral[index], resources, context);
    }
    return undefined;
  }

  if (intrinsic === 'Fn::Join') {
    if (!Array.isArray(arg) || arg.length !== 2) return undefined;
    const [delim, parts] = arg as [unknown, unknown];
    if (typeof delim !== 'string' || !Array.isArray(parts)) return undefined;
    const resolved: string[] = [];
    for (const part of parts) {
      const r = resolveImageIntrinsic(part, resources, context);
      if (r === undefined) return undefined;
      resolved.push(r);
    }
    return resolved.join(delim);
  }

  if (intrinsic === 'Fn::Sub') {
    // Reuse the single-string Fn::Sub substituter, which handles Tier 1
    // (pseudo parameters) + Tier 2 (state-recorded ECR Repository refs).
    let template: string | undefined;
    if (typeof arg === 'string') template = arg;
    else if (Array.isArray(arg) && typeof arg[0] === 'string') template = arg[0];
    if (template === undefined) return undefined;
    const out = substituteImagePlaceholders(template, resources, context);
    if (out.includes('${')) return undefined;
    return out;
  }

  return undefined;
}

/**
 * Replace `${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` /
 * `${AWS::URLSuffix}` against `context.pseudoParameters` and same-stack
 * `${<EcrRepoLogicalId>}` / `${<EcrRepoLogicalId>.<attr>}` placeholders
 * against `context.stateResources` in a flat string. Unresolvable
 * placeholders pass through verbatim — callers detect that with a
 * post-substitution `.includes('${')` check and surface a precise error.
 *
 * Pure string-rewrite; no AWS calls. Used by both the flat-`Fn::Sub`
 * Image path (ECS `cdkd local run-task`) and the `Fn::Sub` branch of
 * `resolveImageIntrinsicAny` (the nested-intrinsic resolver in this
 * file).
 */
export function substituteImagePlaceholders(
  flat: string,
  resources: Record<string, TemplateResource>,
  context: ImageResolutionContext | undefined
): string {
  if (!flat.includes('${')) return flat;
  return flat.replace(/\$\{([^}]+)\}/g, (full, key: string) => {
    if (context?.pseudoParameters) {
      if (key === 'AWS::AccountId' && context.pseudoParameters.accountId) {
        return context.pseudoParameters.accountId;
      }
      if (key === 'AWS::Region' && context.pseudoParameters.region) {
        return context.pseudoParameters.region;
      }
      if (key === 'AWS::Partition' && context.pseudoParameters.partition) {
        return context.pseudoParameters.partition;
      }
      if (key === 'AWS::URLSuffix' && context.pseudoParameters.urlSuffix) {
        return context.pseudoParameters.urlSuffix;
      }
    }
    if (context?.stateResources) {
      const dot = key.indexOf('.');
      const logicalId = dot === -1 ? key : key.slice(0, dot);
      const refResource = resources[logicalId];
      const stateEntry = context.stateResources[logicalId];
      if (refResource?.Type === 'AWS::ECR::Repository' && stateEntry) {
        if (dot === -1) {
          // `${<Repo>}` → the repository's physical id (its Name).
          return stateEntry.physicalId;
        }
        const attr = key.slice(dot + 1);
        const cached = stateEntry.attributes?.[attr];
        if (typeof cached === 'string') return cached;
      }
    }
    return full;
  });
}
