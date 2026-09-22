import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-async-context "attach this permissions boundary to every IAM principal
 * cdkd creates" value, set from `deploy --permissions-boundary <arn>`.
 *
 * The point is that it OVERRIDES the template. A template-declared
 * `PermissionsBoundary` is written by whoever wrote the CDK app, so it is not a
 * control the operator holds: an app that omits it, or declares a weaker one,
 * would otherwise escape the boundary the operator asked for. The flag
 * therefore wins unconditionally, and a template value that differs is logged
 * as an override rather than honored ({@link resolvePermissionsBoundary}).
 *
 * This is what makes it possible to hand `cdkd deploy` a session role whose
 * `iam:CreateRole` is conditioned on `iam:PermissionsBoundary` and still deploy
 * an app that never mentions boundaries — the condition is satisfied by cdkd,
 * not by the app. The CDK CLI has no equivalent: its `PermissionsBoundary.of()`
 * is a synth-time construct the app's own code can simply not call.
 *
 * Scoped via `AsyncLocalStorage` for the same reason as
 * `resource-name.ts`'s skip-prefix store: `--stack-concurrency > 1` runs each
 * stack's body in its own scope, so parallel deploys cannot cross-contaminate.
 * Unset (the default) means "honor the template", preserving prior behavior.
 */
const forcedBoundaryStore = new AsyncLocalStorage<string | undefined>();

/**
 * Run `fn` with the forced permissions-boundary ARN set to `arn`. Passing
 * `undefined` leaves the template in charge, which is the default.
 *
 * Wrap this around the per-stack deploy body in the deploy CLI, alongside
 * `withSkipPrefix(...)`. The stores are independent, so ordering is free.
 */
export function withForcedPermissionsBoundary<T>(
  arn: string | undefined,
  fn: () => Promise<T>
): Promise<T>;
export function withForcedPermissionsBoundary<T>(arn: string | undefined, fn: () => T): T;
export function withForcedPermissionsBoundary<T>(
  arn: string | undefined,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return forcedBoundaryStore.run(arn, fn);
}

/**
 * Read the current async context's forced boundary ARN, or `undefined` when no
 * `withForcedPermissionsBoundary` scope is active.
 *
 * Public for unit tests; providers go through
 * {@link resolvePermissionsBoundary}.
 */
export function getForcedPermissionsBoundary(): string | undefined {
  return forcedBoundaryStore.getStore();
}

/**
 * The boundary an IAM principal provider should actually apply.
 *
 * Returns the forced ARN when a scope is active, otherwise the
 * template-declared value. `onOverride` is invoked only when the forced ARN
 * replaces a DIFFERENT template value (including replacing "no boundary"), so
 * a provider can log that the template was overridden; it is not called when
 * the two already agree.
 */
export function resolvePermissionsBoundary(
  templateValue: string | undefined,
  onOverride?: (forced: string, template: string | undefined) => void
): string | undefined {
  const forced = getForcedPermissionsBoundary();
  if (forced === undefined) return templateValue;
  if (forced !== templateValue) onOverride?.(forced, templateValue);
  return forced;
}

/**
 * A copy of `properties` with `PermissionsBoundary` set to what was actually
 * sent. `undefined` REMOVES the key rather than setting it to `undefined`,
 * which would survive `structuredClone` and every `Object.keys` walk and so
 * could never match what `readCurrentState` emits.
 *
 * Used for `effectiveProperties` on the provisioning side and by
 * `canonicalizeDesiredProperties` on the diff side, so state and template
 * cannot fold to different shapes.
 */
export function withAppliedPermissionsBoundary(
  properties: Record<string, unknown>,
  applied: string | undefined
): Record<string, unknown> {
  const next = { ...properties };
  if (applied === undefined) delete next['PermissionsBoundary'];
  else next['PermissionsBoundary'] = applied;
  return next;
}

/**
 * The `canonicalizeDesiredProperties` half for an IAM principal type. Folds the
 * forced boundary onto the DESIRED side so `cdkd diff` compares like with like:
 * state holds the forced value (recorded via `effectiveProperties`), so without
 * this the template's declared value reads as a user change on every deploy.
 *
 * A no-op when no `withForcedPermissionsBoundary` scope is active, which keeps
 * the pre-flag behavior exactly as it was.
 */
export function canonicalizePermissionsBoundary(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const forced = getForcedPermissionsBoundary();
  if (forced === undefined) return properties;
  if (properties['PermissionsBoundary'] === forced) return properties;
  return withAppliedPermissionsBoundary(properties, forced);
}
