---
description: Provider diff-side and record-side folds, empty collections, UpdateContext, and retiring what a failing create materialized
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - diff/record folds, empty collections, `UpdateContext`

Preceded by [provider-property-fidelity.md](provider-property-fidelity.md).

Provider interface, registry, Custom Resources, and "Adding a New SDK Provider": [providers.md](providers.md).

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
none of the 77 providers implementing `update()` changed. Its own field,
`desiredFromAwsReadback`, is named for what it asserts rather than for
"state-borne", and that distinction is load-bearing: the rollback executor's
revert arms ARE state-borne, but their desired bag is
`previousState.properties` — a TEMPLATE recorded earlier — so `{Rules: []}`
there means what the template meant and the template answer (SKIP) is correct.
Those arms deliberately never set that FLAG (they do pass a context, carrying
only the `maskSecrets` capability below), and widening the flag to `stateBorne`
would sweep them in and delete a live configuration during a rollback. Only
`src/cli/commands/drift.ts`'s revert call sets it. When adding a field here,
ask what the flag lets a provider CONCLUDE, not merely where the call came
from.

**The other field is inherited, not its own** — `UpdateContext` and
`CreateContext` both extend `SecretMaskingContext`, which supplies
`maskSecrets?: (text: string) => string` (issue #1932). See the section below;
the reason it lives on a shared base rather than being declared twice is that a
masker present on one path and absent on the other is not a partial fix, it is
a fix with a hole in the shape of whichever path a given deploy takes.

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
`CreateContext` — `update()`'s own context is an `UpdateContext`, which
carries no `replayingState` — and the `properties` they
forward ARE a state record during a rollback replay (`rollback-executor.ts`'s
`revert` arm calls `provider.update(..., previousState.properties, ...)`, as
does `drift --revert`). So a provider that both refuses on create AND
re-creates inside `update()` would fire that refusal on a replay with no way
to detect it. None of the five does today (required-field validation only,
which correctly stays a hard error).

### Retiring what a FAILING create already materialized

Issue #2169. For a create shaped `<one API call that materializes the
resource>` then `<a wait for it to become usable>`, the wait can fail with the
resource alive in AWS. Nothing recorded it, because the create never returned —
so it was invisible to `cdkd state show`, unreachable by `cdkd destroy`, and
re-created by the next deploy, one orphan per attempt. The reported case is
`AWS::CertificateManager::Certificate`: `RequestCertificate` returns an ARN
immediately, and the `ISSUED` wait times out by construction while the DNS
validation records are not live.

The fix is to delete it in the provider's own `catch` and re-throw the ORIGINAL
error (`ACMCertificateProvider.cleanupRequestedCertificate`).

Rules:

- **Track the id from the AWS response**, not from a name computed before the
  call, so a failure BEFORE the request deletes nothing.
  `ProvisioningError.physicalId` is NOT that signal: 462 call sites across 75
  provider files pass one and it is usually the INTENDED name
  (`IAMRoleProvider.create` hands its catch the `roleName` it derived
  regardless of whether `CreateRole` ran). Its only consumer is
  `cleanupFailedCreateRemnant` in `cloud-control-provider.ts`, Cloud-Control
  only.
- **The cleanup degrades the message, never replaces it.** A cleanup that could
  not delete appends a line naming the survivor plus the manual retire command.
- **Do NOT record the remnant in state instead.** This was tried first and it
  is a trap: the recorded properties ARE the template's, so the next deploy
  diffs `NO_CHANGE` and never touches the resource again — `cdkd deploy` prints
  "No changes detected" and exits 0 over something still unusable, and the
  consumer fails with no explanation. A loud failure turned silent is worse
  than the orphan. Making the diff re-provision it needs a marker on the state
  record, i.e. a schema bump, to buy what deleting gives for free.
- **Prove the delete is SAFE for that service rather than assuming it.** For
  ACM it is, from AWS's own docs: the validation CNAME is derived from the
  domain and the account, not the certificate, and you can "replace a deleted
  certificate" without repeating validation.
- **Release the idempotency token when the cleanup succeeded.** ACM answers a
  repeat of the same token within an hour with the SAME certificate — which no
  longer exists. Keep it when the cleanup FAILED: there the survivor is exactly
  what a retry should be handed.

This also covers the replacement path for free: `update()` re-creates via the
same `create()`, so a replacement whose wait fails aborts with the OLD resource
still live and still in state, and nothing orphaned.
