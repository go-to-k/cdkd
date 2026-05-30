/**
 * Shim: re-exports cdk-local's `start-api --watch` source-tree file watcher
 * (chokidar-backed, debounced). The implementation lives in cdk-local and cdkd
 * consumes it verbatim instead of carrying a copy. cdkd's `local-start-api.ts`
 * adopts cdk-local's watch-SOURCE model (watch the CDK app source tree + re-synth
 * on edit, excluding `cdk.out`) via this watcher plus cdk-local's
 * `createWatchPredicates` / `resolveWatchConfig` (imported directly from
 * `cdk-local`). See cdk-local's `src/local/file-watcher.ts`.
 */
export { createFileWatcher, type FileWatcher, type FileWatcherOptions } from 'cdk-local/internal';
