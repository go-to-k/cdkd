/**
 * Shim: re-exports cdk-local's `pickRefLogicalId` (`{ Ref: <id> }` ->
 * the referenced logical id, else `null`). The implementation lives in
 * cdk-local and cdkd consumes it verbatim instead of carrying a
 * byte-identical copy. See cdk-local's `src/local/intrinsic-utils.ts`.
 */
export { pickRefLogicalId } from 'cdk-local';
