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
 * See cdk-local's `src/local/docker-image-builder.ts`.
 */
import {
  architectureToPlatform,
  buildContainerImage as buildContainerImageImpl,
  LocalInvokeBuildError as CdkLocalLocalInvokeBuildError,
  type BuildContainerImageOptions,
} from 'cdk-local/internal';
import { warnManifestExecutable } from '../assets/manifest-passthrough-warnings.js';
import { LocalInvokeBuildError } from '../utils/error-handler.js';

export { architectureToPlatform };
export type { BuildContainerImageOptions };

export async function buildContainerImage(
  ...args: Parameters<typeof buildContainerImageImpl>
): Promise<string> {
  // `cdkd local invoke`'s container-Lambda build runs a manifest-chosen
  // `source.executable` too — cdk-local's builder spawns it, exactly as the
  // deploy path does (go-to-k/cdkd#3497). The warning belongs HERE, at the
  // shim, because the implementation is cdk-local's and cdkd consumes it
  // verbatim; without it the docs' claim would have been true only of deploy,
  // while `cdkd local invoke` executed assembly code in silence.
  const executable = args[0]?.source?.executable;
  if (executable && executable.length > 0) warnManifestExecutable(executable);
  try {
    return await buildContainerImageImpl(...args);
  } catch (e) {
    if (e instanceof CdkLocalLocalInvokeBuildError) {
      throw new LocalInvokeBuildError(e.message);
    }
    throw e;
  }
}
