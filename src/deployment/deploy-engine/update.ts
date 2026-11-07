/**
 * The `UPDATE` arm of `provisionResourceBody`. Entry module: the code lives in
 * `deploy-engine/update/` (go-to-k/cdkd#5835), and every symbol this file
 * exported is re-exported here, so no importer changes.
 */
export { provisionUpdate } from './update/provision-update.js';
export { unwrittenCreateOnlyRefusal } from './update/refusal-text.js';
