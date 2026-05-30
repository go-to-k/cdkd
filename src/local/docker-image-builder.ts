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
import { LocalInvokeBuildError } from '../utils/error-handler.js';

export { architectureToPlatform };
export type { BuildContainerImageOptions };

export async function buildContainerImage(
  ...args: Parameters<typeof buildContainerImageImpl>
): Promise<string> {
  try {
    return await buildContainerImageImpl(...args);
  } catch (e) {
    if (e instanceof CdkLocalLocalInvokeBuildError) {
      throw new LocalInvokeBuildError(e.message);
    }
    throw e;
  }
}
