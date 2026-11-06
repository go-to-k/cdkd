import type { LogsLogGroupProvider } from '../logs-loggroup-provider.js';
import {
  AssociateKmsKeyCommand,
  DisassociateKmsKeyCommand,
  DeleteIndexPolicyCommand,
  PutBearerTokenAuthenticationCommand,
  PutIndexPolicyCommand,
  PutLogGroupDeletionProtectionCommand,
  PutRetentionPolicyCommand,
  DeleteRetentionPolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  PutDataProtectionPolicyCommand,
  DeleteDataProtectionPolicyCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import { plainIdentOr } from '../../../utils/display-safe.js';
import {
  createMaskedLogSinks,
  maskerOrIdentity,
  withDerivedNameMasks,
} from '../../masked-retry-logger.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { planTagDiff, refuseMalformedDesiredTags, tagPlanWarning } from '../../tag-list.js';
import { isTruthyCfnBoolean } from '../../data-delete-intent.js';
import { toCfnInteger, toFiniteNumber } from '../../dynamodb-warm-throughput.js';
import { renderDisableCommand, UNNAMEABLE_ID_CLAUSE } from '../../replacement-protection-advice.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { isAbsentRetention, assertUsableRetention } from './shared.js';

/**
 * Update a CloudWatch Logs log group
 *
 * Mutable: `RetentionInDays`, `DataProtectionPolicy`, `Tags`,
 * `DeletionProtectionEnabled`, `BearerTokenAuthenticationEnabled`,
 * `FieldIndexPolicies`, `KmsKeyId` (via AssociateKmsKey /
 * DisassociateKmsKey). `LogGroupName` requires replacement.
 * `LogGroupClass` cannot be changed at all (CFn: "Updates are not
 * supported" — there is no CloudWatch Logs API to change a log group's
 * class after creation), so a class change throws
 * {@link ResourceUpdateNotSupportedError} instead of being silently
 * dropped; `--replace` recreates the log group under the new class.
 *
 * Thin wrapper that maps any AWS SDK failure onto {@link ProvisioningError}
 * the same way {@link create} and {@link delete} do, so an update failure
 * carries cdkd's typed error formatting and exit-code handling instead of
 * surfacing raw (issue #1267). The body lives in {@link applyUpdate} so the
 * wrap is a boundary concern rather than a large indentation change.
 *
 * The {@link ResourceUpdateNotSupportedError} thrown by the LogGroupClass
 * guard is re-thrown untouched: the deploy engine matches it by class to
 * fall back to replacement, so swallowing it into a ProvisioningError would
 * turn a recoverable class change into a hard failure.
 */
export async function update(
  this: LogsLogGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  callerContext?: UpdateContext
): Promise<ResourceUpdateResult> {
  // The physical id IS the log group name, which can be secret-derived.
  // Paired with the RECORDED name (go-to-k/cdkd#4339): after a secret
  // rotation the physical id is the PRE-rotation value, which this deploy's
  // masker never resolved, and a previous side still spelling `{{resolve:`
  // makes it a needle. (An unrotated secret-derived name IS the resolved
  // value, which the deploy's masker already holds.) Every masker use
  // below reads this one.
  const context: UpdateContext = {
    ...callerContext,
    maskSecrets: withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, callerContext?.maskSecrets),
      [[previousProperties['LogGroupName'], physicalId]]
    ).mask,
  };
  try {
    return await this.applyUpdate(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  } catch (error) {
    // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
    // is control flow the deploy engine matches BY CLASS, and a ProvisioningError
    // raised deeper in the body already carries better context than a re-wrap.
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    // An AWS error can echo a request value (a resolved tag value), so the
    // message goes through the operation's masker.
    const mask = maskerOrIdentity(context?.maskSecrets);
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update log group ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function applyUpdate(
  this: LogsLogGroupProvider,
  logicalId: string,
  physicalId: string,
  // Threaded rather than re-spelled as a literal: `update()` already
  // receives it, and a hardcoded type in a refusal is a second place to
  // update if this provider ever serves another one.
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  // Read for `desiredFromAwsReadback`, which decides whether a numeric `0` is
  // cdkd's own never-expire readback or a template's rejected zero (see
  // `isAbsentRetention`), for `replayingState` (issue #3141), which
  // downgrades the refusal on a rollback replay, and for `maskSecrets`, applied
  // to the Tags plan warning (which names no property value). The one VALUE
  // any of the retention warnings interpolates is
  // `toFiniteNumber`'s positive-integer reading of the retention itself —
  // a day count, not a carrier for secret material (PR #3246 security
  // review, which flagged the previous "names no value" wording as stale).
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(
    `Updating log group ${logicalId}: ${maskerOrIdentity(context?.maskSecrets)(physicalId)}`
  );

  // go-to-k/cdkd#4073: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  // LogGroupClass is unchangeable after creation (no AWS API exists;
  // CloudFormation documents the property as "Update requires: Updates
  // are not supported" and fails the stack update). Guard BEFORE any
  // other mutation so a doomed deploy fails without partially applying
  // the rest of the diff — silently dropping the change would poison
  // state (state records the new class while AWS keeps the old one, and
  // the next diff sees no change, so it can never self-heal). An absent
  // property means the CloudWatch Logs default class (STANDARD), so an
  // explicit-STANDARD <-> absent transition is NOT a real change.
  const normalizeClass = (v: unknown): string =>
    typeof v === 'string' && v.length > 0 ? v : 'STANDARD';
  const prevClass = normalizeClass(previousProperties['LogGroupClass']);
  const nextClass = normalizeClass(properties['LogGroupClass']);
  if (prevClass !== nextClass) {
    // EVERY log group is in the stateful-recreate guard set on this path, so
    // a bare --replace would be stopped a second time by
    // STATEFUL_REPLACE_BLOCKED — name the full flag set upfront.
    //
    // UNCONDITIONAL since issue [#2558]. It used to read
    // `properties['RetentionInDays']`, on the premise that a log group with
    // no retention was not stateful; that premise was the defect — an unset
    // or zero retention is CloudWatch Logs' never-expire — and the
    // mid-deploy guard now refuses any log group the recorded bag cannot
    // prove empty. Advising a bare `--replace` would hand the user a remedy
    // guaranteed to fail on the second deploy. (This also retires the
    // ADVICE half of issue [#2521], which filed the same line for reading
    // the DESIRED bag while the guard reads the RECORDED one: with no
    // condition left, there is no bag to read. Its other two halves — a
    // string-valued retention defeating the guard's `typeof === 'number'`
    // test, and the guard never reading `observedProperties` — were closed
    // separately, in `stateful-types.ts`.)
    const replaceFlags = '--replace --force-stateful-recreation';

    // Issue [#2579]: those two flags are not sufficient on a log group that
    // carries DeletionProtectionEnabled. The replacement's DELETE runs from
    // the deploy engine, which never sets `DeleteContext.removeProtection`
    // (the flip-off in `delete()` below is gated on it, and only the destroy
    // paths set it — `cdkd deploy` has no `--remove-protection` flag at
    // all), so AWS refuses the DeleteLogGroup and the advised command dies
    // on a SECOND wall with nothing named to do about it.
    //
    // Read the RECORDED bag, not the desired one. On the DEPLOY path
    // `previousProperties` is `ResourceState.properties` for this resource
    // (`deploy-engine.ts` hands over `currentProps`, which
    // `diff-calculator.ts` sets from `currentResource.properties`) — what
    // cdkd last deployed, and so its best account of what AWS holds on the
    // log group that must be deleted. The DESIRED bag answers a different
    // question and would be wrong in both directions there: a template newly
    // ADDING protection alongside the class change leaves AWS unprotected,
    // because this very refusal fires before the flip is applied, so the
    // replacement's delete would have succeeded; and a template CLEARING it
    // does not clear it in AWS for the same reason, so the dead-end is still
    // ahead of the user.
    //
    // TWO of the four `update()` callers hand over something else, which is
    // why the message SAYS "cdkd's recorded properties" rather than asserting
    // AWS state. `drift.ts` passes `outcome.awsProperties`, a
    // `readCurrentState` snapshot — strictly better here, and the one bag
    // that ALWAYS carries this key (`readCurrentState` emits an explicit
    // `false` placeholder). `rollback-executor.ts`'s `--revert-failed` arm
    // passes `op.attemptedProperties ?? current.properties` — the DESIRED bag
    // of the failed attempt, i.e. exactly the read argued against above. (Its
    // `revert` arm passes `current.properties`, the state record, same as
    // deploy.) The advice survives being wrong on the `--revert-failed` arm:
    // the disable call is idempotent, and AWS accepts it on an
    // already-unprotected log group.
    //
    // Two residuals are ACCEPTED rather than fixed here. Protection enabled
    // OUT OF BAND is absent from every bag, so that log group still gets the
    // short advice and still hits the wall — cdkd cannot see what it never
    // recorded, and probing AWS from a refusal path would add a call to the
    // failure route. And `isTruthyCfnBoolean` matches `true` / `'true'` only,
    // so `'True'` or `1` falls through to the short advice: widening it is a
    // repo-wide change to a helper `hasCdkAutoDeleteTag` also uses, and the
    // fall-through direction is merely the pre-#2579 behaviour. It is the
    // same defect class issue [#2521] closed one property over, where the
    // stateful guard's `typeof === 'number'` test on `RetentionInDays` was
    // replaced by a coercion — so the shape has a fix to copy if this one is
    // ever taken up, not merely a sibling to point at.
    // The message deliberately STOPS at what this function can know, and
    // hands the rest to the doc. Three review rounds each proved a different
    // sentence about the downstream mechanism FALSE, because `update()` sees
    // neither `UpdateReplacePolicy` nor what the replacement then does:
    //
    //   1. "re-enable protection on the new log group afterwards" — wrong;
    //      `create()` re-applies the flag from the DESIRED bag, so a manual
    //      re-enable over a `false` template manufactures drift that never
    //      self-corrects (`applyUpdate` flips only when the two bags DIFFER).
    //   2. "the disable applies to the OLD log group, which the replacement
    //      deletes" — wrong under `UpdateReplacePolicy: Retain`, where both
    //      replacement paths skip the delete (`deploy-engine.ts`'s
    //      `retainOldOnReplace`).
    //   3. "under Retain it only strips a log group cdkd stops tracking" —
    //      wrong again: `LogGroupName` is this type's ONLY replacement
    //      property, so a same-name Retain replacement cannot complete at
    //      all. `create()` swallows `ResourceAlreadyExistsException` and
    //      returns the OLD physical id, and the engine refuses with
    //      `NAMED_REPLACEMENT_IDEMPOTENT_CREATE` before any state
    //      bookkeeping — i.e. the sentence promised an outcome the code
    //      makes unreachable, and hid a THIRD wall, which is the exact
    //      defect class issue [#2579] exists to close.
    //
    // So: state the refusal, the flag that does not exist, the disable
    // command, and the same-deploy trap — all knowable here — then point at
    // `docs/cli-deploy-safety.md`, which has the policy in view and room to
    // be precise. A shorter message that is TRUE beats a complete one that
    // is not.
    const deletionProtected = isTruthyCfnBoolean(previousProperties['DeletionProtectionEnabled']);
    // The id in the pasteable command is `state.json`-borne, not an
    // AWS-minted literal (issue [#2669]): the deploy engine hands this
    // method `currentResource.physicalId` straight off the record, which
    // `lock-manager.ts` already treats as attacker-influenced for anyone who
    // can write the bucket. It therefore gets exactly what the five
    // `protectedReplacementAdvice` callers get — `displaySafe(asciiOnly)`,
    // then `shellQuote`, and the WHOLE command suppressed when sanitizing
    // changed the id, since a command naming a sanitized id acts on a
    // DIFFERENT resource. Only the rendering is shared; the sentence around
    // it stays this type's own (the header of that module says why). For a
    // clean id `shellQuote` emits it UNQUOTED — its quote-free class is
    // `[A-Za-z0-9._/@:+-]`, which every ordinary CloudWatch Logs name is in
    // (a `#`, legal in a name, is outside it and gets quoted, correctly) —
    // and that bare form is what
    // `tests/integration/loggroup-class-guard/verify.sh` greps.
    const disableCommand = renderDisableCommand({
      before: 'aws logs put-log-group-deletion-protection --log-group-identifier',
      identifier: physicalId,
      after: '--no-deletion-protection-enabled',
      // A secret-derived name (the pre-rotation one included) withholds the
      // command (go-to-k/cdkd#4339).
      maskSecrets: maskerOrIdentity(context?.maskSecrets),
    });
    const disableStep = disableCommand
      ? `Then disable deletion protection — \`${disableCommand}\`, or via the console — and re-deploy with ${replaceFlags}`
      : `${UNNAMEABLE_ID_CLAUSE} Then re-deploy with ${replaceFlags}`;
    const remedy = deletionProtected
      ? `cdkd's recorded properties for this log group carry DeletionProtectionEnabled, so ${replaceFlags} alone will NOT succeed while AWS still has it on: the replacement normally deletes the log group, AWS refuses that delete while protection is on, and cdkd deploy has no --remove-protection flag to clear it (only cdkd destroy and cdkd state destroy act on one). Read "Deletion protection blocks a replacement" at https://cdkd.dev/cli-deploy-safety/#deletion-protection-blocks-a-replacement-and-deploy-cannot-clear-it BEFORE you disable anything: whether disabling helps at all, and what the flag ends up as, depend on your UpdateReplacePolicy and on whether the deploy completes — neither of which this refusal can see. ${disableStep} to delete + recreate the log group under the new class (its stored log events are lost). Setting DeletionProtectionEnabled: false in the template does NOT clear it in the same deploy: this refusal fires before that property is applied, so that route needs its own deploy with the LogGroupClass change reverted. Or revert the LogGroupClass change and keep the current class.`
      : `Re-deploy with ${replaceFlags} to delete + recreate the log group under the new class (its stored log events are lost), or revert the LogGroupClass change.`;
    // A legal class is a plain enum word (STANDARD / INFREQUENT_ACCESS /
    // DELIVERY) and prints bare; anything else is DESCRIBED, never shown, so no
    // pasted span of the refusal runs a value the template or state chose. A
    // quoted display is not enough: `'...'` is closed by a `'` in the value,
    // and `"..."` still runs a `$( )` (go-to-k/cdkd#4239).
    const shownClass = (c: string): string =>
      plainIdentOr(c, 'a class value that is not a plain identifier');
    throw new ResourceUpdateNotSupportedError(
      'AWS::Logs::LogGroup',
      logicalId,
      `the LogGroupClass (from ${shownClass(prevClass)} to ${shownClass(nextClass)}) cannot be changed after creation. ${remedy} Note --force-stateful-recreation has NO per-resource granularity: it clears the data guard for every replacement target in the run`
    );
  }

  // Read + VALIDATE the retention here, above every mutation, and send it
  // further down (issue [#2521]).
  //
  // BOTH sides go through `toCfnInteger`, and the comparison matters as
  // much as the send: a state record carrying the string `'30'` — what
  // `cdkd import --migrate-from-cloudformation` persists from a CFn template
  // that spelled it that way — is `!==` the template's numeric `30`, so
  // every deploy re-issued a PutRetentionPolicy for a retention that had not
  // changed.
  //
  // The refusal is gated on the RAW value CHANGING, and each half of that
  // was a review-round finding rather than a design:
  //
  //  - gating on a CHANGE at all, because an unusable value present
  //    identically in BOTH bags is what an import record produces, and the
  //    pre-coercion code compared it EQUAL and issued nothing; refusing it
  //    would fail an unrelated property change on a template nobody touched.
  //  - gating on RAW rather than on the COERCED comparison below, because
  //    `toCfnInteger` maps `'abc'`, `'  '`, `[]`, `{}`, `true`, `''` and
  //    ABSENT all to `undefined`. A coerced gate therefore reads `'abc'`
  //    against an absent-or-differently-unusable previous side as
  //    UNCHANGED, skips the refusal AND the send, and the deploy succeeds
  //    green with the property silently discarded while state records it —
  //    the state-poisoning silent-drop class the `LogGroupClass` guard above
  //    exists to prevent.
  //  - ABOVE the KMS block, so a refusal cannot leave the update
  //    half-applied with the key association changed and state unwritten.
  //
  // `sameRawRetention` is deliberately NOT a bare `JSON.stringify` compare,
  // and not a bare `Object.is` either. `Object.is` alone would refuse an
  // UNCHANGED `[]` or `{}`, because the template bag and the state bag never
  // share a reference — the import no-op above is exactly that shape.
  // `JSON.stringify` alone is not INJECTIVE: `Infinity`, `-Infinity` and
  // `NaN` all render `'null'`, so an `Infinity` over a recorded `null` would
  // compare UNCHANGED and take the refusal-skipped SDK-unwired route one
  // layer down from the bullet above. So: identical by reference, OR
  // structurally equal through a rendering that is FAITHFUL.
  //
  // BOTH exclusions are defence with no reachable case, labelled rather than
  // argued — `!== 'null'` only matters for a non-finite number and
  // `!== undefined` only for a symbol or function, and neither survives the
  // `JSON.parse` both bags come out of. The `Object.is` arm is in the same
  // position: the only pair it decides on its own is a non-finite value
  // against itself. What is REACHABLE, and what that arm is really for, is
  // the unchanged `[]` / `{}` — structurally equal, never the same
  // reference, and refused by a bare `Object.is`.
  //
  // One RESIDUAL is argued the same way and left unfenced: an object
  // carrying a `toJSON` that renders as the previous side's number would
  // compare unchanged and reach the delete arm — but `previousProperties` is
  // strictly `JSON.parse` output and no parse path builds a `toJSON` bearer,
  // and adding `typeof raw !== 'object'` here would refuse the unchanged
  // `[]` this arm exists for.
  const rawRetention = properties['RetentionInDays'];
  const rawPreviousRetention = previousProperties['RetentionInDays'];
  const renderedRetention = JSON.stringify(rawRetention);
  const sameRawRetention =
    Object.is(rawRetention, rawPreviousRetention) ||
    (renderedRetention !== undefined &&
      renderedRetention !== 'null' &&
      renderedRetention === JSON.stringify(rawPreviousRetention));
  // `toCfnInteger`, CloudFormation's measured Integer grammar (issue
  // [#2698]) — `Number()` forwarded `'0x1e'` as 30 here. The PREVIOUS side
  // reads through the same function so the two spellings of one retention
  // still compare equal; a previous value the grammar rejects is the
  // `previousRetentionUnknown` case below, exactly as an `'abc'` was.
  // `let`, because the REPLAY downgrade below can restore the reading the
  // binary that wrote the record took (see the `legacyReading` arm).
  let retentionInDays = toCfnInteger(rawRetention);
  const oldRetentionInDays = toCfnInteger(rawPreviousRetention);
  // Absent FIRST (issue [#2699]): absent / `''` / whitespace-only are
  // CloudFormation's measured spellings of "no retention" and take the
  // delete arm below; numeric `0` joins them ONLY on a readback bag. Every
  // other falsy value — `false`, `null`, a template `0` / `'0'` — is refused
  // by `assertUsableRetention` like `'abc'`, because CloudFormation rejects
  // the template and cdkd must not delete a live retention on its behalf.
  //
  // Decided per site, as `.claude/rules/provider-replay-and-refusals.md`
  // asks of an update-path refusal. Issue [#2699] left an ACCEPTED RESIDUAL
  // here and issue [#3141] CLOSES it: the rollback executor's revert arms
  // hand `update()` `previousState.properties`, and until #3141 they carried
  // no flag saying so (`desiredFromAwsReadback` says something else — the bag
  // is an AWS READBACK — and setting it on those arms would delete a live
  // configuration elsewhere, see `UpdateContext`'s own doc). So a record
  // whose `properties` spell the retention `0` / `'0'` / `false` / `null` —
  // a pre-#2699 template cdkd accepted and recorded, or `drift --accept`
  // writing the readback `0` into `properties` on a record with no
  // `observedProperties` — was REFUSED on a rollback where it used to take
  // the delete arm, and the resource stayed at the FAILED deploy's retention.
  //
  // `UpdateContext.replayingState` is now that flag, and the downgrade below
  // is the UPDATE twin of `create()`'s (read that one for the pattern; both
  // reproduce what the record CERTIFIES was applied rather than what the
  // template grammar allows):
  //
  //  - a spelling the WRITING binary read as a positive integer through
  //    `Number()`-based `toFiniteNumber` (`'30.0'`, `'0x1e'`) was FORWARDED
  //    as that integer and CloudWatch Logs accepted it, so the revert
  //    RESTORES it rather than refusing — otherwise the rollback leaves the
  //    failed deploy's retention in place on a log group whose recorded one
  //    is a compliance setting;
  //  - every other refused member (`0`, `'0'`, `false`, `null`, `'abc'`, a
  //    negative, a non-integer) was SKIPPED on create or rejected by AWS, so
  //    "no retention" is what the record meant for it — that is the DELETE
  //    arm below, which is exactly where it used to land.
  //
  // Both arms WARN naming the spelling; neither is silent, and neither
  // widens what a TEMPLATE bag may say. A template deploy and
  // `drift --revert` set no `replayingState`, so the refusal stands there.
  const desiredFromAwsReadback = context?.desiredFromAwsReadback === true;
  if (!sameRawRetention && !isAbsentRetention(rawRetention, desiredFromAwsReadback)) {
    try {
      assertUsableRetention(rawRetention, retentionInDays, logicalId, resourceType);
    } catch (refusal) {
      if (context?.replayingState !== true || !(refusal instanceof ProvisioningError)) {
        throw refusal;
      }
      const legacyReading = toFiniteNumber(rawRetention);
      if (legacyReading !== undefined && Number.isInteger(legacyReading) && legacyReading > 0) {
        retentionInDays = legacyReading;
        this.logger.warn(
          `${refusal.message}. This update replays a cdkd state record (rollback) written ` +
            `by a cdkd that read the value as ${legacyReading} and applied it, so the ` +
            `retention is RESTORED as ${legacyReading} days rather than refused. Fix the ` +
            `template spelling and re-deploy.`
        );
      } else {
        this.logger.warn(
          `${refusal.message}. This update replays a cdkd state record (rollback), so the ` +
            `value is read as the "no retention" the record meant rather than refused: the ` +
            `log group's retention policy is REMOVED, which is what the cdkd that wrote the ` +
            `record left in place. Re-apply it by hand (aws logs put-retention-policy) or fix ` +
            `the template and re-deploy.`
        );
      }
    }
  }

  // Update KmsKeyId if changed. CFn applies it in place ("Update
  // requires: No interruption") via AssociateKmsKey / DisassociateKmsKey;
  // this previously had NO branch at all, so a KMS key change was
  // silently dropped (deploy success, AWS unchanged, state poisoned) —
  // the exact bug class of the LogGroupClass guard above. A just-created
  // same-stack key can race its key-policy propagation; the engine's
  // withRetry absorbs it via the existing retryable patterns.
  const newKmsKeyId = properties['KmsKeyId'] as string | undefined;
  const oldKmsKeyId = previousProperties['KmsKeyId'] as string | undefined;
  if (newKmsKeyId !== oldKmsKeyId) {
    if (newKmsKeyId) {
      await this.logsClient.send(
        new AssociateKmsKeyCommand({
          logGroupName: physicalId,
          kmsKeyId: newKmsKeyId,
        })
      );
    } else {
      // Removed -> disassociate; newly-ingested data falls back to the
      // CloudWatch Logs default encryption (matches CFn).
      await this.logsClient.send(
        new DisassociateKmsKeyCommand({
          logGroupName: physicalId,
        })
      );
    }
    this.logger.debug(
      `Updated KMS key association for log group ${maskerOrIdentity(context?.maskSecrets)(physicalId)}`
    );
  }

  // Send the retention if the COERCED value changed. Coerced, so the two
  // spellings of one retention compare equal and no redundant call goes out;
  // the values were read and validated above, before any mutation.
  //
  // `previousRetentionUnknown` is the second trigger, and without it the
  // coerced comparison DROPS a call the pre-#2521 code made. `toCfnInteger`
  // answers `undefined` for two different things — "the previous deploy
  // applied no retention" and "cdkd cannot tell what it applied" — and a
  // PRESENT, TRUTHY previous value that does not coerce is the second. Remove
  // the property against such a record (`'abc'`, `[]`, an unresolved
  // `{Ref:...}`, all of which an imported record can carry) and both sides
  // coerce to `undefined`, the `!==` never opens, and cdkd issues nothing
  // while recording absence — so a real retention on the log group would
  // survive with nothing in state pointing at it, and the next diff would see
  // no change. That is the silent-drop class this file's `LogGroupClass`
  // guard exists to prevent, arriving through the coercion.
  //
  // Scoped by `!sameRawRetention` so the import NO-OP is untouched: an
  // unusable value present identically in both bags still issues nothing, as
  // it did before. And scoped by `Boolean(rawPreviousRetention)` because a
  // FALSY previous (`''`, `false`, `null`, absent) is not unknown at all —
  // every one of them was skipped by the pre-coercion truthiness test too, so
  // no `PutRetentionPolicy` was ever issued for it and AWS provably holds no
  // retention. Removing the property against one of those is the one place
  // this change still drops a pre-#2521 call, deliberately: the call was
  // redundant. `UPDATE_MATRIX` carries a row for it.
  //
  // A WHITESPACE-ONLY previous is excluded the same way since issue [#2699]:
  // it is CloudFormation's measured spelling of "absent" (an import record
  // is the only writer — cdkd never sent one), so AWS provably holds no
  // retention for it either. `isAbsentRetention` is called with the readback
  // flag OFF: a previous-side `0` is already excluded by the truthiness test.
  const previousRetentionUnknown =
    !sameRawRetention &&
    Boolean(rawPreviousRetention) &&
    !isAbsentRetention(rawPreviousRetention, false) &&
    oldRetentionInDays === undefined;
  if (retentionInDays !== oldRetentionInDays || previousRetentionUnknown) {
    if (retentionInDays !== undefined && retentionInDays > 0) {
      await this.logsClient.send(
        new PutRetentionPolicyCommand({
          logGroupName: physicalId,
          retentionInDays,
        })
      );
    } else {
      // Remove retention policy (never expire)
      await this.logsClient.send(
        new DeleteRetentionPolicyCommand({
          logGroupName: physicalId,
        })
      );
    }
  }

  // Update DataProtectionPolicy if changed
  if (
    JSON.stringify(properties['DataProtectionPolicy']) !==
    JSON.stringify(previousProperties['DataProtectionPolicy'])
  ) {
    if (properties['DataProtectionPolicy']) {
      const policyDocument =
        typeof properties['DataProtectionPolicy'] === 'string'
          ? properties['DataProtectionPolicy']
          : JSON.stringify(properties['DataProtectionPolicy']);
      await this.logsClient.send(
        new PutDataProtectionPolicyCommand({
          logGroupIdentifier: physicalId,
          policyDocument,
        })
      );
    } else {
      await this.logsClient.send(
        new DeleteDataProtectionPolicyCommand({
          logGroupIdentifier: physicalId,
        })
      );
    }
  }

  // Update DeletionProtectionEnabled if changed. Use !== undefined so
  // explicit `false` is honored (drift --revert needs to be able to
  // clear a console-side enable).
  if (properties['DeletionProtectionEnabled'] !== previousProperties['DeletionProtectionEnabled']) {
    const next = properties['DeletionProtectionEnabled'];
    if (next !== undefined) {
      await this.logsClient.send(
        new PutLogGroupDeletionProtectionCommand({
          logGroupIdentifier: physicalId,
          deletionProtectionEnabled: next as boolean,
        })
      );
    } else {
      // State went from set -> undefined. AWS-side default is false;
      // disable explicitly so the round-trip lands at the default.
      await this.logsClient.send(
        new PutLogGroupDeletionProtectionCommand({
          logGroupIdentifier: physicalId,
          deletionProtectionEnabled: false,
        })
      );
    }
  }

  // Update BearerTokenAuthenticationEnabled if changed. Same pattern
  // as DeletionProtectionEnabled: use !== undefined so explicit
  // `false` reaches AWS.
  if (
    properties['BearerTokenAuthenticationEnabled'] !==
    previousProperties['BearerTokenAuthenticationEnabled']
  ) {
    const next = properties['BearerTokenAuthenticationEnabled'];
    if (next !== undefined) {
      await this.logsClient.send(
        new PutBearerTokenAuthenticationCommand({
          logGroupIdentifier: physicalId,
          bearerTokenAuthenticationEnabled: next as boolean,
        })
      );
    } else {
      // State went from set -> undefined. AWS-side default is false.
      await this.logsClient.send(
        new PutBearerTokenAuthenticationCommand({
          logGroupIdentifier: physicalId,
          bearerTokenAuthenticationEnabled: false,
        })
      );
    }
  }

  // Update FieldIndexPolicies if changed. AWS keys the index policy by
  // logGroupIdentifier alone (one log-group-level policy max), so the
  // diff is structurally trivial: same content -> no-op; new content
  // -> Put (replaces the old one); empty -> Delete.
  const newFieldIndex = properties['FieldIndexPolicies'] as unknown[] | undefined;
  const oldFieldIndex = previousProperties['FieldIndexPolicies'] as unknown[] | undefined;
  if (JSON.stringify(newFieldIndex) !== JSON.stringify(oldFieldIndex)) {
    if (newFieldIndex && newFieldIndex.length > 0) {
      if (newFieldIndex.length > 1) {
        this.logger.debug(
          `Log group ${maskerOrIdentity(context?.maskSecrets)(physicalId)} declares ${newFieldIndex.length} FieldIndexPolicies; AWS only supports one log-group-level field index policy. Applying the first.`
        );
      }
      const first = newFieldIndex[0];
      const policyDocument = typeof first === 'string' ? first : JSON.stringify(first);
      await this.logsClient.send(
        new PutIndexPolicyCommand({
          logGroupIdentifier: physicalId,
          policyDocument,
        })
      );
    } else {
      // Removed -> delete the log-group-level policy. The account-level
      // policy (if any) takes over.
      try {
        await this.logsClient.send(
          new DeleteIndexPolicyCommand({ logGroupIdentifier: physicalId })
        );
      } catch (err) {
        if (!(err instanceof ResourceNotFoundException)) throw err;
        // Already absent; treat as success.
      }
    }
  }

  // Update Tags through `planTagDiff` (go-to-k/cdkd#4073): only the keys the
  // desired side dropped are untagged and only new or changed tags are set,
  // and a recorded Tags cdkd cannot read untags nothing.
  const tagPlan = planTagDiff(previousProperties['Tags'], properties['Tags']);
  const tagWarning = tagPlanWarning(tagPlan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(maskerOrIdentity(context?.maskSecrets)(tagWarning));
  }
  if (tagPlan.remove.length > 0 || tagPlan.set.size > 0) {
    // The tagging APIs take the log-group ARN WITHOUT the trailing `:*`
    // wildcard `buildArn` returns (the `Arn` attribute), as `readCurrentState`'s
    // ListTagsForResource does.
    const arn = (await this.buildArn(physicalId)).replace(/:\*$/, '');
    if (tagPlan.remove.length > 0) {
      await this.logsClient.send(
        new UntagResourceCommand({
          resourceArn: arn,
          tagKeys: tagPlan.remove,
        })
      );
    }
    if (tagPlan.set.size > 0) {
      await this.logsClient.send(
        new TagResourceCommand({
          resourceArn: arn,
          tags: Object.fromEntries(tagPlan.set),
        })
      );
    }
    this.logger.debug(
      `Updated tags for log group ${maskerOrIdentity(context?.maskSecrets)(physicalId)}`
    );
  }

  const arn = await this.buildArn(physicalId);

  return {
    physicalId,
    wasReplaced: false,
    attributes: {
      Arn: arn,
    },
  };
}
