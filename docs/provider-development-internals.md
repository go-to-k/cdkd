---
title: Provider Development internals
description: "Contributor reference for the less common ResourceProvider return fields and methods: effectiveProperties, canonicalizeDesiredProperties, noEchoAttributes, the orphan identity methods, and what import must return."
unlisted: true
---

# Provider Development internals

[Provider Development](provider-development.md) walks through a provider that
needs none of what is on this page. Come here when your provider does one of
these things:

| Your provider | Read |
| --- | --- |
| Returns a secret in `attributes` | [`noEchoAttributes`](#noechoattributes-and-noechoattributenames) |
| Sends AWS something other than the declared properties | [`effectiveProperties`](#effectiveproperties) |
| Serves a type whose failed create can leave an orphan under a reusable name | [`isSameResource` and `resourceIdentity`](#issameresource-and-resourceidentity) |
| Implements `import` for a type whose `Ref` or `Fn::GetAtt` reads a recorded attribute | [What `import` returns](#what-import-returns) |

## `noEchoAttributes` and `noEchoAttributeNames`

**`noEchoAttributes` — the attributes you are returning are SENSITIVE**
(issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)). Leave it absent
and nothing changes. Set it and the deploy engine registers every string value
in `attributes` as a redaction needle, so `state.json` stores `***` in its
place — in this resource's own `attributes`, in the resolved `properties` of
every resource that consumed one through `Fn::GetAtt`, and in `state.outputs`.

Three things about it are decisions rather than accidents, and each is a rule
for a second producer:

- **`noEchoAttributes` is WHOLE-BAG, and that matches its producer.**
  `CustomResourceProvider` relays the `NoEcho: true` field of the
  CloudFormation custom-resource RESPONSE envelope — a property of the
  response, not of one `Data` member — so declaring one member sensitive would
  invent a granularity the wire format does not have. Use
  `noEchoAttributeNames` instead when your bag genuinely MIXES sensitive and
  ordinary members: `NestedStackProvider` does, because its attributes are a
  whole child stack's outputs, of which typically one is sensitive. Declaring
  such a bag whole would mask every unrelated member into this record and into
  every resource that consumes one — degrading resources that have nothing to
  do with the secret. A name the returned `attributes` does not carry is
  ignored.
- **Do NOT mask the values you return.** They are what `Fn::GetAtt` resolves
  to, and CloudFormation delivers a `NoEcho` custom resource's `Data` to a
  dependent resource in the CLEAR (measured against real CloudFormation).
  Masking at capture would make a template feeding the value into
  `AWS::SecretsManager::Secret.SecretString` store the literal mask AS the
  secret. Report the flag; let the engine decide what to write down.
- **It is per-CALL and not persisted.** A `create()` that reports it and a
  later `update()` that does not are two honest statements about two
  responses. `ResourceState` has no durable field for it, which is why cdkd
  REFUSES rather than guessing when a later deploy has to write a value it can
  only read back as the mask — see
  [State Store](state-management-secrets.md#custom-resource-responses-marked-noecho)
  for the user-facing consequences, and issue
  [#2449](https://github.com/go-to-k/cdkd/issues/2449) for the schema bump that
  would close it.

## `effectiveProperties`

**`effectiveProperties` — only when you deliberately NARROW what you send**
(issue [#1591](https://github.com/go-to-k/cdkd/issues/1591)). The deploy engine
records the DESIRED properties into cdkd state, which is right for almost every
provider — leave the field absent and nothing changes. But a provider that
knowingly drops part of the bag makes the record describe something AWS never
held, and since `readCurrentState` can only return what AWS *does* hold, the
difference becomes permanent phantom drift: reported by every `cdkd drift`, and
"repaired" by `drift --revert` calling `update()` again, which narrows and
re-reports. Returning the bag you actually sent makes the engine record that
instead.

Every `update()` caller honours the field, not only the deploy engine — since
issue [#1644](https://github.com/go-to-k/cdkd/issues/1644), `drift --revert` and
the rollback executor's two revert arms record it as well, so the loop closes on
those commands too. Return the COMPLETE bag you sent regardless of caller; each
one knows how to fold that into the record it maintains.

### Live cases

`EC2Provider.createRoute` is the live case: a CFn-invalid template declaring two
destination keys is REFUSED on the template path, but the refusal downgrades to
a warning on the state-borne paths, where it keeps one key and returns the
others stripped.

`EC2Provider.createSecurityGroupIngress` is the second, and it shows that a
dropped KEY is not the only shape (issue
[#1633](https://github.com/go-to-k/cdkd/issues/1633)). A SUBSTITUTED value does
the same damage: a malformed `IpProtocol` is warn-replaced by the `-1` default
on the state-borne paths, and — separately — an unquoted YAML `IpProtocol: -1`
is a NUMBER that is stringified before it is sent. Both reached AWS as something
other than what the record said, so both had to be reported. When auditing your
own provider, read every arm that can put a value on the wire differing from the
declared one, not only the arms that log.

`DynamoDBGlobalTableProvider` is the third, and it shows both halves of the
question (issue [#1683](https://github.com/go-to-k/cdkd/issues/1683)). Every one
of its ordinary CREATE-path guard downgrades is now answered (the UPDATE-side
capacity residual was closed by issue
[#1738](https://github.com/go-to-k/cdkd/issues/1738)), and they do NOT all answer
the same way — a `BillingMode` warn-and-SUBSTITUTE on the replay-CREATE path records
the substituted mode, the same property's UPDATE-side guard suppresses the flip
and so records the mode it compared against — DROPPING the key instead when the
record declared none, so the key stays absent and every later deploy re-reads
AWS rather than comparing against a snapshot this arm would have frozen in
(issue [#1733](https://github.com/go-to-k/cdkd/issues/1733) is what makes that
re-read happen, and what makes the drop safe rather than a lost flip) — a
`GlobalSecondaryIndexes` warn-and-SKIP on update retains the previous list, and
the same property's replay-CREATE OMIT drops the key outright (issue
[#1724](https://github.com/go-to-k/cdkd/issues/1724)), because there the block
never reached AWS at all. Note the first two answer the SAME property
differently because what reached AWS differs: one created the table on-demand,
the other left a live table's mode untouched. The create-side substitution also
STRIPS the PROVISIONED-only capacity blocks that mode never sent (issue
[#1726](https://github.com/go-to-k/cdkd/issues/1726)) — a substitution that
changes a MODE drops more than the key it rewrote, and the strip set is read off
the provider's own `readCurrentState` gating under the new mode rather than
guessed from key names, which is what keeps the on-demand ceilings (genuinely
sent under that mode) from being swept up with it. Getting the
UPDATE-side split wrong cost two review rounds in opposite directions, so the
per-shape reasoning lives in
[.claude/rules/providers.md](https://github.com/go-to-k/cdkd/blob/main/.claude/rules/providers.md) rather than being
summarized twice. One arm logs no refusal at all: cross-region replication REQUIRES a stream, so the
provider enables `NEW_AND_OLD_IMAGES` on a template that declared no
`StreamSpecification`, on the ORDINARY template path. A provider is therefore
not "done" once every guard reports — the audit question is what it SENDS that
differs from what was declared, not which guards can warn.

**But finding such an arm is not the same as fixing it.** The value that arm
records is a key the template does not have, so the twin rule above binds:
`DiffCalculator` walks the key UNION, so an unchanged template would classify an
UPDATE on the next deploy, `update()` would return no effective bag, and the key
would vanish again. Settle the twin's feasibility BEFORE recording anything. For
this arm (issue [#1723](https://github.com/go-to-k/cdkd/issues/1723)) the twin
is pure and synchronous and does not know the deploy region, so only the
region-independent half (more than one replica, no `MultiRegionConsistency` declared) is recorded, through one
predicate shared by `create()`, `update()` and `canonicalizeDesiredProperties`;
a single replica outside the deploy region still records nothing.

When more than one arm can fire in a single call, COMPOSE them
(`...(effectiveProperties ?? properties)`) rather than assigning — otherwise the
later arm silently erases the earlier one's answer.

### Three conditions for returning it

Three conditions, or this becomes a way to hide losses rather than record them:

- the narrowing is **deliberate** — a value you merely failed to send is a bug,
  and recording it launders the bug. Usually that means an **announced** one (a
  warn arm), and if you are unsure, that is the bar to hold yourself to. The
  exception is a transformation that loses NOTHING and therefore has nothing to
  announce: `IpProtocol: -1` and `'-1'` name the same protocol, so stringifying
  it needs no warning and still belongs here. **Do not read that as "any
  lossless coercion qualifies" — the real bar is "matches what AWS HOLDS"**
  (issue #1643). `-1` works because AWS reports `-1` back. Measured us-east-1
  2026-08-12: a declared `IpProtocol: 6` goes through the identical lossless
  coercion to `'6'`, and AWS stores and reports `tcp` — so recording `'6'` here
  pins a value the readback can never equal. A TYPE coercion cdkd performs is
  knowable at send time; a VALUE mapping the SERVICE performs is not, so that
  class is fixed on the readback side instead (see
  `src/analyzer/drift-protocol-normalize.ts`). Ask what the service will
  REPORT, not just whether your transformation lost information;
- it is what you **sent**, not what AWS computed. AWS-side defaults and computed
  values belong in `observedProperties` (captured by a real read-back); putting
  them here makes the desired baseline drift from the template and silently
  disables the absent-field removal derivation, which reads that side;
- it **replaces** the desired bag wholesale, so it must be complete — not a
  patch. An absent field means "record the desired properties", so the engine
  gates on `??`, and an empty object is a legitimate answer.

### `canonicalizeDesiredProperties`: the diff-side half

**Implement `canonicalizeDesiredProperties` alongside it — whenever what you
report is a NARROWING.** The two are halves of one decision, and the first
without the second is worse than neither. (A warn-and-SKIP is a different shape
and takes the opposite answer — see the section below.) `effectiveProperties` makes state describe what AWS holds; the
template still declares what it always did, so the next diff reads the dropped
keys as a change the user made. For a create-only property that means a
REPLACEMENT, and the engine's replacement create never sets `replayingState` —
so a provider that refuses the shape on the create path turns a previously-green
no-op deploy into a hard failure. Without create-only knowledge it classifies in-place instead and the resource is
delete-and-recreated on *every* deploy.

```typescript
canonicalizeDesiredProperties(
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType === 'AWS::EC2::SecurityGroupIngress') {
    // A no-op `onUnusable`: a diff must not throw, and must not warn either —
    // the provisioning path already announces the identical substitution.
    return narrowIngressIpProtocol(properties, () => {}).narrowed;
  }
  if (resourceType !== 'AWS::EC2::Route') return properties;
  // The SAME helper the provisioning path uses — re-deriving the rule lets
  // state and template narrow to different keys, which is the original bug
  // wearing a new hat.
  const { declared, narrowed } = narrowRouteDestinations(properties);
  return declared.length > 1 ? narrowed : properties;
}
```

It must be pure and synchronous (it runs inside the diff, before any AWS call),
and it must return the input unchanged whenever nothing applies.

Two things that are easy to get wrong and were both caught by review:
**normalize BOTH comparison sides**, not just the desired one — a record written
BEFORE the provider started narrowing still carries every key, so a one-sided
pass flips the same difference to a REMOVAL and breaks exactly the population
the narrowing exists for; and **wire `cdkd diff` too**, since a preview that
narrows differently from the apply forecasts a change the deploy will never
make. `makeCanonicalizePropertiesFn` in
`src/provisioning/canonicalize-properties.ts` is the one builder both commands
use, so they cannot drift.

### A warn-and-skip arm

**A warn-and-SKIP arm needs `effectiveProperties` too — but NOT the
`canonicalizeDesiredProperties` twin** (issue
[#1612](https://github.com/go-to-k/cdkd/issues/1612)). A guard that refuses a
malformed value on the template path and downgrades to warn-and-skip on the
state-borne ones lets the deploy SUCCEED while the call never runs, so the
engine records a desired value AWS never received — the same permanent phantom
drift, reached through a skip instead of a narrowing. `S3BucketProvider` is the
live case: eight of its appliers carry that downgrade, behind two shared guard
helpers.

Read the twin rule above as scoped to a NARROWING, which is a pure function of
the desired bag so both comparison sides can be reduced identically. A skip is
not: what reaches AWS depends on what was already there. Canonicalizing the
desired side would DROP the malformed configuration from it, so a previous side
holding a VALID configuration against a desired side holding a malformed one
derives a REMOVAL — cdkd would DELETE the live lifecycle / replication
configuration the user still wants, over one unusable field. Recording the
retained value has no such arm: the malformed template keeps re-warning until it
is fixed, which is correct.

What to record differs per path, and neither answer generalizes:

- **UPDATE** — retain the PREVIOUS value. The call never ran, so AWS still holds
  the previously-applied configuration. Dropping the key is wrong in the other
  direction: a later template that REMOVES the block would derive no removal and
  the live configuration would survive forever.
- **replay-CREATE** (the reverse-replacement arm) — DROP the key. The resource is
  new and nothing was applied, so there is no previous value to keep. Read that
  as scoped to a SKIP ([#1653](https://github.com/go-to-k/cdkd/issues/1653)): a
  create arm whose replay downgrade is a warn-and-DEFAULT DID apply the block,
  so it records the SUBSTITUTED value instead — dropping there would record that
  the provider sent nothing. Ask whether the call went out, not whether it was a
  create.
- **per-item appliers** (a Put keyed by `Id`) — the skip unit is one
  configuration ITEM, so the effective array substitutes the previous item of the
  same `Id` IN PLACE, or drops it when the skipped item was an ADD. Preserve the
  DESIRED order: the diff compares arrays positionally, so a reordered effective
  array manufactures a fresh phantom drift while removing the one you fixed.

Report the skip EXPLICITLY from the applier — a `Promise<boolean>` "applied"
return, or a list of skipped item indexes — rather than inferring it by wrapping
`onUnusable`. That callback is shared by two guard classes: SKIP-class guards
(`configStringRefusal`, `configBooleanRefusal`, `requireConfigObject`,
`requireConfigArray`) and
warn-and-DEFAULT reads (`readConfigString` with the options bag), where the
applier proceeds WITH a substituted default. A wrapper cannot tell them apart, so
a defaulted-but-APPLIED configuration would be recorded as skipped and the
previous value retained — manufacturing exactly the drift you set out to remove.

### A warn-and-substitute arm

**The warn-and-SUBSTITUTE arm beside it needs the same treatment, and its own
answer** (issue [#1670](https://github.com/go-to-k/cdkd/issues/1670)). Those
warn-and-DEFAULT reads are not the SKIP's sibling only in the negative sense:
the applier proceeds, the deploy succeeds, and AWS ends up holding a value the
record does not describe — the same permanent phantom drift, reached through a
substitution. Record the value SENT, and mind three things the skip path did not
need:

- The item was APPLIED, so its effective entry is what was SENT — kept IN PLACE,
  not dropped and not replaced by the previous item. Because the two arms mean
  opposite things, report them separately: the four `S3BucketProvider` per-`Id`
  appliers return `{ skipped, substituted }` rather than a bare index list.
- Write the substituted value back at the key the TEMPLATE declared — UNLESS the
  readback can only emit one of the accepted spellings, in which case normalize
  the whole block to that one (see the SHAPE section below). The bullet's
  original reason was that a hardcoded branch leaves the malformed value alive at
  the other key and adds a stray one; normalizing wholesale removes the other key
  entirely, so that concern does not apply. The S3 analytics / inventory
  `Destination` was the worked case: accepted flattened AND nested, emitted only
  flattened, so it normalized
  ([#1707](https://github.com/go-to-k/cdkd/issues/1707)). The nested spelling
  is now refused pre-flight as a missing required member
  ([#3602](https://github.com/go-to-k/cdkd/issues/3602)); a spelling the
  nested required-member check refuses is dropped rather than normalized.
- Hand the recorder the value the read RETURNED, not the fallback literal, so
  "recorded" and "sent" cannot drift apart.

Whether such a site ALSO takes the `canonicalizeDesiredProperties` twin is a
genuine per-site question — unlike a skip, a substitution IS a pure function of
the desired value, so the twin rule reaches it. `.claude/rules/providers.md`
carries the three-finding checklist and the worked S3 answer, which is worth
reading as TWO answers rather than one: for the SUBSTITUTED values (#1670) it is
still no twin, because canonicalizing would conceal a malformed value whose
warning is the user's only signal; for the never-emitted KEY and SHAPE folds at
the same sites (#1686 / #1707) it is yes, because those have no fault to conceal
and emit no warning at all. Both live in one
`canonicalizeDesiredProperties` on `S3BucketProvider`, keyed off the DECLARED
shape so the substitution stays visible.
The one licensed exception is a SINGLE call site of KNOWN class
([#1653](https://github.com/go-to-k/cdkd/issues/1653)): where you wrap one
`readConfigString` you wrote yourself, you already know it is a
warn-and-DEFAULT, and what you record is the default that WAS APPLIED rather
than a retained previous value. Compose `replayWarn`'s own `onUnusable` instead
of replacing it, and only when that callback exists — otherwise a template-path
create silently gains a downgrade it never had — and say in-code that the
exception is deliberate, or the next reviewer reads it as the violation.

### Validate the previous value, and check who reads the record next

Two more rules the #1653 / #1654 reviews added:

- **Validate the PREVIOUS value before retaining it.** An absent-vs-present test
  is not enough — `previousProperties` is a cdkd STATE record, so on a replay it
  can hold `null` / `''` / a bare string just as the desired side can, and
  copying that in re-creates the drift from the other direction. Run the SAME
  predicate the desired side runs (`configStringRefusal`, not a hand-written
  `typeof` twin), DROP the key when both sides are unusable, and COPY the
  retained value rather than aliasing the previous bag — the rollback executor
  spreads your answer shallowly.
- **Dropping a key can MOVE a hazard rather than remove it.** An absent key is
  not malformed, so the next reader's guard does not fire and its default
  applies silently. `AWS::Lambda::Url` is the live case
  ([#1654](https://github.com/go-to-k/cdkd/issues/1654)): `update()` drops an
  unvouchable `AuthType`, and the reverse-replacement `create()` then defaults
  to `'NONE'` — a PUBLIC function URL, unannounced. The fix is not to stop
  dropping but to make the READING path announce the defaulted absence on a
  replay. Audit who reads the record next.

### A key the readback never emits

**A KEY the readback never emits is the same defect reached through the SHAPE**
(issue [#1686](https://github.com/go-to-k/cdkd/issues/1686)), and it NARROWS the
"write it back at the key the TEMPLATE declared" bullet above. That bullet is
right when both accepted spellings can come back from AWS. When they cannot —
your provider tolerates an SDK spelling on the desired side but your
`readCurrentState` reverse-mapper emits only the CFn one — writing back at the
declared key preserves a key the comparator can never match, and the record
drifts forever with no warning anywhere, because nothing was lost and nothing
was substituted. Record the spelling the READBACK produces and REMOVE the other:
the S3 inventory applier accepts `ScheduleFrequency` and the SDK
`Schedule: { Frequency }` while `inventorySdkToCfn` emits only the former, so it
records the CFn key and drops `Schedule`. Three things generalize: key the
normalization off the DECLARED shape rather than off a refusal (the main
population carries no malformed value at all); REMOVE the key instead of setting
it `undefined` (`JSON.stringify` drops an `undefined` member but a cloned state
record keeps it, so key-set walks disagree); and prefer normalizing over
retracting the tolerance. Audit the whole type when you fix one — diff the
type's live registry-schema property names against every key the provider reads
 off a desired-side bag. Match the `(a['X'] ?? a['Y'])` alias
form explicitly — a plain bracket-read regex misses most of the class.

Recording the folded spelling **needs its `canonicalizeDesiredProperties`
twin**, and re-asking that question per site matters: the #1670 "no twin"
answer rests on canonicalizing CONCEALING a malformed value whose warning tells
the user what to fix, and a never-emitted spelling has no fault to fix and emits
no warning. Without the twin the template keeps declaring the SDK spelling while
state holds the CFn one, so `cdkd diff` reports the property forever and every
deploy re-issues the Put (measured). cdkd's S3 fold shipped WITHOUT the twin at
first — deliberately, because the alternative is worse in the direction that
MUTATES — and the twin landed in issue
[#1717](https://github.com/go-to-k/cdkd/issues/1717):
`S3BucketProvider.canonicalizeDesiredProperties` folds the inventory schedule
key, the analytics / inventory destination shape, and the defaulted-but-SENT
members, sharing ONE per-item helper with the appliers so state and template can
never be folded to different keys. It has since grown two WHOLE-BLOCK folds on
the same rule — `effectiveNotificationConfiguration` and
`effectiveLifecycleConfiguration` (issues #1748 / #1754 / #1755 / #1759) — which
add three things worth knowing when you write the next one: the fold's unit can
be the BLOCK rather than an item; a decision made across a whole LIST (S3
chooses the V1 vs V2 lifecycle form once per configuration) has to be shared
with the applier as a function, not re-derived; and an arm the wire WARNS about
(a legacy singular transition colliding with its plural) must be left unfolded,
or the comparison goes equal and the warning stops after one deploy.

### A member that is always sent and always read back

**A member that is always SENT and always READ BACK must be recorded even when
the template omits it** (issue
[#1718](https://github.com/go-to-k/cdkd/issues/1718)) — the defaulted-but-SENT
arm of the same class, with no substitution and no warning anywhere. The S3
inventory `Enabled` / `IncludedObjectVersions`, the analytics
`OutputSchemaVersion`, the destination `Format` and the intelligent-tiering
`Status` are all defaulted on the wire and all emitted by the reverse mapper, so
an item omitting one recorded fewer keys than the readback produces. That is
invisible for a TOP-LEVEL key (the drift comparator only descends into keys state
carries) and fatal inside an ARRAY, which is compared WHOLESALE. Record the
default and add it to the twin so both diff sides agree. Audit the sibling
appliers when you fix one, and expect the answer to differ: S3 `metrics`
defaults no scalar member and correctly needs no fold.

### An empty collection is not a removal intent

**An EMPTY COLLECTION is not a removal intent** (issue
[#1671](https://github.com/go-to-k/cdkd/issues/1671)). An applier that skips its
Put for an empty rules array is the skip class reached from an ORDINARY template
rather than a state replay, since a condition-pruned or intrinsic-collapsed
template synthesizes one. Do not "fix" it by turning the skip into a Delete:
measured against live CloudFormation (us-east-1, 2026-08-12), an update to
`LifecycleConfiguration: { Rules: [] }` / `CorsConfiguration: { CorsRules: [] }`
drives the stack to `UPDATE_ROLLBACK_COMPLETE` and BOTH live configurations
survive unchanged — so it is an invalid template, and deleting would diverge
from CFn while destroying a configuration the user still wants. The registry
schema only says the shape is legal (the collection is required with no
`minItems`), which is why this had to be measured rather than read. Keep the
skip, record the PREVIOUS value per the UPDATE rule above, and ANNOUNCE it —
CFn's own answer is a loud failure, so a silent skip leaves the user to discover
it by diffing state. Keep it a warning rather than a throw, or the
`readCurrentState` round-trip the arm exists to absorb (`drift --revert` feeds
an always-emitted empty-rules block back through `update()`) stops working.

### The create path's guard

**The CREATE path usually carries the same guard, and what it RECORDS is a
separate question** (issue [#1718](https://github.com/go-to-k/cdkd/issues/1718)).
cdkd's create-side S3 arm skipped in SILENCE for the same collapsed array, so a
fresh bucket came up without a declared configuration and nothing said so; it
now announces the skip too. Neither recording answer transfers: the update arm
retains the PREVIOUS value and a create has none, while the replay-CREATE rule's
"DROP the key" is also wrong here, because `readCurrentState` ALWAYS emits the
empty placeholder for an unconfigured resource — so the declared empty
collection already equals what the readback returns and the right answer is to
override NOTHING. Dropping it would leave the template declaring a key the
record does not and churn a no-op UPDATE on every deploy. Before importing the
drop answer, ask what your readback emits for the UNCONFIGURED resource.

## `isSameResource` and `resourceIdentity`

Both are optional members of `ResourceProvider` (`src/types/resource.ts`). They
let a successful deploy delete a resource that an earlier failed create left
behind under the same logical id.

```typescript
  /**
   * Whether a resource a failed CREATE proved it made (its journaled id) is
   * the same live resource as the one the state record under the same
   * logical id holds (issue #4606: the fix-forward).
   *
   * Optional. A successful deploy deletes the journaled resource only on
   * `'different'`, and so do `cdkd rollback` and `cdkd destroy` replaying
   * an entry that deploy kept (issue #4754); absent, `'unknown'` or a throw
   * keeps today's warning.
   * A `'different'` must rest on AWS evidence, not on two id strings
   * differing: at the least a live read confirming the record's resource
   * exists, in an id namespace where two distinct ids cannot name one
   * resource (a unique, non-renamable name per account and region). Answer
   * `'unknown'` for an id form you do not
   * recognise, a client region other than `context.expectedRegion`, or a
   * record whose resource is not found.
   */
  isSameResource?(
    journaledPhysicalId: string,
    record: { physicalId: string; provisionedBy?: 'sdk' | 'cc-api' },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<'same' | 'different' | 'unknown'>;

  /**
   * A token naming THIS live resource and no later one created under the
   * same physical id (issue #4655). A failed CREATE journals it beside a
   * proven orphan, and a successful deploy deletes the orphan only when the
   * live token is equal (one reported gone is dropped without a delete).
   *
   * Optional, but without it a successful deploy never deletes a proven
   * orphan of a name-keyed type: it warns and exits 2. Not needed for a type
   * listed in `UNIQUE_PHYSICAL_ID_TYPES`
   * (src/deployment/rollback-executor/orphan-identity.ts), whose marked id
   * AWS generates and never reuses; add a type there only after checking its
   * `markCreatedBeforeFailure` site. Build the token from an immutable AWS id
   * where one exists, else the ARN plus the creation time. Return
   * `RESOURCE_NOT_FOUND` only on AWS's not-found answer, and `undefined` for
   * an id form you do not recognise, a client region other than
   * `context.expectedRegion`, or a response without the fields.
   */
  resourceIdentity?(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | typeof RESOURCE_NOT_FOUND | undefined>;
```

## What `import` returns

> [!IMPORTANT]
> **If any intrinsic resolves from a recorded ATTRIBUTE, `import` must record
> it too** ([#1728](https://github.com/go-to-k/cdkd/issues/1728)). Returning
> `attributes: {}` is only correct when the physical id alone answers every
> `Ref` / `Fn::GetAtt` for the type. Where it does not — the three
> `AWS::AppSync::*` children, whose `Ref` is an ARN the resolver recovers from
> the attribute `create()` records — an adopted resource is silently stuck on
> the degraded path until its next UPDATE happens to heal the record. Reuse the
> SAME mapping `create()` / `update()` use rather than writing a third spelling,
> and return the COMPLETE set: the import writes the record's attribute map
> outright, so a partial answer drops the rest. Reconstructing from the supplied
> physical id is preferred over a readback when every segment is already in the
> id (it costs no per-resource API call), and the build must never fail the
> import — warn and degrade to `{}`, which is exactly the pre-fix behavior.
>
> Two things about reconstructing, both found by review rather than by tests:
> derive the region from `ResourceImportInput.region` (what `import` keyed the
> STATE RECORD by), not from the provider client's own config, or the ARN can
> name a different region than the record holding it. And **the credentials
> failure throws from the ARN BUILDER** — `getAccountInfo` rejects with
> `AccountIdUnavailableError` when STS cannot name the account
> ([#1730](https://github.com/go-to-k/cdkd/issues/1730)). Do not swallow it
> INSIDE the builder: the UPDATE path rebuilds the same ARN on every in-place
> update and its attribute map replaces the record's wholesale, so a builder
> that answered something anyway would overwrite a correct recorded ARN. Let it
> reach each caller, and let each caller pick its own degradation: create omits, update reports NO
> attributes (so the engine carries the existing ones forward), and import keeps
> the account-independent keys while dropping only the ARN.

### A list walk that matches a template-supplied name

A `List*` walk is still correct when it matches on a **name** the template
supplies (rather than on a tag) and the service has no direct
`Get<Name>` lookup — see `s3-tables-provider.ts`'s `TableBucketName` walk
and `servicediscovery-provider.ts`'s namespace `Name` walk. Guard it with an
early `return null` when the template carries no name, so the walk never
pages an account's entire inventory just to fail.

### Reference implementations

| Shape | When | Copy from |
| --- | --- | --- |
| Name-matched list walk | The service has no direct lookup by the template-supplied name | `s3-tables-provider.ts` (`TableBucketName`), `servicediscovery-provider.ts` (namespace `Name`) |
| Explicit override only | Auto lookup is impractical, or the resource is a sub-resource or an attachment | The providers listed below |
| Singleton live lookup | The type represents an AWS-managed default | `agentcore-browser-provider.ts`, `agentcore-code-interpreter-provider.ts` |

An explicit-override-only `import` has this body, with a doc comment naming the
reason (no tag API, sub-resource scoping, attachment, identity carried by a
handler-returned `PhysicalResourceId`):

```typescript
if (input.knownPhysicalId) return { physicalId: input.knownPhysicalId, attributes: {} };
return null;
```

The providers that take this shape:

- Sub-resources scoped under a parent RestApi / HttpApi / GraphqlApi:
  `apigateway-provider.ts`, `apigatewayv2-provider.ts`, `appsync-provider.ts`.
- Not taggable: `route53-provider.ts` (RecordSets), `efs-provider.ts`
  (MountTargets).
- No taggable identity tying it to a CDK construct: `elbv2-provider.ts`
  (Listeners).
- Attachments, or identity returned by a handler: `sns-subscription-provider.ts`,
  `sns-topic-policy-provider.ts`, `sqs-queue-policy-provider.ts`,
  `s3-bucket-policy-provider.ts`, `lambda-permission-provider.ts`,
  `lambda-eventsource-provider.ts`, `lambda-url-provider.ts`,
  `custom-resource-provider.ts`, `cloudfront-oai-provider.ts`,
  `agentcore-runtime-provider.ts`.
- `agentcore-evaluator-provider.ts` accepts the ARN verbatim or resolves a bare
  evaluator id to the canonical ARN via `GetEvaluator`.

The two singleton providers are adopt-only representations of the AWS-managed
defaults (`aws.browser.v1` / `aws.codeinterpreter.v1`), so `import` resolves
them live via `GetBrowser` / `GetCodeInterpreter` and ignores overrides.

### Attribute map rules

- **Return `null`, don't throw**, when nothing matches. `cdkd import` treats
  `null` as "not deployed yet", not as a failure.
- `attributes: {}` is fine for most types — the deploy-time `Fn::GetAtt`
  resolver reconstructs missing attributes via `constructAttribute`
  (dispatched from `src/deployment/intrinsic-resolver/getatt.ts`; the per-type handlers live in `getatt-construct-*.ts`). `cdkd import`
  persists whatever map you return, but an empty map is treated as "no
  attributes" and falls back to the same-physical-id map already in state,
  so returning `{}` never clobbers a good snapshot from a prior deploy.

### Never store an empty-string placeholder for an attribute you could not read back

Omit the key instead. Build the map with `definedAttributes`
from `src/provisioning/attribute-map.ts`, which drops every `undefined` /
`null` value (an empty string AWS itself reported is a known value and is
kept — a provider that knows a `''` means "not yet" maps it to `undefined`
first, as the EC2 Instance provider does while an instance is `pending`):
write
`attributes: definedAttributes({ Arn: response.Arn })`, not
`attributes: { Arn: response.Arn ?? '' }`, and stringify a numeric field
through its `stringifyIfAssigned` sibling so `Endpoint.Port` never becomes
the literal `'undefined'`. The resolver treats any non-`undefined` stored
attribute as a hit, so a persisted `''` shadows `constructAttribute`'s
fallback — the live `DescribeInstances` re-read for an EC2 instance's
addresses, the rebuilt ARN for the RDS family — and makes `Fn::GetAtt`
resolve to the empty string, which the Outputs pass then exports. This
applies to `create()` / `update()` / `import()` alike — keep the three
consistent within a provider. `tests/unit/provisioning/attribute-map.test.ts`
fails the build on any `?? ''` / `|| ''`, or a bare `''` where a value is
built (a property value, an initializer, an `=` right-hand side, a `?:`
branch), reachable from a provider's `attributes` value — the literal, a
hoisted `const` / `let` and its reassignments, a builder's element writes, a
same-file helper's return, a call's arguments and receiver, or a spread.
It carries no allow-list: the last two exempt sites (the security group's
`VpcId`, once copied from the template) were retired by reading the value
back from `DescribeSecurityGroups` (issue #3097) — when a provider has no
read-back for an attribute, add one rather than an exemption.

## Related

- [Provider Development](provider-development.md)
- [Provider implementation rules](provider-rules.md)
- [State Store](state-management.md)
