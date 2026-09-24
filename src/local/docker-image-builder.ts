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
 * The build context is CONTAINED by the engine, against the REQUIRED
 * `assetOutdir` bound this shim forwards (issues
 * [#3503](https://github.com/go-to-k/cdkd/issues/3503),
 * [#3597](https://github.com/go-to-k/cdkd/issues/3597)): without one the
 * engine narrows to the manifest directory and refuses a `cdk.Stage` image's
 * `../asset.<hash>`. The engine refuses an escaping `source.directory` before
 * it spawns anything, and renders the value display-safe since cdk-local
 * 0.149.4, so cdkd carries no copy of the check (go-to-k/cdkd#3652).
 * See cdk-local's `src/local/docker-image-builder.ts`.
 */
import {
  architectureToPlatform,
  buildContainerImage as buildContainerImageImpl,
  LocalInvokeBuildError as CdkLocalLocalInvokeBuildError,
  type BuildContainerImageOptions,
} from 'cdk-local/internal';
import { LocalInvokeBuildError } from '../utils/error-handler.js';

export { architectureToPlatform };
export type { BuildContainerImageOptions };

/**
 * The shim's options: cdk-local's, with the containment bound made REQUIRED.
 *
 * `assetOutdir` is optional in cdk-local, where ABSENT narrows the bound to the
 * manifest directory. REQUIRED here so that a new caller cannot reach the
 * engine's check without naming one (issues
 * [#3503](https://github.com/go-to-k/cdkd/issues/3503),
 * [#3597](https://github.com/go-to-k/cdkd/issues/3597)). It is the app's
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
  // A manifest-chosen `source.executable` is announced by the ENGINE, once per
  // command line and only after its own containment check passes
  // (go-to-k/cdkd#3497 moved upstream in cdk-local 0.149.3). A second warning
  // here would print the same paragraph twice.
  try {
    // `options` WITH the bound: the engine's own check needs the app outdir,
    // or it refuses a Stage's `../asset.<hash>` (go-to-k/cdkd#3597).
    return await buildContainerImageImpl(asset, cdkOutDir, options);
  } catch (e) {
    if (e instanceof CdkLocalLocalInvokeBuildError) {
      throw new LocalInvokeBuildError(e.message);
    }
    throw e;
  }
}
