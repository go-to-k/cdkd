/** Marker schema version, bumped if the marker shape ever changes. */
export const ASSET_SUPPORT_VERSION = 1;

/**
 * S3 key prefix for bootstrap markers in the state bucket. Deliberately
 * outside the `cdkd/` state prefix so `state list` key-listing never mistakes
 * a marker for a stack, and concurrent bootstraps in two regions cannot race
 * last-writer-wins on a shared object (design §12.1).
 */
export const BOOTSTRAP_MARKER_PREFIX = 'cdkd-bootstrap/';

/**
 * Name of the cdkd-owned asset bucket for an (account, region) pair.
 * Per-region because Lambda requires the code bucket to be in the function's
 * region — the same reason CDK's asset bucket is per-region (design §3).
 */
export function getCdkdAssetBucketName(accountId: string, region: string): string {
  return `cdkd-assets-${accountId}-${region}`;
}

/**
 * Name of the cdkd-owned container-asset ECR repository for an
 * (account, region) pair. ECR repos are account+region scoped by ARN, so the
 * suffix is not strictly needed — the CDK-parallel shape keeps the future
 * template rewrite uniform and the names self-describing (design §3).
 */
export function getCdkdContainerRepoName(accountId: string, region: string): string {
  return `cdkd-container-assets-${accountId}-${region}`;
}
