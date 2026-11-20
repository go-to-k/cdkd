/**
 * The physical id a cdkd before go-to-k/cdkd#6694 recorded for an
 * `AWS::CloudFormation::WaitConditionHandle`: an opaque placeholder with no
 * signal URL behind it. A LEAF, so the diff calculator can recognise one
 * without loading the S3 signal store.
 */
export const LEGACY_HANDLE_ID_PREFIX = 'cdkd-wait-condition-handle-';

export function isLegacyHandleId(physicalId: unknown): boolean {
  return typeof physicalId === 'string' && physicalId.startsWith(LEGACY_HANDLE_ID_PREFIX);
}
