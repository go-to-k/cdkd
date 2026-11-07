import type { ResourceProvider } from '../../../types/resource.js';
import type { ProviderRoutingDecision } from '../../../provisioning/provider-registry.js';
import type { deleteFirstBlocker } from '../plan.js';
import type { replayPrefixScope } from '../names.js';
import type { RollbackDeleteGuardScope } from '../messages.js';
import type { ReplayOpScope } from '../replay-scope.js';
import type { MarkedRecreateScope } from './failures.js';

/**
 * What `replayReverseReplacement` resolves before the re-create, handed to
 * its two later phases (`recreateOldResource` and
 * `finishReverseReplacement`). Each field is the binding of the same name in
 * that function; see it there for why each one exists.
 */
export interface ReverseReplacementScope {
  /** The record of the NEW resource: `stateResources[op.logicalId]`. */
  current: NonNullable<ReplayOpScope['stateResources'][string]>;
  /** The journaled OLD record: `op.previousState`. */
  prev: NonNullable<ReplayOpScope['op']['previousState']>;
  /** The OLD resource's type (issue #2668). */
  oldType: string;
  typeChanged: boolean;
  resolvedPrevProps: Record<string, unknown>;
  deleteFirstBlocked: ReturnType<typeof deleteFirstBlocker>;
  reverseDeleteFirst: boolean;
  createProvider: ResourceProvider;
  createProvisionedBy: ProviderRoutingDecision['provisionedBy'];
  replayCreateProps: () => Record<string, unknown>;
  inOriginalPrefix: ReturnType<typeof replayPrefixScope>;
  resolveNewDeleteRoute: () => {
    provider: ResourceProvider;
    provisionedBy: 'sdk' | 'cc-api' | undefined;
  };
  newDeleteGuardScope: (provisionedBy: 'sdk' | 'cc-api' | undefined) => RollbackDeleteGuardScope;
  newCopyClaimed: ReturnType<ReplayOpScope['inlinePolicyWriters']['claimedFor']>;
  recreateCleanup: MarkedRecreateScope;
}
