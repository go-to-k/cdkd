import { createHash } from 'node:crypto';
import { buildDockerImage } from '../assets/docker-build.js';
import type { DockerImageAssetSource } from '../types/assets.js';
import { LocalInvokeBuildError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';

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
}

/**
 * Build a Lambda container image from a CDK asset entry. Returns the
 * local image tag the caller should pass to `docker run`.
 */
export async function buildContainerImage(
  asset: { source: DockerImageAssetSource },
  cdkOutDir: string,
  options: BuildContainerImageOptions
): Promise<string> {
  const tag = computeLocalTag(asset.source);
  const platform = architectureToPlatform(options.architecture);
  const logger = getLogger().child('local-invoke-build');

  logger.info(`Building container image (platform=${platform})...`);
  logger.debug(`Local tag: ${tag}`);

  await buildDockerImage(asset, cdkOutDir, tag, {
    platform,
    wrapError: (stderr) =>
      new LocalInvokeBuildError(
        `docker build failed for container Lambda asset (${asset.source.directory}): ${stderr}`
      ),
  });

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
 * Build a stable local tag derived from the asset's build context. We
 * fingerprint `directory + dockerFile + dockerBuildTarget + dockerBuildArgs`
 * so an iteration that doesn't change those fields hits Docker's layer
 * cache; an iteration that DOES change them gets a fresh tag (the old
 * tag stays around in `docker images` but harmlessly).
 */
function computeLocalTag(source: DockerImageAssetSource): string {
  const hash = createHash('sha256');
  hash.update(source.directory);
  hash.update('\0');
  hash.update(source.dockerFile ?? '');
  hash.update('\0');
  hash.update(source.dockerBuildTarget ?? '');
  hash.update('\0');
  if (source.dockerBuildArgs) {
    for (const [k, v] of Object.entries(source.dockerBuildArgs)) {
      hash.update(k);
      hash.update('=');
      hash.update(v);
      hash.update('\0');
    }
  }
  return `cdkd-local-invoke-${hash.digest('hex').slice(0, 16)}`;
}
