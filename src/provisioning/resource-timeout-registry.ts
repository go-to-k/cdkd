/**
 * Process-wide registry of the user's resolved `--resource-timeout` input.
 *
 * Providers with an INNER waiter cap (`ECSProvider.settleService`'s
 * `--full-wait` steady-state waiter, issue #1280, and
 * `CloudFrontDistributionProvider.waitForDistributionStable`'s Deployed-wait
 * budget, issue #1282) consult this so the inner cap can never undercut the
 * OUTER per-resource deadline the same flag already lifts in the deploy
 * engine / destroy runner. This is the SDK-provider
 * analogue of `slow-cc-operation-timeouts.ts`, which closes the identical
 * inner-undercuts-outer gap for Cloud Control types — but sourced from the
 * user's CLI input rather than a hardcoded per-type floor, because the ECS
 * 600s default is already the right floor (Terraform parity) and only an
 * explicit user override should raise it.
 *
 * Deliberately NOT threaded through the `ResourceProvider` interface: the
 * timeout is per-CLI-invocation state (one flag set per process), and widening
 * every provider method signature for one consumer would touch ~50 files.
 * Commands seed it immediately after `validateResourceTimeouts(options)` (the
 * wiring is pinned by a source-level test, same pattern as
 * `applyWaitFlagEnv`), so only validated values ever land here.
 */

/**
 * Structurally identical to `ResourceTimeoutOption` in `src/cli/options.ts`.
 * Re-declared locally so the provisioning layer does not import CLI types.
 */
export interface ResolvedResourceTimeouts {
  globalMs?: number;
  perTypeMs?: Record<string, number>;
}

let resolved: ResolvedResourceTimeouts | undefined;

/**
 * Seed the registry with the validated `--resource-timeout` input. Call once
 * per CLI invocation, right after `validateResourceTimeouts`. Passing
 * `undefined` (flag not supplied) clears the registry, so consumers fall back
 * to their own compile-time floors.
 */
export function setResolvedResourceTimeouts(opt: ResolvedResourceTimeouts | undefined): void {
  resolved = opt;
}

/**
 * The user's resolved timeout for `resourceType` in milliseconds, or
 * `undefined` when the user supplied nothing applicable. Resolution matches
 * the outer-deadline sites: per-type override wins, else the explicit global
 * value. The compile-time default (`DEFAULT_RESOURCE_TIMEOUT_MS`) is
 * deliberately NOT applied here — an inner waiter's own floor (e.g. ECS 600s)
 * must only be raised by an EXPLICIT user value, never by the generic 30m
 * default silently multiplying every `--full-wait` failure by 3x.
 */
export function resolvedResourceTimeoutMs(resourceType: string): number | undefined {
  if (!resolved) return undefined;
  return resolved.perTypeMs?.[resourceType] ?? resolved.globalMs;
}

/** Test-only: reset to the unseeded state. */
export function clearResolvedResourceTimeouts(): void {
  resolved = undefined;
}
