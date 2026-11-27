/**
 * An `AWS::EKS::Cluster` update that turns `KubernetesNetworkConfig.
 * ElasticLoadBalancing.Enabled` on or off without Auto Mode's other two
 * settings (go-to-k/cdkd#7099). Measured in us-east-1 on 2026-11-27, on a
 * cluster with `AccessConfig.AuthenticationMode: API_AND_CONFIG_MAP`:
 *
 *  - Cloud Control answered the lone toggle SUCCESS and the cluster kept
 *    `elasticLoadBalancing.enabled: false`;
 *  - CloudFormation did the same: the stack update ended UPDATE_COMPLETE on
 *    the same cluster, which still reported `false`;
 *  - the same change sent with `ComputeConfig.Enabled` and
 *    `StorageConfig.BlockStorage.Enabled` applied.
 *
 * No route applies the lone toggle, so cdkd refuses it before any call and
 * names the two settings to change with it. Without this, the update reaches
 * Cloud Control and the `[cc-silent-noop]` check fails it afterwards, after
 * the rest of the patch has applied.
 */
import { ProvisioningError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { markRefusedBeforeApplying } from '../../deployment/prior-attempt-scope.js';

export const EKS_CLUSTER_TYPE = 'AWS::EKS::Cluster';

/** `true` / `"true"` is on; anything else, absence included, is off (EKS's default). */
function enabled(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true');
}

function member(bag: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let node: unknown = bag;
  for (const key of path) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const LOAD_BALANCING = ['KubernetesNetworkConfig', 'ElasticLoadBalancing', 'Enabled'] as const;
const COMPANIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['ComputeConfig.Enabled', ['ComputeConfig', 'Enabled']],
  ['StorageConfig.BlockStorage.Enabled', ['StorageConfig', 'BlockStorage', 'Enabled']],
];

/**
 * Throw when the update changes `ElasticLoadBalancing.Enabled` to a value the
 * desired side declares, without both Auto Mode companions at that value.
 */
export function assertEksAutoModeToggleComplete(input: {
  resourceType: string;
  logicalId: string;
  physicalId: string;
  properties: Readonly<Record<string, unknown>>;
  previousProperties: Readonly<Record<string, unknown>>;
}): void {
  if (input.resourceType !== EKS_CLUSTER_TYPE) return;
  // A removal of the member is not judged: what AWS keeps then is not measured.
  const declared = member(input.properties, LOAD_BALANCING);
  if (declared === undefined || declared === null) return;
  const want = enabled(declared);
  if (want === enabled(member(input.previousProperties, LOAD_BALANCING))) return;
  const missing = COMPANIONS.filter(
    ([, path]) => enabled(member(input.properties, path)) !== want
  ).map(([name]) => name);
  if (missing.length === 0) return;
  const value = String(want);
  throw markRefusedBeforeApplying(
    markNonRetryable(
      new ProvisioningError(
        `Cannot update ${input.logicalId} (${EKS_CLUSTER_TYPE}): KubernetesNetworkConfig.ElasticLoadBalancing.Enabled changes to ${value}, but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not ${value}. EKS Auto Mode takes the three settings together: set ComputeConfig.Enabled, StorageConfig.BlockStorage.Enabled and KubernetesNetworkConfig.ElasticLoadBalancing.Enabled to ${value} in the same deploy. Sent alone, the change is reported as applied and is not, through Cloud Control and CloudFormation alike (go-to-k/cdkd#7099).`,
        EKS_CLUSTER_TYPE,
        input.logicalId,
        input.physicalId
      )
    )
  );
}
