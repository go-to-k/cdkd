import { hasNoCloudControlHandlers } from '../../../provisioning/unsupported-types.js';
import { ccBrokenReason } from '../../../provisioning/provider-registry.js';
import { lostChildActions, survivesParent } from '../../child-of-recreated-parent.js';
import { shownType } from '../../recreate-target-readers.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { withPropertiesMarksOf } from '../record-shape.js';
import { settleReportedCreates } from './helpers.js';
import type { DeployRun } from './run.js';

/**
 * The failed deploy's record fixes made before its first save: lost
 * children of re-created parents, then the deadline-failed creates
 * (go-to-k/cdkd#5835: moved out of `executeDeployment`'s catch).
 */
export async function settleFailedDeployRecords(run: DeployRun): Promise<void> {
  const {
    engine,
    template,
    conditions,
    newResources,
    completedOperations,
    failedOperations,
    reportedCreatesToSettle,
  } = run;
  // go-to-k/cdkd#4443: a resource AWS stored inside a parent this deploy
  // destroyed and re-created under the same id went with the old parent;
  // the UPDATE arm restores it, but this deploy failed before it did. Its
  // record would survive (the rollback keeps an equal-id parent as done)
  // and every later deploy would diff it unchanged, so forget it: the next
  // deploy creates it. Before every save below, the interrupt path's
  // included.
  // Written: restored, or any completed operation -- minus a re-put child on
  // Cloud Control, whose completed update sent nothing.
  const written = new Set([
    ...engine.replacementRun.restoredLostChildren,
    ...completedOperations.map((op) => op.logicalId),
  ]);
  for (const logicalId of engine.replacementRun.updatesThatSentNothing) written.delete(logicalId);
  // A child whose own write was ATTEMPTED and then threw (a deadline race, a
  // lost response, a definite AWS rejection -- only EC2 marks a refusal as
  // never applied, so the rest all carry an attempted bag; a multi-holder put
  // that landed on one holder) may be live in AWS: it keeps its record,
  // accepting the old fail-open for that narrower set, rather than risk an
  // untracked live grant. Applied LAST, so nothing above can undo it.
  // ...except one whose provider reported it sent NOTHING before the throw
  // (a later step failed): nothing could have reached AWS, so it is
  // unwritten and forgotten. A child that threw BEFORE that word stays
  // attempted -- an accepted fail-open (the PR's known edges).
  const attempted = new Set(
    failedOperations
      .filter(
        (op) =>
          op.attemptedProperties !== undefined &&
          !engine.replacementRun.updatesThatSentNothing.has(op.logicalId)
      )
      .map((op) => op.logicalId)
  );
  const recoveryFlagFor = (
    logicalId: string,
    record: { resourceType: string; provisionedBy?: string | undefined }
  ): string | undefined => {
    const type = record.resourceType;
    if (record.provisionedBy === 'cc-api') {
      // The validator can still refuse it while the template uses a
      // property the SDK provider does not cover; its refusal names the
      // `--prefer-sdk-route` that lets it through.
      return engine.providerRegistry.getProviderType?.(type) === 'sdk'
        ? safeMsg`--recreate-via-sdk-provider ${logicalId} (adding the --prefer-sdk-route the refusal names, if it is refused over a property the SDK provider does not cover)`
        : undefined;
    }
    const noCcRoute =
      hasNoCloudControlHandlers(type) ||
      engine.providerRegistry.ccRouteUnavailableReason?.(type) !== undefined ||
      ccBrokenReason(type) !== undefined;
    return noCcRoute
      ? undefined
      : safeMsg`--recreate-via-cc-api ${logicalId} (which moves it to Cloud Control)`;
  };
  for (const lost of lostChildActions({
    templateResources: template.Resources ?? {},
    records: newResources,
    recreatedUnderSameId: engine.replacementRun.recreatedUnderSameId,
    written,
    conditions,
  })) {
    const record = newResources[lost.logicalId]!;
    const childType = shownType(record.resourceType);
    // The one recovery flag the validator accepts for this record, or
    // none: `validate.ts` refuses --recreate-via-cc-api on a record already
    // on Cloud Control or a type with no usable Cloud Control route (no
    // handlers, an SDK opt-out, or a 'cc-broken' type), and
    // --recreate-via-sdk-provider on an SDK record or a type with no SDK
    // provider.
    const recovery = recoveryFlagFor(lost.logicalId, record);
    // Kept only while that way back exists. Without one (an SDK-recorded
    // IAM `Policy`, topic or queue policy, or `EventInvokeConfig`), keeping
    // the record would leave a possibly-missing Deny with no recovery, so
    // the ordinary forget / trim applies: those types' creates are
    // overwrite-style puts, which the next deploy re-writes whatever landed,
    // or else the next CREATE collides loudly (a Cloud Control-only alias or
    // log stream that did land).
    // A resource merely ATTACHED to the parent (go-to-k/cdkd#4461) is
    // always trimmed instead: re-attaching is idempotent (`Attach*Policy`,
    // `AddUserToGroup`; an instance profile that kept its role fails loudly),
    // while the flag would destroy and re-create the resource itself -- for
    // a user, revoking its access keys -- to redo one attach.
    if (
      attempted.has(lost.logicalId) &&
      recovery !== undefined &&
      !survivesParent(record.resourceType)
    ) {
      engine.logger.warn(
        safeMsg`  ⚠ ${lost.logicalId} (${childType}) went with a resource this deploy re-created under the same id; restoring it failed, and its state record is kept because the write may have reached AWS. If it is missing there, re-run the deploy with `.concat(
          recovery,
          ' to write it again.'
        )
      );
      continue;
    }
    // An attempted write forgotten for lack of a recovery flag may still be
    // live on the parent, and once its record is gone nothing removes it.
    // The parent is named with its physical id too: that is what a hand
    // removal in AWS has to look up.
    const parentPhysicalId = newResources[lost.parent]?.physicalId;
    const parentShown =
      parentPhysicalId !== undefined && parentPhysicalId !== ''
        ? safeMsg`${lost.parent} (${parentPhysicalId})`
        : safeMsg`${lost.parent}`;
    const mayStillBeLive = attempted.has(lost.logicalId)
      ? safeMsg` Its write may still be on `.concat(
          parentShown,
          safeMsg`: if ${lost.logicalId} is removed from the template before the next deploy, remove it from that resource by hand.`
        )
      : '';
    if (lost.action === 'forget' && mayStillBeLive !== '') {
      Reflect.deleteProperty(newResources, lost.logicalId);
      engine.logger.warn(
        safeMsg`  ⚠ ${lost.logicalId} (${childType}) went with a resource this deploy re-created under the same id, and restoring it failed: its state record is dropped, so the next deploy creates it again.`.concat(
          mayStillBeLive
        )
      );
    } else if (lost.action === 'forget') {
      Reflect.deleteProperty(newResources, lost.logicalId);
      engine.logger.warn(
        safeMsg`  ⚠ ${lost.logicalId} (${childType}) went with a resource this deploy re-created under the same id, and the deploy failed before restoring it: it is gone from AWS and the resource runs without it until the next deploy, which creates it again (its state record is dropped).`
      );
    } else if (survivesParent(record.resourceType)) {
      // go-to-k/cdkd#4461: the resource exists; only its attachment to the
      // re-created principal is gone. An attach that partly landed is NOT
      // in the trimmed record: harmless while the template keeps naming
      // the principal (the next attach is idempotent), and a delete of the
      // resource detaches whatever IAM lists, but a list that drops the
      // principal before the next deploy diffs unchanged and leaves the
      // landed attachment untracked.
      newResources[lost.logicalId] = {
        ...record,
        // go-to-k/cdkd#5076: the trimmed lists only drop elements of the
        // record's own lists, so the copy keeps the bag's redaction marks.
        properties: withPropertiesMarksOf(record.properties, {
          ...record.properties,
          ...lost.trimmed,
        }),
      };
      const lists = Object.keys(lost.trimmed).join(' / ');
      engine.logger.warn(
        safeMsg`  ⚠ ${lost.logicalId} (${childType}) lost its attachment to a resource this deploy re-created under the same name, and the deploy failed before attaching it again: its record keeps only the attachments that survived, so the next deploy attaches it again.`.concat(
          attempted.has(lost.logicalId)
            ? safeMsg` Its attach may already have landed on `.concat(
                parentShown,
                safeMsg`: if ${lost.logicalId}'s ${lists} stops naming it before the next deploy, nothing will detach it, so detach it by hand.`
              )
            : ''
        )
      );
    } else {
      newResources[lost.logicalId] = {
        ...record,
        // go-to-k/cdkd#5076: the trimmed lists only drop elements of the
        // record's own lists, so the copy keeps the bag's redaction marks.
        properties: withPropertiesMarksOf(record.properties, {
          ...record.properties,
          ...lost.trimmed,
        }),
      };
      engine.logger.warn(
        safeMsg`  ⚠ ${lost.logicalId} (${childType}) was removed from a resource this deploy re-created under the same id, and the deploy failed before writing it again: the next deploy writes it there again (its record keeps only the holders it is still on).`.concat(
          mayStillBeLive
        )
      );
    }
  }

  // go-to-k/cdkd#5511: as late as possible before the first save, so a
  // report or retraction an abandoned provider call made after its deadline
  // is reflected. One made after this point is not.
  await settleReportedCreates(engine, template, failedOperations, reportedCreatesToSettle);
}
