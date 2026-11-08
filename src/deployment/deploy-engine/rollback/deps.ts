/**
 * The engine members the rollback modules read (`RollbackDeps`).
 * Split out of `deploy-engine/rollback.ts` (go-to-k/cdkd#5835), which
 * re-exports what it exported.
 */
import type { DeployEngine } from '../../deploy-engine.js';
import type { NoEchoDeps } from '../noecho.js';

/**
 * The engine members this module's functions read, built per call by
 * `DeployEngine.rollbackDeps()`. Constructor-only members are passed by value;
 * per-deploy state `deploy()` replaces (`secretsRun`, `noEchoRun`,
 * `outputsRun`, `recordedImports`, `recordedOutputReads`, `resumedCreates`)
 * or the deploy flow sets mid-deploy (`absentJournalVersionPurge`,
 * `interrupted`) is read through live getters, and the engine methods stay
 * bound to THIS engine.
 */
export interface RollbackDeps {
  /** The engine's identity, the key of `adoptedOrphanRecords` only — never read. */
  owner: object;
  logger: DeployEngine['logger'];
  options: DeployEngine['options'];
  stackRegion: DeployEngine['stackRegion'];
  stateBackend: DeployEngine['stateBackend'];
  lockManager: DeployEngine['lockManager'];
  providerRegistry: DeployEngine['providerRegistry'];
  secretsRun: () => DeployEngine['secretsRun'];
  noEchoRun: () => DeployEngine['noEchoRun'];
  outputsRun: () => DeployEngine['outputsRun'];
  recordedImports: () => DeployEngine['recordedImports'];
  recordedOutputReads: () => DeployEngine['recordedOutputReads'];
  resumedCreates: () => DeployEngine['resumedCreates'];
  /** Replaces the engine's `resumedCreates` with an empty map (never cleared in place). */
  resetResumedCreates: () => void;
  absentJournalVersionPurge: () => DeployEngine['absentJournalVersionPurge'];
  interrupted: () => DeployEngine['interrupted'];
  userInterrupted: () => DeployEngine['userInterrupted'];
  noEchoDeps: () => NoEchoDeps;
  recordEvent: DeployEngine['recordEvent'];
  crossStackReadKeyNormalizer: DeployEngine['crossStackReadKeyNormalizer'];
}
