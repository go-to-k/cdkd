/**
 * The per-stack AWS scope: which clients and which region code running on
 * behalf of ONE stack must use (issue go-to-k/cdkd#1981).
 *
 * `cdkd deploy` runs up to `--stack-concurrency` stacks at once, and stacks may
 * live in different regions. It used to re-point two PROCESS-GLOBAL things per
 * stack: the `getAwsClients()` singleton (`setAwsClients`) and
 * `process.env.AWS_REGION`. Both were restored in each stack's `finally`, so
 * with two stacks in flight a provider call made after any `await` could read
 * the OTHER stack's clients or region and create a resource in the wrong
 * region.
 *
 * An `AsyncLocalStorage` scope has neither problem: it is bound to the async
 * call chain that entered it, so every continuation of stack A sees stack A's
 * scope no matter what stack B does in between. The consumers read it through
 * three doors, so callers do not change:
 *
 * - `getAwsClients()` returns the scope's clients before the global;
 * - `awsClientDefaults()` adds the scope's `region`, which reaches every SDK
 *   client a provider builds for itself (that helper is spread FIRST at every
 *   construction site, so a site's own explicit `region` still wins);
 * - {@link ambientRegion} replaces direct `process.env.AWS_REGION` reads.
 *
 * Outside a scope every door behaves exactly as before (the global singleton,
 * no injected region, the environment variable), so commands that never enter
 * one are unchanged.
 *
 * A LEAF apart from a type-only import: `aws-clients.ts` and
 * `aws-client-defaults.ts` both import it, and it is inside the closure
 * `scripts/audit-provider-coverage.ts` loads under Node's literal `.ts`
 * resolution (see the note in `aws-clients.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AwsClients } from './aws-clients.ts';

export interface StackAwsScope {
  /** The stack's region. Always a named region: a scope is never region-less. */
  readonly region: string;
  /** Clients bound to {@link region}. */
  readonly clients: AwsClients;
}

const storage = new AsyncLocalStorage<StackAwsScope>();

/**
 * Run `fn` with `scope` as the AWS scope of everything it (transitively,
 * across `await`s) calls. Scopes nest; the innermost wins.
 */
export function runInStackAwsScope<T>(scope: StackAwsScope, fn: () => T): T {
  if (typeof scope.region !== 'string' || scope.region === '') {
    // A region-less scope would silently fall through to the environment in
    // `awsClientDefaults()` and `ambientRegion()` — the very read this scope
    // exists to replace — so refuse it rather than accept it.
    throw new Error('runInStackAwsScope requires a non-empty region');
  }
  return storage.run(scope, fn);
}

/** The active stack AWS scope, or `undefined` outside one. */
export function currentStackAwsScope(): StackAwsScope | undefined {
  return storage.getStore();
}

/**
 * The region code running NOW should treat as its own: the active stack
 * scope's region, else `process.env.AWS_REGION` (the pre-scope behaviour).
 *
 * Use this instead of reading `process.env['AWS_REGION']` in any code a deploy
 * can reach — the environment is process-wide and cannot say which of several
 * concurrently deploying stacks is asking.
 */
export function ambientRegion(): string | undefined {
  return storage.getStore()?.region ?? process.env['AWS_REGION'];
}
