import { AsyncLocalStorage } from 'node:async_hooks';
import { installLogLineMaskerSource } from '../utils/log-line-masker.js';
import { createUnionSecretMasker, hasMaskableValues } from './secret-redaction.js';
import type { RecordedSecretValues } from './secret-redaction.js';

/**
 * The secrets THIS process substituted into the property bag of the resource
 * currently being provisioned, scoped to that provider call's async chain
 * (issue [#1903](https://github.com/go-to-k/cdkd/issues/1903)).
 *
 * WHY AN ASYNC-LOCAL STORE RATHER THAN A FIELD ON `CreateContext`. Only the
 * two providers {@link getCurrentResourceSecrets} names need the pairs — the
 * first, `NestedStackProvider`, must SEED them into the child `DeployEngine` it
 * builds (see `DeployEngineOptions.inheritedSecrets`) — and a
 * `RecordedSecretValues` is keyed by PLAINTEXT. `.claude/rules/providers.md`
 * already records the rule this follows: the reason `SecretMaskingContext`
 * carries a masking FUNCTION and not the bag is that putting the bag on the
 * shared context makes every registered provider a place a
 * `[...secrets.keys()]` can leak from. A function cannot substitute here —
 * seeding needs the pairs, not the ability to mask — so the bag is handed
 * through a channel only those providers read, instead of widening the type
 * every provider sees.
 *
 * It is also the idiom `NestedStackProvider` in particular already lives in:
 * it reads its whole world out of
 * `getCurrentNestedStackContext()`, another `AsyncLocalStorage`.
 *
 * WHY ITS OWN LEAF MODULE rather than living in `deploy-engine.ts`, where it
 * started. Both BINDERS need it — the deploy engine and
 * `rollback-executor.ts`, whose replay arms re-resolve the journal's
 * `{{resolve:...}}` back to plaintext and drive the very same providers (issue
 * [#2086](https://github.com/go-to-k/cdkd/issues/2086)) — and
 * `deploy-engine.ts` already imports `rollback-executor.ts`, so keeping the
 * store there would have made the two modules a cycle. Its only imports are
 * `secret-redaction.ts` and `src/utils/log-line-masker.ts`, both import-free,
 * so it still cannot participate in one.
 *
 * SCOPE. {@link withCurrentResourceSecrets} wraps the provider CREATE / UPDATE
 * call itself, so the store is bound per resource and per retry attempt, and
 * two resources provisioned concurrently under `--concurrency` cannot see each
 * other's bag. Absent (every caller that binds nothing — `cdkd drift --revert`,
 * the import path, tests) reads as `undefined`, which each reader treats as
 * "no pairs": `NestedStackProvider` seeds nothing (the pre-#1903 behaviour)
 * and `asPersisted` returns its bag unrewritten.
 */
const currentResourceSecretsStore = new AsyncLocalStorage<RecordedSecretValues>();

/**
 * Every bag bound on the current async chain, outermost first. A nested-stack
 * child engine runs INSIDE its parent's `NestedStackProvider` call, so the
 * child's per-resource bag shadows the parent's in
 * {@link currentResourceSecretsStore}; the log sink masks with all of them,
 * since a parent secret the child never resolved can still reach a child line.
 */
const boundSecretBagsStore = new AsyncLocalStorage<readonly RecordedSecretValues[]>();

/**
 * The logger's SINK masker (issue
 * [#2177](https://github.com/go-to-k/cdkd/issues/2177)): every log line emitted
 * while a bag is bound — a provider's own `this.logger.*` line included — is
 * masked with the printing masker (`maskSecretsInText`'s two arms, log-only
 * needles included) over every bound bag, so a provider call site that forgets
 * to thread `maskSecrets` no longer prints the plaintext. Installed at module
 * load: every binder imports this module, so the source is in place before any
 * bag can be bound.
 *
 * Unbound or empty is one store read and an `undefined`, which the logger
 * takes as "leave the line alone". A bound line gets a FRESH union masker, so
 * its needle regex is built at most once per line and never outlives it: a
 * bag can only change between lines, never while one is formatted.
 */
installLogLineMaskerSource(() => {
  const bags = boundSecretBagsStore.getStore();
  if (bags === undefined || !bags.some((bag) => hasMaskableValues(bag))) return undefined;
  return createUnionSecretMasker(bags);
});

/**
 * Run `fn` with `secrets` visible to {@link getCurrentResourceSecrets}. Used by
 * the deploy engine and the rollback executor around a provider CREATE / UPDATE
 * call; see the store's own doc for why the bag travels this way rather than on
 * `CreateContext`.
 */
export function withCurrentResourceSecrets<T>(secrets: RecordedSecretValues, fn: () => T): T {
  const outer = boundSecretBagsStore.getStore() ?? [];
  return boundSecretBagsStore.run([...outer, secrets], () =>
    currentResourceSecretsStore.run(secrets, fn)
  );
}

/**
 * The bag {@link withCurrentResourceSecrets} bound for the provider call
 * currently in flight, or `undefined` when no binder is on the stack.
 *
 * Three readers: `NestedStackProvider` (seeds the child engine),
 * `SecretsManagerSecretProvider.asPersisted` (issue #2472 — rewrites a desired
 * bag into the spelling state persisted so it can be COMPARED against the
 * previous one; a masking function cannot substitute there, because `***`
 * never equals the persisted `{{resolve:...}}` expression), and
 * `CustomResourceProvider`'s refusal to send a handler a secret (issue #4009),
 * which asks only WHETHER an expression entry exists and where its plaintext
 * sits. A provider reading this MUST NOT enumerate or log its KEYS — they are
 * secret plaintext.
 */
export function getCurrentResourceSecrets(): RecordedSecretValues | undefined {
  return currentResourceSecretsStore.getStore();
}
