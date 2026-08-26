import { AsyncLocalStorage } from 'node:async_hooks';
import type { RecordedSecretValues } from './secret-redaction.js';

/**
 * The secrets THIS process substituted into the property bag of the resource
 * currently being provisioned, scoped to that provider call's async chain
 * (issue [#1903](https://github.com/go-to-k/cdkd/issues/1903)).
 *
 * WHY AN ASYNC-LOCAL STORE RATHER THAN A FIELD ON `CreateContext`. Exactly ONE
 * provider needs the pairs — `NestedStackProvider`, which must SEED them into
 * the child `DeployEngine` it builds (see
 * `DeployEngineOptions.inheritedSecrets`) — and a `RecordedSecretValues` is
 * keyed by PLAINTEXT. `.claude/rules/providers.md` already records the rule
 * this follows: the reason `SecretMaskingContext` carries a masking FUNCTION
 * and not the bag is that putting the bag on the shared context makes every one
 * of the ~130 registered providers a place a `[...secrets.keys()]` can leak
 * from. A function cannot substitute here — seeding needs the pairs, not the
 * ability to mask — so the bag is handed through a channel only this one
 * provider reads, instead of widening the type every provider sees.
 *
 * It is also the idiom this particular provider already lives in:
 * `NestedStackProvider` reads its whole world out of
 * `getCurrentNestedStackContext()`, another `AsyncLocalStorage`.
 *
 * WHY ITS OWN LEAF MODULE rather than living in `deploy-engine.ts`, where it
 * started. Both BINDERS need it — the deploy engine and
 * `rollback-executor.ts`, whose replay arms re-resolve the journal's
 * `{{resolve:...}}` back to plaintext and drive the very same providers (issue
 * [#2086](https://github.com/go-to-k/cdkd/issues/2086)) — and
 * `deploy-engine.ts` already imports `rollback-executor.ts`, so keeping the
 * store there would have made the two modules a cycle. A leaf that imports one
 * TYPE cannot participate in one.
 *
 * SCOPE. {@link withCurrentResourceSecrets} wraps the provider CREATE / UPDATE
 * call itself, so the store is bound per resource and per retry attempt, and
 * two resources provisioned concurrently under `--concurrency` cannot see each
 * other's bag. Absent (every caller that binds nothing — `cdkd drift --revert`,
 * the import path, tests) reads as `undefined`, which the provider treats as
 * "no secrets to inherit" — the pre-#1903 behaviour.
 */
const currentResourceSecretsStore = new AsyncLocalStorage<RecordedSecretValues>();

/**
 * Run `fn` with `secrets` visible to {@link getCurrentResourceSecrets}. Used by
 * the deploy engine and the rollback executor around a provider CREATE / UPDATE
 * call; see the store's own doc for why the bag travels this way rather than on
 * `CreateContext`.
 */
export function withCurrentResourceSecrets<T>(secrets: RecordedSecretValues, fn: () => T): T {
  return currentResourceSecretsStore.run(secrets, fn);
}

/**
 * The bag {@link withCurrentResourceSecrets} bound for the provider call
 * currently in flight, or `undefined` when no binder is on the stack.
 *
 * Read by `NestedStackProvider` alone. A provider reading this MUST NOT
 * enumerate or log its KEYS — they are secret plaintext; the only sanctioned
 * use is handing the map on as a redaction seed.
 */
export function getCurrentResourceSecrets(): RecordedSecretValues | undefined {
  return currentResourceSecretsStore.getStore();
}
