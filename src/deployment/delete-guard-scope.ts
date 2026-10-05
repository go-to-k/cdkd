import { AsyncLocalStorage } from 'node:async_hooks';
import type { IndeterminateGuard, ResourceDeleteResult } from '../types/resource.js';
import { deleteIndeterminateGuards } from './delete-outcome.js';

/**
 * One {@link IndeterminateGuard} a deploy-path delete reported, together with
 * the resource the guarded delete ran on (issue
 * [#2422](https://github.com/go-to-k/cdkd/issues/2422)).
 *
 * The target travels WITH the guard because four of the deploy engine's five
 * delete sites run inside an UPDATE, where the resource the guard ran on is the
 * OLD one: by the time the row's events are built, the state record names the
 * NEW physical id (and, after a `Type` change, the new type).
 */
export interface ReportedDeleteGuard extends IndeterminateGuard {
  /** The physical id the guarded delete was addressed to. */
  readonly physicalId: string;
  /** The type the guarded delete ran as (the RECORD's type, not the template's). */
  readonly resourceType: string;
  /** The routing layer of the record the delete ran on. */
  readonly provisionedBy?: 'sdk' | 'cc-api' | undefined;
}

const storage = new AsyncLocalStorage<ReportedDeleteGuard[]>();

/**
 * Run one resource's provisioning with `sink` collecting every indeterminate
 * guard its delete sites report.
 *
 * A SINK the caller owns, not a return value, for two reasons. The four
 * in-UPDATE delete sites sit two to four frames below `provisionResourceBody`
 * inside helpers whose return value is the replacement's CREATE result, and
 * three of them THROW right after a guarded delete returns (a `'skipped'`
 * outcome there fails the resource), so a returned value would lose exactly
 * the guard whose delete ran. The caller reads `sink` whether `fn` resolved or
 * threw. Nested scopes shadow outer ones, so a nested-stack child engine's own
 * provisioning collects into its own sink.
 */
export function collectDeleteGuards<T>(
  sink: ReportedDeleteGuard[],
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(sink, fn);
}

/**
 * Report the indeterminate guards a deploy-path delete returned to the
 * enclosing {@link collectDeleteGuards} scope. Call it right after the
 * `provider.delete(...)` resolves and BEFORE any `'skipped'` check that
 * throws. A no-op outside a scope and for a result carrying no guard.
 */
export function reportDeleteGuards(
  result: void | ResourceDeleteResult,
  target: Omit<ReportedDeleteGuard, keyof IndeterminateGuard>
): void {
  const sink = storage.getStore();
  if (!sink) return;
  for (const guard of deleteIndeterminateGuards(result)) {
    sink.push({
      guard: guard.guard,
      reason: guard.reason,
      physicalId: target.physicalId,
      resourceType: target.resourceType,
      ...(target.provisionedBy && { provisionedBy: target.provisionedBy }),
    });
  }
}
