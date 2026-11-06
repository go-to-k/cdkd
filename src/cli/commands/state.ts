import { Command } from 'commander';
import { createStateMigrateCommand } from './state-migrate.js';
import { createStateListCommand } from './state/list.js';
import { createStateResourcesCommand } from './state/resources.js';
import { createStateShowCommand } from './state/show.js';
import { createStateOrphanCommand } from './state/orphan.js';
import { createStateDestroyCommand } from './state/destroy.js';
import { createStateInfoCommand } from './state/info.js';
import { createStateRefreshObservedCommand } from './state/refresh-observed.js';
import { createStateBrowseCommand } from './state/browse.js';

export { stateDestroyTargets, resolveSingleRegion } from './state/refs.js';
export { setupStateBackend } from './state/setup.js';
export type { StateSetup } from './state/setup.js';
export { printStackResources } from './state/resources.js';
export { printStackShow } from './state/show.js';
export { confirmStateOrphanRemoval } from './state/orphan.js';
export { confirmRefresh } from './state/refresh-observed.js';
export { stateBrowseDeps } from './state/browse.js';

/**
 * Create the `state` parent command.
 *
 * Subcommands:
 * - `state info` — show bucket name, region, source, schema version, stack count
 * - `state list` (alias `ls`) — list stacks in the state bucket
 * - `state resources <stack>` — list resources of one stack
 * - `state show <stack>` — full state record (metadata, outputs, resources)
 * - `state orphan <stack>...` — remove cdkd's state record (NOT AWS resources)
 * - `state destroy <stack>...` — delete AWS resources AND state record
 *   without requiring the CDK app (CDK-app-free version of `cdkd destroy`)
 * - `state migrate` — copy all state from the legacy region-suffixed
 *   default bucket to the region-free default; optionally delete the source
 * - `state refresh-observed <stack>...` — refresh observedProperties on every
 *   resource without redeploying (closes the gap for state written before v3)
 */
export function createStateCommand(): Command {
  const cmd = new Command('state').description('Manage cdkd state stored in S3');
  cmd.addCommand(createStateInfoCommand());
  cmd.addCommand(createStateBrowseCommand());
  cmd.addCommand(createStateListCommand());
  cmd.addCommand(createStateResourcesCommand());
  cmd.addCommand(createStateShowCommand());
  cmd.addCommand(createStateOrphanCommand());
  cmd.addCommand(createStateDestroyCommand());
  cmd.addCommand(createStateMigrateCommand());
  cmd.addCommand(createStateRefreshObservedCommand());
  return cmd;
}
