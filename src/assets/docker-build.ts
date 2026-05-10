import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DockerImageAssetSource } from '../types/assets.js';
import { getLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Shared `docker build` invocation used by both
 * `src/assets/docker-asset-publisher.ts` (publish to ECR) and
 * `src/local/docker-image-builder.ts` (run a container Lambda locally
 * via `cdkd local invoke`).
 *
 * Invariants preserved across the two callers:
 *   - `maxBuffer: 50 * 1024 * 1024` so a verbose `docker build` log doesn't
 *     blow up `execFile`'s default 1 MB buffer.
 *   - Build args iterate in the order `Object.entries(...)` returns them so
 *     the resulting layer cache is stable across runs (any reordering would
 *     bust caches for both the publisher and local invoke).
 *   - Errors carry the captured stderr so the user can re-run `docker build`
 *     directly to debug. The error class is parameterized: each consumer
 *     wraps the failure with its own typed error (`AssetError` for the
 *     publisher, `LocalInvokeBuildError` for local invoke) so the existing
 *     error-handling chain on each side keeps working unchanged.
 *
 * `platform` is new in PR 5: container Lambdas declare `Architectures:
 * [x86_64]` (default) or `[arm64]`, and the local-invoke caller MUST pass the
 * matching `linux/amd64` / `linux/arm64` so the built image can run on the
 * developer's host (which may have the opposite arch). The publisher caller
 * defaults to `undefined` for backward compatibility — passing through is
 * the no-op, the user's local docker default arch picks up.
 */

/**
 * Build a Docker image from a CDK asset's source description.
 *
 * @param asset       The `DockerImageAsset` entry from the cdk asset
 *                    manifest (carries `directory`, `dockerFile`, build args,
 *                    target, outputs).
 * @param cdkOutDir   Absolute path to the CDK output directory (`cdk.out`).
 *                    Used to resolve `asset.source.directory` to a real
 *                    build context on disk.
 * @param tag         Local image tag to apply (`-t`). The caller chooses a
 *                    deterministic tag so subsequent runs hit Docker's
 *                    layer cache (publisher uses `cdkd-asset-<hash>`;
 *                    local-invoke uses `cdkd-local-invoke-<hash>`).
 * @param platform    Optional `--platform` value (e.g. `linux/amd64`,
 *                    `linux/arm64`). When `undefined` the flag is omitted
 *                    and Docker uses its default platform.
 * @param wrapError   Function the caller provides to wrap the underlying
 *                    `docker build` failure in a typed error specific to
 *                    its call site.
 * @throws Whatever `wrapError` returns when `docker build` exits non-zero.
 */
export async function buildDockerImage(
  asset: { source: DockerImageAssetSource },
  cdkOutDir: string,
  tag: string,
  options: {
    platform?: string;
    wrapError: (stderr: string) => Error;
  }
): Promise<void> {
  const logger = getLogger().child('docker-build');
  const args: string[] = ['build', '-t', tag];

  if (options.platform) {
    args.push('--platform', options.platform);
  }

  // Dockerfile
  if (asset.source.dockerFile) {
    args.push('-f', asset.source.dockerFile);
  }

  // Build args (order preserved per Object.entries — load-bearing for cache
  // reproducibility across both callers).
  if (asset.source.dockerBuildArgs) {
    for (const [key, value] of Object.entries(asset.source.dockerBuildArgs)) {
      args.push('--build-arg', `${key}=${value}`);
    }
  }

  // Build target
  if (asset.source.dockerBuildTarget) {
    args.push('--target', asset.source.dockerBuildTarget);
  }

  // Build outputs
  if (asset.source.dockerOutputs) {
    for (const output of asset.source.dockerOutputs) {
      args.push('--output', output);
    }
  }

  // Context directory
  const contextDir = `${cdkOutDir}/${asset.source.directory}`;
  args.push(contextDir);

  logger.debug(`docker ${args.join(' ')}`);

  try {
    await execFileAsync('docker', args, {
      maxBuffer: 50 * 1024 * 1024, // 50MB for build output
    });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const stderr = err.stderr || err.message || String(error);
    throw options.wrapError(stderr);
  }
}
