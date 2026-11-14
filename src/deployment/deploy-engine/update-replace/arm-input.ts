import type { NoEchoDeleteValues } from '../../noecho-delete-reresolution.js';
import type { ProviderRoutingDecision } from '../../../provisioning/provider-registry.js';
import type { ResourceProvider } from '../../../types/resource.js';
import type { ResourceState } from '../../../types/state.js';
import type { RecordedSecretValues } from '../../secret-redaction.js';

/**
 * What `updateByReplacement` (`update-replace.ts`) hands each of its
 * replacement arms (go-to-k/cdkd#5835): its parameters and the routing it
 * bound before choosing an arm.
 */
export interface ReplacementArmInput {
  currentResource: ResourceState;
  equalIdIsSameResource: boolean;
  logicalId: string;
  noEchoDeleteValues: NoEchoDeleteValues | undefined;
  oldDeleteProvider: ResourceProvider;
  oldDeleteRoute: ProviderRoutingDecision;
  oldResourceType: string;
  replaceDecision: ProviderRoutingDecision;
  replaceProps: Record<string, unknown>;
  replaceProvider: ResourceProvider;
  resolvedProps: Record<string, unknown>;
  resourceType: string;
  stackName: string;
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | undefined;
  updateSecrets: RecordedSecretValues;
  /** go-to-k/cdkd#6309: a custom resource's `Fn::GetAtt` positions, for its Create. */
  typedPayloadLeaves?: (string | number)[][] | undefined;
}
