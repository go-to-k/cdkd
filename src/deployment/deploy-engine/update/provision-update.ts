import { type DeployEngine } from '../../deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from '../../deploy-engine.js';
import { recreateDirectionFor } from '../routing.js';
import { refuseRedactedAttributeReads } from '../masking.js';
import {
  findActionableSdkUnwired,
  findHandledUnwrittenCreateOnly,
  unwrittenCreateOnlyReplacement,
} from '../../../provisioning/property-coverage.js';
import {
  STATE_RESOURCES_MALFORMED,
  hasAddressablePhysicalId,
  unaddressableUpdateRefusalMessage,
} from '../../../state/malformed-resources-bag.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { CHANGED_PROPERTIES_CONSUMER_TYPES } from '../../../provisioning/changed-properties-consumers.js';
import { markNonRetryable } from '../../retryable-errors.js';
import { markRefusedBeforeApplying } from '../../prior-attempt-scope.js';
import { recordedProtectionEvidence } from '../../../provisioning/recorded-protection.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import {
  type PropertyChange,
  type ResourceChange,
  type ResourceState,
} from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  type FreshNoEchoCeilingVerdict,
  isReplacementCeiling,
  keyOrderFreeJson,
  liveHoldsFreshLeaves,
} from '../../deploy-value-equality.js';
import { noEchoLeavesOf, valueAtCoordinate } from '../../secret-redaction.js';
import { withRefreshedReadVersions } from '../read-provenance-moved.js';
import { approveLateReplacement } from '../../deployment-approval.js';
import { findDestructiveChanges } from '../../../analyzer/destructive-changes.js';
import { STACK_UNDER_OTHER_PREFIX } from '../../../state/cross-prefix-stack-scan.js';
import { setAtCoordinate } from './helpers.js';
import { resolveUpdateInputs } from './resolve-inputs.js';
import { compareWithRecord } from './compare-record.js';
import { finishUpdate } from './finish.js';
import { unwrittenCreateOnlyRefusal } from './refusal-text.js';
import { macWriteOnlyKeys, noEchoMacVerdicts } from './noecho-macs.js';
import { keptNoEchoMacSink } from '../noecho-macs.js';

/** The `UPDATE` arm of `provisionResourceBody` (`deployment/deploy-engine/provision.ts`, #4200 phase 3a). */
export async function provisionUpdate(
  engine: DeployEngine,
  logicalId: string,
  change: ResourceChange,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  template?: CloudFormationTemplate,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>,
  counts?: ProvisionCounts,
  progress?: { current: number; total: number }
): Promise<ResourceOutcomeSignal | void> {
  const resolved = await resolveUpdateInputs(
    engine,
    logicalId,
    change,
    stateResources,
    stackName,
    template,
    parameterValues,
    conditions
  );
  const {
    resourceType,
    renderer,
    currentResource,
    oldResourceType,
    typeChanged,
    currentProps,
    context,
    updateSecrets,
    resolvedProps,
    lostChild,
    lostWithParent,
    staleCoordinates,
    desiredProps,
    noEchoSources,
    parameterCoordinates,
  } = resolved;
  const compared = await compareWithRecord(
    engine,
    logicalId,
    change,
    stateResources,
    template,
    counts,
    progress,
    resolved
  );
  const {
    desiredForSkipCheck,
    desiredForSkipCheckAsWritten,
    allowedForRecord,
    createOnlyEvidence,
    witness,
    currentPropsAsWritten,
    witnessMigrates,
    otherFreshAt,
    pendingParameterLeaves,
    warnWitnessReplacement,
    suppliesFreshMaskOnlyValue,
    provenanceUnchanged,
    recordMatchesDesired,
    unsettledNames,
    movedAsWritten,
    applyAttributeOnlyUpdate,
    schemaCreateOnly,
    echoCandidates,
    readOnce,
    provenChangedAt,
  } = compared;
  // A replacement the readback proves is decided here, after
  // `--require-approval` asked about the diff, which could not read AWS and
  // showed none. So it is asked about now (`approveLateReplacement`), ONCE for
  // the resource, whichever of its paths proved it: one answer replaces the
  // resource or keeps it. A kept one warns why; the rest of the deploy goes on.
  // A resource another path replaces anyway (a create-only template edit, a
  // `--recreate-via-*` target), the up-front prompt already asked about: it is
  // replaced without a second question, and nothing says it is kept.
  // go-to-k/cdkd#4705: the plan-time cross-prefix check never saw this
  // replacement either, so it is asked first (`stage` 'late'). Its refusal
  // (another prefix records the stack, or the check failed) is warned in full
  // and keeps the resource, as a "no" does, but counts as unaddressed
  // (`crossPrefixKept`): the deploy exits 2 unless --allow-unaddressed. A 403
  // warns and proceeds.
  let replacedAnyway = false;
  let lateApproval: Promise<boolean> | undefined;
  let lateCrossPrefixRefused = false;
  const approveReplacementOf = (pc: PropertyChange): Promise<boolean> => {
    if (replacedAnyway) return Promise.resolve(true);
    const { noEchoPromoted: _promoted, ...asReplacement } = pc;
    const asChange: ResourceChange = {
      ...change,
      changeType: 'UPDATE',
      propertyChanges: [{ ...asReplacement, requiresReplacement: true }],
    };
    lateApproval ??= (async () => {
      const crossPrefixGate = engine.options.onDestructivePlan;
      if (crossPrefixGate !== undefined) {
        try {
          await crossPrefixGate(
            stackName,
            findDestructiveChanges(stackName, [asChange], stateResources, template),
            'late'
          );
        } catch (error) {
          if (!(error instanceof CdkdError) || error.code !== STACK_UNDER_OTHER_PREFIX) throw error;
          lateCrossPrefixRefused = true;
          if (counts) counts.crossPrefixKept = (counts.crossPrefixKept ?? 0) + 1;
          engine.logger.warn(error.message);
          return false;
        }
      }
      return approveLateReplacement({
        options: engine.options,
        stackName,
        change: asChange,
        records: stateResources,
        template,
        // go-to-k/cdkd#4705: the prompt may have waited, as the up-front one.
        onAsked: () => engine.generatedNameGuard?.noteApprovalPrompted(),
      });
    })();
    return lateApproval;
  };
  const lateReplacementDeclined = new Set<string>();
  // Why a `differs` on such a path is not acted on: the warning names it.
  const differsWhy = (key: string): string =>
    !lateReplacementDeclined.has(key)
      ? 'differs; the provider is not known to report this property exactly, so the difference may be its normalization'
      : lateCrossPrefixRefused
        ? 'differs; the replacement was refused: see the state-prefix warning above'
        : `differs; the replacement was not approved (--require-approval=${engine.options.requireApproval ?? 'never'})`;
  // go-to-k/cdkd#4656: the MIGRATION deploy (`witnessMigrates`) takes the
  // echo-fidelity readback even when its witness settles every value (so no
  // block below would read), before the skip just below can return.
  if (
    witnessMigrates &&
    !typeChanged &&
    echoCandidates.length > 0 &&
    hasAddressablePhysicalId(currentResource)
  ) {
    await readOnce();
  }
  // What both no-change skips below require. go-to-k/cdkd#6282: a nested-stack
  // row updated for its child's engine to run is never skipped.
  const mayTakeNoChangeSkip =
    !typeChanged &&
    lostChild === undefined &&
    change.nestedChildHeal !== true &&
    recreateDirectionFor(engine.options, stackName, logicalId) === undefined &&
    recordMatchesDesired &&
    unsettledNames.size === 0;
  if (mayTakeNoChangeSkip && !suppliesFreshMaskOnlyValue) {
    // go-to-k/cdkd#4852: a reader whose read versions moved with an equal
    // value now records the versions it was served (the save persists it).
    if (provenanceUnchanged.length > 0) {
      stateResources[logicalId] = withRefreshedReadVersions(
        stateResources[logicalId] ?? currentResource,
        provenanceUnchanged
      );
    }
    // Attribute-only change (schema v5+): `DeletionPolicy` /
    // `UpdateReplacePolicy` may have flipped without any AWS-side
    // property change. There is no per-resource AWS API for those —
    // refresh cdkd state alone and skip the provider call.
    if (change.attributeChanges && change.attributeChanges.length > 0) {
      applyAttributeOnlyUpdate(change.attributeChanges);
      return;
    }
    engine.logger.debug(
      safeMsg`Skipping ${logicalId}: no actual changes after intrinsic function resolution`
    );
    if (counts) counts.skipped++;
    return;
  }

  // Issue #2274: the UPDATE twin of the CREATE arm's refusal — same
  // reason, and needed on BOTH because an existing dependent whose OTHER
  // properties changed is the commonest way to reach a redacted read.
  //
  // AFTER the no-change skip, not before it (go-to-k/cdkd#3662). The
  // refusal exists so the literal `***` is never SENT; a skip sends
  // nothing and leaves the record as it was. Refusing first failed a
  // deploy over a dependent the diff promoted only speculatively (a
  // reader of a nested stack's `Outputs.<Key>`, issue #3631) whose
  // resolved bag, masked read included, equals its record. A redacted
  // read resolves to the literal mask, so it passes the skip only where
  // the record holds the mask at that same position and nothing else
  // moved, which is exactly the case with nothing to send.
  refuseRedactedAttributeReads(logicalId, resourceType, context);

  // go-to-k/cdkd#3211: a record with no usable physical id cannot be
  // ADDRESSED, and every arm below hands it to a provider (the in-place
  // update, the replacement's delete of the old resource, the NoEcho
  // readback). Below the no-change skip, which sends nothing, and above the
  // first of them. Refused rather than skipped, unlike the DELETE arm: a
  // skip would end the deploy without the template's change. The RECORD's
  // type decides the nested-stack exemption, as in `cdkd destroy`: that
  // provider finds its child by name and never addresses AWS by the id. Not a
  // record on Cloud Control, which does.
  if (
    !(
      currentResource.resourceType === 'AWS::CloudFormation::Stack' &&
      currentResource.provisionedBy !== 'cc-api'
    ) &&
    !hasAddressablePhysicalId(currentResource)
  ) {
    throw markRefusedBeforeApplying(
      markNonRetryable(
        new CdkdError(
          unaddressableUpdateRefusalMessage(
            stackName,
            engine.stackRegion,
            logicalId,
            oldResourceType,
            engine.options.refusalRecovery
          ),
          STATE_RESOURCES_MALFORMED
        )
      )
    );
  }

  // #1198: snapshot the attempted (resolved) properties so a failed
  // UPDATE can be journaled with what it tried to apply (load-bearing
  // for the --revert-failed patch generation). Below the refusal, as it
  // was before the refusal moved: a refused UPDATE attempted nothing.
  engine.attemptedResolvedProps.set(logicalId, resolvedProps);

  // A synthetic change's `requiresReplacement` is a CEILING
  // (go-to-k/cdkd#3662): the diff promoted this reader because an
  // attribute it reads MAY move (`inPlacePropagated`, e.g. a custom
  // resource's `Data`, a nested stack's outputs) or because a resource it
  // references was to be replaced (`replacementPropagated`), and a
  // create-only reading property then asked for a replacement whatever
  // the value turned out to be. The skip above only covers a reader with
  // NOTHING else moving; once another property changes, an unmoved value
  // would have destroyed and re-created the resource. The resolved value
  // is in hand now, so a path whose redacted value equals the record is
  // lowered to an in-place change.
  //
  // A path carrying a `NoEcho` value supplied in this deploy needs a
  // second witness (go-to-k/cdkd#3729). Its record holds `***`, and the
  // mask identifies nothing, so equal redacted values say only that the
  // OTHER leaves did not move. The resource is read back from AWS (once,
  // however many such paths it has), and the ceiling is lowered only when
  // AWS holds exactly this value at every fresh position. Nothing
  // derived from the value is stored, so there is nothing in state to
  // guess against. Every case the readback cannot confirm keeps the
  // replacement: no readback for the type, a write-only property, a
  // failed or slow read, or a different value.
  //
  // The same witness answers one change that is NOT a ceiling: a
  // create-only path the diff called changed only because it compared a
  // fresh `NoEcho` plaintext with the recorded `***`. A consumer's
  // `Fn::ImportValue` of a masked output this process recovered is that
  // shape. Such a path enters this block only when it holds a fresh leaf
  // AND its redacted value equals the record, so a real edit anywhere
  // else in it keeps the replacement exactly as before.
  // The paths whose fresh `NoEcho` leaves AWS confirmed, for the skip
  // below the block.
  const noEchoHeldPaths = new Set<string>();
  // The create-only paths a `NoEcho` PARAMETER value feeds, taken before the
  // block below can lower them: the parameter block after it decides them.
  // Create-only by the type's SCHEMA (the committed snapshot when DescribeType
  // fails), not by the diff's replacement flag: a write-only create-only
  // property raises no ceiling in the diff, nor does any whole-property path
  // when the lookup fails, and maintainer decision 1 covers both (never sent
  // as an in-place change, never replaced; warned).
  const isSchemaCreateOnly = (key: string): boolean =>
    (pendingParameterLeaves.get(key) ?? []).some((leaf) => {
      const full = [key, ...leaf.path.map(String)];
      return schemaCreateOnly.some(
        (path) => path.length <= full.length && path.every((segment, i) => segment === full[i])
      );
    });
  const parameterCreateOnlyPaths = new Set(
    (change.propertyChanges ?? [])
      .filter(
        (pc) =>
          (pc.requiresReplacement || isSchemaCreateOnly(pc.path)) &&
          pendingParameterLeaves.has(pc.path) &&
          otherFreshAt(pc.path).length === 0
      )
      .map((pc) => pc.path)
  );
  // go-to-k/cdkd#6146: never sent in place, so the save keeps each one's
  // previous NoEcho value MAC (a replacement's new record starts with none).
  // Nothing reads a create-only key's MAC today (no verdict for it); it is
  // kept, rather than restamped with a value never sent, so every entry stays
  // the MAC of what the resource was last sent.
  const keepMac = keptNoEchoMacSink(engine, logicalId, parameterCreateOnlyPaths);
  for (const key of parameterCreateOnlyPaths) keepMac(key);
  if (change.propertyChanges?.some((pc) => pc.requiresReplacement) === true) {
    const lowered: PropertyChange[] = [];
    for (const pc of change.propertyChanges) {
      if (!pc.requiresReplacement || parameterCreateOnlyPaths.has(pc.path)) {
        lowered.push(pc);
        continue;
      }
      // A path carrying BOTH classes is confirmed only when every leaf holds:
      // the parameter leaves join the custom-resource ones here.
      const freshLeaves = [
        ...otherFreshAt(pc.path),
        ...(pendingParameterLeaves.get(pc.path) ?? []),
      ];
      if (!isReplacementCeiling(pc) && freshLeaves.length === 0) {
        lowered.push(pc);
        continue;
      }
      // The non-NoEcho half first, unchanged: a moved leaf keeps the
      // replacement whatever AWS holds at the masked ones.
      // A masked property whose template moved (go-to-k/cdkd#4451) moved,
      // whatever its two `***` say.
      const moved = movedAsWritten(pc.path);
      // A propagated CEILING whose value MOVED is kept, unless the type's
      // own conditional rule reads the move as in place (issue #4134) --
      // the same predicate the diff applies to a template edit. A
      // property with no conditional rule answers `undefined` and keeps
      // it; a template-diff replacement is the diff's verdict already.
      const conditionalVerdict =
        moved && !typeChanged && isReplacementCeiling(pc)
          ? engine.diffCalculator.conditionalReplacementVerdict?.(
              resourceType,
              pc.path,
              currentPropsAsWritten[pc.path],
              desiredForSkipCheckAsWritten[pc.path],
              {
                oldProperties: currentPropsAsWritten,
                newProperties: desiredForSkipCheckAsWritten,
              }
            )
          : undefined;
      if (moved && conditionalVerdict !== false) {
        warnWitnessReplacement(pc.path);
        lowered.push(pc);
        continue;
      }
      if (freshLeaves.length > 0) {
        // A Type change replaces anyway, and the record's provider
        // describes the OLD type: no read, and nothing to report.
        if (typeChanged) {
          lowered.push(pc);
          continue;
        }
        const read = await readOnce();
        let verdict: FreshNoEchoCeilingVerdict;
        if ('failure' in read) {
          verdict = read.failure;
        } else if (!Object.prototype.hasOwnProperty.call(read.live, pc.path)) {
          verdict = 'not-readable';
        } else {
          verdict = liveHoldsFreshLeaves(read.live[pc.path], freshLeaves) ? 'held' : 'differs';
        }
        // A mixed path whose custom-resource leaves AWS holds, and whose only
        // unconfirmed leaves are a `NoEcho` PARAMETER's: the parameter class's
        // rule (maintainer decision 1 on #4043) — never replaced on a
        // readback's word, warned on every deploy.
        const parameterLeaves = pendingParameterLeaves.get(pc.path) ?? [];
        if (
          verdict === 'differs' &&
          parameterLeaves.length > 0 &&
          !('failure' in read) &&
          liveHoldsFreshLeaves(read.live[pc.path], otherFreshAt(pc.path))
        ) {
          engine.logger.warn(
            safeMsg`${logicalId}.${pc.path} is a create-only property fed by a NoEcho parameter, and cdkd cannot confirm AWS holds its current value (differs). It is not replaced, so a change to that value is not applied: to apply one, deploy with --recreate-via-cc-api ${logicalId} or --recreate-via-sdk-provider ${logicalId}.`
          );
          noEchoHeldPaths.add(pc.path);
          lowered.push({ ...pc, requiresReplacement: false });
          continue;
        }
        if (verdict !== 'held') {
          // WARN, not debug: this is what turns the update into a
          // replacement, and a `Replacing` label must never be
          // unexplained. The id, the path and the class only.
          engine.logger.warn(
            safeMsg`${logicalId}.${pc.path} carries a NoEcho value that AWS could not confirm unchanged (${verdict}): replacement kept.`
          );
          lowered.push(pc);
          continue;
        }
        engine.logger.debug(
          safeMsg`${logicalId}.${pc.path} carries a NoEcho value AWS already holds: not replaced.`
        );
        noEchoHeldPaths.add(pc.path);
      }
      lowered.push({ ...pc, requiresReplacement: false });
    }
    change.propertyChanges = lowered;
  }

  // go-to-k/cdkd#4043 §4.2: the PARAMETER class. The resource is read back
  // (once, shared with the block above) when a create-only path carries such
  // a value, or when nothing else moved, which is when the readback alone
  // decides between sending and skipping. Another moved leaf sends the update
  // anyway, with the value in hand.
  const parameterSettledPaths = new Set<string>();
  // Keys whose every pending leaf AWS confirmed holding (`held`).
  const parameterHeldKeys = new Set<string>();
  const parameterUnreadablePaths: string[] = [];
  // go-to-k/cdkd#6146: the updatable keys AWS does not report (a readback
  // showed it, or the schema declares the key write-only), which the NoEcho
  // value MACs may settle below. Only those: a readable key is AWS's to
  // decide, read or not, and every replay (an older cdkd's included) refuses
  // to send an unreadable one, so no revert can leave AWS holding a value its
  // MAC does not describe.
  const parameterUnreportedPaths = new Set<string>();
  if (pendingParameterLeaves.size > 0 && !typeChanged) {
    // go-to-k/cdkd#5112: a type whose provider decides from
    // `changedProperties` whether to send a field reads back a `NoEcho` key
    // on an updatable path even when something else moved, so one AWS holds
    // is left out of that set, as CloudFormation compares templates. Parity
    // won only for those opted-in types: every other type makes no new call
    // (performance first), and its unconfirmed key stays in the set, re-sent.
    const consumerReadsBack =
      CHANGED_PROPERTIES_CONSUMER_TYPES.has(resourceType) &&
      currentResource.provisionedBy !== 'cc-api' &&
      [...pendingParameterLeaves.keys()].some(
        (key) => !parameterCreateOnlyPaths.has(key) && otherFreshAt(key).length === 0
      );
    const mustRead = parameterCreateOnlyPaths.size > 0 || recordMatchesDesired || consumerReadsBack;
    const read = mustRead ? await readOnce() : undefined;
    const verdictAt = (key: string): FreshNoEchoCeilingVerdict => {
      if (read === undefined) return 'not-readable';
      if ('failure' in read) return read.failure;
      if (!Object.prototype.hasOwnProperty.call(read.live, key)) return 'not-readable';
      return liveHoldsFreshLeaves(read.live[key], pendingParameterLeaves.get(key) ?? [])
        ? 'held'
        : 'differs';
    };
    const lowered: PropertyChange[] = [];
    replacedAnyway =
      recreateDirectionFor(engine.options, stackName, logicalId) !== undefined ||
      lostWithParent !== undefined ||
      (change.propertyChanges ?? []).some(
        (other) =>
          other.requiresReplacement &&
          (!parameterCreateOnlyPaths.has(other.path) || movedAsWritten(other.path))
      );
    for (const pc of change.propertyChanges ?? []) {
      if (!parameterCreateOnlyPaths.has(pc.path)) {
        lowered.push(pc);
        continue;
      }
      // A leaf OTHER than the `NoEcho` one moved (a template edit, or a
      // pre-v11 record's witness that differs, an exact change): the
      // replacement stands, as CloudFormation would replace.
      const moved = movedAsWritten(pc.path);
      if (moved) {
        // go-to-k/cdkd#4737: the path is create-only by the SCHEMA, while the
        // diff decided whether it replaces (registry first, then a whole
        // create-only property). A path the diff did not mark (a Budget's
        // `NotificationsWithSubscribers`, which the registry updates in place)
        // is sent as an update, so the line saying it is replaced would be
        // false.
        if (pc.requiresReplacement) warnWitnessReplacement(pc.path);
        lowered.push(pc);
        continue;
      }
      const verdict = verdictAt(pc.path);
      if (verdict === 'read-failed') {
        throw markNonRetryable(
          new CdkdError(
            safeMsg`${logicalId}.${pc.path} is a create-only property a NoEcho parameter feeds, and reading the resource back from AWS to compare it failed. cdkd does not replace a resource on a failed read: re-run the deploy.`,
            'NOECHO_READBACK_FAILED'
          )
        );
      }
      if (verdict === 'held') {
        parameterHeldKeys.add(pc.path);
        engine.logger.debug(
          safeMsg`${logicalId}.${pc.path} carries a NoEcho parameter value AWS already holds: not replaced.`
        );
      } else if (
        verdict === 'differs' &&
        provenChangedAt(pc.path, read) &&
        (await approveReplacementOf(pc))
      ) {
        // go-to-k/cdkd#4656: the provider echoes this leaf exactly, so the
        // difference is the value's. The id, the path and the cause only.
        engine.logger.warn(
          safeMsg`${logicalId}.${pc.path} is a create-only property fed by a NoEcho parameter, and AWS, which reports it exactly, holds a different value: ${logicalId} is replaced.`
        );
        lowered.push({ ...pc, requiresReplacement: true });
        continue;
      } else {
        // Maintainer decision 1 on #4043: never replaced on a readback's
        // word, whether it could not read the property or read a different
        // value (a provider may normalize what it echoes). Every deploy says so,
        // and a `differs` names why it is not trusted (#4656).
        const staleOnly = staleCoordinates.some((coordinate) => coordinate[0] === pc.path);
        if (verdict === 'differs' && provenChangedAt(pc.path, read)) {
          lateReplacementDeclined.add(pc.path);
        }
        const why = verdict === 'differs' ? differsWhy(pc.path) : verdict;
        engine.logger.warn(
          staleOnly
            ? safeMsg`${logicalId}.${pc.path} is a create-only property whose recorded value is only the NoEcho mask, and cdkd cannot confirm AWS holds its current value (${why}). It is not replaced, so a change to that value is not applied: to apply one, deploy with --recreate-via-cc-api ${logicalId} or --recreate-via-sdk-provider ${logicalId}.`
            : safeMsg`${logicalId}.${pc.path} is a create-only property fed by a NoEcho parameter, and cdkd cannot confirm AWS holds its current value (${why}). It is not replaced, so a change to that value is not applied: to apply one, deploy with --recreate-via-cc-api ${logicalId} or --recreate-via-sdk-provider ${logicalId}.`
        );
      }
      parameterSettledPaths.add(pc.path);
      lowered.push({ ...pc, requiresReplacement: false });
    }
    if (change.propertyChanges !== undefined) change.propertyChanges = lowered;
    if (read !== undefined) {
      for (const key of pendingParameterLeaves.keys()) {
        if (parameterCreateOnlyPaths.has(key)) continue;
        // A custom-resource leaf beside it keeps the #3729 rule (an updatable
        // path nobody read back for it is sent).
        if (otherFreshAt(key).length > 0) continue;
        const verdict = verdictAt(key);
        // A `held` key is settled as on the no-change arm, whichever reason
        // took the read (go-to-k/cdkd#5112 included): the provider's previous
        // side gets the value AWS holds, and the key leaves `changedProperties`.
        // `differs` and an unreadable key stay pending, so both stay in it.
        if (verdict === 'held') {
          parameterSettledPaths.add(key);
          parameterHeldKeys.add(key);
        } else if (verdict === 'not-readable') {
          parameterUnreadablePaths.push(key);
          parameterUnreportedPaths.add(key);
        }
      }
    } else if (
      engine.noEchoRun.noEchoMacs?.settled() !== undefined &&
      currentResource.noEchoValueMacs !== undefined
    ) {
      // Not read (something else moved): a key the type's schema declares
      // write-only is one no readback reports either, so its MAC may decide.
      // Only a record carrying MACs asks (one cached DescribeType); an
      // unknown answer is no candidate (re-sent, as before).
      const writeOnly = await macWriteOnlyKeys(resourceType, engine.noEchoRun.macWriteOnlyLookups);
      for (const key of pendingParameterLeaves.keys()) {
        if (parameterCreateOnlyPaths.has(key) || otherFreshAt(key).length > 0) continue;
        if (writeOnly?.has(key) === true) parameterUnreportedPaths.add(key);
      }
    }
  }

  // go-to-k/cdkd#6146 (maintainer decision 2): a key AWS gave no word on is
  // decided by the NoEcho value MACs when the record has them. A match settles
  // it as AWS-confirmed above would (no re-send, and none of a RestApi
  // `Body`'s destructive put); a difference sends it as a proven change. No
  // verdict keeps the re-send (decision 4 on #4043) and #6140's stop-gap.
  const {
    confirmed: macConfirmedPaths,
    changed: macChangedPaths,
    readsOther: macReadsOther,
  } = noEchoMacVerdicts({
    candidates: parameterUnreportedPaths,
    record: currentResource,
    templateProperties: desiredProps,
    sources: noEchoSources,
    pendingParameterLeaves,
    parameterCoordinates,
    staleCoordinates,
    movedAsWritten,
    unsettledNames,
    current: engine.noEchoRun.noEchoMacs?.settled(),
    inputBindings: engine.noEchoRun.noEchoMacInputBindings.get(logicalId),
  });
  for (const key of macConfirmedPaths) parameterSettledPaths.add(key);
  if (macConfirmedPaths.size > 0 || macChangedPaths.size > 0) {
    const decided = parameterUnreadablePaths.filter(
      (key) => !macConfirmedPaths.has(key) && !macChangedPaths.has(key)
    );
    parameterUnreadablePaths.splice(0, parameterUnreadablePaths.length, ...decided);
  }
  if (macConfirmedPaths.size > 0) {
    engine.logger.debug(
      safeMsg`${logicalId}: ${[...macConfirmedPaths].sort().join(', ')} carry the NoEcho parameter values they were last sent (their MACs match): not re-sent`
    );
  }
  if (macReadsOther.size > 0) {
    engine.logger.debug(
      safeMsg`${logicalId}: ${[...macReadsOther].sort().join(', ')} carry the NoEcho values they were last sent, but also read a value their MACs do not cover (a resource attribute, a plain parameter) with no equal, fully resolved input binding: compared as without a MAC`
    );
  }
  if (macChangedPaths.size > 0) {
    engine.logger.info(
      safeMsg`  ${logicalId}: sending ${[...macChangedPaths].sort().join(', ')}: a NoEcho parameter value it reads changed since the last deploy.`
    );
  }

  // The no-change skip above could not trust the mask. Once AWS has
  // confirmed every fresh `NoEcho` leaf the bag carries, and every other
  // leaf equals the record, there is nothing to send, so the same skip
  // applies here. Without it the provider would be called with an
  // unchanged bag: a redundant update, or, for a type with no update API
  // (`AWS::Lambda::LayerVersion`), a refusal the update-failure fallback
  // turns back into the replacement this block just avoided. A fresh
  // leaf outside a confirmed path (an updatable property nobody read
  // back) keeps the update, as before (go-to-k/cdkd#3729).
  //
  // A `--recreate-via-*` target is never skipped here: before this skip
  // existed a fresh value always reached the recreate below, and a named
  // recreate must not be dropped because a value turned out unchanged.
  // An attribute-only change (`DeletionPolicy`, ...) takes the same
  // metadata arm as the skip above, for the same no-update-API reason.
  const confirmedPaths = new Set([...noEchoHeldPaths, ...parameterSettledPaths]);
  if (
    confirmedPaths.size > 0 &&
    mayTakeNoChangeSkip &&
    Object.keys(resolvedProps).every(
      (key) =>
        confirmedPaths.has(key) ||
        (otherFreshAt(key).length === 0 && !pendingParameterLeaves.has(key))
    )
  ) {
    engine.logger.debug(
      safeMsg`Skipping ${logicalId}: AWS already holds every NoEcho value it carries, and nothing else changed`
    );
    // go-to-k/cdkd#4043 (review round 8 m2): a STALE coordinate (the record
    // holds `***` where no NoEcho source serves the leaf any more) that AWS
    // confirmed holding the resolved value is rewritten to that value and
    // unmarked, so the diff stops comparing `***` with it on every run.
    const staleHeld = staleCoordinates.filter(
      (coordinate) => typeof coordinate[0] === 'string' && parameterHeldKeys.has(coordinate[0])
    );
    if (staleHeld.length > 0) {
      let properties = currentResource.properties;
      for (const coordinate of staleHeld) {
        properties = setAtCoordinate(
          properties,
          coordinate,
          valueAtCoordinate(resolvedProps, coordinate)
        );
      }
      const remaining = (noEchoLeavesOf(currentResource) ?? []).filter(
        (coordinate) =>
          !staleHeld.some((stale) => keyOrderFreeJson(stale) === keyOrderFreeJson(coordinate))
      );
      const { noEchoLeaves: _dropped, ...rest } = currentResource;
      stateResources[logicalId] = {
        ...rest,
        properties,
        ...(remaining.length > 0 && { noEchoLeaves: remaining.map((c) => [...c]) }),
      };
    }
    // go-to-k/cdkd#4852: as on the first skip, an equal-value version move
    // refreshes the read versions, so the next diff does not promote again.
    if (provenanceUnchanged.length > 0) {
      stateResources[logicalId] = withRefreshedReadVersions(
        stateResources[logicalId] ?? currentResource,
        provenanceUnchanged
      );
    }
    // Nothing was attempted, as on the skip above the refusal.
    engine.attemptedResolvedProps.delete(logicalId);
    if (change.attributeChanges && change.attributeChanges.length > 0) {
      applyAttributeOnlyUpdate(change.attributeChanges);
      return;
    }
    if (counts) counts.skipped++;
    return;
  }

  // Maintainer decision 4 on #4043: an updatable property AWS does not report
  // (write-only, or a type with no readback) is re-sent on every deploy, and
  // one line per resource says why the update ran -- unless its NoEcho value
  // MACs decided it above (go-to-k/cdkd#6146).
  if (recordMatchesDesired && parameterUnreadablePaths.length > 0) {
    engine.logger.info(
      safeMsg`  ${logicalId}: re-sending ${parameterUnreadablePaths.join(', ')}, fed by a NoEcho parameter. AWS does not report the value back, so cdkd cannot tell whether it changed.`
    );
  }

  // Check if this update requires resource replacement (immutable property changed)
  // `typeChanged ||` (issue #3036): a Type change is a replacement by
  // definition, never an in-place update — the in-place arm below would
  // hand the OLD physical id to the NEW type's `update()`. Read from the
  // record rather than trusted to the diff's synthetic `Type` row, so a
  // change-shape that omits the row cannot route there.
  const propertyDrivenReplacement =
    typeChanged || change.propertyChanges?.some((pc) => pc.requiresReplacement);
  // Issue [#2567] — the recreate targets apply ONLY to the stack the
  // pre-flight validated them against. This engine instance may be a
  // NESTED child (`NestedStackProvider.runChildDeploy` spreads the
  // parent's options into it, and the child deploys under
  // `<parent>~<logicalId>`), where the ids were never validated: neither
  // the child's template, nor its state record, nor its live emptiness
  // was ever looked at. Unscoped, a child resource sharing a logical id
  // with a validated parent one was treated as recreate-flagged — and
  // `recreateFlagged` is what SKIPS the stateful guard below.
  //
  // Read INSIDE `case 'UPDATE'`: a target the diff called NO_CHANGE gets
  // here because `promoteRecreateTargets` made it an UPDATE, and the
  // no-op skips above exempt it (issue #2651).
  const recreateTargets =
    engine.options.recreateTargets?.stackName === stackName
      ? engine.options.recreateTargets
      : undefined;
  // Issue [#615] — the user explicitly named this resource via
  // `--recreate-via-cc-api <LogicalId>` so this deploy MUST destroy
  // + recreate it through Cloud Control regardless of whether the
  // template's diff would otherwise drive a replacement.
  const recreateViaCcApi = recreateTargets?.viaCcApi.has(logicalId) ?? false;
  // #651 reverse direction. Mutually exclusive with `recreateViaCcApi`
  // — the pre-flight validator rejects any logical id named in both
  // lists, so at most one of these two booleans is true at a time.
  const recreateViaSdkProvider = recreateTargets?.viaSdkProvider.has(logicalId) ?? false;
  const recreateFlagged = recreateViaCcApi || recreateViaSdkProvider;
  const needsReplacement =
    propertyDrivenReplacement || recreateFlagged || lostWithParent !== undefined;

  // Issue #2790: a replacement driven ONLY by create-only properties an
  // earlier deploy accepted dropping (`--prefer-sdk-route`) and
  // the template still asks for unchanged — including one the SDK provider
  // has since started writing (issue #5572), which no flag can keep dropped. AWS never held them, and the only
  // thing that moved is that the flag went away — so destroying and
  // re-creating the resource is not something cdkd does on its own. Refused
  // before anything is deleted; `--replace` or `--recreate-via-cc-api` opts
  // in, and the stateful guard still applies on that path.
  //
  // Any OTHER replacement-requiring change lets it through: that replacement
  // happens anyway, and its create applies these properties too.
  if (
    propertyDrivenReplacement &&
    !typeChanged &&
    !recreateFlagged &&
    lostWithParent === undefined &&
    engine.options.replace !== true &&
    currentResource.provisionedBy !== 'cc-api'
  ) {
    const unwritten = unwrittenCreateOnlyReplacement(
      resourceType,
      currentProps,
      desiredForSkipCheck,
      allowedForRecord,
      createOnlyEvidence,
      (change.propertyChanges ?? []).filter((pc) => pc.requiresReplacement).map((pc) => pc.path)
    );
    if (unwritten.length > 0) {
      // Marked refused-before-applying: nothing was sent, so the journal
      // must not record this resolved bag as an attempt a `--revert-failed`
      // or a later create would act on.
      throw markRefusedBeforeApplying(
        markNonRetryable(
          new CdkdError(
            unwrittenCreateOnlyRefusal({
              logicalId,
              resourceType,
              unwritten,
              routeDriving: findActionableSdkUnwired(
                resourceType,
                desiredForSkipCheck,
                allowedForRecord,
                currentProps
              ).map(({ property }) => property),
              nested: engine.options.parentStackInfo !== undefined,
              // Issue #5572: the keys a later release's SDK provider writes.
              nowWritten: findHandledUnwrittenCreateOnly(
                resourceType,
                currentProps,
                createOnlyEvidence
              ),
              evidence: [...createOnlyEvidence],
              // Issue #2610: the replacement's delete never clears a
              // deletion protection, so the remedy says so where the record
              // shows one -- as the stateful guard does.
              protectionEvidence: recordedProtectionEvidence(
                resourceType,
                currentProps,
                currentResource.observedProperties,
                engine.stackRegion
              ),
            }),
            'CREATE_ONLY_DROP_NEEDS_REPLACEMENT'
          )
        )
      );
    }
  }

  return finishUpdate(engine, {
    logicalId,
    change,
    stateResources,
    stackName,
    template,
    parameterValues,
    conditions,
    counts,
    progress,
    resourceType,
    renderer,
    currentResource,
    oldResourceType,
    typeChanged,
    currentProps,
    updateSecrets,
    resolvedProps,
    lostChild,
    lostWithParent,
    desiredForSkipCheckAsWritten,
    witness,
    currentPropsAsWritten,
    otherFreshAt,
    pendingParameterLeaves,
    unsettledNames,
    movedAsWritten,
    confirmedPaths,
    macChangedPaths,
    propertyDrivenReplacement,
    recreateViaCcApi,
    recreateViaSdkProvider,
    recreateFlagged,
    needsReplacement,
  });
}
