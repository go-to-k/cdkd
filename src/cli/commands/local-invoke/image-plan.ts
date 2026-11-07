import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getLogger } from '../../../utils/logger.js';
import { explicitRoleArnOrThrow } from '../../../utils/role-arn.js';
import {
  assetPathDirs,
  type ResolvedImageLambda,
  type ResolvedLambda,
  type ResolvedLambdaLayer,
  type ResolvedZipLambda,
} from '../../../local/lambda-resolver.js';
import { materializeLayerFromArn } from '../../../local/layer-arn-materializer.js';
import { copyLayerTreeLastWins } from '../../../local/layer-tree-copy.js';
import {
  resolveRuntimeCodeMountPath,
  resolveRuntimeFileExtension,
  resolveRuntimeImage,
} from '../../../local/runtime-image.js';
import { pullImage } from '../../../local/docker-runner.js';
import { architectureToPlatform } from '../../../local/docker-image-builder.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../../../assets/asset-manifest-loader.js';
import { materializeInlineCode } from './inline-code.js';
import { type LocalInvokeOptions } from './types.js';

/**
 * Result of resolving the docker image, bind-mounts, and CMD / entrypoint /
 * workdir / platform fields that depend on the function's `kind`. Built by
 * {@link resolveImagePlan}; consumed by `runDetached`.
 *
 * For ZIP Lambdas: `image` is a public Lambda base image, `mounts` carries
 * one entry that bind-mounts the local code at /var/task, `cmd` is
 * `[handler]`. `platform` is set per `Architectures` (issue #768);
 * `entryPoint` / `workingDir` are unset.
 *
 * For IMAGE Lambdas (PR 5): `image` is either a locally-built tag (asset
 * manifest hit) or the deployed ECR URI (fallback). `mounts` is empty (the
 * code is already in the image). `cmd` / `entryPoint` / `workingDir` come
 * from `ImageConfig`. `platform` is set per `Architectures` (D5.6).
 */
export interface ImagePlan {
  image: string;
  mounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  /**
   * Lambda Layer mounts (PR 6 of #224, issue #232). The function's
   * `Properties.Layers` references collapse to a single bind mount at
   * `/opt`. Why one mount, not one-per-layer: Docker rejects multiple
   * bind mounts at the same target path (`Error response from daemon:
   * Duplicate mount point: /opt`) — bind mounts are NOT layered the
   * way the OCI image stack is. AWS Lambda implements layer
   * stacking by extracting each layer's ZIP into `/opt` IN ORDER so
   * later layers overwrite earlier files; cdkd mirrors that on the
   * host by merging (`copyLayerTreeLastWins`) each layer's asset directory into one
   * tmpdir and bind-mounting THAT at `/opt`. The single-layer case
   * skips the copy and bind-mounts the layer's asset dir directly.
   * Empty `[]` for container Lambdas and ZIP Lambdas with no layers.
   */
  extraMounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  cmd: string[];
  platform?: string;
  entryPoint?: string[];
  workingDir?: string;
  /**
   * Set when the ZIP-Lambda branch materialized inline `Code.ZipFile`
   * source to a tmpdir. The CLI's outer `finally` removes this dir
   * alongside the docker container so we don't leak per-invoke tmpdirs
   * (each invoke creates a fresh `cdkd-local-invoke-*` directory under
   * the OS tmp root). Asset-backed Lambdas leave this unset.
   */
  inlineTmpDir?: string;
  /**
   * Set when multiple `Properties.Layers` were merged into a single
   * tmpdir (see {@link extraMounts}). The CLI's outer `finally`
   * removes this dir alongside the docker container so we don't leak
   * per-invoke layer-merge tmpdirs. Single-layer or no-layer functions
   * leave this unset.
   */
  layersTmpDir?: string;
  /**
   * Issue #448: per-ARN unzip tmpdirs for literal-ARN layers
   * (`Properties.Layers: ['arn:aws:lambda:...']`). One entry per ARN
   * layer regardless of whether multiple-layer merge fires above. The
   * CLI's outer `finally` walks the list with `rmSync` so the
   * downloaded layer ZIPs do not accumulate across invokes.
   */
  layerArnTmpDirs?: string[];
  /**
   * Sized tmpfs mount for `/tmp` (issue #440 — Lambda
   * `Properties.EphemeralStorage.Size`). Set when the function's
   * template declares `EphemeralStorage`; threaded through to
   * `runDetached`'s `tmpfs` option which emits
   * `--tmpfs /tmp:rw,size=<N>m`. Undefined when the property is
   * absent, in which case the container's `/tmp` is whatever the
   * base image provides (no cap). Applies to both ZIP and IMAGE
   * Lambdas.
   */
  tmpfs?: { target: string; sizeMb: number };
}

/**
 * ZIP-Lambda branch: pull the public Lambda base image, bind-mount the
 * resolved code dir at /var/task, set CMD to `[handler]`. Inline
 * (Code.ZipFile) Lambdas materialize to a tmpdir using the
 * runtime-appropriate file extension before bind-mounting.
 */
export async function resolveZipImagePlan(
  lambda: ResolvedZipLambda,
  options: LocalInvokeOptions
): Promise<ImagePlan> {
  let inlineTmpDir: string | undefined;
  let codeDir = lambda.codePath;
  if (codeDir === null) {
    inlineTmpDir = materializeInlineCode(
      lambda.handler,
      lambda.inlineCode ?? '',
      resolveRuntimeFileExtension(lambda.runtime)
    );
    codeDir = inlineTmpDir;
  }

  const image = resolveRuntimeImage(lambda.runtime);

  // Commander surfaces `--no-pull` as `pull: false` (default `true`).
  await pullImage(image, options.pull === false);

  // PR 6 (#232): merge every same-stack `AWS::Lambda::LayerVersion`
  // referenced by `Properties.Layers` into a single bind mount at
  // `/opt`. AWS extracts layer ZIPs into `/opt` IN ORDER (later
  // layers overwrite earlier files); we mirror that on the host
  // before bind-mounting because Docker rejects multiple bind mounts
  // at the same target path.
  //
  // Issue #448: literal-ARN layers (`{kind: 'arn', ...}`) are
  // pre-materialized via `lambda:GetLayerVersion` + presigned-URL
  // download + unzip BEFORE the same merge path runs, so the
  // downstream code path is identical for asset-backed and ARN-backed
  // layers. The per-ARN unzip tmpdirs are tracked alongside the merged
  // `/opt` tmpdir so the outer cleanup can remove all of them.
  const layerPlan = await materializeLambdaLayersIncludingArns(lambda.layers, options);

  // provided.al2 / provided.al2023 require the deployment package at
  // /var/runtime (where the base image's hardcoded entrypoint exec's
  // /var/runtime/bootstrap); every other runtime expects /var/task.
  const containerCodePath = resolveRuntimeCodeMountPath(lambda.runtime);

  const tmpfs = resolveTmpfsForLambda(lambda);

  return {
    image,
    mounts: [{ hostPath: codeDir, containerPath: containerCodePath, readOnly: true }],
    extraMounts: layerPlan.mount ? [layerPlan.mount] : [],
    cmd: [lambda.handler],
    // Issue #768: pin `--platform` to the function's declared arch on the
    // ZIP container run too (the IMAGE path always has). Without it a
    // `provided.*` `bootstrap` compiled for the other arch fails with
    // `exec format error` / `Runtime.InvalidEntrypoint` on an
    // arch-mismatched host; with it Docker emulates the declared arch.
    platform: architectureToPlatform(lambda.architecture),
    ...(inlineTmpDir !== undefined && { inlineTmpDir }),
    ...(layerPlan.tmpDir !== undefined && { layersTmpDir: layerPlan.tmpDir }),
    ...(layerPlan.extraTmpDirs.length > 0 && { layerArnTmpDirs: layerPlan.extraTmpDirs }),
    ...(tmpfs !== undefined && { tmpfs }),
  };
}

/**
 * Two-stage layer materialization (issue #448).
 *
 *   - Stage 1: every `{kind: 'arn'}` entry is downloaded + unzipped
 *     into its own tmpdir via `materializeLayerFromArn`. The per-ARN
 *     tmpdirs are tracked in `extraTmpDirs` so the outer cleanup can
 *     remove them.
 *   - Stage 2: the resulting `{logicalId, assetPath}[]` list (in
 *     template order — ARN entries surface their `arn` as the
 *     `logicalId` for log lines) is handed to the existing
 *     `materializeLambdaLayers` merge path. AWS's "last layer
 *     wins" file-collision semantic is preserved across both layer
 *     kinds because the merge step is unchanged.
 */
export async function materializeLambdaLayersIncludingArns(
  layers: ResolvedLambdaLayer[],
  options: LocalInvokeOptions
): Promise<{
  mount?: { hostPath: string; containerPath: string; readOnly: boolean };
  tmpDir?: string;
  extraTmpDirs: string[];
}> {
  const extraTmpDirs: string[] = [];
  const flat: { logicalId: string; assetPath: string }[] = [];
  for (const layer of layers) {
    if (layer.kind === 'asset') {
      flat.push({ logicalId: layer.logicalId, assetPath: layer.assetPath });
      continue;
    }
    const dir = await materializeLayerFromArn(layer, {
      // An EMPTY `--layer-role-arn ""` is an explicit value (issue #2348):
      // cdk-local reads `roleArn` by truthiness and would pull as the caller.
      ...(options.layerRoleArn !== undefined && {
        roleArn: explicitRoleArnOrThrow('--layer-role-arn', options.layerRoleArn),
      }),
    });
    extraTmpDirs.push(dir);
    flat.push({ logicalId: layer.arn, assetPath: dir });
  }
  const plan = materializeLambdaLayers(flat);
  return { ...plan, extraTmpDirs };
}

/**
 * Build the `--tmpfs /tmp:rw,size=<N>m` plan for a Lambda (issue #440).
 *
 * The shape is identical for ZIP and IMAGE Lambdas — `--tmpfs` overlays
 * mount-time inside any container, regardless of whether the image is a
 * public Lambda base image (ZIP path) or a user-built container Lambda.
 * Returns `undefined` when the template did not declare
 * `EphemeralStorage`, in which case the caller emits no `--tmpfs` flag
 * and the container's `/tmp` is whatever the base image provides
 * (matches pre-#440 behavior). The lambda-resolver's
 * `extractEphemeralStorageMb` already enforces the AWS 10240 MiB
 * ceiling at parse time.
 *
 * Target path is always `/tmp` — AWS Lambda's `/tmp` is the ONLY
 * sized-tmpfs surface the `EphemeralStorage.Size` property controls,
 * and the constant is centralized here so a future fixture / docs
 * update has a single grep target.
 */
export function resolveTmpfsForLambda(
  lambda: ResolvedLambda
): { target: string; sizeMb: number } | undefined {
  if (lambda.ephemeralStorageMb === undefined) return undefined;
  const logger = getLogger();
  if (lambda.kind === 'image') {
    // Container Lambdas: surface the cap at info level so users notice
    // when `--tmpfs /tmp` overlays whatever their Dockerfile placed
    // there at build time. Matches the issue spec note about logging
    // a single line on container images.
    logger.info(
      `Lambda ${lambda.logicalId}: capping /tmp at ${lambda.ephemeralStorageMb} MiB via --tmpfs (overlays any base-image /tmp content)`
    );
  } else {
    // ZIP Lambdas: base image's /tmp is just an overlay-fs path, so
    // the cap is uneventful — debug-level keeps the default output clean.
    logger.debug(
      `Lambda ${lambda.logicalId}: applying EphemeralStorage cap via --tmpfs /tmp:size=${lambda.ephemeralStorageMb}m`
    );
  }
  return { target: '/tmp', sizeMb: lambda.ephemeralStorageMb };
}

/**
 * Build the `/opt` bind mount for a Lambda's resolved layers (PR 6 of
 * #224, issue #232).
 *
 * Three cases:
 *
 *   1. **No layers**: returns `{ mount: undefined }`. The caller emits
 *      no `/opt` mount.
 *   2. **Single layer**: returns `{ mount: { hostPath, '/opt', ro }, tmpDir: undefined }`.
 *      The layer's asset directory is bind-mounted directly — faster
 *      than copying since CDK has already unzipped the asset.
 *   3. **Multiple layers**: copies each layer's contents into a fresh
 *      tmpdir IN ORDER (later layers overwrite earlier files via
 *      `copyLayerTreeLastWins`), then bind-mounts the merged tmpdir at
 *      `/opt`. Returns `{ mount, tmpDir: <path> }` so the caller can
 *      `rmSync` the tmpdir on cleanup.
 *
 * The merge case is the only way to honor AWS's "last layer wins on
 * file collision" semantics with bind mounts: Docker rejects multiple
 * `-v ...:/opt:ro` entries at the same target path, so we can't rely
 * on overlay layering at the docker-runner layer.
 */
export function materializeLambdaLayers(layers: { logicalId: string; assetPath: string }[]): {
  mount?: { hostPath: string; containerPath: string; readOnly: boolean };
  tmpDir?: string;
} {
  if (layers.length === 0) return {};
  if (layers.length === 1) {
    return {
      mount: { hostPath: layers[0]!.assetPath, containerPath: '/opt', readOnly: true },
    };
  }
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-invoke-layers-'));
  try {
    for (const layer of layers) {
      // Merged in template order with AWS's "last layer wins" semantic, mode
      // bits (`+x`) preserved and symlinks kept VERBATIM — the contract, and
      // the ways a bare `cpSync` breaks it, are written once on
      // `copyLayerTreeLastWins` (issue #3106); `local-start-api.ts`'s merge
      // is the same call.
      copyLayerTreeLastWins(layer.assetPath, tmpDir);
    }
  } catch (error) {
    // A merge that throws mid-loop has nobody to hand the tmpdir to — the
    // caller never sees it, so it would sit in the OS tmp root forever.
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
  return {
    mount: { hostPath: tmpDir, containerPath: '/opt', readOnly: true },
    tmpDir,
  };
}

/**
 * Look up the docker image asset that backs a container Lambda. Returns
 * `undefined` when the asset manifest does not contain a matching entry
 * (and the single-asset fallback in `getDockerImageBySourceHash` did not
 * apply either) — the caller falls back to the ECR-pull path.
 */
export async function resolveLocalBuildPlan(lambda: ResolvedImageLambda): Promise<
  | {
      asset: { source: import('../../../types/assets.js').DockerImageAssetSource };
      cdkOutDir: string;
      assetOutdir: string;
    }
  | undefined
> {
  const manifestPath = lambda.stack.assetManifestPath;
  if (!manifestPath) return undefined;
  // BASE from the manifest, BOUND from the app outdir -- the pair every other
  // asset path in this command is judged against (go-to-k/cdkd#3489).
  const { manifestDir: cdkOutDir, assetOutdir } = assetPathDirs(lambda.stack);

  const loader = new AssetManifestLoader();
  const manifest = await loader.loadStackManifest(lambda.stack, cdkOutDir);
  if (!manifest) return undefined;

  const entry = getDockerImageBySourceHash(manifest, lambda.imageUri);
  if (!entry) return undefined;
  return { asset: entry.asset, cdkOutDir, assetOutdir };
}
