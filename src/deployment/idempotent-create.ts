import type { ResourceProvider } from '../types/resource.js';

/**
 * go-to-k/cdkd#7141: whether a create of `resourceType` through `provider` may
 * replay an ambiguous socket error (`WithRetryOptions.replayAmbiguousSocketError`):
 * only a type the provider declared in `idempotentCreateTypes`. A caller that
 * is not wrapping a create passes no type, and gets `false`.
 */
export function replaysAmbiguousCreate(
  provider: Pick<ResourceProvider, 'idempotentCreateTypes'> | undefined,
  resourceType: string | undefined
): boolean {
  return resourceType !== undefined && provider?.idempotentCreateTypes?.has(resourceType) === true;
}
