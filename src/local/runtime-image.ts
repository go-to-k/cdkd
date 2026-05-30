/**
 * Shim: re-exports cdk-local's Lambda runtime resolution for
 * `cdkd local invoke` / `cdkd local start-api` — maps a CloudFormation
 * `Runtime` string to the AWS Lambda base image, source-file extension, and
 * in-container code-mount path. The implementation lives in cdk-local and cdkd
 * consumes it verbatim instead of carrying a byte-identical copy. See
 * cdk-local's `src/local/runtime-image.ts`.
 */
export {
  resolveRuntimeCodeMountPath,
  resolveRuntimeFileExtension,
  resolveRuntimeImage,
} from 'cdk-local/internal';
