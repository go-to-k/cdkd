/**
 * Shim: re-exports cdk-local's per-API Stage selection for
 * `cdkd local start-api` — builds the stage map and attaches stage context
 * (populating `event.stageVariables`) to discovered routes. The
 * implementation lives in cdk-local and cdkd consumes it verbatim instead of
 * carrying a byte-identical copy. See cdk-local's `src/local/stage-resolver.ts`.
 */
export { attachStageContext, buildStageMap, type ResolvedStage } from 'cdk-local';
