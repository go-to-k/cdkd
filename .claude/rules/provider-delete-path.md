---
description: Provider delete path - delete context (expectedRegion region check, forceDataDelete), warn-and-continue arms, recursion, skip reporting
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - the delete path

This file documents how providers CALL the `assertRegionMatch()` region-check helper. The helper itself lives in `src/provisioning/region-check.ts`, which this file's `paths:` glob does NOT match -- editing the helper loads [layout-provisioning.md](layout-provisioning.md), not this file. Masking rules: [provider-masking.md](provider-masking.md).

Provider interface, registry, Custom Resources, and "Adding a New SDK Provider": [providers.md](providers.md).

**`delete()` deliberately has no masker, and the reason is about PROVIDERS, not
about the bag.** A delete bag CAN carry plaintext: the in-process rollback hands
`replayRollback` the IN-MEMORY `stateResources`, whose `properties` a CREATE set
to the resolved plaintext, and redaction happens at the save choke point on a
COPY. What is true is that no provider `delete()` interpolates a property value
today. Threading one correctly is not mechanical either — that plaintext was
resolved by the DEPLOY, whose bag lives in `DeployEngine.perResourceSecrets`,
while the executor's own per-op map is re-resolved from the PREVIOUS generation,
so a masker bound to it would miss exactly the value it exists to catch. Before
adding any delete-side log line that names a property value, thread the
capability first. Filed as issue #2007.

`EC2Provider.createRoute` IS such a provider since issue #1566 — it refuses a
multi-destination template on create AND is re-created from `updateRoute` — and
it shows the shape that satisfies the constraint: the refusal is behind a
CALLBACK parameter that `updateRoute` passes UNCONDITIONALLY, so the re-create
can never fire it. Note the callback covers only that guard; `createRoute`'s
required-field check is still a hard error on the post-delete path, which is
why the safe pattern is "downgrade the refusal", not "assume update() is
throw-free".

The `context.expectedRegion` parameter on `delete` is the region recorded
in the stack state when the resource was created. Providers MUST verify
the AWS client's region against `context.expectedRegion` (via the shared
`assertRegionMatch()` helper in `src/provisioning/region-check.ts`)
before treating a `*NotFound` error as idempotent delete success — see
"DELETE idempotency" below and [docs/provider-development.md](../../docs/provider-development.md).

**That call is the REACTIVE one, and since issue [#2301](https://github.com/go-to-k/cdkd/issues/2301) it is no longer the only shape.** Two things changed for a provider AUTHOR, neither of which changes the call above: `expectedRegion` is now on `UpdateContext` too (`src/types/resource.ts`), threaded by `deploy-engine.ts` / `rollback-executor.ts` / `drift --revert`; and `assertRegionMatch()` takes an optional trailing `RegionCheckPhase` whose DEFAULT is the `NotFound` wording, so every existing provider call site is unchanged and none needs editing. An SDK provider MAY read `context.expectedRegion` in its own `update()` — `S3BucketProvider` is the only one with an update-side region guard today, and it still compares against the deploy's own region (the remaining half of issue [#2245](https://github.com/go-to-k/cdkd/issues/2245)) — but nothing requires it: absent, the helper is a no-op exactly as on the delete side. The UNCONDITIONAL pre-flight form of the check lives in `CloudControlProvider`, outside this file's `paths:` glob; see [layout-provisioning.md](layout-provisioning.md).

`context.forceDataDelete` (issue #1340) is explicit user consent to destroy
the DATA a resource still contains — set ONLY by the deploy engine's
replacement / recreate delete sites when `--force-stateful-recreation` was
passed, never by plain `cdkd destroy`. Providers whose delete API fails by
default on contained data (S3 bucket / S3 Express directory bucket
auto-empty, ECR `force: true`) MUST
gate that force-cleanup on this flag OR a template-borne opt-in (CDK's
`aws-cdk:auto-delete-objects` / `aws-cdk:auto-delete-images` tags,
`EmptyOnDelete: true` — shared helpers in
`src/provisioning/data-delete-intent.ts`), and otherwise surface AWS's
not-empty error like CloudFormation's DELETE_FAILED. Do NOT add
unconditional force-cleanup to a new provider's delete — verify CFn's
actual delete behavior by live A/B first (CFn hard-deletes more than
folklore says: SecretsManager no-recovery-window and IAM role
force-detach are PARITY, verified 2026-08-02).

`context.finalSnapshotIdentifier` (issue #1352) means the resource's
`DeletionPolicy` is `Snapshot`: the provider MUST create a final snapshot
under that identifier as part of the delete — the atomic-parameter types
(RDS DBInstance / DBCluster, Neptune / DocDB clusters, ElastiCache
CacheCluster) flip their delete call from `SkipFinalSnapshot: true` to the
API's final-snapshot form. The delete call sites only pass the field for
types in `ATOMIC_FINAL_SNAPSHOT_TYPES`
(`src/provisioning/final-snapshot.ts`) on the SDK route; the
`PRE_DELETE_SNAPSHOT_TYPES` (EC2 Volume, Redshift Cluster, ElastiCache
ReplicationGroup — issue #1353) are snapshotted engine-side pre-delete via
`createPreDeleteFinalSnapshot`, and any other Snapshot-tagged shape
(cc-api routing included) is refused before any delete. The call sites are
`cdkd destroy` / `cdkd state destroy` (`destroy-runner.ts`), the deploy
engine's DELETE + replacement / recreate deletes
(`prepareFinalSnapshotForDelete`), and — since issue #1358 — the rollback of
a CREATE (`rollback-executor.ts`'s `delete-with-final-snapshot` action,
driving both the automatic post-failure rollback and `cdkd rollback`), plus
the FAILED in-flight CREATE's delete under `cdkd rollback --revert-failed`
(`delete-failed-create-with-final-snapshot`, issue #1362 — same matrix, same
refusals). When
adding final-snapshot support for a new type, extend the sets there — never
make a provider silently ignore the field.

**A warn-and-continue DELETE arm must REPORT the skip** (issue
[#1752](https://github.com/go-to-k/cdkd/issues/1752)). `delete` returning
normally means "the resource is gone" — a delete call succeeded, or it was
already absent (the `*NotFound` idempotent arms, `CustomResourceProvider`'s
backing-Lambda-is-gone pre-check). Both are honest. An arm that issues NO AWS
call is not: `cdkd destroy`'s only signal used to be "did not throw", so the
five malformed-composite-physicalId arms printed `✓ <id> (<type>) deleted`,
counted toward `N deleted`, DROPPED the state record and exited 0 over a
resource that may still be alive. Such an arm returns
`{ outcome: 'skipped', reason }` — in practice `compositeIdSkipResult()` from
`composite-id.ts`, beside the existing `{ skipping: true }` warning. The runner
then prints `⚠ … skipped (<reason>)`, counts a separate `skippedCount`, emits
`RESOURCE_SKIPPED`, KEEPS the state record (dropping it is the second half of
the loss — neither the resource deleted nor an id to delete it with), preserves
`state.json`, and exits 2.

**A provider that RECURSES into another destroy must propagate the child's
skip.** `NestedStackProvider.delete` drives `runDestroyForStack` for the child
stack; discarding that result re-creates the mis-report one level up — the
parent prints `✓ <Child> (AWS::CloudFormation::Stack) deleted`, drops the
child's row from parent state and exits 0, while the child's own `state.json`
is sitting there preserved describing a live resource. It returns
`{ outcome: 'skipped' }` when `childResult.skippedCount > 0` OR
`childResult.interrupted` — a SIGINT mid-child is the same data loss reached
through another field.

**But a child result carries THREE such fields, and the third one is a THROW,
not a skip** (issue [#1777](https://github.com/go-to-k/cdkd/issues/1777)).
`childResult.errorCount > 0` means a child resource was ATTEMPTED and FAILED,
so the parent's `AWS::CloudFormation::Stack` row must FAIL exactly as any other
type's failed delete does; reporting it as a skip would be a lie in the other
direction, since a skip asserts no AWS call was issued. Swallowing it was worse
than a dangling pointer: with the parent's own `errorCount` still 0 its
`preserveState` evaluated to FALSE, so the parent deleted its `state.json` AND
the exports index and exited 0, leaving the child's preserved `state.json`
describing live resources with nothing naming it. This was a deliberate
BEHAVIOR CHANGE, and it reaches BOTH callers of `delete()`: `cdkd destroy` /
`cdkd state destroy` (the parent's row fails, exit 2) AND `cdkd deploy`, where
REMOVING a nested stack from the template routes the row through the deploy
engine's DELETE path — so a failing child now fails the DEPLOY and triggers its
rollback. That asymmetry is worth internalizing before adding a throw anywhere:
a `{ outcome: 'skipped' }` return value reaches the deploy-side call sites too
since issue #1762, but WEAKER there (the template-removal DELETE warns and keeps
the record rather than failing the ROW), whereas a throw fails the resource at
every one of them. "Weaker" is about the row, not about the RUN: since issue
[#1960](https://github.com/go-to-k/cdkd/issues/1960) the skip still makes the
deploy exit 2 at the end, unless `--allow-unaddressed` is passed.

Three more details generalize to any provider that recurses:

- the throw's wording must avoid `not found` / `does not exist` / `No policy
  found` / `NoSuchEntity` / `NotFoundException` (plus the deploy engine's
  `was not found` / `ResourceNotFoundException`), since both callers' catch
  blocks read those as an idempotent already-deleted success and DROP the state
  row — the very outcome the throw exists to prevent;
- the split between the three fields is decided by what was ATTEMPTED, not by
  whether the run was clean, so do not collapse them into one "anything
  non-clean throws" rule; and
- a REMEDY printed for a failed nested-stack row must name the CHILD's state
  file. `destroy-runner.ts` collects `failedStateTargets` alongside #1752's
  `skippedStateTargets` for exactly this: its last-resort
  `cdkd state orphan <target>` hint used to name the parent, which would drop
  the `Child` row the throw just preserved.

**A provider that DELEGATES a delete, or pairs create + delete inside its own
`update()`, must not discard the result either** (issue
[#1778](https://github.com/go-to-k/cdkd/issues/1778)). The delegation case is
the nested-stack hole one layer down — `CloudControlProvider` hands a protected
ASG to `ASGProvider.delete` under `--remove-protection`, so it now
`return await`s the delegate (typed as `ResourceProvider`, so the forwarding
survives the delegate widening its own return type). The chosen contract is
PROPAGATE rather than ASSERT-it-cannot-skip: an assertion needs re-verifying
every time the delegate grows an arm, and it fails LOUDLY on a case the
delegate considers merely unaddressable. The REPLACE case splits on ORDERING,
because a skip does not throw and therefore bypasses exactly the `catch` that
would have told the user: **create-then-delete** (ACM certificate, IAM managed
policy, IAM role, and the API Gateway Resource PathPart replacement) cannot
abort — the new resource exists — so each WARNS in the same orphan wording the
failure arm uses AND, since issue
[#1819](https://github.com/go-to-k/cdkd/issues/1819), reports
`{ outcome: 'partial', reason }` on its `ResourceUpdateResult` so the deploy
engine can count and record the survivor; **delete-then-create** (SNS subscription) ABORTS
with a `ProvisioningError` before creating the replacement, since continuing
would leave two subscriptions delivering every message twice and that duplicate
is exactly what the CREATE would add. **ONE rule covers BOTH failure arms** —
cdkd creates the replacement only when the old resource is PROVEN gone. #1778
scoped its abort to the SKIP arm and left the THROWN delete warning and
creating anyway, on the argument that a throw is AMBIGUOUS (the delete may have
partially landed, been transient, or found the resource already gone) and
converging is the better bet. Issue
[#1967](https://github.com/go-to-k/cdkd/issues/1967) reversed that: the
ambiguity is real but the conclusion does not follow: cdkd must not issue a
CREATE whose precondition it failed to establish, and the abort's downside is a
failed deploy a retry converges on. Note which arm actually FIRES: `delete()`
wraps a real AWS failure in a `ProvisioningError`, so the THROW arm is the live
one, while the skip families here are still latent. When you add an abort, cover
both arms in one place — a guard on one of them is the shape this defect had.
**Reachability at THIS exemplar, measured rather than assumed** (#1967, review):
the duplicate cannot occur here, because SNS enforces uniqueness on (topic,
protocol, endpoint) — a repeated `Subscribe` with identical attributes returns
the same `SubscriptionArn`, and with different attributes it is REFUSED — and
those three fields are exactly this type's `createOnlyProperties`, so a change
to any of them routes to the deploy engine's own replacement branch and never
reaches `update()`. The duplicate needs the endpoint to differ, which happens
only when `cloudformation:DescribeType` is unavailable and
`create-only-properties.ts` degrades an endpoint change into an in-place update.
So the gain here is error QUALITY (the failure names the DELETE that failed,
non-retryably, instead of a downstream `Subscribe` rejection) and the rule holds
for the degraded case. Do not restate the duplicate as this site's live harm —
it is the RULE's justification, not this exemplar's measured outcome. State the premise as **"the resource was
not destroyed"**, never as "no AWS call was issued" — `ResourceDeleteResult`'s
contract warns against the second reading, since `NestedStackProvider` reports
`skipped` after a recursion that may already have deleted things; the abort is
right under the weaker premise anyway. An abort added to an `update()` path has
to be right for EVERY caller — `deploy`, `drift --revert`, and the rollback
executor's revert arms — per the update-path rule above; downgrade to a warning
where it is not. Two mechanical details it inherits: do NOT interpolate the
provider-supplied `reason` into the thrown message (the rollback arms wrap
`update()` in `withRetry` and `retryable-errors.ts` classifies by SUBSTRING, so
a reason carrying `does not exist` / `Rate exceeded` / `because it is in use`
would burn the whole backoff schedule before a certain failure — log it
instead, and interpolate nothing but the TEMPLATE logical id: the state-borne
physical id is the worst candidate, since the only skip family a REPLACE path
meets today is literally "malformed physicalId in state"), and then
`markNonRetryable` the error, because the message discipline alone cannot close
the hole — the match is a SUBSTRING, so an ordinary composite logical id like
`MyDependencyViolationSub` still carries a pattern (measured) and a message
naming nothing is not diagnosable. The marker (a non-enumerable `Symbol.for`
key in `retryable-errors.ts`, walked down the `.cause` chain) is consulted by
`isRetryableTransientError` BEFORE any name or message heuristic, so a
cdkd-authored refusal is terminal by DECLARATION. The fence is at the RETRY
LOOP rather than in that one classifier: `withRetry` rethrows a marked error
ahead of the `opts.isRetryable ? ... : ...` branch, and the destroy runner's
delete loop gates its own `Too Many Requests` message test the same way — so
the message-only classifiers (`isNameCollisionError`'s `AlreadyExists`,
`isNameCooldownError`'s `QueueDeletedRecently` / `StateMachineDeleting`, all
of which match a bare logical id) cannot resurrect a refusal even though they cannot read the marker
themselves, and no classifier signature had to widen. Also point the
remediation at the STATE record as well as at AWS, since neither skip family
shipping today (the state-borne composite-id arms, `NestedStackProvider`'s
propagation) is repaired by deleting the AWS resource alone. All six sites were LATENT when #1778 shipped, and the SKIP
families STAY latent even after #1770 lands — that issue's eight arms
are in `lambda-layer` / `lambda-permission` / `custom-resource` / `iam-policy` /
`iam-user-group`, none of which `CloudControlProvider` delegates to or any of
the four REPLACE `update()`s calls, and neither `iam-role` nor
`iam-managed-policy` is in its table (`AWS::IAM::Policy` is a different type and
a different file from `AWS::IAM::ManagedPolicy`). So the reason to fix them is
that they land the mechanism BEFORE any skip arm reaches these five providers,
not that #1770 specifically arms them — and the SNS abort is why
`logPendingConfirmationSkip`'s two CFn-parity delete-SUCCESS arms carry an
in-code note NOT to convert them: a skip there would abort every deploy of a
`PendingConfirmation`-adopted subscription, with no flag to force it.

Three things about it are decisions rather than accidents. The exit code is
**not** a new policy: it is the same "state preserved, stack not destroyed"
contract `errorCount > 0` and a graceful interrupt already carry, so a run that
leaves a resource behind cannot report success. The outcome union is TWO values,
not the three the issue sketched — `'already-absent'` had no producer and no
consumer that would treat it differently from `'deleted'`, and the runner
already has its own message-matched already-deleted branch. The DEPLOY-side callers
(`deploy-engine.ts`'s template-DELETE + replacement deletes,
`rollback-executor.ts`'s rollback deletes) consume the return value as of issue
[#1762](https://github.com/go-to-k/cdkd/issues/1762), each in the way its
situation allows: the template-removal DELETE warns and KEEPS the record (the
next deploy re-attempts it), a replacement delete FAILS the resource (its create
would otherwise run beside a live old one), and a rollback delete counts as a
per-op failure so the journal segment is kept for a re-run — except at the
delete-the-NEW-resource-after-re-creating-the-old arm, whose delete is already
best-effort (the revert succeeded and state points at the old resource), where a
skip warns and counts as a WARNING, leaving the new resource untracked. The eight same-class arms
OUTSIDE the composite-id family were converted by issue
[#1770](https://github.com/go-to-k/cdkd/issues/1770): both malformed
`LayerVersionArn` arms, the missing-`FunctionName` Lambda-permission arm, the
Custom Resource no-properties / no-`ServiceToken` pair, the empty-policy-name
IAM arm, and both `AWS::IAM::UserToGroupAddition` arms. Each exports its
`reason` as a named constant beside the provider (there is no shared literal —
the destroy line must be able to say WHICH half of the record is broken), and
the wording is pinned by a test. Do NOT reach for a skip when you know the
resource is gone: it would preserve state and fail the destroy for no reason.

**A lenient `catch` on a delete path is the same arm reached through a throw**
(issue [#2033](https://github.com/go-to-k/cdkd/issues/2033)).
`CustomResourceProvider.delete` warned and returned `undefined` when the Delete
request failed — and `undefined` is DELETED, so a permanent
`lambda:InvokeFunction` denial printed `✓ … deleted`, dropped the state record
and exited 0 over a handler that never received a `Delete`, silently orphaning
everything it manages together with the id needed to reach it. Warn-and-continue
is still right (a destroy must not abort on one custom resource), but the
OUTCOME has to be `'skipped'`. Two details generalize: the premise is **"the
resource was not destroyed"**, not "no AWS call was issued" — the handler may
have run and failed, or run and had its response lost, and both leave it
unproven — and the AWS message goes in the WARNING while the `reason` stays a
FIXED constant, because a reason is rendered into the `Error` the deploy-side
replacement sites throw and their catch classifies "already deleted" by
SUBSTRING, so an AWS text carrying `does not exist` would bin the record one
layer further out. When auditing a provider for this class, read its `catch`
arms, not only its guards.

**EXHAUST every addressable source before reporting a skip** (the #1770 code
review, and the reason a skip is not a free "safe" default). A skip is not
inert: it preserves the state record, prints a warning and makes `cdkd destroy`
exit 2 — and it repeats on every re-run, so the destroy can never go green. So
a guard reading ONE source and skipping is a defect wherever a second source
carries the same value. Two of the eight arms were exactly that. The Lambda
permission guard read only `properties['FunctionName']`, while the physicalId's
documented `<functionArn>|<statementId>` shape — the same shape the code
immediately below it already splits for the statementId — carries the function
ARN, which `RemovePermission` accepts as `FunctionName`. The IAM policy guard
derived the name only from the physicalId, while `PolicyName` is in
`handledProperties` and `create()` uses it VERBATIM as the real AWS name. The
audit question is "what else in the bag or the id names this resource", and it
is worth asking at every skip arm; the other six have genuinely no second
source (a layer's version number is AWS-assigned and appears in no property, a
Custom Resource's teardown needs the `ServiceToken`, and a
`UserToGroupAddition`'s physicalId is just the logicalId). Order the sources by
what was DEPLOYED, not by convenience: the physicalId wins over
`properties['PolicyName']`, because a template edit that changed the name
without a replacement having landed would otherwise send a `DeleteRolePolicy`
for a name AWS never had.

**A fallback is only as good as its VALIDATION, and adding one can make things
WORSE than the skip it replaced** (the #1770 delta review — three ways the two
fallbacks above nearly shipped a silent DELETED over a live resource).

- **Apply the `typeof` guard to BOTH sources, not just the one you thought of.**
  The IAM policy fallback got `typeof x === 'string'`; its Lambda sibling did
  not, so a truthy NON-string (`{ Ref: 'MyFn' }`, `['my-fn']`) beat a perfectly
  good ARN. The SDK URI-encodes it: `[object Object]` comes back
  `ResourceNotFoundException` and the IDEMPOTENT arm then reports DELETED, while
  an array coerces to a bare name nothing validated and the call can SUCCEED
  against the wrong function. An emptiness test cannot see either — `''` is
  falsy and the `||` chain rejects it anyway, so the shapes worth testing are a
  number, an intrinsic object and an array.
- **Check the fallback's REGION.** A provider holds ONE client, at the stack's
  region, so an ARN from another region sends the call to the WRONG region,
  comes back `ResourceNotFoundException`, and is reported DELETED by the
  idempotent arm while the real resource stays live. cdkd has no client that
  could reach it, so the skip is the honest answer. A bare NAME carries no
  region and is resolved against this client, which is correct.
- **Do not let the gate refuse a genuine second source.** The Lambda gate
  required an `arn:` prefix, but the CFn primary identifier is
  `[FunctionName, Id]` and `FunctionName` is often a BARE name — so the gate
  declined a real id and put the arm back in the class this rule exists to
  remove. It is safe to accept because `StatementId` forbids `|`, so a `|` can
  only ever be the composite separator. The in-code justification for a gate
  must be CHECKED against the service's own pattern rather than assumed; the
  first version's stated reason ("a statementId that happens to contain `|`")
  was impossible.

**A guard that lets a record through must check that the path it opens actually
DOES something.** The same review found the IAM `PolicyName` fallback converting
an honest `skipped` into a silent `deleted`: with the name resolvable the guard
passed, but an inline policy exists only as an ATTACHMENT, and a record naming
no `Roles` / `Groups` / `Users` and no legacy role segment reaches a body where
every branch is skipped — zero AWS calls, `return undefined`, i.e. DELETED. The
zero-call hole pre-dated the fallback (`physicalId: 'MyPolicy'` with empty
properties already reached it); the fallback merely ROUTED formerly-skipped
records into it, which is what made it this change's problem. When adding a
guard, trace the path it now admits all the way to an AWS call. And use the SAME
truthiness spelling the branches downstream use — a `=== undefined` test would
let a null-valued `Roles` (which a hand-edited or pre-v7 state file carries)
fall through into the very hole being closed, while `!roles` matches the loops
and keeps a PRESENT-but-empty `Roles: []` an honest `deleted`.

**"LEFT IN PLACE" is FALSE when the resource's parent is in the same stack**
(same review). After a skip the destroy keeps going, and for four of the eight
arms the very next deletes remove the skipped resource anyway — `deleteGroup`
-> `removeAllUsersFromGroup` and `deleteUser` -> `removeUserFromAllGroups`
remove exactly those memberships, deleting a Lambda function drops its whole
resource policy, deleting an IAM role drops its inline policies. So AWS ends
CLEAN while cdkd prints a warning claiming an orphan, exits 2, keeps the record
and repeats forever. Qualify the wording ("unless the group / function / role
is itself part of this stack") and name `cdkd state orphan <stack>` as what
clears the record. Do NOT copy the qualifier onto an arm where it is false — a
Lambda layer version is standalone and a Custom Resource's external side
effects are undone by nothing — since a false reassurance is worse than the
warning it softens.

**"Repair state.json and re-run" holds on DESTROY and on the deploy engine's
template-removal DELETE** — both keep the record (issue #1762). It does NOT hold
for a deploy-side REPLACEMENT or rollback delete: those fail the resource, and
the replacement path can leave the old resource untracked. Every skip warning carries the caveat
`compositeIdFormatMessage` already carries for the composite-id family; a
remedy that is impossible on the path the user is actually on is worse than no
remedy.

**A DEBUG level is not evidence that an arm is routine** (the #1770 judgment
call, worth re-running rather than inheriting). The two `UserToGroupAddition`
arms logged at DEBUG, which reads as "nothing to do" — but `GroupName` and
`Users` are BOTH required by the CloudFormation schema, so a record missing
either is CORRUPT, not empty, and `AddUserToGroup` really did put users in the
group, so those memberships survive the destroy with every permission the group
grants. They are skips, and the level is now WARN: a skip preserves state and
exits non-zero, so a normal-verbosity run has to say why. The genuinely routine
neighbour is an EMPTY `Users: []` — an array is truthy, so it falls through to
the removal loop, does nothing, and correctly reports `deleted`. Ask what the
CFn schema makes REQUIRED and what the create path actually did, not what level
the author picked.
