import { CdkdError } from './base-errors.js';

/**
 * A DELIBERATE refusal to resolve an intrinsic function, as opposed to a
 * "the referenced thing does not exist" miss (issue
 * [#1740](https://github.com/go-to-k/cdkd/issues/1740)).
 *
 * The distinction exists for one consumer of THIS class: `Fn::Sub`'s variable
 * resolution, which speculatively tries `Ref` and then `Fn::GetAtt` and keeps
 * the raw `${...}` placeholder when neither resolves. That warn-and-keep is the
 * long-standing, deliberate behavior for a genuinely unknown variable — but a
 * bare `catch` around it also swallowed every REFUSAL raised on that PATH, so a
 * template that hard-fails when the reference sits in a resource property
 * silently degraded to shipping a literal `${Resource.Attribute}` to AWS when
 * the IDENTICAL reference was written inside an `Fn::Sub`.
 *
 * Throwing this class rather than a bare `Error` is what lets that catch
 * re-raise a refusal (carrying its own message and remedy) while leaving the
 * not-found path on warn-and-keep. Nothing else branches on THIS class;
 * `cdkd scrub` branches on the {@link CrossAccountSecretRefusalError} SUBCLASS,
 * for the reason group 3 below gives.
 *
 * **Throw sites split into three groups, and the enumeration is worth keeping
 * accurate** — an out-of-date one reads as "these are all of them", which is
 * how the #1730 site below went unlisted for three releases, and how the
 * cross-account `Fn::GetStackOutput` site in group 3 went unlisted from the
 * day it shipped. All live in the resolver family
 * (`src/deployment/intrinsic-function-resolver.ts` and `intrinsic-resolver/*.ts`):
 *
 * 1. Reachable from `Fn::Sub`'s `${LogicalId.Attribute}` form, i.e. the ones
 *    the laundering fix above is actually about: `guardedPhysicalIdFallback`'s
 *    ARN / URL shape hard-fail (the #1103 class), the `--strict-getatt`
 *    rejection, `rejectPlaceholderArnAttribute` (#1729), the
 *    unknown-account guard (#1730), which refuses a constructed value that
 *    needs the account id when STS did not answer, and the nested-stack
 *    MISSING-OUTPUT refusal
 *    ([#2270](https://github.com/go-to-k/cdkd/issues/2270)), which refuses an
 *    `Outputs.<Key>` the child does not declare rather than letting
 *    `guardedPhysicalIdFallback` serve the synthetic
 *    `arn:cdkd-local:...` physical id — that id starts with `arn:`, so the
 *    #1103 ARN-shape guard passes it; and the LIVE-READ refusals of issue
 *    [#3096](https://github.com/go-to-k/cdkd/issues/3096)
 *    (`refuseUnservedAttribute`, raised by the `AWS::EC2::Instance` address /
 *    DNS / zone arm, the `AWS::EC2::VPC` `DefaultSecurityGroup` arm and the
 *    `AWS::CloudFront::Distribution` `DomainName` arm when the record omits
 *    the attribute and the live read finds nothing or fails), plus the
 *    read-less `AWS::RDS::DBProxy` / `DBProxyEndpoint` `VpcId` refusal beside
 *    them — each replacing a physical id the attribute's value type can never
 *    accept; and `lookupResourceRecord`'s refusal of a state record whose
 *    `physicalId` is not a string
 *    ([#3576](https://github.com/go-to-k/cdkd/issues/3576)), which both `Ref`
 *    and `Fn::GetAtt` reach, and so both `${...}` forms; and
 *    `subListRefusal`, raised BY `resolveSub` itself for a `${...}` or a
 *    variable-map value that resolves to a list
 *    ([#3809](https://github.com/go-to-k/cdkd/issues/3809)).
 * 2. NOT reachable from it, and thrown as this class only so that "deliberate
 *    refusal" is a property of the THROW rather than of the one catch that
 *    inspects it: `resolveSplit`'s two refusals of a non-string value (#1874),
 *    `resolveSelect`'s refusal of an index that does not resolve to a
 *    non-negative integer ([#3574](https://github.com/go-to-k/cdkd/issues/3574))
 *    or is past the end of its list ({@link SelectOutOfBoundsRefusalError}),
 *    and `refuseCoercedInheritedSecret`, which refuses an already-resolved
 *    value whose type cannot be coerced. Their non-reachability has two
 *    DIFFERENT reasons, so do not collapse them: a `${...}` placeholder cannot
 *    syntactically contain an `Fn::Split` or `Fn::Select`, while
 *    `refuseCoercedInheritedSecret` runs in the
 *    nested-stack PARAMETER pre-pass, before any `Fn::Sub` is resolved. Neither
 *    changes behavior by being this class.
 * 3. PERMANENT — the one site where no user action and no re-run can make the
 *    read succeed: `resolveGetStackOutput`'s cross-account refusal to resolve a
 *    producer account's redacted dynamic reference with the consumer's
 *    credentials. It throws the SUBCLASS
 *    {@link CrossAccountSecretRefusalError} rather than this class, because
 *    every site in groups 1 and 2 is USER-FIXABLE (correct the stale
 *    placeholder ARN, deploy the producer so STS resolves, enrich the
 *    `Fn::GetAtt`, drop `--strict-getatt`, fix the malformed `Fn::Split` or
 *    `Fn::Select` index, repair the record's `physicalId`, `Fn::Join` a list
 *    before substituting it,
 *    correct the nested stack's output name, declare the nested-stack parameter
 *    `Type: String`) and a
 *    consumer that treats "permanent" as a property of the CLASS silently
 *    downgrades every one of them. `cdkd scrub`'s cross-stack pre-pass is that consumer:
 *    it records a permanent refusal as a FINDING and scrubs the rest of the
 *    stack, but must REFUSE the stack for a fixable one, since a re-run after
 *    the fix would scrub it (issue
 *    [#2133](https://github.com/go-to-k/cdkd/issues/2133) review). Match on the
 *    subclass, never on this class.
 *
 * The class is deliberately NOT `markNonRetryable` at construction, unlike
 * `ResourceUpdateNotSupportedError`: two kinds of throw site are
 * genuinely time-dependent — the unknown-account guard, where
 * `getAccountInfo` never caches a failed lookup precisely so a later attempt
 * can heal, and since issue #3096 the LIVE-READ refusals
 * (`refuseUnservedAttribute`), where a `pending` instance settles seconds
 * later and a failed describe can succeed on the next attempt — so a
 * constructor-level marker would wrongly DECLARE those terminal (whether
 * `withRetry` then retries one is the classifiers' call, and that helper's
 * doc comment says what they actually see). Every OTHER
 * site marks at its own `throw` (the #3096 `DBProxy` `VpcId` refusal
 * included — it has no live read, so it decides from the record alone): each
 * decides from inputs a retry cannot change (a persisted state record, an
 * attribute-name suffix, a CLI flag, an already-resolved value's type, a
 * template's literal `RoleArn`, a child stack's declared output names), and
 * each interpolates
 * template-controlled text into their message, which the
 * SUBSTRING-matching retry classifiers can read as transient (issue #1838 —
 * a logical id like `MyDependencyViolationHandler` is enough). So the split is
 * "which SITE can heal", not "which class"; do not read the unmarked class as
 * a statement that these refusals are retryable.
 */
export class IntrinsicResolutionRefusalError extends CdkdError {
  constructor(message: string, cause?: Error, code = 'INTRINSIC_RESOLUTION_REFUSAL') {
    super(message, code, cause);
    this.name = 'IntrinsicResolutionRefusalError';
    Object.setPrototypeOf(this, IntrinsicResolutionRefusalError.prototype);
  }
}

/**
 * `resolveSelect`'s refusal of an index past the end of its resolved list
 * (go-to-k/cdkd#6181), in group 2 of {@link IntrinsicResolutionRefusalError}.
 * CloudFormation refuses such a template outright, so a SUBCLASS lets
 * `evaluateConditions` re-raise it instead of downgrading the condition to
 * false, which would prune (and so delete) a resource CloudFormation never
 * gets to evaluate.
 */
export class SelectOutOfBoundsRefusalError extends IntrinsicResolutionRefusalError {
  constructor(message: string) {
    super(message, undefined, 'SELECT_OUT_OF_BOUNDS');
    this.name = 'SelectOutOfBoundsRefusalError';
    Object.setPrototypeOf(this, SelectOutOfBoundsRefusalError.prototype);
  }
}

/**
 * The ONE refusal in group 3 of {@link IntrinsicResolutionRefusalError}: a
 * cross-account `Fn::GetStackOutput` whose stored value is a redacted dynamic
 * reference (issue [#2133](https://github.com/go-to-k/cdkd/issues/2133)
 * review).
 *
 * A SUBCLASS rather than a flag, so the two properties stay independent:
 * `instanceof IntrinsicResolutionRefusalError` is still true, which is what
 * `resolveSub`'s catch re-raises on (making this refusal propagate out of an
 * `Fn::Sub` instead of being laundered into a literal `${...}`), while
 * consumers that need "no re-run can change this" match on THIS class and
 * therefore cannot capture its user-fixable siblings.
 *
 * `code` is distinct for the same reason a message is not: a consumer keying
 * on `INTRINSIC_RESOLUTION_REFUSAL` would capture every sibling, and one
 * keying on message text breaks the moment the wording improves.
 *
 * `cdkd scrub` is the consumer today. Its cross-stack pre-pass records a
 * refusal of THIS class as an unverifiable FINDING — the rest of the stack is
 * still scrubbed, and the run exits non-zero — because refusing the whole
 * stack would strand every other secret in it forever. A sibling refusal
 * (a stale placeholder ARN, an unenriched `Fn::GetAtt`, a malformed
 * `Fn::Split`, all reachable through an `Fn::Sub`-built export name) must
 * REFUSE instead, since the user can fix the cause and re-run.
 */
export class CrossAccountSecretRefusalError extends IntrinsicResolutionRefusalError {
  constructor(message: string, cause?: Error) {
    super(message, cause, 'INTRINSIC_RESOLUTION_REFUSAL_CROSS_ACCOUNT_SECRET');
    this.name = 'CrossAccountSecretRefusalError';
    Object.setPrototypeOf(this, CrossAccountSecretRefusalError.prototype);
  }
}

/**
 * An `Fn::GetStackOutput` whose PRODUCER's state record has no readable
 * `outputs` map (issue [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * A SUBCLASS for the same reason {@link CrossAccountSecretRefusalError} is
 * one, and with the same two independent properties.
 * `instanceof IntrinsicResolutionRefusalError` stays true, so `resolveSub`'s
 * catch re-raises it rather than laundering the reference into a literal
 * `${...}` shipped to AWS; and the one consumer that must treat it
 * DIFFERENTLY from its user-fixable siblings matches on THIS class.
 *
 * That consumer is `cdkd scrub`'s cross-stack pre-pass, and the distinction it
 * needs is neither of the two the base class already carries. A sibling
 * refusal makes scrub REFUSE the stack, on the sound argument that the user
 * can fix the cause and re-run. Here the cause is ANOTHER STACK's record,
 * which the user may not own — so refusing would strand THIS stack's own
 * plaintext in `state.json` over a file they cannot repair. Issue
 * [#3192](https://github.com/go-to-k/cdkd/issues/3192) settled that trade one
 * layer down, for the classifier this refusal now runs ahead of
 * (`docs/design/3192-outputs-consumers.md` §6), and the same answer has to
 * hold here or closing the resolver would silently reverse it: scrub records
 * an unverifiable FINDING, scrubs the rest of the stack, does not report it
 * clean, and exits 2.
 *
 * It is NOT `CrossAccountSecretRefusalError`, whose subclass identity means
 * PERMANENT — "no re-run can change this". A damaged record IS repairable;
 * what it is not is repairable by everyone who meets it.
 *
 * `code` is distinct for the reason the sibling's note gives: a consumer
 * keying on `INTRINSIC_RESOLUTION_REFUSAL` would capture every sibling, and
 * one keying on message text breaks the moment the wording improves.
 */
export class MalformedProducerRecordRefusalError extends IntrinsicResolutionRefusalError {
  constructor(message: string, cause?: Error) {
    super(message, cause, 'INTRINSIC_RESOLUTION_REFUSAL_MALFORMED_PRODUCER_RECORD');
    this.name = 'MalformedProducerRecordRefusalError';
    Object.setPrototypeOf(this, MalformedProducerRecordRefusalError.prototype);
  }
}

/**
 * A `{{resolve:...}}` reference whose REGION cannot be established (issue
 * [#2134](https://github.com/go-to-k/cdkd/issues/2134)): it names no region,
 * and the stack it sits in is on record as reading across a region boundary.
 *
 * A SUBCLASS rather than a bare code, because the consumers that must not
 * swallow it identify it by CLASS. `cdkd scrub` wraps its resolution passes in
 * best-effort `catch { logger.debug }` blocks so that one unresolvable resource
 * does not abandon the rest of the scrub -- and a refusal swallowed there is
 * the exact outcome the refusal exists to prevent: no needle is recorded for
 * the reference, the plaintext survives in `state.json`, and the command
 * reports `No plaintext secrets found` and exits 0. The pre-pass refusals in
 * `scrub.ts` are placed OUTSIDE those catches for the same reason; this one
 * fires from inside `resolveDynamicReferences`, so it cannot be placed --
 * it has to be re-raised.
 *
 * USER-FIXABLE, so it deliberately does NOT extend
 * {@link CrossAccountSecretRefusalError}, whose subclass identity marks the one
 * PERMANENT refusal `scrub.ts`'s `isByDesignRefusal` reports as unclearable.
 * Spelling the reference as a full ARN names its region and clears this.
 *
 * The CODE names the domain (`DYNAMIC_REFERENCE_REGION_AMBIGUOUS`) rather than
 * carrying the base class's `INTRINSIC_RESOLUTION_REFUSAL_` prefix its one
 * sibling uses. Deliberate: no consumer keys on that prefix, so it is not a
 * contract, and the prefixed spelling would read
 * `INTRINSIC_RESOLUTION_REFUSAL_DYNAMIC_REFERENCE_REGION_AMBIGUOUS`. Consumers
 * that must act on this identify it by CLASS, which is what the subclass is
 * for.
 */
export class DynamicReferenceRegionAmbiguousError extends IntrinsicResolutionRefusalError {
  constructor(message: string, cause?: Error) {
    super(message, cause, 'DYNAMIC_REFERENCE_REGION_AMBIGUOUS');
    this.name = 'DynamicReferenceRegionAmbiguousError';
    Object.setPrototypeOf(this, DynamicReferenceRegionAmbiguousError.prototype);
  }
}
