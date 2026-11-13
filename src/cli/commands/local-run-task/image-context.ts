import { getLogger } from '../../../utils/logger.js';
import { describeLocalAwsFailureForWarn } from '../../../utils/local-aws-failure.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import {
  derivePartitionAndUrlSuffix,
  detectEcsImageResolutionNeeds,
  type EcsImageResolutionContext,
} from '../../../local/ecs-task-resolver.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import { matchStacks } from '../../stack-matcher.js';
import { stackForPathFormTarget } from '../../cdk-path.js';
import { loadBootstrapContainerRepo } from '../local-state-loader.js';
import type { LocalStateProvider } from '../../../local/local-state-provider.js';
import type { LocalRunTaskOptions } from './types.js';
import { resolveStackAccountId } from './stack-account.js';
import { stateRoleRecordIsEmulatorSide } from '../../../local/local-aws-wiring.js';

/**
 * Region the cross-stack resolver is scoped to for `cdkd local run-task`
 * (issue #1836).
 *
 * This value does THREE things (round 3 said TWO and was wrong — corrected in
 * round 4), and the first is why the state record's own spelling outranks the env
 * chain:
 *
 * 1. it becomes the exports-index KEY `cdkd/_index/{region}/exports.json`;
 * 2. it is the same-region filter of the index-miss per-stack scan; and
 * 3. via `SubstitutionContext.consumerRegion`, it is cdk-local's DEFAULT producer
 *    region for an `Fn::GetStackOutput` that carries no explicit `Region` — i.e.
 *    it becomes the `cdkd/{producer}/{region}/state.json` key that intrinsic
 *    reads.
 *
 * All three land in `buildCrossStackResolver` (`local-state-loader.ts`), whose
 * `resolveImport` scan (2) and — since round 4 — `resolveGetStackOutput` (3) fold
 * BOTH sides for the comparison / recovery, while (1) is deliberately raw.
 *
 * `local invoke` / `local invoke-agentcore` both pass `loaded.region` there; this
 * command passed a FOLDED env-chain value instead, so the two commands keyed one
 * index differently — and a key the state records do not spell makes
 * `ExportIndexStore`'s rebuild filter match zero refs and PUT an EMPTY index,
 * permanently degrading every `Fn::ImportValue` to the O(N) scan. Keyed by a
 * record's spelling the filter always matches.
 *
 * The env-chain arm remains for the case where no state record was loaded at all
 * (nothing in the task needed one), and it stays FOLDED for the reason the rest
 * of this file folds: both env-var links escape the handler-entry `--region`
 * fold, and a raw upper-cased spelling reaches an S3 key and an SDK client.
 *
 * @internal exported for unit tests.
 */
export function resolveEcsConsumerRegion(
  stateRecordRegion: string | undefined,
  options: Pick<LocalRunTaskOptions, 'region'>,
  synthRegion: string | undefined
): string {
  if (stateRecordRegion) return stateRecordRegion;
  return canonicalizeRegion(
    // Issue #1836 round 4: `||`, not `??`, on the FLAG link. Round 3's `??` let
    // `--region ''` beat `AWS_REGION` and yield `''` — which would then be the
    // exports-index key AND the bucket-resolution region, contradicting the
    // blank-is-absent rule this branch adopted at the four client boundaries. The
    // two env links keep `??` for parity with the sibling chains in this file
    // (an exported-but-empty `AWS_REGION` is not a shape this branch changed),
    // and `synthRegion` keeps `??` because a blank synth region is not user input.
    (options.region || process.env['AWS_REGION']) ??
      process.env['AWS_DEFAULT_REGION'] ??
      synthRegion ??
      'us-east-1'
  );
}

/**
 * Build the substitution context the ECS task resolver consumes (issue
 * #264), plus the region of the state record it loaded (if any — issue #1836;
 * see {@link resolveEcsConsumerRegion} for what reads it). `context` is
 * `undefined` when no container's `Image` field needs substitution — the
 * resolver behaves as before in that case.
 *
 * Tier 1 (pseudo parameters) fires `sts:GetCallerIdentity` once for
 * `${AWS::AccountId}`; region / partition / URL suffix come from the CLI
 * (`--region` → env vars → synth-derived stack region). Tier 2 (state
 * load) routes through the active {@link LocalStateProvider} so both
 * `--from-state` and `--from-cfn-stack` produce the same downstream
 * context shape (issue #606).
 *
 * The resolved region is CANONICALIZED (issue #1795) before anything consumes
 * it. That covers all four sources — `--region`, both env vars, and the
 * synth-derived stack region — and all three consumers: the STS client built
 * for `${AWS::AccountId}`, the `${AWS::URLSuffix}` / `${AWS::Partition}`
 * derivation, and the `${AWS::Region}` value itself.
 *
 * @internal exported for unit tests.
 */
export async function buildEcsImageResolutionContext(
  candidate: StackInfo | undefined,
  stateProvider: LocalStateProvider | undefined,
  options: LocalRunTaskOptions
): Promise<{ context?: EcsImageResolutionContext; stateRecordRegion?: string }> {
  const logger = getLogger();
  if (!candidate) return {};

  const needs = detectEcsImageResolutionNeeds(candidate);
  // The bare `--assume-task-role` reads the task role's deployed ARN from the
  // state record (go-to-k/cdkd#6189); no other path reads the task role.
  const roleRecordUsable = !taskRoleRecordIsEmulatorSide();
  const wantsStateForTaskRole =
    !!stateProvider &&
    needs.needsTaskRoleState &&
    options.assumeTaskRole === true &&
    roleRecordUsable;
  if (
    !needs.needsPseudoParameters &&
    !needs.needsStateResources &&
    !needs.needsEnvOrSecretSubstitution &&
    !needs.needsAssetRepoMarker &&
    !wantsStateForTaskRole
  ) {
    return {};
  }

  const ctx: EcsImageResolutionContext = {};
  if (!roleRecordUsable) ctx.ignoreStateForRoles = true;
  // Region of the state record the load below resolved to, if any. Reported
  // separately rather than stashed on `ctx`: `EcsImageResolutionContext` is
  // cdk-local's `ImageResolutionContext` plus one cdkd field, and the region is
  // not part of the resolver's contract — it only scopes the cross-stack
  // resolver the caller builds afterwards (issue #1836).
  let stateRecordRegion: string | undefined;

  // Pseudo parameters are needed (a) by image Fn::Sub references to AWS::*,
  // and (b) by env / secret Fn::Join / Fn::Sub bodies when a state
  // provider is set — `ecs.Secret.fromSsmParameter` synthesizes a Fn::Join
  // that splices ${AWS::Partition} / ${AWS::Region} / ${AWS::AccountId}
  // around a Ref to the parameter. Issue #291.
  const wantsPseudoForEnvOrSecret = !!stateProvider && needs.needsEnvOrSecretSubstitution;
  if (needs.needsPseudoParameters || wantsPseudoForEnvOrSecret) {
    const region = canonicalizeRegion(
      options.region ??
        process.env['AWS_REGION'] ??
        process.env['AWS_DEFAULT_REGION'] ??
        candidate.region
    );
    if (!region) {
      logger.warn(
        'Resolver references ${AWS::Region} but cdkd could not determine the target region. ' +
          'Pass --region, set AWS_REGION, or declare env.region on the CDK stack.'
      );
    }
    let accountId: string | undefined;
    try {
      accountId = await resolveStackAccountId({
        region,
        profile: options.profile,
        fromState: options.fromState,
        fromCfnStack: options.fromCfnStack,
      });
    } catch (err) {
      logger.warn(
        `Resolver needs \${AWS::AccountId} but STS GetCallerIdentity failed: ${describeLocalAwsFailureForWarn(err, 'STS GetCallerIdentity')}. ` +
          'Substitution will be skipped; affected env / secret entries will be dropped with per-key warnings.'
      );
    }
    const partitionAndSuffix = region ? derivePartitionAndUrlSuffix(region) : undefined;
    ctx.pseudoParameters = {
      ...(accountId !== undefined && { accountId }),
      ...(region !== undefined && { region }),
      ...(partitionAndSuffix && {
        partition: partitionAndSuffix.partition,
        urlSuffix: partitionAndSuffix.urlSuffix,
      }),
    };
  }

  const wantsState =
    needs.needsStateResources || needs.needsEnvOrSecretSubstitution || wantsStateForTaskRole;
  if (stateProvider && wantsState) {
    const loaded = await stateProvider.load(candidate.stackName, candidate.region);
    if (loaded) {
      ctx.stateResources = loaded.resources;
      stateRecordRegion = loaded.region;
    }
  } else if (!stateProvider && needs.needsStateResources) {
    // `--image-override` can replace a same-stack ECR image, so the warning is
    // noise when one is passed; an uncovered image still fails with the full
    // remedy (`assertEcsTaskImagesResolvable`).
    if (!options.imageOverride?.length) {
      logger.warn(
        'Container Image references a same-stack AWS::ECR::Repository. Pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) ' +
          'to substitute the deployed repository URI, or --image-override to build it from a local Dockerfile. ' +
          'Otherwise the run stops before any container starts.'
      );
    }
  } else if (!stateProvider && needs.needsEnvOrSecretSubstitution) {
    logger.warn(
      'Container Environment / Secrets entries contain CloudFormation intrinsics (Ref / Fn::GetAtt / Fn::Sub / Fn::Join). ' +
        'Pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) to substitute them against deployed state. Without a state source these entries are dropped (per-key warnings will follow).'
    );
  }

  // Issue #1025: a container Image targets an ECR repo whose name does not
  // match the conventional container-assets shapes. When the stack was
  // deployed via cdkd (`--from-state`), the region may have been
  // bootstrapped with `cdkd bootstrap --container-repo <name>` — read the
  // bootstrap marker (best-effort, never fails the run) so the classifier
  // can recognize images in the custom-named repo as cdk assets and take
  // the local cdk.out-build fast path instead of an ECR pull. Gated on
  // `--from-state` only: `--from-cfn-stack` stacks were deployed via
  // CloudFormation, whose asset repos use conventional names the regex
  // already matches.
  if (needs.needsAssetRepoMarker && options.fromState) {
    const containerRepo = await loadBootstrapContainerRepo(candidate.region, {
      statePrefix: options.statePrefix,
      ...(options.stackRegion !== undefined && { stackRegion: options.stackRegion }),
      // Issue #1836: the raw spelling too, so the marker-key fallback probe can
      // reach the key an upper-cased `cdkd bootstrap` wrote (see
      // `loadBootstrapContainerRepo`'s `rawRegion` note).
      ...(options.rawStackRegion !== undefined && { rawStackRegion: options.rawStackRegion }),
      // Issue #3622: likewise the raw env spelling, which the entry fold has
      // already overwritten in `process.env`.
      ...(options.rawEnvRegion !== undefined && { rawEnvRegion: options.rawEnvRegion }),
      ...(options.stateBucket !== undefined && { stateBucket: options.stateBucket }),
      ...(options.region !== undefined && { region: options.region }),
      ...(options.profile !== undefined && { profile: options.profile }),
      logPrefix: '--from-state',
    });
    if (containerRepo !== undefined) {
      ctx.cdkAssetContainerRepo = containerRepo;
    }
  }

  return { context: ctx, ...(stateRecordRegion !== undefined && { stateRecordRegion }) };
}

/**
 * Whether the state record's IAM roles are the WRONG side for
 * `--assume-task-role` (go-to-k/cdkd#6189): in AWS Emulator mixed mode the role
 * is assumed in real AWS (`planTaskRoleCredentials`), while the record's IAM
 * resources are the emulator's unless `Parameters` marks IAM as a `"real-aws"`
 * exception. The record would then name an emulator role to real STS.
 *
 * @internal exported for unit tests.
 */
export function taskRoleRecordIsEmulatorSide(): boolean {
  return stateRoleRecordIsEmulatorSide();
}

/**
 * The stack whose state feeds `--from-state` / `--from-cfn-stack`, chosen by
 * the SAME rule `resolveEcsTaskTarget` resolves the task with: a path-form
 * target's longest display-path prefix first, so a Stage stack's target does
 * not name the Stage id here while the resolver finds the task (which ran the
 * task with no state source, silently -- go-to-k/cdkd#3953).
 *
 * @internal exported for unit tests.
 */
export function pickCandidateStack(
  parsed: { stackPattern: string | null; isPath: boolean; pathOrId: string },
  target: string,
  stacks: StackInfo[]
): StackInfo | undefined {
  const byPrefix = stackForPathFormTarget(parsed, target, stacks);
  if (byPrefix) return byPrefix;
  const { stackPattern } = parsed;
  if (stackPattern === null) {
    if (stacks.length === 1) return stacks[0];
    return undefined;
  }
  // By identity: two Stage stacks sharing a physical name are not unique,
  // never the first one's (#5176).
  const matched = matchStacks(stacks, [stackPattern], { dedupe: 'identity' });
  if (matched.length === 1) return matched[0];
  return undefined;
}
