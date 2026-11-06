import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../types/resource.js';
import {
  derivePseudoParametersFromRegion,
  tryResolveImageFnJoin,
} from '../../../local/intrinsic-image.js';
import {
  assetPathDirs,
  extractEphemeralStorageMb,
  resolveAssetCodeDirectory,
  resolveLambdaLayers,
  type ResolvedLambdaLayer,
} from '../../../local/lambda-resolver.js';
import { describeStack } from '../../stack-matcher.js';
import { displayIdent } from '../../../utils/display-safe.js';
import {
  stacksDeclaring,
  LAMBDA_FUNCTION_TYPE,
  renderServeOneStackAdvice,
} from './served-lambdas.js';

/**
 * Locate a Lambda by logical ID across the target stacks. Throws when
 * no stack contains a matching `AWS::Lambda::Function` — at this point
 * route discovery has already linked the routes to logical IDs, so a
 * miss here is a synthesis bug worth surfacing.
 */
/**
 * Discriminated union covering both ZIP and container Lambdas (closes
 * #453). The ZIP variant is the original `cdkd local start-api` v1
 * shape; the IMAGE variant was unlocked here in this PR — the per-
 * Lambda image build / ECR pull / `--platform` threading lives below
 * in `buildContainerSpec`'s `kind === 'image'` branch.
 */
type ResolvedStartApiLambda = ResolvedStartApiZipLambda | ResolvedStartApiImageLambda;

interface ResolvedStartApiLambdaBase {
  stack: StackInfo;
  logicalId: string;
  resource: TemplateResource;
  memoryMb: number;
  timeoutSec: number;
  /**
   * Resolved same-stack `Properties.Layers` references. Populated on
   * the ZIP branch; always `[]` on the IMAGE branch — container
   * Lambdas reject `Layers` at deploy time on the AWS side (layers
   * are baked into the image at build time, not overlaid at
   * runtime), so cdkd silently ignores any `Layers` property to
   * match AWS's invoke-time behavior. The base-shape `[]` keeps the
   * ResolvedImageLambda → `lambda-resolver.ResolvedImageLambda`
   * cast structurally valid in the container-pool spec.
   */
  layers: ResolvedLambdaLayer[];
  /**
   * `Properties.EphemeralStorage.Size` (issue #440), MiB. Parsed via
   * the shared `extractEphemeralStorageMb` helper so the CFn-range
   * validation (reject > 10240) matches `cdkd local invoke`. Plumbed
   * into the warm container's `--tmpfs /tmp:size=Nm` so handlers in
   * the start-api server see the same sized `/tmp` cap they would on
   * the deployed function. Applies to BOTH ZIP and IMAGE Lambdas —
   * Docker `--tmpfs` overlays inside any container image just like on
   * the public base images. Undefined when the property is absent.
   */
  ephemeralStorageMb?: number;
}

interface ResolvedStartApiZipLambda extends ResolvedStartApiLambdaBase {
  kind: 'zip';
  runtime: string;
  handler: string;
  codePath: string | null;
  inlineCode?: string;
  /**
   * `Architectures: [x86_64]` (default) or `[arm64]`. Threaded through to
   * `--platform linux/amd64` / `linux/arm64` on the ZIP container's
   * `docker run` (issue #768) so a `provided.*` `bootstrap` compiled for
   * the other arch doesn't fail with `exec format error` /
   * `Runtime.InvalidEntrypoint` on an arch-mismatched host — matching the
   * IMAGE path, which already pins `--platform`.
   */
  architecture: 'x86_64' | 'arm64';
}

export interface ResolvedStartApiImageLambda extends ResolvedStartApiLambdaBase {
  kind: 'image';
  /**
   * Raw `Code.ImageUri` value, surfaced for the local-build path's
   * asset-hash extraction AND for the ECR-pull fallback. Already
   * resolved through cdk-assets bootstrap-placeholder substitution
   * upstream — `${AWS::*}` pseudo-parameters are still present and
   * substituted at the lookup site.
   */
  imageUri: string;
  /**
   * `ImageConfig` (all fields optional). Most container Lambdas leave
   * `EntryPoint` unset so `/lambda-entrypoint.sh` stays in charge of
   * RIE dispatch. `Command` is typically the handler reference, e.g.
   * `['app.handler']`.
   */
  imageConfig: {
    command?: string[];
    entryPoint?: string[];
    workingDirectory?: string;
  };
  /**
   * `Architectures: [x86_64]` (default) or `[arm64]`. Threaded through
   * to `--platform linux/amd64` / `linux/arm64` on BOTH `docker build`
   * AND `docker run` so an arm64 host running an x86_64 Lambda doesn't
   * hit silent emulation, and an x86_64 host running an arm64 Lambda
   * doesn't fail with `exec format error`.
   */
  architecture: 'x86_64' | 'arm64';
}

export function resolveLambdaByLogicalId(
  logicalId: string,
  stacks: StackInfo[]
): ResolvedStartApiLambda {
  // Never the first stack that declares it: the server passes only the
  // route's own stack (`lambdaOwners`, #5181), and this keeps a direct caller
  // from resolving one stack's Lambda for another's route.
  const owners = stacksDeclaring(logicalId, stacks, LAMBDA_FUNCTION_TYPE);
  if (owners.length > 1) {
    // cdkd-raw-beside-safe: a count, `describeStack` and
    // `renderServeOneStackAdvice`, each sanitized as in
    // `assertServedLogicalIdsUnambiguous`.
    throw new Error(
      `Lambda ${displayIdent(logicalId)} is declared by ${owners.length} stacks ` +
        `(${owners.map(describeStack).join(', ')}). ${renderServeOneStackAdvice(owners)}`
    );
  }
  for (const stack of owners) {
    const resource = stack.template.Resources![logicalId]!;
    const props = resource.Properties ?? {};
    const memoryMb = typeof props['MemorySize'] === 'number' ? props['MemorySize'] : 128;
    const timeoutSec = typeof props['Timeout'] === 'number' ? props['Timeout'] : 3;

    const code = (props['Code'] ?? {}) as Record<string, unknown>;
    const imageUri = extractImageUri(
      code['ImageUri'],
      logicalId,
      stack.stackName,
      stack.template.Resources ?? {},
      stack.region
    );
    if (imageUri !== undefined) {
      return resolveImageLambda({
        stack,
        logicalId,
        resource,
        props,
        memoryMb,
        timeoutSec,
        imageUri,
      });
    }

    // ZIP branch: Runtime + Handler mandatory.
    const runtime = typeof props['Runtime'] === 'string' ? props['Runtime'] : '';
    const handler = typeof props['Handler'] === 'string' ? props['Handler'] : '';
    if (!runtime) {
      throw new Error(
        `Lambda '${logicalId}' has no Runtime property and no Code.ImageUri. ` +
          'cdkd local start-api cannot tell if this is a ZIP or a container Lambda.'
      );
    }
    if (!handler) {
      throw new Error(`Lambda '${logicalId}' has no Handler property.`);
    }
    const inlineCode = typeof code['ZipFile'] === 'string' ? code['ZipFile'] : undefined;
    let codePath: string | null = null;
    if (!inlineCode) {
      codePath = resolveAssetCodePath(stack, logicalId, resource);
    }
    // PR 6 (#232): same-stack `Properties.Layers` references resolve to
    // local asset directories that bind-mount at `/opt`; start-api
    // routes through the same lambda-resolver helper as `cdkd local
    // invoke` so the warm container pool gets layer support out of
    // the box.
    const layers = resolveLambdaLayers(stack, logicalId, props);
    const ephemeralStorageMb = extractEphemeralStorageMb(props, logicalId);
    const architecture = extractStartApiArchitecture(props, logicalId);
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
      architecture,
      ...(inlineCode !== undefined && { inlineCode }),
      ...(ephemeralStorageMb !== undefined && { ephemeralStorageMb }),
    };
  }
  throw new Error(
    `No AWS::Lambda::Function resource named '${logicalId}' found in target stacks. This is likely a synthesis bug — the route-discovery phase resolved a route to this logical ID.`
  );
}

/**
 * Extract `Code.ImageUri` across the shapes CDK actually synthesizes.
 * Mirrors the simpler subset of `lambda-resolver.ts:extractImageUri`
 * scoped to the shapes `cdkd local start-api` consumes — flat string,
 * `Fn::Sub` (the canonical asset shape for
 * `lambda.DockerImageCode.fromImageAsset`), and `Fn::Join` (the
 * canonical shape for `lambda.DockerImageCode.fromImageAsset` in
 * CDK 2.x, which emits a `Fn::Join` over the literal bootstrap ECR
 * URI with `${AWS::URLSuffix}` — issues #627 + #637).
 *
 * The `Fn::Join` arm routes through the shared
 * `tryResolveImageFnJoin` helper (`src/local/intrinsic-image.ts`) used
 * by `cdkd local invoke`. When the synth template recorded a deploy
 * region (`stack.region`), we derive `{ urlSuffix, partition, region }`
 * via `derivePseudoParametersFromRegion` and pass it as the resolver's
 * `pseudoParameters` block so the canonical `${AWS::URLSuffix}` shape
 * resolves cleanly (issue #637). Same-stack ECR refs still surface as
 * `needs-state` (those require `--from-state`); a Join that references
 * `${AWS::AccountId}` without state still surfaces as `not-applicable`
 * with a more specific error message naming the missing parameter.
 *
 * Returns `undefined` when the field is absent or non-recognized,
 * which routes the caller to the ZIP branch (with its existing
 * "no Runtime / no Handler" validations).
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
    if (Array.isArray(sub) && typeof sub[0] === 'string') return sub[0];

    if ('Fn::Join' in obj) {
      // Issue #637: derive the region-knowable pseudo parameters
      // (`urlSuffix` / `partition` / `region`) and pass them as
      // resolver context so the canonical `lambda.DockerImageCode
      // .fromImageAsset` shape resolves without `--from-state`.
      // `accountId` stays undefined — the canonical shape has it
      // as a literal in the template, and a Join that genuinely
      // references `${AWS::AccountId}` falls back to the
      // `not-applicable` branch below with a clear error.
      const pseudoParameters = derivePseudoParametersFromRegion(region);
      const joinResolved = tryResolveImageFnJoin(
        value,
        resources,
        pseudoParameters ? { pseudoParameters } : undefined
      );
      if (joinResolved.kind === 'resolved') return joinResolved.uri;
      if (joinResolved.kind === 'needs-state') {
        throw new Error(
          `Lambda '${logicalId}' in ${stackName} references same-stack ECR repository '${joinResolved.repoLogicalId}' via Fn::Join. ` +
            'cdkd local start-api cannot resolve the repository URI without state — ' +
            'deploy the stack first (so cdkd records the repository physical id), ' +
            'rebuild via lambda.DockerImageCode.fromImageAsset, or pin a public image.'
        );
      }
      if (joinResolved.kind === 'unsupported-join') {
        throw new Error(
          `Lambda '${logicalId}' in ${stackName} has an unsupported Fn::Join Code.ImageUri shape: ${joinResolved.reason}. ` +
            'cdkd local start-api recognizes the canonical CDK 2.x lambda.DockerImageCode.fromEcr Fn::Join shape ' +
            '(delimiter "" with nested Fn::Select/Fn::Split over an ECR Repository Arn GetAtt + Ref to the repo).'
        );
      }
      // `not-applicable` — the Join couldn't reduce every element
      // AND there's no same-stack ECR Repository ref. With #637's
      // pseudo-parameter plumbing the typical remaining cause is
      // `${AWS::AccountId}` (needs an STS call or `--from-state`)
      // or an unknown region (`stack.region` was undefined so we
      // couldn't derive `urlSuffix`). Either way, surface a clear
      // error instead of falling through to ZIP-branch validation.
      const accountIdHint = pseudoParameters
        ? ' (likely ${AWS::AccountId}, which cdkd cannot derive without --from-state or STS)'
        : ` (cdkd could not derive AWS pseudo parameters because stack.region was undefined)`;
      throw new Error(
        `Lambda '${logicalId}' in ${stackName} has an Fn::Join Code.ImageUri that cdkd local start-api cannot resolve${accountIdHint}. ` +
          'Workarounds: deploy first and run with --from-state, or pin a fully-literal public image URI.'
      );
    }
  }
  return undefined;
}

/**
 * Parse `Properties.Architectures` into the single arch cdkd threads to
 * `--platform`. Defaults to `x86_64` (the AWS default) when absent; CDK
 * only ever sets one entry. Shared by BOTH the ZIP and IMAGE start-api
 * resolvers (issue #768) so the ZIP container run pins `--platform` the
 * same way the IMAGE path always has.
 */
function extractStartApiArchitecture(
  props: Record<string, unknown>,
  logicalId: string
): 'x86_64' | 'arm64' {
  const arches = props['Architectures'];
  if (Array.isArray(arches) && arches.length > 0) {
    const first: unknown = arches[0];
    if (first === 'arm64') return 'arm64';
    if (first === 'x86_64') return 'x86_64';
    throw new Error(
      `Lambda '${logicalId}' has unsupported Architectures value '${String(first)}'. ` +
        'cdkd local start-api supports x86_64 and arm64.'
    );
  }
  return 'x86_64';
}

/**
 * Build the IMAGE-variant `ResolvedStartApiLambda` from a Lambda
 * template entry with `Code.ImageUri`. Mirrors
 * `lambda-resolver.ts:extractImageLambdaProperties` but trimmed to the
 * fields `cdkd local start-api` actually consumes.
 */
function resolveImageLambda(args: {
  stack: StackInfo;
  logicalId: string;
  resource: TemplateResource;
  props: Record<string, unknown>;
  memoryMb: number;
  timeoutSec: number;
  imageUri: string;
}): ResolvedStartApiImageLambda {
  const { stack, logicalId, resource, props, memoryMb, timeoutSec, imageUri } = args;

  const rawImageConfig = (props['ImageConfig'] ?? {}) as Record<string, unknown>;
  const imageConfig: ResolvedStartApiImageLambda['imageConfig'] = {};
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

  const architecture = extractStartApiArchitecture(props, logicalId);

  // Issue #440 — EphemeralStorage.Size applies to container Lambdas
  // too; AWS accepts it on `lambda.DockerImageFunction`. Parse via the
  // shared helper for CFn-range validation parity with the ZIP branch.
  const ephemeralStorageMb = extractEphemeralStorageMb(props, logicalId);

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
 * Locate the Lambda's local code directory using the CDK-blessed
 * `Metadata['aws:asset:path']` hint. Bind-mounted directly at
 * `/var/task` (read-only) by the docker-runner.
 *
 * The verdicts go through `resolveAssetCodeDirectory`, which is the ONE
 * spelling this and `cdkd local invoke`'s resolver share (issue
 * [#3494](https://github.com/go-to-k/cdkd/issues/3494)): it REFUSES an escaping
 * RELATIVE value and WARNS on an ABSOLUTE one that leaves the asset outdir.
 * This copy previously spelled the resolution itself, so a guard on the other
 * one would have been a guard on neither. It keeps its own error class and
 * command name by passing its own `wrapError`.
 *
 * `assetPathDirs` is shared for the same reason: the bound it returns is what
 * go-to-k/cdkd#3493's two sites disagreed about. Pass `manifestDir` as the
 * bound instead and a Stage's legitimate `../asset.<hash>` is refused, which
 * `local-asset-code-path-containment.test.ts`'s start-api wiring case pins.
 */
function resolveAssetCodePath(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource
): string {
  const meta = resource.Metadata;
  const assetPath = meta?.['aws:asset:path'];
  if (typeof assetPath !== 'string' || assetPath.length === 0) {
    throw new Error(
      `Lambda ${displayIdent(logicalId)} has no Metadata['aws:asset:path']. cdkd local start-api needs this hint to find the local asset directory. Re-synthesize the app and retry.`
    );
  }
  const { manifestDir, assetOutdir } = assetPathDirs(stack);
  return resolveAssetCodeDirectory({
    manifestDir,
    assetPath,
    wrapError: (message) => new Error(message),
    assetOutdir,
    logicalId,
  });
}
