---
description: ResourceProvider interface, Provider Registry, Custom Resources, and adding a new SDK Provider
paths:
  - 'src/provisioning/**'
---

# Provider Pattern

```typescript
interface ResourceProvider {
  create(logicalId: string, resourceType: string, properties: Record<string, unknown>, context?: CreateContext): Promise<ResourceCreateResult>;
  update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>, previousProperties: Record<string, unknown>): Promise<ResourceUpdateResult>;
  delete(logicalId: string, physicalId: string, resourceType: string, properties?: Record<string, unknown>, context?: DeleteContext): Promise<void>;
  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;
}
```

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
creates), where the refusal stands. Consumers today come in THREE shapes, and
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
  DROPS the key: the comparison baseline there is the create-path default, so
  recording it would INVENT a key on a possibly-PROVISIONED table. Anything else
  records the baseline the guards already resolved — which for a usable recorded
  previous IS that value (so an out-of-band re-price stays a `cdkd drift`
  finding rather than being reconciled away), and for a present-but-unusable one
  is the live reading, which RESTORES a usable baseline. That last case is the
  one place this file's "a read-back value belongs in `observedProperties`" bar
  is crossed, and the bar itself is what reconciles it rather than a carve-out:
  NOTHING was sent, so the live mode IS what cdkd left AWS holding, and the only
  other candidate baseline is junk. Do not "tidy" that case into a drop
  regardless: a dropped key reads as ABSENT next time, and the absent
  branch does not consult AWS, so a corrected template can compare equal, issue
  no call, and silently lose a real flip. The create-side arm of the SAME
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
  no template-side remedy; and because `update()` has no context parameter, it
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
reads as a change, and issues a call AWS rejects on every deploy. An ABSENT
previous is NOT unusable: seeding it turns a no-op into a spurious change.

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
  PREVIOUS-value row above applies instead); it is tracked as issue #1738.
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
round-trip one is what caught it. It also measured what is still open on the same
rule (issues #1754 / #1755), so "the aliases converge" is not mistaken for "the
block converges".

**A DIFF-side fold must not name its member in a spread-and-patch literal.**
`canonicalizeDesiredProperties` is pure and never reaches AWS, but
`gen-nested-key-coverage`'s write-evidence walk cannot tell that: it recognizes
`{ ...out, LifecycleConfiguration: folded }` as the #1475 whole-blob HAND-OFF
and wildcard-credits everything beneath the named path as DELIVERED. Written
that way, #1748's twin retired three reviewed `AWS::S3::Bucket` allow-list
entries (`LifecycleConfiguration.TransitionDefaultMinimumObjectSize`,
`…Rules.TagFilters.Key` / `.Value`) — i.e. it silently switched the write pass
off for that whole subtree, and the critic's only visible complaint was that
those entries were now "stale", which reads like tidy-up rather than like lost
coverage. Use a COMPUTED key (`{ ...properties, [key]: folded }`), which is why
the pre-existing folds in that file are spelled that way; `canonicalizeBlock` /
`canonicalizeItemList` in `s3-bucket-provider.ts` are the two helpers. Measured
both ways through the critic's `--providers-dir=` seam. The general form: when a
critic reports an allow-list entry stale, first ask what NEW evidence made it
resolve — a stale entry and a newly-blinded pass look identical from the
message.
The analytics / inventory `Destination` half of that list is FIXED: the recorded
block is now normalized wholesale to the flattened CFn spelling
(`effectiveS3BucketDestination`), mapping `BucketArn ?? Bucket` to `BucketArn`
and dropping the `S3BucketDestination` wrapper. That supersedes #1670's
write-back-at-the-DECLARED-branch decision, whose only reason was that writing at
a hardcoded branch leaves the malformed value alive at the other key and adds a
stray one — normalizing the whole block leaves no other key. The notification and
lifecycle aliases in the same list are still open.

Two things about running that audit, both learned by getting them wrong. A
plain bracket-read regex finds only the direct `config['X']` form and MISSES
the `(a['X'] ?? a['Y'])` alias reads, which is most of the class — match the
alias form explicitly. And a count is not a finding: the first pass reported
"four non-CFn reads, two of them real" and the real number was larger, so state
what you matched rather than a total. No critic covers this direction today:
`gen-nested-key-coverage` audits CFn -> SDK spellings on the WRITE side, not SDK
spellings TOLERATED on the desired side.

**The recording fold needs its `canonicalizeDesiredProperties` twin** (issue
#1717, which SHIPPED the S3 one). Re-ask the twin question at every such site
rather than inheriting the #1670 "no twin" answer: that answer rests on finding
3 (canonicalizing would CONCEAL a malformed value whose warning tells the user
what to fix), and a never-emitted SPELLING has no fault to fix and emits no
warning at all — so the twin's absence leaves a permanent `cdkd diff` line and a
redundant Put with no explanation. Measured on the #1686 fold: an unchanged
template redeploys as `1 to update` forever. That fold shipped WITHOUT its twin
because the alternative was worse in the direction that MUTATES — without the
fold, `cdkd drift` reports the key forever and `--revert` re-issues the call.
`S3BucketProvider.canonicalizeDesiredProperties` now folds the inventory
`Schedule` -> `ScheduleFrequency` key, the analytics / inventory destination
SHAPE, and the defaulted-but-SENT members (`Enabled` /
`IncludedObjectVersions` / `OutputSchemaVersion` / `Format`), sharing ONE helper
per item type with the appliers so state and template can never be folded to
different keys. The fold is keyed off the DECLARED shape, never off a refusal,
so a malformed value still passes through intact and keeps being reported —
finding 3 survives rather than being overridden.

**Resolve a twin's defaults by PRESENCE, never with `??`** — the review of
#1707 caught the fold concealing exactly what finding 3 says must stay visible.
The default belongs to a key the template OMITTED: the provider sends it, the
readback reports it, and folding both sides is what makes them agree. A key
DECLARED with a malformed value is a different case — the provider warns and
substitutes, records what it SENT, and `cdkd diff` must go on reporting the
difference until the template is fixed, because that report plus the warning are
the user's only signal. `??` cannot tell them apart: it reads a declared `null`
as absent and folds the template side onto the substituted value, so the
comparison comes out equal, the provider is never called, and the warning STOPS.
The same applies to a two-source precedence read: prefer a PRESENT-but-malformed
first source rather than falling through the way the applier's refusal-driven
read does, so the two sides stay different. The trap is invisible to the obvious
tests — a blank string, an array and an unresolved intrinsic are all non-nullish,
so every malformed-value row written first passed against the broken fold; the
nullish spelling is what has to be probed.

**And presence is not the whole rule either — the real one is MIRROR WHAT THE
WIRE DOES.** The code review of the same PR found the fold concealing through the
container SHAPE instead of through `??`: for a malformed `Schedule: 'Weekly'` the
applier's container guard SKIPS the item (AWS keeps the previous configuration
and state retains it), while the fold fell through to the default AND deleted the
malformed key — so the desired side could compare EQUAL to the retained item,
`update()` would never be called, and the skip warning would stop. A
DECLARED-but-unfoldable container must be left completely alone: no patch, and
the key NOT dropped. The mirror rule runs in the other direction too: a member
whose wire read SILENTLY COERCES (`x ?? default`, no warn arm — the S3 inventory
`Enabled`) must fold that same coercion, or the record keeps a value AWS does not
hold. Presence is right only for the members whose wire read REFUSES and WARNS.
Ask, per member, what the wire does with the malformed value; do not apply one
spelling rule across the item.

**But the fold is the second question — first ask whether the WIRE should be
coercing at all.** Issue #1751 settled the `Enabled` half above, and NOT by
folding the coercion: it guarded the wire instead, so the fold's presence test
became correct rather than being made to mirror a bad read. The deciding
question is what the default DOES, not which side is cheaper to change. A
declared `Enabled: null` was going out as `true` — ENABLING an inventory report
the template may have been disabling — which is the destructive-default class
#1595 already refuses at that item's string members, so the boolean member had
to answer the same way: SKIP the configuration item on the replay-reachable
update path, THROW on a template-path create. `configBooleanRefusal` in
`config-shape.ts` is the predicate, and it runs `coerceCfnBoolean` — literally
the function the wire read calls — for the same reason its string sibling
exports `configStringRefusal` rather than letting callers hand-roll a `typeof`
twin. What the fold still owes after that is the lossless COERCION (a CFn
`'false'` is a legitimate declaration and AWS reports the boolean back), not the
substitution. Read the "mirror the wire" rule as MIRROR A WIRE WORTH
MIRRORING.

**And do not HAND-ROLL the mirror — run the wire's own predicate.**
`configStringRefusal` is PURE and importable, so a fold can call the very
function the applier's guard calls. The S3 schedule fold took two review rounds
to get right because it approximated that guard with
`isPlainObject(x) && 'Frequency' in x`, and the approximation disagreed with the
wire on THREE of nine container shapes (measured: `undefined` / `null` / `{}` /
`{Frequency: 'Daily'}` all SEND, while `'Weekly'` / `[]` / `42` /
`{Frequency: null}` / `{Frequency: '   '}` all SKIP). Both error directions are
real defects and they cost differently: treating a SENDS shape as unfoldable
leaves state folded while the template is not — the permanent `1 to update` the
twin exists to close — and treating a SKIPS shape as foldable collapses the
desired side onto the RETAINED previous item, so the provider is never called and
the skip warning stops. A comment in that fold claimed "a REFUSAL this pure fold
cannot run"; it was false, and the false premise is what produced the hand-rolled
approximation. When a fold needs to know what the wire did, import the predicate
rather than restating it, and pin the whole shape TABLE — both arms — in one
test, so a wrong row cannot be mistaken for the spec.

Two things about the obstacle #1717 recorded, because a later reader will meet
it as a claim rather than as a measurement. The issue warned that a
`canonicalizeDesiredProperties` folding this key makes `gen-nested-key-coverage`
report the still-correct plural->singular `segmentRenames` entry for
`InventoryConfigurations` STALE, that removing that entry surfaces genuine
`no-write-evidence` divergences, and that each piece is inert alone so only the
combination trips it. **It did not reproduce.** With the folds written as
MODULE-level pure functions over an item parameter, all three passes report 0
divergences, the committed matrix does not drift, and the `segmentRenames` entry
is still listed in the target's `usedSegmentRenames` — so no entry was removed
and no staleness check was widened. What DID move is the file's withdrawn-name
measurement: `Enabled` / `ScheduleFrequency` / `BucketArn` left the reverse-map
withdrawal set, because a fold writing a CFn spelling outside a `read*` /
`*ToCfn` function is no longer withdrawn-because-only-a-reverse-map-writes-it.
That is the direction to WATCH — a RECORDING write vouching for a forward mapper
that stopped writing the SDK member — so it was measured away per-name with
real-code probes rather than argued: deleting the wire write for `IsEnabled` /
`Bucket` from a scratch copy of the real provider still fails the critic by
name.

**An EMPTY COLLECTION is not a removal intent, and the skip that absorbs it must
still record the previous value** (issue #1671, the ordinary-template half of
the #1612 skip class). The S3 lifecycle / CORS `onPut` arms skip the Put for an
empty rules array, so AWS keeps the previously-applied configuration while the
engine recorded `{Rules: []}` — a Put that never ran, written as though it had.
Unlike the malformed-value skips, this arm is reachable from an ORDINARY
template path rather than only a state replay: a condition-pruned or
intrinsic-collapsed template synthesizes an empty array. Two things were settled
by live A/B rather than by reading the schema (us-east-1, 2026-08-12):
CloudFormation REFUSES an update to `LifecycleConfiguration: { Rules: [] }` /
`CorsConfiguration: { CorsRules: [] }` — the stack reaches
`UPDATE_ROLLBACK_COMPLETE` — and BOTH live configurations survive the rollback
unchanged. So the empty collection is an INVALID template, not a removal, which
rules out the opposite candidate answer: turning the arm into a Delete would
both diverge from CFn and destroy a configuration the user still wants, on a
template whose only fault is a collapsed array. The registry schema only says
the shape is legal (`Rules` / `CorsRules` are required with no `minItems`, so
`[]` parses and the SERVICE refuses it) — which is why the behavior had to be
measured. The skip therefore stands, the PREVIOUS value is what state records
(the #1612 UPDATE answer, now with CFn behavior behind it), and the skip is
ANNOUNCED rather than silent, because CFn's own answer to this template is a
loud failure and a user whose rules stop being applied should not have to diff
state to find out. It stays a warning rather than a throw so the
`readCurrentState` round-trip the arm exists to absorb (`drift --revert` feeds
an always-emitted empty-rules block back through `update()`) keeps working.

**The CREATE path carries the same guard, and WHAT IT RECORDS is the opposite
answer** (issue #1718 item 1). `applyAllSubConfigsForCreate` skipped the same
empty collection in SILENCE, so a fresh bucket came up without a declared
lifecycle / CORS configuration and nothing said so; it now announces the skip
the way the update arm does. The recording answer does NOT transfer, in either
direction. The update arm retains the PREVIOUS value; a create has none, and the
replay-CREATE rule's "DROP the key" — the obvious import — is also wrong here,
because `readLifecycle` / `readCors` ALWAYS emit the empty placeholder for an
unconfigured bucket (`{Rules: []}` on `NoSuchLifecycleConfiguration`,
`{CorsRules: []}` on an absent CORS config). So the declared empty collection
ALREADY equals what `readCurrentState` returns and the right answer is to
override NOTHING, while dropping the key would leave the template declaring one
the record does not and churn a no-op UPDATE on every deploy. The generalizable
form: the drop answer is scoped to a skip whose declared value AWS cannot
report — before importing it, ask what the readback emits for the unconfigured
resource.

**The sibling arms that NORMALIZE the empty collection away reach a DELETE, and
that is the same defect one indirection further out** (issue #1713).
`OwnershipControls` / `BucketEncryption` fold BOTH sides through
`emptyListConfigToUndefined` before `diffSubConfig`, so a declared-but-empty
desired side against a non-empty previous did not merely skip — it took the
onDelete arm and issued `DeleteBucketEncryption`, dropping a declared `aws:kms`
default to SSE-S3 on a template whose only fault is a collapsed array. Measured
live on the same date and account as the #1671 A/B: CFn answers this template
with `UPDATE_ROLLBACK_COMPLETE` and both configurations survive, so it is an
INVALID template rather than a removal — the identical answer, so the identical
skip. **The fold is not the bug and must not be removed**: `readCurrentState`
always emits the empty placeholder, so `drift --revert` feeds it back through
`update()` and both sides must keep normalizing for empty-vs-empty to compare
EQUAL and issue no call at all. What was missing is that the fold COLLAPSES two
different desired sides — declared-but-empty and ABSENT — into one `undefined`,
and only the second is a removal. Split them with a predicate scoped to the shape that was
MEASURED — the list key present and EMPTY (`declaresEmptyCollection`) — and
NOT by asking "present, and the fold erased it": the fold also erases a bare
`{}`, which #1466 pinned as a removal and the #1713 A/B never exercised, so
delegating to it silently reverses a contract on evidence that does not cover
it. A MALFORMED block needs no clause either way; the fold passes it through, so
it never reaches the Delete arm and is refused by name by the apply call. The
generalizable question: when a normalization maps several desired shapes onto
one value, ask what each of them MEANT before letting the merged value pick an
arm — especially when one arm deletes.

**And ask who ELSE sends that shape, because the answer can invert per caller.**
#1713's review is where that surfaced: `readCurrentState` emits the empty
placeholder for an UNSET feature, so `cdkd drift --revert` hands `update()` a
desired `{Rules: []}` meaning "restore the state where this was unset" — where
the same bag from a template means "a collapsed array, do not touch the live
value". The two callers need OPPOSITE arms. Skipping unconditionally breaks
revert (the out-of-band change survives) and, worse, `retainPrevious` then
records the AWS-current value as the new baseline, laundering it clean; deleting
unconditionally is the #1713 data loss. Before adding a skip on an update path,
enumerate every caller that can produce the skipped shape and check the skip is
right for ALL of them.

**That is what `UpdateContext` is for** (issue #1732) — the `update()` sibling of
`CreateContext`, added because this class has no per-site workaround: the bags
are byte-identical and only the CALLER knows which it is. It is optional, so
none of the 77 providers implementing `update()` changed. Its one field today,
`desiredFromAwsReadback`, is named for what it asserts rather than for
"state-borne", and that distinction is load-bearing: the rollback executor's
revert arms ARE state-borne, but their desired bag is
`previousState.properties` — a TEMPLATE recorded earlier — so `{Rules: []}`
there means what the template meant and the template answer (SKIP) is correct.
Those arms deliberately pass NO context, and widening the flag to `stateBorne`
would sweep them in and delete a live configuration during a rollback. Only
`src/cli/commands/drift.ts`'s revert call passes it. When adding a field here,
ask what the flag lets a provider CONCLUDE, not merely where the call came
from.

Two things that are easy to get wrong and were both caught by review:
**normalize BOTH comparison sides**, not just the desired one — a record written BEFORE the provider started narrowing still carries every key, so a one-sided pass flips the same difference to a REMOVAL and breaks exactly the population the narrowing exists for; and **wire `cdkd diff` too**, since a preview that narrows differently from the apply forecasts a change the deploy will never make. `makeCanonicalizePropertiesFn` in `src/provisioning/canonicalize-properties.ts` is the one builder both commands use, so they cannot drift.


REMOVALS are a separate decision and the conservative reading usually stands: a
junk record cannot distinguish "cdkd created this and the template dropped it"
from "somebody added it out of band". But say so ACCURATELY — "re-deploy once
state is valid" was wrong, because once the corrected block is recorded the
live-only member is in neither side of every later diff and survives
indefinitely. Point at the remedy that works (`cdkd drift --accept`, then
re-deploy).

The full contract
is on `CreateContext` in `src/types/resource.ts` (NOT in `region-check.ts`
where `DeleteContext` lives — that type belongs there because its
`expectedRegion` feeds `assertRegionMatch`; a one-line pointer sits next to
`DeleteContext` so a reader looking for one finds the other).

**A create-side pre-flight refusal forbids re-creating inside `update()`.**
Several providers call `this.create(logicalId, resourceType, properties)` from
their own `update()` (ACM certificate, IAM managed policy, IAM role, Lambda
permission, SNS subscription). Those internal re-creates CANNOT receive a
context — `update()` has no context parameter — and the `properties` they
forward ARE a state record during a rollback replay (`rollback-executor.ts`'s
`revert` arm calls `provider.update(..., previousState.properties, ...)`, as
does `drift --revert`). So a provider that both refuses on create AND
re-creates inside `update()` would fire that refusal on a replay with no way
to detect it. None of the five does today (required-field validation only,
which correctly stays a hard error).

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

Register Provider for each resource type in Provider Registry:

```typescript
const registry = ProviderRegistry.getInstance();
registry.register('AWS::IAM::Role', new IAMRoleProvider());
```

## Custom Resources

- Supports Lambda-backed Custom Resources
- Create/Update/Delete lifecycle
- ResponseURL uses S3 pre-signed URL for cfn-response handlers
- **Response-bucket region correction (issue #1195).** The response bucket is cdkd's STATE bucket, which can live in a different region from the deploy region (account-scoped region-free default bucket). Before the first response-bucket S3 operation (placeholder `PutObject` + `ResponseURL` presign in `generateResponseURL`), `ensureResponseClient()` lazily resolves the bucket's actual region via the shared `rebuildClientForBucketRegion` helper (#827) and swaps in a region-corrected client — a pre-signed URL's host is region-specific, so signing with the deploy region against a foreign-region bucket 301s (`PermanentRedirect`). `setResponseBucket(bucket)` deliberately takes NO region parameter (issue #1202): correction always starts from the shared `AwsClients.s3` client, so `--profile` / static credentials carry into both the `GetBucketLocation` probe and the rebuilt client, and every call site (deploy / destroy / drift / state / rollback) is corrected the same lazy way.
- CDK Provider framework: isCompleteHandler/onEventHandler async pattern detection
- Async CRUD with polling (max 1hr), pre-signed URL validity 2hr
- Sets `disableOuterRetry = true` on the `ResourceProvider` interface so the deploy engine's outer `withRetry` loop does NOT re-invoke `provider.create()` on transient SDK errors. Each invocation derives a fresh pre-signed S3 URL and RequestId via `prepareInvocation()`; an outer retry would strand the first attempt's Lambda response at an S3 key nobody polls. Internal exponential-backoff polling on the response key handles eventual consistency on its own.
- **Transient IAM-authorization retry (CR-internal).** Because cdkd's fast SDK path attaches a backing Lambda's execution-role inline policy and invokes the function ~1s later, the function can cold-start before IAM propagates the policy to its assumed-role session — caching stale, policy-less credentials for the warm container's life. The CDK Provider framework's first invoke / `waitUntilFunctionActive` (`lambda:GetFunction`) then 403s ("not authorized to perform" / "not in the state functionActive") and the custom resource FAILs. CloudFormation never hits this because its deployment latency lets IAM settle; cdkd does NOT, so `invokeCustomResourceWithRetry()` re-invokes (default 2 retries; `CDKD_CR_AUTHZ_MAX_RETRIES`, 0 disables) when the FAILED reason matches the NARROW IAM-authz signal set (`CR_TRANSIENT_AUTHZ_SIGNALS` — `not authorized to perform` / `no identity-based policy allows` / `not in the state functionActive` / `cannot be assumed` / `is unable to assume`; generic timeouts / handler bugs are deliberately NOT retried). Each retry derives a fresh pre-signed URL/RequestId AND recycles the backing function's execution environment via a no-op `UpdateFunctionConfiguration` (so the next cold start re-assumes the role with the now-propagated policy — a plain re-invoke would reuse the same warm container's stale creds). This is the CR-path analogue of the IAM-propagation retry `withRetry` already applies to every other resource (the CR path opts out of `withRetry` via `disableOuterRetry`, so it retries internally instead). Verified end-to-end via the `custom-resource-provider` integ.
- **...and the reason string alone is NOT a sufficient signal for it** (issue [#1674](https://github.com/go-to-k/cdkd/issues/1674)). The FAILED reason is written by the HANDLER, so a handler that wraps an SDK / CLI failure in its own message — ordinary handler hygiene — erases every authz phrase before cdkd sees it, and the retry above never fires on a resource that is GUARANTEED to race. CDK's `BucketDeployment` is the widely-used instance: `aws_command()` lets `subprocess.check_call` raise, `str(CalledProcessError)` is only `Command '[...]' returned non-zero exit status 1.`, and CDK generates the handler role, its inline policy AND the custom resource in the same stack, so the asset-object 403 fails the deploy on the first attempt while looking like a handler bug. The denial survives only in the function's own log, so `invokeLambda` now passes `LogType: 'Tail'` and the retry consults `CR_TRANSIENT_AUTHZ_LOG_SIGNALS` (the reason set PLUS the CLI / SDK spellings `an error occurred (403)` / `accessdenied` / `access denied`) against the decoded tail whenever the reason itself carried none. Prefer this over reading CloudWatch Logs after the fact — the tail rides the invoke response cdkd already awaits, so it costs no CloudWatch client, no `logs:GetLogEvents` on cdkd's own credentials and no extra API call, and it is scoped to the exact invocation that failed rather than to whatever is latest in the log stream. It is returned UNDECODED from `sendRequest` so the happy path pays nothing; only a FAILED whose reason missed decodes it.
  **What is surfaced where is a DATA-CLASS decision, not a formatting one, and the axis is WHO AUTHORED THE TEXT — not how long it is.** Anything that reaches a THROWN message is captured by `extractDeploymentEventError` into `deployments/{runId}.jsonl`, a store that outlives `cdkd destroy` and whose header restricts it to error + metadata, explicitly never anything that may carry secrets. A backing function's log tail is arbitrary handler stdout, so an ordinary `logger.error(f"AccessDenied writing {event}")` puts the resource's `ResourceProperties` there. Truncation does NOT fix that: 200 chars bounds the VOLUME and 200 chars is precisely where a dumped properties bag begins. So:
  - On a terminal FAILED, what is folded into `cfnResponse.Reason` is the matched **SIGNAL PHRASE** — one of the fixed `CR_TRANSIENT_AUTHZ_LOG_SIGNALS` strings, authored by cdkd — never the verbatim log line. That reaches the create / update throw, the delete warn-and-continue AND the `cdkd events` record, so the post-mortem says "the log matched an IAM-authorization signal" instead of pointing back at CloudWatch, while carrying zero handler-authored bytes.
  - The verbatim line and the full tail live only in EPHEMERAL `logger.warn`s (the retry warning, the `FunctionError` arm, and the unexplained-failure arm below), capped at `CR_LOG_TAIL_WARN_MAX_CHARS` because CI logs and scrollback are not nothing either.
  - **A terminal FAILED that NOTHING explained gets the whole tail, ephemerally** (issue [#1687](https://github.com/go-to-k/cdkd/issues/1687)). #1674 fixed the diagnostic only for the authz-matched subset; for a 404 / traceback / JSON-decode failure cdkd had decoded the tail and then thrown it away, leaving `returned non-zero exit status 1.` and a trip to CloudWatch — the second half of what #1674 reported. The arm fires only when the reason carried no authz wording AND the log matched no signal, because both of those cases have already NAMED the cause and repeating the tail beside an explained failure is noise. Two things review had to correct, and both are about not asserting more than cdkd knows: `LogResult` is NEVER absent on a `LogType: 'Tail'` invoke (Lambda always emits `START` / `END` / `REPORT`), so a bare presence check filters nothing and would dump zero-value boilerplate on every unexplained failure — `hasHandlerLogOutput` requires at least one HANDLER-authored line, and the boilerplate set must include the COLD-START platform lines (`INIT_START` / `INIT_REPORT` / the SnapStart `RESTORE_*` pair / `EXTENSION`) or the filter is inert in its own main case — the IAM-propagation race this mechanism exists for IS a cold start, so those lines are present exactly when the arm fires. The trailing space in the pattern is load-bearing too: a handler's `print("REPORT: no bucket")` must not be classified as platform noise. The `FunctionError` arm applies the same filter, since both surface the same data class through the same ephemeral channel; and the tail belongs to the DISPATCH invoke, so on the Provider framework's async pattern it is not the failing execution's log at all, which on the SIGNAL path costs only a redundant retry but here would present an unrelated log as THE explanation — so the message names which invocation it came from and says the failure may have happened elsewhere. The wording likewise says cdkd "could not classify the reason" rather than that the reason was useless, which is all cdkd actually knows.

  Two review rounds landed here and both earlier positions were wrong: the first cut appended the WHOLE tail to the `FunctionError` throw, and the second folded the truncated verbatim LINE into the reason on the argument that "the reason is already handler-authored text". That argument does not transfer — a reason is text the handler CHOSE to hand to CloudFormation, a log line is text it wrote for itself.
  **Known bound.** The tail always belongs to the DISPATCH invoke. For a handler that works inline and PUTs the cfn-response itself — `BucketDeployment`, the case this exists for — that IS where the failure happened. For the Provider framework's genuinely async pattern it is not, so a stray denial logged by the `onEvent` wrapper buys a bounded extra retry with a message naming the wrong execution; that path is otherwise covered by the reason string, so the cost is redundancy, not a wrong answer. **Do not "fix" this by gating on `isAsyncPattern`** — that flag means only "the invoke returned no direct payload", which is equally true of `BucketDeployment` (its Python handler returns `None`), so gating on it switches off exactly the case the feature exists for. A bare `403` / `forbidden` is likewise NOT a signal: it would match a handler legitimately logging an unrelated downstream denial. Accepted cost, stated because a log surface is noisier than a handler-authored reason: a handler that merely LOGS a genuine permanent `AccessDenied` buys the bounded retries — the failure is DELAYED, never masked, since the original reason still surfaces. That cost is not purely wasted time: a re-invoke re-runs `Create`, so a non-idempotent handler repeats partial work and a Provider-framework `onEvent` can create a SECOND physical resource, orphaning the first. The exposure predates this change (the reason-string match could always retry) but the log signal widens what reaches it. `CDKD_CR_AUTHZ_MAX_RETRIES=0` disables the RETRY only — the log-tail scan and the reason annotation still run, since they describe the failure rather than react to it.
- Implements `getMinResourceTimeoutMs()` returning `asyncResponseTimeoutMs` (default 1h) so the deploy engine's per-resource deadline auto-lifts to the polling cap for CR resources only — Custom-Resource-heavy stacks no longer need `--resource-timeout 1h`. A user-supplied `--resource-timeout AWS::CloudFormation::CustomResource=<DURATION>` per-type override still wins as the explicit escape hatch.
- **Delete fail-fast when the backing Lambda is gone (issue #804).** `delete()` issues a single `GetFunction` pre-check before preparing the invocation; a definitive `ResourceNotFoundException` logs a warning and treats the Custom Resource as already deleted (warn-and-continue is the delete path's existing policy). Without it, a re-run after an interrupted / partially-failed destroy entered `waitForBackingLambdaReady`, whose SDK waiters classify `ResourceNotFoundException` as RETRY and poll `GetFunction` for the full 10-minute `maxWaitTime`. Inconclusive pre-check errors (throttle, IAM) fall through to the normal invoke path; SNS-backed tokens skip the pre-check; create / update never pre-check (they must fail loudly against a missing function).
- Implemented in `CustomResourceProvider`

## Reading a field off an AWS response: type != populated

An AWS SDK v3 response TYPE declaring a field does NOT mean the API you called
populates it. The models are shared across operations, so a `List*` summary can
declare `Tags?: Tag[]` and never carry tags. AWS documents the exception on the
COMMAND, not the model:

> IAM resource-listing operations return a subset of the available attributes
> for the resource. For example, this operation does not return tags, even
> though they are an attribute of the returned object. To view all of the
> information for an instance profile, see GetInstanceProfile.

`iam-instance-profile-provider` carried exactly this defect until PR #1127:
`import()` read tags off the `ListInstanceProfiles` summary, which typechecked
and always saw `undefined`. Because a tag-walk non-match is not an error, the
walk simply never matched and `cdkd import` reported the resource as
**not-found** — a silent wrong answer, not a crash. The provider's unit tests
hand-fed inline `Tags` and so agreed with the bug.

**When consuming a field from a `List*` / `Describe*` response:**

- Read the command doc
  (`node_modules/@aws-sdk/client-*/dist-types/commands/<Op>Command.d.ts`), not
  just the model in `models/models_*.d.ts`. Types prove SHAPE; only the command
  doc (or a live call against a populated account) proves POPULATION.
- Prefer a per-candidate `Get*` when the list form is documented as a subset.
  The extra call is the correct cost.
- A live probe that comes back empty because the account has no such resource is
  **inconclusive**, not confirmation.
- Ask of any test: "would this still pass if the API returned nothing for this
  field?" If yes, it pins your assumption, not the behavior.

## Never infer a default from a possibly-malformed value

`(config['Status'] as string) || 'Suspended'` reads correctly and is wrong: when
`config` is a STRING / array / unresolved intrinsic rather than the object the
template was supposed to carry, the index yields `undefined` and the `||`
substitutes the default — frequently the OPPOSITE of what the template declared,
with no error anywhere. `VersioningConfiguration: 'Enabled'` on an
`AWS::S3::Bucket` turned versioning OFF on a live bucket (issue #1471); the shape
was measured at 16 sites across 5 providers.

**The `??` spelling is the same bug** (issue #1493), it defaults on MORE than
`||` did (`??` also substitutes on an explicit `null`), and measuring it is
where the work actually goes wrong. Three greps, in increasing order of
usefulness:

- `\] \?\? '` — the obvious one, and it finds **zero** real sites. The cast sits
  INSIDE the parens.
- `as [A-Za-z]+\) \?\? '` — better, still blind to every `as string | undefined`,
  quoted-union and line-wrapped site, four of which #1493 had to fix.
- `as [A-Za-z<>,| ]+\) \?\? '` — the class-covering form. Follow it with a hand
  pass for wrapped sites; a purely mechanical count will be short.

Do not trust a cast-specific pattern in either spelling:
`(properties['AuthType'] as FunctionUrlAuthType) || 'NONE'` survived the #1471
sweep for exactly that reason and kept defaulting a blank AuthType to a PUBLIC
Lambda function URL.

**And check the GATE in front of the guard, not just the read.** A guard behind
`if (container)` is skipped entirely by a FALSY malformed value — `Source: ''`
still built a `NO_SOURCE` project after the guard was added. Use `!= null`, per
the "cover the CREATE path" rule above; #1493 shipped the gate bug and a
reviewer caught it. Roll the
guard onto the sites that INDEX A NESTED CONTAINER; a top-level
`properties['X'] ?? 'default'` read cannot hit rule 2 at all (the bag is always
an object) and refusing a non-string there is a separate, riskier decision —
issue #1513 settled it PER SITE, and `config-shape.ts`'s header records the
full split.

**A silent DROP is the sibling class, and `readConfigString` does not cover
it** (issue #1493 item 2). Where the defaulting bug substitutes a value the
template did not ask for, this one omits the block entirely: a provider that
picks between two accepted shapes by PROBING member presence —
`dest?.['BucketArn'] || dest?.['Format'] ? dest : dest?.['S3BucketDestination']`
— indexes every probe of a malformed `dest` to `undefined`, falls through to an
equally-`undefined` nested bag, and the caller's `s3Dest ? … : undefined` sends
the request without the destination. Nothing is defaulted, so no guard in
`config-shape.ts` fires. Two rules, both learned on the S3 analytics /
inventory sites:

- **Refuse on create, warn on update** — the same split as the update-path
  question below, for the same reason (a rollback replays `update()` with a
  historical STATE record as the desired bag). The appliers take an optional
  `onUnusable` callback; the create-path caller omits it and the update-path
  caller passes `this.logger.warn`.
- **Probe every member the readers accept.** The S3 branch probe omitted
  `Bucket` although the reader below it was `s3Dest['BucketArn'] ??
  s3Dest['Bucket']`, so a `{ Bucket }`-only block took the nested branch, found
  nothing, and dropped — the same silent drop one shape over. A probe narrower
  than its reader is a bug by construction.

Report the CFn path of the branch you PICKED, not a hardcoded one (item 3): the
flattened branch's bag IS `dest`, so a refusal naming
`…Destination.S3BucketDestination` points at a key the user's template does not
contain.

**A top-level site takes three questions, not one** (issue #1513):

- **Can the field legitimately arrive as a NUMBER?** CFn coerces scalars and
  cdkd does not, so an unquoted YAML `IpProtocol: -1` / `Qualifier: 1` deploys
  fine today and a refusal would break a working template. Those sites pass
  `{ coerceNumber: true }`; an enum-valued field (`InstanceType`,
  `AuthorizationType`, `Status`, `Domain`, `BillingMode`) does NOT — a number
  there is a bug.
- **Is the site on the UPDATE path?** Then WARN, do not throw
  (`{ onUnusable: (m) => this.logger.warn(m) }`). `rollback-executor.ts` replays
  a rollback via `provider.update(..., previousState.properties, ...)`, so the
  desired bag can be a historical STATE record — a refusal there makes the
  resource UN-ROLLBACKABLE with no template-side remedy. Throw on CREATE, where
  the value is always template-borne. (Same rule as
  `update-refusal-breaks-rollback-replay`.)
- **Is the read in a helper the DELETE / diff paths also reach?** Then leave it
  unguarded and guard the create CALL SITE instead. `EC2Provider`'s
  `buildIpPermission` is textually a top-level read but is also reached from
  `deleteSecurityGroupIngress` and from the REVOKE half of the inline-rule diff,
  both carrying state-borne rules — a guard inside it would break destroy.

Use `src/provisioning/config-shape.ts` instead of hand-writing the guard:

```ts
// nested container (may itself be malformed)
const status = readConfigString(
  versioningConfig, 'Status', 'Suspended', 'AWS::S3::Bucket VersioningConfiguration'
);
// top-level field — keep the properties['X'] read at the call site
const scope = requireConfigString(properties['Scope'], 'REGIONAL', 'AWS::WAFv2::WebACL Scope');
```

Three things about it are non-obvious and each was forced by the real tree:

- **Guard the DESIRED side only.** `previousProperties` comes from cdkd STATE,
  not the user's template. Refusing a malformed value recorded there by an older
  binary makes the stack permanently undeployable — editing the template does not
  help, because the previous side stays malformed until a deploy succeeds. An
  earlier attempt guarded both sides and had to be reverted.
- **Validate the FIELD, not just the container.** `{ Status: null }` and
  `{ Status: '' }` both pass a `typeof === 'object'` check and still fall through
  to the default. An ABSENT key must keep defaulting, though — `{}` legitimately
  means Suspended.
- **Cover the CREATE path.** A truthiness gate (`if (versioningConfig)`) lets a
  truthy-but-malformed value through on create only, so create and update
  disagree; use `!= null` so both refuse it. Same rationale as the
  OwnershipControls / BucketEncryption gates.

Pre-flight template validation is NOT the right layer for the field rules: at
pre-flight time intrinsics are unresolved, so a legitimate `Fn::If`-valued block
is an object whose inner key does not exist yet and a field check would reject
valid templates.

**A property COMBINATION rule is the exception, and it is pre-flight's job**
(issue #1634). Where a field rule asks what a value IS — undecidable before
resolution — a mutually-exclusive rule asks only which top-level keys are
unconditionally PRESENT, which the raw template already answers. It also has to
live there, because a provider-side refusal is only reachable on a
template-borne CREATE: once the resource exists the diff classifies NO_CHANGE,
the provider is never called, and the invalid template deploys forever (exactly
what `AWS::EC2::Route`'s #1566 refusal could not catch after #1591 normalized
both diff sides). `src/provisioning/mutually-exclusive-properties.ts` holds the
rule table and `ProviderRegistry.validateResourceProperties` applies it, ahead
of the silent-drop routing chatter. The intrinsic constraint above still binds
and is what makes the check safe: a key behind an unresolved intrinsic counts
as UNKNOWN, never as declared, since its `Fn::If` arm can resolve to
`AWS::NoValue` — so the check refuses only two or more unconditionally present
keys, and a combination it lets through is still caught by the provider's own
create-path refusal. Add a rule ONLY for a combination AWS itself rejects:
there is deliberately no `--allow-*` escape hatch (the defect is in the
template, not in cdkd), so a wrong entry blocks a valid deploy with no way
around it.

## Fixing ONE nested-key divergence: diff the WHOLE blob, not the reported key

A filed silent-drop bug names the key someone happened to notice. Fixing only
that key leaves its siblings broken, and the sibling is often the WIDER
breakage — the reported key may be the rarer shape.

Issue #1389 reported `ByteMatchStatement.SearchStringBase64` (CFn-only, no SDK
member) on `AWS::WAFv2::WebACL`. A reviewer extracted **all 154** CFn keys in the
`CfnWebACL` tree from `aws-cdk-lib`'s `convertCfnWebACL*PropertyToCloudFormation`
renderers and diffed them against the SDK schema member-name set. That found a
second divergence the issue never mentioned: CFn spells the reference-statement
ARN `Arn` while `IPSetReferenceStatement` / `RegexPatternSetReferenceStatement` /
`RuleGroupReferenceStatement` all declare it `ARN` **and mark it required** — so
every WebACL using a reference statement failed `CreateWebACL`, base64 or not.
That is a far more common template shape than the base64 search string.

**Before fixing a nested-key divergence:**

- Enumerate the CFn side MECHANICALLY, from `aws-cdk-lib`'s generated
  `convertCfn<Type><Prop>PropertyToCloudFormation` functions or the registry
  schema's `nestedPropertyPaths` capture (or its flattened `nestedProperties`
  sibling) — not by reading the type by eye.
- Enumerate the SDK side from the schema serde aliases
  (`node_modules/@aws-sdk/client-*/dist-cjs/schemas/schemas_0.js`) as well as the
  `.d.ts` members: the aliases are what the serializer actually iterates, so
  "`_ARN = "ARN"` exists and `_Arn` does not" is the decisive evidence.
- Diff the two sets and fix EVERY divergence in the same change. Report the
  count you compared, so a reviewer can tell a full diff from a spot-check.
- Prefer adding the type to `NESTED_KEY_TARGETS` (see step 4 below) over relying
  on this being done by hand next time — the mechanical critic is the durable
  form of this rule.
- **Know what membership does and does not guarantee.** For a provider that
  FORWARDS a config blob, membership makes the key-spelling class
  non-regressing. For one that builds a FRESH SDK object naming each member,
  a matching spelling proves nothing: the critic's `same-spelling` bucket is
  silent, and a member the mapper never names is dropped anyway. That is issue
  #1432, found on `AWS::CodeBuild::Project` `BuildBatchConfig.BatchReportMode`
  — CFn declares it, the SDK declares `batchReportMode`, the provider named
  four of five members, and the critic stayed silent even with every
  occurrence of the SDK spelling renamed away.
  So a fresh-object provider must ALSO set `freshObjectMapper: true` on its
  target, which turns on the WRITE-EVIDENCE pass: each would-be
  `same-spelling` key then has to appear as a WRITTEN SDK member
  (`batchReportMode: ...`, `{ batchReportMode }`, `sdk.batchReportMode = ...`,
  the compound `??=` / `||=` / `+=` forms, or
  `Object.defineProperty(sdk, 'batchReportMode', ...)`) or it lands in the
  CI-blocking `no-write-evidence` bucket. Reads do not count,
  `readCurrentState`'s reverse map is excluded, and a literal built only to be
  DIFFED (`JSON.stringify({ … }) !== JSON.stringify(prev)`) is not delivery —
  so the evidence is scoped to the CFn->SDK direction.
  Measure before setting it. The opt-in set is decided by measurement, never
  by prediction, and the full before/after table lives in the script's file
  header. Today `AWS::CodeBuild::Project`, the five `AWS::ApiGatewayV2::*`
  targets, both `AWS::ECS::*` targets, `AWS::CloudWatch::AnomalyDetector`,
  `AWS::CloudFront::Distribution` (issue #1475, via the spread-and-patch
  recognizer) and all three `AWS::AppSync::*` targets (`GraphQLApi` at issue
  #609, opted in at 0 with the type's config blobs; `DataSource` + `Resolver`
  at issue #1597, once their schema fixtures were re-captured with the
  `definitionShapes` / `nestedPropertyPaths` sections the generator requires —
  `Resolver` measured 0 on the first run, `DataSource` measured 10 and needed
  the `HttpConfig.AuthorizationConfig` + `DynamoDBConfig.DeltaSyncConfig` /
  `.Versioned` forwards the opt-in exposed) are in; `AWS::S3::Bucket` carries a
  recorded, measured reason it is not.
- **A whole sub-blob handed to a GENERIC key converter is credited (issue
  #1445).** `ECSProvider.convertLinuxParameters` is
  `return pascalToCamelCaseKeys(config)` — one call delivers `Capabilities` /
  `Devices` / `Tmpfs` / `Swappiness` and everything beneath them, correctly
  wired and with no per-member write to find. `collectWriteEvidence` follows
  that hand-off: a value read off the DESIRED property bag
  (`HANDOFF_BAG_PARAM_NAMES`, declaration-scoped taint) that reaches a WRITE
  without any member of it being named — through `?:` / `??` arms, `const`
  bindings, spread-only literals, and `this.f(…)` / free-function /
  sibling-module calls — is a hand-off PATH, and everything AT OR BENEATH that
  path is credited (`isHandoffCovered`'s prefix test since #1464; #1445 shipped
  it as a fold through the SDK model's reference graph, which a flat scope
  needed and a path-keyed one does not).
  Two halves of that are what keep it from becoming a rubber stamp, and both
  are worth knowing before you rely on it:
  - A callee counts as GENERIC only when it names NO member — anywhere in its
    body OR in any callee it can reach. `convertLoadBalancers` names four, so
    every member of the blob it builds still has to prove itself, which is how
    the pass found that `LoadBalancers.AdvancedConfiguration` was silently
    dropped (fixed in #1473; both ECS targets are opted in since). The TRANSITIVE part is what refuses a DELEGATING GUARD
    (`convertLog(cfg) { if (!cfg) return cfg; return this.buildLog(cfg); }`),
    which a body-local test would accept.
    Read the rule as exactly "names no member", NOT as "can only emit keys it
    read": a converter that FILTERS, RENAMES via a map, or PICKs a key list
    names nothing and is still credited — recorded as known bound (5).
  - The credit is bounded to the BLOB, not to the enclosing scope.
    `ContainerDefinitions` carries the `LinuxParameters` hand-off AND
    `convertPortMappings`; crediting the whole scope would have hidden the
    missing `containerPortRange`.
  A blob read back off an AWS response and re-sent (CloudFront's
  disable-then-delete path) is NOT a hand-off — that is what the property-bag
  taint root is for, and without it 108 of CloudFront's 110 findings cleared
  falsely.
- **The BUILDER idiom is credited too (issue #1474).** A sub-blob assembled by
  MUTATION — `const mapped = {}; mapped.MetricTimezone = …;
  mapped.ExcludedTimeRanges = …; params.Configuration = mapped;` — names every
  member it delivers, per member, on the forward path; only the AST location
  differs from a literal's, so `resolveLiterals` stopped at the empty seed and
  every child of `Configuration` reported `no-write-evidence` falsely. That was
  all three of `AWS::CloudWatch::AnomalyDetector`'s residuals, and it is why
  that target can now opt in at 0. A BUILDER is a local binding whose
  INITIALIZER is an object literal (empty or partial), populated afterwards by
  `out.Foo = …` / `out['Foo'] = …` assignments onto THAT BINDING, and reaching
  a write; the credit lands at the same path a literal would have got, at full
  depth (`out.Rule.DefaultRetention = { Mode }` opens the intermediate scopes
  rather than flattening). Three things keep it from being a rubber stamp:
  the literal initializer (so the object's identity is this file's — a
  `const out = makeThing()`, a `let out;` seeded later, and a binding
  REASSIGNED as a whole are all refused); DECLARATION IDENTITY rather than the
  bare name; and the credit bounded to the BUILDER, never the enclosing
  scope — the `ContainerPortRange` trap one recognizer over. Delivery stays the
  caller's question: the builder walk only runs from a write site, which the
  `feedsOnlyComparison` rule has already filtered, so a builder that is never
  handed to a write, or handed only to a diff, is never credited. Recognizing
  the shape is MONOTONE (it only adds scoped members), so no target gained a
  finding; the tree's residual fell 290 -> 260 and `AWS::S3::Bucket`'s
  125 -> 98.
  **"Declaration identity" required fixing `declarationOf` itself**, and the
  gap was live in this recognizer before the #1474 review caught it: that
  helper searched the nearest FUNCTION scope and descended fully into nested
  functions, returning the FIRST textual match, so the bare-name weakness of
  known bound (3) reached INSIDE a single function. Two same-named `const cfg`
  builders in different `if` arms collapsed onto one declaration and MERGED
  their member sets (each vouching for the other's blob — false CLEAR), and a
  `const cfg` inside a nested arrow declared textually first captured the
  enclosing function's own `cfg` (outer member falsely flagged, inner falsely
  cleared). `const` / `let` are BLOCK-scoped, so `declarationOf` now resolves
  outward through BLOCK scopes, which is both the accurate model and the fix;
  it cannot under-resolve a valid binding either, since a reference outside the
  declaring block is a compile error. Both shapes are pinned by tests. The
  sibling-METHOD case worked from the start — it is the intra-function one that
  did not, which is why "we already have a test for same-named bindings" was
  not evidence.
  **The recognizer WIDENS known bound (4)** (prefix-only reverse-map
  exclusion), measured: a reverse SDK->CFn helper that is NOT named
  `readCurrentState*` and uses the builder idiom previously contributed only
  its empty seed and now contributes a populated SCOPE —
  `s3-bucket-provider.ts`'s `readLifecycle` (`const out = {}` filled with
  CFn-spelled `out['Id']` / `out['Status']`) and `ecs-provider.ts`'s
  `volumesToCfn` are exactly that, and S3's non-empty scope count jumped
  85 -> 144 partly on their strength. No effect on today's verdicts (S3 is not
  opted in; ECS is `lower-first`, so a CFn-spelled terminal misses the exact
  compare) — but S3 is `exact`-style, where a CFn-spelled reverse write vouches
  for the forward mapper verbatim, so widening
  `REVERSE_MAP_FUNCTION_PREFIXES` to a suffix match belongs to the S3 opt-in
  (issue #1520 — the structural half split out of #1495, whose silent-drop half
  is fixed), where its effect on the LITERAL set can be measured on the target
  it affects. A `readCurrentState*`-named helper nested in a builder's
  scope IS skipped today, and that branch — the only builder refusal in the
  over-crediting direction — is pinned by a test with a non-reverse-named
  control.
- **Write evidence is PATH-SCOPED (issue #1448), and the bound it replaced is
  worth knowing.** As shipped in #1432 the evidence was a flat per-FILE set of
  member names and the audited unit was a key NAME, so a member written
  ANYWHERE vouched for every key of that spelling — 11 of CodeBuild's 55
  same-spelling keys had more than one write site, and
  `BuildBatchConfig.ServiceRole` (the sibling of the member that motivated
  #1432) stayed silent when dropped because the unrelated top-level
  `serviceRole` write covered it.
  Both sides moved in #1448: the audited unit became the PATH
  `TopLevelProperty.NestedKey`, and each written name was indexed to the members
  written BENEATH the value it is written with (`collectWriteEvidence`,
  resolving `this.mapSource(x)` calls, `const` / `let` bindings, `?:` / `??`
  arms and `.map(cb)` callbacks — the same reach as the #1404 taint walk), so
  the `BuildBatchConfig.ServiceRole` deletion exits 1.
- **...and scoped at FULL DEPTH since issue #1464.** #1448 stopped one level
  short because of the FIXTURE: `nestedProperties` is a flattened transitive
  closure per top-level, so `Environment.Type` and
  `Environment.EnvironmentVariables.Type` were literally the same audited path
  and each vouched for the other. The fixture now also carries
  `nestedPropertyPaths` (full `$ref`-resolved, cycle-guarded chains,
  `extractNestedPropertyPaths` in `scripts/refresh-cfn-schemas.mjs`; arrays are
  transparent), and the write index is keyed by the matching write PATH. Three
  consequences: a terminal member is checked against the scope its FULL PARENT
  CHAIN maps to; a whole-blob hand-off credits by path PREFIX (tighter than the
  #1445 fold through the SDK model, which is now only a parser floor); and a
  write that only ever appears LEXICALLY nested no longer opens a root scope.
  Measured against the real `codebuild-provider.ts` via `--providers-dir=`:
  deleting `environment: { type: … }` exits **1** naming `Environment.Type`
  with the cousin clean, and deleting `environmentVariables[].type` exits **1**
  naming `Environment.EnvironmentVariables.Type` with the cousin clean.
  The audited unit grew 587 -> 703 paths, so every `minNestedKeys` floor was
  re-calibrated, as was ECS's `minWriteScopes` (34 -> 58 non-empty scopes; 70
  after #1474's builder recognizer opened the scopes a mutated binding
  populates — the declared floor is a lower bound, so it did not need moving).
  **Two SEGMENT-SPELLING mechanisms sit under the full-depth match, and they are
  not interchangeable.** A CASE difference on an intermediate segment is
  absorbed: the parent chain is matched case-insensitively (the terminal member
  is not — it is the only thing that proves delivery), because a CFn->SDK
  segment spelling is routinely not the mechanical first-letter flip
  (`EFSVolumeConfiguration` -> `efsVolumeConfiguration`) and an exact parent
  match reported 16 members `ecs-provider.ts` demonstrably does write. The fold
  is applied one LEVEL at a time while descending the write index, never as a
  global lowercase union — that would merge the member sets of the 80 unrelated
  `name` / `Name`-style scope pairs the same file carries. A genuine RENAME is
  out of the fold's reach and needs an explicit
  `segmentRenames` entry on the target (`ProxyConfigurationProperties` ->
  `properties`, the one in the tree), which is STALENESS-FENCED exactly like
  `NESTED_KEY_ALLOW_LIST`: `--check` fails when the un-renamed chain starts
  resolving (the SDK renamed it back) or the CFn segment disappears. It does NOT
  fail when the provider merely stops writing the member — that is the
  divergence the map exists to make reachable, and a stale-map error standing in
  front of it would hide a real silent drop behind a tooling complaint.
- **The pass still has a measured BOUND — do not repeat the over-promise this
  bullet exists to correct.** Depth-scoping NARROWS the duplicate-name class
  further; it does not make it vanish, and the residual is NOT only #1445's
  generic converter.
  1. **A duplicate name at the SAME PATH still vouches**, because the write index
     unions across write SITES. Two `environment: { … }` literals in different
     methods both feed the one `environment` scope, so a provider that stops
     writing a member on ONE code path is not fenced. Per-site sets would not
     change the answer — a key is cleared when ANY site covers it, which IS the
     union.
     Hand-off points are unioned the same way, and it is measurable:
     `ApiGatewayV2Provider` forwards `DefaultRouteSettings` whole at two sites
     (create + update), and deleting only ONE of them leaves `--check` at exit
     0.
  2. **A literal reached only by INDIRECTION still opens a root scope.** Root
     suppression is lexical, so a literal returned by a helper (or bound to a
     `const`) has no object-literal ancestor and its members are recorded at
     depth 1 as well as under the caller's path. Harmless unless a nested member
     name collides with an audited TOP-LEVEL property of the same type —
     measured today: on the API Gateway v2 targets every path cleared by a
     hand-off wildcard is one of the 18 legitimate blob members (6
     `CorsConfiguration.*` + 5 `DefaultRouteSettings.*` + 2
     `JwtConfiguration.*` + 2 `AccessLogSettings.*` + 1 `RequestParameters.*`,
     plus `TlsConfig.*` and `ResponseParameters.*` from the issue #609
     `::Integration` backfill), none by a stray root. The count was 13 when
     this was first measured and moved with each of the two #609 batches —
     re-measure it rather than trusting the number. Suppression follows a
     `.map(v => ({ … }))` callback, because `resolveLiterals` does; it does NOT
     follow an opaque call such as `JSON.stringify({ … })`, because nothing
     resolves that in the other direction and suppressing there would LOSE the
     write.
  3. **Value resolution is best-effort and bare-name.** Same-file callables and
     property initializers are indexed by NAME, so `this.mapSource(…)` and a
     free `mapSource(…)` resolve to the same declaration while a
     `receiver.mapSource(…)` on some other object deliberately does not.
     Identifier bindings are searched in the nearest function scope (descended
     FULLY, so two disjoint `if` branches binding the same name are unioned),
     then OUTWARD without descending into sibling functions, with a PARAMETER of
     the nearest scope stopping the climb. A hop it cannot follow yields no
     literals and flags CORRECT code, which is why it peels `await` and climbs
     to the module scope at all.
     The #1445 SDK-side expansion was bare-name the same way (`Items` reached
     217 members in the CloudFront model); since #1464 the hand-off credit is a
     path-prefix test that never consults the SDK model, and the expansion
     survives only as the `minHandoffPoints` parser floor.
  4. **The reverse-map exclusion is PREFIX-only**, so a suffix-named reverse
     helper (`volumesToCfn`, `metricsSdkToCfn`) is not skipped. No live impact —
     the only opted-in target keeps its reverse map inside `readCurrentState` —
     but widening the match would also withdraw names from the LITERAL set on
     targets nobody has measured for it, so it is deliberately not done.
  5. **The genericity test means "names no member", not "preserves every
     key".** It is transitive through resolvable callees, which closes the
     delegating guard — but a FILTERING (`if (DROP.has(k)) continue`),
     RENAME-MAP (`out[MAP[k] ?? k] = v`) or PICK (`for (const k of KEEP)`)
     converter names nothing and is credited anyway. No such shape is a
     hand-off callee today, but `glue-provider.ts`'s `renameRecordKeys` is
     exactly the rename-map shape and would be credited the moment a Glue
     target opted in. Closing it needs the walk to model the converter's KEY
     SET, not just its member names.
  6. **The SPREAD-AND-PATCH forwarder is CLOSED by issue
     [#1475](https://github.com/go-to-k/cdkd/issues/1475)** (it sat here as the
     last unrecognized shape; the BUILDER idiom beside it was closed by issue
     [#1474](https://github.com/go-to-k/cdkd/issues/1474) — see the builder
     bullet above, bounds under known bound (8)). A literal spreading a
     BAG-DERIVED seed (`const result = { ...config }`) inside an otherwise
     member-naming function registers a hand-off at its write path, BOUNDED by
     the keys the function `delete`s off the binding (resolved through the
     `Object.entries(TABLE)` / literal-array loop shapes; an unresolvable
     delete key refuses the whole registration, fail-closed) — which is what
     opted `AWS::CloudFront::Distribution` in at 0 findings (162 -> 0, two
     `Tags.*` paths allow-listed as written one SDK wrapper level below the
     CFn chain). What it deliberately does NOT exclude is known bound (9) in
     the script header: an OVERWRITTEN member stays credited through the
     spread, and the spread delivers the seed's spelling verbatim.
  7. **An intermediate segment the provider RENAMES leaves its children
     unresolvable** (new with #1464). Case differences are absorbed; a rename is
     not — CFn `ProxyConfiguration.ProxyConfigurationProperties` is the SDK's
     `ProxyConfiguration.properties`, so
     `ProxyConfiguration.ProxyConfigurationProperties.{Name,Value}` report
     `no-write-evidence` although `convertProxyConfiguration` writes both. Two
     occurrences in the tree, both on `AWS::ECS::TaskDefinition`, both pinned by
     a test rather than allow-listed. The direction is the SAFE one (a loud
     false positive, never a silent clear), but it has to be resolved before
     that target opts in.
  Bounds (1) and (2) are pinned by tests, and so are the two bounds #1464 CLOSED
  (the same probes, inverted into fences). The full measured statement lives in
  the script's file header. For all of the above, a hand diff of the WHOLE blob
  (the first bullet in this section) is still the thing that catches a dropped
  sub-key.
- **Allow-listing a nested key does NOT silence the write pass by default.**
  `NESTED_KEY_ALLOW_LIST` entries silence the key and shape passes (the
  deliberate #1378 cross-pass sharing); an entry must say
  `passes: ['write', ...]` to clear a `no-write-evidence` verdict, because "this
  key is a legacy member with no modern SDK equivalent" says nothing about
  whether the provider writes a member it demonstrably has. Entries are matched
  PATH-first, terminal-name-second, so `…#BuildBatchConfig.ServiceRole` scopes a
  decision to one path while `…#ServiceRole` covers the key wherever it is
  reachable.
- **Naming a CFn key's literal is no longer enough to clear the key pass on a
  write-evidence target (issue #1393 item 2).** A key with no same-spelled SDK
  member needs the literal PLUS scoped delivery proof: a genuine SDK member
  written at the resolved parent chain whose case-folded name equals the key,
  or a `terminalRenames` entry that resolves on the write side. When a
  conversion is real but invisible to the write walk (a computed-key rename
  loop, a destructured helper return), declare a `passes: ['key']` allow-list
  entry with the write site named in the rationale — do NOT scatter decoy
  literals to appease the critic.

## Adding a New SDK Provider

1. Create new file in `src/provisioning/providers/`
2. Implement `ResourceProvider` interface
3. Register in `src/provisioning/register-providers.ts` within the `registerAllProviders()` function
4. Refresh the CFn schema fixture for the new type: `node scripts/refresh-cfn-schemas.mjs --only-missing` (requires AWS credentials with `cloudformation:DescribeType`). Then classify every unaccounted property into `handledProperties` (if `create()`/`update()` wires the field) or `unhandledByDesign` (with a one-line rationale) so the new `property-coverage` test stays green — see [docs/provider-development.md](../../docs/provider-development.md) §3c. If the provider FORWARDS a nested config blob (a `handledProperties` entry whose value is a nested object/array the provider re-shapes for the SDK), ALSO add it to `NESTED_KEY_TARGETS` in `scripts/gen-nested-key-coverage.ts` — the critic's first run audits every nested key spelling against the SDK model (the #1370 silent-drop class, issue #1373). If the provider builds FRESH SDK objects naming each member rather than forwarding the blob, set `freshObjectMapper: true` too, after measuring the finding count — see the "Know what membership does and does not guarantee" bullet above (issue #1432).

   Adding an EXISTING type to `NESTED_KEY_TARGETS` needs a different refresh invocation: `node scripts/refresh-cfn-schemas.mjs '<AWS::Service::Type>'` with an explicit type argument, NOT `--only-missing`. `--only-missing` skips every type that already has a fixture file, and a fixture captured before the `definitionShapes` / `nestedPropertyPaths` extension does not carry the sections the generator reads — 14 of 134 fixtures had them as of 2026-08-12, i.e. exactly the then-current target set. `loadReport` throws naming the missing capture and the command rather than auditing zero paths, so the failure is loud; the point of this note is that the fix is not the command the previous paragraph names (issue #1699). The refresh is additive for an unchanged type — it rewrites `generatedAt` and adds the capture sections, leaving `properties` / `readOnlyProperties` / `createOnlyProperties` untouched — but re-run `vp run gen:all-matrices` afterwards, because `primaryIdentifier` also arrives with it and feeds `gen-enrichment-coverage` (opting `AWS::Lambda::EventSourceMapping` in this way retired a false `Id` enrichment gap the stale capture had been reporting; PR #1694).
5. Write tests
6. Add the resource type to [docs/supported-resources.md](../../docs/supported-resources.md) (deploy/manage capability table) AND to [docs/import.md](../../docs/import.md) (import-side coverage: auto-lookup vs override-only vs sub-resource)
7. **If the provider gates a stabilization wait on `process.env['CDKD_NO_WAIT']`** (i.e. `--no-wait` skips a multi-minute poll for this type), add the resource type to the `--no-wait` docs in ALL of: the `--no-wait` table + intro in [docs/cli-reference.md](../../docs/cli-reference.md), the `--no-wait` feature bullet in [README.md](../../README.md), and the `noWaitOption` help string + JSDoc in [src/cli/options.ts](../../src/cli/options.ts). Enforced by `tests/unit/provisioning/no-wait-doc-coverage.test.ts` (fails CI if a `CDKD_NO_WAIT`-honoring provider has no handled type in the cli-reference table). The `AWS::Lambda::MicrovmImage` provider shipped honoring `--no-wait` but missed this list — the test is the backstop.

   The same 4-site rule applies to the opposite end of the axis,
   `process.env['CDKD_FULL_WAIT']` (`--full-wait`, issue
   [#1275](https://github.com/go-to-k/cdkd/issues/1275)): a provider that
   waits ONLY under `--full-wait` belongs in the same wait-semantics table AND
   in the `--full-wait` section of
   [docs/cli-reference.md](../../docs/cli-reference.md). Enforced by
   `tests/unit/provisioning/full-wait-doc-coverage.test.ts` (added when
   `AWS::CloudFront::Distribution` joined `AWS::ECS::Service` as the second
   such type, issue [#1282](https://github.com/go-to-k/cdkd/issues/1282)).

   Before adding EITHER kind of wait, settle the completion definition per
   [docs/cli-reference.md](../../docs/cli-reference.md)'s wait-semantics rule:
   where CloudFormation and Terraform agree, match them; where they disagree,
   the default takes the dev/test-friendly side and `--full-wait` opts into the
   CloudFormation one. A default may take the fast side even where BOTH
   engines wait, but only under the 3-condition fast-side clause (issue
   #1282, recorded in the cli-reference wait-semantics intro): (a) no
   in-deploy consumer of the waited-for state, (b) no failure signal in the
   wait, and (c) the comparison tool has both modes so the benchmark can
   report two like-for-like rows. Record the divergence in the table rather
   than leaving it implicit in provider code.

See [docs/provider-development.md](../../docs/provider-development.md) for details.
