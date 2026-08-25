---
description: Provider property fidelity - substituted values, dropped keys, never-emitted keys, and auditing who reads them
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - property fidelity on the wire

Preceded by [provider-replay-and-refusals.md](provider-replay-and-refusals.md); continued in [provider-diff-record-folds.md](provider-diff-record-folds.md).

Provider interface, registry, Custom Resources, and "Adding a New SDK Provider": [providers.md](providers.md).

**A SUBSTITUTED value is the same class as a dropped key, and it arrives by
more than one route** (issue #1633, the `AWS::EC2::SecurityGroupIngress`
`IpProtocol` twin of the Route fix). The obvious route is the warn-and-default
arm — `requireConfigString`'s `onUnusable` downgrade SENDS the default while
the engine records the malformed value the template wrote. The less obvious one
is a value the guard ACCEPTS by design: `coerceNumber` stringifies an unquoted
YAML `IpProtocol: -1` before sending it, so state held the number and
`readCurrentState` returned the string — the identical permanent phantom drift,
with no warning anywhere to hint at it. Both belong in `effectiveProperties`.
The "already ANNOUNCED" condition above is about not laundering a silent LOSS
into a clean record; a lossless coercion drops nothing, so it does not need a
warning to qualify. When auditing a provider for this class, read every arm
that can put a value on the wire that differs from the declared one, not only
the arms that log.

**But "lossless" is the wrong bar to carry away — the bar is "matches what AWS
HOLDS"** (issue #1643, the residual of #1633). Recording `'-1'` for a declared
`-1` works because AWS reports `-1` back; the number-to-string coercion is
incidental. It is NOT the rule. Measured us-east-1 2026-08-12: a declared
`IpProtocol: 6` is stringified to `'6'` by exactly the same lossless coercion,
and AWS stores and reports `tcp` — so `effectiveProperties` records a value the
readback can never equal, and the phantom drift the mechanism exists to remove
survives via a third route. The difference is that `-1` -> `'-1'` is a TYPE
coercion cdkd performs, while `6` -> `tcp` is a VALUE mapping the SERVICE
performs; only the first is knowable at send time. So a send-side record cannot
close the second class, and the fix belongs on the readback instead
(`src/analyzer/drift-protocol-normalize.ts`, canonicalizing BOTH comparison
sides — plus `sgProtocolKey`, so the rule-identity lookup that runs one layer
below the comparison agrees with it). When you reach for `effectiveProperties`,
ask what the service will REPORT, not merely whether your own transformation
lost information; when those differ, the readback side is the one to fix.

**But "the service transforms it" does not automatically mean the readback
side** — the deciding question is whether the transformation is knowable AT SEND
TIME (issue #609, `AWS::Kinesis::Stream` `DesiredShardLevelMetrics`). AWS expands
the `ALL` shorthand into seven individual metric names and never stores the
literal, which reads like the `6` -> `tcp` case above and is not: `ALL` expands
to a CLOSED, documented set, so cdkd can perform the identical expansion itself
and SEND the seven names. Having sent them, the send-side record is exactly what
AWS holds, and `effectiveProperties` + its `canonicalizeDesiredProperties` twin
apply normally. The distinction that actually matters is therefore not
"who performs the mapping" but "can the provider compute the post-mapping value
before the call": `6` -> `tcp` cannot be (the table is the service's and open to
change), `ALL` -> the seven can be. When it can, prefer expanding on the wire —
one shared helper feeding both halves — over a readback normalizer, because the
readback fix leaves cdkd SENDING a value it cannot describe and needs a
normalizer for every future consumer of the same field. The type separately
declares the path in `getDriftUnorderedPaths`, because AWS's readback order for
this field is arbitrary whether the template used `ALL` or listed the metrics
explicitly — a shorthand that expands to a SET usually needs both mechanisms,
but they answer different questions and neither implies the other.

**Expanding on the wire also means the guard has THREE answers, not two**
(same issue). Once the provider refuses to send a value it could not parse, an
ABSENT declaration and an UNUSABLE one must stop collapsing to the same empty
list: absent is a template REMOVAL and correctly clears the live set, while
unusable would clear it on the strength of a value cdkd could not read. That is
the [[nonempty-shape-guard-falls-through-to-destructive-arm]] shape one level
up, and it bites specifically on a SET-valued property where the empty list is
itself a meaningful instruction. Classify the read (`absent` / `usable` /
`unusable`) and let each caller pick the ACTION — refuse on create, warn-and-skip
on update — rather than flattening early. And do not let a partial read leak
past the refusal: filtering an unresolved intrinsic out of a MIXED array sends a
list the template never declared while state records the declared one, which
re-creates the phantom drift through the back door.

**A warn-and-SKIP arm is the same class as a narrowing, and the
`canonicalizeDesiredProperties` twin above does NOT apply to it** (issue
#1612). Read the twin rule as scoped to a NARROWING — a pure function of the
desired bag, where both comparison sides can be reduced identically. A skip is
a different shape: what reaches AWS depends on what was ALREADY there, so
there is no pure function of the desired bag to canonicalize with, and the twin
is actively destructive. Canonicalizing the desired side would DROP the
malformed configuration from it, so a previous side holding a VALID
configuration against a desired side holding a malformed one derives a
REMOVAL — cdkd would DELETE the live lifecycle / replication configuration the
user still wants, on a template whose only fault is one unusable field.
Recording the retained value has no such arm: the malformed template keeps
re-warning until it is fixed, which is correct.

What to record differs per path, and neither answer generalizes — the eight
skip-reporting S3 bucket appliers carry all three:

- **UPDATE**: retain the PREVIOUS value. The Put never ran, so AWS still holds
  the previously-applied configuration and that IS what state should describe.
  Dropping the key instead is wrong in the other direction: a later template
  that REMOVES the block would derive no removal and the live configuration
  would survive forever.
- **replay-CREATE** (the reverse-replacement arm): DROP the key. The resource
  is new and nothing was applied, so there is no previous value to keep.
  **Read that as scoped to a SKIP** (issue #1653, `AWS::DynamoDB::GlobalTable`
  `StreamSpecification`): on a create arm whose replay downgrade is a
  warn-and-DEFAULT, the block IS applied — a stream really is created — so
  what binds is #1633's "what you return is what you SENT" and the answer is
  the SUBSTITUTED value, not a drop. Dropping there would record that cdkd
  sent nothing. Record it in the CFn shape rather than the SDK one
  (GlobalTable's `StreamSpecification` declares only `StreamViewType`, no
  `StreamEnabled`), so the effective bag is indistinguishable from what an
  ordinary template-path create of the same resource records. Which arm you
  are on is a property of the GUARD, not of the path: ask whether the call
  went out, not whether it was a create.
  **A substitution that changes a MODE drops more than the one key, and BOTH
  answers appear in the same bag** (issue #1726, the `BillingMode` sibling of
  the arm above). Substituting `PAY_PER_REQUEST` for a malformed GlobalTable
  `BillingMode` also skips `ProvisionedThroughput`, hands the SUBSTITUTED mode
  to the GSI translator so every PROVISIONED-only per-index member is dropped
  before the call, and skips auto-scaling registration — so the bag records the
  substituted mode (it WAS sent) while STRIPPING the capacity blocks (they were
  not). Recording only the mode leaves the same permanent phantom drift the arm
  exists to remove, one key over. **Read the strip set off your own
  `readCurrentState` under the NEW mode, per member** — that is the operational
  form of #1643's "ask what the service will REPORT", and it is already written
  down in the provider: every one of those emissions is type-discriminator-gated
  on the mode, so the gate IS the answer (top-level
  `WriteProvisionedThroughputSettings` emits `{}`, the per-replica / per-index /
  per-replica-index blocks are omitted). Do NOT strip by name-shape: the
  on-demand ceilings look like capacity and go on the wire under precisely this
  mode, so a blanket sweep would record a loss that did not happen. And re-ask
  the twin question rather than inheriting an answer — none is needed here
  because the arm ALREADY records a mode differing from the declared one, so the
  next deploy ALREADY classifies an UPDATE and the strip folds into it. The
  UPDATE-side twin of the same property is NOT the same problem (the kept mode
  can be either value and the resource already exists, so the retain-the-
  PREVIOUS-value row above applies instead); it is FIXED in issue #1738 by
  `retainUnsendableCapacityMembers`, which splits every capacity member against
  the KEPT mode — the members that mode cannot send RETAIN the previous value
  (validated through the same `asRecord` predicate the wire reads apply, and
  DROPPED when the previous side is unusable OR absent, since there is no value
  cdkd can vouch for either way), while the members it CAN send keep the desired
  one. A block the desired side REMOVED is retained too, so a later removal
  stays derivable.
  **An OMIT can leave the call itself invalid, and that is a separate question
  from what to record** (issue #1741, the first LIVE exercise of these arms).
  The GlobalTable GSI omit sent `CreateTable` with no indexes but with the
  record's `AttributeDefinitions` unchanged; DynamoDB requires the definitions
  to be EXACTLY the attributes referenced by `KeySchema` and by the indexes
  being created, so for the ORDINARY shape — an index keyed on its own
  attribute — AWS rejected the whole call and the reverse-replacement rollback
  failed to re-create the table at all. So the downgrade broke on precisely the
  population it exists for, and the refusal it replaced at least failed before
  touching AWS. **When an omit fires, prune everything DOWNSTREAM that
  referenced the omitted thing, not only the thing itself**, and prune the
  effective bag to match (an unsent definition is the same phantom-drift class).
  Two details that generalize: scope the prune to what this call still sends —
  the create-only `LocalSecondaryIndexes` are NOT omitted by that arm, so their
  key attributes must survive, which is why the shared name-collector takes the
  index lists explicitly rather than defaulting to all of them — and fail OPEN
  when the referencing side is unreadable (an intrinsic-valued `KeySchema`
  resolves to no names, and pruning against an empty set would strip everything
  and turn a template defect into a more confusing AWS error). Unit mocks cannot
  see any of this: the failure is a real AWS rejection and every mock returns
  success. A second instance of the same class is still open — the omit keeps
  cross-region `Replicas[].GlobalSecondaryIndexes` overrides (correctly, they
  are a separate key with their own send path) but `addReplica` sends them
  AFTER `CreateTable`, against a table the omit just created with zero indexes;
  it needs a cross-region fixture arm and stays on #1741.
- **per-item appliers** (a Put keyed by `Id`): the skip unit is one
  configuration ITEM, so the effective array substitutes the previous item of
  the same `Id` IN PLACE, or drops it when the skipped item was an ADD.
  Preserve the DESIRED order — `DiffCalculator` compares arrays positionally,
  so a reordered effective array manufactures a fresh phantom drift while
  removing the one this exists to fix.

Report the skip EXPLICITLY from the applier (a `Promise<boolean>` "applied"
return, or a list of skipped item indexes) rather than inferring it by wrapping
`onUnusable`. That callback is shared by TWO guard classes — SKIP-class guards
(`configStringRefusal` + `requireConfigObject` / `requireConfigArray`) and
warn-and-DEFAULT reads (`readConfigString` with the options bag, where the
applier proceeds WITH a substituted default). A wrapper cannot tell them apart,
so a defaulted-but-APPLIED configuration would be recorded as skipped and the
previous value retained — manufacturing exactly the phantom drift the change
exists to remove.

**A warn-and-SUBSTITUTE arm at the SAME sites reports what it SENT, and the
twin question has to be RE-ASKED there rather than inherited from the paragraph
above** (issue #1670, the sibling #1612 deliberately left alone). A
substitution's effect IS a pure function of the desired value — malformed ->
the default, the key still present, no removal derivable — so the skip
carve-out does not cover it and the #1633 twin rule genuinely reaches it. The
S3 analytics `StorageClassAnalysis.DataExport.OutputSchemaVersion` and the
analytics / inventory destination `Format` still answered NO, on three findings
worth reusing as the checklist:

- **Which hazard does the twin actually avert here?** It exists because a
  narrowed record makes the next diff read the difference as a user-made
  change, and for a create-only property that is a REPLACEMENT. Neither
  property is create-only in the registry schema (`AWS::S3::Bucket`'s
  `createOnlyProperties` is `BucketName` / `BucketNamePrefix` /
  `BucketNamespace`) nor named in either half of the type's
  `ReplacementRulesRegistry` entry, so `isClassified` is false, the createOnly
  fallback decides, and the un-canonicalized diff derives an in-place UPDATE
  that re-issues the same idempotent per-`Id` Put. Check the classification
  before assuming the hazard.
- **What would sharing the twin with the provisioning path COST?** The rule
  requires sharing, and it is worth being precise that this is a cost question
  and not an impossibility one — a PATH-CONDITIONAL substitution is no obstacle
  in itself, since `narrowIngressIpProtocol` throws without an `onUnusable` too
  and `canonicalizeDesiredProperties` bridges it by passing a NO-OP callback
  (`ec2-provider.ts`). What differs is the size of the shared helper: EC2 folds
  ONE top-level scalar, whereas the effective value here is rebuilt per ITEM,
  at the destination branch the template declared, inside a per-`Id` loop — so
  the pure helper would re-implement the applier's item walk. That is the cost;
  the next finding is what decides against paying it.
- **What would the user LOSE?** Canonicalizing both sides makes the comparison
  equal, so on a template whose only fault is this field the provider is never
  called and the warning stops — the value silently normalized on UPDATE while
  an identical fresh deploy hard-refuses. EC2 accepts exactly that concealment,
  and the difference is what it BUYS there: `IpProtocol` is create-only, so the
  fold prevents a REPLACEMENT of a rule AWS already holds. Here finding 1 says
  there is no replacement to prevent, so the concealment buys only the
  suppression of a repeated idempotent Put. Refusing the twin costs the mirror
  image of the drift being fixed: `cdkd diff` keeps reporting the property
  until the template is corrected, which is TRUE and ends with one edit.

Record it per ITEM, like the skip — the S3 per-`Id` appliers therefore report
`{skipped, substituted}` rather than the bare index list the paragraph above
describes, because the two arms mean OPPOSITE things to the effective array (a
skipped item's entry is what AWS still holds, a substituted item's is what was
just sent) and must stay separable all the way to the recorder. Two further
details the skip path did not need:
the effective array keeps the substituted item IN PLACE in its DECLARED branch
shape (a CFn `Destination` block is accepted flattened AND nested, so writing
back at a hardcoded branch leaves the malformed value alive at the other key
and adds a stray one) — but read that as scoped to a branch the READBACK can
emit, because where it cannot (issue #1686) the declared spelling is exactly
what must NOT be preserved, and the recorder is handed the value the read RETURNED
rather than the fallback literal, so "what is recorded" and "what is sent"
cannot drift apart. And weigh the #1643 bar first: both values here are literal
SDK enum members the service stores verbatim, so a send-side record converges.
**The one licensed exception to that prohibition is a SINGLE call site of KNOWN
class** (issue #1653). The rule guards a callback SHARED by both guard classes;
where you are wrapping one `readConfigString` you wrote yourself, you already
know it is a warn-and-DEFAULT, and what you record is the DEFAULT THAT WAS
APPLIED rather than a retained previous value — which is the outcome the rule
wants, reached by the route it warns about. Preserve the gate exactly: compose
`replayWarn`'s own `onUnusable` rather than replacing it, and only when that
callback EXISTS, or a template-path create silently gains a downgrade it never
had. Say in-code that the exception is deliberate, or the next reviewer reads
it as the violation.

**Validate the PREVIOUS value before retaining it** (issue #1653 review). An
absent-vs-present test is not enough: `previousProperties` is a cdkd STATE
record, and a replay whose record was written by an older binary is exactly the
#1544 scenario, so the previous side can hold `null` / `''` / a bare string
just as the desired side can. Copying that into `effectiveProperties` re-creates
the phantom drift from the other direction. Run the SAME predicate the desired
side runs (`configStringRefusal`, not a hand-written `typeof` twin, or the two
sides disagree on exactly the blank string / explicit null / coerced number),
and when BOTH sides are unusable, DROP the key — there is no value to vouch
for. COPY the retained value rather than aliasing the previous bag; the
rollback executor spreads the answer shallowly.

**Dropping a key can move a hazard rather than remove it — audit who READS the
record next** (issue #1654 review). Dropping is right when state must not claim
a value cdkd cannot vouch for, but an absent key is not malformed, so the next
reader's guard does not fire and its DEFAULT applies silently. `AWS::Lambda::Url`
is the live case: `update()` drops an unvouchable `AuthType`, and the
reverse-replacement `create()` then reads a record with no `AuthType` and
defaults to `'NONE'` — a PUBLIC function URL, with no warning anywhere, which is
worse than the malformed value the drop replaced. The remedy is not to stop
dropping; it is to make the reading path ANNOUNCE the defaulted absence on a
replay. A drop is only honest while something still says so.

**A never-emitted KEY is the same class reached through the SHAPE rather than
the value, and it is not covered by asking what the service STORES** (issue
#1686, the sibling #1670 left behind at the same sites). The #1643 bar — record
what AWS will REPORT — is usually applied to a value; apply it to the key too.
Where a provider accepts more than one spelling of a block on the DESIRED side
but its `readCurrentState` reverse-mapper emits only one, a record written in
the other spelling can never match the readback, so `cdkd drift` re-reports it
forever and `--revert` re-issues the same call — with no warning anywhere to
hint at it, because nothing was lost and nothing was substituted. The S3
inventory applier accepts the CFn `ScheduleFrequency` and the SDK
`Schedule: { Frequency }` (the #1605 fall-through) while `inventorySdkToCfn`
emits only the former; it now records the CFn spelling and DROPS `Schedule`.
Three things generalize:

- **Key the normalization off the DECLARED shape, not off the refusal.** The
  case that matters carries no malformed value at all — an item declaring only
  the SDK spelling sends the right cadence and records the wrong key — so a
  condition riding the existing substitution arm misses the main population.
- **Remove the key rather than setting it to `undefined`.** `deepEqual` is
  `JSON.stringify`, which drops an `undefined` member, but the state record is
  written from the same object and a present-but-`undefined` key survives a
  `structuredClone` — so any consumer that walks `Object.keys` (the
  `unionWalkObjects` drift path) still sees two different key sets.
- **Prefer normalizing over RETRACTING the tolerance.** Refusing the SDK
  spelling outright is the other candidate answer and it costs more than it
  buys: it would retract the #1605 fall-through, whose purpose is that a
  malformed first source lands on a value the record ALSO carries instead of
  skipping a live configuration.

Audit the whole type when fixing one of these, the way #1389 says to for the
write side, and the audit is mechanical: diff every property name in the type's
live registry schema against every key the provider reads off a desired-side
bag. On `AWS::S3::Bucket` that is 158 schema names, and the class is WIDER than
one property: besides `Schedule` (fixed) it covers the analytics / inventory
`Destination.S3BucketDestination` nested branch with its `Bucket` / `BucketArn`
alias, the notification `TopicArn` / `QueueArn` / `LambdaFunctionArn` reads
(`readNotification` emits only `Topic` / `Queue` / `Function`), and the
lifecycle `Date` alias (`readLifecycle` emits only `TransitionDate`) — all left
as issue #1707, whose PR fixed the DESTINATION half only; the notification and
lifecycle families are FIXED by issue #1748 (`effectiveNotificationConfiguration`
/ `effectiveLifecycleConfiguration`, both with the twin). `IsEnabled` and
`AccountId` look like members of the class and are NOT: they are legitimate SDK
spellings read on the RESPONSE side.

**Re-run the audit rather than fixing the names the issue lists**, which is what
#1748 measured the value of twice over. Matching the `(a['X'] ?? a['Y'])` ALIAS
form found THREE lifecycle aliases in the two transition item shapes where the
issue named one (`TransitionInDays ?? Days` and `TransitionDate ?? Date` on
`Transitions[]`, `TransitionInDays ?? NoncurrentDays` on
`NoncurrentVersionTransitions[]`), so fixing the reported key alone would have
left its siblings broken. And the ROUND-TRIP fence — assert the recorded bag
against what `readCurrentState` ACTUALLY EMITS for the configuration just sent,
never against a hand-written literal — immediately failed on a divergence
neither the issue nor the audit had named: `readNotification` emitted the SDK's
LIST `Events` while every template carries the CFn scalar `Event` (the registry
schema declares no `Events` member), so the record and the readback disagreed on
EVERY notification-configured bucket rather than only on the rare
`TopicArn`-spelled one. That one is fixed on the READBACK side, by arity — a
single-element list is the CFn `Event`, a longer one has no CFn spelling and
stays `Events` — mirroring what `readLifecycle` already does for
`TransitionInDays`. Two literal-based fences would both have passed; the
round-trip one is what caught it. It also measured what was still open on the
same rule (issues #1754 / #1755), so "the aliases converge" was not mistaken for
"the block converges" — and those, plus the notification residuals of #1759, are
now FIXED, on four findings worth reusing:

- **Upgrade the fence's UNIT when it stops finding things.** #1748's rows
  compared one nested ITEM at a time, which is structurally why they missed the
  RULE-level divergences beside them. Comparing the WHOLE recorded rule against
  the whole emitted one immediately showed that an ORDINARY CDK-shaped rule
  using no cdkd tolerance at all disagreed on three keys — `ExpirationInDays` /
  `NoncurrentVersionExpirationInDays` against an `Expiration` /
  `NoncurrentVersionExpiration` readback, and the empty-prefix `Filter` the
  applier SENDS for a scope-less rule but nothing recorded. That is a far wider
  population than the tolerated spellings the issue was filed for.
- **A fold whose input is a LIST-wide decision cannot be a pure per-item
  function.** S3 forbids mixing V1 (top-level `Prefix`) and V2 (`Filter`) rules
  in one lifecycle configuration, so the form is chosen ACROSS ALL RULES;
  `lifecycleRuleScope` / `lifecycleUsesFilterForm` are module-level and the
  applier calls them too, because a fold re-deriving that decision could record
  a `Filter` the wire never sent. Same share-ONE-helper rule as the appliers,
  applied to a decision instead of to a value.
- **A MERGE with a warning arm does not fold the way an alias rename does.**
  `mergeLegacySingular` drops the legacy singular and WARNS on a `StorageClass`
  collision. Folding both sides identically there would make the comparison
  equal, so `update()` would never be called again and the warning would stop
  after ONE deploy — the finding-3 concealment. The NON-colliding case (the
  population the fix exists for) folds; a COLLIDING rule is left completely
  alone, keeping the difference visible until the template drops one
  declaration. Reach for a no-op callback only when the callback has nothing to
  say.
- **The `!isPlainObject(x)` arm of a boolean gate is where the destructive
  default hides.** `NotificationConfiguration.EventBridgeConfiguration`'s gate
  was `!isPlainObject(eb) || coerceCfnBoolean(eb['EventBridgeEnabled']) !==
  false`, and `coerceCfnBoolean` answers `undefined` for a declared `null` /
  `'yes'` / an array / an unresolved intrinsic — so `undefined !== false`
  ENABLED delivery for EVERY unreadable value, on a live bucket, with no
  warning. `configBooleanRefusal` + the per-path answer (#1751's) replaces both
  arms; #1430's usable-value polarity is untouched, which is what the
  `s3-lifecycle` integ asserts on both phases. The SKIP unit came from the API,
  not from the item: `PutBucketNotificationConfiguration` is a full replace, so
  skipping one family would silently DELETE the others — it needs the
  `retainPrevious` treatment its sibling appliers use.
