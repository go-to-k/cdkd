/**
 * The resource the generated-name guard licensed a create to take back
 * (go-to-k/cdkd#6655).
 *
 * `GeneratedNameGuard` (go-to-k/cdkd#4705) answers `licensed` for a holder of a
 * create's cdkd-GENERATED name that this stack's own evidence names (its
 * create-token ledger after a crash, what it kept under this prefix). For the
 * types whose create API hands an existing resource back, the create itself
 * then takes it. A create that REFUSES an existing name (a CloudWatch Logs log
 * group, which no longer adopts on `ResourceAlreadyExistsException`) reads the
 * licensed holder here instead, and takes back that resource and no other.
 *
 * An async-local scope rather than a `CreateContext` field, as
 * `prior-attempt-scope.ts` records for its own one-reader case: one provider
 * reads it, on its create path only. Outside a scope (a rollback re-create, an
 * import, unit tests) nothing is licensed.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ holder: string | undefined }>();

/**
 * Run `fn` with `holder` licensed (or, with `undefined`, nothing licensed --
 * which shadows an outer scope, so a nested-stack child's create never reads
 * its parent's license).
 */
export function withLicensedNameHolder<T>(holder: string | undefined, fn: () => T): T {
  return storage.run({ holder }, fn);
}

/** The physical id the current create may take back, or `undefined`. */
export function licensedNameHolder(): string | undefined {
  return storage.getStore()?.holder;
}
