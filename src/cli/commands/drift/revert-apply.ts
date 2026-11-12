/**
 * `cdkd drift`: `--revert`: one resource's `provider.update` and the state record it leaves.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { ResourceUpdateNotSupportedError } from '../../../utils/error-handler.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { updatePartialReason, updatePartialMessage } from '../../../deployment/update-outcome.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { recordAfterRollbackUpdate } from '../../../deployment/rollback-executor/replay-retry.js';
import { withRetry } from '../../../deployment/retry.js';
import { maskingRetryLogger } from '../../../deployment/masking-retry-logger.js';
import {
  createSecretMasker,
  maskSecretsInText,
  redactForState,
  recordNoEchoAttributeValues,
  maskWholeValue,
} from '../../../deployment/secret-redaction.js';
import { noEchoAttributeNamesOf } from '../../../deployment/deploy-engine/noecho.js';
import {
  settleUnsettledPrevious,
  withUnprovenUnsettled,
} from '../../../deployment/unsettled-convergence.js';
import {
  unsettledPropertiesOf,
  unsettledItemsOf,
  withoutUnsettledProperties,
} from '../../../state/unsettled-properties.js';
import { declaredEmptyProperties, declaredTrueProperties } from './baseline-keys.js';
import { keepBaselineAtUncertifiedPaths } from './revert-live-values.js';
import {
  collectNarrowedTopLevelKeys,
  keepRecordedAttributesOverMask,
  sameRecordedJson,
} from './revert-payload.js';
import type { ApplyRevertUpdateArgs } from './revert-outcome.js';

/**
 * The `provider.update` half of {@link revertDriftedOutcome}: send the revert
 * payload, then record what the update returned.
 */
export async function applyRevertUpdate(args: ApplyRevertUpdateArgs): Promise<void> {
  const {
    logger,
    tally,
    report,
    narrowedByLogicalId,
    reRecordedByLogicalId,
    settledByRevert,
    outcome,
    stateResource,
    provider,
    secrets,
    revertBaseline,
    newProperties,
  } = args;
  try {
    // go-to-k/cdkd#5487: the deploy's convergence step. The
    // previous side is already AWS's; this refuses a name AWS is
    // still changing (the catch below reports it) and re-reads
    // the unsettled ones.
    const revertPrevious = await settleUnsettledPrevious({
      provider,
      logicalId: outcome.logicalId,
      physicalId: stateResource.physicalId,
      resourceType: outcome.resourceType,
      recordedProperties: stateResource.properties ?? {},
      names: unsettledPropertiesOf(stateResource),
      attemptedItems: unsettledItemsOf(stateResource),
      previous: outcome.awsProperties,
      desired: newProperties,
    });
    const updateResult = await withRetry(
      () =>
        provider.update(
          outcome.logicalId,
          stateResource.physicalId,
          outcome.resourceType,
          newProperties,
          revertPrevious,
          // The desired bag here is `observedProperties ?? properties`
          // overlaid onto the AWS-current snapshot — an AWS READBACK, not
          // a template (issue #1732). Several `readCurrentState`
          // implementations spell "this feature is not set" as an EMPTY
          // collection rather than an absent key, so without this flag a
          // provider cannot tell "restore the unset state" (delete) from
          // a template's condition-collapsed array (leave the live value
          // alone), and picking either arm breaks the other caller.
          //
          // `maskSecrets` (issue #1932 item 3) is the THIRD caller of the
          // provider masking contract, alongside `deploy-engine.ts` and
          // `rollback-executor.ts`, and it is not optional here: the bag
          // this call carries was re-resolved from state back to
          // PLAINTEXT a few hundred lines up (`resolveStateSecretExpressions`,
          // the counterpart of the rollback replay's `resolveReplayProps`),
          // so it provably holds the concrete secret whenever the resource
          // has one. Without it, a provider warning that names a
          // mis-shaped property value — e.g. a state record holding
          // `EnabledMfas: "{{resolve:secretsmanager:...}}"`, which
          // re-resolves to a plaintext string and so is `not a list` —
          // prints that plaintext on `cdkd drift --revert`.
          //
          // Bound to `secrets`, the SAME map `resolveStateSecretExpressions`
          // resolved into and the retry logger below masks with, so the
          // masker and that logger can never disagree about what this call
          // considers secret.
          //
          // `expectedRegion` (issue #2301 item 1) is `report.region` --
          // the region segment of the state key this report was built
          // from, i.e. where the record says its resources live. It is
          // NOT necessarily where the ambient clients point: this command
          // installs its clients ONCE (the `setAwsClients` call at the top
          // of `runDrift`) and then loops over stacks in whatever regions
          // `listStacks()` returned, so a `--revert` for a stack outside
          // the ambient region was previously issued against the ambient
          // one -- a write addressed by a state-recorded physical id, in
          // the wrong region, which is exactly the hazard the guard
          // exists for. With this threaded, a Cloud-Control-routed
          // resource in that position REFUSES instead. Same-region
          // reverts, which is every ordinary run, are unaffected.
          //
          // `recordedAttributes` (issue #4051): the identity evidence of
          // the record `stateResource.physicalId` came from.
          {
            desiredFromAwsReadback: true,
            // go-to-k/cdkd#4884: what the template declares, beside
            // the readback baseline.
            declaredEmptyProperties: declaredEmptyProperties(stateResource.properties),
            // go-to-k/cdkd#5707: which flags the template turns
            // on, so a feature it declares can be restored while
            // one only the readback holds stays as it is. With no
            // observed baseline the desired bag is built on `properties`,
            // so the set constrains only observed-baseline records.
            declaredTrueProperties: declaredTrueProperties(stateResource.properties),
            maskSecrets: createSecretMasker(secrets),
            expectedRegion: report.region,
            recordedAttributes: stateResource.attributes,
            recordedCreateOnlyDrops: stateResource.acceptedCreateOnlyDrops,
            // Issue #1160: nothing reads as REMOVED here, so no
            // provider `removalDefaults` value is injected. Removal is
            // judged template-vs-template, and the previous side above
            // is an AWS readback, never a template declaration.
            removedProperties: new Set<string>(),
          }
        ),
      outcome.logicalId,
      // Issue #1914: the retry logger echoes the failing call's AWS error
      // verbatim, and this call's payload now carries RESOLVED secrets —
      // an AWS validation error routinely quotes the offending property
      // value. Same fence `deploy-engine.ts` puts on its own provider
      // calls. No-op when the op resolved no secret.
      // `warn` is threaded too (issue #2018): without it the
      // give-up summary for an exhausted IAM-propagation retry is
      // dropped on THIS path only, so `cdkd drift --revert` would keep
      // the pre-fix behavior of rethrowing the raw AWS error with no
      // sign that cdkd had retried for ~48s. It goes through the SAME
      // mask as `debug` rather than straight to `logger.warn` -- the
      // summary interpolates the AWS message verbatim, so an unmasked
      // forward would defeat the #1914 fence at a HIGHER log level than
      // the one that fence was written for.
      //
      // The object itself now comes from `masking-retry-logger.ts` — this
      // was one of three byte-identical eager copies (issue #2038).
      { logger: maskingRetryLogger(logger, secrets) }
    );
    tally.totalSucceeded++;
    // go-to-k/cdkd#5380: AWS now holds the baseline, so what a
    // failed deploy left unsettled here is settled.
    // A key AWS is still changing stays (go-to-k/cdkd#5380).
    // Settled only on proof (go-to-k/cdkd#5487): AWS no longer
    // changing the name and holding the reverted value under
    // drift's comparator, as on the deploy side.
    const unsettledNames = unsettledPropertiesOf(stateResource);
    if (unsettledNames.size > 0) {
      const settled = await withUnprovenUnsettled(
        withoutUnsettledProperties(stateResource),
        {
          provider,
          logicalId: outcome.logicalId,
          physicalId: stateResource.physicalId,
          resourceType: outcome.resourceType,
          recordedProperties: stateResource.properties ?? {},
          names: unsettledNames,
          desired: newProperties,
          attemptedItems: unsettledItemsOf(stateResource),
        },
        (message) => logger.warn(maskSecretsInText(message, secrets))
      );
      if (unsettledPropertiesOf(settled).size < unsettledNames.size) {
        settledByRevert.set(outcome.logicalId, settled);
      }
    }
    // Issue #1819: the revert landed, but the provider may have left
    // something behind (a replacement whose old resource survives). The
    // revert still counts as succeeded — the resource IS at the desired
    // state — so this annotates the line rather than failing it; dropping
    // the reason would put `drift --revert` back where the deploy path
    // was before the channel existed.
    const revertPartial = updatePartialReason(updateResult);
    if (revertPartial !== undefined) {
      logger.warn(
        `  ✓ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted, ` +
          `${maskSecretsInText(updatePartialMessage(revertPartial), secrets)}`
      );
    } else {
      logger.info(
        `  ✓ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted.`
      );
    }
    // Issue #1644: keep whatever the provider says it ACTUALLY delivered,
    // so a narrowing does not re-surface as drift on the next run.
    //
    // AFTER the success accounting, and in its OWN try: the AWS update
    // has already landed, so a throw in here (a provider handing back a
    // cyclic / non-comparable bag) must not be caught by the outer
    // handler and re-reported as `AWS update failed`, flipping a
    // succeeded revert to exit 2.
    try {
      if (updateResult?.effectiveProperties) {
        const delta = collectNarrowedTopLevelKeys(newProperties, updateResult.effectiveProperties);
        if (Object.keys(delta).length > 0) {
          // Issue #1914: the delta is the provider's echo of a bag we
          // just resolved secrets INTO, and it is persisted below — so
          // this is a state-write surface, and fixing the revert without
          // it would have moved the disclosure rather than closed it.
          //
          // A reference cdkd never RESOLVED has no map entry, so the
          // provider's echo of AWS's value at its position cannot be
          // masked by value. That needs no mask (issue #2102): since
          // issue #2482 every CloudFormation service resolves, so what
          // AWS holds at a surviving token's span is ordinary data. A
          // MIXED leaf the payload kept LIVE was kept only because its
          // resolved halves equal what cdkd resolved
          // (`liveMatchesUnresolvedTokenFrame`), so the plaintext an
          // echo carries there is a map entry, and the source side's
          // mixed leaf is substituted over the echo by the readback
          // refusal below anyway.
          //
          // Positioned against `revertBaseline` — the SAME bag
          // `desiredProperties` was resolved from — and not against
          // `properties`, which is a different bag whenever an observed
          // capture exists.
          //
          // `STATE_SOURCED_READBACK_RULES`, NOT the `STATE_DERIVED_RULES`
          // that `redactRollbackRecord` uses on its own echo. Both grant
          // `trustAnyExpression`, which is right here for the same reason
          // it is right there: a persisted record holds no PUBLIC
          // expression, so any `{{resolve:...}}` leaf in the source is by
          // construction a secret. They differ on ARRAY descent, and the
          // rollback's justification for it does not carry over. There
          // the whole bag descends from resolving the journaled one, so
          // the two have identical structure; here `collectNarrowedTopLevelKeys`
          // derives the delta from `newProperties`, which is
          // `buildRevertNewProperties`'s merge of the AWS-CURRENT
          // snapshot with the resolved desired subtrees — so a top-level
          // key that did not drift comes from AWS and may be reordered.
          // BLIND positional descent over an equal-length,
          // differently-ordered array would write a sibling's expression
          // onto the wrong element: the #1904 wrong-reference class, on a
          // write path. Those leaves fall to the value scan instead,
          // which the `properties`-side map completion above keeps
          // complete.
          //
          // BLIND is load-bearing, and this paragraph used to omit it.
          // `descendArrays: false` refuses to pair by INDEX ALONE; it is
          // not a claim that cdkd never walks a readback array by index,
          // which has been false since the anchor pass for issue #2012.
          // This very constant selects that pass —
          // `isReadbackProjectedFromState` is exactly
          // `trustAnyExpression && !descendArrays && sourceIsSameGeneration`,
          // which `STATE_SOURCED_READBACK_RULES` satisfies — so the two
          // `redactSecretsForState` calls in this file that pass a SOURCE
          // (`--accept`'s new baseline and this one) run
          // `refuseUncertifiedReadbackPositions` after the path pass, and
          // its unkeyed-array arm DOES pair element i with element i.
          // What licenses that is `unkeyedArrayPairsByAnchors`: the index
          // counts match, every position whose SOURCE subtree carries no
          // dynamic reference is deep-equal on both sides, every
          // reference-bearing element carries a distinguishing anchor of
          // its own (or, being a bare reference leaf with no interior,
          // leans on the array's literal frame), and no two
          // reference-bearing elements share an order-insensitive anchor
          // signature. AWS's own unrewritten values are the evidence, so
          // the ORDER objection above is ANSWERED rather than assumed
          // away — a different argument from this flag's, not a
          // relaxation of it. Where the corroboration fails the array is
          // returned untouched BY THAT PASS and keeps whatever the path
          // pass left it, i.e. the value scan named above — with one
          // further qualifier, since `secrets` at this site is often
          // EMPTY (see the note below): on an empty map
          // `deriveReadbackNeedles` learns needles from the positions the
          // pass DID certify and `preferPositionDecisions` merges them
          // over the refused array, so "untouched" is true of the
          // position pass and not of the whole call. The sibling copies
          // of this rationale in `secret-redaction.ts` were corrected in
          // the #2012 lane; see `unkeyedArrayPairsByAnchors` for the two
          // measured shapes behind the last two conditions — a
          // `{Name:'db'} / {Name:''}` pair for the per-element evidence
          // rule, and `AWS::AmazonMQ::Broker.Users` for the pairwise
          // distinguishability one. Only the second is AmazonMQ.
          // (Until issue #2482 `preserveLiveValuesAtUnresolvedTokens`
          // was a second source, registering every live value it copied
          // in over an `ssm-secure` survivor; a survivor is no longer a
          // secret, so the value it copies needs no entry.) Since issue
          // #1944 the path pass DOES reach a KEY-IDENTIFIABLE array
          // element — an ECS `ContainerDefinitions[].Environment[]`, the
          // shape this advisory keeps landing in, is keyed by `Name` at
          // both levels — so the value scan is what covers the arrays
          // that carry no such key, which reach neither pass and would
          // land in `state.json` as plaintext without it.
          narrowedByLogicalId.set(
            outcome.logicalId,
            // Since issue #1926 this rules constant ALSO runs the
            // module's readback refusal, which substitutes a MIXED source
            // leaf (a reference embedded in surrounding text) over the
            // value this payload was about to persist. That is the right
            // default here for the same reason it is elsewhere — the
            // alternative is persisting a decrypted secret — but note
            // this site has no equivalent of the `--accept` arm's
            // post-write re-check above, so a leaf that a PUBLIC
            // reference reached through `cdkd import`'s warn path is
            // corrected silently rather than warned about -- UNLESS the
            // pass proved it public. `secrets` at this site stays empty
            // for a resource carrying no secret reference (the common
            // shape), so the populated-map decline does not apply; but it
            // is the SAME bag `resolveStateSecretExpressions` resolved the
            // baseline into, and the resolver files a per-bag proof for
            // each plain `ssm:` token whose parameter answered `String` /
            // `StringList` (issue #2036). A mixed leaf whose every token
            // is proven keeps the value AWS reported; any other still
            // takes the source expression.
            //
            // THE RULES CONSTANT FOLLOWS THE DESTINATION, as at the
            // `--accept` site (issue #2939 — the sibling question that
            // issue asked to be answered rather than assumed). A VALUE
            // from this delta is persisted ONLY into `observedProperties`
            // (the write loop below records a value against an observed
            // baseline and never into `properties`, which takes drops
            // alone), so wherever a redacted value lands it lands in a
            // drift baseline — the fail-closed constant's one
            // destination. The mask costs the same here as it does for
            // `cdkd import` / `refresh-observed`: a masked position
            // reports as drift, `--accept` refuses it and `--revert`
            // preserves the live value there, until a deploy rewrites the
            // baseline. The alternative at an uncertifiable position is
            // persisting the provider's echo of a DECRYPTED value. The
            // merge provenance of this bag (AWS-current non-drifted keys,
            // resolved desired subtrees) changes how OFTEN a position is
            // uncertifiable — a reordered echo of a non-drifted key —
            // never what a mask costs, and the refusal masks only where
            // the source spells a reference, so a reordered literal list
            // is untouched. On the `properties` arm the redacted values
            // are discarded by the loop below, so the non-failing
            // constant there changes nothing.
            keepBaselineAtUncertifiedPaths(
              redactForState(delta, {
                provenance:
                  stateResource.observedProperties !== undefined
                    ? 'state-baseline'
                    : 'state-readback',
                secrets: secrets,
                source: revertBaseline,
              }),
              [...outcome.uncertifiedPaths, ...(outcome.noEchoParameterPaths ?? [])],
              revertBaseline
            )
          );
        }
      }
    } catch (captureErr) {
      logger.warn(
        `  ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted, but ` +
          `the provider's reported effective properties could not be read — ` +
          `${maskSecretsInText(describeAwsFailure(captureErr).detail, secrets)}`
      );
    }
    // go-to-k/cdkd#4476: the record takes the identity `update()`
    // returned, as the rollback replay's does (go-to-k/cdkd#4434) — a
    // provider that re-creates on update (`SecurityGroupIngress`
    // revokes and re-authorizes, minting a new `sgr-` id) otherwise
    // leaves the record naming what it removed, which `cdkd export` and
    // a later `Fn::GetAtt` read. `recordAfterRollbackUpdate` owns the
    // merge (wholesale on `wasReplaced`, key-wise in place, untouched
    // when none is returned, and the replaced physical id). Only its
    // `physicalId` and `attributes` are taken: this command records a
    // narrowing per key above, never the `properties` bag wholesale.
    //
    // In its own try for the same reason as the capture above: AWS has
    // already been reverted.
    try {
      if (updateResult !== undefined) {
        // A `NoEcho` declaration becomes mask-only needles BEFORE the
        // redaction below, as the deploy engine and the rollback
        // replay register it, or a custom resource's masked `Data`
        // lands in `state.json` in the clear.
        const noEchoDeclared = recordNoEchoAttributeValues(updateResult, secrets, newProperties);
        const next = recordAfterRollbackUpdate(stateResource, updateResult);
        // The attributes alone are scrubbed, by value, with the
        // revert's resolved secrets — `scrubResourceRecord`'s
        // `attributes` arm. The rest of the record is the one state
        // already holds, redacted when it was written.
        const keptAttributes =
          next.attributes === undefined
            ? undefined
            : keepRecordedAttributesOverMask(
                redactForState(next.attributes, {
                  provenance: 'value-scan',
                  secrets: secrets,
                }),
                next.attributes,
                stateResource.attributes,
                noEchoDeclared
              );
        // go-to-k/cdkd#4043 (review LOW-7): an attribute the record
        // declares `NoEcho` (`noEchoAttributeNames`) is kept `***`
        // whatever its type or length, as the deploy's save keeps
        // it; the value scan above cannot key a number or a short
        // value.
        const declaredNames = noEchoAttributeNamesOf(stateResource) ?? [];
        const attributes =
          keptAttributes === undefined || declaredNames.length === 0
            ? keptAttributes
            : Object.fromEntries(
                Object.entries(keptAttributes).map(([name, value]) => [
                  name,
                  declaredNames.includes(name) ? maskWholeValue(value) : value,
                ])
              );
        if (
          next.physicalId !== stateResource.physicalId ||
          !sameRecordedJson(attributes, stateResource.attributes)
        ) {
          reRecordedByLogicalId.set(outcome.logicalId, {
            physicalId: next.physicalId,
            attributes,
          });
        }
      }
    } catch (recordErr) {
      logger.warn(
        safeMsg`  ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted, but the attributes the provider returned could not be recorded — ${maskSecretsInText(describeAwsFailure(recordErr).detail, secrets)}`
      );
    }
  } catch (err) {
    // Distinguish "the AWS update failed" from "this resource type
    // does not support in-place update at all". The latter cannot be
    // fixed by retrying; the user has to redeploy with --replace.
    if (err instanceof ResourceUpdateNotSupportedError) {
      tally.totalUnsupported++;
      logger.warn(
        `  ⊘ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): could not revert — ${maskSecretsInText(err.message, secrets)}`
      );
      return;
    }
    tally.totalFailed++;
    // Masked (issue #1914): this is the error from a call whose payload
    // carried resolved secrets, and AWS quotes the offending value.
    const msg = maskSecretsInText(describeAwsFailure(err).detail, secrets);
    logger.error(
      `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): AWS update failed — ${msg}`
    );
  }
}
