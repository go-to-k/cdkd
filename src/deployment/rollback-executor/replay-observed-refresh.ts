import { RESOURCE_NOT_FOUND, type ResourceProvider } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import { hasAddressablePhysicalId } from '../../state/malformed-resources-bag.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../utils/display-safe.js';
import { buildReadCurrentStateContext } from '../read-current-state-context.js';
import { withCurrentResourceSecrets } from '../resource-secrets-scope.js';
import {
  maskedLeafCoordinatesOf,
  scrubResourceRecord,
  withOffTemplateEchoesMasked,
  type RecordedSecretValues,
} from '../secret-redaction.js';

/** What {@link withRefreshedObservedBaseline} reads from the revert it follows. */
export interface ObservedBaselineRefresh {
  provider: ResourceProvider;
  op: { readonly logicalId: string; readonly resourceType: string };
  /** The RESOLVED bag the revert's `update()` sent: what AWS now holds. */
  desiredProps: Record<string, unknown> | undefined;
  /** The record being restored, as state holds it (its leaves REDACTED). */
  restored: ResourceState;
  /** The replay's records, for the readback's sibling context. */
  stateResources: Record<string, ResourceState>;
  /** The op's resolved secrets (`resolveReplayProps`). */
  secrets: RecordedSecretValues;
  /** What the revert put back at a `NoEcho` coordinate (`substituteMarkedNoEchoLeaves`). */
  noEcho: { readonly substituted: readonly unknown[] };
  /** The op's masker (`createOpMasker`). */
  mask: (text: string) => string;
  logger: { debug(message: string): void };
  /** The scope the revert's `update()` ran in (`replayPrefixScope`). */
  inScope: <T>(fn: () => Promise<T>) => Promise<T>;
  /** `RollbackExecutorContext.captureObservedState`; only `false` skips. */
  capture: boolean | undefined;
  /**
   * go-to-k/cdkd#7129: `record` describes a resource the replay just
   * RE-CREATED (a reversed replacement), whose stale baseline was dropped on
   * purpose. Its absent `observedProperties` then means "not captured yet",
   * as after a deploy's CREATE, so a readback is taken for it too.
   */
  recreated?: true | undefined;
}

/**
 * go-to-k/cdkd#6526: `record` (built by `recordAfterRollbackUpdate` after a
 * SUCCESSFUL in-place revert) with its `observedProperties` re-read from AWS,
 * as the deploy re-captures it after an ordinary update
 * (`ObservedCapture.kickOffObservedCapture`). Without it the restored record
 * keeps the PRE-deploy snapshot verbatim, and a value AWS regenerates on the
 * revert's write (an S3 lifecycle rule's generated `Id`) reports as drift.
 *
 * Runs only on the rollback replay's two in-place revert arms (`replay-revert.ts`
 * and `replay-failed.ts`) and its two re-create arms (`recreated`,
 * go-to-k/cdkd#7129: the reverse replacement's `finish.ts` and
 * `replay-failed-replaced-deleted.ts`, as the deploy captures after a CREATE),
 * which both the automatic rollback and `cdkd rollback` drive, never on a
 * deploy: the ordinary deploy path issues no new call.
 *
 * REDACTION is the deploy's: `scrubResourceRecord` walks the readback under a
 * same-generation claim (it was taken right after this replay wrote the
 * restored bag, which `secrets` resolved), against the restored record's
 * REDACTED `properties`, which is how `redactStateForPersist` scrubs a drained
 * capture (its `#1900` source when no template bag is given). The claim is the
 * call's argument and the bag carries no mark, so a later scrub
 * (`redactRollbackRecord`, the engine's persist) rewrites it as a prior
 * generation and adds no fail-closed mask.
 *
 * `cdkd deploy --no-capture-observed-state` skips it, as it skips the deploy's
 * own capture (`capture: false`).
 *
 * Every case it cannot answer SAFELY keeps the record's existing baseline,
 * which is exactly the pre-#6526 behavior: at worst the drift entry this
 * exists to remove, never a disclosure and never a lost baseline. Dropping the
 * field instead would be wrong, since an absent `observedProperties` is
 * OVERLOADED (also a refused import baseline, which a deploy-start refresh
 * must not refill). Those cases:
 *
 * - no baseline to refresh (unless `recreated`), or a refused one
 *   (`observedBaselineRefused`), which a re-create keeps refused too;
 * - a provider without `readCurrentState`, or an unaddressable physical id;
 * - any `NoEcho` marking on the restored record (`noEchoLeaves`,
 *   `noEchoAttributeNames`, a value the revert substituted) or any `***` in
 *   its `properties` / baseline: the readback would hold the plaintext at a
 *   position only the deploy's `NoEcho` persist arm knows how to mask, and a
 *   masked baseline has its own re-capture (`masked-baseline-recapture.ts`);
 * - a read that fails, answers nothing, or reports the resource gone. A
 *   failure is logged at debug through the op's masker and never fails the
 *   rollback: AWS already holds the restored value.
 */
export async function withRefreshedObservedBaseline(
  record: ResourceState,
  refresh: ObservedBaselineRefresh
): Promise<ResourceState> {
  const { provider, restored } = refresh;
  if (refresh.capture === false) return record;
  if (record.observedBaselineRefused === true) return record;
  if (record.observedProperties === undefined && refresh.recreated !== true) return record;
  if (!provider.readCurrentState || !hasAddressablePhysicalId(record)) return record;
  const noEchoFields = restored as { noEchoLeaves?: unknown; noEchoAttributeNames?: unknown };
  if (
    noEchoFields.noEchoLeaves !== undefined ||
    noEchoFields.noEchoAttributeNames !== undefined ||
    refresh.noEcho.substituted.length > 0 ||
    maskedLeafCoordinatesOf(restored.properties).length > 0 ||
    maskedLeafCoordinatesOf(record.observedProperties).length > 0
  ) {
    return record;
  }
  const readCurrentState = provider.readCurrentState.bind(provider);
  let observed: Record<string, unknown> | typeof RESOURCE_NOT_FOUND | undefined;
  try {
    // Sink-masked with the op's bag, as the deploy's capture binds it
    // (go-to-k/cdkd#4362): AWS may echo a secret-derived name in a failure.
    observed = await withCurrentResourceSecrets(refresh.secrets, () =>
      refresh.inScope(() =>
        readCurrentState(
          record.physicalId,
          refresh.op.logicalId,
          refresh.op.resourceType,
          refresh.desiredProps ?? {},
          {
            // The record being restored stands for its own id, never the
            // failed deploy's record the replay still holds there.
            ...buildReadCurrentStateContext(
              { resources: { ...refresh.stateResources, [refresh.op.logicalId]: record } },
              refresh.op.logicalId
            ),
            // The revert just wrote this bag, as the deploy's own update does.
            afterOwnWrite: true,
          }
        )
      )
    );
  } catch (err) {
    refresh.logger.debug(
      safeMsg`Rollback: observedProperties refresh for ${refresh.mask(refresh.op.logicalId)} (${refresh.mask(refresh.op.resourceType)}) failed: ${asIsMessage(refresh.mask(describeAwsFailure(err).detail))}; ${refresh.recreated === true ? 'the re-created record has no drift baseline until a deploy captures one' : 'the restored record keeps its previous drift baseline'}.`
    );
    return record;
  }
  if (observed === undefined || observed === RESOURCE_NOT_FOUND) return record;
  const scrubbed = scrubResourceRecord(
    {
      properties: restored.properties,
      // The scrub builds a new bag, so the record never aliases the object the
      // provider returned (pinned by this module's suite).
      observedProperties: observed,
    },
    refresh.secrets,
    undefined,
    undefined,
    { observed: 'same-generation' }
  ).observedProperties;
  if (scrubbed === undefined) return record;
  // go-to-k/cdkd#7152: a secret reference's plaintext the readback echoed
  // under a key the template lacks, learned from the raw readback.
  return withOffTemplateEchoesMasked(
    { ...record, observedProperties: scrubbed },
    { properties: restored.properties, observedProperties: observed }
  );
}
