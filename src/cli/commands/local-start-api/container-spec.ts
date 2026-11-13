import {
  resolveContainerRegion,
  setContainerRegion,
  warnAwsEmulatorStateSourceHint,
} from '../../../local/local-aws-wiring.js';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  firstUsableRegion,
  keysNotFromTemplate,
  resolveDynamicReferencesInEnv,
  type AwsEmulatorWorkload,
} from 'cdk-local/internal';
import { createCallerDynamicReferenceResolver } from '../../../local/dynamic-reference.js';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AssumeRoleOption } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { explicitRoleArnOrThrow } from '../../../utils/role-arn.js';
import { readCdkPathOrUndefined } from '../../cdk-path.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import {
  substituteEnvVarsFromState,
  type SubstitutionContext,
} from '../../../local/state-resolver.js';
import { copyLayerTreeLastWins, layerAssetDirectory } from '../../../local/layer-tree-copy.js';
import { resolveRuntimeFileExtension } from '../../../local/runtime-image.js';
import {
  architectureToPlatform,
  buildContainerImage,
} from '../../../local/docker-image-builder.js';
import { parseEcrUri, pullEcrImage } from '../../../local/ecr-puller.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../../../assets/asset-manifest-loader.js';
import type { DockerImageAssetSource } from '../../../types/assets.js';
import type { ContainerSpec } from '../../../local/container-pool.js';
import { resolveRieWrap } from '../../../local/rie-mount.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../../local/env-resolver.js';
import { assetPathDirs, type ResolvedLambdaLayer } from '../../../local/lambda-resolver.js';
import { materializeLayerFromArn } from '../../../local/layer-arn-materializer.js';
import type { ProfileCredentialsFile } from '../local-profile-credentials-file.js';
import { resolveStartApiAssumeRoleArn } from './assume-role.js';
import { resolveLambdaByLogicalId, type ResolvedStartApiImageLambda } from './lambda-resolver.js';
import { materializeInlineCode, getTemplateEnv, forwardAwsEnv } from './env.js';
import { assumeLambdaExecutionRole } from './credentials.js';
import { stateBundleKey, type StackStateBundle } from './state.js';

/**
 * Build the per-Lambda container spec — code dir, env vars (template +
 * --env-vars overlay), STS-issued creds when --assume-role names this
 * Lambda, optional --debug-port reservation. Errors out with a clear
 * message if the Lambda's code can't be resolved (asset directory
 * missing, runtime not supported).
 */
export async function buildContainerSpec(args: {
  logicalId: string;
  stacks: StackInfo[];
  overrides: EnvOverrideFile | undefined;
  assumeRole: AssumeRoleOption | undefined;
  containerHost: string;
  debugPort?: number;
  stsRegion: string | undefined;
  /**
   * The caller's set of materialized inline-code tmpdirs. Every dir
   * `materializeInlineCode` returns is also pushed here so the graceful
   * shutdown path can remove it. The set is shared across all calls
   * within one server boot.
   */
  inlineTmpDirs: Set<string>;
  /**
   * The caller's set of merged-layers tmpdirs (PR 6 of #224, issue
   * #232). Every multi-layer Lambda's `materializeLambdaLayers(...)`
   * call records its merged tmpdir here so `shutdown(...)` can remove
   * each one. Single-layer Lambdas bind-mount the layer's asset dir
   * directly and never write into this set.
   */
  layerTmpDirs: Set<string>;
  /**
   * `--from-state` substitution input keyed by stack name. Empty when
   * the flag is unset OR when no routed stack had loadable state. Per-
   * stack entries supply state.resources + the pseudo-parameter bag
   * the env-resolver consults for `Ref AWS::*` / `${AWS::*}` placeholders.
   */
  stateByStack: Map<string, StackStateBundle>;
  /** `--from-state` / `--from-cfn-stack` was given (the `--aws-emulator` hint stays quiet). */
  stateSourceActive?: boolean;
  /**
   * `--no-pull` flag, threaded to the IMAGE branch's ECR-pull fallback
   * (`pullEcrImage(... {skipPull})`). ZIP branch ignores this — the
   * base-image pull happens once up the call chain
   * (`synthesizeAndBuild`'s `pullImage` loop) and is independently
   * gated by the same flag.
   */
  skipPull: boolean;
  /**
   * Issue #448: optional `--layer-role-arn` value. Forwarded into
   * {@link materializeLambdaLayers}, which `sts:AssumeRole`s into this
   * role before calling `lambda:GetLayerVersion` for every literal-ARN
   * entry. Same role applies to every routed Lambda — if the user's
   * apps reference layers in multiple accounts they need a single
   * cross-account role that can read all of them.
   */
  layerRoleArn?: string;
  /** `--emulate-role-via <arn>` (go-to-k/cdkd#6201), for a refused `--assume-role`. */
  emulateRoleVia?: string;
  /**
   * Issue #654: profile-resolved credentials to forward into the Lambda
   * container's env when `--profile <p>` is set AND this Lambda has no
   * `--assume-role` mapping. Resolved once at server boot via
   * `resolveProfileCredentials` and shared across every spec build.
   * Undefined when `--profile` is unset (the pre-fix path stays in
   * effect — `forwardAwsEnv` copies `process.env.AWS_*`).
   */
  profileCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /**
   * Issue #2 deferred from #655: when set, a synthesized AWS shared
   * credentials file (one INI section, the resolved `[<profile-name>]`
   * block) the container should bind-mount + reference via
   * `AWS_SHARED_CREDENTIALS_FILE` + `AWS_PROFILE` env vars. Lets handlers
   * that use `fromIni({ profile })` explicitly inside their code resolve
   * to the same creds locally. Undefined when `--profile` was not
   * passed.
   */
  profileCredsFile?: ProfileCredentialsFile;
  /** `--profile`: the credentials a `{{resolve:...}}` lookup is made with. */
  profile?: string;
  /** `--stack-region`, ahead of the synth region when resolving `{{resolve:...}}`. */
  stackRegionOverride?: string;
}): Promise<ContainerSpec> {
  const {
    logicalId,
    stacks,
    overrides,
    assumeRole,
    containerHost,
    debugPort,
    stsRegion,
    inlineTmpDirs,
    layerTmpDirs,
    stateByStack,
    stateSourceActive,
    skipPull,
    layerRoleArn,
    emulateRoleVia,
    profileCredentials,
    profileCredsFile,
    profile,
    stackRegionOverride,
  } = args;
  const lambda = resolveLambdaByLogicalId(logicalId, stacks);

  // ZIP / IMAGE divergence (closes #453). ZIP needs `codeDir` (bind-
  // mount source for /var/task) + `optDir` (bind-mount source for
  // /opt from same-stack Layers). IMAGE needs a pre-built local
  // docker image tag — resolved here once at server boot, then the
  // container pool runs `docker run` against it without further
  // resolution. Layers are silently ignored on the IMAGE branch
  // (matches AWS's invoke-time behavior: container Lambdas can't
  // declare Layers).
  let codeDir: string | undefined;
  let optDir: string | undefined;
  let imageRef: string | undefined;
  let platform: string | undefined;
  if (lambda.kind === 'zip') {
    // Re-use `cdkd local invoke`'s materialization rules for inline
    // (Code.ZipFile) Lambdas; asset-backed Lambdas already point at an
    // unzipped CDK directory.
    codeDir =
      lambda.codePath ??
      materializeInlineCode(
        lambda.handler,
        lambda.inlineCode ?? '',
        resolveRuntimeFileExtension(lambda.runtime),
        inlineTmpDirs
      );

    // PR 6 (#232): pre-resolve the `/opt` bind-mount source. Single-
    // layer functions reuse the layer's asset dir directly; multi-
    // layer functions get a freshly-merged tmpdir (later layers
    // overwrite earlier files via `copyLayerTreeLastWins` — the
    // load-bearing half of AWS's "last layer wins" semantic).
    //
    // Issue #448: literal-ARN entries are downloaded + unzipped via
    // `lambda:GetLayerVersion` before the merge step. The per-ARN
    // tmpdirs are tracked in `layerTmpDirs` alongside multi-layer merge
    // dirs so the same shutdown path cleans every one.
    optDir = await materializeLambdaLayers(lambda.layers, layerTmpDirs, layerRoleArn, {
      logicalId,
      cdkPath: readCdkPathOrUndefined(lambda.resource),
    });

    // Issue #768: pin `--platform` to the function's declared arch on the
    // ZIP container run too (the IMAGE branch below always has). Without
    // it a `provided.*` `bootstrap` compiled for the other arch fails with
    // `exec format error` / `Runtime.InvalidEntrypoint` on an
    // arch-mismatched host; with it Docker emulates the declared arch.
    platform = architectureToPlatform(lambda.architecture);
  } else {
    // IMAGE branch (closes #453): build locally from cdk.out asset
    // manifest, OR pull from ECR when no matching asset is found.
    // Cross-REGION works on the ECR-pull path (the ECR client is built for the
    // image URI's own region); cross-ACCOUNT needs credentials that already hold
    // the ECR read permissions, since this command declares no --ecr-role-arn
    // (issue #2536).
    const built = await resolveContainerImageForStartApi(lambda, skipPull);
    imageRef = built.imageRef;
    platform = architectureToPlatform(lambda.architecture);
  }

  // Env vars: literal template values + --env-vars overlay. When
  // `--from-state` was passed (and state for this Lambda's stack
  // loaded), intrinsic-valued template entries are first substituted
  // against deployed cdkd state + AWS pseudo parameters via
  // `substituteEnvVarsFromState`. Per-key failures (state missing for
  // a referenced logical id, attribute not captured at deploy time,
  // unsupported intrinsic shape) warn-and-drop with context. Keys the
  // state-resolver already warned about are suppressed in the downstream
  // env-resolver's generic warn loop so the user sees one warn per key.
  let templateEnv = getTemplateEnv(lambda.resource);
  // Keyed by stack AND, in mixed mode, this function's routed services.
  const stateBundle = stateByStack.get(
    stateBundleKey(lambda.stack.stackName, {
      logicalId,
      cdkPath: readCdkPathOrUndefined(lambda.resource),
    })
  );
  let stateAudit: ReturnType<typeof substituteEnvVarsFromState>['audit'] | undefined;
  if (stateBundle) {
    const context: SubstitutionContext = { resources: stateBundle.state.resources };
    if (stateBundle.pseudoParameters) {
      context.pseudoParameters = stateBundle.pseudoParameters;
    }
    const { env, audit } = substituteEnvVarsFromState(templateEnv, context);
    templateEnv = env;
    stateAudit = audit;
    for (const key of audit.resolvedKeys) {
      getLogger().debug(`Lambda ${logicalId}: --from-state substituted env var ${key}`);
    }
    for (const { key, reason } of audit.unresolved) {
      getLogger().warn(
        `Lambda ${logicalId}: --from-state could not substitute env var ${key} (${reason}). ` +
          `Override it via --env-vars or it will be dropped.`
      );
    }
  }
  const lambdaCdkPath = readCdkPathOrUndefined(lambda.resource);
  const envResult = resolveEnvVars(logicalId, lambdaCdkPath, templateEnv, overrides);
  for (const key of envResult.unresolved) {
    // The state-resolver already warned for keys it tried + failed on
    // (defensive: substituteEnvVarsFromState drops unresolved keys from
    // the returned env so the env-resolver never sees them, but mirror
    // `cdkd local invoke --from-state`'s safety dedupe in case the
    // state-resolver evolves).
    if (stateAudit && stateAudit.unresolved.some((u) => u.key === key)) continue;
    // Prefer the L2 form (`MyStack/MyFn`) in the suggestion since that
    // matches docs/local-invoke.md's target-resolution guidance and the
    // `cdkd local invoke` target shape;
    // the resolver's prefix rule accepts either form.
    const overrideKeyExample = lambdaCdkPath?.replace(/\/Resource$/, '') ?? logicalId;
    getLogger().warn(
      `Lambda ${logicalId}: env var ${key} contains a CloudFormation intrinsic and was dropped. ` +
        `Override it with --env-vars (e.g. {"${overrideKeyExample}":{"${key}":"<literal>"}}) ` +
        `or pass --from-state to recover deployed values.`
    );
  }
  warnAwsEmulatorStateSourceHint(envResult.unresolved.length, stateSourceActive === true);

  // CloudFormation dynamic references (`{{resolve:...}}`), resolved ONCE here
  // at server boot against the region of the stack owning the Lambda (issue
  // #2056, mirroring cdk-local#784's `buildContainerSpec`). Plaintext keys
  // (the audit's `sensitiveKeys`) and `--env-vars` overrides are left as they
  // are; a failed lookup throws, naming the reference, and the server does
  // not start with the token in place of the value.
  const plaintextKeys = new Set<string>(stateAudit?.sensitiveKeys ?? []);
  for (const key of keysNotFromTemplate(templateEnv, envResult.resolved)) plaintextKeys.add(key);
  const dynamicRefs = createCallerDynamicReferenceResolver(profile);
  let dynamic: Awaited<ReturnType<typeof resolveDynamicReferencesInEnv>>;
  try {
    dynamic = await resolveDynamicReferencesInEnv(envResult.resolved, {
      // Mixed mode: routed by THIS function's own "real-aws" exceptions (go-to-k/cdkd#6150).
      workload: { logicalId, cdkPath: lambdaCdkPath },
      region: firstUsableRegion(
        stateBundle?.region,
        stackRegionOverride,
        lambda.stack.region,
        stsRegion
      ),
      label: `Lambda ${logicalId}`,
      skipKeys: plaintextKeys,
      resolver: dynamicRefs,
    });
  } finally {
    dynamicRefs.dispose();
  }
  const sensitiveKeyList = [...(stateAudit?.sensitiveKeys ?? []), ...dynamic.resolvedKeys];
  const sensitiveEnvKeys = sensitiveKeyList.length > 0 ? new Set(sensitiveKeyList) : undefined;

  const dockerEnv: Record<string, string> = {
    AWS_LAMBDA_FUNCTION_NAME: logicalId,
    AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(lambda.memoryMb),
    AWS_LAMBDA_FUNCTION_TIMEOUT: String(lambda.timeoutSec),
    AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
    AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${logicalId}`,
    AWS_LAMBDA_LOG_STREAM_NAME: 'local',
    ...dynamic.env,
  };

  const roleArn = resolveStartApiAssumeRoleArn({
    logicalId,
    assumeRole,
    lambdaResource: lambda.resource,
    stateBundle,
  });
  // A Lambda always runs with `AWS_REGION` set: `--region`, the host variables
  // (`stsRegion`), the stack's own region, the state record's, then the
  // profile's — one chain for BOTH arms, the same as `cdkd local invoke`'s
  // (go-to-k/cdkd#6200; an environment-agnostic stack whose region lived only in
  // `~/.aws/config` ran region-less and the handler failed `Region is missing`).
  const containerRegion = await resolveContainerRegion({
    region: stsRegion,
    stackRegion: lambda.stack.region,
    stateRegion: stateBundle?.region,
    profile,
  });
  if (roleArn) {
    const creds = await assumeLambdaExecutionRole(roleArn, containerRegion, emulateRoleVia);
    // cdkd-local-env-identity: `--assume-role`'s own STS hop — the flag whose
    // entire job is to choose this Lambda's identity. Its STS client opts out
    // of the `--role-arn` role, so the hop is answered by the caller.
    dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
    dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
    dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
    setContainerRegion(dockerEnv, containerRegion);
  } else {
    forwardAwsEnv(dockerEnv);
    setContainerRegion(dockerEnv, containerRegion);
    // Issue #654: when `--profile <p>` is set AND this Lambda has no
    // `--assume-role` mapping, overlay the profile-resolved credentials
    // on top of whatever `forwardAwsEnv` copied from `process.env`. The
    // overlay covers SSO / IAM Identity Center / regular access key /
    // role-assumption profiles uniformly (resolved via the SDK's
    // default credential chain). Without this overlay, a dev who runs
    // `cdkd local start-api --profile dev` AND has no
    // `AWS_ACCESS_KEY_ID` env var (the common SSO / Identity Center
    // case) sees the Lambda boot with no creds → handler's AWS SDK
    // call fails with `Could not load credentials from any providers`.
    //
    // Region from forwardAwsEnv is preserved — only the credential
    // triple is overlaid. Existing precedence: assume-role > profile >
    // forwarded process env.
    if (profileCredentials) {
      // cdkd-local-env-identity: `--profile`, resolved by
      // `resolveProfileCredentials` through
      // `awsClientDefaults({ ignoreAssumedRole: true })` — the caller's own
      // chain, never the `--role-arn` role. Runs AFTER the caller-identity
      // restore in `forwardAwsEnv` and deliberately outranks it: both are the
      // caller, and the flag is the more specific of the two.
      dockerEnv['AWS_ACCESS_KEY_ID'] = profileCredentials.accessKeyId;
      dockerEnv['AWS_SECRET_ACCESS_KEY'] = profileCredentials.secretAccessKey;
      if (profileCredentials.sessionToken) {
        dockerEnv['AWS_SESSION_TOKEN'] = profileCredentials.sessionToken;
      } else {
        // The profile resolved to long-lived creds (no session token).
        // Strip any inherited session token to avoid the SDK trying
        // to use a mismatched (long-lived AKID + foreign session).
        delete dockerEnv['AWS_SESSION_TOKEN'];
      }
    }

    // Issue #2 deferred from #655 (profile-aware SDK config inside
    // container): when the server boot synthesized a credentials file via
    // `writeProfileCredentialsFile(options.profile, ...)`, point the
    // container's SDK chain at the bind-mounted path so
    // `fromIni({ profile: '<name>' })` calls inside the handler resolve
    // to the same creds as the default chain. `AWS_PROFILE` makes
    // `fromIni()` (no explicit arg) ALSO use this profile — both code
    // paths converge on the same `[<name>]` section.
    //
    // GATED on `!roleArn` (nested in the assume-role-NOT-effective branch)
    // so the existing precedence "assume-role > profile > env" holds for
    // the file path too. Without this nesting, a handler in an
    // assume-role'd Lambda that called `fromIni({ profile: '<name>' })`
    // explicitly would silently bypass the execution-role creds and use
    // the `--profile <name>` creds — breaking the documented precedence
    // (PR #670 code review finding #1).
    if (profileCredsFile) {
      dockerEnv['AWS_SHARED_CREDENTIALS_FILE'] = profileCredsFile.containerPath;
      dockerEnv['AWS_PROFILE'] = profileCredsFile.profileName;
    }
  }

  if (debugPort !== undefined) {
    dockerEnv['NODE_OPTIONS'] = `--inspect-brk=0.0.0.0:${debugPort}`;
  }

  // Issue #440 — Lambda EphemeralStorage.Size: when the function's
  // template declared `EphemeralStorage`, plumb the configured `/tmp`
  // cap through to every cold-start of this Lambda's warm pool so
  // the local container's `/tmp` matches the deployed function's
  // sized tmpfs. Resolved here (once at server boot) rather than at
  // acquire-time because the value is template-static for the
  // server's lifetime. Applies to BOTH ZIP and IMAGE Lambdas.
  const tmpfs =
    lambda.ephemeralStorageMb !== undefined
      ? { target: '/tmp', sizeMb: lambda.ephemeralStorageMb }
      : undefined;

  if (lambda.kind === 'zip') {
    const spec: ContainerSpec = {
      kind: 'zip',
      lambda,
      codeDir: codeDir!,
      // Issue #768: the ZIP branch sets `platform` from the function's
      // declared arch above; carry it onto the spec so the warm-container
      // pool's `docker run` pins `--platform` (the IMAGE spec already does).
      platform: platform!,
      env: dockerEnv,
      ...(sensitiveEnvKeys !== undefined && { sensitiveEnvKeys }),
      containerHost,
      ...(optDir !== undefined && { optDir }),
      ...(debugPort !== undefined && { debugPort }),
      ...(tmpfs !== undefined && { tmpfs }),
      ...(profileCredsFile && {
        profileCredentialsFile: {
          hostPath: profileCredsFile.hostPath,
          containerPath: profileCredsFile.containerPath,
        },
      }),
    };
    return spec;
  }

  // Issue #6018: run the image under a mounted Lambda RIE (resolved once per
  // boot / `--watch` reload, so a cold start pays nothing extra). `undefined`
  // keeps the pre-#6018 shape: the image already starts an RIE, or the binary
  // could not be obtained (warned once).
  const rie = await resolveRieWrap({
    image: imageRef!,
    platform: platform!,
    entryPoint: lambda.imageConfig.entryPoint,
    command: lambda.imageConfig.command,
    skipPull,
  });

  const spec: ContainerSpec = {
    kind: 'image',
    lambda,
    image: imageRef!,
    platform: platform!,
    command: rie ? rie.cmd : (lambda.imageConfig.command ?? []),
    ...(rie && { entryPoint: rie.entryPoint, rieMount: rie.mount }),
    ...(!rie &&
      lambda.imageConfig.entryPoint !== undefined &&
      lambda.imageConfig.entryPoint.length > 0 && {
        entryPoint: lambda.imageConfig.entryPoint,
      }),
    ...(lambda.imageConfig.workingDirectory !== undefined && {
      workingDir: lambda.imageConfig.workingDirectory,
    }),
    env: dockerEnv,
    ...(sensitiveEnvKeys !== undefined && { sensitiveEnvKeys }),
    containerHost,
    ...(debugPort !== undefined && { debugPort }),
    ...(tmpfs !== undefined && { tmpfs }),
    ...(profileCredsFile && {
      profileCredentialsFile: {
        hostPath: profileCredsFile.hostPath,
        containerPath: profileCredsFile.containerPath,
      },
    }),
  };
  return spec;
}

/**
 * Resolve a container Lambda's local docker image — local build from
 * `cdk.out` asset manifest first, ECR-pull fallback when the asset
 * manifest has no matching entry. Mirrors `cdkd local invoke`'s
 * `resolveContainerImagePlan` shape; the start-api server doesn't
 * need the no-build flag (deterministic-tag cache reuse is automatic
 * across reloads because the per-Lambda tag is content-addressed).
 *
 * NOT same-region-only on the ECR-pull path: `pullEcrImage` authenticates
 * against the image URI's OWN region, so a cross-region image pulls fine. The
 * real limit here is cross-ACCOUNT — unlike `local invoke` / `run-task` /
 * `invoke-agentcore` this command declares no `--ecr-role-arn`, so it can only
 * use credentials already granted `ecr:GetAuthorizationToken` +
 * `ecr:BatchGetImage` on the repository (issue #2536 corrected the message and
 * this comment; the earlier "W2-1 deferred" wording predated #455).
 */
export async function resolveContainerImageForStartApi(
  lambda: ResolvedStartApiImageLambda,
  skipPull: boolean
): Promise<{ imageRef: string }> {
  const logger = getLogger();
  const localBuild = await resolveLocalBuildPlan(lambda);
  if (localBuild) {
    const imageRef = await buildContainerImage(localBuild.asset, localBuild.cdkOutDir, {
      // The containment bound for `source.directory` (go-to-k/cdkd#3503).
      assetOutdir: localBuild.assetOutdir,
      architecture: lambda.architecture,
      workload: { logicalId: lambda.logicalId, cdkPath: readCdkPathOrUndefined(lambda.resource) },
    });
    return { imageRef };
  }
  if (!parseEcrUri(lambda.imageUri)) {
    throw new Error(
      `Container Lambda '${lambda.logicalId}' has no matching asset in cdk.out, and Code.ImageUri ` +
        `'${lambda.imageUri}' is not an ECR URI cdkd can authenticate against. ` +
        'Re-synthesize the CDK app (so cdk.out includes the build context) or deploy the image to ECR first.'
    );
  }
  logger.info(
    // Cross-REGION is fine — `pullEcrImage` builds its ECR client for the image
    // URI's own region. The real constraint on THIS command is that it carries no
    // `--ecr-role-arn` (unlike `local invoke` / `run-task` / `invoke-agentcore`),
    // so a cross-account pull works only with credentials that already hold
    // `ecr:GetAuthorizationToken` + `ecr:BatchGetImage` on the repository
    // (issue #2536).
    `No matching cdk.out asset for ${lambda.imageUri}; falling back to ECR pull (uses your own credentials — this command has no --ecr-role-arn, so a cross-account image needs cross-account ECR permissions)...`
  );
  const imageRef = await pullEcrImage(lambda.imageUri, {
    skipPull,
    // Mixed mode: real ECR only when THIS function excepts ECR (#6179).
    workload: { logicalId: lambda.logicalId, cdkPath: readCdkPathOrUndefined(lambda.resource) },
  });
  return { imageRef };
}

/**
 * Look up the docker image asset that backs a container Lambda.
 * Returns `undefined` when the asset manifest has no matching entry —
 * the caller falls back to the ECR-pull path.
 *
 * Mirrors `local-invoke.ts:resolveLocalBuildPlan`; kept separate so
 * the two commands evolve their asset-lookup heuristics independently.
 */
async function resolveLocalBuildPlan(
  lambda: ResolvedStartApiImageLambda
): Promise<
  { asset: { source: DockerImageAssetSource }; cdkOutDir: string; assetOutdir: string } | undefined
> {
  const manifestPath = lambda.stack.assetManifestPath;
  if (!manifestPath) return undefined;
  // BASE from the manifest, BOUND from the app outdir (go-to-k/cdkd#3489).
  const { manifestDir: cdkOutDir, assetOutdir } = assetPathDirs(lambda.stack);
  const loader = new AssetManifestLoader();
  const manifest = await loader.loadStackManifest(lambda.stack, cdkOutDir);
  if (!manifest) return undefined;
  const entry = getDockerImageBySourceHash(manifest, lambda.imageUri);
  if (!entry) return undefined;
  return { asset: entry.asset, cdkOutDir, assetOutdir };
}

/**
 * Build the `/opt` bind-mount source for a Lambda's layers. Mirrors
 * the helper in `src/cli/commands/local-invoke.ts` but stores the
 * merged tmpdir into the shared `layerTmpDirs` set so the server's
 * graceful shutdown path can clean it up. Returns `undefined` when
 * the function declares no layers.
 *
 * Three branches:
 *   - 0 layers → `undefined` (no `/opt` mount).
 *   - 1 layer → bind-mount the layer's asset dir directly (no copy)
 *     when the entry is a same-stack asset. Literal-ARN entries always
 *     pre-materialize first.
 *   - 2+ layers → copy each into a fresh tmpdir IN ORDER (later
 *     layers overwrite earlier files via `copyLayerTreeLastWins`),
 *     bind-mount the tmpdir at `/opt`. Records the tmpdir in
 *     `layerTmpDirs` so `shutdown(...)` removes it.
 *
 * Issue #448: literal-ARN entries (`{kind: 'arn', ...}`) are downloaded
 * + unzipped via `lambda:GetLayerVersion` BEFORE the merge
 * branches run. Every per-ARN tmpdir is also recorded in `layerTmpDirs`
 * so the same shutdown path cleans it up — even for the single-layer
 * fast path that bind-mounts the dir directly.
 *
 * AWS Lambda's actual runtime extracts every layer ZIP into `/opt`
 * in template order — the merge mirrors that. Docker rejects multiple
 * `-v ...:/opt:ro` entries at the same target, so cdkd can't rely on
 * overlay layering and must produce a single merged dir on the host.
 */
export async function materializeLambdaLayers(
  layers: ResolvedLambdaLayer[],
  layerTmpDirs: Set<string>,
  layerRoleArn: string | undefined,
  /** Mixed mode: a literal layer ARN reads real Lambda only for this function's LAMBDA exception (#6179). */
  workload?: AwsEmulatorWorkload
): Promise<string | undefined> {
  if (layers.length === 0) return undefined;

  // Stage 1: pre-materialize every literal-ARN entry into its own
  // tmpdir (issue #448). The resulting flat list of `assetPath`
  // entries is what the existing single-layer / multi-layer merge
  // branches consume.
  const flat: { logicalId: string; assetPath: string }[] = [];
  for (const layer of layers) {
    if (layer.kind === 'asset') {
      const asset = await layerAssetDirectory(layer.assetPath);
      if (asset.tmpDir !== undefined) layerTmpDirs.add(asset.tmpDir);
      flat.push({ logicalId: layer.logicalId, assetPath: asset.dir });
      continue;
    }
    const dir = await materializeLayerFromArn(layer, {
      ...(workload && { workload }),
      // An EMPTY `--layer-role-arn ""` is an explicit value (issue #2348):
      // cdk-local reads `roleArn` by truthiness and would pull as the caller.
      ...(layerRoleArn !== undefined && {
        roleArn: explicitRoleArnOrThrow('--layer-role-arn', layerRoleArn),
      }),
    });
    layerTmpDirs.add(dir);
    flat.push({ logicalId: layer.arn, assetPath: dir });
  }

  if (flat.length === 1) return flat[0]!.assetPath;
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-start-api-layers-'));
  try {
    for (const layer of flat) {
      // Merged in template order with AWS's "last layer wins" semantic, mode
      // bits (`+x`) preserved and symlinks kept VERBATIM — the contract, and
      // the ways a bare `cpSync` breaks it, are written once on
      // `copyLayerTreeLastWins` (issue #3106); `local-invoke/image-plan.ts`'s
      // `materializeLambdaLayers` is the same call. The `local-invoke-layers`
      // fixture exercises it end-to-end.
      copyLayerTreeLastWins(layer.assetPath, dir);
    }
  } catch (error) {
    // Not yet in `layerTmpDirs`, so shutdown would never remove it.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  layerTmpDirs.add(dir);
  return dir;
}
