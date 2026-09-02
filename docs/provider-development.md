# cdkd Provider Development Guide

## Overview

In cdkd, AWS resource provisioning is implemented through an abstraction layer called **Provider**. SDK Providers are preferred for performance — they make direct synchronous API calls with no polling overhead. Cloud Control API serves as a fallback for resource types without an SDK Provider (requires async polling).

Adding SDK Providers for frequently used resource types is one of the most impactful performance improvements. This guide explains how to add new providers.

## Provider Interface

All providers implement the `ResourceProvider` interface.

### Definition (`src/types/resource.ts`)

```typescript
export interface ResourceProvider {
  /**
   * Create a new resource
   *
   * @param logicalId CloudFormation logical ID
   * @param resourceType CloudFormation resource type (e.g., "AWS::S3::Bucket")
   * @param properties Resource properties from template
   * @returns Physical ID and attributes
   */
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult>;

  /**
   * Update an existing resource
   *
   * @param logicalId CloudFormation logical ID
   * @param physicalId AWS physical ID (from state)
   * @param resourceType CloudFormation resource type
   * @param properties New properties
   * @param previousProperties Old properties
   * @param context Optional update context — `desiredFromAwsReadback`,
   *   `maskSecrets`, and `expectedRegion` (the region the state record being
   *   updated belongs to, issue #2301). Optional in every sense: a provider
   *   that needs none of them may declare five parameters, as the examples
   *   further down this page do.
   * @returns Physical ID (may change if replaced) and attributes
   */
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult>;

  /**
   * Delete a resource
   *
   * @param logicalId CloudFormation logical ID
   * @param physicalId AWS physical ID
   * @param resourceType CloudFormation resource type
   * @param properties Resource properties (optional, for cleanup logic)
   * @param context Delete-time context (optional). `context.expectedRegion`
   *   is the region recorded in the stack state when the resource was
   *   created. Providers MUST verify the AWS client's region against
   *   `context.expectedRegion` before treating a `*NotFound` error as
   *   idempotent delete success — see the "DELETE idempotency" section
   *   below.
   * @returns Nothing (means "deleted"), or `{ outcome: 'skipped', reason }`
   *   when the provider issued NO AWS call and the resource may still be
   *   alive — see "2b. Reporting a SKIPPED delete" below.
   */
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult>;

  /**
   * Adopt an existing AWS resource into cdkd state.
   *
   * Optional. Providers without an `import` implementation are reported
   * by `cdkd import` as `unsupported` and skipped (Cloud Control API
   * fallback handles them via `--resource <id>=<physicalId>` overrides).
   *
   * @param input Logical ID, resource type, CDK path, stack name, region,
   *   template properties, and (optionally) the user-supplied
   *   `knownPhysicalId` from `--resource` / `--resource-mapping`.
   * @returns Physical ID + attributes (same shape as `create` returns),
   *   or `null` when no matching AWS resource was found (caller treats
   *   `null` as "skipped — not deployed yet", not as a failure).
   */
  import?(input: ResourceImportInput): Promise<ResourceImportResult | null>;
}
```

### Return Types

```typescript
export interface ResourceCreateResult {
  physicalId: string                     // AWS physical ID
  attributes?: Record<string, unknown>   // Attributes for Fn::GetAtt
  effectiveProperties?: Record<string, unknown>  // See below — rarely needed
}

export interface ResourceUpdateResult {
  physicalId: string                     // Physical ID after update
  wasReplaced: boolean                   // Whether resource was replaced
  attributes?: Record<string, unknown>   // Attributes after update
  effectiveProperties?: Record<string, unknown>  // See below — rarely needed
}
```

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
[.claude/rules/providers.md](../.claude/rules/providers.md) rather than being
summarized twice. One arm logs no refusal at all: cross-region replication REQUIRES a stream, so the
provider enables `NEW_AND_OLD_IMAGES` on a template that declared no
`StreamSpecification`, on the ORDINARY template path. A provider is therefore
not "done" once every guard reports — the audit question is what it SENDS that
differs from what was declared, not which guards can warn.

**But finding such an arm is not the same as fixing it.** That auto-enable arm is
deliberately left unanswered (tracked as issue
[#1723](https://github.com/go-to-k/cdkd/issues/1723)) because the value it would
record is a key the template does not have, and the twin rule above then binds:
`DiffCalculator` walks the key UNION, so an unchanged template would classify an
UPDATE on the next deploy, `update()` would return no effective bag, and the key
would vanish again — a spurious no-op UPDATE buying no durable record. The twin
that would fix it cannot be written here either: it is pure and synchronous and
does not know the deploy region, while the auto-enable condition does. Settle
the twin's feasibility BEFORE recording anything.

When more than one arm can fire in a single call, COMPOSE them
(`...(effectiveProperties ?? properties)`) rather than assigning — otherwise the
later arm silently erases the earlier one's answer.

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

**Implement `canonicalizeDesiredProperties` alongside it — whenever what you
report is a NARROWING.** The two are halves of one decision, and the first
without the second is worse than neither. (A warn-and-SKIP is a different shape
and takes the opposite answer — see the section below.) `effectiveProperties` makes state describe what AWS holds; the
template still declares what it always did, so the next diff reads the dropped
keys as a change the user made. For a create-only property that means a
REPLACEMENT, and the engine's replacement create passes no context — so a
provider that refuses the shape on the create path turns a previously-green
no-op deploy into a hard failure. Without create-only knowledge (no
`DescribeType`) it classifies in-place instead and the resource is
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
**normalize BOTH comparison sides**, not just the desired one — a record written BEFORE the provider started narrowing still carries every key, so a one-sided pass flips the same difference to a REMOVAL and breaks exactly the population the narrowing exists for; and **wire `cdkd diff` too**, since a preview that narrows differently from the apply forecasts a change the deploy will never make. `makeCanonicalizePropertiesFn` in `src/provisioning/canonicalize-properties.ts` is the one builder both commands use, so they cannot drift.

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
  `Destination` is the worked case: accepted flattened AND nested, emitted only
  flattened, so it normalizes
  ([#1707](https://github.com/go-to-k/cdkd/issues/1707)).
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

## Provider Implementation Examples

### 1. Simple Example: S3 Bucket Policy Provider

S3 bucket policies benefit from an SDK Provider for fast, synchronous operations without CC API polling overhead.

#### File: `src/provisioning/providers/s3-bucket-policy-provider.ts`

```typescript
import {
  S3Client,
  PutBucketPolicyCommand,
  GetBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  NoSuchBucketPolicy,
} from '@aws-sdk/client-s3';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

export class S3BucketPolicyProvider implements ResourceProvider {
  private s3Client: S3Client;
  private logger = getLogger().child('S3BucketPolicyProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.info(`Creating S3 bucket policy ${logicalId}`);

    const bucket = properties['Bucket'] as string;
    const policyDocument = properties['PolicyDocument'];

    if (!bucket || !policyDocument) {
      throw new ProvisioningError(
        `Bucket and PolicyDocument are required for ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const policy =
        typeof policyDocument === 'string'
          ? policyDocument
          : JSON.stringify(policyDocument);

      await this.s3Client.send(
        new PutBucketPolicyCommand({
          Bucket: bucket,
          Policy: policy,
        })
      );

      this.logger.info(`Successfully created S3 bucket policy ${logicalId}`);

      // Physical ID is bucket name
      return {
        physicalId: bucket,
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to create S3 bucket policy ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        bucket,
        error instanceof Error ? error : undefined
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.info(`Updating S3 bucket policy ${logicalId}`);

    const newBucket = properties['Bucket'] as string;
    const oldBucket = previousProperties['Bucket'] as string;

    // Replace if bucket name changed
    if (newBucket !== oldBucket) {
      this.logger.info(`Bucket changed, replacing policy: ${oldBucket} -> ${newBucket}`);

      // Create new policy
      const createResult = await this.create(logicalId, resourceType, properties);

      // Delete old policy
      try {
        await this.delete(logicalId, physicalId, resourceType, previousProperties);
      } catch (error) {
        this.logger.warn(`Failed to delete old policy: ${String(error)}`);
      }

      return {
        physicalId: createResult.physicalId,
        wasReplaced: true,
      };
    }

    // Update only policy document
    try {
      const policyDocument = properties['PolicyDocument'];
      const policy =
        typeof policyDocument === 'string'
          ? policyDocument
          : JSON.stringify(policyDocument);

      await this.s3Client.send(
        new PutBucketPolicyCommand({
          Bucket: newBucket,
          Policy: policy,
        })
      );

      this.logger.info(`Successfully updated S3 bucket policy ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to update S3 bucket policy ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.info(`Deleting S3 bucket policy ${logicalId}`);

    try {
      // Check if policy exists
      try {
        await this.s3Client.send(
          new GetBucketPolicyCommand({
            Bucket: physicalId,
          })
        );
      } catch (error) {
        if (error instanceof NoSuchBucketPolicy) {
          this.logger.info(`Policy does not exist for bucket ${physicalId}, skipping`);
          return;
        }
        throw error;
      }

      // Delete policy
      await this.s3Client.send(
        new DeleteBucketPolicyCommand({
          Bucket: physicalId,
        })
      );

      this.logger.info(`Successfully deleted S3 bucket policy ${logicalId}`);
    } catch (error) {
      throw new ProvisioningError(
        `Failed to delete S3 bucket policy ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }
}
```

### 2. Complex Example: IAM Role Provider

IAM Role requires the following features:

- Inline policies (`Policies`)
- Managed policy attachment (`ManagedPolicyArns`)
- Role name length limit (64 characters)

See `src/provisioning/providers/iam-role-provider.ts` for details.

**Key Points**:

1. **Create** sets inline policies and managed policies
2. **Update** calculates diff and adds/removes/updates
3. **Delete** deletes dependent resources (policies) first

```typescript
async update(...): Promise<ResourceUpdateResult> {
  // Replace if role name changed
  if (newRoleName !== physicalId) {
    const createResult = await this.create(logicalId, resourceType, properties);

    try {
      await this.delete(logicalId, physicalId, resourceType);
    } catch (error) {
      this.logger.warn(`Failed to delete old role: ${String(error)}`);
    }

    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      attributes: createResult.attributes,
    };
  }

  // Update properties only
  await this.iamClient.send(new UpdateRoleCommand({ ... }));

  // Apply managed policies diff
  await this.updateManagedPolicies(physicalId, newPolicies, oldPolicies);

  // Apply inline policies diff
  await this.updateInlinePolicies(physicalId, newPolicies, oldPolicies);

  return {
    physicalId,
    wasReplaced: false,
    attributes: { ... },
  };
}
```

## Provider Registration

### Provider Registry (`src/provisioning/provider-registry.ts`)

```typescript
export class ProviderRegistry {
  private providers = new Map<string, ResourceProvider>();

  // Singleton instance
  private static instance: ProviderRegistry;

  static getInstance(): ProviderRegistry {
    if (!this.instance) {
      this.instance = new ProviderRegistry();
    }
    return this.instance;
  }

  /**
   * Register a provider
   */
  register(resourceType: string, provider: ResourceProvider): void {
    this.providers.set(resourceType, provider);
    this.logger.debug(`Registered provider for ${resourceType}`);
  }

  /**
   * Get a provider
   *
   * Returns registered SDK Provider if available (preferred for performance),
   * falls back to Cloud Control Provider for unregistered types
   */
  getProvider(resourceType: string): ResourceProvider {
    const provider = this.providers.get(resourceType);

    if (provider) {
      return provider;  // SDK Provider (fast, synchronous)
    }

    // Fallback to Cloud Control API (async polling)
    return this.cloudControlProvider;
  }
}
```

### Registration Location

Register in `src/provisioning/register-providers.ts`:

```typescript
import { ProviderRegistry } from './provider-registry.js';
import { IAMRoleProvider } from './providers/iam-role-provider.js';
// ... (see register-providers.ts for full list of provider imports)

export function registerAllProviders(): void {
  const registry = ProviderRegistry.getInstance();
  registry.register('AWS::IAM::Role', new IAMRoleProvider());
  registry.register('AWS::IAM::Policy', new IAMPolicyProvider());
  registry.register('AWS::S3::Bucket', new S3BucketProvider());
  // ... see register-providers.ts for all registrations

  // Multi-type providers share a single instance:
  const ec2Provider = new EC2Provider();
  registry.register('AWS::EC2::VPC', ec2Provider);
  registry.register('AWS::EC2::Subnet', ec2Provider);
  // ... (9 EC2 types total)

  // Wildcard matching for Custom::*
  // handled by ProviderRegistry.getProvider()
}
```

## Steps to Add a New Provider

### Step 1: Research Resource Type

Check if an SDK Provider already exists for the target resource type, and whether it would benefit from a dedicated provider:

- **Performance**: SDK Providers make direct synchronous API calls (no polling), significantly faster than CC API
- **CC API limitations**: Some resources are not supported or have bugs in Cloud Control API
- **Fine-grained control**: Some resources need special handling (e.g., IAM propagation retries, inline policies)

```bash
# Check if CC API supports the resource (for reference)
# https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html
```

Adding an SDK Provider is recommended for **any frequently used resource type** to improve deployment speed.

### Step 2: Check AWS SDK Client

Identify the required AWS SDK v3 client:

| Resource Type | AWS SDK Client |
|---------------|----------------|
| `AWS::IAM::Role` | `IAMClient` from `@aws-sdk/client-iam` |
| `AWS::S3::BucketPolicy` | `S3Client` from `@aws-sdk/client-s3` |
| `AWS::Lambda::Function` | `LambdaClient` from `@aws-sdk/client-lambda` |
| `AWS::DynamoDB::Table` | `DynamoDBClient` from `@aws-sdk/client-dynamodb` |

### Step 3: Create Provider Class

#### File Naming Convention

`src/provisioning/providers/{service}-{resource}-provider.ts`

Examples:

- `iam-role-provider.ts`
- `s3-bucket-policy-provider.ts`
- `lambda-function-provider.ts`

#### Template

```typescript
import { /* AWS SDK imports */ } from '@aws-sdk/client-xxx';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

export class XxxResourceProvider implements ResourceProvider {
  private client: XxxClient;
  private logger = getLogger().child('XxxResourceProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.client = awsClients.xxx;  // Use shared client instance
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.info(`Creating ${resourceType} ${logicalId}`);

    try {
      // 1. Validate properties
      const requiredProp = properties['RequiredProp'] as string;
      if (!requiredProp) {
        throw new ProvisioningError(
          `RequiredProp is required for ${logicalId}`,
          resourceType,
          logicalId
        );
      }

      // 2. Create with AWS SDK
      const response = await this.client.send(
        new CreateXxxCommand({
          /* ... */
        })
      );

      // 3. Return physical ID and attributes
      const physicalId = response.XxxId || response.XxxArn;
      const attributes = {
        Arn: response.XxxArn,
        Id: response.XxxId,
        // Attributes accessible via Fn::GetAtt
      };

      this.logger.info(`Successfully created ${resourceType} ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes,
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to create ${resourceType} ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.info(`Updating ${resourceType} ${logicalId}: ${physicalId}`);

    try {
      // Check if replacement required due to property changes
      const requiresReplacement = this.checkReplacementRequired(
        properties,
        previousProperties
      );

      if (requiresReplacement) {
        this.logger.info(`Replacement required for ${logicalId}, recreating`);

        const createResult = await this.create(logicalId, resourceType, properties);

        // Delete old resource (best effort)
        try {
          await this.delete(logicalId, physicalId, resourceType, previousProperties);
        } catch (error) {
          this.logger.warn(`Failed to delete old resource: ${String(error)}`);
        }

        return {
          physicalId: createResult.physicalId,
          wasReplaced: true,
          attributes: createResult.attributes,
        };
      }

      // Update if possible
      await this.client.send(
        new UpdateXxxCommand({
          /* ... */
        })
      );

      // Get attributes after update
      const updatedResource = await this.client.send(
        new GetXxxCommand({ /* ... */ })
      );

      const attributes = {
        Arn: updatedResource.XxxArn,
        // ...
      };

      this.logger.info(`Successfully updated ${resourceType} ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes,
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to update ${resourceType} ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.info(`Deleting ${resourceType} ${logicalId}: ${physicalId}`);

    try {
      // Check if resource exists
      try {
        await this.client.send(new GetXxxCommand({ /* ... */ }));
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          this.logger.info(`Resource ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Delete
      await this.client.send(
        new DeleteXxxCommand({
          /* ... */
        })
      );

      this.logger.info(`Successfully deleted ${resourceType} ${logicalId}`);
    } catch (error) {
      throw new ProvisioningError(
        `Failed to delete ${resourceType} ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if replacement is required
   */
  private checkReplacementRequired(
    newProps: Record<string, unknown>,
    oldProps: Record<string, unknown>
  ): boolean {
    // Properties marked "Update requires: Replacement" in CloudFormation docs
    const replacementProperties = ['XxxName', 'XxxId'];

    for (const prop of replacementProperties) {
      if (newProps[prop] !== oldProps[prop]) {
        return true;
      }
    }

    return false;
  }
}
```

### Step 3.5: Implement `import` (Optional but Recommended)

The `import` method lets `cdkd import <stack> --app "..."` adopt
already-deployed AWS resources of this type into cdkd state — covering
disaster recovery (state file lost), adoption (moving from another IaC
tool), and re-syncing after rollback. Skipping `import` is allowed (CC
API fallback handles overrides), but providers without it can only be
adopted via `--resource <id>=<physicalId>`.

> [!IMPORTANT]
> **Do not write an `aws:cdk:path` tag walk in a new provider.** That fallback
> can never match: AWS rejects any `aws:`-prefixed tag write, and CloudFormation
> keeps the construct path in template `Metadata` without promoting it to a tag
> ([#1128](https://github.com/go-to-k/cdkd/issues/1128)). Auto-mode import
> resolves physical ids from a same-named CloudFormation stack's
> `DescribeStackResources` ([#1130](https://github.com/go-to-k/cdkd/issues/1130))
> or from the template's physical-name property. The existing walks are being
> deleted ([#1134](https://github.com/go-to-k/cdkd/issues/1134)); adding a new
> one just adds more dead code.

What the method RETURNS matters as much as how it resolves the id:

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
> name a different region than the record holding it. And **a `try` does not
> cover the credentials failure** — `getAccountInfo` CATCHES its own STS error
> and returns the hardcoded `123456789012` (flagged `fabricated`), so nothing
> throws and a confidently-wrong ARN gets PERSISTED, carrying no wildcard for any
> downstream guard to catch. Refuse inside the ARN BUILDER rather than at the
> import call site: the UPDATE path rebuilds the same ARN on every in-place
> update and its attribute map replaces the record's wholesale, so guarding only
> import leaves the worse path — overwriting a correct recorded ARN — wide open.
> Then let each caller pick its own degradation: create omits, update reports NO
> attributes (so the engine carries the existing ones forward), and import keeps
> the account-independent keys while dropping only the ARN.

The method follows a single shape:

```typescript
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
  // Explicit override OR Properties.<NameField> from template.
  // Pass `null` as the second arg if the resource type has no
  // template-supplied name field (e.g. KMS Key, CloudFront Distribution).
  const explicit = resolveExplicitPhysicalId(input, '<NameField>');
  if (explicit) {
    try {
      await this.client.send(new <Get|Head|Describe>Command({ /* ... */ }));
      return { physicalId: explicit, attributes: {} };
    } catch (err) {
      if (err instanceof <NotFoundError>) return null;
      throw err;
    }
  }

  // Nothing else to resolve from. Return null so `cdkd import` reports the
  // resource as not-found rather than guessing.
  return null;
}
```

A `List*` walk is still correct when it matches on a **name** the template
supplies (rather than on a tag) and the service has no direct
`Get<Name>` lookup — see `s3-tables-provider.ts`'s `TableBucketName` walk
and `servicediscovery-provider.ts`'s namespace `Name` walk. Guard it with an
early `return null` when the template carries no name, so the walk never
pages an account's entire inventory just to fail.

Reference implementations to copy from:

- **Name-matched list walk** (the only walk shape still worth writing — matches
  a template-supplied name, not a tag): `s3-tables-provider.ts`
  (`TableBucketName`), `servicediscovery-provider.ts` (namespace `Name`)
- **Explicit-override only** (auto lookup is impractical, the resource is not taggable, or it is a sub-resource / attachment): `apigateway-provider.ts`, `apigatewayv2-provider.ts`, `appsync-provider.ts` for sub-resources scoped under a parent RestApi / HttpApi / GraphqlApi; `route53-provider.ts` for RecordSets (not taggable); `efs-provider.ts` for MountTargets (not taggable); `elbv2-provider.ts` for Listeners (no taggable identity tying them to a CDK construct); `sns-subscription-provider.ts`, `sns-topic-policy-provider.ts`, `sqs-queue-policy-provider.ts`, `s3-bucket-policy-provider.ts`, `lambda-permission-provider.ts`, `lambda-eventsource-provider.ts`, `lambda-url-provider.ts`, `custom-resource-provider.ts`, `cloudfront-oai-provider.ts`, `agentcore-runtime-provider.ts` for attachments / handler-returned identity; `agentcore-evaluator-provider.ts` accepts the ARN verbatim or resolves a bare evaluator id to the canonical ARN via `GetEvaluator`. Pattern: `if (input.knownPhysicalId) return { physicalId: input.knownPhysicalId, attributes: {} }; return null;` — JSDoc the override-only choice naming the reason (no tag API, sub-resource scoping, attachment, identity carried by handler-returned PhysicalResourceId, etc).
- **Singleton live auto-lookup (no override needed at all)**: `agentcore-browser-provider.ts` / `agentcore-code-interpreter-provider.ts` — the types are adopt-only representations of the AWS-managed defaults (`aws.browser.v1` / `aws.codeinterpreter.v1`), so `import` resolves them live via `GetBrowser` / `GetCodeInterpreter` and ignores overrides.

Notes:

- **Return `null`, don't throw**, when nothing matches — `cdkd import` treats `null` as "not deployed yet", not as a failure
- `attributes: {}` is fine for most types — the deploy-time `Fn::GetAtt`
  resolver reconstructs missing attributes via `constructAttribute`
  (see `src/deployment/intrinsic-function-resolver.ts`). `cdkd import`
  persists whatever map you return, but an empty map is treated as "no
  attributes" and falls back to the same-physical-id map already in state,
  so returning `{}` never clobbers a good snapshot from a prior deploy.
- **Never store an empty-string placeholder for an attribute you could not
  read back — omit the key instead.** Write
  `attributes: arn ? { Arn: arn } : {}`, not
  `attributes: { Arn: arn ?? '' }`. The resolver treats any non-`undefined`
  stored attribute as a hit, so a persisted `''` shadows
  `constructAttribute`'s fallback and makes `Fn::GetAtt` resolve to the
  empty string. This applies to `create()` / `update()` / `import()` alike —
  keep the three consistent within a provider.
- Tests for `import` go in the same file as the create/update/delete
  tests, with three cases: explicit-override path, tag-based lookup
  hit, tag-based lookup miss (returns `null`)

### Step 4: Add AWS Client

Add client to `src/utils/aws-clients.ts`:

```typescript
import { XxxClient } from '@aws-sdk/client-xxx';

export class AwsClients {
  // Existing clients
  public readonly s3: S3Client;
  public readonly iam: IAMClient;
  // ...

  // New client
  public readonly xxx: XxxClient;

  constructor(region: string) {
    const config = { region };

    this.s3 = new S3Client(config);
    this.iam = new IAMClient(config);
    // ...
    this.xxx = new XxxClient(config);
  }
}
```

### Step 5: Register Provider

Register in `src/provisioning/register-providers.ts` within the `registerAllProviders()` function:

```typescript
import { XxxResourceProvider } from './providers/xxx-resource-provider.js';

// Add to registerAllProviders()
registry.register('AWS::Xxx::Resource', new XxxResourceProvider());
```

### Step 5b: Refresh CFn schema fixture (issue #391)

The `property-coverage` test will fail until the new type's schema fixture exists:

```bash
node scripts/refresh-cfn-schemas.mjs --only-missing
```

Then classify every unaccounted property into `handledProperties` (if wired) or `unhandledByDesign` (if intentionally skipped, with a one-line rationale). See [§3c handledProperties coverage check](#3c-handledproperties--cfn-schema-coverage-check-issue-391) for the full workflow.

### Step 6: Create Tests

`tests/unit/provisioning/providers/xxx-resource-provider.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { XxxResourceProvider } from '../../../../src/provisioning/providers/xxx-resource-provider.js';

describe('XxxResourceProvider', () => {
  let provider: XxxResourceProvider;

  beforeEach(() => {
    provider = new XxxResourceProvider();
  });

  describe('create', () => {
    it('should create resource with valid properties', async () => {
      const result = await provider.create(
        'MyResource',
        'AWS::Xxx::Resource',
        {
          RequiredProp: 'value',
        }
      );

      expect(result.physicalId).toBeDefined();
      expect(result.attributes).toBeDefined();
    });

    it('should throw error if required property is missing', async () => {
      await expect(
        provider.create('MyResource', 'AWS::Xxx::Resource', {})
      ).rejects.toThrow();
    });
  });

  // Add tests for update, delete
});
```

## Best Practices

### 1. Error Handling

- Wrap all AWS SDK calls in try-catch
- Use `ProvisioningError` to provide detailed context

```typescript
try {
  await this.client.send(new CreateXxxCommand({ ... }));
} catch (error) {
  throw new ProvisioningError(
    `Failed to create ${logicalId}: ${String(error)}`,
    resourceType,
    logicalId,
    physicalId,
    error instanceof Error ? error : undefined
  );
}
```

### 1b. Never infer a default from a possibly-malformed value

Reading a string out of a nested config block with `||` — or with `??` — looks
harmless and is not:

```typescript
// WRONG — a string / array / unresolved intrinsic container indexes to
// `undefined`, and the `||` silently substitutes the OPPOSITE of the
// declared intent.
const status = (versioningConfig['Status'] as string) || 'Suspended';

// EQUALLY WRONG — `??` defaults on exactly the same `undefined` (issue #1493).
const type = (source['Type'] as string) ?? 'NO_SOURCE';
```

`VersioningConfiguration: 'Enabled'` (a hand-written L1 template, or an
intrinsic the resolver could not resolve) therefore turned versioning **off**
on a live bucket, with no error anywhere. Use the shared guards instead:

```typescript
import { readConfigString, requireConfigString } from '../config-shape.js';

// nested container, which may itself be malformed
const status = readConfigString(
  versioningConfig,
  'Status',
  'Suspended',
  'AWS::S3::Bucket VersioningConfiguration'
);

// top-level field — keep the `properties['X']` read at the call site so the
// handled-property-wiring critic can still see the property is consumed
const scope = requireConfigString(properties['Scope'], 'REGIONAL', 'AWS::WAFv2::WebACL Scope');
```

An absent container and an absent key still take the default (`{}` legitimately
means "defaulted"); a container that is present but not an object, and a key
that is present but not a non-blank string, are refused by name.

**A container you never read a string out of needs its own guard.** The two
above can only fire while reading a FIELD, so a block whose members you merely
probe for PRESENCE — or hand to `.map` — slips past both, and a malformed value
there reads as an EMPTY block rather than as an error:

```typescript
import { requireConfigArray, requireConfigObject } from '../config-shape.js';

// LIST block: a truthy non-array reaches `.map` and dies with a raw TypeError,
// a falsy one is silently dropped by the truthiness gate in front of it.
const tagFilters = requireConfigArray(raw, 'AWS::S3::Bucket …TagFilters');

// OBJECT block: every probe of a malformed container indexes to `undefined`,
// so the block reads as empty and the caller proceeds WITHOUT it — an S3
// lifecycle rule losing its whole location scope and applying bucket-wide.
const filter = requireConfigObject(raw, 'AWS::S3::Bucket …Rules[].Filter');
```

Both leave the ABSENT case to you (`raw != null && …`), because an omitted
block legitimately means "no entries" / "defaulted". Both also take the
`onUnusable` downgrade below, and when you pass it they return `undefined`
instead of throwing — **you** then decide the skip UNIT, and that decision is
the whole point: skipping must never be the misbehavior you were refusing.
S3's per-item Puts skip the single configuration item, while its lifecycle Put
skips the WHOLE configuration, because that call replaces every rule and
applying the valid siblings alone would DELETE the malformed one from AWS.

**A per-ITEM STRING read may need that same skip, not `readConfigString`'s
default.** `readConfigString`'s `onUnusable` downgrade is warn-and-DEFAULT,
which is right for a field whose default is inert — and wrong wherever the
default is applied to a LIVE resource and turns something ON. All four of S3's
per-item reads are that shape (issue
[#1595](https://github.com/go-to-k/cdkd/issues/1595)): defaulting a replayed
lifecycle / intelligent-tiering / replication `Status` to `Enabled` starts
expiring, archiving or replicating objects for a rule the template had
DISABLED. Ask the question without taking the answer:

```typescript
import { configStringRefusal } from '../config-shape.js';

// `undefined` when the read would have succeeded; otherwise the refusal
// SENTENCE, with no action clause — you supply the one that is true here.
const refusal = configStringRefusal(rule, 'Status', 'Enabled', '…Rules[]');
if (onUnusable && refusal !== undefined) {
  // Keep the clause PATH-NEUTRAL. The replay-CREATE arm reaches this too
  // (a reverse-replacement revives the resource), so a message asserting a
  // "live" configuration would be false there.
  onUnusable(`${refusal}. Leaving the whole configuration unapplied here; …`);
  return; // ...or `continue`, per the skip UNIT this API implies
}
```

On the create path you do not probe at all, so the original read still refuses
exactly as before. Use this helper rather than a hand-written `typeof` check:
it shares `requireConfigString`'s predicate, and a twin disagrees with the read
it fronts on precisely the values that matter — a blank string, an explicit
`null`, a coerced number.

Pass the **desired** side only. `previousProperties` comes from cdkd state
rather than the user's template, so refusing a malformed value recorded there
by an older binary would make the stack undeployable with no way out short of
hand-editing the state file.

A **top-level** read takes two further decisions, both per site (issue
[#1513](https://github.com/go-to-k/cdkd/issues/1513)), expressed as options on
`requireConfigString`:

```typescript
// CFn coerces scalars and cdkd does not, so an unquoted YAML `IpProtocol: -1`
// arrives as a NUMBER and deploys fine today — refusing it would break a
// working template. Only for genuinely numeric-looking fields; a number where
// an enum belongs (`InstanceType`) stays a refusal.
//
// The real site wraps this call in `narrowIngressIpProtocol` so the DIFF can
// resolve the protocol the same way — see the `effectiveProperties` section
// above for why a coerced value has to be recorded as well as sent (#1633).
const ipProtocol = requireConfigString(
  properties['IpProtocol'],
  '-1',
  'AWS::EC2::SecurityGroupIngress IpProtocol',
  { coerceNumber: true }
);

// UPDATE-path sites WARN instead of throwing — see §1a: `update()` is a state
// replay path unconditionally, so a refusal there can leave the resource
// un-rollbackable with no template-side remedy.
const status = requireConfigString(properties['Status'], 'Active', 'AWS::IAM::AccessKey Status', {
  onUnusable: (message) => this.logger.warn(message),
});
```

And check WHERE the read lives before guarding it: a helper the `delete()` or
diff paths also reach is fed state-borne values, so guard the create CALL SITE
instead (`EC2Provider.buildIpPermission` is the tree's example — it is shared
with `deleteSecurityGroupIngress` and with the revoke half of the inline-rule
update diff).

### 1a. Pre-flight refusal — when a provider may reject what CloudFormation forwards

cdkd's compatibility target is CloudFormation, so the default for a property
cdkd cannot handle is to **forward it and let AWS answer**, never to invent a
validation CloudFormation does not have. A provider that refuses a template
CloudFormation would accept is a parity break, and parity breaks are how a
tool that claims template compatibility stops being trustworthy.

There is one narrow exception, and it has a high bar. A provider MAY refuse a
property before the AWS call when **all** of the following hold:

1. **The property is undeployable on cdkd's OWN path**, proven by a live probe
   against the real API the provider calls — not inferred from CloudFormation
   also rejecting it. This is the load-bearing condition: "CFn rejects it too"
   is not sufficient, because cdkd calls the service API directly and could in
   principle succeed where a CFn resource handler fails.
2. **No shape of it works**, so no user loses a working deployment. If some
   combination deploys, forward it.
3. **The refusal names the working alternative**, concretely enough to copy.
   A refusal that only says "no" is worse than AWS's own error.
4. **The rationale is recorded at the check site**, as a comment naming the
   probe (date, region, what was tried, what AWS said) and flagging it as a
   deliberate parity divergence — so the next reader can re-evaluate it when
   AWS changes.

`GlueProvider`'s `enforceIcebergTableInputAbsent` (issue
[#1454](https://github.com/go-to-k/cdkd/issues/1454)) is the reference
implementation. Three details are worth copying:

- The check runs **before** the `try` block, so the typed `ProvisioningError`
  is not caught and re-labelled by the provider's own error wrapper. A test
  that only asserts message CONTENT cannot catch this being moved inside the
  `try`, because the wrapper EMBEDS the original message — assert the raw
  message PREFIX and an absent `cause` instead.
- **Refuse a TEMPLATE-driven call; WARN on a STATE REPLAY.** This asymmetry is
  the rule, not a Glue quirk, and the axis is the ORIGIN of the properties, not
  the operation name. **`cdkd rollback` replays from cdkd STATE, not from the
  template.** A resource whose state record already carries the offending value
  (written by an older cdkd build, or by an import) would become not just
  un-updatable but **UN-RESTORABLE**, and unlike the template case the user has
  no remedy at all — only hand-editing `state.json`. Concretely:

  - **`update()` — always warn.** `rollback-executor.ts` calls
    `provider.update(..., op.previousState.properties, ...)`, so `update()` is
    a replay path unconditionally and there is no signal to test. **Then pick
    the FALLBACK per site** (issue
    [#1551](https://github.com/go-to-k/cdkd/issues/1551)): warning and then
    applying the CREATE DEFAULT is frequently worse than the refusal was,
    because the default lands on a LIVE resource — it flipped an IAM-guarded
    Lambda function URL to PUBLIC, re-pointed a live DynamoDB stream, and read
    a malformed GSI block as "delete every index". Keep the PREVIOUS value
    where one exists (omitting the field entirely when the API has merge
    semantics), otherwise SKIP the block or SUPPRESS that part of the diff.
    Whichever you choose, remember the warn path now records the unusable
    value as the new state, so seed the next comparison from AWS's live value
    where the provider already holds it (issue
    [#1552](https://github.com/go-to-k/cdkd/issues/1552)).
  - **`create()` — refuse, unless `CreateContext.replayingState` is set.**
    `create()` is a replay path only through the rollback executor's
    reverse-replacement arm, which revives the OLD resource from
    `previousState.properties` (issue
    [#1199](https://github.com/go-to-k/cdkd/issues/1199)). That arm — and
    nothing else in cdkd — passes the optional 4th parameter
    `context?: CreateContext` with `replayingState: true` (issue
    [#1463](https://github.com/go-to-k/cdkd/issues/1463)). The deploy engine's
    five create sites (CREATE, the property-driven replacement, the
    `--recreate-via-*` destroy-then-create, the `--replace` delete-first
    fallback, the update-failure replacement) are driven by freshly resolved
    TEMPLATE properties and never set `replayingState`, so the refusal stands
    where the user can actually act on it. (They DO pass a context — every
    provider call now carries `maskSecrets`, see the `maskSecrets` bullet below — so the test
    fences for this read the context's key set rather than the call's arity.)
  - **Do not re-create inside `update()` if you have a create-side refusal.**
    Several providers call `this.create(logicalId, resourceType, properties)`
    from their own `update()` (ACM certificate, IAM managed policy, IAM role,
    Lambda permission, SNS subscription). Those internal re-creates CANNOT
    receive a `CreateContext` — `update()`'s own context is an `UpdateContext`,
    which carries no `replayingState` — and the
    `properties` they forward ARE a state record during a rollback replay. So
    the refusal would fire on a replay with no way to detect it. None of those
    providers has a pre-flight refusal today (they validate required fields
    only, which correctly stays a hard error), so there is no live gap; this is
    a constraint on the NEXT provider, not a description of the current tree.

  - **Retire what your create materialized before the error leaves.** A create
    shaped `<one API call that materializes the resource>` then `<a wait for it
    to become usable>` can fail with the resource already alive in AWS. Before
    issue [#2169](https://github.com/go-to-k/cdkd/issues/2169) an
    `AWS::CertificateManager::Certificate` in that state was simply LOST: the
    create never returned, so nothing was written to state, and it was
    invisible to `cdkd state show`, unreachable by `cdkd destroy`, and
    re-requested by the next `cdkd deploy` — an orphan per attempt. Delete it
    in your own `catch`, best-effort, and re-throw the ORIGINAL error.

    Three points that decide whether you get this right:

    - **Track the id from the API response, not from the name you computed.**
      Set the local only once AWS has confirmed the resource exists, so a
      failure BEFORE the call deletes nothing. Do NOT reuse
      `ProvisioningError.physicalId` as this signal — 462 call sites across 75
      provider files pass one, and on a create path it is usually the intended
      name computed beforehand (`IAMRoleProvider.create` hands its catch the
      `roleName` it derived, whether or not `CreateRole` ever ran).
    - **Never let the cleanup replace the diagnosis.** The create's own error
      is what the user needs; a cleanup that FAILED appends a line naming the
      survivor and the manual command to retire it, and a cleanup that threw
      must never surface instead of the original.
    - **Do not record the remnant in state as an alternative.** It looks like
      the tidier answer and it is a trap: the recorded properties ARE the
      template's, so the next deploy diffs the resource as `NO_CHANGE` and
      never touches it again — `cdkd deploy` prints "No changes detected" and
      exits 0 over a resource that is still unusable. Turning a loud failure
      into a silent one is worse than the orphan. Making the diff re-provision
      it instead needs a marker on the state record, i.e. a schema bump.

    Whether deleting is SAFE is a per-service question you have to answer, not
    assume. For ACM it is, and the reason is documented rather than inferred:
    the DNS validation CNAME is derived from the domain and the account, not
    from the certificate, and AWS states you can "replace a deleted
    certificate" without repeating validation — so the records a user adds
    after the failure validate the retry's certificate too. If your service has
    no such property, say so and choose differently.

  - **`maskSecrets` — mask a resolved property value before you log it.**
    Both `CreateContext` and `UpdateContext` extend a shared
    `SecretMaskingContext`, whose one optional field is
    `maskSecrets?: (text: string) => string` (issue
    [#1932](https://github.com/go-to-k/cdkd/issues/1932)). Any provider log
    line that interpolates a value from the `properties` bag MUST run through
    it: those values arrive RESOLVED, so a
    `{{resolve:secretsmanager:...}}` property is already plaintext by the time
    a provider sees it, and cdkd's other masking boundaries (the deploy
    engine's error / reason text, the resolver's own debug line) do not cover a
    provider's own `logger.warn`. Read it defensively —
    `const mask = context?.maskSecrets ?? ((t: string) => t)` — since `create()`
    / `update()` are also called by `cdkd drift --revert`, by the import path,
    and by tests. It is per-CALL, so never cache it on `this`: providers are
    registered as singletons and serve concurrent resources.
    **Mask the VALUE before it is stringified or interpolated; the finished
    message is a FALLBACK, not an equivalent.** Two independent reasons:
    (1) *escaping* — a masker matches by literal occurrence, and
    `JSON.stringify` escapes `"`, `\` and newlines, so a secret containing any
    of them (i.e. any Secrets Manager JSON document, the commonest real secret
    shape) no longer occurs in the finished line and passes through verbatim;
    (2) *length* — `maskSecretsInText` masks an exact whole-value match at ANY
    length but only scans for SUBSTRING needles of at least
    `MIN_NEEDLE_LENGTH` (4) characters, and a message is always longer than the
    value inside it, so a 1-3 character secret survives. Do BOTH: mask each
    string leaf before interpolating (catches escaped and short secrets), and
    route the assembled message through the masker too (catches interpolations
    added later, and text the leaf pass never sees). The mask is idempotent, so
    the layers compose.
    **Use `maskDeep` from
    [src/provisioning/masked-retry-logger.ts](../src/provisioning/masked-retry-logger.ts)
    for the leaf pass — do NOT hand-roll one.** Issue
    [#2176](https://github.com/go-to-k/cdkd/issues/2176) found SIX private
    copies of that walk, FOUR of which had lost the depth cap. A walk that
    encodes a security contract drifts the moment it is copied: a hardening
    applied to one copy silently leaves the rest behind. Grep for the walk's
    SHAPE rather than a name — two of the six were nearly missed twice because
    they spell it `maskLeaf` / `maskLeafValue` and declare no named depth
    constant to grep for.
    **The leaf pass is now MECHANICALLY ENFORCED for the `JSON.stringify` case**
    (issue [#2178](https://github.com/go-to-k/cdkd/issues/2178)).
    `vp run audit:provider-secret-mask:check`
    (`scripts/check-provider-secret-mask.ts`, a CI step) fails on any
    `${JSON.stringify(X)}` interpolated into a message under
    `src/provisioning/providers/**` (plus `composite-id.ts`) where `X` reaches
    no masker. It is DATAFLOW-aware, so the mask may sit anywhere upstream —
    through a `const` binding, a `?:` / `??` arm, an array or object literal, a
    `.map()` callback, or a helper — and both real upstream-mask sites
    (`asg-provider.ts`, `cloudfront-distribution-provider.ts`) pass unchanged.
    It became a check rather than another sentence because the rule above was
    already written and violated anyway: the #2176 sweep found raw sites in
    files already hardened for this exact contract.

    **An IDENTITY masker does NOT satisfy it.** A binding such as
    `const M: MaskerFn = maskerOrIdentity(undefined)` type-checks, reads as
    protection, and masks nothing — so the critic classifies a site masked only
    by one as `raw`. Issue
    [#2007](https://github.com/go-to-k/cdkd/issues/2007) is why that is worse
    than having no masker at all: its presence stops the next author looking.
    This holds in the ARGUMENT position too, which is the one you are most
    likely to write: `maskDeep(value, maskerOrIdentity(undefined))` walks every
    leaf and changes nothing, so the critic classifies it `raw` exactly as it
    does a bare value. That position is an ALLOW-LIST — it accepts only what
    resolves to the shared capability and refuses anything else, so an inline
    `(t) => t`, a cast, a hand-rolled `function noMask(v) { return v; }` and an
    arbitrary object property are all refused without the check having to
    enumerate them.

    **What the check does NOT prove.** It is syntactic, so a no-op DECLARED to
    be the capability is believed: `const m: MaskerFn = someNoOp` and
    `{ maskSecrets: (t) => t }` both pass. A green run means the value reached
    something declared to be the project's masker — not that it was masked.
    Thread the real capability; do not satisfy the checker.
    Where a path genuinely has no masker to thread — `DeleteContext` carries
    none by the `SecretMaskingContext` contract — thread the capability first,
    or record the site in the critic's `EXEMPT` list, where it is COUNTED and
    re-audited on every run and fails the moment the capability arrives. Do not
    reach for an identity default to make the check pass. A parameter's
    identity DEFAULT is a different thing and stays legitimate: it is the
    contract's back-compatible absent-means-unmasked answer, and what the
    critic checks there is that every CALL SITE threads a real masker — but
    only for an UNTYPED parameter of a non-exported function. A parameter
    ANNOTATED `MaskerFn` / `SecretMasker` is treated as a masker by TYPE, so it
    joins the file's masker set unconditionally and its call sites are NOT
    checked; the same is true of any exported function. Prefer the REQUIRED
    spelling (`mask: MaskerFn`, no identity default) for new sites: the
    compiler then enforces threading, which is the only mechanism that does not
    depend on the critic noticing. Every in-repo call site does thread today —
    verified, not assumed — so this is a shape to prefer, not a live gap.

    Back to the masker itself, whose scope the paragraphs above interrupted.
    `maskDeep` covers cdkd's
    dynamic-reference secret model only — a `NoEcho: true` template PARAMETER
    is outside that model and is not masked by it, and that residual is
    PERSISTED rather than log-only (a `NoEcho` value quoted inside an AWS error
    reaches `deployments/*.jsonl`; issue
    [#1998](https://github.com/go-to-k/cdkd/issues/1998)). `delete()` has no
    masker — see `SecretMaskingContext` for why that is a statement about
    providers rather than about the bag, and why you must thread the capability
    BEFORE adding any delete-side log line that names a property value.
    **Mask where the message is CONSTRUCTED, not where the arm catches it, when
    the service reports rejections through an operation poller.** For an
    operation-based API (AWS Cloud Map's `Create*Namespace` / `Update*Namespace`
    return an `OperationId`, and the rejection arrives later as
    `Operation.ErrorMessage` with the offending value quoted back), a shared
    poller builds the error and every arm's catch opens with
    `if (error instanceof ProvisioningError) throw error;` — so the poller's
    error is re-thrown VERBATIM and masking the arm does nothing for it.
    Threading the masker into the arm therefore looks like a fix and is inert on
    the path that actually fires, since for these types a FAILED operation is
    the NORMAL rejection route rather than an edge case. `pollOperation` in
    [src/provisioning/providers/servicediscovery-provider.ts](../src/provisioning/providers/servicediscovery-provider.ts)
    is the worked example (issue
    [#2063](https://github.com/go-to-k/cdkd/issues/2063)): it masks the raw
    `ErrorMessage` at construction, and it takes the masker from every
    CREATE / UPDATE caller rather than only the newly-threaded ones — an arm
    fixed by an earlier pass is not evidence that its poller was. The DELETE
    callers stay unthreaded, which is the contract above rather than an
    oversight: `DeleteContext` carries no masker, and their payload is a
    physical id rather than a resolved property bag.
    The reference implementation
    is `buildMfaConfigRequest` in
    [src/provisioning/providers/cognito-provider.ts](../src/provisioning/providers/cognito-provider.ts),
    which routes every warning through one masked sink rather than masking at
    each call; `create()` in
    [src/provisioning/providers/ssm-parameter-provider.ts](../src/provisioning/providers/ssm-parameter-provider.ts)
    is the same shape for a whole operation (one `mask`, one `warn`, one
    `debug`, built at the top and used everywhere below).
    **Per-site masking DOES drift, and that is measured rather than
    predicted.** Issue #2176's sweep found raw `${JSON.stringify(...)}` sites in
    files ALREADY hardened for this contract —
    `dynamodb-table-provider.ts` masked one argument of a `warn` call and left
    the argument beside it raw. A sink is what makes the next line added below
    it correct by default.

  The parameter is optional, so a provider with no pre-flight needs no change.
  A provider that HAS one threads `context` from `create()` to its check and
  emits a warning instead of throwing when the flag is set. What the flag means
  (and, just as importantly, what it does NOT license — nothing about the
  properties' content, no relaxing of data-safety guards, no skipping the
  validation that protects the AWS call itself) is spelled out on `CreateContext`
  in [src/types/resource.ts](../src/types/resource.ts), next to the
  `ResourceProvider` interface that consumes it. Its sibling `DeleteContext`
  lives in [src/provisioning/region-check.ts](../src/provisioning/region-check.ts)
  instead, because `expectedRegion` feeds that module's `assertRegionMatch`
  helper; `CreateContext` has no region-checking role, so it is not filed there
  for symmetry alone. A pointer next to `DeleteContext` links the two.

  One honest consequence: warning on a replay means the value IS forwarded on
  the create path, unlike the update path where the SDK command has no member
  for it. So the re-created resource is degraded in whatever way the original
  was, and the AWS call may still fail. That is strictly better than refusing —
  a refusal guarantees the resource is not restored — but the warning must SAY
  so and name the fix-forward (`cdkd deploy` with the working shape).
- Where update genuinely does not forward the property anyway (cdkd does not
  wire Glue's update-only `UpdateOpenTableFormatInput` shape), warning costs nothing:
  no bad value can reach AWS from that path, and the user still gets the full
  message. Share ONE message builder between the refusal and the warning so
  they cannot drift.

A pre-flight in a provider only covers the **SDK route**. A resource whose
state records `provisionedBy: 'cc-api'` is sticky-routed to
`CloudControlProvider` and bypasses it entirely. That is usually acceptable
(the deploy still fails, just later and less helpfully) — but say so in the
docs rather than letting a reader assume the refusal is total.

If a property is merely *unimplemented* rather than undeployable, this is the
wrong mechanism — move it to `unhandledByDesign`, which converts the silent
drop into the Cloud Control auto-route (see §3c).

### 2. Idempotency

- Handle when `create` is called on existing resource
- Handle when `delete` is called on non-existent resource

**Region verification on `*NotFound`**: A `*NotFound` error during DELETE
must NOT be treated as idempotent success without confirming that the AWS
client's region matches the region the resource was deployed to. A destroy
run pointing at the wrong region would otherwise receive `NotFound` for
every resource and silently strip them all from state, leaving the actual
AWS resources orphaned in the real region (this is the silent-failure
incident that motivated PR 2 of the region/state refactor).

Providers MUST call `assertRegionMatch()` from
`src/provisioning/region-check.ts` before returning early on a `*NotFound`
error:

```typescript
import { assertRegionMatch, type DeleteContext } from '../region-check.js';

async delete(
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext,
): Promise<void> {
  try {
    await this.client.send(new DeleteXxxCommand({ Id: physicalId }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.client.config.region();
      assertRegionMatch(
        clientRegion,
        context?.expectedRegion,
        resourceType,
        logicalId,
        physicalId,
      );
      this.logger.info('Resource not found, skipping deletion');
      return;
    }
    throw error;
  }
}
```

`assertRegionMatch` is a no-op when `context.expectedRegion` is undefined,
preserving the existing idempotent semantics for callers that have not
been threaded with state region. When set, a region mismatch throws a
`ProvisioningError` that surfaces both regions and a hint to rerun with
the correct `--region`.

**The `NotFound` branch is the REACTIVE use, and it is not the only one**
(issue [#2301](https://github.com/go-to-k/cdkd/issues/2301)). A wrong-region
call usually never REACHES that branch: most physical ids are NAMES, and the
same name commonly exists in the client's region as well — the same stack
deployed twice, or `resource-name.ts` deriving an identical name from an
identical stack plus logical id — so the call succeeds against the WRONG
resource instead of erroring. `assertRegionMatch` therefore takes an optional
sixth `phase` argument: the default `'not-found'` keeps the wording above,
while `'pre-delete'` / `'pre-update'` word the same refusal for a call that has
not been issued yet. The comparison and the three outcomes are one
implementation across all three phases; only the message differs.

`CloudControlProvider` uses those phases UNCONDITIONALLY, for every
Cloud-Control-routed type, at the top of both `delete()` and `update()` —
before the `--remove-protection` flips, before the SDK delegations, before the
`AWS::S3::Bucket` identity probe, and before the `DescribeType` the update
path's write-only lookup performs. The update side is why `UpdateContext`
carries an `expectedRegion` of its own (`src/types/resource.ts`), threaded by
`deploy-engine.ts`, `rollback-executor.ts` and `drift --revert`. An SDK
provider MAY read the same field, but nothing requires it to: absent, the
guard is a no-op, exactly as on the delete side.

**The create side has the same question, and it is NOT the same answer.**
"Handle when `create` is called on an existing resource" above is the usual
idempotent short-circuit: an `*AlreadyExists` / `*AlreadyOwned` error is
swallowed and the create reported as success. Before writing one, ask what
namespace that error is scoped to and whether it is narrower, equal to, or
WIDER than the region the client points at. It is sound only when the error
can mean nothing but "the resource I want, where I want it, already exists".

For nearly every type that is automatic — either the namespace is REGIONAL
(SNS, CloudWatch Logs, SSM, EC2), so the conflict is by construction in the
region you called, or the namespace is global AND so is the resource (IAM,
Route 53, CloudFront), so there is no other region for it to be in.
`AWS::S3::Bucket` is the one type where the two come apart, a globally unique
name over a regionally located resource, and it broke exactly there: measured
on real AWS, a bucket in `us-west-2` answers `BucketAlreadyOwnedByYou` to a
`CreateBucket` in `eu-west-1` and in `us-east-1` alike, so the short-circuit
adopted another region's bucket and applied the whole stack's configuration to
it while reporting success (issue
[#2227](https://github.com/go-to-k/cdkd/issues/2227)).

`S3BucketProvider.assertExistingBucketRegion` is the create-side twin of
`assertRegionMatch`. It reads the bucket's region from the
`x-amz-bucket-region` header on the 409 itself — no extra call, no extra IAM —
and falls back to `GetBucketLocation`. Note `assertRegionMatch` is a no-op
without `expectedRegion` while this one always has a region to compare against:
the create knows where it is deploying.

**There are FOUR of these guards, not two, and `assertRegionMatch` is only the
generic one.** The two above are the SDK route; the Cloud Control route has its
own pair, because a bucket declaring a silent-drop property (`AccessControl`) is
auto-routed there and `S3BucketProvider.delete` never runs at all (issue
[#2283](https://github.com/go-to-k/cdkd/issues/2283), fixed in
[#2309](https://github.com/go-to-k/cdkd/issues/2309)):

| Guard | Route / phase | On an INDETERMINATE answer |
| --- | --- | --- |
| `S3BucketProvider.assertExistingBucketRegion` | SDK, create | refuses |
| `assertRegionMatch` (`src/provisioning/region-check.ts`) | generic, delete; update only where a provider opts in (`S3BucketProvider` alone today) | no-op without `expectedRegion` |
| `CloudControlProvider.confirmDeleteTargetIdentity` | CC, delete, per-type (S3 today) | **warns and PROCEEDS** |
| `CloudControlProvider.assertRecordedRegionAgainstClient` | CC, delete + update | **refuses** |

The last two sit in the same file and answer indeterminacy in OPPOSITE
directions, which is deliberate rather than an inconsistency. The probe asks a
REMOTE service where a globally unique name lives, so a least-privilege role
never granted `s3:GetBucketLocation` would be stranded by a refusal; the
comparison is LOCAL and free against a region the caller positively recorded, so
a client that cannot say where it points cannot be shown to point there. Two
further details of the probe are decisions, not oversights: it is keyed on a
per-type set rather than being generic, and it deliberately omits
`ExpectedBucketOwner` — the opposite of the convention `state.ts` and
`aws-region-resolver.ts` follow — because the hazard is a name resolving to a
bucket in ANOTHER ACCOUNT, and the guard has to hear that foreign answer to
refuse. Passing the parameter would turn every cross-account collision into a
403, i.e. into the indeterminate arm, i.e. into warn-and-proceed.

Deliberately NOT `HeadBucket`, which 301s cross-region and which SDK v3 turns
into a synthetic `UnknownError` (`src/utils/aws-region-resolver.ts` records the
mechanism), and deliberately not that module's `resolveBucketRegion`, which
never throws and returns a fallback region — wiring it here would turn a
fail-closed guard into a fail-open one. See
`.claude/rules/provider-resource-identity.md` for the full rule, including the
two legacy `GetBucketLocation` spellings the fold must absorb and why the
refusal is `markNonRetryable`. (`.claude/rules/providers.md` is a routing index
now — the rules corpus was split under its byte ceiling in issue
[#2310](https://github.com/go-to-k/cdkd/issues/2310) — so it points on rather
than carrying the rule itself.)

That guard is scoped to the `BucketAlreadyOwnedByYou` catch on the CREATE path,
which leaves two neighbouring routes to the wrong bucket that it cannot see —
`us-east-1`'s legacy 200 (issue
[#2241](https://github.com/go-to-k/cdkd/issues/2241)) and a state record written
before the guard existed (issue
[#2245](https://github.com/go-to-k/cdkd/issues/2245)). `S3BucketProvider` now
also pre-flights the bucket NAME before `CreateBucket` when the target region is
`us-east-1`, and shares one `assertStateBucketRegion` between `update()` and
`delete()`. `.claude/rules/provider-resource-identity.md` carries the mechanism
and the three rules worth reusing: the pre-flight informs the partial-create CLEANUP GATE only
and never replaces `CreateBucket` (the ownership oracle), an unanswered probe is
kept distinct from a confirmed absence, and the state-record guard PROCEEDS on
both rather than stranding every update and destroy for a least-privilege role.

Note what that last choice COSTS, because it is a new IAM dependency rather than
a free win: the guard works only where the caller can call `GetBucketLocation`
on the target. A principal without that grant is NOT an unrelated population —
it is the same population, unprobeable, and for it the guard is inert on every
call; a bucket POLICY can `Deny` the call as well, which is indistinguishable on
the wire from a missing grant. That is why the delete-side degrade logs at
`warn` rather than `debug`: proceeding unverified into an irreversible delete
must never look identical to a healthy one.

That rule is also where the probe-first lesson lives, and it cuts both ways
here: the mid-delete hazard the issue was FILED for is not reachable, so a
guard against it could never have fired — while the guard that WAS written
could not fire either, because its unit tests encoded the AWS CLI's wire shape
rather than the SDK's. A mutation probe cannot catch that: it perturbs the code
and reads the test, and both read the same fixture, so a premise shared by code
and mock is invariant under it. Only a recorded real response or a live arm
falsifies a fixture.

### 2b. Reporting a SKIPPED delete (issue #1752)

`delete()` returning normally means **"the resource is gone"** — a delete
call succeeded, or the resource was already absent (the `*NotFound`
idempotent arm above, `CustomResourceProvider`'s backing-Lambda-is-gone
pre-check). Both are honest, so both count toward `N deleted`.

A **warn-and-continue** arm that issues no AWS call at all is different, and
returning `void` from one is a bug. `cdkd destroy`'s only signal used to be
"did not throw", so such an arm printed `✓ <id> (<type>) deleted`, counted
toward `N deleted`, **dropped the state record**, and exited 0 — over a
resource that may still be alive and billing. Report the skip instead:

```typescript
const [databaseName, tableName] = physicalId.split('|');
if (!databaseName || !tableName) {
  this.logger.warn(
    compositeIdFormatMessage(GLUE_TABLE_ID_FORMAT, logicalId, physicalId, { skipping: true })
  );
  return compositeIdSkipResult(); // { outcome: 'skipped', reason }
}
```

What the destroy runner then does, and why each half matters:

- prints `⚠ <id> (<type>) skipped (<reason>)` — a yellow warning glyph, so it
  can be read as neither the `✓ … deleted` success line nor the
  `✗ Failed to delete` failure line;
- counts it in a separate `skipped` column
  (`2 deleted, 1 skipped, 0 errors`) rather than as an error — nothing was
  attempted, so nothing failed;
- **KEEPS the state record.** This is the half that is easy to miss: dropping
  it leaves the user with neither the AWS resource deleted nor an id to go and
  delete it with;
- preserves `state.json` and exits **2** (`PartialFailureError`), the same
  contract a partial / interrupted destroy already carries. Exiting 0 while
  leaving a resource behind is the mis-report this mechanism exists to
  prevent;
- emits a `RESOURCE_SKIPPED` deployment event (no `error` field).

Reach for this ONLY when cdkd genuinely cannot address the resource. If you
know the resource is gone, return `void` — reporting a skip there would
preserve state and fail the destroy for no reason. The `--purge-events` flag
and the run-level `RUN_FINISHED` result both treat a skip as a failed run, so a
new producer changes user-visible exit behavior — decide deliberately.

**A provider that recurses into another destroy propagates the child's
result.** `NestedStackProvider.delete` returns `{ outcome: 'skipped' }` when the
child runner reports `skippedCount > 0` OR `interrupted`; without that the
parent would print `✓ <Child> (AWS::CloudFormation::Stack) deleted` and exit 0
over a child stack that kept a live resource. The child's third
not-gone signal, `errorCount > 0`, is a **THROW** rather than a skip (issue
[#1777](https://github.com/go-to-k/cdkd/issues/1777)): a resource was attempted
and FAILED, so the parent's row must fail too, and calling it a skip would
assert the opposite of what happened (a skip means no AWS call was issued).
Word such a throw so it contains none of `not found` / `does not exist` /
`No policy found` / `NoSuchEntity` / `NotFoundException` (and the deploy
engine's `was not found` / `ResourceNotFoundException`) — both callers' catch
blocks read those as an idempotent already-deleted success and DROP the state
record, which is the outcome the throw exists to prevent. Note the asymmetry
between the two return channels: since issue #1762 a `{ outcome: 'skipped' }`
value reaches the deploy-side sites too, but WEAKER — the template-removal
DELETE warns and keeps the record — while a throw FAILS the resource at every
caller, so converting a skip into a throw still changes `cdkd deploy`'s
behavior when the resource is removed from the template.

**A provider that DELEGATES its delete to another provider propagates the
delegate's outcome** (issue
[#1778](https://github.com/go-to-k/cdkd/issues/1778)). `CloudControlProvider`
hands a protected `AWS::AutoScaling::AutoScalingGroup` to `ASGProvider.delete`
under `--remove-protection`, and discarding that verdict is the nested-stack
hole one layer down: a skip inside the delegate reached the destroy runner as a
plain successful delete. `return await delegate.delete(...)` is the whole fix.
Type the delegate as `ResourceProvider` rather than as its concrete class, so
the forwarding stays correct when the delegate widens its own return type.
The alternative contract — ASSERT the delegate cannot skip — was rejected: it
has to be re-verified every time the delegate grows an arm, and it fails
loudly on a case the delegate considers merely unaddressable.

**And a provider that pairs `create()` + `delete()` inside its own `update()`
must not swallow the delete's outcome either** (same issue). A skip does not
throw, so it slips past the `catch` that would have warned — precisely when the
old resource IS left behind. What to do depends on the ORDERING, and it is not
the same for all of them:

- **create-then-delete** (ACM certificate, IAM managed policy, IAM role, and
  the API Gateway Resource PathPart replacement): the new resource already
  exists, so the replacement cannot be aborted. WARN, in the same orphan wording
  the failure arm uses (`The old role may be orphaned and require manual
  cleanup.`), naming the skip's `reason` — and since issue
  [#1819](https://github.com/go-to-k/cdkd/issues/1819) ALSO return
  `{ outcome: 'partial', reason }`, so the outcome is counted and recorded
  rather than living only in the log.
- **delete-then-create** (SNS subscription): ABORT with a `ProvisioningError`
  BEFORE creating the replacement. Continuing would leave two subscriptions on
  the topic and deliver every message twice, and that duplicate is precisely
  what the CREATE would add — so not making it is the whole remedy.

State the premise as **"the resource was not destroyed"**, never as "no AWS
call was issued". `ResourceDeleteResult`'s own contract says so, and its
warning is not academic: `NestedStackProvider` reports `skipped` after
recursing into a child destroy that may already have deleted the child's other
resources. The abort is right under the weaker premise anyway — whatever the
skipping delete did, adding a second live resource on top of it is not an
improvement.

An abort on an `update()` path must be right for EVERY caller, not only the
template-driven one — `cdkd drift --revert` and the rollback executor's revert
arms call `update()` with a state-borne desired bag (see §1a). The SNS abort
clears that bar because a second live subscription serves none of the three;
where a refusal would not, downgrade it to a warning instead.

Two mechanical details any such abort inherits:

- **Do not interpolate the provider-supplied `reason` into the thrown
  message.** The rollback executor wraps `update()` in `withRetry`, and
  `retryable-errors.ts` classifies by SUBSTRING — so a reason carrying
  `does not exist`, `Rate exceeded`, or `because it is in use` would flip a
  deterministic abort to "retryable" and burn the whole backoff schedule
  before a certain failure. Log the reason; interpolate nothing into the thrown
  message but the TEMPLATE logical id. The state-borne physical id is the worst
  candidate of all — the only skip family a REPLACE path meets today is
  literally "malformed physicalId in state", and `cdkd import --resource
  <id>=<anything>` puts an arbitrary string there.
- **...and then `markNonRetryable` the error, because keeping values out of the
  message cannot close the hole.** The match is a SUBSTRING, not an equality, so
  an ordinary composite logical id (`MyDependencyViolationSub`) still carries a
  pattern — measured — and a message that names nothing is not diagnosable.
  `markNonRetryable(new ProvisioningError(...))` (from
  `src/deployment/retryable-errors.ts`) sets a non-enumerable `Symbol.for`
  marker that `isRetryableTransientError` consults BEFORE any name or message
  heuristic, so the refusal is terminal by DECLARATION and no wording can
  overturn it. Reach for it only where the error means "this cannot succeed on
  a retry" as a matter of cdkd's own logic — never for a relayed AWS failure,
  whose retryability is the classifiers' business.

  The fence is at the RETRY LOOP, not only in that one classifier: `withRetry`
  rethrows a marked error BEFORE choosing between the default classifier and a
  caller-supplied `opts.isRetryable`, and the destroy runner's delete-retry
  loop gates its own `Too Many Requests` message test the same way. So the
  message-only classifiers (`isNameCollisionError`'s `AlreadyExists`,
  `isNameCooldownError`'s `QueueDeletedRecently` / `StateMachineDeleting` —
  all of which match a bare logical id) cannot resurrect a refusal even though they cannot read the
  marker themselves. Keep the message discipline above regardless: it is what
  a future classifier added outside those two loops still relies on.
- **Point the remediation at the STATE record, not only at AWS.** Both skip
  families shipping today — the state-borne composite-id arms and
  `NestedStackProvider`'s propagation — describe a resource whose repair
  "remove the old resource in AWS" does not cover on its own, and for the
  malformed-physicalId one deleting the AWS resource fixes nothing at all.
  Name both repairs.

Note this is deliberately NOT symmetric with a THROWN delete, which those
providers still warn-and-continue past: a throw may mean the delete partially
landed or was transient, while a skip is a positive statement that the resource
was not destroyed.

Producers today: the malformed-composite-physicalId family
(`src/provisioning/composite-id.ts`, five arms), the nested-stack propagation
above, and — since issue [#1770](https://github.com/go-to-k/cdkd/issues/1770) —
eight same-class arms outside the composite-id family: both malformed
`LayerVersionArn` arms in `lambda-layer-provider.ts`, the missing-`FunctionName`
arm in `lambda-permission-provider.ts`, the no-properties / no-`ServiceToken`
arms in `custom-resource-provider.ts`, the empty-policy-name arm in
`iam-policy-provider.ts`, and both `AWS::IAM::UserToGroupAddition` arms in
`iam-user-group-provider.ts`. Each exports its `reason` as a named constant
beside the provider, so the wording is pinned by a test instead of retyped.

Three lessons from that issue's code review are worth reusing before you add a
skip arm of your own.

**Exhaust every addressable source first.** A skip is not a free "safe"
default: it preserves the record, warns, and exits 2 — on every re-run, so the
destroy can never go green. Two of the eight arms were skipping although a
second source held the value. `RemovePermission` accepts a full ARN as
`FunctionName`, and the physicalId's documented
`<functionArn>|<statementId>` shape carries one; `PolicyName` is in
`handledProperties` and `create()` uses it verbatim as the real AWS name. Order
the sources by what was DEPLOYED — the physicalId wins over the property, or a
template edit that renamed the policy without a replacement having landed would
send a delete for a name AWS never had.

**Validate the fallback, or it is worse than the skip.** A truthy NON-string
(an unresolved intrinsic, an array) must not beat a good second source — the SDK
URI-encodes it into a garbage label that 404s, and the idempotent `*NotFound`
arm then reports DELETED. Check the fallback's REGION too: a provider holds one
client, so a cross-region ARN sends the call to the wrong region and is reported
DELETED the same way. And do not let the gate refuse a genuine source — the CFn
primary identifier `[FunctionName, Id]` carries a BARE name as often as an ARN.

**A guard that admits a record must check the path it opens reaches AWS.** The
IAM `PolicyName` fallback turned an honest skip into a silent `deleted`: with
the name resolvable, a record naming no `Roles` / `Groups` / `Users` reached a
body where every branch is skipped — zero AWS calls, returning `undefined`, i.e.
DELETED. Trace the admitted path to an actual call, and use the same truthiness
spelling the branches downstream use so a null-valued list cannot slip past.

**"LEFT IN PLACE" is false when the parent is in the same stack.** The destroy
keeps going after a skip, and `deleteGroup` / `deleteUser` remove exactly those
memberships, a deleted Lambda function drops its whole resource policy, a
deleted IAM role drops its inline policies. Qualify the wording and name
`cdkd state orphan <stack>`; do not copy the qualifier onto an arm where it is
false (a layer version and a Custom Resource's external side effects are undone
by nothing).

**"Repair state.json and re-run" holds on destroy AND on the deploy engine's
template-removal DELETE** — both keep the record (issue
[#1762](https://github.com/go-to-k/cdkd/issues/1762)). It does NOT hold for a
deploy-side REPLACEMENT or rollback delete, which fail the resource and can
leave the old one untracked, so every skip warning carries the same caveat
`compositeIdFormatMessage` does.

Two judgment calls from that issue are worth reusing. The
`UserToGroupAddition` arms logged at DEBUG, which read as "routine, nothing to
do" — but `GroupName` and `Users` are both REQUIRED by the CloudFormation
schema, so a record missing either is CORRUPT rather than empty, and the
memberships `AddUserToGroup` created survive the destroy; they are skips, and
the level was raised to WARN to match (a skip preserves state and exits
non-zero, so the user needs the explanation at normal verbosity). An EMPTY
`Users: []` is the opposite case and stays a `deleted`: an array is truthy, so
it falls through to the removal loop and correctly does nothing.

The `*NotFound` idempotent arms in those same files are deliberately
untouched, as is `CustomResourceProvider`'s backing-Lambda-is-gone pre-check —
those mean the resource IS gone. The deploy-engine / rollback-executor callers
consume the return value as of issue
[#1762](https://github.com/go-to-k/cdkd/issues/1762): the template-removal
DELETE warns and keeps the record, a replacement delete fails the resource, and
a rollback delete counts as a per-op failure — except at the arm that deletes
the NEW resource after the old one was already re-created, where the delete is
best-effort and a skip only warns.

### 2c. A CREATE that mints a server-side id needs an idempotency token (issue #2039)

The deploy engine wraps every `provider.create()` in its outer transient-error
retry, and HTTP 500 / 502 / 504 are retryable (issue #2026). So a 500 whose
request actually SUCCEEDED server-side re-invokes `create()` from the top. For a
create whose id comes from AWS rather than from a name, the replay provisions a
SECOND resource: it has no state entry, `cdkd destroy` never reaches it, and it
bills indefinitely.

When the API takes a `ClientToken` / `ClientRequestToken` / `IdempotencyToken` /
`CallerReference`, take it from the shared helper:

```typescript
import { acquireIdempotencyToken } from './idempotency-token.js';

const token = acquireIdempotencyToken({ scope: 'RunInstances', logicalId });
const response = await this.client.send(
  new RunInstancesCommand({ ...input, ClientToken: token.value })
);
token.release(); // SUCCESS PATH ONLY
```

Three rules, each of which has a failure mode behind it:

- **Never derive the token per attempt.** A `Date.now()` / `randomUUID()` value
  is worse than no token at all, because the call site then LOOKS idempotent
  while behaving exactly as before. `AWS::Route53::HostedZone` shipped that way.
- **Release only on success**, and also wherever the provider DESTROYS the
  resource the token names (the `RunInstances` wiring-failure path terminates the
  instance). A released token is never handed out again, so releasing on a
  failure path defeats the mechanism, while NOT releasing after the resource is
  gone can hand a later create the resource it just destroyed — EC2 keeps a
  `RunInstances` token for ~24h.
- **Check what the API does with a repeat, and for how long.** Most return the
  original resource; Route 53 REFUSES a repeated `CallerReference`
  (`HostedZoneAlreadyExists`), so that provider recovers by looking the zone up
  by its caller reference and adopting it. EFS is both at once: a
  `CreateAccessPoint` `ClientToken` either replays, or is refused with
  `AccessPointAlreadyExists` (which names the surviving `AccessPointId`), so
  `EFSProvider.createOrAdoptAccessPoint` reads that access point back, confirms
  BOTH that its `ClientToken` is the one cdkd minted and that it belongs to the
  file system cdkd asked for, and adopts it. A stable token that turns every
  retry into a hard failure is only half a fix. Note EFS documents no
  retirement period for this token -- the "one minute" in the EFS User Guide's
  "Creation token and idempotency" section is about file-system CREATION
  tokens -- so do not write a provider whose correctness depends on that
  duration; see the DERIVATION note in `createAccessPoint`.
- **Wrap the rethrow when you decline to adopt.** `DeployEngine`'s replacement
  path classifies a failed create with `isNameCollisionError`, which tests the
  TOP-LEVEL message for `already exists` / `AlreadyExists` -- exactly what the
  raw AWS conflict carries. Rethrowing it bare makes the engine read a TOKEN
  collision as a physical-NAME collision, and under `--replace` fall back to
  delete-first: deleting the OLD resource and re-creating with the same
  still-unreleased token. Wrap it, keep the AWS error as `cause`.
- **Do not assume the SDK's auto-fill is a fix.** A field carrying Smithy's
  `idempotencyToken` trait is auto-populated when the caller omits it -- with a
  FRESH value per request, which is the per-attempt derivation the first rule
  forbids. Measured on `@aws-sdk/client-efs` 3.1018.0: two identical
  `CreateAccessPoint` sends went out with different UUIDs, and a
  caller-supplied value went out verbatim.

`EFSProvider`'s FILE SYSTEM `CreationToken` and `FSxFileSystemProvider`'s
`ClientRequestToken` deliberately do NOT use the helper: those APIs enforce token
uniqueness only among LIVE file systems, so a deterministic hash of the immutable
create inputs is right there (it also lets the new file system coexist with the
old one during a replacement). That reasoning is per-API, not per-provider --
the same `EFSProvider` DOES take the helper for `CreateAccessPoint`. That choice
does not rest on knowing how long the token lives, because the process-scoped
derivation is right under both readings: if the token retires quickly,
stability across runs buys nothing (no two deploys are that close together on
one create) while it would put a `--replace` delete-then-create inside the
replay window of the access point it just deleted; and if it instead binds for
the access point's lifetime, a deterministic hash is worse still, since any
re-create with unchanged inputs would collide with the live access point
instead of creating one.

Where the API has NO token member, the choice is between `disableOuterRetry`
(which makes the provider single-shot for EVERY transient error, IAM propagation
included) and a pre-create reconcile that detects the previous attempt's orphan.
Say in-code which you chose and what it costs.

**A reconcile is not simply "delete what appeared since my baseline" — write it
so the wrong answer LEAVES an orphan rather than destroying a live resource.**
"Newer than my snapshot" is equally true of the orphan your own attempt minted
and of a resource something else created in the same window: a sibling resource
in the same stack (the deploy engine dispatches at `--concurrency 10` by
default), a second `cdkd` process, or a human. Deleting the second kind is
strictly worse than the bug being fixed — it destroys something cdkd state still
advertises, and for a type whose `readCurrentState` returns `undefined` when the
resource is gone, `cdkd drift` reports UNKNOWN rather than drift, so the loss is
invisible. `IAMAccessKeyProvider` shows the shape:

- **Serialize per owning resource in-process.** A `Map<owner, Promise>` queue,
  with the baseline read, the create, and the reconcile all inside it, so no
  sibling create can interleave with them.
- **Reconcile from the FAILURE path of the attempt that took the baseline**,
  never from the top of the next attempt. A baseline that spans the whole retry
  schedule describes a window many seconds wide.
- **Require a creation timestamp at or after the attempt started**, with a small
  margin for clock skew between you and the service.
- **Keep a set of ids this process created successfully and never delete one.**
  This is the condition a baseline structurally cannot express, and it is the
  one that covers the case the in-process lock cannot: another process.
- **Report anything you decline to delete**, at `warn`, and do not claim an
  attribution the code did not establish.

### 2a. UPDATE removal semantics — clear-on-removal (issue #1155)

CloudFormation resets a property **removed** from the template to its
default. Most AWS `Update*` / `Modify*` APIs do the opposite: an **absent**
input field means "no change" (merge semantics). A provider `update()` that
maps template properties straight into the SDK input therefore silently
drops removals:

```typescript
// BROKEN for removal: properties['Timeout'] is undefined when the user
// deletes `timeout` from their template → the SDK omits the field → AWS
// keeps the old value, while CFn would reset it to the default.
Timeout: properties['Timeout'] as number | undefined,
```

The failure is invisible end-to-end: the diff layer correctly reports
`old → undefined`, the deploy reports `updated` + success, state drops the
field — so the very next `cdkd diff` says "No changes" while AWS still holds
the old value. Permanent, undetectable divergence from CloudFormation
(confirmed live for Lambda in issue #1155).

**Rule: every optional, mutable property passed to a merge-semantics update
API needs an explicit reset when it was present before and is absent now.**
The shared helper is `clearOnUpdateRemoval` in
`src/provisioning/update-removal.ts` (extracted in #1223 from the per-provider
copies that Lambda #1157 / ECS #1164 / RDS #1222 / ASG #1224 shipped):

```typescript
import { clearOnUpdateRemoval } from '../update-removal.js';

// clearOnUpdateRemoval(newValue, previousValue, clearValue):
//   present -> pass through; removed -> explicit reset; never set -> stay absent.
// Usage — the reset value is the property's CFn default or the
// SDK-documented clear sentinel:
Timeout: clearOnUpdateRemoval(newTimeout, prevTimeout, 3),
MemorySize: clearOnUpdateRemoval(newMem, prevMem, 128),
Environment: clearOnUpdateRemoval(newEnv, prevEnv, { Variables: {} }),
```

Checklist when writing or reviewing an `update()`:

- Classify the API: **merge** (absent = unchanged — most `Update*` /
  `Modify*` calls) vs **full-replace** (the whole config object is replaced,
  or removal is handled by a dedicated `Delete*` call, like the S3 bucket
  sub-config pattern). Only merge APIs need clear-on-removal — but a
  full-replace API has the MIRROR hazard instead, see §2b.
- For each optional mutable property: what does AWS need to receive to get
  back to the CFn default? Common shapes: the documented default scalar
  (`3`, `128`), an empty container (`{ Variables: {} }`, `[]`), an empty
  string (`''` for description/KMS-key fields), or a sentinel
  (`{ ApplyOn: 'None' }`, `{ Mode: 'PassThrough' }`).
- Never synthesize a reset for a field that was **never** set — that turns
  every unrelated update into a spurious (and sometimes invalid) write.
- **The reset SENTINEL can vary per API *and* per value KIND within one API,
  so verify it per key rather than picking one for the whole call** (issue
  [#1609](https://github.com/go-to-k/cdkd/issues/1609) item 1). ELBv2's three
  attribute APIs take an identical `{Key, Value}` list and disagree three
  ways: `ModifyTargetGroupAttributes` rejects an empty `Value` for EVERY key
  ("A target group attribute value must be specified"), while
  `ModifyLoadBalancerAttributes` / `ModifyListenerAttributes` accept `''` for
  numeric and free-form-string keys but reject it for BOOLEAN / ENUM ones
  ("The value of 'deletion_protection.enabled' must be 'true' or 'false', but
  was ''"). So a single provider needs a per-key resolver — a documented
  defaults table with a fallback — not one sentinel.
  Three things make this worth its own bullet. **The blast radius is the whole
  call, not the key**: these APIs validate the entire attribute list, so ONE
  removed boolean fails the deploy — and it can fail the automatic ROLLBACK
  too, leaving no template-side way out. (The rollback re-runs the same diff
  with the sides SWAPPED. That turns a removal of key K into an ADDITION of K,
  so it is not the same refusal mirrored — but any key the two template sides
  do not share becomes a removal in the other direction, which is exactly how
  the live run failed on a SECOND key the forward pass never touched.)
  **The previous side is not always a template**, which decides what a safe
  reset value even is: `cdkd drift --revert` hands the provider the
  `readCurrentState` snapshot as `previousProperties`, so an attribute AWS
  reports but the template never set can look REMOVED. Writing a documented
  default for each would silently reset a dozen live settings. Skip a key
  whose CURRENT value already equals the default — an untemplated key is by
  definition sitting at its default, while a genuinely templated one is not.
  Since issue [#1626](https://github.com/go-to-k/cdkd/issues/1626) the caller
  meets you halfway: when the reverted resource has NO `observedProperties`
  (the baseline is the raw template, so cdkd cannot tell AWS-authored from
  out-of-band), `runRevert` MERGES every untemplated path into the desired bag
  it hands you, so those keys arrive with their AWS-current values on BOTH
  sides and your diff sees no change. That covers the bulk case and the
  non-default residual the per-provider skip cannot — and, because it is on
  the desired side, it also covers a provider that replaces the bag wholesale
  and never reads `previousProperties`. It does NOT cover the observed-capture
  baseline, where an absence IS an intentional removal — so keep the skip.
  And **mocked unit tests cannot find any of it** — they agree with whatever
  sentinel the provider chose. The
  ELBv2 arms shipped with two tests literally named "AWS-documented clear" /
  "empty-string default" that pinned a payload real AWS rejects; only an integ
  whose removal phase actually drops the key surfaced it. If you add a
  clear-on-removal arm, add the removal phase to a fixture in the same change.
- **The CFn-reset premise itself is per-type — A/B it before writing the
  reset, because where CloudFormation does NOT reset, the reset is the bug.**
  Removing a Cognito UserPool `Policies` sub-key (`SignInPolicy` /
  `PasswordPolicy`, or the whole container) reaches UPDATE_COMPLETE in
  CloudFormation with every live value intact (measured us-east-1 2026-09-02,
  issue #1979) — CFn performs the same merge-semantics no-op the raw API
  does, so a cdkd-side reset would DIVERGE from template compatibility. The
  correct shape there is pass-through-nothing plus a WARN naming the sub-key
  and the explicit-declaration remedy (`warnOnUnremovablePoliciesSubKeys` in
  `cognito-provider.ts`): under both A/B answers the only wrong option is
  silence, because the user who deleted the sub-key believes a change (often
  a TIGHTENING) landed.
- Sub-structures can carry the same hazard one level down: an object that is
  present but missing its inner key (e.g. `Environment: {}` without
  `Variables`) may also read as "no change" — normalize it to the explicit
  clear shape (issue #1158; live-verified). Conversely some config objects
  are replaced wholesale (Lambda's `LoggingConfig`: sending
  `{LogFormat: 'Text'}` alone resets an unspecified custom `LogGroup` to the
  default — also live-verified), so verify per API, not by analogy.
  Lambda's `ImageConfig` is the same whole-replace shape (issue #1225, live
  A/B 2026-08-11): `UpdateFunctionConfiguration` with `{EntryPoint}` alone
  CLEARED the previously-set `Command` / `WorkingDirectory`, and dropping
  those two from a kept CFn `ImageConfig` block reached the same end state —
  so the provider passes the kept-partial block through verbatim and
  synthesizing per-sub-field clears there would DIVERGE from CloudFormation.
  Measure both halves: "does CFn reset it" and "what does the API do with a
  partial object" are two different questions, and only the second one tells
  you whether pass-through is already correct.
  **A MERGING sub-shape is not automatically a cdkd bug** — ECS
  `DeploymentConfiguration` is the counterexample, and it is the reason the
  question above must be asked as an A/B rather than answered from the API
  semantics alone (issue #1225, live A/B us-east-1 2026-08-13).
  `UpdateService` genuinely MERGES: a kept block carrying only
  `MaximumPercent` left `MinimumHealthyPercent` and the circuit breaker at
  their live values. That is exactly the silent-drop shape — and a
  CloudFormation stack given the same partial block reached the IDENTICAL
  end state on a real resource UPDATE, so the retained value is CFn's
  behavior too and normalizing it away would DIVERGE. (The END STATE is what
  was measured; that CFn's handler submits the same partial to
  `UpdateService` is the inference.) The same run settled the whole-block
  removal the #1160 audit had left open for this field: CFn issued a real
  UPDATE and did NOT reset the configuration, so passing `undefined` is
  right and adding a reset would have been the divergence.
  **One level DOWN the answer flips, and the flip is the part worth
  remembering.** A kept `DeploymentCircuitBreaker` missing `Rollback` has the
  nested struct REPLACED, not merged — the SDK ACCEPTS it and a live
  `rollback` went true -> false. CloudFormation refuses that template up
  front (`Model validation failed (... required key [Rollback] not found)`),
  because the registry schema marks the `DeploymentCircuitBreaker` definition
  required [Enable, Rollback] and `DeploymentAlarms` (the `Alarms` property)
  required [AlarmNames, Rollback, Enable]. **cdkd enforces no nested
  required-ness anywhere** — pre-flight covers top-level properties
  (`property-coverage.ts`) and property COMBINATIONS
  (`mutually-exclusive-properties.ts`), neither of which reads a definition's
  `required` list — so cdkd DEPLOYS a template CFn rejects and silently flips
  the live setting. That is an accepted divergence in the PERMISSIVE
  direction, tracked as issue #1802, NOT a parity row. Do not file it under
  the ASG `InstanceMaintenancePolicy` disposition: there AWS ITSELF rejected
  the partial, so cdkd failed loudly too and pass-through really was parity.
  The generalizable check is therefore two questions, not one — does the API
  merge or replace the nested struct, and does anything on cdkd's side refuse
  the shape the way CFn does?
  Answering the second question no longer needs a live `describe-type`: since
  issue #1800 each `tests/fixtures/cfn-schemas/*.json` carries a
  `definitionRequired` section (per definition, its `required` list; the
  top-level list under the reserved `#top` key), so a test can assert the
  actual lists a parity verdict rests on. Read a MISSING key as "nothing is
  required here" — a definition with no `required` list, or an empty one, gets
  no entry. Note the section's ABSENCE does not mean "not captured": seven
  types legitimately require nothing anywhere and carry no section at all, so
  use `generatedAt` (>= 2026-08-13) to tell a captured fixture from a stale
  one. Note also that only a definition's OWN top-level `required` array is
  captured — required-ness expressed through a `oneOf` combinator
  (`AWS::S3::Bucket`'s `TargetObjectKeyFormat`) or on an inline nested object
  (`AWS::WAFv2::WebACL`'s `FieldToMatch.SingleHeader`) is absent, so for those
  shapes a missing entry means UNKNOWN rather than "CFn requires nothing";
  measure against the live schema before concluding a parity verdict.
  That absence is itself load-bearing: `LinearConfiguration` and
  `CanaryConfiguration` carry no required list, so a kept-but-partial block
  there IS reachable from a template CFn accepts — which is issue #1806, and
  was expected to be strictly worse than #1802 precisely because there is no
  CFn-side refusal to point at. It MEASURED as parity instead; the next
  paragraph is that measurement, and it is a good example of why the
  reachability of a shape does not predict its verdict.

  **And REPLACE does not imply divergence — ask the second question before
  concluding one** (issue #1806, measured us-east-1 2026-08-13 on the same
  type, SDK and CloudFormation A/B per block). The three DEPTH-1
  `DeploymentConfiguration` blocks whose partials CFn ACCEPTS —
  `LinearConfiguration` and `CanaryConfiguration` (no `required` list at all)
  and `LifecycleHooks[]`, whose element requires only `LifecycleStages` (the
  partial measured there is one element's `TimeoutConfiguration`) — are what
  made this the worrying case. All three replace the nested
  struct exactly as `DeploymentCircuitBreaker` does, but the absent member is
  filled with an AWS-side DEFAULT (`StepBakeTimeInMinutes` -> 6,
  `CanaryBakeTimeInMinutes` -> 10, the hook's `Action` -> `ROLLBACK`) and
  CloudFormation handed the same partial template reached the IDENTICAL end
  state every time — so the verbatim pass-through is PARITY and re-filling the
  member from the previous side would be the divergence. What separates them
  from the #1802 row is only the second question: nothing refuses the shape,
  on either side. Two further findings generalize:
  - **A block reachable only under one MODE has to be probed in that mode, and
    the mode may not be the one the issue names.** These three are documented
    as blue/green machinery, but `LinearConfiguration` is gated on
    `Strategy: LINEAR` and `CanaryConfiguration` on `CANARY` — AWS answers a
    `BLUE_GREEN` service carrying one with `Linear configuration can only be
    present with LINEAR deployment strategy`, so the fixture the issue
    prescribed could not have reached them at all. `LifecycleHooks` is not
    strategy-gated that way (measured under `CANARY`; its reach under
    `ROLLING` was not probed).
  - **The default-fill is not phantom drift**, because the deploy engine
    captures `observedProperties` from `readCurrentState` and the AWS-filled
    value lands in the drift baseline. Check that before reaching for
    `effectiveProperties`: a value AWS computes belongs in `observedProperties`
    by this file's own rule, and the capture already puts it there. It holds
    only while the property stays drift-COMPARED, so fence it — declaring the
    property in `getDriftUnknownPaths` later would falsify the parity verdict
    with every send-side test still green.

  The rest of the tree splits TWO ways, plus the array shape below — so neither "the other blocks are
  refused" nor "the rest is parity" is the thing to carry away, and
  `DeploymentAlarms` keeps the permissive-divergence disposition above:
  - **AWS ITSELF REFUSES** (the ASG `InstanceMaintenancePolicy` disposition —
    cdkd fails loudly, no nested required-ness check involved): a hook element
    missing `LifecycleStages`; a hook element missing `TargetType` (absent
    DEFAULTS to `AWS_LAMBDA`, which then demands a target ARN and role a PAUSE
    hook does not carry, so dropping ONE member arms a requirement for TWO
    others); and `DeploymentCircuitBreaker.ThresholdConfiguration` missing
    `Value`.
  - **AWS RETAINS it and CLOUDFORMATION RESETS it** — the one DIVERGENCE the
    sweep found, and the opposite polarity to the permissive one above:
    `DeploymentCircuitBreaker`'s OPTIONAL children (`ResetOnHealthyTask`, and
    the whole `ThresholdConfiguration` block). Dropping them from an otherwise
    complete parent is a CFn-accepted partial that reaches AWS; from the
    identical baseline, with a sibling flipped in the same call so the update
    demonstrably applied, cdkd left `false` / `{COUNT, 7}` intact while
    CloudFormation reset them to `true` / `{BOUNDED_PERCENT, 50}`. So cdkd
    fails to apply a removal CFn applies — too STICKY rather than too
    permissive. Filed as issue #1861 and FIXED there: those two members — and
    only those two, and only while BOTH template sides still declare the
    `DeploymentCircuitBreaker` block — are routed through
    `clearOnUpdateRemoval` in `ECSProvider.resolveDeploymentConfiguration`, so
    a declared-then-dropped member is now sent as its AWS default. Everything
    else in the property still ships as the verbatim pass-through the parity
    rows measured.

  The `LifecycleHooks` ARRAY is replaced WHOLESALE, so a per-element drop is a
  non-issue. Three things generalize:
  - **Enumerate the tree from the registry definitions, not from the blocks
    the issue names.** #1806 named three; the live schema has more, and the two
    the issue never mentioned (`ThresholdConfiguration`, `ResetOnHealthyTask`)
    are the ones that produced new behavior.
  - **Check the CHILD's own `required` list before calling a nested partial
    reachable.** A satisfied PARENT requirement does not make the child's
    partial CFn-accepted: `ThresholdConfiguration` carries
    `required: [Type, Value]`, so CFn refuses it up front — the parity there
    comes from BOTH engines failing, not from agreeing on an end state. **What
    decides the verdict is whether AWS ACCEPTS, not whether CFn refuses**:
    `DeploymentCircuitBreaker` missing `Rollback` is refused by CFn and
    ACCEPTED by AWS, which is precisely why that row is the permissive
    divergence (#1802) and this one is not.
  - **Members of ONE block can carry DIFFERENT semantics.** In
    `DeploymentCircuitBreaker`, the required `Rollback` reads as replaced while
    the optional children are retained. Measure per member; do not generalize a
    row to its siblings.
  - **Where the API RETAINS an omitted optional member of a STILL-DECLARED
    struct, cdkd diverges from CloudFormation**, which treats the omission as a
    REMOVAL and resets the member to its default. Scope that sentence
    carefully, because two neighbouring shapes behave differently and both were
    measured: removing the WHOLE property resets nothing under either engine
    (the depth-0 row), and a member the template NEVER declared is left alone by
    CFn too — an out-of-band value survived a CFn update that changed an
    unrelated member — and it still survived when a SIBLING INSIDE the same
    block was flipped, which is what excludes the competing reading "CFn
    re-serializes a struct with defaults whenever its declared content
    changed". So this is a previous-present / current-absent REMOVAL, the
    semantic `clearOnUpdateRemoval` implements one level up, NOT a handler that
    materializes every default. Treat the member-vs-whole-property boundary as
    EMPIRICAL rather than derived: a top-level property is previous-present /
    current-absent too, and removing it resets nothing. The `LinearConfiguration` family is parity
    because the API ITSELF default-fills there, so both engines land in the same
    place. And the two behaviors are indistinguishable until you probe a member
    whose live value DIFFERS from its default — measuring from a live value that
    happens to EQUAL the default proves nothing, which is a mistake this
    measurement made once and had to redo. Capture the resource's identity on
    both sides too (a replacement trivially shows defaults, and reads as a
    reset).

  A note on HOW to probe, because it changes the answer: the AWS CLI refuses
  the `ThresholdConfiguration` partial CLIENT-side (botocore validates the
  required trait before sending), so it never reaches the service. The JS SDK
  cdkd uses declares the same member required in its TYPE (`value: number |
  undefined`, a non-optional key, unlike the optional `targetType?:`) but
  performs no runtime required check, so it serializes the partial and the
  refusal arrives from the SERVICE. The models agree; only where the validation
  runs differs — so probe through `@aws-sdk/client-*`, or a CLI probe reports
  the right verdict for the wrong reason, and reports the WRONG verdict
  entirely if the service would have accepted it.
- Unit-test **three** shapes: removed → exact reset value; never-present →
  stays absent; mixed kept/removed → kept fields pass through unchanged.
- A per-key removal test (one key dropped from a still-present map) does NOT
  cover whole-block removal (the map itself dropped) — test both.
- **Walk the DEPTH-1 members too, not just the top-level properties.** The
  removal audit above is normally run over a type's top-level properties, and
  a nested struct forwarded whole (a recursive case-flip, a spread, a raw
  cast) hides the same bug one level down: the API retains the omitted member
  while CloudFormation resets it. `ECSProvider.resolveDeploymentConfiguration`
  (issue #1861) is the worked example — reuse `clearOnUpdateRemoval` with the
  PREVIOUS side read raw, since only its PRESENCE is inspected. Two traps that
  both cost a round there: a member the template NEVER declared must stay
  absent (sending the default clobbers an out-of-band value CFn preserves),
  and the reset re-runs with the sides SWAPPED during a rollback replay
  (issue #1609), so key strictly on previous-present / current-absent rather
  than on "the two sides differ".
- **Not every removal is a VALUE on the same call.** `clearOnUpdateRemoval`
  fits a property that maps to an input FIELD, so a reset is "send the default
  instead of omitting". A property whose apply is a *separate API call* needs a
  different call on removal, and there is no reset value to pass — the
  `route53-provider.ts` pair (issue #1160) is both spellings: `HostedZoneTags`
  applies via `ChangeTagsForResource` and its removal is the `RemoveTagKeys`
  argument (a previous-minus-desired KEY DIFF, not a value), while
  `QueryLoggingConfig` applies via `CreateQueryLoggingConfig` and its removal
  is `DeleteQueryLoggingConfig` on a sub-resource. Both looked like no-ops
  precisely because the apply helper took only the DESIRED bag and had nothing
  to diff against; the fix is threading `previousProperties` into the helper,
  keeping it optional so `create()` keeps its existing REMOVAL behavior (it has
  no previous side, so nothing is ever removed — though a shape guard you add
  along the way does change what create accepts, so do not claim it is
  byte-identical). Gate the removal on the previous side actually having
  carried the thing, rather than probing AWS on every update — a config cdkd
  never created is drift, which `cdkd drift` owns, not a removal reset.
  Two things bite specifically in this shape, both found by review on the
  route53 batch after its first integ had already passed:
  - **A malformed value must not read as a removal.** The desired side reaches
    the helper through a tolerant reader, and anything the reader cannot use
    collapses to the same emptiness a real removal produces — so an unresolved
    intrinsic UNTAGS a live zone or DELETES a live config. Refuse a LOSSY read,
    not merely a wrong container: `[{ Key: { Ref: 'X' } }]` is genuinely an
    array, so a shape-only check lets the destructive case through one level
    down. Compare the parsed length against the raw length. And check what your
    own `readCurrentState` emits before calling a shape malformed — route53's
    emits `QueryLoggingConfig: {}` for "no live config", which `cdkd drift
    --revert` feeds straight back as the DESIRED side.
  - **A failed removal is not self-healing, so it must not be swallowed.** A
    failed ADD is retried by the next deploy because the template still declares
    it. A failed REMOVAL is not: the update returns success, state is rewritten
    WITHOUT the property, and the next deploy's previous side no longer carries
    it — so the value survives on AWS forever with `cdkd diff` clean, which is
    the #1160 failure mode the fix existed to close. Throw on the removal
    branch even when the surrounding helper is warn-and-continue.

### 2b. Full-replace update APIs erase AWS-AUTHORED values (issue #1461)

A **full-replace** update API needs no clear-on-removal (§2a) — omitting a key
IS the reset. Its hazard runs the other way: whatever the payload omits is
erased, including values **AWS itself wrote** and your template therefore has
no representation for. No template-side diff hints at the loss, and no unit
test can catch it, because the values only exist on the live resource.

The live case (`GlueProvider`, issue
[#1461](https://github.com/go-to-k/cdkd/issues/1461)): `UpdateTable` replaces
`TableInput` wholesale, so an Iceberg table's `Parameters.table_type` and
`Parameters.metadata_location` — written by Glue at create time — were erased
by a deploy that changed only `TableInput.Description`, silently degrading the
table to a plain external table while the deploy reported success.

When a full-replace update sends a general-purpose bag (a `Parameters` /
`Properties` / `Tags`-shaped map AWS can write into), read the live resource
first and merge those entries back. Key the merge on **"present in NEITHER
template side"**, using `previousProperties`:

| key in desired | key in previous | outcome                              |
| -------------- | --------------- | ------------------------------------ |
| yes            | (either)        | the user's value wins                |
| no             | yes             | the USER REMOVED it -> stays removed |
| no             | no              | AWS-authored -> preserved from live  |

Restoring anything merely absent from the DESIRED side would make
user-authored entries unremovable — the mirror image of the bug — and would
break `cdkd drift --revert`'s ability to clear a console-side addition (on an
observed-capture baseline that path passes the AWS-current snapshot as
`previousProperties`, so every live key lands in the previous column and
nothing is added back). On a resource with no `observedProperties` the same
path MERGES every untemplated live key into the DESIRED bag instead (issue
[#1626](https://github.com/go-to-k/cdkd/issues/1626)) — `previousProperties`
is still the full AWS-current snapshot — so an untemplated live
key arrives in BOTH columns at its AWS-current value, so this table's first
row keeps it — which is the intended outcome there, since the raw template
cannot distinguish an AWS-authored entry from a console-added one.

**State the price.** The merge cannot distinguish an AWS-written entry from a
console-written one — neither appears on either template side — so every
out-of-band addition to that bag becomes permanent, and invisible to
`cdkd drift` once the next deploy folds it into the state baseline. That is an
acceptable trade against silently destroying an AWS-authored value, but it is a
real semantic change: document it on the resource type, and give users the
removal path (delete it directly, or declare-then-undeclare it so it becomes a
normal user-authored removal).

**Close the TOCTOU window if the API lets you.** Reading a value and writing it
back is not atomic; a concurrent writer landing in between is silently undone
by your write-back. Check the update request for an optimistic-concurrency
member (Glue's `UpdateTableRequest.VersionId`; the `ConcurrentModificationException`
in a command's documented error list is the tell) and send the version you
read, so a concurrent change fails loudly instead. Send it on EVERY update
rather than only on the ones that write back live values: the read runs
immediately before the write, so the version is never stale unless somebody
else really wrote in between, and an update that merged nothing still ships a
wholesale replace that a concurrent write would lose. (Scoping it was tried on
Glue and was wrong twice over — it left the empty-live-read case unguarded,
and its premise that a pure template push carries a stale version was false.)
When the API has no such member, say so where users will read it rather than
leaving the exposure implicit.

**Prove the precondition, do not assume it.** An AWS field named like a version
token is not necessarily enforced — Glue documents `VersionId` only as "the
version ID at which to update the table contents". Pin the semantics with a
real-AWS probe that advances the version out of band and requires the stale
replay to be REFUSED (and refused with a concurrency error, not any error).
Without that, an ignored token makes the whole guard a placebo that reads as
protection in review.

Two placement rules go with it:

- **Fail closed on a read failure.** Only a definitive not-found may degrade
  to "no live values" (the update's own error is more actionable). Any other
  failure must throw, naming the required IAM action — silently skipping the
  merge reinstates the erasure the read exists to prevent. Wrap the original
  error as `cause` so a transient throttle stays retryable.
- **Throw OUTSIDE the update's `try`**, and order the read AFTER the
  pre-flight validation, so the typed error is not re-labelled by the catch
  wrapper and a refused update issues no extra API call. Move ONLY the read —
  leaving the payload-building code outside the `try` as well turns a
  malformed-template crash into a raw `TypeError` with no resource context.
- **Check that every `provider.update()` call site retries.** Adding a read to
  `update()` makes it newly sensitive to throttling. `deploy-engine.ts` and
  `drift.ts` wrap their calls in `withRetry`; `rollback-executor.ts` did not
  until issue #1461, so the new read would have failed a rollback op that
  previously issued no read at all — and the best-effort catch there counts
  that as a failure and moves on. A transient failure on a RECOVERY path is
  the worst place to introduce one. **A new `withRetry` must carry the two
  conventions the surrounding sites use**, or it trades one bug for another:
  honor `provider.disableOuterRetry` (`CustomResourceProvider` /
  `NestedStackProvider` set it AND implement `update()` — re-invoking a Custom
  Resource derives a fresh RequestId + pre-signed URL and strands the first
  response at an S3 key nobody polls), and thread `isInterrupted` /
  `onInterrupted` (a rollback polls interrupts only BETWEEN ops, so an
  un-threaded probe leaves Ctrl-C dead for the whole backoff schedule).

  **The second of those is now MECHANICALLY ENFORCED** (issue
  [#2053](https://github.com/go-to-k/cdkd/issues/2053), after a count found 11
  sites under `src/provisioning/providers/**` and the pair threaded at exactly
  one of them). `vp run audit:withretry-interrupt:check`
  (`scripts/check-withretry-interrupt.ts`, a CI step) fails on any `withRetry`
  under `src/provisioning/**` whose options object literal does not declare
  BOTH names. Half a pair is a defect too: without `onInterrupted`, `withRetry`
  throws a bare `Error('Interrupted')` that names no resource, and without
  `isInterrupted` the other half is never called. A conditional spread does not
  count — it reads as threading to a reviewer while being absent whenever its
  guard is falsy — and an options bag the checker cannot READ (an identifier, a
  spread) is reported rather than skipped, so inline it.

  **Do not hand-roll the watch.** There is exactly one:
  `startInterruptWatch` in `src/provisioning/interrupt-watch.ts`, and the critic
  above checks PROVENANCE, so a locally-built object with the right property
  names fails. Four module-local copies existed briefly and could not agree with
  each other, which is what made two of its properties wrong; all four are gone.
  Call it per WAIT, thread `watch.isInterrupted` / `watch.onInterrupted`, and
  `dispose()` in a `finally`.

  Four properties of that module, each load-bearing and each the fix for a
  concrete bug:

  - **Per WAIT, never on `this`.** Providers are registered as SINGLETONS
    serving concurrent resources, so provider-level state is some other
    resource's.
  - **`onInterrupted` returns an `InterruptedWaitError`**, not a bare `Error`.
    `deploy-engine.ts` decides whether to ROLL BACK by asking what the failure
    was, and its own `InterruptedError` is module-private, so a bare `Error` from
    a provider read as a genuine resource failure and rolled the whole stack back
    on Ctrl-C. Use `isInterruptedWaitError` to recognise one. It walks the
    `cause` chain — every provider catch re-wraps — with a `visited` set and NO
    depth ceiling, because the chain grows by one per nested-stack level and a
    ceiling sized against today's nesting silently reinstates the rollback bug.
  - **The latch is STICKY, and only a COMMAND clears it.** A wait STARTED after
    the signal begins is already interrupted. Clearing it when the last watch is
    disposed looks equivalent and is not: sequential waits always empty the live
    set between them, so a `GlobalTable` delete running the #1521 gate, then the
    index-busy loop, then the gone-wait left the two multi-minute waits after the
    gate DEAF. `forwardSigtermToSigint()` opens and closes the command scope. The
    process listener is likewise never removed BETWEEN waits — one torn down in
    that gap cannot record a signal landing in it.
  - **It arms only inside a command that OWNS interrupt handling**, signalled by
    that scope rather than by counting SIGINT listeners. Any listener disables
    Node's default terminate, so a command with none of its own (`cdkd drift
    --revert` reaches `provider.update`) must not gain one here. A listener
    COUNT is the wrong test and was the first cut: `drift` runs at concurrency
    4, and a concurrent CloudFront / ACM / Route53 wait installs a transient
    SIGINT listener, so a wait starting in that window armed the shared handler
    permanently.
  - **The handler force-quits when it is the LAST SIGINT listener.** A command
    scope is not the same as a live graceful path: `destroy.ts` registers no
    handler and `destroy-runner.ts` removes its own in a `finally`, so between
    two stacks of a multi-stack destroy the watch is alone — and merely latching
    there SWALLOWS the Ctrl-C, letting the next stack delete on. Alone, it does
    what Node would have done with no listener at all, plus a
    `cdkd force-unlock` hint it cannot verify but cannot afford to omit.

    **The corollary is a rule for any command holding a lock: release it BEFORE
    unregistering your SIGINT handler.** Unregister-first leaves a window where
    the command holds the lock with no handler of its own, and the force-quit
    turns a Ctrl-C there into a stranded lock for its full 30-minute TTL.
    `destroy-runner.ts` had it backwards in its main `finally` and correct in
    its strong-ref refusal path; both now read the same way, and
    `destroy-runner-lock-release-ordering.test.ts` pins it by observing which
    listeners are registered at the moment `releaseLock` is entered.
    `rollback.ts` had the same defect until
    [#2118](https://github.com/go-to-k/cdkd/issues/2118), whose fix adds one
    thing worth copying into any command you write: both unregistrations sit in
    a nested `finally`, because the `.catch()` on a release covers a rejection
    and not a synchronous throw. It is pinned by
    `rollback-lock-release-ordering.test.ts`, which measures the SIGINT and the
    SIGTERM listener sets SEPARATELY — a fix that reordered only the SIGINT half
    would leave `unforwardSigterm()` running before the release, and CI
    cancellation delivers SIGTERM, so that half strands the lock on its own.
    **What is NOT a rule is the order within the teardown pair**, and the first
    cut of that fix asserted it in four places before a review round measured
    it: the two calls are adjacent and synchronous, so no signal can be
    delivered between them, and `unforwardSigterm()` first does not empty the
    SIGINT set anyway because the command's own handler is still registered.
    Order them for readability; the requirement is release-before-unregister.
    `deploy-engine.ts` is now the only site that still unregisters first, and
    is safe only because `deploy.ts` holds a handler that outlives it — stated
    at that call site, because a surviving instance of a corrected anti-pattern
    has to explain itself.

    **And the corollary's own corollary: keeping the handler armed for longer
    moves the window a signal can arrive in, so re-check anything that READS the
    interrupt.** `destroy-runner.ts` assigns `result.interrupted` once, inside
    its `try` — so arming across the teardown made a first Ctrl-C there set
    `draining` after the only read, leaving the flag false and letting
    `destroy --all` delete the next stack. It re-syncs with
    `result.interrupted ||= draining` at the end of the `finally`. That is
    tactical: the real defect is that flag being the only channel, which is
    [#2117](https://github.com/go-to-k/cdkd/issues/2117).

  **An interrupt is not a failure — but it is not a reason to leave AWS state
  behind either.** Two shapes to check in any wait you add, and they pull in
  opposite directions:

  - A best-effort `catch` that swallows into a `warn` will blame AWS for a user
    abort and then carry on to the next write. `applyAutoScalingDiff` re-throws
    instead, which stops the burst.
  - A partial-create cleanup arm must STILL run its cleanup delete on an
    interrupt. "Ctrl-C must not delete what you just made" is the intuitive
    answer and it is wrong here, because `create()` is throwing: the physical id
    never reaches state, the rollback journal records `physicalId: undefined`,
    and the rollback executor classifies it `skip-failed-unknown`. Nothing holds
    the id, so the choice is *delete vs orphan forever* — and the orphan fails
    every later deploy on a name collision that neither rollback nor destroy can
    reach. Both the ELBv2 Listener and Cloud Map Service arms clean up, and each
    prints the physical id plus a manual delete command BEFORE attempting it, so
    a process killed mid-cleanup still leaves the user a handle.

  **An interrupt must also never be read as "already deleted".** Both delete
  paths decide a resource is already gone by SUBSTRING-matching the error
  message, and an interrupt's message embeds a name the user chose — so a
  logical id containing `NotFoundException` used to drop a live resource's state
  row. `destroy-runner.ts` and `deploy-engine.ts` both check
  `isInterruptedWaitError` ahead of that match; any new message-based classifier
  on a delete path needs the same guard.

  **A hand-rolled poll on the same path owes the same treatment**, and issue
  [#1952](https://github.com/go-to-k/cdkd/issues/1952) is why the rule is stated
  for the PATH rather than per call: interrupting one wait while the next one
  still sits out its cap buys nothing. What a poll DOES on the signal is its
  own call: throw when nothing has been accepted yet, stop waiting when the
  operation is already in AWS's hands (see `waitForReplicaGone` /
  `waitForTableGone` in `dynamodb-globaltable-provider.ts` for both answers on
  one path).

Only bags AWS actually writes into qualify. A purely user-authored bag
(Glue's `JobUpdate.DefaultArguments`, `ConnectionInput.ConnectionProperties`)
must NOT be merged — preserving a console-side addition there would break
`drift --revert`. Audit the sibling update APIs on the same provider when you
fix one; the divergence is per-bag, not per-provider.

### 3. Returning Attributes

Return attributes accessible via `Fn::GetAtt`:

```typescript
return {
  physicalId: bucketName,
  attributes: {
    Arn: `arn:aws:s3:::${bucketName}`,
    DomainName: `${bucketName}.s3.amazonaws.com`,
    RegionalDomainName: `${bucketName}.s3.${region}.amazonaws.com`,
  },
};
```

### 3a. `getAttribute()` for live `Fn::GetAtt` resolution

Beyond the initial create/update return value, providers should implement
`getAttribute(physicalId, resourceType, attributeName)` so that **live**
attribute reads succeed even when the value is no longer in cdkd state —
specifically the `cdkd orphan` per-resource flow, which fetches each
referenced attribute on demand to splice into sibling references.

Conventions:

- Return `undefined` for unknown attribute names. Do not throw.
- Treat `*NotFound` exceptions as `undefined` rather than re-throwing —
  the live fetch is best-effort, and `cdkd orphan` falls back to the
  cached `state.attributes` (and ultimately `--force`) when the live
  resolution comes back empty.
- Prefer derivation from `physicalId` when CFn returns derivable values
  (S3 Bucket DomainName/Arn, SNS Topic name from ARN tail, SQS QueueName
  from URL tail) so the call is free.

#### Known coverage gaps (deliberate)

The following CloudFormation `Fn::GetAtt` return values are documented but
not implemented in cdkd's `getAttribute()`. They require a separate AWS
API call beyond what cdkd already makes, are rarely referenced from CDK
code, or both. If a real-world stack hits one of these, file an issue —
the small additional call is reasonable to add.

| Resource | Unsupported attribute | Why deferred |
| --- | --- | --- |
| `AWS::SQS::Queue` | (none) | All three CFn return values are covered. |
| `AWS::S3::Bucket` | (none) | All five CFn return values are covered. |

### 3b. `readCurrentState()` for drift detection — always emit user-controllable top-level keys

`readCurrentState(physicalId, logicalId, resourceType, properties?, context?)` returns the AWS-current snapshot of a resource for `cdkd drift` and `cdkd state refresh-observed`. The drift comparator walks **state's top-level keys only** (intentionally — to avoid surfacing every `FunctionArn` / `RevisionId` / `LastModified` / etc. that AWS auto-attaches to every response). That design has one consequence the provider author MUST account for:

> **Any user-controllable top-level CFn property `update()` can mutate must be emitted with a placeholder when AWS returns the field as undefined / empty.**

If the provider omits the key on the empty path (e.g. `if (cfg.Environment?.Variables) result['Environment'] = ...`), then on a resource that was deployed WITHOUT that key in its template, `state.observedProperties` never carries the key — and the comparator's state-keys-only walk skips the field forever. A user adding the property in the AWS console after deploy is **silently invisible** to drift.

Use these placeholders consistently:

| Type | Placeholder | Example |
| --- | --- | --- |
| Array | `?? []` | `result['ManagedPolicyArns'] = arns;` (after building the list) |
| Map / object (when AWS returns the whole object as undefined) | `?? {}` | `result['Cors'] = cors;` (after building, even if `cors` ended up empty) |
| Optional string | `?? ''` | `result['Description'] = resp.Description ?? '';` |
| Boolean / numeric scalar | `?? <semantic-default>` | `Status: resp.Status ?? 'Suspended'`, `BlockPublicAcls: cfg?.BlockPublicAcls ?? false` |
| Tags map | `?? []` (already covered for Tags by PR #145) | `result['Tags'] = normalizeAwsTagsToCfn(...);` |

**When the guard is justified — keep it**:

- **Immutable on create** — `BucketName`, `Lambda Runtime` (when create-time-only), `IAM RoleName`. The field can't change at all; AWS returning undefined is a wire-layer artifact, not a "user could add this." Skip emit.
- **AWS-managed read-only** — `FunctionArn`, `RevisionId`, `CodeSha256`, timestamps. These are not in the CFn template; cdkd state never carries them. They should NOT be in `readCurrentState` output at all.
- **Write-only** — `Code: { S3Bucket, S3Key }`, `SecretString`, `LoginProfile.Password`. AWS does not return these on read. Declare via `getDriftUnknownPaths()` so the comparator skips the entire subtree (see "Known coverage gaps" below).

**Wire-layer filtering** — the drift comparator does NOT apply per-type denylists for SDK provider results (those are reserved for the CC-API fallback path). If your provider's SDK response includes AWS-managed fields you don't want to surface, do NOT assign them in the first place.

**Test convention** (mandatory for any provider with `readCurrentState`): every provider test file MUST have an `it('emits placeholders for every user-controllable top-level key on AWS minimum response')` block that:

1. Mocks the SDK to return the resource exists with **all optional fields undefined / empty** (just required fields like Name / ARN).
2. Calls `readCurrentState(physicalId, logicalId, resourceType)`.
3. Asserts `Object.keys(result).sort()` matches the **complete expected key list** for that resource type — not a subset.
4. Spot-checks the placeholder values for the most fragile keys (`?? ''` strings, `?? []` arrays, `?? {}` objects, `?? <semantic-default>` scalars).

Example template:

```typescript
it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
  mockSend.mockResolvedValueOnce({
    /* SDK response: required fields only, all optionals undefined */
  });
  const result = await provider.readCurrentState('phys-id', 'L', 'AWS::My::Type');
  expect(Object.keys(result ?? {}).sort()).toEqual(
    ['Key1', 'Key2', /* ... complete list ... */ ].sort()
  );
  expect(result?.Key1).toBe('');           // string placeholder
  expect(result?.Key2).toEqual([]);        // array placeholder
  expect(result?.Key3).toEqual({});        // object placeholder
});
```

See [tests/unit/provisioning/lambda-function-provider-readcurrentstate.test.ts](../tests/unit/provisioning/lambda-function-provider-readcurrentstate.test.ts) and [tests/unit/provisioning/cognito-provider-readcurrentstate.test.ts](../tests/unit/provisioning/cognito-provider-readcurrentstate.test.ts) for canonical examples.

This is the **structural defense** against the "provider author forgets to emit a key" regression class. Without it, the bug only surfaces when a user runs drift on a resource configured exactly the way the test missed (and PR review missed). The test makes silent regression mechanically impossible — a refactor that drops a placeholder fails the key-set assertion immediately.

**The `properties` argument is the DESIRED side, and gating an emission on it is a fix with a TRANSITION COST — do not reach for it alone** (issues [#1742](https://github.com/go-to-k/cdkd/issues/1742) / [#1760](https://github.com/go-to-k/cdkd/issues/1760)). Every caller passes the resource's state-recorded / template-resolved bag (`drift.ts`, the deploy engine's observed capture, `import.ts`, `state.ts`), so a provider CAN ask what the user actually declared, and the temptation is to use that to stop emitting an AWS-COMPUTED value the desired side can never carry.

**The half that is easy to miss:** `observedProperties` bags already in S3 were written by a binary that DID emit the member. The moment the new binary stops, the comparison is `baseline has it` vs `aws side undefined`, and the first `cdkd drift` after the upgrade reports a one-sided phantom on every such resource. It does not self-heal — the observed capture runs only on CREATE / UPDATE, and the auto-refresh skips a record that already has a capture — so the window is however long until the user's next deploy, which is exactly when they are running `drift` instead. Measured live on `AWS::DynamoDB::Table` (#1760).

So the emission gate needs a companion that removes the path from the COMPARISON too:

- For a TOP-LEVEL key, declare it in `getDriftUnknownPaths(resourceType, properties)` — per-resource via the #1602 seam, so it is ignored on BOTH sides when the template declares nothing and still compared when it does. That covers the transition and the steady state with one declaration.
- For a PER-ELEMENT key there is no such declaration: an ignore-path never crosses an array (see the divergence note below), and declaring the enclosing array instead switches drift off for the whole subtree. That case needs a BOTH-SIDES normalizer in the `drift-protocol-normalize.ts` mould, and a live test seeded with a STALE observed baseline — a fresh-deploy fixture takes both sides from the same readback and structurally cannot exercise the transition. `AWS::DynamoDB::GlobalTable`'s `GlobalSecondaryIndexes[].WarmThroughput` is exactly this shape, and is now the WORKED example rather than the open question: PR [#1859](https://github.com/go-to-k/cdkd/pull/1859) closed it through the `canonicalizeDriftProperties` seam (issue [#1784](https://github.com/go-to-k/cdkd/issues/1784)), which IS the both-sides normalizer this bullet asks for — the provider names the member in a closed `DRIFT_STRIPPED_INDEX_MEMBERS` table and strips it from each bag, so an already-written baseline and a post-fix readback converge on carrying no member at all. Copy the NORMALIZER half's shape — but note it is only half of what this bullet asks for: the live test seeded with a STALE observed baseline was NOT shipped with it and is still outstanding (issue [#1939](https://github.com/go-to-k/cdkd/issues/1939)), so #1859 is the worked answer for the mechanism and an open question for the proof. Take the two things that come with it as well: the emission change and the normalizer had to ship in ONE change (landing the readback half alone is precisely the stranding described above), and the accepted cost is that a DECLARED per-element value stops being reported entirely — the hook sees one bag with no desired-side reference, so it cannot express the declared-gate `getDriftUnknownPaths` gives you for a top-level key. The sibling `AWS::DynamoDB::Table` type has the same shape and has not adopted the seam yet (issue [#1812](https://github.com/go-to-k/cdkd/issues/1812)).

Contrast an ORDERING fix, which has no such asymmetry: `getDriftUnorderedPaths` canonicalizes both sides, so an existing baseline and the readback converge rather than diverge, and it can ship on its own.

#### `getDriftUnknownPaths()` for unreadable fields

When AWS does not return a field that cdkd state stores (write-only fields, or a CFn property whose round-trip back to the template shape isn't worth implementing yet), declare the path so the comparator skips it instead of firing guaranteed false-positive drift on every clean run:

```typescript
getDriftUnknownPaths(): string[] {
  return ['Code'];                              // Lambda::Function: pre-signed URL only
  // or ['SecretString', 'GenerateSecretString']
  // or ['RedshiftDestinationConfiguration.Password']  // Firehose: write-only, AWS never returns it
}
```

The comparator does exact-match + `entry + '.'` prefix-match — listing `'Policies'` skips `Policies`, `Policies.Foo`, `Policies[0].PolicyDocument`, etc. Pair this with a docstring explaining why the field is unreadable so a future PR can lift the gap.

**Scoping a path to a SUBSET of a type's resources.** Some fields are unreadable only for resources in a particular configuration, and declaring them unconditionally would switch drift detection off for the resources where AWS *does* return the value. The method therefore takes an optional second argument — the resource's state-recorded properties, which `cdkd drift` passes — so the answer can be per-resource:

```typescript
getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
  // AWS silently discards TlsConfig on a PUBLIC ApiGatewayV2 integration and
  // never returns it; on a VPC_LINK (private) one it does, so keep comparing.
  if (
    resourceType === 'AWS::ApiGatewayV2::Integration' &&
    properties !== undefined &&
    properties['ConnectionType'] !== 'VPC_LINK'
  ) {
    return ['TlsConfig'];
  }
  return [];
}
```

`DynamoDBTableProvider` is the other consumer, and the clearer illustration of the absent-bag rule below. It scopes on whether the template declares the property AT ALL rather than on a sibling's value — `WarmThroughput` is returned as unknown unless the desired bag declares it — and its predicate deliberately answers DECLARED for an absent or uninformative bag, so the path stays COMPARED:

```typescript
function declaresWarmThroughput(properties?: Record<string, unknown>): boolean {
  // A bag that was never populated is NOT evidence the template declared
  // nothing, so answer 'declared' and keep comparing. A wrong DROP here is
  // unrecoverable phantom drift; the residual is a loud revert failure.
  if (!desiredBagIsInformative(properties)) return true;
  return properties !== undefined && isSendableWarmThroughput(properties['WarmThroughput']);
}
```

It also shows what the seam is FOR beyond a configuration split (issues [#1760](https://github.com/go-to-k/cdkd/issues/1760) / [#1602](https://github.com/go-to-k/cdkd/issues/1602)): an AWS-computed value that an earlier binary froze into `observedProperties` would otherwise drift forever, and per-resource scoping is what retires those records without switching the key off for the type.

Two rules for this shape (issue [#1602](https://github.com/go-to-k/cdkd/issues/1602)):

- **Tolerate an absent bag.** Other callers may have no properties to pass, so fall back to the type-level answer rather than assuming a shape. Default to COMPARING when you cannot tell — hiding real drift is the worse failure, exactly as for `getDriftUnorderedPaths()` below.
- **Say so at write time.** A value AWS discards is still worth a `logger.warn` on create / update. Declaring the drift path only removes the false positive; without the warning the user never learns the field is inert. Warn, never throw — the update path can be a state-record replay (`rollback-executor.ts` / `drift --revert`), where a refusal would leave the resource un-revertable.

#### `getDriftUnorderedPaths()` for unordered sets (strings AND objects)

The drift comparator compares arrays **positionally**, and AWS does not guarantee element ordering across reads. The shared normalizer ([src/analyzer/drift-normalize.ts](../src/analyzer/drift-normalize.ts)) already auto-canonicalizes two shapes for every type — `{Key,...}[]` tag lists and arrays whose every element is an AWS resource id (`subnet-…`, `rtb-…`) or ARN — but **plain-string arrays and non-tag object arrays are deliberately left untouched**, because either can be order-significant.

When your `readCurrentState` emits such an array that is semantically an unordered SET, declare its path so the comparator sorts it on both sides:

```typescript
getDriftUnorderedPaths(resourceType: string): string[] {
  if (resourceType !== 'AWS::FSx::FileSystem') return [];
  return ['WindowsConfiguration.Aliases'];   // DNS alias names
}
```

Path matching uses the same shared `matchesPathPrefix` rule as `getDriftUnknownPaths()` (exact match, or entry followed by `.`). **A plain entry is a subtree declaration** — `'WindowsConfiguration.Aliases'` covers that path *and everything beneath it*.

**Append `[]` to declare the path ALONE** (issue [#1783](https://github.com/go-to-k/cdkd/issues/1783)). Because this walk descends into array elements (see the divergence note below), a subtree entry for an object list also claims every array nested *inside* its elements — and that is frequently wrong: `AWS::DynamoDB::Table.GlobalSecondaryIndexes` is an unordered set keyed by `IndexName`, but each element carries a `KeySchema` that is order-SIGNIFICANT (HASH before RANGE), so `'GlobalSecondaryIndexes'` would sort the per-index key schema too and **hide a real key change**. `'GlobalSecondaryIndexes[]'` sorts the list and stops there. The marker is understood by `getDriftUnknownPaths()` as well, so the two lists keep one spelling; a bare `'[]'` matches nothing.

Two element shapes are sorted, each only when the array is **homogeneous** in it: every element a plain string (sorted lexically), or every element a plain object (sorted by a key-order-independent canonical JSON — issue [#1620](https://github.com/go-to-k/cdkd/issues/1620)). Key order deliberately does not participate: AWS's readback order for an object's own keys is no more guaranteed than its order for the list, so sorting on a raw `JSON.stringify` would reintroduce the phantom drift the pass exists to remove. A MIXED array, and a nested array inside a declared path, are both left alone — so a mis-declared path can never reorder a heterogeneous or array-valued list.

`ElasticLoadBalancingV2::TargetGroup.Targets` is the object-array case. It also shows the two things a readback of an unordered set has to get right that no amount of sorting fixes.

**Transient lifecycle states.** `DescribeTargetHealth` keeps reporting a just-deregistered target as `draining` for minutes, so including one would freeze it into the deploy-time `observedProperties` snapshot and produce *permanent* phantom drift against every later read. The provider excludes exactly `draining` and includes every other state — `initial`, `unused`, `unhealthy`, `unavailable` are all REGISTERED targets, and health is not registration.

**Who owns the value.** A target group fronting an ECS service or an ASG declares no `Targets` at all: the sibling resource registers them and re-registers as it scales. Comparing that list would report drift on every scale event of an untouched stack, and `--revert` would deregister the tasks the service just placed (the [#1498](https://github.com/go-to-k/cdkd/issues/1498) class). So the provider keeps `Targets` in `getDriftUnknownPaths()` **per resource** — using the properties-bag argument described above — and only drops the entry when the template actually declares `Targets`. An explicit `Targets: []` counts as a declaration and stays compared. Reach for this scoping whenever a property can legitimately be authored by a *different* resource rather than by the template.

One semantic divergence from `getDriftUnknownPaths()`, required for this pass to work: the comparator compares arrays wholesale and never descends into elements, so an ignore-path can never cross an array. This normalizer *does* descend into array elements, giving each the parent's path. A path like `'Items.Aliases'` is therefore meaningful for `getDriftUnorderedPaths()` (it reaches an `Aliases` array inside each `Items` element) while being inert as an ignore-path. The divergence is strictly more permissive.

**Only declare a path AWS documents — or you can demonstrate — as order-insensitive.** The failure modes are not symmetric: an undeclared unordered set produces a *visible* false positive the user can see and correct, but declaring an order-*significant* list silently hides real drift, which is the worse failure for a drift tool. FSx's `SelfManagedActiveDirectoryConfiguration.DnsIps` is left undeclared for exactly this reason (DNS resolver lists are conventionally preference-ordered and AWS documents no set semantics), as is ElastiCache's `PreferredAvailabilityZones` (documented as positionally aligned to node index).

**Do NOT sort inside the reverse-mapper instead.** It looks like a one-liner, but it breaks the `properties` fallback baseline: `runDriftForStack` uses `observedProperties` as the baseline only when present and falls back to the template `properties` otherwise, so for a resource deployed before observed-capture the baseline would be the user's TEMPLATE order while the read side is sorted — manufacturing drift instead of removing it. The normalizer runs on both comparison sides, which is exactly the property needed.

#### `canonicalizeDriftProperties()` for a member INSIDE an array element

The two seams above are declared as PATHS, and a path can never cross an array: `calculateResourceDrift` compares arrays wholesale via `deepEqual` and never descends into elements, so `isIgnoredPath` is never asked about a member of one. The only suppression an ignore-path can express there is the WHOLE array — which for `GlobalSecondaryIndexes` means never detecting an out-of-band index add / remove / capacity change again, permanently, to remove a one-time report. That trade is not worth making.

`canonicalizeDriftProperties(resourceType, properties)` (issue [#1784](https://github.com/go-to-k/cdkd/issues/1784)) is the seam for exactly that shape. `cdkd drift` applies it to **both** comparison sides, last in the normalization chain, so a provider can strip the AWS-managed member from the baseline as well as from the readback — an old `observedProperties` record and a new readback then converge with no ignore-path and no lost detection:

```typescript
canonicalizeDriftProperties(
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const indexes = properties['GlobalSecondaryIndexes'];
  if (!Array.isArray(indexes)) return properties;   // identity when nothing applies
  return {
    ...properties,
    GlobalSecondaryIndexes: indexes.map(({ ItemCount, IndexArn, ...rest }) => rest),
  };
}
```

Four rules, each load-bearing:

- **There is deliberately no `side` parameter.** One-sided normalization is the mistake `src/analyzer/drift-normalize.ts`'s header already records — it manufactures drift on the `properties`-fallback baseline, where the baseline is the user's raw template. The same pure function must see both bags.
- **Pure, synchronous, no AWS calls, NON-mutating.** It runs inside the comparison, and `--revert` diffs against the raw, uncanonicalized AWS bag — mutating the input would corrupt it.
- **`--accept` persists your output.** It writes each reported change's `awsValue`, and those come from the canonicalized bags — so on a path that still drifts after canonicalization, `--accept` freezes the *stripped* shape into `observedProperties`. For the intended use (dropping a member the readback no longer reports) that is the right direction, but do not strip anything you would be unwilling to see removed from state.
- **Position in the chain matters.** The hook runs after the principal / `IpProtocol` passes and *before* the tag-list / id-array / unordered-path passes, which live inside `calculateResourceDrift`. That order is required: an element strip must precede the unordered sort, or the two sides' canonical sort keys are computed over different member sets and diverge.
- **Return the input by identity** when nothing applies, so an unaffected resource pays nothing.
- **Reach for it only for a per-array-element member.** A top-level key a readback stopped emitting is `getDriftUnknownPaths()`'s job; a difference that is only about ORDER is `getDriftUnorderedPaths()`'.

#### When there is NO observed baseline at all

The paragraph above describes the round-trip when `observedProperties` exists.
When it does NOT — a resource deployed before observed-capture shipped —
`--revert` falls back to the raw TEMPLATE as its desired side while the
previous side is still the AWS-current snapshot. Because the revert overlays a
drifted top-level subtree wholesale, every AWS-authored key inside that subtree
which the template does not declare is DROPPED (issue #1478). Glue
`Table.Parameters` is the discovered case — `table_type` / `metadata_location`
are written by AWS, not by the template, so a `--revert` de-Icebergs the table —
but the exposure is general to any resource where AWS writes into a bag the
template does not fully declare.

The chosen semantic is **warn and proceed**: `cdkd drift --revert` lists the
paths it will drop as part of the plan (before the confirmation prompt, and
under `--dry-run`) and then reverts. This is a `drift` concern, NOT a provider
one — the baseline choice affects every provider that implements
`readCurrentState`, so fixing it inside one provider would make that provider
diverge from its siblings. Nothing is required of a provider here; the note
exists so that reading only the round-trip paragraph above does not leave you
believing the desired side is always an observed snapshot.

#### Two failure modes when an always-emit placeholder round-trips through `update()`

`cdkd drift --revert` round-trips `observedProperties` (the snapshot `readCurrentState` produced) back through `provider.update`. That code path is what surfaces every shape-mismatch bug between the read side (`readCurrentState` output) and the write side (AWS create/update API input). Two failure classes have been observed; both must be designed around BEFORE adding a new `readCurrentState`.

**Class 1 — type-discriminator-dependent fields.** A field is only valid on AWS when a sibling discriminator says so. Examples: SQS `DeduplicationScope` / `FifoThroughputLimit` (FIFO-only — `FifoQueue=true`), SNS `FifoThroughputScope` (`FifoTopic=true`), AppSync DataSource shape (`DynamoDBConfig` / `LambdaConfig` / `HttpConfig` discriminated by `Type`). Emitting a `''` placeholder for these on a discriminator-false resource means `--revert` pushes it back and AWS rejects with "You can specify X only when Y is set to true". **Fix:** guard the emit on the sibling discriminator — only emit when the discriminator is true. Pattern documented in `feedback_always_emit_check_type_discriminator.md`. Drift detection is not lost: the discriminator-false state cannot legally have the field on AWS, so console-side ADD is impossible. When the discriminator is **N-way rather than boolean** — a set of mutually-exclusive `<Variant>Configuration` blocks selected by a type field, as in AppSync's `Type` or FSx `FileSystem`'s `FileSystemType` (`LustreConfiguration` / `WindowsConfiguration` / `OntapConfiguration` / `OpenZFSConfiguration`) — the same rule reads: emit EXACTLY the one block the discriminator selects, and emit it **unconditionally** (so the always-emit contract still holds for the one legal block, `{}` included), never the others. The §3b key-set test is then written once per discriminator value, each asserting its own block is present and the rest absent — see [tests/unit/provisioning/providers/fsx-filesystem-provider.test.ts](../tests/unit/provisioning/providers/fsx-filesystem-provider.test.ts).

**The "console-side ADD is impossible" clause holds ONLY when the discriminator is an INDEPENDENT sibling** (issue [#1565](https://github.com/go-to-k/cdkd/issues/1565)). Where the "discriminator" is really the field group's OWN presence — the group is all-or-nothing, and enabling it IS setting the fields — a console-side add is not merely possible, it is the whole drift you want to catch, and guarding the emit hides it FOREVER: the comparator's top-level walk is baseline-keys-only, so a key absent from the snapshot is never compared. `AWS::CloudTrail::Trail`'s `CloudWatchLogsLogGroupArn` / `CloudWatchLogsRoleArn` pair is that shape, and it was guarded on a rationale whose both halves later proved false: AWS was said to reject the `''` round-trip (the issue #1160 live probe accepts it and nulls the field out), and a console-side enable was said to surface as both fields appearing at once on the next read (it cannot — the walk never reaches an absent key). For this shape emit the group TOGETHER and UNCONDITIONALLY, with `''` placeholders, and keep the all-or-nothing invariant on the WRITE side instead — CloudTrail's update path decides both fields TOGETHER and forwards them on PRESENCE, so an explicit `''` CLEARS (which is what lets `drift --revert` undo a console-side enable) while an ABSENT pair is retained, and a half-populated or non-string shape is refused rather than coerced. Ask which one you have before guarding: *is there a sibling field whose value makes mine illegal (guard), or is my own presence the switch (always-emit)?*

**Class 2 — structurally-incomplete-when-empty fields.** An empty-object / empty-array placeholder is structurally invalid as AWS input because a sub-field is required. Example: SQS `RedrivePolicy: {}` rejects with "Redrive policy does not contain mandatory attribute: maxReceiveCount" because `deadLetterTargetArn` and `maxReceiveCount` are required. Other Class 2 candidates: Lambda `DeadLetterConfig` (TargetArn required), Lambda `VpcConfig` (SubnetIds + SecurityGroupIds required), EventBridge / SNS `DeadLetterConfig`, ECS `NetworkConfiguration` (awsvpcConfiguration.subnets required), various `LoggingConfiguration` shapes. **Fix:** keep the placeholder on the read side (drift detection requires it), and **sanitize at the wire layer in `create()` / `update()`** by translating the empty placeholder to whatever AWS accepts as "clear this field" — usually empty string. Canonical pattern in `serializeRedrivePolicy` ([src/provisioning/providers/sqs-queue-provider.ts](../src/provisioning/providers/sqs-queue-provider.ts)):

```typescript
function serializeRedrivePolicy(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0) {
    return '';  // AWS-documented way to clear RedrivePolicy
  }
  return JSON.stringify(value);
}
```

Pattern documented in `feedback_class2_placeholder_round_trip.md`.

#### `update()` must gate optional fields on `!== undefined`, not truthy

Truthy gates (`if (properties['X']) { ... }`) silently drop empty string `''`, numeric `0`, boolean `false`, and empty array `[]` (where the CFn type allows it). For `cdkd deploy` this is mostly invisible. For `cdkd drift --revert` it is a load-bearing bug: when state has no description but AWS does, the desired value to push back is `Description: ''`. A truthy gate drops it, the AWS update succeeds with no actual change, `--revert` reports `✓ reverted`, and the very next `cdkd drift` re-detects the same drift — silent fail mode. **Fix:** use `if (properties['X'] !== undefined)` so explicit-empty values reach AWS:

```typescript
// IAM Role example (PR #161 fix):
if (properties['Description'] !== undefined) {
  updateParams.Description = properties['Description'] as string;
}
```

Truthy gates are correct ONLY for fields where the value range excludes the falsy form (e.g. boolean flags where `false` means "use default", or `Path` where empty is invalid). Add a code comment when the truthy form is intentional. Pattern documented in `feedback_update_optional_field_undefined_check.md`.

#### Read-update round-trip test (mandatory for any provider with `readCurrentState`)

The above failure modes (Class 1, Class 2, truthy gate) all surface only on the `cdkd drift --revert` code path, which round-trips `observedProperties` (= a previous `readCurrentState` snapshot) back through `provider.update`. Document review and code grep cannot catch every instance — write a test that exercises the round-trip mechanically:

```typescript
it('round-trip: readCurrentState placeholders survive update() without AWS-invalid inputs', async () => {
  // 1. Mock SDK to return the AWS-minimum response (only required
  //    fields, optionals undefined). readCurrentState should emit
  //    every always-emit placeholder.
  mockSend.mockResolvedValueOnce({ /* minimum SDK shape */ });
  // ...

  const observed = await provider.readCurrentState(physicalId, 'L', RESOURCE_TYPE);
  // Spot-check the placeholders are present (this is the always-emit
  // contract, see "Test convention" earlier in this section).
  expect(observed?.RedrivePolicy).toEqual({});  // Class 2 placeholder
  // ...

  // 2. Reset mocks and set up update() expectations.
  vi.clearAllMocks();
  mockSend.mockResolvedValueOnce({});  // SDK update call
  // ...

  // 3. Round-trip: pass observed as both new (desired) and old (previous).
  //    No drift → update should be a logical no-op on AWS.
  await provider.update('L', physicalId, RESOURCE_TYPE, observed!, observed!);

  // 4. Assert: no SDK call sent a value AWS would reject.
  //    Per-provider — list the AWS-rejection-shaped values you know of:
  const setAttrsCall = mockSend.mock.calls.find(
    (c) => c[0] instanceof SetQueueAttributesCommand
  );
  if (setAttrsCall) {
    const attrs = setAttrsCall[0].input.Attributes;
    if (attrs.RedrivePolicy !== undefined) {
      // Class 2: '{}' would fail "Redrive policy does not contain
      // mandatory attribute: maxReceiveCount"
      expect(attrs.RedrivePolicy).not.toBe('{}');
    }
    // ... other per-provider rejection-shape checks
  }
});
```

The round-trip test catches all three classes mechanically:

- **Class 1** — discriminator-false placeholders that AWS rejects when shipped: assert the relevant `SetXxxAttributes` / `UpdateXxx` call does NOT include the discriminator-only attribute when the discriminator is false in the mock setup.
- **Class 2** — structurally-incomplete placeholders: assert the AWS API call does NOT contain the empty-object / empty-array shape AWS validates and rejects (e.g. `RedrivePolicy: '{}'`, `VpcConfig: {}`).
- **Truthy gate** — assert that empty-string / 0 / false placeholder values DO reach the relevant AWS API call (e.g. `UpdateRoleCommand` input must contain `Description: ''` when `observedProperties.Description === ''`).

See [tests/unit/provisioning/sqs-queue-provider-update.test.ts](../tests/unit/provisioning/sqs-queue-provider-update.test.ts) (Class 2 round-trip), [tests/unit/provisioning/iam-role-provider.test.ts](../tests/unit/provisioning/iam-role-provider.test.ts) (truthy-gate round-trip), and [tests/unit/provisioning/sns-topic-provider-roundtrip.test.ts](../tests/unit/provisioning/sns-topic-provider-roundtrip.test.ts) (Class 1 round-trip) for canonical examples.

### 3c. `handledProperties` ↔ CFn schema coverage check (issue #391)

Every SDK Provider declares a `handledProperties: Map<string, ReadonlySet<string>>` field naming the CFn template properties it knows how to wire to its AWS API calls. The provider registry's `getProviderFor` consults that set at routing time — a template carrying a property NOT in the set is auto-routed via Cloud Control API (which forwards the full property map to AWS, closing the silent-drop bug — see #614). `--allow-unsupported-properties Type:Prop` is the per-property opt-out that forces the SDK Provider path and accepts the silent drop.

That's a **runtime** safety net. It doesn't help during development. A provider author who simply forgets to list a property in `handledProperties` AND forgets to wire it in `create()` / `update()` ships a silent bug — exactly what PR #370 (ApiGateway::Method dropped 15+ fields) demonstrated.

The structural prevention layer lives at [tests/unit/provisioning/property-coverage.test.ts](../tests/unit/provisioning/property-coverage.test.ts). It cross-references every registered provider's `handledProperties` against the canonical CFn schema (snapshotted to [tests/fixtures/cfn-schemas/](../tests/fixtures/cfn-schemas/)) and fails when a schema property is unaccounted for.

#### The four "OK" buckets

For each schema property the test classifies it into one of four buckets (in priority order):

| Bucket | Where declared | When to use |
| --- | --- | --- |
| `handled` | `provider.handledProperties.get(type)` | The provider's `create()` / `update()` actually wires the property to the SDK call. |
| `by-design` | `provider.unhandledByDesign.get(type)` (with rationale string) | The provider INTENTIONALLY does not wire it — separate code path, deprecated, immutable post-create, AWS API doesn't accept it, etc. |
| `backfill` | [tests/fixtures/cfn-schemas/_todo-backfill.json](../tests/fixtures/cfn-schemas/_todo-backfill.json) under `types[<type>]` | Auto-generated catch-all for incremental rollout. Each entry MUST be migrated to `handled` or `by-design` eventually. |
| `read-only` | `readOnlyProperties` in the schema fixture | AWS computes the value; cdkd cannot wire it on Create/Update by definition (e.g. `Arn`). Automatically excluded. |

A property in NONE of the above → test fails with the offending type + property list + the three actions you can take.

#### Adding `unhandledByDesign` to a provider

A clean example is `AWS::ApiGatewayV2::Api`'s OpenAPI-import fields (`Body` / `BodyS3Location` / `FailOnWarnings` / `DisableSchemaValidation` / `BasePath`): they trigger an entirely separate `ImportApi` AWS API, not `CreateApi`. Listing them in `handledProperties` would be a lie; listing them in `unhandledByDesign` documents the deliberate skip:

```typescript
unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
  [
    'AWS::ApiGatewayV2::Api',
    new Map([
      ['Body', 'OpenAPI/Swagger inline spec; routed through ImportApi, not the field-by-field CreateApi path.'],
      ['BodyS3Location', 'OpenAPI/Swagger spec on S3; routed through ImportApi, not the field-by-field CreateApi path.'],
      // ...
    ]),
  ],
]);
```

Wired into the provider class:

```typescript
export class ApiGatewayV2Provider implements ResourceProvider {
  handledProperties = new Map<string, ReadonlySet<string>>([...]);
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([...]);
  // ... rest of provider
}
```

Rationales are free text but should be greppable. Common shapes:

- `"create-only — AWS rejects on update"`
- `"AWS-managed read-only attribute"` (when not already in `readOnlyProperties`)
- `"deprecated — superseded by Y"`
- `"tags handled via per-resource Tag API, not the create input"`
- `"covered by separate AWS::Foo::Bar resource type"`
- `"OpenAPI-import-only flag; meaningful only on the ImportApi code path"`

**NON_PROVISIONABLE types: set `disableCcApiFallback`.** A template property
in neither `handledProperties` nor the allow set normally auto-routes the
resource through Cloud Control (issue #614). If your provider covers a
`ProvisioningType: NON_PROVISIONABLE` type (the reason SDK providers exist
for e.g. `AWS::FSx::FileSystem` / `AWS::DLM::LifecyclePolicy`), that route
target does not exist — Cloud Control has no handlers — and the runtime
Tier 3 set cannot catch it (it excludes SDK-covered types by design, so
`isNonProvisionable()` returns false once your provider is registered).
Declare `readonly disableCcApiFallback = true;` on the provider class: the
`ProviderRegistry` then rejects such templates pre-flight with a clear
error (property rationale + `--allow-unsupported-properties` escape hatch)
instead of failing at provisioning time with an opaque
`UnsupportedActionException`. This only matters when the type has (or may
gain) `unhandledByDesign` / not-yet-handled properties — a fully-handled
type never triggers the auto-route — but declaring it is cheap insurance
against a future schema addition.

#### Workflow when adding a new provider

1. Add the provider as usual ([§3 Provider Implementation Examples](#provider-implementation-examples)).
2. Register the new resource type in `src/provisioning/register-providers.ts`.
3. Refresh the CFn schema fixture:
   ```bash
   node scripts/refresh-cfn-schemas.mjs --only-missing
   ```
   This fetches only the newly-registered type via `cloudformation:DescribeType` and writes `tests/fixtures/cfn-schemas/<sanitized-type>.json`. Requires AWS credentials with `cloudformation:DescribeType` permission.
4. Run `vp test run property-coverage` — it will fail listing the schema properties your provider has not yet accounted for.
5. For each unaccounted property, EITHER:
   - Add it to `handledProperties` (if `create()` / `update()` already wires it), OR
   - Add it to `unhandledByDesign` with a one-line rationale.
6. Re-run the test — green.

If you really need to ship before classifying every property, you can regenerate the backfill TODO:

```bash
CDKD_GENERATE_BACKFILL=true vp test run property-coverage
```

This dumps every unaccounted property per type into `tests/fixtures/cfn-schemas/_todo-backfill.json` so the test passes. The intent is short-lived — a follow-up PR must migrate the backfill entries to `handled` or `by-design`.

#### Workflow when AWS publishes new properties

AWS adds properties to existing resource types fairly regularly. Surface them on schedule:

1. Periodically (manually) run `node scripts/refresh-cfn-schemas.mjs` to refresh ALL fixtures.
2. `git diff tests/fixtures/cfn-schemas/` shows the new properties added by AWS.
3. The next `vp test run property-coverage` run will fail naming the newly-unaccounted properties.
4. Triage each: wire it through, mark `unhandledByDesign`, or backfill (with follow-up).

The script is **not automated** today. The `cloudformation:DescribeType` API is throttled per-account, and committing a recurring CI cron would require credentials. For now this stays an on-demand operator step; see the issue thread for the open design question on CI automation.

#### "Bogus" entries and the tolerance list

A property in `handledProperties` (or `unhandledByDesign`) that is NOT in the CFn schema is a "bogus" entry — most often an SDK input field name that diverges from the CFn property name (e.g. SDK `DefaultCooldown` vs CFn `Cooldown` on `AutoScalingGroup`), a typo (`PlacementStrategy` vs `PlacementStrategies` on `ECS::Service`), or a stale alias from before AWS renamed the property.

The test reports these — but fixing each requires per-provider investigation that often touches the safety-net's runtime behavior. As a stopgap, the tolerance list at `tests/fixtures/cfn-schemas/_todo-backfill.json` under `bogusTolerated[<type>][<prop>]` accepts a one-line rationale per entry, the test stays green, and follow-up PRs investigate one at a time. Day-1 of issue #391 the test surfaced 10 such entries — see the rationale strings in that file for the canonical examples.

### 4. Logging

- `info`: Successful operations
- `debug`: Detailed information
- `warn`: Non-fatal errors
- `error`: Fatal errors

```typescript
this.logger.info(`Creating ${resourceType} ${logicalId}`);
this.logger.debug(`Using properties:`, properties);
this.logger.warn(`Old resource deletion failed: ${String(error)}`);
this.logger.error(`Failed to create ${logicalId}:`, error);
```

### 5. Resource Name Constraints

AWS services have length and character constraints on names:

```typescript
// IAM Role example (64 character limit)
private shortenRoleName(roleName: string): string {
  const MAX_LENGTH = 64;

  if (roleName.length <= MAX_LENGTH) {
    return roleName;
  }

  const hash = Buffer.from(roleName)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 8);

  const maxPrefixLength = MAX_LENGTH - hash.length - 1;
  const prefix = roleName.substring(0, maxPrefixLength);

  return `${prefix}-${hash}`;
}
```

## Custom Resource Provider

Support for Lambda-backed custom resources (`Custom::*`):

See `src/provisioning/providers/custom-resource-provider.ts` for details.

**Key Points**:

- Invoke Lambda with same request format as CloudFormation
- Get `PhysicalResourceId` from response
- Return `Data` field as attributes

```typescript
const payload = {
  RequestType: 'Create',  // or 'Update', 'Delete'
  ServiceToken: properties['ServiceToken'],
  ResourceType: resourceType,
  LogicalResourceId: logicalId,
  ResourceProperties: properties,
};

const response = await lambdaClient.send(
  new InvokeCommand({
    FunctionName: serviceLambdaArn,
    Payload: JSON.stringify(payload),
  })
);

const result = JSON.parse(responsePayload);

return {
  physicalId: result.PhysicalResourceId,
  attributes: result.Data || {},
};
```

## Troubleshooting

### Provider is Not Being Called

**Cause**: Not registered in Registry (falling back to Cloud Control API)

**Check**:

```typescript
const provider = registry.getProvider('AWS::Xxx::Resource');
console.log(provider.constructor.name);  // → "CloudControlProvider" if SDK Provider not registered
```

### Attributes Not Resolved

**Cause**: Not returning attributes in `create()` / `update()`

**Fix**:

```typescript
return {
  physicalId: xxx,
  attributes: {
    Arn: 'arn:aws:...',
    // ...
  },
};
```

### Error on Update

**Cause**: Trying to change property requiring replacement in `update()`

**Fix**: Detect in `checkReplacementRequired()` and replace with `create()` + `delete()`

## References

- [architecture.md](./architecture.md) - Overall architecture
- [AWS Cloud Control API Supported Resources](https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html)
- [CloudFormation Resource Reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)

## Future Extensions

### Provider Plugin System

Future consideration for adding Providers as external plugins:

```bash
# Install plugin
npm install cdkd-provider-custom-service

# Enable in configuration
# cdkd.config.json
{
  "providers": [
    "cdkd-provider-custom-service"
  ]
}
```

### Import Terraform Providers

Bridge Terraform Providers to cdkd Providers:

```typescript
import { TerraformProviderBridge } from 'cdkd-terraform-bridge';

const awsProvider = new TerraformProviderBridge('hashicorp/aws');
registry.register('AWS::CustomService::Resource', awsProvider);
```
