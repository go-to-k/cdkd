import type { DeployEngine } from '../../deploy-engine.js';

/** The record `getState` loaded at the start of a deploy (`null` for a first deploy). */
export type LoadedStateData = Awaited<ReturnType<DeployEngine['stateBackend']['getState']>>;
