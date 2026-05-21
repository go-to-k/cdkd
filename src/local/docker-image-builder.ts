import { createHash } from 'node:crypto';
import { buildDockerImage } from '../assets/docker-build.js';
import type { DockerImageAssetSource } from '../types/assets.js';
import { runDockerStreaming } from '../utils/docker-cmd.js';
import { LocalInvokeBuildError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import { isImageInLocalCache } from './ecr-puller.js';

/**
 * Local-build path for `cdkd local invoke` against container Lambdas
 * (PR 5). Wraps `buildDockerImage` (in `src/assets/docker-build.ts`) with
 * a stable local tag derived from the asset source directory + Dockerfile
 * + build-args fingerprint, so successive `cdkd local invoke` runs hit
 * Docker's layer cache instead of re-building from scratch.
 *
 * Failures are wrapped in `LocalInvokeBuildError` (mirrors the publisher's
 * `AssetError` shape) so the global error handler surfaces a class
 * specific to local-invoke instead of the more general "asset" class.
 */

export interface BuildContainerImageOptions {
  /** Architecture from `Architectures: [x86_64|arm64]` (D5.6). Drives `--platform`. */
  architecture: 'x86_64' | 'arm64';
  /**
   * When true, skip `docker build` and require the previously-built image
   * tag to already be in the local docker registry. Surfaces a clear
   * "image not in local registry and --no-build is set" error when the
   * tag is missing so the user knows to drop `--no-build` or run
   * `docker build` manually first. Off by default; opt-in via the CLI's
   * `cdkd local invoke --no-build` flag (closes #233).
   *
   * The local tag is deterministic — derived from the asset source
   * directory + Dockerfile + build-target + build-args fingerprint via
   * `computeLocalTag` — so a previous successful build under the same
   * inputs produces a tag that's still valid on subsequent
   * `--no-build` runs.
   */
  noBuild?: boolean;
}

/**
 * Build a Lambda container image from a CDK asset entry. Returns the
 * local image tag the caller should pass to `docker run`.
 *
 * When `options.noBuild` is set, skips `docker build` entirely and
 * verifies the deterministic local tag is already in the docker
 * registry; throws `LocalInvokeBuildError` with an actionable message
 * when the tag is missing.
 */
export async function buildContainerImage(
  asset: { source: DockerImageAssetSource },
  cdkOutDir: string,
  options: BuildContainerImageOptions
): Promise<string> {
  const tag = computeLocalTag(asset.source);
  const platform = architectureToPlatform(options.architecture);
  const logger = getLogger().child('local-invoke-build');

  if (options.noBuild === true) {
    logger.info(`Skipping docker build (--no-build). Verifying ${tag} is in local registry...`);
    if (!(await isImageInLocalCache(tag))) {
      throw new LocalInvokeBuildError(
        `image '${tag}' not in local registry and --no-build is set; ` +
          'remove --no-build or run `docker build` manually first.'
      );
    }
    logger.debug(`Local tag ${tag} is cached; skipping build.`);
    return tag;
  }

  logger.info(`Building container image (platform=${platform})...`);
  logger.debug(`Local tag: ${tag}`);

  // For `executable` source mode the user's script returns its own tag;
  // re-tag to our deterministic `cdkd-local-invoke-<hash>` so the
  // `--no-build` cache-lookup branch finds the image on subsequent runs.
  const actualTag = await buildDockerImage(asset, cdkOutDir, {
    tag,
    platform,
    wrapError: (stderr) =>
      new LocalInvokeBuildError(
        `docker build failed for container Lambda asset (${asset.source.directory ?? asset.source.executable?.join(' ')}): ${stderr}`
      ),
  });
  if (actualTag !== tag) {
    logger.debug(`Re-tagging executable-built image ${actualTag} → ${tag}`);
    try {
      await runDockerStreaming(['tag', actualTag, tag]);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new LocalInvokeBuildError(
        `docker tag failed: ${e.stderr?.trim() || e.message || String(err)}`
      );
    }
  }

  return tag;
}

/**
 * Translate Lambda's `Architectures` enum to a Docker `--platform` value.
 *
 * Critical bug fix C2 from the design doc — without this the build /
 * run step uses the host's default arch, which races on M1/M2 Macs
 * (arm64 host) with x86_64 Lambdas. Threaded into BOTH the build (here)
 * and the run path (`docker-runner.runDetached`).
 */
export function architectureToPlatform(architecture: 'x86_64' | 'arm64'): string {
  return architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64';
}

/**
 * Build a stable local tag derived from the asset's build context.
 *
 * Fingerprints every field that affects the produced image so an iteration
 * that doesn't change those fields hits Docker's layer cache; an iteration
 * that DOES change them gets a fresh tag (the old tag stays around in
 * `docker images` but harmlessly). The fingerprint covers the full CDK
 * `DockerImageSource` schema so `dockerBuildSecrets` / `dockerBuildContexts`
 * / `cacheFrom` / etc. changes also bust the local cache as expected.
 */
function computeLocalTag(source: DockerImageAssetSource): string {
  const hash = createHash('sha256');
  // Field-tagged fingerprint: prepend each field's name so adding new fields
  // later doesn't shift the digest for old shapes.
  pushField(hash, 'directory', source.directory ?? '');
  pushField(hash, 'executable', (source.executable ?? []).join(' '));
  pushField(hash, 'dockerFile', source.dockerFile ?? '');
  pushField(hash, 'dockerBuildTarget', source.dockerBuildTarget ?? '');
  pushField(hash, 'networkMode', source.networkMode ?? '');
  pushField(hash, 'platform', source.platform ?? '');
  pushField(hash, 'dockerBuildSsh', source.dockerBuildSsh ?? '');
  pushField(hash, 'cacheDisabled', source.cacheDisabled ? '1' : '0');
  pushMap(hash, 'dockerBuildArgs', source.dockerBuildArgs);
  pushMap(hash, 'dockerBuildContexts', source.dockerBuildContexts);
  pushMap(hash, 'dockerBuildSecrets', source.dockerBuildSecrets);
  pushField(hash, 'dockerOutputs', (source.dockerOutputs ?? []).join('\x1f'));
  pushField(hash, 'cacheFrom', (source.cacheFrom ?? []).map((o) => JSON.stringify(o)).join('\x1f'));
  pushField(hash, 'cacheTo', source.cacheTo ? JSON.stringify(source.cacheTo) : '');
  return `cdkd-local-invoke-${hash.digest('hex').slice(0, 16)}`;
}

function pushField(hash: ReturnType<typeof createHash>, name: string, value: string): void {
  hash.update(name);
  hash.update('=');
  hash.update(value);
  hash.update('\0');
}

function pushMap(
  hash: ReturnType<typeof createHash>,
  name: string,
  value: Record<string, string> | undefined
): void {
  hash.update(name);
  hash.update('={');
  if (value) {
    for (const [k, v] of Object.entries(value)) {
      hash.update(k);
      hash.update('=');
      hash.update(v);
      hash.update(';');
    }
  }
  hash.update('}\0');
}
