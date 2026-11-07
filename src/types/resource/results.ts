/**
 * The properties a provider ACTUALLY delivered to AWS, when they differ from
 * the desired bag it was handed (issue #1591).
 *
 * The deploy engine persists the DESIRED properties into cdkd state. That is
 * right almost always — but a provider that deliberately NARROWS the bag makes
 * the record describe something AWS never holds, and `readCurrentState` can
 * only ever return what AWS does hold, so the difference becomes PERMANENT
 * phantom drift: `cdkd drift` reports it on every run and `drift --revert`
 * "fixes" it by calling `update()` again, which re-narrows and re-reports.
 * That is the #1552 junk-state class, and it is the provider — not the
 * engine — that knows what was dropped.
 *
 * Returning this field lets the provider hand back the bag it actually sent,
 * which the engine records INSTEAD of the desired one. Absent (the normal
 * case) means "record the desired properties", so no provider needs to change.
 *
 * Two things this is NOT:
 *
 * - It is not a place to report AWS-side defaults or computed values. Those
 *   belong in `observedProperties` (captured by a real read-back); putting
 *   them here would make the DESIRED baseline drift away from the template and
 *   silently disable the #1160 absent-field removal derivation, which reads
 *   the previous side.
 * - It is not a licence to drop a value the provider merely failed to send.
 *   Narrowing must already be a deliberate, ANNOUNCED decision (a warn arm),
 *   or recording it hides the loss instead of surfacing it.
 */
export interface EffectivePropertiesResult {
  /**
   * The properties actually delivered. Recorded verbatim in place of the
   * desired bag, so it must be a COMPLETE replacement, not a patch.
   *
   * An EXPLICIT `undefined` is accepted (and means the same as absent) so a
   * provider can spell the decision as one always-present key --
   * `effectiveProperties: skipped ? bag : undefined` -- where a conditional
   * spread would hide the key from a source-shape fence that reads return
   * literals (`tests/unit/scripts/integ-secret-fixture-sweep.test.ts`). Every
   * consumer already gates on truthiness or `=== undefined`.
   */
  effectiveProperties?: Record<string, unknown> | undefined;
}

/**
 * The provider's declaration that the `attributes` it is returning are
 * SENSITIVE and must not be persisted in the clear (issue
 * [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * ONE producer today: `CustomResourceProvider`, relaying the documented
 * `NoEcho: true` field of the CloudFormation custom-resource RESPONSE envelope,
 * by which a handler declares its own `Data` sensitive. cdkd declared that
 * field and read it nowhere, so a handler-GENERATED secret was persisted
 * verbatim into `state.json`.
 *
 * TWO SHAPES, because two producers answer at different granularities.
 * {@link NoEchoAttributesResult.noEchoAttributes} is WHOLE-BAG, matching the
 * wire format: `NoEcho` is a property of the RESPONSE, so a handler declares
 * the response sensitive rather than one member of its `Data`, and inventing a
 * per-member granularity there would be inventing a contract AWS does not have.
 * {@link NoEchoAttributesResult.noEchoAttributeNames} is the PER-ATTRIBUTE one,
 * and it exists because `NestedStackProvider` has a genuinely different fact to
 * report: its attributes are a whole child stack's OUTPUTS, of which typically
 * one carries a `NoEcho` value and the rest are ordinary. Declaring the bag
 * whole there would mask every unrelated output of that child into the parent's
 * record and into every parent resource that consumes one — degrading resources
 * that have nothing to do with the secret.
 *
 * WHAT THE ENGINE DOES WITH IT, and what it deliberately does NOT do. It
 * registers each returned string leaf as a MASK-ONLY redaction needle
 * (`recordMaskOnlyValue`) for this resource and for every dependent that
 * resolves an `Fn::GetAtt` against it, so `state.json` stores `***`. It does
 * NOT mask at CAPTURE: `Fn::GetAtt` keeps resolving to the REAL value, because
 * CloudFormation delivers the plaintext to a dependent resource (measured
 * against real CloudFormation on the issue thread — the AWS doc sentence about
 * asterisks describes the DISPLAY channel, not the wire). Masking at capture
 * would make a template feeding this `Data` into
 * `AWS::SecretsManager::Secret.SecretString` store the literal mask AS the
 * secret.
 *
 * NOT PERSISTED. There is no per-attribute `NoEcho` on `ResourceState`, so this
 * declaration lives for one deploy only; a LATER deploy that does not re-invoke
 * the handler has no flag, which is why the persisted `attributes` carry the
 * mask itself as the signal. Giving state a durable flag is a v9 -> v10 schema
 * bump with its own migration integ and is tracked by issue
 * [#2449](https://github.com/go-to-k/cdkd/issues/2449).
 */
export interface NoEchoAttributesResult {
  /**
   * `true` when every member of `attributes` is sensitive. Absent means "not
   * sensitive", so no provider needs to change.
   */
  noEchoAttributes?: boolean;
  /**
   * The SUBSET of `attributes` keys that are sensitive, for a provider whose
   * bag mixes sensitive and ordinary members. Ignored when
   * {@link noEchoAttributes} is `true` (the whole bag already covers it) and
   * ignored for a name the returned `attributes` does not carry, so a stale
   * declaration cannot register a needle out of nothing.
   *
   * One producer today: `NestedStackProvider`, naming the `Outputs.<Key>`
   * entries whose value it recovered from a child output THIS RUN masked.
   */
  noEchoAttributeNames?: readonly string[];
  /**
   * The `attributes` keys whose value holds the name of a resource NAMED from
   * a secret (go-to-k/cdkd#3869): KEYS only, never a value. One producer:
   * `NestedStackProvider`, naming each `Outputs.<Key>` that carries a child
   * resource's secret-derived name (a name its provider rewrote or case-folded,
   * which no recorded plaintext spells). The engine persists them as
   * `ResourceState.secretNamedAttributes`, which the derived-name judge reads
   * so a parent `Fn::GetAtt Child.Outputs.<Key>` reader masks what it prints,
   * on a later deploy where the row is `NO_CHANGE` too. Print-only: nothing
   * persisted, compared or sent changes.
   */
  secretNamedAttributeNames?: readonly string[];
}

/**
 * Resource creation result
 */
export interface ResourceCreateResult extends EffectivePropertiesResult, NoEchoAttributesResult {
  /** Physical resource ID */
  physicalId: string;
  /** Resource attributes for Fn::GetAtt resolution */
  attributes?: Record<string, unknown>;
}

/**
 * The data half of {@link ResourceUpdateResult}, split out only so the outcome
 * can be a discriminated union intersected onto it.
 */
interface ResourceUpdateResultBase extends EffectivePropertiesResult, NoEchoAttributesResult {
  /** Physical resource ID (may be different if resource was replaced) */
  physicalId: string;
  /** Whether the resource was replaced (new physical ID) */
  wasReplaced: boolean;
  /** Updated resource attributes */
  attributes?: Record<string, unknown>;
  /**
   * The update sent NOTHING to AWS (go-to-k/cdkd#4443): Cloud Control's patch
   * from record to template came out empty. Only a provider that can tell
   * sets it; absent means "may have written".
   */
  sentNothing?: true;
}

/**
 * What a provider's `update` actually LEFT BEHIND (issue
 * [#1819](https://github.com/go-to-k/cdkd/issues/1819)).
 *
 * The mirror of {@link ResourceDeleteResult}, and deliberately NOT the same
 * shape, because the two verbs fail differently:
 *
 * - `delete` can decline the whole job, so its union says whether the resource
 *   is gone (`'deleted'` / `'skipped'`).
 * - `update` cannot. Four providers implement a REPLACEMENT inside `update()`
 *   by pairing create and delete (`acm-certificate`, `iam-managed-policy`,
 *   `iam-role` create-then-delete; `sns-subscription` delete-then-create), and
 *   by the time the inner delete is attempted the NEW resource already exists.
 *   Aborting there would strand an untracked resource, which is worse than the
 *   residue. So the resource under management IS updated — what is in doubt is
 *   the OLD one the replacement was supposed to retire.
 *
 * Hence `'partial'` rather than a second `'skipped'`: the row is not a failure
 * and must not be counted as one, but it is not a clean `'updated'` either.
 * Before this existed the honest verdict had nowhere to go, so the three
 * create-then-delete providers emitted a `logger.warn` and the deploy exited 0
 * with the old resource alive and no longer in cdkd state — discoverable only
 * by reading the log.
 *
 * `'partial'` means: **the resource named by this result was updated, and
 * something the update was responsible for retiring was NOT retired.** The
 * `reason` carries what, in the same short form the destroy path prints.
 *
 * Returning no `outcome` means `'updated'`, so the ~80 providers that already
 * return a bare `{ physicalId, wasReplaced }` need no change.
 *
 * There is deliberately no `'skipped'` member: an `update()` that cannot touch
 * the resource at all throws (`ResourceUpdateNotSupportedError` and friends),
 * and adding a value no producer emits would be an unreachable enum member
 * inviting mis-wiring. Widening the union later is a one-line change — the
 * same call the delete side made when it dropped `'already-absent'`.
 */
export type ResourceUpdateOutcome =
  | {
      /** The update completed with nothing left behind. Same as omitting it. */
      readonly outcome?: 'updated';
      /**
       * Never set on this arm. Present as `never` so a `reason` handed in
       * WITHOUT an `outcome: 'partial'` is a compile error rather than a
       * silently ignored field.
       */
      readonly reason?: never;
    }
  | {
      /**
       * The resource was updated, but something the update was responsible for
       * retiring survives and is no longer tracked by cdkd.
       */
      readonly outcome: 'partial';
      /**
       * One line saying what survived, rendered inline on the per-resource
       * status line and carried into the `RESOURCE_SKIPPED` deployment event.
       * Providers normally also `logger.warn` the full remediation text; this
       * is the short form.
       *
       * A DISCRIMINATED union rather than an optional `reason`, so "required on
       * partial" is enforced by the compiler instead of only asserted in a doc
       * comment — a row reading a bare `partial` with no cause is barely better
       * than the `updated` it replaced. Same reasoning as
       * {@link ResourceDeleteResult}.
       */
      readonly reason: string;
      /**
       * go-to-k/cdkd#4911: set by a provider that replaced the resource inside
       * `update()` and could not delete the OLD one. `'kept'` only when AWS
       * refused that delete outright, so no deletion is running; absent reads
       * as `'unconfirmed'`. The deploy journals it as
       * `oldResourceMaySurvive`, which a rollback reads before re-creating.
       */
      readonly oldResourceSurvivor?: 'kept' | 'unconfirmed';
    };

/**
 * Resource update result: the data the caller needs, plus what the update left
 * behind (see {@link ResourceUpdateOutcome}).
 */
export type ResourceUpdateResult = ResourceUpdateResultBase & ResourceUpdateOutcome;

/**
 * One PRE-FLIGHT SAFETY GUARD that RAN, could NOT reach a verdict, and was
 * therefore not enforced — cdkd proceeded with the operation anyway (issue
 * [#2301](https://github.com/go-to-k/cdkd/issues/2301)).
 *
 * Proceeding is deliberate wherever a guard reports one of these: refusing on
 * an unanswerable probe would strand least-privilege operators who never
 * granted the permission the probe needs. What was NOT acceptable is that the
 * outcome existed only as a `logger.warn` on a terminal that scrolls away —
 * because the attack the guards exist to catch is precisely one that DISABLES
 * a probe (an `s3:GetBucketLocation` `Deny` in a bucket policy, settable by
 * anyone holding `s3:PutBucketPolicy` on the target). After the run, a destroy
 * that proceeded WITHOUT confirming its target was indistinguishable from one
 * that confirmed it. A provider has no access to the deployment-event recorder
 * (`git grep DeploymentEventRecorder -- src` reaches only the destroy runner,
 * the deploy engine, the store and the types module), so the delete's RETURN
 * VALUE is the structured channel back to the caller that does.
 *
 * Metadata only, exactly like `ResourceDeleteResult.reason`: provider-authored
 * prose about the IDENTIFIER and the probe, never resource properties.
 */
export interface IndeterminateGuard {
  /**
   * Stable machine-readable id of the guard that could not answer, e.g.
   * `cc-delete-region-identity`. Deliberately NOT a per-resource-type or
   * per-API name: the persisted event is a user contract, and the next guard
   * to grow an indeterminate arm should reuse this shape with its own id
   * rather than mint a second event type.
   */
  readonly guard: string;
  /**
   * One line saying why the guard could not answer, rendered beneath the
   * event by `cdkd events` and carried into the destroy summary's warning.
   * Distinct causes get distinct text even when they reach the same
   * proceed-anyway outcome, because the remediation differs (grant an IAM
   * permission vs. repair a state record vs. fix a credential chain).
   */
  readonly reason: string;
}

/**
 * What a provider's `delete` actually DID (issue
 * [#1752](https://github.com/go-to-k/cdkd/issues/1752)).
 *
 * Before this existed, `delete` returned `Promise<void>` and the destroy
 * runner's only signal was "did not throw" — so a warn-and-continue arm that
 * issued NO AWS call at all was printed as `✓ <id> (<type>) deleted` and
 * counted toward `N deleted`, while the AWS resource stayed alive. Reporting
 * an outcome lets the runner tell the two apart.
 *
 * - `'deleted'` — cdkd addressed the resource: an AWS delete call was issued
 *   and succeeded, OR the resource was already gone (`*NotFound` idempotent
 *   arms, `CustomResourceProvider`'s backing-Lambda-is-gone pre-check). Either
 *   way the resource is not there any more, so counting it as deleted is
 *   honest.
 * - `'skipped'` — cdkd could NOT address the resource, so it may still be
 *   ALIVE. The runner prints a distinct line, counts it separately, KEEPS the
 *   state record, and exits non-zero.
 *
 *   The invariant is "the resource this result names was NOT destroyed" — it
 *   is deliberately NOT "no AWS call was issued", and reading it that way is a
 *   mistake a future caller could build on. Most producers DO issue no call —
 *   the malformed-composite-physicalId delete arms, plus the eight arms issue
 *   [#1770](https://github.com/go-to-k/cdkd/issues/1770) converted, where the
 *   state record is missing the id or the property the delete is addressed BY
 *   (Lambda layer / permission, Custom Resource, IAM policy / user-group).
 *   `NestedStackProvider.delete` is the one that does not: it recursed into the
 *   child's own destroy and so may have DELETED the child's other resources
 *   before reporting that the child stack as a whole was not destroyed. That
 *   single exception is why the invariant is worded about the ROW rather than
 *   about the call.
 *
 * The issue's sketch had a third value, `'already-absent'`, splitting the
 * idempotent arms out of `'deleted'`. It is deliberately NOT here: no call
 * site produces it and no consumer would treat it differently from
 * `'deleted'` (the runner already has its own message-matched
 * "already deleted" branch), so it would be an unreachable enum member
 * inviting mis-wiring. Widening the union later is a one-line change.
 *
 * Returning nothing (`undefined`) means `'deleted'`, so the ~80 providers
 * that already return `void` need no change.
 *
 * Both arms additionally carry `indeterminateGuards` (issue
 * [#2301](https://github.com/go-to-k/cdkd/issues/2301)) — see
 * {@link IndeterminateGuard}. It is an OPTIONAL FIELD on the EXISTING arms
 * rather than a third `outcome` member, and that choice is load-bearing:
 * a suppressed guard says nothing about whether the resource was addressed,
 * so it is orthogonal to `outcome`. A third member would also break every
 * consumer by construction — returning nothing already means `'deleted'` (the
 * paragraph above says so, and the ~80 providers that return `void` rely on
 * it), so every existing caller reads "not `'skipped'`" as "deleted". A new member
 * would silently join the deleted side at some call sites and need explicit
 * handling at others, while an optional field is invisible to callers that
 * do not read it.
 */
export type ResourceDeleteResult =
  | {
      /** cdkd addressed the resource — identical to returning `void`. */
      readonly outcome: 'deleted';
      /**
       * Part of what the resource wrote was deliberately LEFT, because cdkd
       * could not prove it was still the resource's own (go-to-k/cdkd#4612: a
       * failed `AWS::SQS::QueuePolicy`'s queue now carrying another policy).
       * One plain-prose line, never a physical id. A caller that reads it
       * warns and counts it toward exit 2; one that does not reads the
       * outcome as `'deleted'`, as before.
       */
      readonly leftInPlace?: string;
      /**
       * Pre-flight safety guards that could not reach a verdict on this
       * operation. See {@link IndeterminateGuard}.
       */
      readonly indeterminateGuards?: readonly IndeterminateGuard[];
    }
  | {
      /**
       * Pre-flight safety guards that could not reach a verdict on this
       * operation. See {@link IndeterminateGuard}. Present on this arm too:
       * a guard that could not answer and a delete that could not be
       * addressed are independent facts, and a provider can report both (an
       * `AWS::AutoScaling::AutoScalingGroup` whose Cloud-Control delete runs
       * the pre-flight and then delegates to a `ResourceProvider` that
       * reports `'skipped'` is the shape that produces the pair).
       */
      readonly indeterminateGuards?: readonly IndeterminateGuard[];
      /**
       * cdkd could NOT address the resource this result names, so it was NOT
       * destroyed and may still be ALIVE.
       *
       * Deliberately NOT "no AWS call was issued" — see the invariant in the
       * block comment above. Most producers do issue no call, but
       * `NestedStackProvider.delete` reports `'skipped'` after its recursion
       * has already DELETED the child's other resources.
       */
      readonly outcome: 'skipped';
      /**
       * One line saying why, rendered inline on the per-resource status line
       * (`⚠ MyTable (AWS::Glue::Table) skipped (<reason>)`) and carried into
       * the `RESOURCE_SKIPPED` deployment event. Providers normally also
       * `logger.warn` the full remediation text; this is the short form.
       *
       * A DISCRIMINATED union rather than one interface with an optional
       * `reason`, so "required on skipped" is enforced by the compiler instead
       * of only asserted in a doc comment — a skip whose line reads a bare
       * `skipped` with no cause is barely better than the `deleted` it
       * replaced.
       */
      readonly reason: string;
    };

/**
 * Input passed to a provider's `import` method.
 *
 * Carries everything a provider needs to find an existing AWS resource that
 * corresponds to a logicalId in the user's CDK template:
 * - the logicalId itself (sometimes embedded in physical names),
 * - the resource's CDK path (`aws:cdk:path` tag) for tag-based lookup,
 * - the parent stack name and AWS region,
 * - the template properties (often contain explicit names like `BucketName`
 *   that bypass the tag lookup entirely).
 */
export interface ResourceImportInput {
  /** Logical ID from the CDK template (e.g., `MyBucket`). */
  logicalId: string;

  /** CloudFormation resource type (e.g., `AWS::S3::Bucket`). */
  resourceType: string;

  /** Physical CloudFormation stack name (used for naming-pattern fallback). */
  stackName: string;

  /** AWS region the resource lives in. */
  region: string;

  /** Properties from the template (resolved as far as possible). */
  properties: Record<string, unknown>;

  /**
   * Caller-supplied physical id, e.g. via `--resource MyBucket=my-bucket` or
   * `--resource-mapping`. When set, the provider should treat it as ground
   * truth: verify the resource exists and fetch attributes, but do NOT
   * search. When `undefined`, the provider performs its own lookup
   * (tag-based, name-based, etc.).
   */
  knownPhysicalId?: string;
}

/**
 * Result returned by a provider's `import` method.
 *
 * `null` from the provider means "no matching resource found in AWS" — the
 * caller (state-import command) marks it as skipped, not as a failure, since
 * the user's template might reference resources that have not been deployed.
 */
export interface ResourceImportResult {
  /** Physical resource ID. */
  physicalId: string;
  /** Resource attributes for `Fn::GetAtt` resolution (same shape as `create` returns). */
  attributes?: Record<string, unknown>;
}
