/**
 * The deploy's Outputs pass. Entry module: the code lives in
 * `deploy-engine/outputs/` (go-to-k/cdkd#5835), and every symbol this file
 * exported is re-exported here, so no importer changes.
 */
export { OutputsRunState, type OutputsDeps } from './outputs/run-state.js';
export { EXPORT_NAME_SCOPE, handleOutputResolutionFailure } from './outputs/failure.js';
export { buildDisplayOutputs, resolveOutputs } from './outputs/resolve.js';
