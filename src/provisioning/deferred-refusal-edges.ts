import { awaitDeferredResource } from './deferred-readiness.js';

/**
 * go-to-k/cdkd#6940 rule 3, measured per type (go-to-k/cdkd#6962): a create
 * or update AWS REFUSES while a resource it names is still not ready. Under
 * `--no-wait` such a call first waits for that resource's skipped readiness
 * (`awaitDeferredResource`), the one wait the deploy cannot do without.
 *
 * Measured (us-east-1, 2026-11-25):
 * - `AWS::BedrockAgentCore::RuntimeEndpoint` on a `CREATING` runtime:
 *   `ConflictException: Agent version 1 must be in READY status. Current
 *   status: CREATING.` Listed.
 * - `AWS::RDS::DBProxyTargetGroup` on a `creating` DB instance or Aurora
 *   cluster: accepted (`TargetHealth` `REGISTERING`). Not listed.
 *
 * Each entry names the property holding the target's id, as the target's
 * provider reported it to `deferReadiness` (an ARN's last `/` segment is
 * tried too).
 */
const REFUSAL_EDGES: Readonly<
  Record<string, { readonly property: string; readonly what: string }>
> = {
  'AWS::BedrockAgentCore::RuntimeEndpoint': {
    property: 'AgentRuntimeId',
    what: 'AWS refuses a runtime endpoint until its runtime version is READY',
  },
};

/**
 * Wait, under `--no-wait`, for the deferred readiness of the resource
 * `resourceType`'s refusal edge names in `properties`. Nothing to do in another
 * mode, for another type, or when that resource's wait was not deferred.
 */
export async function awaitRefusalEdgeTarget(
  logicalId: string,
  resourceType: string,
  properties: Readonly<Record<string, unknown>>
): Promise<void> {
  if (process.env['CDKD_NO_WAIT'] !== 'true') return;
  const edge = REFUSAL_EDGES[resourceType];
  if (edge === undefined) return;
  const target = properties[edge.property];
  if (typeof target !== 'string' || target === '') return;
  const reason = `${logicalId} is created or updated on it, and ${edge.what}`;
  const ready =
    awaitDeferredResource(logicalId, resourceType, target, reason) ??
    (target.includes('/')
      ? awaitDeferredResource(
          logicalId,
          resourceType,
          target.slice(target.lastIndexOf('/') + 1),
          reason
        )
      : undefined);
  if (ready !== undefined) await ready;
}
