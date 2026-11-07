/**
 * Replacement of a resource on deploy (create-first or delete-first), the
 * final-snapshot gate before a delete, and the deferred replaced-delete retry
 * pass. Entry module: the code lives in `deploy-engine/replacement/`
 * (go-to-k/cdkd#5835), and every symbol this file exported is re-exported
 * here, so no importer changes.
 */
export { ReplacementRunState } from './replacement/run-state.js';
export type { ReplacementDeps } from './replacement/run-state.js';
export {
  replacementDeleteContext,
  prepareFinalSnapshotForDelete,
} from './replacement/delete-context.js';
export { replaceDeleteFirstAndRecreate } from './replacement/delete-first.js';
export { typeChangeNameQuestion, checkedReplacementNameChange } from './replacement/name-change.js';
export { createFirstThenDeleteOld } from './replacement/create-first.js';
export { deleteReplacedAfterCreate } from './replacement/delete-replaced.js';
export {
  retryDeferredReplacedDeletes,
  warnUnretriedReplacedDeletes,
} from './replacement/deferred-deletes.js';
export type { DeferredReplacedDelete } from './replacement/deferred-deletes.js';
