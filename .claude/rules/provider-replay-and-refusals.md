---
description: Provider create/update context - replayingState, pre-flight refusals and their replay downgrade, effectiveProperties
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - replay context, pre-flight refusals, `effectiveProperties`

The narrowing / substitution half of the same argument continues in [provider-property-fidelity.md](provider-property-fidelity.md).

Provider interface, registry, Custom Resources, and "Adding a New SDK Provider": [providers.md](providers.md).

`create`'s `context` (issue #1463) is the sibling of `delete`'s: optional,
so most providers need no change, and it carries exactly one field today.
`context.replayingState` is `true` when the properties come from a cdkd
STATE record rather than the template — set ONLY by the rollback executor's
reverse-replacement arm (`rollback-executor.ts`), which revives the OLD
resource from `previousState.properties`. A provider PRE-FLIGHT REFUSAL
(see [docs/provider-development.md](../../docs/provider-development.md) §1a)
MUST downgrade to a warning when it is set: the user cannot edit a state
record from the template, so refusing would leave the old resource
unrestorable with only a hand-edit of `state.json` as a remedy. It licenses
NOTHING else — it says nothing about the properties' content, is not a
dry-run signal, and must not relax data-safety guards or the validation that
protects the AWS call itself. Absent / `false` = an ordinary template-path
create (`cdkd deploy`, the replacement / `--replace` / `--recreate-via-*`
creates), where the refusal stands.

**The MUST has exactly one stated exception, and its own reasoning is what
licenses it** (issues [#1975](https://github.com/go-to-k/cdkd/issues/1975) /
[#1977](https://github.com/go-to-k/cdkd/issues/1977),
`CognitoUserPoolProvider`'s MFA pre-flight). The downgrade exists because a
refusal against a STATE record leaves a resource un-rollbackable with no
template-side remedy — which presupposes the replay could otherwise SUCCEED.
Where the refused combination is rejected by AWS 100% of the time, it cannot:
downgrading trades a clear cdkd-worded refusal for the same AWS failure a
moment later, and on the update path for a PARTIAL APPLY as well. A state
record cannot legitimately hold such a combination either, since state is
written only after a successful apply. So the test is not "is this a replay"
but **"could the replay have succeeded"**, and a provider taking the exception
must say so AT the refusal, naming this rule and the measurement that settles
the 100% claim — an unconditional refusal with no such note reads as an
oversight, and the next reader cannot tell the two apart. Do NOT generalize
this to "my guard is probably right anyway": the measurement is the licence.

Consumers today come in THREE shapes, and
the count is worth knowing because the spread is exactly the drift the shared
helper exists to stop:

- **The shared `replayWarn(logger, context)` helper** in `config-shape.ts`,
  spread into a create-path `requireConfigString` options bag — API Gateway
  `AuthorizationType`, EC2 `InstanceType` / `Domain`, IAM access-key `Status`,
  Lambda event-invoke `Qualifier`, RDS DB-proxy `TargetGroupName`, DynamoDB
  GlobalTable `BillingMode`, WAFv2 `Scope`, Lambda URL create-path `AuthType`,
  S3 directory-bucket `DataRedundancy`, DynamoDB Table `BillingMode` (issues
  #1544 / #1545). `readConfigString` accepts the same options bag for nested
  containers (GlobalTable `StreamSpecification`); `requireConfigArray` accepts
  its `onUnusable`-only subset (`ConfigArrayOptions`) for LIST blocks — under
  the callback it warns and returns `undefined` so the caller decides the skip
  unit, and the S3 `TagFilters` guards skip the whole configuration item /
  whole lifecycle Put rather than applying a widened scope (issue #1579);
  `requireConfigObject` is the OBJECT-block twin of that guard
  (`ConfigObjectOptions`, same overloads, same caller-owned ABSENT case) for a
  container whose members are probed for PRESENCE rather than read as a
  string — where `readConfigString`'s rule 2 is unreachable and a malformed
  value reads as an EMPTY block, so the S3 lifecycle `Filter` / analytics
  `StorageClassAnalysis` / `.DataExport` / replication `Filter` guards skip
  with the same units (issue #1581). The replication site is the one worth
  remembering: an EMPTY block is not inert there — `Filter: {}` is the valid
  CFn form meaning "replicate EVERY object" — so the malformed container did
  not merely drop a predicate, it replicated the whole bucket. When auditing
  this class, ask what the EMPTY block MEANS at the site before deciding the
  severity.
  **A per-item STRING read is the same replay question with a DIFFERENT
  answer** (issue #1595): `readConfigString`'s own `onUnusable` downgrade is
  warn-and-DEFAULT, and at a per-item site the default lands on a LIVE
  resource — the four S3 per-item reads left strict by #1581 all default to
  `Enabled` / `All`, so defaulting would START an expiration rule, an
  intelligent-tiering transition, or a replication rule the template had
  disabled. Those sites take `configStringRefusal(container, key, fallback,
  containerPath, options?)` instead: it returns the refusal SENTENCE (or
  `undefined`) without taking the fallback, so the caller performs the SKIP its
  sibling container guards already use, with the same per-applier unit — whole
  Put where the Put replaces every rule, single item where the Put is per-Id.
  It shares `requireConfigString`'s predicate rather than re-deriving one, and
  a test enumerates both against every value to keep them from drifting; a
  hand-written `typeof` twin disagrees on exactly the blank string, the
  explicit `null` and the coerced number. On the CREATE path the caller does
  not probe at all, so the original read still throws unchanged; and
  `toSdkGlobalSecondaryIndexes` takes the callback as `onUnusableIndexes` —
  wired from `create()` AND, since issue #1551, from both of `update()`'s
  call sites (desired and previous). Prefer this.
- **A `context` parameter threaded into a provider-local mode switch** —
  `SNSTopicProvider.create` passes `'warn'` instead of `'throw'` to
  `buildDeliveryStatusAttributeMap` when the replay flag is set (issue #1551).
  It previously declared no `context` parameter at all, so the 4th argument
  the rollback executor passes was silently ignored — worth knowing as the
  failure mode a missing parameter produces: no type error, no warning, just
  a refusal that still fires on a replay.
- **A hand-threaded callback** — `EC2Provider.buildIpPermission` takes an
  `onUnusableProtocol` parameter and forwards it as `onUnusable`, because the
  helper is shared with state-borne callers that must NOT downgrade.
  `EC2Provider.createRoute`'s `onMultipleDestinations` (issue #1566) is the
  second: `create()` passes it only when `replayingState` is set, and
  `updateRoute` passes it UNCONDITIONALLY — see the update-path bullet below.
- **A hand-written refusal** — `GlueProvider`'s
  `enforceIcebergTableInputAbsent`.

**An UPDATE-path refusal is a replay refusal too**, and its downgrade is NOT
the create one. `rollback-executor.ts`'s revert arm and `cdkd drift --revert`
both call `update(..., previousState.properties, ...)`, so the desired bag can
be a cdkd STATE record — but falling back to the CREATE DEFAULT there is
frequently worse than the refusal, because the default is applied to a LIVE
resource. Decide per site (issue #1551 settled the three that were left
strict, each differently):

- **keep the PREVIOUS value** — Lambda URL `AuthType` (defaulting would flip a
  live IAM-guarded function URL to PUBLIC; when the previous side is unusable
  too the field is OMITTED, and `UpdateFunctionUrlConfig`'s merge semantics
  retain the live value), DynamoDB Table / GlobalTable `BillingMode`. Since
  issue #1683 the GlobalTable UPDATE arm also RECORDS the kept mode via
  `effectiveProperties`, because leaving the malformed desired value in the
  record hands it to the NEXT deploy as its previous side (the #1552 class);
  where AWS reports a `BillingModeSummary` it also clears phantom drift, but a
  table created without an explicit mode returns none, so do not state that as
  the whole payoff. **The split is on ABSENCE, not on usability**, and getting
  that wrong cost a review round in both directions. An ABSENT recorded previous
  DROPS the key, leaving the record exactly as it was; anything else records the
  baseline the guards already resolved — which for a usable recorded previous IS
  that value (so an out-of-band re-price stays a `cdkd drift` finding rather than
  being reconciled away), and for a present-but-unusable one is the live reading,
  which RESTORES a usable baseline. That last case is the
  one place this file's "a read-back value belongs in `observedProperties`" bar
  is crossed, and the bar itself is what reconciles it rather than a carve-out:
  NOTHING was sent, so the live mode IS what cdkd left AWS holding, and the only
  other candidate baseline is junk. Do not "tidy" that case into a drop
  regardless: a dropped key reads as ABSENT next time, and until issue #1733
  the absent branch did not consult AWS, so a corrected template compared
  equal, issued no call, and silently lost a real flip. #1733 closed that
  route — the absent branch now resolves its baseline from the live read
  whenever the desired side DECLARES a mode, which this arm always implies,
  since the guard fires only on a value the template DID declare. That is also
  why the DROP is still right and is no longer the residual it was: the key
  stays absent, and every later deploy re-reads AWS instead of comparing against
  a snapshot this arm would have frozen into the record.
  The create-side arm of the SAME
  property answers differently — it records the SUBSTITUTED mode — because there
  the table really was created on-demand; and because a DROP leaves an absence
  nothing announces, that arm warns on a replay whose record declares no mode.
- **SKIP the block** — GlobalTable `StreamSpecification` (defaulting would
  re-point a live stream's view type the template never asked to change).
- **SUPPRESS the diff** — GlobalTable `GlobalSecondaryIndexes`, where the
  create side's "omit" would read as "delete every live index". The PREVIOUS
  side's translation takes the downgrade UNCONDITIONALLY: it is state-borne,
  so a refusal there is the guard-the-desired-side-only rule violated outright.
  Since issue #1683 the suppression also RECORDS the retained previous list via
  `effectiveProperties`, per the warn-and-SKIP rule below — AWS keeps the index
  set it already holds, so recording the malformed desired blob left a record
  `readCurrentState` could never match and the NEXT update read as its previous
  side. The previous side is validated through the SAME translator (a probe
  call with a flag-only callback) before it is retained, and the key is DROPPED
  when the previous side is unusable OR absent — there is no value cdkd can
  vouch for either way.
- **WARN and keep the pre-refusal behavior** — `EC2Provider`'s Route
  multi-destination guard (issue #1566). `updateRoute` DELETES the route before
  re-creating it, so a throw on the re-create would strand a deleted route with
  no template-side remedy; and because nothing on `UpdateContext` distinguishes
  the callers (it carries no `replayingState`), it
  cannot tell a template update from the state-borne replay that
  `rollback-executor.ts` / `drift --revert` drive. So the downgrade is
  UNCONDITIONAL on that path and the pre-fix precedence still applies — the
  narrowing becomes ANNOUNCED rather than silent, while the refusal stands on
  the create path, where the value is always template-borne.
  **A warn arm that NARROWS must also say what it sent** (issue #1591): the
  same guard left the engine recording every declared destination key while
  AWS holds exactly one, so `readCurrentState` could never match and the
  difference was permanent phantom drift — re-reported by every `cdkd drift`
  and re-triggered by `drift --revert`, which calls `update()` again. Return
  `effectiveProperties` (on `ResourceCreateResult` / `ResourceUpdateResult`)
  carrying the bag actually delivered; the engine records THAT in place of the
  desired one. See the paragraph below for when this is and is not the answer.

**A warn-and-continue update path becomes a producer of junk state** (issue
#1552): the deploy SUCCEEDS, so the engine records the unusable desired value,
and the NEXT update reads it as the previous side. Where the provider already
holds AWS's live value (a `DescribeTable` at the top of `update()`), seed the
comparison baseline from it whenever the state-recorded previous is
present-but-unusable — otherwise the corrected template compares against junk,
reads as a change, and issues a call AWS rejects on every deploy.

**An ABSENT previous must not be seeded BLINDLY** — that is the spurious-change
hazard, and it is a statement about HOW, not a prohibition. The seed is gated on
the DESIRED side DECLARING a mode: where the template omits the property both
sides normalize to the type default and `BillingMode` contributes no change of
its own, so consulting AWS there would manufacture one (and, on an imported
provisioned table, re-price it). Where the template DOES declare a mode the user
is stating one, and comparing it against the type default instead would suppress
a real flip — reachable via `cdkd import`, whose state properties come from the
template rather than from AWS. `AWS::DynamoDB::Table` has resolved it that way
all along (`properties['BillingMode'] !== undefined ? liveBillingMode : <type
default>`); `GlobalTable` CONVERGED onto that answer in issue #1733, where an
absent previous had been resolving to the create-path default without ever
consulting AWS, so a corrected template compared equal and silently lost a real
flip. There is no divergence between the two providers here — only a difference
in each type's own default (PROVISIONED for `Table`, PAY_PER_REQUEST for
`GlobalTable`), which is the CFn type default in both cases.

**Resolve a missing `BillingModeSummary` to PROVISIONED, not to the type
default** (#1733 review). DynamoDB omits the summary for a table created without
an explicit mode, and such a table IS provisioned — so the inference is reading
AWS correctly rather than inventing a value, and it is the reading both
providers' `readCurrentState` already takes. **The no-summary population is far
wider than "tables cdkd did not create", and that was MEASURED rather than
reasoned about** (us-east-1, 2026-08-13, `dynamodb-globaltable` integ): a table
created with an EXPLICIT `BillingMode: PROVISIONED` reports no
`BillingModeSummary` either, so the inference is what every provisioned table
depends on — not a rare imported-table corner. Getting this wrong is what made
the first cut of the GlobalTable fix INERT on its own headline population, and
falling
back to the type default there both lost the flip AND re-opened the same-mode
`UpdateTable` in the other direction — a record with no mode against a
`PROVISIONED` template compared PAY_PER_REQUEST vs PROVISIONED and flipped a
table that was already provisioned. When a live read has a documented ABSENCE
semantic, encode the semantic; a "defensive" fallback to the create-path default
is only defensive against the wrong thing.

**Take IDENTITY from the live read unconditionally, VALUES only where the live
value answers the SAME question as the desired one** (issue #1571, refining the
memory rule that said identity only). Existence is always safe and is what
stops the permanent loss. A live VALUE is safe only when three things hold, and
each was learned by shipping the version that did not check it:

- the live value is not an AWS-side DEFAULT for a mode the resource is not in
  (`DescribeTable` reports `ProvisionedThroughput: {0, 0}` for every index of a
  PAY_PER_REQUEST table, so an ungated read modified every index and re-sent
  `{0, 0}`, which AWS rejects) — gate on the live MODE, not on the value;
- nothing else OWNS the number (an autoscaled capacity belongs to Application
  Auto Scaling while the desired side is `MinCapacity`; both are correct, and
  comparing them issues a scale-down nobody asked for) — detect the other owner
  from the TEMPLATE, which is the side that declares it;
- the comparator can actually tell them apart (`deepEqual` is
  `JSON.stringify`, so an entry rebuilt member-by-member differs from its own
  translated counterpart on key ORDER alone, and AWS does not guarantee list
  readback order) — build the baseline by SPREADING the desired entry and
  overriding only the members you vouch for, and leave anything whose readback
  order is not guaranteed as the desired copy.

**EXISTENCE and VALUES take DIFFERENT gates in the same method** (issue #1630,
the Create / Update siblings of the #1617 Delete fix). `applyGsiUpdates` now
consults the live `DescribeTable` snapshot in both arms so a failure LATER in
`update()` — PITR, TTL, ResourcePolicy, Kinesis streaming — cannot wedge every
later deploy on a re-emitted op AWS rejects (state is written only once
`update()` RETURNS, so anything that already landed is unrecorded). But the two
arms are gated differently on purpose: an index's EXISTENCE is
billing-mode-independent, so the Create skip applies on either mode, while the
capacity VALUES are meaningless under PAY_PER_REQUEST and the Update skip is
disabled there entirely. Reading the identity bullet above as "consult the live
read" without splitting the two would re-open the `{0, 0}` trap on the arm that
compares numbers. And compare such a value MEMBER BY MEMBER: a
`Describe*` readback carries AWS bookkeeping (`NumberOfDecreasesToday`,
`LastIncreaseDateTime`) the desired object does not, so a structural compare
never matches and the suppression becomes dead code that still LOOKS safe.
Make every unresolvable shape fail OPEN (still issue the call) — the worst case
is the pre-fix behavior, whereas a false match silently drops a real change.

Carrying the values matters beyond capacity: the #1160 absent-field RESET is
derived from the PREVIOUS side, so an identity-only baseline silently disables
every removal for as long as the record stays junk.

**`effectiveProperties` is the OTHER half of that remedy, and the two answer
different questions** (issue #1591). Seeding the comparison baseline from the
live read fixes the case where STATE is already junk; `effectiveProperties`
stops the junk being written in the first place, for the narrower case where
the provider KNOWS it dropped something because it dropped it deliberately.
Reach for it only when all three hold, or it becomes a way to hide losses:

- the narrowing is DELIBERATE and already ANNOUNCED (a warn arm) — recording a
  value the provider merely failed to send converts a bug into a clean record;
- what you return is what you SENT, not what AWS computed. AWS-side defaults
  and computed values belong in `observedProperties`, which is captured by a
  real read-back; putting them in `properties` makes the DESIRED baseline drift
  from the template and silently disables the #1160 absent-field removal
  derivation, which reads that side;
- it REPLACES the desired bag wholesale rather than patching it, so it must be
  complete. An absent field (the normal case) means "record the desired
  properties", which is why the engine gates on `??` and not on truthiness — an
  empty object is a legitimate answer.

**Every `update()` caller honours it, not just the deploy engine** (issue
#1644). `cdkd drift --revert` and the rollback executor's two revert arms
(`revert`, `revert-failed-update`) call `update()` too, and all three used to
discard the return value — so a narrowing announced there was dropped, the
record kept describing a value AWS does not hold, and the next `cdkd drift`
reported the same difference while `--revert` re-issued the same call, forever.
The bag each caller HANDS you is what your answer replaces, and that differs by
caller: the rollback arms send `previousState.properties` verbatim (so the
answer replaces the whole record's `properties`), while `--revert` sends a
merged bag — AWS-CURRENT values for every non-drifted key — and therefore
persists only the top-level keys where your answer differs from what it handed
you, into `observedProperties ?? properties`. So the provider-side rule is
unchanged (return the COMPLETE bag you sent); do not try to return a patch for
one caller's benefit.

**The same held for the `create()` side, and the replay-CREATE row below
depended on the missing half** (issue #1682). The deploy engine honoured
`effectiveProperties` on create from the start, but the rollback executor's
reverse-replacement re-create — the ONE create caller whose input bag is a STATE
record, and therefore the one that can carry the malformed block a provider
warns about and SUBSTITUTES under the #1544 `replayWarn` downgrade — typed its
local result as `{ physicalId, attributes? }` and rebuilt the record from
`previousState.properties`. So every provider that reported a substitution from
its replay-CREATE arm was announcing it into a void, and the row below was
unreachable in production for ALL of them. The shipped consumers are
`EC2Provider` — `createRoute`'s multi-destination narrowing and
`createSecurityGroupIngress`, both gated on `context?.replayingState === true`
— `S3BucketProvider`'s create arm, and `DynamoDBGlobalTableProvider`'s
`StreamSpecification` substitution (issue #1653) plus its `BillingMode` one
(issue #1683, the same `replayWarn` shape one property over); that list is
worth checking with a grep rather than trusting it here. **An arm of this class
can be one you must NOT answer**, and #1683's third arm is the example: the
GlobalTable `needsStream` AUTO-ENABLE fires on the ORDINARY template path —
cross-region replication requires a stream, so cdkd sends one the template never
declared, with nothing malformed and no guard logging a refusal. It is the "arms
that do NOT log" case, so the audit question is rightly "what did this SEND that
differs from what was declared". But the answer there is a key the template does
NOT have, and recording it alone is precisely the shape the twin rule below
forbids: the diff walks the key UNION, so an unchanged template classifies an
UPDATE on the next deploy, the update returns no effective bag, and the key
vanishes again — one spurious no-op UPDATE and no durable record. The twin
cannot rescue it either, being pure and region-blind where `needsStream` is
region-dependent. Left unanswered on purpose, tracked as issue #1723. **Finding
such an arm is therefore not the same as fixing it** — check the twin's
feasibility before you record anything. #1682 named the
GlobalTable as a consumer while the provider was still running its `replayWarn`
substitution and returning WITHOUT the field — the provider-side half, which
#1653 has since supplied, so the two halves now meet. Per-PROVIDER live coverage now exists for TWO of them: the
`rollback-replay-effective-props` fixture drives the GlobalTable `BillingMode`
warn-and-SUBSTITUTE arm and the GSI warn-and-OMIT arm through a real
reverse-replacement rollback (issues #1724 / #1726). The #1696 fixture proves the
ENGINE path via `AWS::EC2::Route`. Still uncovered per-provider, and still
tracked as issue #1706: the GlobalTable `StreamSpecification` substitution and
the S3 bucket arm. Adding them is now cheap — the rollback-failure-injection
phase they need already exists in that fixture.
It now mirrors `recordAfterRollbackUpdate`: the bag handed to
`create()` IS `previousState.properties`, so a returned `effectiveProperties`
replaces the record's `properties` wholesale, and reporting none keeps the
previous bag rather than blanking the record. A provider adding a new
replay-CREATE substitution needs no engine change — but do not re-narrow that
local type, or the wiring silently disappears again.

**`effectiveProperties` alone BREAKS the next deploy — implement
`canonicalizeDesiredProperties` with it.** The two are halves of one decision
and shipping the first without the second is worse than shipping neither.
Recording the narrowed bag makes STATE describe what AWS holds; the template
still declares what it always did, so the next diff reads the dropped keys as a
user-made ADD. For a create-only property that is a REPLACEMENT — every
`AWS::EC2::Route` destination key is create-only in the registry schema — and
the engine's replacement create passes no context, so a provider that refuses
the shape on the create path fails the deploy outright. A previously-green
no-op deploy starts erroring. On the degraded path (no `DescribeType`, so no
create-only knowledge) it is worse: the change classifies in-place and the
resource is delete-and-recreated on EVERY deploy.

So narrow BOTH comparison sides identically, via
`ResourceProvider.canonicalizeDesiredProperties(resourceType, properties)` —
pure, synchronous, applied by `DiffCalculator` to BOTH comparison sides. Share ONE helper with the provisioning path
(`narrowRouteDestinations` and `narrowIngressIpProtocol`, both in
`ec2-provider.ts`, are the examples) rather than re-deriving the rule, or
state and template end up narrowed to different keys and the fix becomes the
bug. This is the same "normalize BOTH comparison sides" rule
`drift-normalize.ts` already records for ordering.
