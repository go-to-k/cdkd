/**
 * `cdkd drift`: `--revert`: one drifted resource's revert payload.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import type { ConsoleLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { refusedBaselineRemedy } from '../refused-baseline-remedy.js';
import {
  type RecordedSecretValues,
  recordPhysicalNameCopy,
  maskSecretsInText,
  SECRET_MASK,
  spelledKeysOf,
  noEchoLeavesOf,
  isMarkedCoordinate,
} from '../../../deployment/secret-redaction.js';
import type { ResourceProvider } from '../../../types/resource.js';
import type { ResourceState } from '../../../types/state.js';
import type { StackDriftReport, DriftedOutcome } from './outcome.js';
import { resolveStateSecretExpressions, isDriftSecretRefusal } from './secret-resolution.js';
import { revertPathSegments } from './redaction.js';
import { otherPhysicalIds } from './baseline-keys.js';
import {
  collectUnresolvedIntrinsicObjectPaths,
  preserveLiveValuesAtUnresolvedTokens,
} from './revert-merge.js';
import {
  overlayLiveAtUncertifiedPaths,
  preserveLiveValuesAtMaskedLeaves,
} from './revert-live-values.js';
import { buildRevertNewProperties, driftAbsentMeansDefaultKeys } from './revert-payload.js';
import type { RevertTally, RevertDriftedOutcomeArgs } from './revert.js';
import { applyRevertUpdate } from './revert-apply.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';

/** What {@link applyRevertUpdate} reads from {@link revertDriftedOutcome}'s scope. */
export interface ApplyRevertUpdateArgs {
  logger: ConsoleLogger;
  tally: RevertTally;
  report: StackDriftReport;
  narrowedByLogicalId: Map<string, Record<string, unknown>>;
  reRecordedByLogicalId: Map<
    string,
    { physicalId: string; attributes: Record<string, unknown> | undefined }
  >;
  settledByRevert: Map<string, ResourceState>;
  outcome: DriftedOutcome;
  stateResource: ResourceState;
  provider: ResourceProvider;
  secrets: RecordedSecretValues;
  revertBaseline: Record<string, unknown>;
  newProperties: Record<string, unknown>;
}

/**
 * One drifted resource's revert, as {@link runRevert} schedules it under the
 * resource's printing bag: build the revert payload, then hand it to
 * {@link applyRevertUpdate}. A `return` ends this resource's task only.
 */
export async function revertDriftedOutcome(args: RevertDriftedOutcomeArgs): Promise<void> {
  const {
    logger,
    tally,
    report,
    scope,
    revertSecretResolvers,
    revertProducerRegions,
    narrowedByLogicalId,
    reRecordedByLogicalId,
    settledByRevert,
    outcome,
  } = args;
  const stateResource = report.state.resources[outcome.logicalId];
  if (!stateResource) {
    // Defensive: drift detection saw the resource in state earlier,
    // but if something racey happened between read and now treat it
    // as a per-resource failure rather than aborting the whole run.
    tally.totalFailed++;
    logger.error(
      `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
        `resource missing from state; skipped.`
    );
    return;
  }
  // Schema v10+ (issue #2944), and the most consequential of the three
  // refused-baseline sites because this one writes to AWS rather than to
  // `state.json`. A marked record has no `observedProperties`, so
  // `revertBaseline` below falls to `properties` — which after an import
  // refusal can hold the WRONG-BRANCH LITERAL the refusal distrusted
  // (`dev-placeholder` where AWS holds the secret the deployed branch
  // resolved). Reverting would push that literal OVER the live secret.
  //
  // "A marked record has no baseline" is the COMMON shape, not an
  // invariant: an import refusal now DROPS a baseline a selective merge
  // preserved (issue #2872), but a record an older cdkd refused can
  // still carry both. The refusal is right either way -- the marker
  // says this record's `properties` are untrustworthy, and a preserved
  // baseline beside them was captured by the run that already could not
  // vouch for them.
  //
  // Issue #2855 closed the neighbouring shape — an unresolved intrinsic
  // OBJECT in the same raw bag — and its guard cannot see this one: a
  // wrong-branch literal is an ordinary STRING, indistinguishable from a
  // value the user really deployed, which is the same reason no in-walk
  // remedy exists for the read side. The marker is the only evidence, and
  // this command has no template of its own to re-derive it from.
  //
  //
  // SECOND LAYER since issue #2952. Detection now reports a marked record
  // `notCompared`, so it never becomes `drifted` and never reaches this
  // loop — this arm is unreachable BY CONSTRUCTION today. It is kept
  // rather than deleted because a write path to AWS (and to `state.json`)
  // should not depend on a detection decision staying where it is, and
  // the cost of keeping it is one branch. What fences it is the detection
  // case in `drift.test.ts`: if the gate there is removed, that case reds
  // and this arm starts carrying the refusal again.
  // Counted `totalUnresolvable` rather than `totalFailed`, matching the
  // mask and intrinsic-object refusals: nothing was attempted at AWS.
  if (stateResource.observedBaselineRefused === true) {
    tally.totalUnresolvable++;
    logger.warn(
      `  ! ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
        `NOT reverted — a 'cdkd import' run refused to capture this resource's ` +
        `observed-properties baseline, so the only baseline available is its recorded ` +
        `properties, which the refusal already found untrustworthy. Reverting from them ` +
        `could overwrite a live value (a resolved secret among them) with a placeholder ` +
        `the deployed stack never used. ` +
        safeMsg`${
          refusedBaselineRemedy(stateResource) ??
          'Deploy a change to this resource to restore a baseline first.'
        }`
    );
    return;
  }
  // Schema v7+ (#614): route the revert update through the
  // state-recorded layer so a CC-managed resource is reverted via
  // Cloud Control.
  //
  // NOT guarded, deliberately (issue #1914 review): a registry lookup
  // that throws here cannot happen, because DETECTION performs the same
  // lookup with the same inputs and routes a failure to an `unsupported`
  // outcome — such a resource never becomes `drifted` and never reaches
  // this loop. A catch here would be an arm no mutation can red, which is
  // worse than none. The payload build below IS guarded, because that one
  // is reachable: `readCurrentState` is provider-authored and its output
  // is not vetted.
  const provider: ResourceProvider = scope.registry.getProviderFor({
    resourceType: outcome.resourceType,
    provisionedBy: stateResource.provisionedBy,
  }).provider;
  // The baseline drift was computed against — `observedProperties`
  // when present, else `properties` — is the right "desired" value
  // to push back to AWS. Using `properties` alone would push the
  // last-deployed template intent and miss any AWS-side defaults
  // we captured at deploy time but never wrote into the template.
  //
  // Issue #1914: RE-RESOLVED before it is handed to the provider. State
  // stores a secret dynamic reference as its unresolved
  // `{{resolve:...}}` expression (GHSA-p5qg-v9gv-hc7w), so the bag as
  // read is not something AWS can be given — pushing it back set the
  // live property to the literal token, corrupting whatever consumes it
  // (a Lambda env var, a Cognito `client_secret`). This is the rollback
  // replay's `resolveReplayProps` on the second synth-free write path.
  // A bag with no dynamic reference resolves to itself by identity.
  const secrets: RecordedSecretValues = new Map();
  // go-to-k/cdkd#4810: the revert's attribute scan keeps a
  // reader's copy of a physical id, as the deploy's save does.
  for (const id of otherPhysicalIds(report.state.resources, outcome.logicalId)) {
    recordPhysicalNameCopy(secrets, id);
  }
  const revertBaseline = stateResource.observedProperties ?? stateResource.properties ?? {};
  // No `secretPaths` here, deliberately: nothing on this path masks by
  // position. What a revert PRINTS comes from `outcome.changes`, redacted
  // once at detection, and what it WRITES is redacted by value + position
  // against `revertBaseline` below.
  const unresolvedTokens = new Set<string>();
  const noteUnresolved = (tokens: string[]): void => {
    for (const token of tokens) unresolvedTokens.add(token);
  };
  let desiredProperties: Record<string, unknown>;
  try {
    desiredProperties = await resolveStateSecretExpressions(
      revertBaseline,
      revertSecretResolvers,
      secrets,
      {
        onUnresolved: noteUnresolved,
        logicalId: outcome.logicalId,
        consumerRegion: report.region,
        record: stateResource,
        producerRegions: revertProducerRegions,
      }
    );
    // Mirrors the detection pass: `properties` are resolved into the same
    // map so a secret the OBSERVED baseline never captured is still a key
    // in it. Revert needs that for the narrowing write below, whose
    // position source can only reach leaves the two bags share.
    if (stateResource.observedProperties !== undefined) {
      await resolveStateSecretExpressions(
        stateResource.properties ?? {},
        revertSecretResolvers,
        secrets,
        {
          onUnresolved: noteUnresolved,
          logicalId: outcome.logicalId,
          consumerRegion: report.region,
          record: stateResource,
          producerRegions: revertProducerRegions,
        }
      );
    }
  } catch (err) {
    // Reported per-resource rather than aborting the run, and with its
    // OWN message: 'AWS update failed' would be a lie — no update was
    // attempted, the reference the state record names could not be read.
    //
    // Same split as the detection site (issue #2108): a region refusal is
    // a decision, not a read failure, and calling it one sends the reader
    // looking for an IAM problem that is not there.
    tally.totalUnresolvable++;
    logger.error(
      `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
        (isDriftSecretRefusal(err)
          ? `refused to re-resolve a dynamic reference this resource's state records — `
          : `could not re-resolve the dynamic reference(s) this resource's state records — `) +
        `${maskSecretsInText(describeAwsFailure(err).detail, secrets)}`
    );
    return;
  }
  // Issue #1914 (minor): `buildRevertNewProperties` keys the overlay on
  // each change's TOP-LEVEL segment, so a path whose first segment is
  // itself the mask matches nothing in the desired bag and the subtree is
  // silently not reverted — while the plan promised it and `--accept`'s
  // refusal pointed the user here. Say it instead.
  const unrevertablePaths = outcome.changes
    .map((c) => c.path)
    .filter((path) => (path.split('.', 1)[0] ?? '').includes(SECRET_MASK));
  // Issue #2855: an unresolved intrinsic OBJECT (`{Fn::Join: ...}`,
  // `{Ref: ...}`) in the send bag must never reach `provider.update`.
  // Measured on both routes (see the helper's doc): no provider fails
  // loudly — the SDK route puts the raw object into the wire call and
  // the Cloud Control route serializes it into the patch, where a
  // JSON-string property makes it schema-valid, i.e. silently
  // accepted.
  //
  // Three scopings, each load-bearing:
  //
  // - GATED on `observedProperties === undefined` — the #2855
  //   population by provenance (PR #2912 review). Intrinsic OBJECTS
  //   reach a revert baseline only through the raw-`properties`
  //   fallback (`cdkd import`'s warn path writes them there; #2842's
  //   refusal is what routes the revert to that bag). An
  //   `observedProperties` baseline is READBACK-derived — cdkd never
  //   writes an intrinsic object into it — so there a single-key map
  //   literally named `Ref` / `Fn::*` is a real AWS value (a Lambda
  //   env var, a config map), and refusing on it would pin the
  //   resource unrevertable FOREVER, the prescribed remedy re-recording
  //   the same readback on every deploy. Stated residual (PR #2912
  //   round 2): a HAND-EDITED `observedProperties` carrying a genuine
  //   intrinsic ships silently under this gate — outside cdkd's write
  //   contract (no cdkd writer puts an intrinsic object there), and
  //   accepted as the cost of not pinning the readback population.
  // - Scoped to the DRIFTED top-level keys, the only ones the baseline
  //   sources into the send bag.
  // - Reading `desiredProperties` — the BASELINE — rather than the
  //   overlay output (PR #2912 review): `mergeUntemplatedValue`'s
  //   key-merge FUSES a single-key intrinsic with a plain-record live
  //   value (`{Ref:'X'}` against live `{A:1}` becomes
  //   `{A:1, Ref:'X'}`) — multi-key, invisible to the single-key
  //   predicate in the merged bag. The baseline scan has no such
  //   dilution and no over-refusal: every overlay arm re-emits every
  //   baseline path into the send bag (wholesale, key-merge, and both
  //   tag-list merges), so a flagged leaf always reaches
  //   `provider.update` in some shape.
  //
  // Positioned BEFORE the warnings below as well as before the
  // preserve passes: a refused resource must not first be promised
  // "left UNCHANGED by this revert" by the token warning (nothing is
  // written at all), and no side effect (a registered mask-only
  // needle) may outlive the refusal.
  if (stateResource.observedProperties === undefined) {
    const driftedTopLevelKeys = new Set<string>();
    for (const change of outcome.changes) {
      const topLevelKey = change.path.split('.', 1)[0];
      if (topLevelKey) driftedTopLevelKeys.add(topLevelKey);
    }
    const intrinsicObjectPaths = collectUnresolvedIntrinsicObjectPaths(
      desiredProperties,
      driftedTopLevelKeys
    );
    if (intrinsicObjectPaths.length > 0) {
      // `totalUnresolvable` rather than `totalFailed`, like the mask
      // refusal below: no AWS call was attempted, and the cause is a
      // value cdkd cannot produce — not an update that failed.
      //
      // The paths are property KEYS from the baseline, and a key can
      // carry a secret (the same fact that makes `redactDriftChanges`
      // mask `change.path`), so they go through `maskSecretsInText`
      // like every other reader on this path.
      tally.totalUnresolvable++;
      logger.error(
        `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
          `refused to revert ` +
          `${maskSecretsInText(intrinsicObjectPaths.join(', '), secrets)} — the recorded ` +
          `baseline holds an unresolved CloudFormation intrinsic there (e.g. Fn::Join, ` +
          `Ref), which cdkd cannot resolve outside a deploy; writing it would set the ` +
          `live property to the raw intrinsic object instead of its value. Run ` +
          `'cdkd deploy' for this stack — the deploy resolves the template and records ` +
          `a resolvable baseline — then re-run the revert if drift remains.`
      );
      return;
    }
  }
  if (unrevertablePaths.length > 0) {
    logger.warn(
      `  ! ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): cannot ` +
        `revert ${maskSecretsInText(unrevertablePaths.join(', '), secrets)} — cdkd cannot ` +
        `name the property, so it is left as AWS has it. ROTATE the secret that leaked ` +
        `into the property name.`
    );
  }
  if (unresolvedTokens.size > 0) {
    // A warning, not a failure — failing would abandon every OTHER
    // drifted property on the resource and exit 2. The wording claims
    // neither that replaying the token is a no-op (true only for a record
    // cdkd deployed, false where the position was adopted from elsewhere
    // or edited out of band) NOR that the live value is
    // always preserved: `preserveLiveValuesAtUnresolvedTokens` preserves
    // it only where the position can be paired against the readback
    // (issue #2893 — a list element by identity field or its list's
    // corroborated frame) AND, for a token embedded in a longer string,
    // the rest of that string equals AWS's (issue #2102), and declines
    // otherwise.
    logger.warn(
      // Deliberately worded so it cannot be confused with the
      // DETECTION-side warning, which names the same tokens: a test that
      // greps for the token alone is satisfied by either, so the two
      // messages must differ in more than punctuation.
      `  ! [revert] ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
        `cdkd cannot resolve ` +
        `${maskSecretsInText([...unresolvedTokens].join(', '), secrets)} — a property ` +
        `whose WHOLE value is one of these tokens is left UNCHANGED by this revert when ` +
        `cdkd can pair its position against AWS's report (a list element by an identity ` +
        `field, or by its list's own unchanged literal values); a token EMBEDDED in a ` +
        `longer string is left unchanged the same way when the rest of that string is ` +
        `exactly what AWS holds. Where it cannot pair or match, the token is written ` +
        `literally, exactly as 'cdkd deploy' does, so a resolved value AWS holds there ` +
        `is overwritten.`
    );
  }
  // AWS-current values for non-drifted top-level keys + desired
  // values for drifted top-level subtrees. See
  // `buildRevertNewProperties` docstring for why we don't pass a
  // drifted-only partial.
  //
  // Issue #1626 items 2 + 3: with NO observed-capture baseline the
  // desired side is the raw TEMPLATE, so a path AWS reports and the
  // template never declared is indistinguishable from one AWS authored
  // itself. Merge those paths into the bag being SENT rather than
  // overlaying the drifted subtree wholesale — a wholesale-replace
  // provider (`PutBucketTagging` and every `Put*Configuration`) never
  // consults the previous side, so this is the only side that can save
  // them. With observed-capture present the baseline IS authoritative
  // and the overlay is unchanged, so an out-of-band addition is still
  // stripped. See `mergeUntemplatedValue`.
  let newProperties: Record<string, unknown>;
  try {
    // Issue #3573: the desired bag IS the recorded baseline, so it gets
    // the same pair pass detection compared through, against the raw
    // readback the overlay takes as its previous side. A legacy record
    // missing a member the readback now carries is completed from that
    // readback; sent without it, `update()` would read the member as
    // REMOVED. Identity for a provider without the hook.
    if (provider.canonicalizeDriftPair) {
      desiredProperties = (
        await provider.canonicalizeDriftPair(
          outcome.resourceType,
          desiredProperties,
          outcome.awsProperties,
          stateResource.properties ?? {}
        )
      ).baseline;
    }
    const overlaid = buildRevertNewProperties(
      outcome.changes,
      desiredProperties,
      outcome.awsProperties,
      stateResource.observedProperties === undefined
        ? { preserveUntemplated: true }
        : {
            // go-to-k/cdkd#5399: the keys detection compared while
            // the observed baseline lacked them.
            absentMeansDefault: driftAbsentMeansDefaultKeys(
              provider,
              outcome.resourceType,
              stateResource.properties
            ),
          }
    );
    // Issue #3595: nothing is reverted at an uncertified-baseline
    // position — AWS's own value goes back — and this runs FIRST, so the
    // mask walk below never meets those masks. Identity when there are
    // none.
    const certifiedOverlay = overlayLiveAtUncertifiedPaths(
      overlaid,
      // go-to-k/cdkd#4043: a `NoEcho` parameter's marked position
      // likewise sends AWS's own value back, never the mask.
      [...outcome.uncertifiedPaths, ...(outcome.noEchoParameterPaths ?? [])],
      outcome.awsProperties,
      desiredProperties,
      secrets,
      new Set(outcome.changes.map((change) => change.path.split('.', 1)[0] ?? '')),
      spelledKeysOf(stateResource.properties ?? {})
    );
    // Issue #1914: a token cdkd could not resolve must never be WRITTEN
    // over whatever AWS holds — see the helper for why the "it is already
    // there" premise holds only for a record cdkd deployed. Skipped
    // entirely when nothing survived, so the ordinary revert is
    // byte-identical.
    const tokenPreserved =
      unresolvedTokens.size > 0
        ? preserveLiveValuesAtUnresolvedTokens(
            certifiedOverlay,
            outcome.awsProperties,
            unresolvedTokens,
            secrets
          )
        : certifiedOverlay;
    // Issue #2274: a REDACTION MASK in the baseline must never be written
    // to AWS either. Run UNCONDITIONALLY, unlike the token pass above:
    // this hazard is decided by the send bag alone, and `unresolvedTokens`
    // says nothing about it. The helper returns its input by identity when
    // there is no mask, so an ordinary revert is unaffected.
    //
    // `certifiedOverlay` — the post-#3595-overlay, PRE-token bag — is the
    // corroboration source. The live values that overlay copied in do not
    // reopen the hole below: they sit only at paths `equalModuloMask`
    // certified at detection, each replaced WHOLE, so no mask survives
    // beneath one for the walk to pair against it. The PRE-token bag, and
    // passing `tokenPreserved` there instead re-opens the round-4 #2884
    // hole: the token pass copies live values in (by certified pairing
    // since issue #2893, by index before it — the distinction does not
    // matter here), so the post-token bag corroborates (and
    // identity-pairs) leaves against the very `live` they were copied
    // from. See the parameter's doc on `preserveLiveValuesAtMaskedLeaves`.
    const maskPreserved = preserveLiveValuesAtMaskedLeaves(
      tokenPreserved,
      outcome.awsProperties,
      secrets,
      certifiedOverlay,
      spelledKeysOf(stateResource.properties ?? {})
    );
    if (maskPreserved.unpreservablePaths.length > 0) {
      // REFUSE the resource rather than send the mask. `totalUnresolvable`
      // rather than `totalFailed`, and the message is worded like the
      // re-resolution refusal one arm down for the same reason: no AWS
      // call was attempted, and the cause is a value cdkd cannot name —
      // not an update that failed.
      //
      // The message names all THREE writers of a mask (issue #2881),
      // because nothing in the record says which one wrote it (issue
      // #2449's absent per-attribute flag):
      //
      // - a `NoEcho` custom-resource value (issue #2274), the only
      //   writer when the message named it as THE cause;
      // - the `Fn::Base64` encoding of a secret, which `resolveBase64`
      //   registers as a mask-only needle (issues #2759 / #3119). No
      //   custom resource is involved, so the nonce remedy does nothing;
      // - a readback position the #2852 fail-closed walk could not
      //   certify.
      //
      // The remedies differ by cause. A deploy that UPDATES this
      // resource sends a Base64 encoding again (the recorded `***`
      // differs from the resolved encoding, so the update carries it),
      // which gives the next revert a live value to keep. For an
      // uncertified position it need not send anything there — a
      // normalised neighbouring literal equals `properties`, so an
      // update patch omits it — and what it does is re-capture the
      // baseline. A no-change deploy does neither: it runs no update,
      // and its re-capture (`masked-baseline-recapture.ts`) refuses a
      // resource that no longer reads back as its baseline, which one
      // reaching this arm does not. None of the three clears the MASK
      // for a NoEcho or Base64 value (see `acceptRefusalReason`), which
      // is why the last sentence speaks of this refusal, not the mask.
      // The first two write the mask into `properties` as well, so the
      // sibling refusals reach that population too: `export.ts`'s
      // blocker, `rollback-executor/replay-props.ts`'s `refuseMaskedReplayBaseline`
      // and `deploy-engine/masking.ts`'s `refuseRedactedAttributeReads`
      // name the `Fn::Base64` writer with a remedy of their own (issue
      // #2881).
      tally.totalUnresolvable++;
      // go-to-k/cdkd#4043 (schema v11): when the record's
      // `noEchoLeaves` names every refused position, the cause IS
      // known — a `NoEcho` template parameter — and only its
      // remedy applies.
      const marked = noEchoLeavesOf(stateResource);
      if (
        marked !== undefined &&
        maskPreserved.unpreservablePaths.every((path) =>
          isMarkedCoordinate(revertPathSegments(path), marked)
        )
      ) {
        const refusedPaths = maskSecretsInText(
          maskPreserved.unpreservablePaths.join(', '),
          secrets
        );
        logger.error(
          safeMsg`  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): refused to revert ${refusedPaths} — a NoEcho template parameter feeds it, the recorded baseline holds only the redaction mask there, and AWS reports nothing to preserve, so cdkd has no value it may write. Deploy the stack with the parameter's value to set it.`
        );
        return;
      }
      const markedRefused =
        marked === undefined
          ? []
          : maskPreserved.unpreservablePaths.filter((path) =>
              isMarkedCoordinate(revertPathSegments(path), marked)
            );
      const markedAmong = markedRefused.length > 0;
      const markedPaths = maskSecretsInText(markedRefused.join(', '), secrets);
      logger.error(
        `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
          `refused to revert ` +
          `${maskSecretsInText(maskPreserved.unpreservablePaths.join(', '), secrets)} — the recorded ` +
          `baseline holds only the redaction mask there, and AWS reports nothing to ` +
          `preserve, so cdkd has no value it may write. ` +
          `${markedAmong ? `Where a NoEcho template parameter feeds a path (${markedPaths}), deploy the stack with the parameter's value to set it. For the other paths, four` : 'Four'} causes leave such a mask, and ` +
          `the record does not say which: a NoEcho custom-resource value (force that ` +
          `custom resource to update — change one of its properties, e.g. a nonce — and ` +
          `re-deploy, so its handler runs again and supplies the value); the Fn::Base64 ` +
          `encoding of a secret value, which cdkd never records (deploy a change to this ` +
          `resource, which sends it the encoded value again); two secret values that ` +
          `overlap inside the value, which no single reference renders (change the ` +
          `property, or rotate one of the secrets, so that they no longer overlap, and ` +
          `deploy that change); or a readback position cdkd ` +
          `could not certify when the baseline was captured (deploy a change to this ` +
          `resource, so its baseline is re-captured). A re-deploy that leaves this resource ` +
          `unchanged sends it nothing, so it resolves this refusal for none of them.`
      );
      return;
    }
    newProperties = maskPreserved.properties;
  } catch (err) {
    // Reachability note (issue #1914 review): this arm is narrower than
    // it looks, and is kept only because it is cheap. A bag so malformed
    // that `buildRevertNewProperties` cannot walk it — a self-referential
    // `readCurrentState` result, say — throws in DETECTION first, where
    // `calculateResourceDrift` walks the same bags, so the resource never
    // reaches this loop. What is left for it to catch is a provider whose
    // output the comparator tolerates and the merge does not. The
    // detection-side equivalent is NOT per-resource and aborts the run;
    // that is pre-existing and out of scope here.
    tally.totalFailed++;
    logger.error(
      `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
        `could not build the revert payload — ` +
        `${maskSecretsInText(describeAwsFailure(err).detail, secrets)}`
    );
    return;
  }
  // go-to-k/cdkd#5848: the RESOLVED bag is a printing bag for the whole
  // update — the unsettled-previous settle, every `provider.update` attempt
  // and `withUnprovenUnsettled` — so a provider's own log line that skips
  // `context.maskSecrets` is masked by the sink, as on a deploy. Stacked on
  // the secret-NAME bag `revert.ts` binds (#3869). NOT
  // `withCurrentResourceSecrets`: two providers read that store's absence as
  // "this is drift --revert".
  await withPrintingSecrets(secrets, () =>
    applyRevertUpdate({
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
    })
  );
}
