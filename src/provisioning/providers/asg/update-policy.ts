/**
 * go-to-k/cdkd#6437: the ASG's reading of its `UpdatePolicy`, shared by the
 * provider's `update()` and the deploy engine's hint
 * (`src/deployment/deploy-engine/update-policy.ts`). Import-free on purpose:
 * the engine loads providers lazily, and importing `update.ts` from it would
 * load the Auto Scaling SDK client on every deploy.
 */

/**
 * `IgnoreUnmodifiedGroupSizeProperties` set to the literal `true` (or the
 * string `'true'`, as a template may spell a boolean). An intrinsic there is
 * not resolved and reads as unset, the pre-#6437 behaviour of sending every
 * size property.
 */
export function ignoresUnmodifiedGroupSize(
  updatePolicy: Readonly<Record<string, unknown>> | undefined
): boolean {
  const scheduled = updatePolicy?.['AutoScalingScheduledAction'];
  if (typeof scheduled !== 'object' || scheduled === null) return false;
  const flag = (scheduled as Record<string, unknown>)['IgnoreUnmodifiedGroupSizeProperties'];
  return flag === true || flag === 'true';
}
