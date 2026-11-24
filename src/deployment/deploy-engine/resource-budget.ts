import type { DeployEngine } from '../deploy-engine.js';
import { slowCcOperationTimeoutMs } from '../../provisioning/slow-cc-operation-timeouts.js';
import { DEFAULT_RESOURCE_TIMEOUT_MS, DEFAULT_RESOURCE_WARN_AFTER_MS } from './options.js';

/**
 * The per-resource deadline for one operation on `resourceType`: the warn
 * point and the timeout, also used by the readiness wait a `--no-wait`
 * operation deferred (go-to-k/cdkd#6940).
 */
export function resourceDeadlineBudget(
  engine: Pick<DeployEngine, 'providerRegistry' | 'options'>,
  resourceType: string,
  operationKind: 'CREATE' | 'UPDATE' | 'DELETE'
): { warnAfterMs: number; timeoutMs: number } {
  const provider = engine.providerRegistry.getProvider(resourceType);
  const providerMinTimeoutMs = provider.getMinResourceTimeoutMs?.() ?? 0;
  const warnAfterMs =
    engine.options.resourceWarnAfterByType?.[resourceType] ??
    engine.options.resourceWarnAfterMs ??
    DEFAULT_RESOURCE_WARN_AFTER_MS;
  const globalTimeoutMs = engine.options.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
  // Known-slow types (OpenSearch domains, RDS / Redshift / ElastiCache
  // clusters) lift the outer deadline to match the CC inner poll cap so a
  // slow CREATE / UPDATE is not aborted by the 30-min default. A per-type CLI
  // override still wins (explicit escape hatch).
  const slowTypeMinTimeoutMs = slowCcOperationTimeoutMs(resourceType, operationKind);
  const timeoutMs =
    engine.options.resourceTimeoutByType?.[resourceType] ??
    Math.max(providerMinTimeoutMs, slowTypeMinTimeoutMs, globalTimeoutMs);
  return { warnAfterMs, timeoutMs };
}
