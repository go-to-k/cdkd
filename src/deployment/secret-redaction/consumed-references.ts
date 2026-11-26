import { AsyncLocalStorage } from 'node:async_hooks';
import type { RecordedSecretValues } from './pairs.js';

/**
 * Which `{{resolve:...}}` references each template OBJECT's resolution
 * CONSUMED, per pass bag (go-to-k/cdkd#7050): the generic taint the persist
 * walk masks by.
 *
 * Written by the resolver at its two central seams, so no construct can opt
 * out. `resolveValue` runs each intrinsic object it dispatches inside
 * {@link withConsumptionScope}, and every replacement of a reference
 * (`log-twin-pass.ts`, all three replacement sites) adds its token to every
 * object on the async call path at that moment, so a construct added later,
 * or one no arm reads (`Fn::Select`, `Fn::Split`, `Fn::Base64`, `Fn::If`, a
 * nested `Fn::Join`), is stamped like the rest. The path is the async
 * context's, so a concurrent sibling's replacement never stamps it.
 *
 * Holds tokens only, never a value. The table is weak in both keys.
 */
const stamps = new WeakMap<RecordedSecretValues, WeakMap<object, Set<string>>>();
const path = new AsyncLocalStorage<ReadonlyArray<object>>();

/** Run `fn` with `node` on the consumption path. */
export function withConsumptionScope<T>(node: object, fn: () => Promise<T>): Promise<T> {
  return path.run([...(path.getStore() ?? []), node], fn);
}

/** Note that the pass owning `secrets` replaced `token` for every object on the path. */
export function noteReferenceConsumed(secrets: RecordedSecretValues, token: string): void {
  const nodes = path.getStore();
  if (nodes === undefined || nodes.length === 0) return;
  let table = stamps.get(secrets);
  if (table === undefined) {
    table = new WeakMap();
    stamps.set(secrets, table);
  }
  for (const node of nodes) {
    let set = table.get(node);
    if (set === undefined) {
      set = new Set();
      table.set(node, set);
    }
    set.add(token);
  }
}

/** The tokens the pass owning `secrets` replaced while resolving `node`. */
export function referencesConsumedBy(
  secrets: RecordedSecretValues,
  node: object
): ReadonlySet<string> {
  return stamps.get(secrets)?.get(node) ?? new Set();
}
