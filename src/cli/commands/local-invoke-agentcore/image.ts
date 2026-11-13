import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLogger } from '../../../utils/logger.js';
import { readCdkPathOrUndefined } from '../../cdk-path.js';
import { describeLocalAwsFailureForWarn } from '../../../utils/local-aws-failure.js';
import { displayIdent, displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { displayAssemblyPath } from '../../../utils/assembly-path.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { CdkdError } from '../../../utils/error-handler.js';
import type { LocalStateProvider, LocalStateRecord } from 'cdk-local';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import { getEmbedConfig } from 'cdk-local';
import {
  type AgentCoreCodeArtifact,
  type ResolvedAgentCoreRuntime,
} from '../../../local/agentcore-resolver.js';
import { buildAgentCoreCodeImage } from '../../../local/agentcore-code-build.js';
import { downloadAndExtractS3Bundle } from '../../../local/agentcore-s3-bundle.js';
import {
  substituteAgainstStateAsync,
  type SubstitutionContext,
} from '../../../local/state-resolver.js';
import {
  derivePseudoParametersFromRegion,
  type ImageResolutionContext,
} from '../../../local/intrinsic-image.js';
import { pullImage } from '../../../local/docker-runner.js';
import { buildContainerImage } from '../../../local/docker-image-builder.js';
import { parseEcrUri, pullEcrImage } from '../../../local/ecr-puller.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../../../assets/asset-manifest-loader.js';
import type { FileAsset } from '../../../types/assets.js';
import {
  resolveStackAccountId,
  assumeRoleFallbackWarning,
  resolveAssumeRoleArn,
  assumeAgentCoreExecutionRole,
} from './env.js';
import { platformToArchitecture } from './output.js';
import type { LocalInvokeAgentCoreOptions } from './types.js';

/**
 * Acquire the agent image. A CODE artifact (managed runtime) is built from
 * source — a fromCodeAsset bundle from its cdk.out asset, a fromS3 bundle
 * downloaded + extracted from S3. A CONTAINER artifact mirrors the
 * container-Lambda path: build from a local cdk.out asset when the URI matches
 * one, else pull from ECR, else pull a plain registry image.
 *
 * `loaded` is the `--from-cfn-stack` state record (when available) — threaded
 * through so a bare `--assume-role` can resolve the execution-role ARN from
 * state for the fromS3 download.
 *
 * `assemblyDir` is the ASSEMBLY ROOT as `Synthesizer.synthesize` reported it,
 * and is the containment bound for an asset path read out of the manifest
 * (issue go-to-k/cdkd#3489). It is NOT `options.output`: under
 * `-a <pre-synthesized dir>` synthesis is skipped and the assembly root is
 * `resolve(options.app)` while `--output` keeps its `cdk.out` default, so
 * binding to `--output` would refuse every asset of an untouched assembly.
 */
export async function resolveAgentCoreImage(
  resolved: ResolvedAgentCoreRuntime,
  options: LocalInvokeAgentCoreOptions,
  assemblyDir: string,
  loaded?: LocalStateRecord
): Promise<string> {
  const logger = getLogger();
  const architecture = platformToArchitecture(options.platform);

  if (resolved.codeArtifact) {
    return resolveAgentCoreCodeImage(
      resolved,
      resolved.codeArtifact,
      options,
      architecture,
      assemblyDir,
      loaded
    );
  }

  const containerUri = resolved.containerUri;
  if (containerUri === undefined) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' has neither a container image nor a code artifact to run.`,
      'LOCAL_INVOKE_AGENTCORE_NO_ARTIFACT'
    );
  }

  const manifestPath = resolved.stack.assetManifestPath;
  if (manifestPath) {
    const cdkOutDir = dirname(manifestPath);
    const loader = new AssetManifestLoader();
    const manifest = await loader.loadStackManifest(resolved.stack, cdkOutDir);
    if (manifest) {
      const entry = getDockerImageBySourceHash(manifest, containerUri);
      if (entry) {
        return buildContainerImage(entry.asset, cdkOutDir, {
          // `assemblyDir`, not `cdkOutDir`: the same bound, for the same Stage
          // reason, as the code arm's `getAssetSourcePath` below
          // (go-to-k/cdkd#3503).
          assetOutdir: assemblyDir,
          architecture,
          noBuild: options.build === false,
          workload: {
            logicalId: resolved.logicalId,
            cdkPath: readCdkPathOrUndefined(resolved.resource),
          },
        });
      }
    }
  }

  if (parseEcrUri(containerUri)) {
    logger.info(`Pulling agent image from ECR: ${containerUri}`);
    return pullEcrImage(containerUri, {
      // Mixed mode: real ECR only when THIS runtime excepts ECR (#6179).
      workload: {
        logicalId: resolved.logicalId,
        cdkPath: readCdkPathOrUndefined(resolved.resource),
      },
      skipPull: options.pull === false,
      ...(options.region !== undefined && { region: options.region }),
      ...(options.ecrRoleArn !== undefined && { ecrRoleArn: options.ecrRoleArn }),
      ...(options.profile !== undefined && { profile: options.profile }),
    });
  }

  await pullImage(containerUri, options.pull === false);
  return containerUri;
}

/**
 * Build a local image from a `CodeConfiguration` (managed-runtime) bundle.
 *
 * - fromS3 (`code.s3Source` set, a literal S3 object): download + extract the
 *   bundle, then run the from-source build over the extracted dir.
 * - fromCodeAsset: locate the source dir in cdk.out via its asset hash, then
 *   run the same from-source build (generated Dockerfile → install deps → run
 *   EntryPoint).
 */
async function resolveAgentCoreCodeImage(
  resolved: ResolvedAgentCoreRuntime,
  code: AgentCoreCodeArtifact,
  options: LocalInvokeAgentCoreOptions,
  architecture: 'x86_64' | 'arm64',
  assemblyDir: string,
  loaded?: LocalStateRecord
): Promise<string> {
  if (code.s3Source) {
    return resolveAgentCoreCodeImageFromS3(
      resolved,
      code,
      code.s3Source,
      options,
      architecture,
      loaded
    );
  }

  const manifestPath = resolved.stack.assetManifestPath;
  if (!manifestPath) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' uses a code artifact, but its stack has no asset ` +
        `manifest in cdk.out to read the bundle source from.`,
      'LOCAL_INVOKE_AGENTCORE_CODE_NO_MANIFEST'
    );
  }
  const cdkOutDir = dirname(manifestPath);
  const loader = new AssetManifestLoader();
  const manifest = await loader.loadStackManifest(resolved.stack, cdkOutDir);
  const fileAssets = manifest ? loader.getFileAssets(manifest) : undefined;
  // The manifest's `files` are keyed by SOURCE hash; for the default
  // synthesizer that equals the destination objectKey hash (`<hash>.zip`), so a
  // direct key lookup hits. Fall back to matching the destination objectKey so
  // a synthesizer that emits a prefixed / differing objectKey still resolves.
  const asset = fileAssets
    ? (fileAssets.get(code.codeAssetHash) ??
      findFileAssetByObjectKey(fileAssets, code.codeAssetHash))
    : undefined;
  if (!asset) {
    // cdkd-raw-beside-safe: `getEmbedConfig().cliName` is this binary's own
    // configured name, not a value the assembly or the user supplies.
    throw new CdkdError(
      `AgentCore Runtime ${displayIdent(resolved.logicalId)} code bundle (asset ${displaySafe(code.codeAssetHash)}) was not found ` +
        `in the cdk.out asset manifest. ${getEmbedConfig().cliName} invoke-agentcore runs a local from-source ` +
        `build of a fromCodeAsset bundle — re-synthesize the app so the asset is staged in cdk.out and retry. ` +
        `(A fromS3 bundle is downloaded from S3 instead; this runtime has no literal Code.S3.Bucket.)`,
      'LOCAL_INVOKE_AGENTCORE_CODE_ASSET_NOT_FOUND'
    );
  }
  // `cdkOutDir` is the MANIFEST's directory, which for a Stage stack is
  // `cdk.out/assembly-<Stage>/` while the asset itself is staged in the app
  // root — so the containment bound is the assembly root, or a Stage's
  // legitimate `../asset.<hash>` is refused (issue go-to-k/cdkd#3489).
  // `assemblyDir` is that root as `Synthesizer.synthesize` reported it;
  // `options.output` is NOT, because `-a <pre-synthesized dir>` skips synthesis
  // and never reads `--output`. `resolved.stack` is cdk-local's StackInfo and
  // carries no `assetOutdir`, so the value is threaded in from the command.
  const sourceDir = loader.getAssetSourcePath(cdkOutDir, asset, {
    assetOutdir: assemblyDir,
    sink: 'read that directory and build a local image from it',
  });
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new CdkdError(
      // `sourceDir` is manifest-derived, and this message is the one READER of
      // the value the containment check above produced (go-to-k/cdkd#3277).
      `AgentCore Runtime ${displayIdent(resolved.logicalId)} code bundle source ${displayAssemblyPath(sourceDir)} does not exist or is not a ` +
        `directory. Re-synthesize the app and retry.`,
      'LOCAL_INVOKE_AGENTCORE_CODE_SOURCE_MISSING'
    );
  }
  return buildAgentCoreCodeImage({
    sourceDir,
    runtime: code.runtime,
    entryPoint: code.entryPoint,
    architecture,
    noBuild: options.build === false,
  });
}

/**
 * Build a local image from a fromS3 CodeConfiguration bundle: download +
 * extract the S3 object, run the from-source build over the extracted dir, then
 * clean up the temp dir.
 *
 * Credentials mirror the rest of the command: an `--assume-role` ARN (explicit,
 * or resolved from `--from-cfn-stack` state for the bare form) yields STS temp
 * creds for the download; otherwise `--profile` / the default chain is used.
 * The region is `--region` / `--stack-region` / env / the stack's region.
 *
 * Exported so its `--assume-role` fallback warn can be driven by unit tests
 * (go-to-k/cdkd#2300), as cdk-local exports its twin.
 */
export async function resolveAgentCoreCodeImageFromS3(
  resolved: ResolvedAgentCoreRuntime,
  code: AgentCoreCodeArtifact,
  s3Source: NonNullable<AgentCoreCodeArtifact['s3Source']>,
  options: LocalInvokeAgentCoreOptions,
  architecture: 'x86_64' | 'arm64',
  loaded: LocalStateRecord | undefined
): Promise<string> {
  const logger = getLogger();
  // The bucket should be a literal string by this point — a template-literal
  // bucket falls through from the resolver, an intrinsic bucket was resolved by
  // `resolveFromS3BucketIntrinsic` in the outer command before we got here.
  if (typeof s3Source.bucket !== 'string' || s3Source.bucket.length === 0) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' fromS3 bundle reached the image step with no literal bucket. ` +
        `This is a cdkd bug — please report it.`,
      'LOCAL_INVOKE_AGENTCORE_FROMS3_BUCKET_UNRESOLVED'
    );
  }
  const location = {
    bucket: s3Source.bucket,
    key: s3Source.key,
    ...(s3Source.versionId !== undefined && { versionId: s3Source.versionId }),
  };
  const region = canonicalizeRegion(
    options.region ??
      options.stackRegion ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      resolved.stack.region
  );

  const assumeRoleArn = resolveAssumeRoleArn(options, resolved, loaded);
  let credentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken: string }
    | undefined;
  if (assumeRoleArn) {
    try {
      credentials = await assumeAgentCoreExecutionRole(
        assumeRoleArn,
        region,
        options.emulateRoleVia
      );
    } catch (err) {
      logger.warn(
        assumeRoleFallbackWarning({
          assumeRoleArn,
          purpose: 'the fromS3 bundle download',
          error: err,
          profile: options.profile,
          fallbackWithoutProfile: 'the default credentials',
        })
      );
    }
  }

  const bundle = await downloadAndExtractS3Bundle(location, {
    // Mixed mode: real S3 only when THIS runtime excepts S3 (#6179).
    workload: { logicalId: resolved.logicalId, cdkPath: readCdkPathOrUndefined(resolved.resource) },
    ...(region !== undefined && { region }),
    ...(options.profile !== undefined && { profile: options.profile }),
    ...(credentials !== undefined && { credentials }),
  });
  try {
    return await buildAgentCoreCodeImage({
      sourceDir: bundle.dir,
      runtime: code.runtime,
      entryPoint: code.entryPoint,
      architecture,
      noBuild: options.build === false,
    });
  } finally {
    await bundle.cleanup();
  }
}

/**
 * Find the file asset whose destination objectKey is `<hash>.zip` (matching the
 * `Code.S3.Prefix`'s hash) when the source-hash-keyed lookup misses — covers a
 * synthesizer whose source hash differs from the destination objectKey.
 */
function findFileAssetByObjectKey(
  fileAssets: Map<string, FileAsset>,
  hash: string
): FileAsset | undefined {
  const zip = `${hash}.zip`;
  for (const asset of fileAssets.values()) {
    const hit = Object.values(asset.destinations).some(
      (d) => d.objectKey === zip || d.objectKey.endsWith(`/${zip}`)
    );
    if (hit) return asset;
  }
  return undefined;
}

/**
 * Resolve a fromS3 bundle's intrinsic `Code.S3.Bucket` to a literal bucket
 * name in place on `resolved.codeArtifact.s3Source.bucket`. Uses the SAME
 * state-substitution machinery env vars use under `--from-cfn-stack`, so
 * every cross-stack intrinsic that path supports (`Ref` / `Fn::ImportValue` /
 * `Fn::GetStackOutput`) is supported transparently here.
 *
 * No-op when there is no intrinsic to resolve. Errors when no state is
 * available, or when the substitution returns a non-string / unresolved value.
 *
 * Exported so a unit test can drive the gate without the full Docker pipeline.
 */
export async function resolveFromS3BucketIntrinsic(
  resolved: ResolvedAgentCoreRuntime,
  stateProvider: LocalStateProvider | undefined,
  loaded: LocalStateRecord | undefined,
  imageContext: ImageResolutionContext | undefined
): Promise<void> {
  const s3Source = resolved.codeArtifact?.s3Source;
  if (!s3Source || s3Source.bucketIntrinsic === undefined) return;
  if (s3Source.bucket !== undefined) return; // already resolved

  if (!stateProvider || !loaded) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' fromS3 bundle's Code.S3.Bucket is an unresolved intrinsic ` +
        `(${describeIntrinsic(s3Source.bucketIntrinsic)}). ` +
        `Pass --from-cfn-stack so its physical bucket name can be resolved against the deployed stack state.`,
      'LOCAL_INVOKE_AGENTCORE_FROMS3_BUCKET_INTRINSIC_NO_STATE'
    );
  }

  const subContext: SubstitutionContext = {
    resources: imageContext?.stateResources ?? loaded.resources,
    consumerRegion: loaded.region,
  };
  const pseudo = imageContext?.pseudoParameters ?? derivePseudoParametersFromRegion(loaded.region);
  if (pseudo) subContext.pseudoParameters = pseudo;
  const crossStackResolver = await stateProvider.buildCrossStackResolver(loaded.region);
  if (crossStackResolver) subContext.crossStackResolver = crossStackResolver;

  const result = await substituteAgainstStateAsync(s3Source.bucketIntrinsic, subContext);
  if (result.kind !== 'literal') {
    throw new CdkdError(
      `Could not resolve AgentCore Runtime '${resolved.logicalId}' fromS3 Code.S3.Bucket intrinsic ` +
        `(${describeIntrinsic(s3Source.bucketIntrinsic)}) against the --from-cfn-stack state: ${result.reason}. ` +
        `Confirm the referenced resource / export exists in the deployed stack.`,
      'LOCAL_INVOKE_AGENTCORE_FROMS3_BUCKET_INTRINSIC_UNRESOLVED'
    );
  }
  if (typeof result.value !== 'string' || result.value.length === 0) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' fromS3 Code.S3.Bucket intrinsic resolved to a ` +
        `${typeof result.value} value, not a bucket name string. ` +
        `(${describeIntrinsic(s3Source.bucketIntrinsic)})`,
      'LOCAL_INVOKE_AGENTCORE_FROMS3_BUCKET_INTRINSIC_NOT_STRING'
    );
  }
  s3Source.bucket = result.value;
  getLogger().info(
    `Resolved fromS3 Code.S3.Bucket from state: ${describeIntrinsic(s3Source.bucketIntrinsic)} resolved to ${result.value}`
  );
}

/** Render the intrinsic key for an error / log message (e.g. `Ref:Bucket1`). */
function describeIntrinsic(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const obj = value as Record<string, unknown>;
  const key = Object.keys(obj)[0] ?? '?';
  const arg = obj[key];
  if (typeof arg === 'string') return `${key}:${arg}`;
  return key;
}

/**
 * Build the state-source (`--from-state` / `--from-cfn-stack`) image-resolution
 * context + return the loaded state record (loaded once, reused by env substitution + role resolution).
 * Mirrors `run-task`'s `buildEcsImageResolutionContext`: pseudo parameters
 * (region + STS account id), the deployed resources, and SSM template
 * parameters (decrypted SecureString logical ids flagged sensitive).
 */
export async function buildAgentCoreImageContext(
  candidate: StackInfo,
  stateProvider: LocalStateProvider,
  options: LocalInvokeAgentCoreOptions
): Promise<{ context: ImageResolutionContext | undefined; loaded: LocalStateRecord | undefined }> {
  const logger = getLogger();
  const region = canonicalizeRegion(
    options.region ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      candidate.region
  );

  let accountId: string | undefined;
  try {
    accountId = await resolveStackAccountId(
      region,
      options.profile,
      options.fromState,
      options.fromCfnStack
    );
  } catch (err) {
    // cdkd-raw-beside-safe: the template is a `safeMsg` tag, which sanitizes
    // every interpolation, `stateProvider.label` included.
    logger.warn(
      safeMsg`${stateProvider.label}: STS GetCallerIdentity failed: ${describeLocalAwsFailureForWarn(err, 'STS GetCallerIdentity')}. ` +
        'A same-stack ECR image URI referencing ${AWS::AccountId} may not resolve.'
    );
  }

  const context: ImageResolutionContext = {};
  const pseudo = derivePseudoParametersFromRegion(region, accountId);
  if (pseudo) context.pseudoParameters = pseudo;

  const loaded = await stateProvider.load(candidate.stackName, candidate.region);
  if (loaded) {
    context.stateResources = loaded.resources;
    if (stateProvider.resolveTemplateSsmParameters) {
      const ssm = await stateProvider.resolveTemplateSsmParameters(candidate.template);
      if (Object.keys(ssm.values).length > 0) context.stateParameters = ssm.values;
      if (ssm.secureStringLogicalIds.length > 0) {
        context.stateSensitiveParameters = ssm.secureStringLogicalIds;
      }
    }
  }
  return { context, loaded: loaded ?? undefined };
}
