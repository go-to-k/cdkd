/**
 * Shim: re-exports cdk-local's `invoke` local container-Lambda build — builds a
 * `DockerImageCode.fromImageAsset` Lambda image locally via the shared docker
 * build helper, with a stable per-context tag so successive runs hit Docker's
 * layer cache. The implementation lives in cdk-local and cdkd consumes it
 * verbatim instead of carrying a byte-identical copy.
 *
 * NOT a bare re-export of `buildContainerImage`: cdk-local throws its OWN
 * `LocalInvokeBuildError` (extends cdk-local's `CdkLocalError`), but cdkd's
 * top-level error handler keys exit code / formatting off `instanceof CdkdError`
 * — and cdkd's `LocalInvokeBuildError` extends `CdkdError`. The bases differ, so
 * the slice-11 same-base class-identity reconciliation cannot apply. Instead this
 * wrapper translates cdk-local's thrown error back to cdkd's class at the shim
 * boundary, so a local-invoke build failure still surfaces with cdkd's exit code
 * / branding. `architectureToPlatform` is a pure helper (re-exported directly).
 *
 * It is also where the build context is CONTAINED: cdk-local joins
 * `source.directory` onto `cdkOutDir` with no check, so the shim refuses an
 * escaping value before delegating, against a REQUIRED `assetOutdir` bound
 * (issue [#3503](https://github.com/go-to-k/cdkd/issues/3503)).
 * See cdk-local's `src/local/docker-image-builder.ts`.
 */
import {
  architectureToPlatform,
  buildContainerImage as buildContainerImageImpl,
  LocalInvokeBuildError as CdkLocalLocalInvokeBuildError,
  type BuildContainerImageOptions,
} from 'cdk-local/internal';
import { assertCdkLocalDockerContextContained } from '../assets/docker-build.js';
import { warnManifestExecutable } from '../assets/manifest-passthrough-warnings.js';
import { LocalInvokeBuildError } from '../utils/error-handler.js';

export { architectureToPlatform };
export type { BuildContainerImageOptions };

/**
 * The shim's options: cdk-local's, plus the containment bound.
 *
 * `assetOutdir` is REQUIRED so that a new caller cannot reach the engine's
 * unguarded join without naming one (issue
 * [#3503](https://github.com/go-to-k/cdkd/issues/3503)). It is the app's
 * outdir, never the manifest directory: a Stage's image asset is staged one
 * level above its manifest, so `../asset.<hash>` is what CDK writes.
 */
export type ContainedBuildContainerImageOptions = BuildContainerImageOptions & {
  assetOutdir: string;
};

export async function buildContainerImage(
  asset: Parameters<typeof buildContainerImageImpl>[0],
  cdkOutDir: string,
  options: ContainedBuildContainerImageOptions
): Promise<string> {
  // `cdkd local invoke`'s container-Lambda build runs a manifest-chosen
  // `source.executable` too — cdk-local's builder spawns it, exactly as the
  // deploy path does (go-to-k/cdkd#3497). The warning belongs HERE, at the
  // shim, because the implementation is cdk-local's and cdkd consumes it
  // verbatim; without it the docs' claim would have been true only of deploy,
  // while `cdkd local invoke` executed assembly code in silence.
  const executable = asset?.source?.executable;
  if (executable && executable.length > 0) warnManifestExecutable(executable);
  const { assetOutdir, ...implOptions } = options;
  // Before anything is spawned: the engine joins `source.directory` onto
  // `cdkOutDir` raw, for the build context and for the executable's cwd alike.
  assertCdkLocalDockerContextContained({
    manifestDir: cdkOutDir,
    source: asset.source,
    assetOutdir,
    wrapError: (message) =>
      new LocalInvokeBuildError(`Refusing to build the container image: ${message}`),
  });
  try {
    return await buildContainerImageImpl(asset, cdkOutDir, implOptions);
  } catch (e) {
    if (e instanceof CdkLocalLocalInvokeBuildError) {
      throw new LocalInvokeBuildError(e.message);
    }
    throw e;
  }
}
