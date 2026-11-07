import type { KeptInHistorySources } from '../../kept-in-history.js';
import { DeploymentEventsReader } from '../../../state/deployment-events-store.js';
import type { DeployEngine } from '../../deploy-engine.js';

/** What `loadKeptInHistory` / `loadKeptForWarning` read, from the engine. */
export function keptHistorySources(engine: DeployEngine): KeptInHistorySources {
  const reader = new DeploymentEventsReader(engine.stateBackend);
  return {
    earlierStateResources: (s, r) => engine.stateBackend.earlierStateResources(s, r),
    listRuns: (s, r) => reader.listRuns(s, r),
    readRunEvents: (s, r, id) => reader.readRunEvents(s, r, id),
  };
}
