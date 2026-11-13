import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import type { DeleteContext } from '../../region-check.js';
import { stateOrphanRecordRemedy } from '../../state-orphan-remedy.js';
import type { MaskerFn } from '../../masked-retry-logger.js';

/**
 * The DELETE path's masker (go-to-k/cdkd#2007): the caller's
 * `DeleteContext.maskSecrets`, composed with the re-resolved `NoEcho` values'
 * own when there are any (go-to-k/cdkd#4682). Both are functions, so they run
 * in turn rather than as one union pass, the wider one first.
 *
 * `undefined` when neither exists: every cdkd delete site passes a masker, so
 * that is a direct caller passing no `DeleteContext.maskSecrets`. Never an
 * identity function: a `MaskerFn` that fences nothing reads as a check that
 * ran, and `scripts/check-provider-secret-mask.ts` refuses one. That arm of the
 * payload refusal stays the critic's counted `EXEMPT` row, since the context
 * stays optional.
 */
export function deletePathMasker(
  callerMask: MaskerFn | undefined,
  noEchoMask: MaskerFn | undefined
): MaskerFn | undefined {
  if (callerMask === undefined) return noEchoMask;
  if (noEchoMask === undefined) return callerMask;
  // The NoEcho bag holds the resolved bag's needles too
  // (`noecho-delete-reresolution.ts` seeds it from the deploy's bag), so it runs
  // FIRST: a caller needle inside a longer NoEcho value would otherwise cut it
  // and print its head and tail.
  return (text) => callerMask(noEchoMask(text));
}

/**
 * The short `ResourceDeleteResult.reason` the no-properties DELETE arm reports
 * (issue [#1770](https://github.com/go-to-k/cdkd/issues/1770)).
 *
 * Rendered inline on the destroy status line, so it is the SHORT form; the full
 * remediation sentence goes out as the `logger.warn` beside it.
 */
export const CR_NO_PROPERTIES_SKIP_REASON = 'no properties in state — Delete handler not invoked';

/**
 * Sibling of {@link CR_NO_PROPERTIES_SKIP_REASON} for the arm where properties
 * exist but carry no `ServiceToken`. Distinct because the repair differs: one
 * record lost everything, the other lost the one field that names the handler.
 */
export const CR_NO_SERVICE_TOKEN_SKIP_REASON =
  'no ServiceToken in state — Delete handler not invoked';

/**
 * Sibling of {@link CR_NO_SERVICE_TOKEN_SKIP_REASON} for a record whose
 * `ServiceToken` is the redaction mask (go-to-k/cdkd#3938). A dependent custom
 * resource reading a `NoEcho` value equal to, or contained in, its own
 * ServiceToken persists `ServiceToken: "***"`, and that mask used to reach
 * `GetFunction` and the Delete invoke as a function name. Distinct because
 * the repair differs: the field is present, but what it held was redacted.
 */
export const CR_MASKED_SERVICE_TOKEN_SKIP_REASON =
  'masked ServiceToken in state — Delete handler not invoked';

/**
 * A record whose recorded `ResourceProperties` hold the `***` mask at a
 * coordinate its `noEchoLeaves` names (go-to-k/cdkd#4043, schema v11): a
 * `NoEcho` parameter value, or an attribute its producer declared `NoEcho`,
 * that cdkd does not keep. Sending the mask would hand the handler a `Delete`
 * request whose properties are not the ones it was created with, and a
 * handler that tears down by a property value would act on `***`. Skipped
 * instead, the record kept, the same shape as the redacted-address skip,
 * unless the caller re-resolved EVERY such coordinate from the template it
 * holds (`DeleteContext.noEchoDeleteValues`, go-to-k/cdkd#4682).
 */
export const CR_NOECHO_PROPERTIES_SKIP_REASON =
  'NoEcho mask in recorded properties — Delete handler not invoked';

/**
 * Sibling of {@link CR_NOECHO_PROPERTIES_SKIP_REASON} for a `***` NO
 * `noEchoLeaves` coordinate names (go-to-k/cdkd#4682): a mask embedded through
 * `Fn::Join`, a record a pre-v11 binary wrote, or one `cdkd import` /
 * `cdkd scrub` wrote. Nothing names what it stood for, so it cannot be
 * re-resolved, and sending it is the hazard the NoEcho skip exists for.
 */
export const CR_MASKED_PROPERTIES_SKIP_REASON =
  'redaction mask in properties — Delete handler not invoked';

/** When a NoEcho coordinate IS re-resolved on delete (go-to-k/cdkd#4682). */
export const NOECHO_RERESOLUTION_BOUND =
  `cdkd re-resolves such a coordinate only where it holds the template ('cdkd destroy' ` +
  `with the app, or 'cdkd deploy --recreate-via-cc-api' naming this resource), and only ` +
  `while today's template reads a NoEcho parameter there with the property's text and inputs unchanged; ` +
  `an attribute a producer declared NoEcho has no template value to re-resolve.`;

/** The NoEcho-mask skip's remedy for this delete's phase. */
export function noEchoPropertiesRemedy(
  context: DeleteContext | undefined,
  logicalId: string
): string {
  return context?.stackDestroy === true
    ? `cdkd is KEEPING the state record and the run exits non-zero, and every re-run skips it again. ` +
        `Tear down what the handler manages by hand, then drop the record with ${stateOrphanRecordRemedy(context, logicalId)}.`
    : `This delete is not part of a stack destroy (a 'cdkd deploy' template removal, replacement or rollback, ` +
        `or a 'cdkd rollback'). For a resource removed from the template the record is KEPT and every ` +
        `'cdkd deploy' skips it again: tear down what the handler manages by hand. ` +
        crDeploySkipTail(logicalId);
}

/**
 * Sibling of {@link CR_MASKED_SERVICE_TOKEN_SKIP_REASON} for a record whose
 * `ServiceToken` holds a `{{resolve:...}}` token (go-to-k/cdkd#3960). State
 * keeps a SECRET reference's expression rather than its value, so a template
 * ServiceToken built from `{{resolve:secretsmanager:...}}` /
 * `{{resolve:ssm-secure:...}}` is recorded as that expression, and the delete
 * path used to send it to Lambda as a function name. A plain
 * `{{resolve:ssm:...}}` is normally stored RESOLVED, but one embedded in a
 * longer leaf can still be recorded as its expression wherever no type proof
 * was available (issue #2036), so the
 * arm matches any token and its wording does not assume a secret.
 *
 * A skip rather than resolving the reference: CloudFormation does not support
 * SECURE dynamic references in custom resources at all, so the main shape here
 * exists only because cdkd deployed a template CloudFormation does not support
 * (which it refuses pre-flight since go-to-k/cdkd#3976; an older record stays),
 * and the delete path has no resolver to spend on reviving it. The
 * "exhaust every addressable source" rule (provider-delete-path.md) does not
 * reach it: the record holds no address, only a pointer to a secret or
 * parameter.
 */
export const CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON =
  'dynamic reference as ServiceToken in state — handler not invoked';

/**
 * Third sibling of the two above, for the arm where cdkd HAD everything it
 * needed and the Delete request still could not be completed — a permanent
 * `lambda:InvokeFunction` denial, an exhausted readiness waiter, a response
 * that never arrived.
 *
 * That arm used to swallow the error and return `undefined`, which
 * `deleteSkipReason` reads as DELETED: `cdkd destroy` printed `✓ … deleted`,
 * dropped the state record and exited 0 over a handler that never received a
 * `Delete` — silently orphaning everything that handler manages. It is the
 * same silent-orphan class issue
 * [#1752](https://github.com/go-to-k/cdkd/issues/1752) removed from the two
 * arms above, reached through the catch rather than through a guard.
 *
 * **Fixed wording, no interpolation.** The underlying AWS message goes out on
 * the `logger.warn` beside it and NOT into the reason, because a `reason` is
 * rendered into the `Error` the deploy-side replacement sites throw, whose
 * catch classifies an already-deleted resource by SUBSTRING — an AWS message
 * carrying `does not exist` / `not found` would make a skip read as "already
 * gone" and drop the record again, one layer further out. Same rule the
 * `sns-subscription` abort follows.
 *
 * The premise is "the resource was NOT destroyed", not "no AWS call was
 * issued": the handler may have run and failed, or run and had its response
 * lost. Both leave the resource unproven, which is what a skip asserts.
 */
export const CR_DELETE_INVOKE_FAILED_SKIP_REASON =
  'Delete request to the handler did not complete — resource unproven';

/**
 * Fourth sibling of the three above, for the arm where the handler RAN, was
 * reached, and answered `Status: 'FAILED'` (issue
 * [#2054](https://github.com/go-to-k/cdkd/issues/2054)).
 *
 * The terminal FAILED arm used to warn and fall through to `return undefined`,
 * which `deleteSkipReason` reads as DELETED — so cdkd dropped the state
 * record, printed the row as deleted and exited 0 over a resource the handler
 * had EXPLICITLY said it did not delete. It is the same silent-orphan class
 * {@link CR_DELETE_INVOKE_FAILED_SKIP_REASON} removed from the throw arm,
 * reached through the handler's RESPONSE instead.
 *
 * **Unconditional, with no already-gone classifier.** A handler that reports
 * FAILED because the thing it manages was already absent is a real and common
 * shape, and today's leniency lets those destroys finish green. Classifying
 * the reason to keep them green was rejected: the reason is free text a user's
 * handler writes, so any classifier is a guess, and a wrong guess
 * re-introduces exactly the orphan this arm exists to stop.
 *
 * This is therefore a COMPATIBILITY BREAK: a destroy whose delete handler
 * reports FAILED now exits 2 with the record kept, where it used to exit 0
 * with the record dropped.
 *
 * **The two callers have DIFFERENT escape hatches, and only one of them is a
 * flag.** On `cdkd deploy` the skip is forced back to exit 0 by
 * `--allow-unaddressed` (issue #1960, the flag that settled the analogous
 * exit-code question). `cdkd destroy` has no such flag — a skip raises
 * `PartialFailureError` unconditionally (`src/cli/commands/destroy.ts`) — so
 * there the remedy is the one that command's own summary names: confirm the
 * resource is gone, then drop the record with
 * `cdkd state orphan <stack> --stack-region <region>`.
 * Messages must not offer the flag on the destroy path, which is the path this
 * arm is mostly reached from.
 *
 * **Fixed wording, no interpolation**, for the reason spelled out on
 * {@link CR_DELETE_INVOKE_FAILED_SKIP_REASON}: the handler's own `Reason` is a
 * user-authored string, it goes out on the `logger.warn` beside this, and a
 * `Reason` carrying `does not exist` / `not found` would make the deploy-side
 * replacement sites classify the skip as "already gone" and drop the record
 * one layer further out.
 */
export const CR_DELETE_HANDLER_FAILED_SKIP_REASON =
  'Delete handler reported FAILED — resource unproven';

/**
 * Fifth sibling, for the issue-#804 pre-check: `GetFunction` on the
 * ServiceToken answered `ResourceNotFoundException`, so the Delete handler can
 * never be invoked (go-to-k/cdkd#2115).
 *
 * That arm used to return `undefined`, which `deleteSkipReason` reads as
 * DELETED, on the reasoning that a handler which can never run again leaves
 * nothing to track. It inverted the burden of proof: cdkd cannot invoke the
 * handler, so it cannot know that what the handler manages is gone. Its most
 * common caller made that concrete — a record a PRIOR destroy kept because the
 * handler refused (#2054) or the invoke failed (#2033), after which that same
 * run deleted the backing Lambda; the next destroy dropped the record and exited
 * 0 over a resource the handler had explicitly refused to remove.
 *
 * **Scoped to a STACK DESTROY** (`DeleteContext.stackDestroy`), following
 * CloudFormation where the phases differ. There a custom resource whose delete
 * cannot be confirmed leaves a stack DELETE `DELETE_FAILED` and the user
 * retries with `RetainResources`; cdkd's escape is
 * `cdkd state orphan <stack> --stack-region <region>`, safe there because only
 * the records the destroy kept remain. Within a destroy it is unconditional —
 * no "a prior run skipped this" classifier, which would need a durable signal
 * in the state schema — so the legitimate shape turns red too (a shared
 * provider stack destroyed before its consumers).
 *
 * A deploy-engine delete (template removal, replacement, rollback) keeps the
 * older warn-and-drop: CloudFormation ignores delete failures in an update's
 * cleanup phase, and a kept record there would fail EVERY later deploy with no
 * escape short of orphaning the whole live stack.
 *
 * Fixed wording, clear of every already-deleted phrase the deploy-side
 * classifiers substring-match (see {@link CR_DELETE_INVOKE_FAILED_SKIP_REASON}).
 */
export const CR_BACKING_LAMBDA_GONE_SKIP_REASON =
  'backing Lambda function is gone — Delete handler not invoked';

/**
 * The deploy-side caveat both skip warnings in this file carry (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)).
 *
 * "Repair state.json and re-run" is only true on DESTROY, where the skip KEEPS
 * the record. The same arms are ALSO reached from `deploy-engine.ts` and
 * `rollback-executor.ts`, which discard the delete result and DROP the record —
 * there the id is gone, so re-running cannot help and the resource has to be
 * torn down by hand. Mirrors the caveat `compositeIdFormatMessage` already
 * carries for the composite-id family.
 */
/**
 * The bound BOTH delete-path skips in this file have to state (found in review
 * of issue [#2054](https://github.com/go-to-k/cdkd/issues/2054)).
 *
 * A skip KEEPS the state record, and the natural thing to promise is that a
 * re-run retries the handler. **On `cdkd destroy` that promise is false**, and
 * it is false in the direction that matters. `destroy-runner.ts` walks every
 * reverse-DAG level regardless of skips, so the SAME run that skipped the
 * custom resource goes on to delete its backing Lambda. The next
 * `cdkd destroy` therefore reaches the issue-#804 pre-check, finds the
 * function gone, and — since go-to-k/cdkd#2115 — skips the resource again
 * ({@link CR_BACKING_LAMBDA_GONE_SKIP_REASON}): the record is kept and the run
 * exits non-zero, but the handler is never reached. So the record is described
 * here as what it actually is — a POINTER to something that has to be torn
 * down by hand — rather than as a retry that will not happen.
 *
 * Printed only on a STACK DESTROY (`DeleteContext.stackDestroy`): its
 * `cdkd state orphan` remedy is safe only once the stack's other records are
 * gone. Every other delete names {@link CR_DEPLOY_HANDLER_SKIP_REMEDY}
 * instead (go-to-k/cdkd#4596).
 */
export function crSkipNotARetryCaveat(
  context: DeleteContext | undefined,
  logicalId: string
): string {
  return (
    `NOTE this record is a POINTER, not a retry: the same destroy run deletes the backing Lambda, ` +
    `so the next 'cdkd destroy' cannot reach the handler either: it skips this resource again and keeps the record (issue 2115). ` +
    `Tear the resource down by hand, then drop the record with ${stateOrphanRecordRemedy(context, logicalId)}.`
  );
}

export const DEPLOY_SKIP_CAVEAT =
  `NOTE this arm is ALSO reached from cdkd deploy. Since issue 1762 the DELETE of a resource ` +
  `removed from the template behaves like destroy — the record is KEPT and the next deploy ` +
  `re-attempts it — but a REPLACEMENT / rollback delete FAILS the resource instead ` +
  `(https://github.com/go-to-k/cdkd/issues/1762), leaving the old one untracked; there, tear the resource down by hand.`;

/**
 * go-to-k/cdkd#4596: the remedy a custom-resource skip names when the delete
 * is NOT part of a stack destroy — a `cdkd deploy` template removal,
 * replacement or rollback (`DeleteContext.stackDestroy` absent).
 *
 * The destroy-side advice, `cdkd state orphan <stack>`, is safe there only
 * because the destroy has already deleted every other record. Here the stack
 * is still deployed, so that command drops the record of every LIVE resource
 * in it and the next deploy re-creates or collides with all of them; and
 * `cdkd orphan '<stack>/<path>'` needs the construct the deploy just removed.
 * The escapes that do exist on this path: the template-removal delete KEEPS
 * the record (`deploy-engine/delete.ts`), so the next deploy re-attempts it;
 * the backing-Lambda-gone arm DROPS the record outside a stack destroy;
 * `--allow-unaddressed` forces exit 0; and, since go-to-k/cdkd#4602,
 * `cdkd state orphan <stack> --resource <logicalId>` drops this one record. A
 * delete-first replacement or a rollback delete usually fails the resource and
 * keeps the record (issue #1762); where the other copy already exists (a
 * create-first replacement, a rollback that re-created the old one first) it
 * only warns, leaving the surviving copy untracked.
 */
export function crDeployNoStateOrphan(logicalId: string): string {
  // go-to-k/cdkd#4602: the single-record drop, and only for a resource the
  // template no longer declares. Where the template still declares it (a
  // replacement's or rollback's other copy, an update) dropping the record
  // makes the next deploy send a fresh Create to the handler. The helper's
  // sentence also warns off the bare whole-stack form.
  return (
    `For a resource removed from the template, to give up on the delete and stop tracking it, ` +
    `drop the record with ${stateOrphanRecordRemedy(undefined, logicalId)}.`
  );
}

export function crDeploySkipTail(logicalId: string): string {
  return (
    `Meanwhile 'cdkd deploy --allow-unaddressed' exits 0 (a deploy-only flag; 'cdkd rollback' has none); ` +
    `the record stays and each deploy re-attempts the delete. ` +
    `A delete-first REPLACEMENT or a rollback delete usually FAILS the resource and keeps the record ` +
    `(https://github.com/go-to-k/cdkd/issues/1762). Where the other copy already exists (a replacement that ` +
    `created the new resource first, or a rollback that re-created the old one first), the skip only warns ` +
    `and the surviving copy is no longer tracked, so tear it down by hand. ` +
    crDeployNoStateOrphan(logicalId)
  );
}

/** The handler-FAILED and invoke-failed arms, outside a stack destroy. */
export const CR_DEPLOY_HANDLER_SKIP_HEAD =
  `This delete is not part of a stack destroy (a 'cdkd deploy' template removal, replacement or rollback, or a 'cdkd rollback'). ` +
  `For a resource removed from the template the record is KEPT and the next 'cdkd deploy' re-sends the Delete: ` +
  `fix what made it fail (the handler's Delete logic, or what stopped the invoke) and re-deploy. That reaches ` +
  `the handler only while its function exists: if this deploy also deleted the backing Lambda, the next deploy ` +
  `finds it gone and DROPS the record with a warning, so tear down what the handler manages by hand. `;

/** The masked and `{{resolve:...}}` ServiceToken arms, outside a stack destroy. */
export const CR_DEPLOY_UNADDRESSABLE_HEAD =
  `This delete is not part of a stack destroy (a 'cdkd deploy' template removal, replacement or rollback, or a 'cdkd rollback'). ` +
  `For a resource removed from the template the record is KEPT and every 'cdkd deploy' skips it again until ` +
  `ServiceToken is restored: put the provider's Lambda function or SNS topic ARN back in state.json and ` +
  `re-deploy, which sends the Delete while that handler exists. If its Lambda function is gone, that deploy ` +
  `DROPS the record with a warning instead, so tear down what the handler manages by hand. `;

/** The masked and `{{resolve:...}}` ServiceToken arms, on a stack destroy. */
export function crDestroyUnaddressableRemedy(
  context: DeleteContext | undefined,
  logicalId: string
): string {
  return (
    `Tear the resource down by hand, then drop the record with ${stateOrphanRecordRemedy(context, logicalId)}. ` +
    `Restoring ServiceToken (the provider's Lambda function or SNS topic ARN) in state.json and re-running ` +
    `helps only while that handler still exists: a destroy goes on to delete its backing Lambda.`
  );
}

/**
 * The handler-FAILED / invoke-failed tail for this delete's phase
 * (go-to-k/cdkd#4596), starting with its own separator. "KEEPING the state
 * record" is stated only on a stack destroy: on a deploy a create-first
 * replacement's cleanup skip only warns and the record is replaced, so the
 * deploy remedy scopes the kept record to a template removal instead.
 */
export function handlerSkipRemedy(context: DeleteContext | undefined, logicalId: string): string {
  return context?.stackDestroy === true
    ? ` — cdkd is KEEPING the state record and the run exits non-zero. ${crSkipNotARetryCaveat(context, logicalId)}`
    : `. ${CR_DEPLOY_HANDLER_SKIP_HEAD}${crDeploySkipTail(logicalId)}`;
}

/**
 * The cause and recovery an unresolved (non-string) ServiceToken names on
 * update (go-to-k/cdkd#4596). A deploy update reads ServiceToken from the NEW
 * template-resolved bag (`deploy-engine/update-in-place.ts`); the only caller
 * reading a recorded value is a rollback, through the journal's copy of the
 * previous state record. `cdkd drift --revert` never reaches this provider:
 * it skips custom resources (#323). A re-import changes none of these inputs,
 * so the fix is the template. No `cdkd state orphan` form at all, not even
 * `--resource`: the template still declares the resource, so dropping its
 * record makes the next deploy send the handler a fresh Create.
 */
export function crUnresolvedTokenUpdateRemedy(): string {
  return (
    `This indicates an unresolved value in the template, or, on a rollback, in the resource's recorded ` +
    `state. Check that the template resolves ServiceToken to the provider's Lambda function or SNS topic ` +
    `ARN and re-deploy; a rollback replays the recorded value, so restore the template and re-deploy ` +
    `instead. Do not drop this record with 'cdkd state orphan', with or without --resource: the template ` +
    `still declares the resource, so the next deploy would send the handler a fresh Create and leave what ` +
    `it already manages untracked.`
  );
}

/**
 * The create-side cause and recovery. A create reads the template-resolved
 * bag, or on a rollback the value the journal recorded; neither has a record
 * to repair, and a first deploy has no deployed stack to warn about.
 */
export const CR_UNRESOLVED_TOKEN_CREATE_REMEDY =
  `This indicates an unresolved value in the template, or, on a rollback, in the resource's recorded ` +
  `state. Check that the template resolves ServiceToken to the provider's Lambda function or SNS topic ` +
  `ARN; a rollback replays the recorded value, so restore the template and re-deploy instead.`;

/** The same recovery on delete, by phase (go-to-k/cdkd#4596). */
export function unresolvedTokenDeleteRemedy(
  context: DeleteContext | undefined,
  logicalId: string
): string {
  return context?.stackDestroy === true
    ? `re-run ${proseQuoted(cdkdRemedy('cdkd import'))}, or drop the record with ${stateOrphanRecordRemedy(context, logicalId)}, to recover.`
    : `put the provider's Lambda function or SNS topic ARN back as ServiceToken in state.json and ` +
        `re-run to recover. ${crDeployNoStateOrphan(logicalId)}`;
}

/** The masked / reference ServiceToken remedy for this delete's phase (go-to-k/cdkd#4596). */
export function unaddressableServiceTokenRemedy(
  context: DeleteContext | undefined,
  logicalId: string
): string {
  return context?.stackDestroy === true
    ? crDestroyUnaddressableRemedy(context, logicalId)
    : `${CR_DEPLOY_UNADDRESSABLE_HEAD}${crDeploySkipTail(logicalId)}`;
}
