import type { NestedStackProvider } from '../nested-stack-provider.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import {
  getCurrentNestedStackContext,
  type NestedStackProviderContext,
} from '../../nested-stack-context.js';
import { withoutSdkUnwiredProperties } from '../../property-coverage.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { markSameGenerationBag } from '../../../deployment/secret-redaction.js';

/**
 * The record-only key a nested row carries while its child still holds a
 * skipped DELETE (issue [#4453](https://github.com/go-to-k/cdkd/issues/4453)).
 *
 * A skipped DELETE keeps its record so the next deploy re-attempts it, but
 * inside a nested child that re-attempt needs the child deploy to RUN, and the
 * parent's diff sees only this row's `TemplateURL` / `Parameters`: with an
 * unchanged child template the row is `NO_CHANGE` and the child's pending
 * DELETE is never retried, so the next deploy exits 0 over it. Recording this
 * key (via `effectiveProperties`) makes the next diff see a REMOVAL on the row,
 * so it updates, the child deploys and retries, and — counted again through
 * the #1989 channel — the run exits 2 until the DELETE lands. It also makes
 * `cdkd diff` preview that re-run. It holds the child's `deleteSkipped`, which
 * includes every descendant's, so each level's row re-runs the level below;
 * a clean re-run records the desired bag again and the key is gone.
 *
 * No CloudFormation property name contains `:`, so the key cannot shadow a
 * real one, and no template can declare it.
 */
export const PENDING_CHILD_DELETES_KEY = 'cdkd:PendingChildDeletes';

export const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/**
 * The bag to record for a nested row whose child left `pendingChildDeletes`
 * skipped DELETEs, or `undefined` (record the desired bag) when there are none.
 *
 * Shaped exactly like the bag the engine records itself, plus the key: the
 * SDK route's SDK-unwired properties (`Tags`, `TimeoutInMinutes`, ...) are removed
 * FIRST, and the result is then marked same-generation. `properties` is this
 * pass's own resolution of the template, which is the one fact the persist
 * choke point needs to tokenize a short secret in the row's `Parameters` (the
 * engine marks the desired bag it records itself, but never an
 * `effectiveProperties` replacement). The order matters: the engine narrows
 * an `effectiveProperties` bag again, and a narrowing that drops a key returns
 * a NEW, unmarked object; narrowed here, its pass removes nothing and keeps
 * this object. Callers must not pass a STATE record here (a rollback replay):
 * it would vouch for leaves this pass never resolved.
 */
export function recordWithPendingChildDeletes(
  properties: Record<string, unknown>,
  pendingChildDeletes: number
): Record<string, unknown> | undefined {
  if (pendingChildDeletes <= 0) return undefined;
  return markSameGenerationBag({
    ...withoutSdkUnwiredProperties(NESTED_STACK_TYPE, properties),
    [PENDING_CHILD_DELETES_KEY]: pendingChildDeletes,
  });
}

/**
 * The run's account (`--profile`, the RESOLVED bucket, `--state-prefix`) as the
 * provider context carries it, for every pasteable command a nested child's
 * message prints: the deploy and destroy paths set `stateBucket` and
 * `destroyOptions` alike (go-to-k/cdkd#3909, #4159, #4648).
 */
export function runAccountOf(ctx: NestedStackProviderContext): LockRecoveryContext {
  return {
    profile: ctx.destroyOptions?.profile,
    stateBucket: ctx.stateBucket,
    statePrefix: ctx.destroyOptions?.statePrefix,
  };
}

export function requireContext(this: NestedStackProvider): NestedStackProviderContext {
  const ctx = getCurrentNestedStackContext();
  if (!ctx) {
    // Issue #1849: the OTHER deterministic refusal `delete()` can raise, and
    // the one whose terminality is a matter of IMPOSSIBILITY rather than of
    // policy — which is what distinguishes it from the interrupted arm marked
    // above. There the retry COULD run; it is marked because re-entering a
    // destroy the user just aborted is the wrong thing to do. Here it could
    // not succeed at all — the store is read
    // from AsyncLocalStorage, and a retry runs inside the SAME async
    // context as the first attempt, so a caller that did not wrap will not
    // have wrapped on attempt 2 either. The mark reaches `create()` /
    // `update()` too (both call this helper), which is correct rather than
    // incidental: the invariant is identical on every attempt from any of
    // the three. Marked even though this message
    // interpolates nothing user-controlled and therefore cannot pick up a
    // retryable substring today: the marker is a DECLARATION by the raiser,
    // which is what the mechanism exists for — message discipline is what
    // failed at the `errorCount` throw above.
    throw markNonRetryable(
      new Error(
        'NestedStackProvider invoked outside withNestedStackContext() scope. ' +
          'The deploy / destroy CLI entry point must wrap its DeployEngine.deploy / ' +
          'runDestroyForStack call in withNestedStackContext(ctx, () => ...).'
      )
    );
  }
  return ctx;
}

export function requireDeployContext(
  this: NestedStackProvider,
  ctx: NestedStackProviderContext,
  op: 'create' | 'update'
): void {
  if (!ctx.nestedTemplates || !ctx.dagBuilder || !ctx.diffCalculator) {
    throw markNonRetryable(
      new Error(
        `NestedStackProvider.${op}: deploy-mode context fields (nestedTemplates / dagBuilder / diffCalculator) ` +
          `are missing. This usually means a destroy-mode entry point called into create/update by mistake.`
      )
    );
  }
}

export function deriveChildStackName(
  this: NestedStackProvider,
  parentStackName: string,
  nestedLogicalId: string
): string {
  // `~` separator avoids ambiguity with CDK Stage paths (which use `/`).
  return `${parentStackName}~${nestedLogicalId}`;
}

/**
 * The synthesized `physicalId` recorded on the PARENT's
 * `AWS::CloudFormation::Stack` row.
 *
 * `childRegion` is the region the child stack was deployed into (its own
 * `StackState.region`), and the segment is LOAD-BEARING as of issue
 * [#2055](https://github.com/go-to-k/cdkd/issues/2055):
 * `IntrinsicFunctionResolver` reads it back as the producer region when a
 * parent property consumes `Fn::GetAtt: [<Child>, 'Outputs.<Name>']` and the
 * child's persisted output is a redacted `{{resolve:...}}` expression. A
 * secret NAME is regional, so resolving that expression anywhere but the
 * child's own region can answer with a different secret. Equal to the
 * parent's region today; do not collapse the two.
 */
export function synthesizeArn(
  this: NestedStackProvider,
  accountId: string,
  childRegion: string,
  parentStackName: string,
  logicalId: string
): string {
  // Per design §3: partition `cdkd-local` is load-bearing — any consumer
  // that misuses this value as a real AWS ARN fails loudly with
  // `Invalid ARN partition: cdkd-local` rather than silently using a
  // non-ARN string.
  return `arn:cdkd-local:${childRegion}:${accountId}:nested-stack/${parentStackName}/${logicalId}`;
}
