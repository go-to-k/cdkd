/**
 * Shim: re-exports cdk-local's S3 bundle downloader for
 * `cdkd local invoke-agentcore` — downloads + unpacks an AgentCore Runtime's
 * `CodeConfiguration.S3` bundle to a local tmpdir for source-build pickup.
 * The implementation lives in cdk-local and cdkd consumes it verbatim instead
 * of carrying a byte-identical copy. See cdk-local's
 * `src/local/agentcore-s3-bundle.ts`.
 */
export {
  downloadAndExtractS3Bundle,
  type S3BundleLocation,
  type S3BundleCredentials,
  type DownloadS3BundleOptions,
  type ExtractedS3Bundle,
} from 'cdk-local/internal';
