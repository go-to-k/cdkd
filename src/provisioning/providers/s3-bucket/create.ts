/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  ABAC_DISABLED,
  ABAC_ENABLED,
  abacStatusOf,
  bucketNameRefusal,
  metadataBag,
  metadataConfigurationRefusal,
} from './metadata.js';
import type { AmbiguousCreateWindow } from '../ambiguous-create.js';
import {
  type BucketLocationConstraint,
  type BucketNamespace,
  CreateBucketCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import {
  type BucketRegionProbe,
  createBucketLatch,
  holdCreateBucketWindow,
  isCreateTagResourceDenial,
  isCreateTagsShapeRefusal,
  takeCreateBucketWindow,
  takeOwnLeftoverBucket,
  untaggedExplicitDeny,
} from './create-identity.js';
import { type CfnTagEntry, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { S3BucketProvider } from '../s3-bucket-provider.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { createMaskedLogSinks, withDerivedNameMasks } from '../../masked-retry-logger.js';
import { declaresBucketObjectLock, manualBucketDeletionClause } from './shared.js';
import {
  describeAwsFailure,
  verbosePointerSentence,
  verbosePointerTail,
} from '../../../utils/aws-failure-text.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import {
  explicitDenyPolicyKind,
  isExplicitDenyError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';

/**
 * Create an S3 bucket
 */
export async function create(
  this: S3BucketProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink set per operation. The body runs on a
  // per-call view (see `maskedView`) whose logger masks every line, so it is
  // re-entered there first; `this` below is that view. A `BucketName` read off
  // the bag is used VERBATIM (never rewritten the way `generateResourceName`
  // rewrites a logical id), so the base masker already recognises it.
  if (this.opMask === undefined) {
    const sinks = createMaskedLogSinks(this.logger, context?.maskSecrets);
    // A prefix is NOT used verbatim: the name only contains it, and a secret
    // too short for the masker's substring floor would print.
    const prefix = properties['BucketNamePrefix'];
    const derivedName =
      typeof prefix === 'string' && prefix !== '' && bucketNameRefusal(properties) === undefined
        ? await this.accountRegionalBucketName(prefix)
        : undefined;
    const view = withDerivedNameMasks(this.logger, sinks, [[prefix, derivedName]]);
    return this.maskedView(view).create(logicalId, resourceType, properties, context);
  }
  this.logger.debug(`Creating S3 bucket ${displaySafe(logicalId)}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const nameRefusal = bucketNameRefusal(properties);
  if (nameRefusal !== undefined) {
    if (context?.replayingState !== true) {
      throw markNonRetryable(
        new ProvisioningError(
          `S3 bucket ${displaySafe(logicalId)} ${nameRefusal}; fix the template`,
          resourceType,
          logicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`S3 bucket ${displaySafe(logicalId)} ${nameRefusal}; restoring it anyway`
    );
  }
  const metadataRefusal = metadataConfigurationRefusal(properties['MetadataConfiguration']);
  if (metadataRefusal !== undefined && context?.replayingState !== true) {
    throw markNonRetryable(
      new ProvisioningError(
        `S3 bucket ${displaySafe(logicalId)}: ${metadataRefusal}; fix the template`,
        resourceType,
        logicalId
      )
    );
  }

  // go-to-k/cdkd#4684: the same truthiness as the `||` below, so "explicit"
  // means exactly "the name sent is the template's, not a generated one".
  // A `BucketNamePrefix` is that too: CloudFormation sends exactly
  // `<prefix>-<account>-<region>-an` (measured 2026-11-01), which any run
  // over the same template repeats.
  const declaredPrefix = properties['BucketNamePrefix'];
  const namePrefix = typeof declaredPrefix === 'string' ? declaredPrefix : undefined;
  const explicitBucketName = Boolean(properties['BucketName'] || namePrefix);
  const prefixedName = namePrefix ? await this.accountRegionalBucketName(namePrefix) : undefined;
  const bucketName =
    prefixedName ||
    (properties['BucketName'] as string | undefined) ||
    (this.generatedCreateName(resourceType, logicalId, properties) as string);
  // go-to-k/cdkd#4583: true while a bucket THIS call created (`createdNewBucket`)
  // exists with no state record; cleared once the cleanup below deletes it.
  let bucketLeftBehind = false;
  // Issue #4639: the window this attempt took, and whether `CreateBucket`
  // (the oracle) answered on it. An attempt that ends without that answer
  // holds the window for the engine's next attempt (`holdCreateBucketWindow`).
  let ambiguousWindow: AmbiguousCreateWindow | undefined;
  let windowSpent = false;

  try {
    // CreateBucket params
    const createParams: {
      Bucket: string;
      CreateBucketConfiguration?: {
        LocationConstraint?: BucketLocationConstraint;
        Tags?: CfnTagEntry[];
      };
      ObjectLockEnabledForBucket?: boolean;
      BucketNamespace?: BucketNamespace;
    } = {
      Bucket: bucketName,
      ...(properties['BucketNamespace'] !== undefined
        ? { BucketNamespace: properties['BucketNamespace'] as BucketNamespace }
        : {}),
    };

    // Add LocationConstraint for non-us-east-1 regions.
    //
    // BOTH sides are canonicalized, and each closes its own half of issue
    // [#2282](https://github.com/go-to-k/cdkd/issues/2282). With a bare `!==`
    // over the value `getRegion()` returns, a mis-cased region took this
    // branch and sent `LocationConstraint: 'US-EAST-1'` for the one region
    // where the field must be OMITTED, and sent `LocationConstraint:
    // 'EU-WEST-1'` for every other region. Neither is a valid region NAME, so
    // S3 rejects the `CreateBucket` outright and the deploy dies here, before
    // anything else on this path runs. The issue framed only the us-east-1
    // GATE; the SEND side carried the same defect everywhere else and is fixed
    // in the same line, because one sentence describes both -- compare and
    // send the CANONICAL region, never the raw one.
    //
    // WHERE THE RAW SPELLING COMES FROM, measured rather than assumed.
    // This comment states MEASURED facts and does NOT claim to enumerate every
    // reachable door -- two earlier revisions each named one and were each
    // wrong, so the correct shape here is an invariant plus evidence, not a
    // population. The invariant the code relies on: `getRegion()` returns
    // whatever `s3Client.config.region()` holds, that value is NOT guaranteed
    // canonical, and this gate must therefore not depend on its spelling.
    //
    // Measured:
    //  - the SDK does hand back a raw spelling for a region-LESS bag: a
    //    profile holding `region = US-EAST-1` gives
    //    `config.region() === 'US-EAST-1'`.
    //  - `AWS_DEFAULT_REGION` is not a door at all -- the JS SDK v3 region
    //    chain does not read it, and neither does `namedCliRegion`.
    //  - the two CLI paths traced to `create()` are CLOSED, contrary to an
    //    earlier revision of this comment: `deploy.ts` replaces the initial
    //    bag with `new AwsClients({ region: stackRegion })` before
    //    `registerAllProviders` runs, and `stackRegion` resolves through
    //    `resolveEffectiveRegion` (go-to-k/cdkd#2100), which always returns
    //    a canonical region, so `region` is always DEFINED and `AwsClients`'
    //    conditional fold always fires. `rollback.ts` has
    //    the same shape.
    //  - the door verified OPEN is a LIBRARY caller constructing `AwsClients`
    //    with no region at all. `import.ts` builds its bag with
    //    `region: effectiveRegion.region` (and a second bag for the stack's
    //    region when that differs), so it is closed the same way.
    //
    // The `as BucketLocationConstraint` cast STAYS, and issue
    // [#2322](https://github.com/go-to-k/cdkd/issues/2322) settled that
    // deliberately rather than leaving it unexamined. It is a widening of a
    // STALE SDK enum, not a claim of membership: `canonicalizeRegion` only
    // lower-cases (`src/utils/aws-partition.ts:105`), so nothing on this path
    // checks membership -- and nothing should: a membership FILTER is exactly
    // the regression this note ends by naming.
    //
    // THE SIZE OF THE GAP IS NOT STABLE, AND THIS NOTE HAS BEEN WRONG ABOUT
    // IT TWICE, in two different ways. One revision named FOUR absent
    // regions, which was never right -- a spot-check written as an
    // enumeration. The cross-check that replaced it said THIRTEEN, five of
    // them commercial, which WAS right when written and is not now: the SDK
    // enum GREW under it. Treat any count below as a dated measurement and
    // re-derive, because both tables move:
    //
    //   node --input-type=module -e "
    //   import { BucketLocationConstraint } from '@aws-sdk/client-s3';
    //   import { RegionInfo } from 'aws-cdk-lib/region-info';
    //   const m = new Set(Object.values(BucketLocationConstraint));
    //   console.log(RegionInfo.regions.map(r => r.name).filter(r => !m.has(r)).sort().join('\n'));"
    //
    // Measured 2026-09-09 against this repo's `@aws-sdk/client-s3` 3.1126.0
    // (38 enum members) and `aws-cdk-lib` 2.268.0 (46 regions): EIGHT absent
    // regions, plus `us-east-1` which is absent by design. NONE of the eight
    // is commercial -- `eusc-de-east-1` is `aws-eusc`, its own partition, and
    // the seven `aws-iso*` ones (which share four partitions between them,
    // not one each) are `eu-isoe-west-1`, `us-iso-east-1`, `us-iso-west-1`,
    // `us-isob-east-1`, `us-isob-west-1`, `us-isof-east-1`,
    // `us-isof-south-1`. The five the previous revision called COMMERCIAL --
    // `ap-east-2`, `ap-southeast-6`, `ap-southeast-7`, `ca-west-1`,
    // `mx-central-1` -- all became enum members between 3.1018.0 and 3.1126.0.
    //
    // NOTHING BELOW DEPENDS ON THAT COUNT, which is why the drift was a
    // documentation defect here and not a bug. (It WAS a live defect in the
    // three sibling fences, which each pinned `ca-west-1` for its absence and
    // went inert when it became a member -- see
    // `tests/unit/_enum-absent-region.ts`.) What is MEASURED is the type
    // claim: this cast sends whichever region `getRegion()` reports, member
    // or not, and no membership test exists on the path. Whether S3
    // ACCEPTS each one was not probed region by region -- no deploy was made
    // to any of them -- so nothing here asserts that. The code cannot tell
    // them apart in any case: the gate below is a single `!== 'us-east-1'`
    // with NO partition branch, so every region traverses byte-identical
    // lines.
    //
    // WHY THE CAST IS NOT DROPPED -- both alternatives measured, not assumed:
    //  - the SDK has NOT widened the field. `CreateBucketConfiguration`
    //    (`@aws-sdk/client-s3` `dist-types/models/models_0.d.ts:1764`) still
    //    declares `LocationConstraint?: BucketLocationConstraint | undefined`.
    //  - declaring this bag's `LocationConstraint` as `string` and deleting
    //    the `as` does NOT compile. `tsc` then fails at the
    //    `new CreateBucketCommand(createParams)` call below with TS2769,
    //    "Type 'string' is not assignable to type 'BucketLocationConstraint |
    //    undefined'". The assertion does not disappear; it MOVES to the send
    //    site and widens from this one FIELD to the whole parameter bag,
    //    which is strictly worse.
    //
    // So the assertion is kept where it is narrowest, and its risk is fenced
    // by TESTS rather than by more prose. The direction that needs fencing is
    // not deletion of the cast -- that fails to compile, as above. It is a
    // future "soundness fix" that filters the region to enum members: that
    // COMPILES, leaves every `us-east-1` / `eu-west-1` case green, and
    // silently omits `CreateBucketConfiguration` for every region the enum
    // does not list -- which BREAKS THE DEPLOY in each of them, loudly.
    //
    // `this.s3Client` is REGION-BOUND (`constructor`: `awsClients.s3`; and
    // `getRegion()` reads `this.s3Client.config.region()`), so a `ca-west-1`
    // create is issued against the `ca-west-1` REGIONAL endpoint, where an
    // omitted `LocationConstraint` answers `IllegalLocationConstraintException`
    // rather than succeeding. `src/assets/asset-storage/ensure.ts:221` already
    // states the same rule for the sibling call site ("For regions other than
    // us-east-1, LocationConstraint is required"), and
    // `.claude/rules/asset-bucket-region.md` names the exception.
    //
    // THE RESIDENCY READING IS FALSE, and it is recorded here because it is
    // the natural guess and an earlier revision of this note asserted it. It
    // said an omitted constraint would quietly place the bucket in
    // `us-east-1`. That default belongs to the GLOBAL `s3.amazonaws.com`
    // endpoint -- the SDK documents it on `CreateBucketCommand` itself ("If
    // you send your CreateBucket request to the s3.amazonaws.com global
    // endpoint, the request goes to the us-east-1 Region") -- and this path
    // never uses that endpoint. Measured: a genuinely region-less client
    // THROWS rather than resolving empty (`new S3Client({}).config.region()`
    // with `AWS_REGION` / `AWS_DEFAULT_REGION` / `AWS_PROFILE` unset and both
    // config files pointed at `/dev/null` gives `Error: Region is missing`),
    // so there is no route by which this client silently becomes global. A
    // wrong-region bucket is not the outcome; a failed deploy is.
    //
    // `tests/unit/provisioning/s3-bucket-provider-location-constraint-case.test.ts`
    // pins every swept region on the wire verbatim for exactly that reason,
    // and the three SIBLING cast sites are pinned the same way in their own
    // suites (`tests/unit/assets/asset-storage.test.ts`,
    // `tests/unit/cli/bootstrap.test.ts`, `tests/unit/cli/state-migrate.test.ts`)
    // so that a contributor grepping `as BucketLocationConstraint` finds all
    // four fenced rather than one.
    //
    // `region` itself is deliberately left RAW rather than reassigned. The
    // pre-flight gate below folds it at its own site, and that fold is what
    // `s3-bucket-provider-us-east-1-preflight.test.ts`'s raw-spelling case
    // watches; canonicalizing the shared binding would leave that fold -- and
    // the case fencing it -- unable to fail.
    const region = await this.getRegion();
    const canonicalRegion = canonicalizeRegion(region);
    if (canonicalRegion !== 'us-east-1') {
      createParams.CreateBucketConfiguration = {
        LocationConstraint: canonicalRegion as BucketLocationConstraint,
      };
    }

    // ObjectLockEnabled must be set at bucket creation time
    if (declaresBucketObjectLock(properties)) {
      createParams.ObjectLockEnabledForBucket = true;
    }

    // go-to-k/cdkd#4969: the template's tags ride on `CreateBucket` itself,
    // as CloudFormation sends them, so an SCP that requires
    // `aws:RequestTag/...` on `s3:CreateBucket` sees them. A create that
    // carried them and created the bucket skips the `PutBucketTagging` the
    // configure step would otherwise repeat (`tagsAppliedOnCreate`).
    if (desiredTags.length > 0) {
      createParams.CreateBucketConfiguration = {
        ...createParams.CreateBucketConfiguration,
        Tags: desiredTags,
      };
    }
    let tagsAppliedOnCreate = false;

    // In `us-east-1` a 200 from `CreateBucket` does NOT mean this call
    // created the bucket, so ask S3 whether the name is already taken
    // BEFORE taking it (issue #2241).
    //
    // Everywhere else the 200 is proof: `CreateBucket` answers a re-create
    // of a bucket you already own with `BucketAlreadyOwnedByYou`, which the
    // catch below handles. `us-east-1` is the documented exception —
    // `@aws-sdk/client-s3` `dist-types/models/errors.d.ts` on
    // `BucketAlreadyOwnedByYou`: "Amazon S3 returns this error in all Amazon
    // Web Services Regions except in the North Virginia Region. For legacy
    // compatibility, if you re-create an existing bucket that you already own
    // in the North Virginia Region, Amazon S3 returns 200 OK and resets the
    // bucket access control lists (ACLs)." Without this probe the adopt never
    // enters the catch, `createdNewBucket` is set for a bucket the deploy did
    // not create, and the partial-create cleanup below fires `DeleteBucket`
    // at a PRE-EXISTING user bucket — the exact outcome issue #376's gate
    // exists to prevent. The default bucket name is `{stackName}-{logicalId}`
    // (`generateResourceName`) with no region or account in it, so the name
    // collision that reaches this is not exotic.
    //
    // The probe never licenses an ADOPTION in place of the `CreateBucket`
    // call: it informs the cleanup gate, and two refusals that adopt nothing
    // -- after an ambiguous attempt of this same create (issue #4639), and
    // over an explicit `BucketName` (go-to-k/cdkd#4684), both below.
    // `CreateBucket` is the authoritative OWNERSHIP
    // oracle (a bucket held by another account fails it with
    // `BucketAlreadyExists`), while `GetBucketLocation` can succeed against a
    // foreign-owned bucket whose policy happens to allow it — so skipping the
    // create on a positive probe AND adopting would trade this bug for a
    // worse one.
    // Canonicalized, like the `LocationConstraint` gate above it: a mis-cased
    // region reaches `getRegion()` unfolded whenever the client bag carries no
    // region and the SDK's own chain answers from the profile (the mechanism
    // and its measurement are on the gate above -- NOT `--region`, which is
    // folded twice before it could get here), and a raw `===` would silently
    // skip the probe for the one region it exists for. This fold is
    // INDEPENDENT of the gate's — `region` is still the raw spelling at this
    // point, so removing `canonicalizeRegion` here still breaks the probe on
    // an unfolded spelling even though the gate above now folds too (issue
    // #2282, which fixed the gate; this line shipped with issue #2241's
    // pre-flight and is unchanged by it).
    const preflight: BucketRegionProbe =
      canonicalizeRegion(region) === 'us-east-1'
        ? await this.probeBucketRegion(bucketName)
        : // Outside us-east-1 the 200 itself proves this call created the
          // bucket, so no probe is issued and no round trip is spent.
          { kind: 'absent' };

    // Track whether THIS call actually created the bucket (vs hit the
    // idempotent `BucketAlreadyOwnedByYou` fallback, or the `us-east-1`
    // legacy 200 over a bucket that was already there). Only the truly-
    // created case is eligible for partial-failure cleanup — deleting a
    // pre-existing bucket would destroy a user resource that lived
    // before this deploy ran.
    let createdNewBucket = false;
    // Issue #4639: the create client is built and the window taken AFTER the
    // pre-flight (which never throws).
    const createClient = await this.getCreateClient();
    ambiguousWindow = takeCreateBucketWindow(logicalId);
    // go-to-k/cdkd#4758: taken by every attempt, used only for an explicit
    // name the holder of which is proven to be that attempt's bucket.
    const ownLeftover = takeOwnLeftoverBucket(logicalId);
    // Decided BEFORE any send, in every region: outside us-east-1 a
    // `CreateBucket` answering `BucketAlreadyOwnedByYou` moves the
    // bucket's ListBuckets `CreationDate` to its own second (measured for
    // go-to-k/cdkd#4758), so the identity could not be compared after it.
    // No attempt holds both a record and an ambiguous window (issue #4639):
    // the attempt that records got a 200, which spends the window.
    // Never on a rollback's re-create (`replayingState`): there the bucket
    // under the name is the forward create's orphan, which the journal
    // still lists, not the old bucket being restored.
    const adoptedOwnLeftover =
      explicitBucketName &&
      ownLeftover !== undefined &&
      context?.replayingState !== true &&
      (await this.isOwnLeftoverBucket(ownLeftover, bucketName, resourceType, canonicalRegion));
    if (adoptedOwnLeftover) {
      createdNewBucket = true;
      bucketLeftBehind = true;
    }
    if (
      ambiguousWindow !== undefined &&
      (preflight.kind === 'indeterminate' ||
        (preflight.kind === 'region' && preflight.region === 'us-east-1'))
    ) {
      // us-east-1's analogue of the `BucketAlreadyOwnedByYou` arm below,
      // refused BEFORE the send. With the bucket seen there, a re-create
      // cannot create anything and its legacy 200 would only reset the
      // ACLs of a bucket that may be a colleague's; the refusal's own
      // `list-buckets` tells an owned bucket from a foreign one. With the
      // pre-flight unanswered, the send could CREATE the bucket and leave
      // it unattributed. A pre-flight placing it in another region keeps
      // the foreign-region refusal below.
      windowSpent = true;
      this.refuseAmbiguousCreateAdopt(
        logicalId,
        resourceType,
        bucketName,
        canonicalRegion,
        { preflight: preflight.kind },
        explicitBucketName
      );
    }
    if (explicitBucketName && preflight.kind === 'region' && preflight.region === 'us-east-1') {
      // go-to-k/cdkd#4684: the us-east-1 analogue of the explicit-name
      // refusal in the `BucketAlreadyOwnedByYou` arm below, refused BEFORE
      // the send so the legacy 200 never resets the bucket's ACLs. A
      // pre-flight that could not answer still sends (nothing proves the
      // name is taken), and one placing the bucket in another region keeps
      // the foreign-region refusal.
      if (!adoptedOwnLeftover) {
        this.refuseExplicitNameHeld(logicalId, resourceType, bucketName, {
          preflightRegion: preflight.region,
        });
      }
    }
    // go-to-k/cdkd#4684: a pre-flight that could not answer cannot rule the
    // explicit name free, and a legacy 200 would adopt a bucket this account
    // owns silently. Ask the account's own bucket list instead: the create
    // is sent unless the list holds the name, and when the list cannot
    // answer either, the warning below says what that may have done.
    let ownershipUnknown: string | undefined;
    // The list not holding the name licenses SENDING the create, never
    // claiming the bucket it answers 200 for: `ListBuckets` can lag a
    // bucket created moments ago (by a concurrent same-account create of
    // the same name, say), an undocumented window, so the bucket stays out
    // of the cleanup and the created-before-failure mark -- an empty orphan
    // with the warning below at worst, never another's bucket deleted
    // (#4684 review). Only a pre-flight answering `absent` claims it.
    if (explicitBucketName && preflight.kind === 'indeterminate' && !adoptedOwnLeftover) {
      const owned = await this.ownsBucketNamed(bucketName);
      if ('owned' in owned && owned.owned) {
        this.refuseExplicitNameHeld(logicalId, resourceType, bucketName, { listed: true });
      }
      if ('unknown' in owned) ownershipUnknown = owned.unknown;
    }
    try {
      const attemptStartMs = Date.now();
      // go-to-k/cdkd#4758: not for this create's own leftover, already
      // proven above: the 409 would move its CreationDate, and in us-east-1
      // the legacy 200 would only reset its ACLs.
      if (!adoptedOwnLeftover) {
        let tagsSent = createParams.CreateBucketConfiguration?.Tags !== undefined;
        try {
          try {
            await createClient.send(new CreateBucketCommand(createParams));
          } catch (taggedError) {
            const tagResourceDenied = isCreateTagResourceDenial(taggedError);
            if (!tagsSent || !(tagResourceDenied || isCreateTagsShapeRefusal(taggedError))) {
              throw taggedError;
            }
            // go-to-k/cdkd#4969: retry ONCE without tags and let the configure
            // step's `PutBucketTagging` apply them -- the pre-fix path -- for
            // the two refusals the tags themselves caused:
            //  - `s3:TagResource` denied. Tags on `CreateBucket` need it
            //    (CreateBucket API reference), which a role granted only the
            //    `s3:PutBucketTagging` the old path needed may lack. Measured:
            //    such a session is denied the tagged create and succeeds
            //    untagged. Never fires for this issue's case: an SCP requiring
            //    request tags lets the tagged create through.
            //  - a request-shape refusal of the `Tags` member
            //    (`isCreateTagsShapeRefusal`): a region or partition whose
            //    CreateBucket does not take it fails EVERY tagged create
            //    otherwise, where untagged + Put worked before this change.
            // The extra call is spent on every tagged create of such a role or
            // region, never by one that accepts the tagged create.
            this.logger.debug(
              safeMsg`CreateBucket with tags was ${tagResourceDenied ? 'denied s3:TagResource' : 'refused for its Tags member'} for ${displaySafe(logicalId)}; ` +
                `retrying without tags and applying them with PutBucketTagging`
            );
            const { Tags: _omitted, ...rest } = createParams.CreateBucketConfiguration ?? {};
            const untagged = { ...createParams };
            if (Object.keys(rest).length > 0) untagged.CreateBucketConfiguration = rest;
            else delete untagged.CreateBucketConfiguration;
            tagsSent = false;
            try {
              await createClient.send(new CreateBucketCommand(untagged));
            } catch (untaggedError) {
              // A TagResource denial whose untagged re-send is DENIED too (an
              // SCP requiring request tags, say): the missing `s3:TagResource`
              // is the cause to report, since granting it lets the tagged
              // create through, so the tagged create's denial surfaces. When
              // the re-send's denial is EXPLICIT, it is marked non-retryable
              // and the wrap names both causes. A TRADE-OFF, recorded here: a
              // `TagResource` grant made earlier in the same deploy and still
              // propagating would let a later tagged attempt through, and
              // that rare case now fails instead of waiting. It gave way to
              // the common case -- `TagResource` never granted -- which would
              // otherwise spend the whole ~47.75s propagation budget at two
              // CreateBucket calls an attempt, the wait #4969 removes. An
              // IMPLICIT untagged denial keeps the retry. Any other answer -- the 409s the outer
              // catch adopts or refuses, a throttle, or anything after a
              // shape refusal -- is the untagged create's own.
              if (
                tagResourceDenied &&
                untaggedError instanceof Error &&
                untaggedError.name === 'AccessDenied'
              ) {
                this.logger.debug(
                  safeMsg`CreateBucket without tags was denied too for ${displaySafe(logicalId)}; ` +
                    `reporting the s3:TagResource denial`
                );
                const untaggedText = describeAwsFailure(untaggedError).detail;
                if (isExplicitDenyError(untaggedText) && taggedError instanceof Error) {
                  untaggedExplicitDeny.set(
                    taggedError,
                    explicitDenyPolicyKind(untaggedText) ?? null
                  );
                  markNonRetryable(taggedError);
                }
                throw taggedError;
              }
              throw untaggedError;
            }
          }
        } catch (sendError) {
          createBucketLatch.noteFailure(logicalId, sendError, attemptStartMs, ambiguousWindow);
          throw sendError;
        }
        // Only a create that MADE the bucket applied its tags: a legacy
        // us-east-1 200 over an existing bucket, or one the pre-flight could
        // not place, keeps the `PutBucketTagging`.
        tagsAppliedOnCreate = tagsSent && preflight.kind === 'absent';
      }
      createdNewBucket = adoptedOwnLeftover || preflight.kind === 'absent';
      bucketLeftBehind = createdNewBucket;
      // go-to-k/cdkd#5511: reported before the configuration calls.
      if (createdNewBucket) reportCreatedResource(logicalId, resourceType, bucketName);
      // A fresh create answers the question: the earlier attempt made nothing.
      if (createdNewBucket) windowSpent = true;
      if (preflight.kind === 'region' && preflight.region !== 'us-east-1') {
        // A 200 over a bucket the pre-flight placed in ANOTHER region.
        // Refuse with the same message the 409 path raises, rather than warn
        // and configure it: warning here would be self-contradicting (its
        // text explains a us-east-1 behaviour while naming a region that is
        // not us-east-1) and would apply this stack's whole configuration to
        // a foreign bucket -- the exact issue #2227 outcome, arriving by the
        // one door that guard does not watch.
        //
        // Not reachable by AWS's own documentation: the legacy 200 is scoped
        // to re-creating a bucket you own IN N. Virginia, and the catch below
        // records the measurement that a cross-region owned bucket answers
        // 409 instead. So this is a fail-CLOSED floor under a documented
        // impossibility, not a case with a live population -- kept because
        // the alternative on a documentation change is a silent cross-region
        // reconfigure, and the refusal already exists.
        this.refuseForeignRegionAdopt(
          logicalId,
          resourceType,
          bucketName,
          'us-east-1',
          preflight.region
        );
      }
      if (preflight.kind === 'region' && !adoptedOwnLeftover) {
        // The legacy 200 already happened by the time we get here, and it
        // reset the bucket's ACLs (SDK doc quoted above) — a real, if
        // smaller, effect of the same adopt, and one the user cannot see
        // from a successful deploy. Say so rather than leaving it silent.
        // `preflight.region` is necessarily us-east-1 here, the branch above
        // having refused everything else, so the message cannot name a region
        // its own explanation does not apply to.
        this.logger.warn(
          `S3 bucket ${this.shown(bucketName)} for ${displaySafe(logicalId)} (${resourceType}) already existed in ` +
            `${preflight.region} and was ADOPTED, not created. In us-east-1 S3 answers a ` +
            `re-create of a bucket you already own with 200 OK and RESETS that bucket's ` +
            `access control lists, so any ACL previously set on ${this.shown(bucketName)} is now the ` +
            `default. cdkd will not delete this bucket if the rest of this create fails.`
        );
      }
      if (ownershipUnknown !== undefined && preflight.kind === 'indeterminate') {
        this.logger.warn(
          safeMsg`S3 bucket ${this.shown(bucketName)} for ${displaySafe(logicalId)} (${resourceType}) was ` +
            `sent to CreateBucket without knowing whether a bucket of that explicit name ` +
            safeMsg`already existed: the region probe (${preflight.errorName}) and the bucket ` +
            safeMsg`listing (${ownershipUnknown}) both failed. In us-east-1 CreateBucket answers 200 ` +
            `OK over a bucket you own, so if one existed it has now been configured and ` +
            safeMsg`recorded as this stack's.${verbosePointerTail()}`
        );
      }
      this.logger.debug(`Created S3 bucket: ${this.shown(bucketName)}`);
    } catch (createError) {
      // A cdkd REFUSAL is not an AWS failure to classify. The only one that
      // can arrive here is the foreign-region adopt raised in the `try`
      // above, and the classifier below matches on
      // `message.includes('you already own it')` -- so it survives today only
      // because that refusal's wording happens not to contain the substring.
      // A future reword would have this catch swallow the refusal into the
      // "already owned" arm and configure the foreign bucket: the exact issue
      // #2227 outcome, reintroduced by a copy-edit. The pass-through is the
      // same unguarded-wrap class already fixed for `update()`, and it goes
      // FIRST so no later arm can claim the error.
      //
      // Not solved by hoisting the refusal out of the `try` instead: the
      // `BucketAlreadyOwnedByYou` arm below calls `assertExistingBucketRegion`
      // on different evidence, so both would fire and double-refuse.
      if (createError instanceof ProvisioningError) throw createError;
      // Another account holds the name: the oracle's answer, so the window
      // (issue #4639) is spent.
      if (createError instanceof Error && createError.name === 'BucketAlreadyExists') {
        windowSpent = true;
      }

      // `BucketAlreadyOwnedByYou` is an idempotent-create success ONLY once
      // the bucket that already exists is confirmed to live in the region
      // this deploy targets. The error is raised on OWNERSHIP, which is
      // account-global, while a bucket is regional — so it fires just as
      // readily for a bucket of ours in a DIFFERENT region. Measured on real
      // AWS for issue #2227: a bucket created in `us-west-2` answers
      // `BucketAlreadyOwnedByYou` to a `CreateBucket` in `eu-west-1` AND in
      // `us-east-1`, and `GetBucketLocation` still reports `us-west-2`
      // afterwards — the bucket never moves. Adopting it would point every
      // `applyConfiguration` / sub-config call below at another region's
      // resource while reporting success, and would record a physical id
      // that denotes nothing in this stack's own region.
      if (
        createError instanceof Error &&
        (createError.name === 'BucketAlreadyOwnedByYou' ||
          createError.message.includes('you already own it'))
      ) {
        await this.assertExistingBucketRegion(
          logicalId,
          resourceType,
          bucketName,
          region,
          createError
        );
        // Issue #4639: a same-region bucket we own, after an ambiguous
        // attempt of THIS create, is not attributable -- refuse rather than
        // adopt.
        if (ambiguousWindow !== undefined) {
          windowSpent = true;
          this.refuseAmbiguousCreateAdopt(
            logicalId,
            resourceType,
            bucketName,
            canonicalRegion,
            { cause: createError },
            explicitBucketName
          );
        }
        // go-to-k/cdkd#4684: nor is one holding an EXPLICIT name; only a
        // generated name's holder is presumed this stack's own and adopted.
        if (explicitBucketName) {
          this.refuseExplicitNameHeld(logicalId, resourceType, bucketName, {
            cause: createError,
          });
        }
        this.logger.debug(`S3 bucket ${this.shown(bucketName)} already exists and is owned by you`);
      } else {
        throw createError;
      }
    }

    // Apply additional configuration in an inner try so a wiring
    // failure can be self-healed by issuing a best-effort `DeleteBucket`
    // cleanup. Without this, a sub-config failure leaves an orphan
    // bucket that AWS will reject on the next redeploy. The cleanup
    // is gated on `createdNewBucket` so we never delete a pre-existing
    // bucket. See Issue #376 for the cross-provider sweep.
    let effectiveOverrides: Map<string, unknown>;
    // go-to-k/cdkd#2762: a bucket this call did not make, or its own leftover,
    // can already hold what the steps below write. Reached by a crash during
    // the metadata wait or a retained.json re-adoption, so a plain create
    // reads nothing here. `PutBucketTagging` is refused while ABAC is on, and
    // the metadata goes through the diff from what S3 holds. ABAC is read
    // whatever the template says, since it decides how tags are written here
    // and a later Tags change is refused while it is on. An undeclared live metadata
    // configuration stays, and the readback enters the observed baseline, so
    // `cdkd drift` will not report it.
    const bucketPredates = !createdNewBucket || adoptedOwnLeftover;
    const desiredAbac = abacStatusOf(properties);
    const liveAbacOn = bucketPredates && (await this.readAbacStatus(bucketName)) === ABAC_ENABLED;
    try {
      // Only a declared `Disabled` turns it off: ABAC decides how `aws:ResourceTag`
      // conditions evaluate, so an undeclared value is the owner's to keep.
      const turnAbacOff = liveAbacOn && properties['AbacStatus'] === ABAC_DISABLED;
      if (turnAbacOff) {
        await this.applyAbacStatus(bucketName, ABAC_DISABLED);
      } else if (liveAbacOn && properties['AbacStatus'] === undefined) {
        this.logger.warn(
          safeMsg`Bucket ${this.shown(bucketName)} already existed with ABAC on, which the template does not declare; it stays on, and a later Tags change fails with BadRequest until the template declares AbacStatus`
        );
      }
      const tagsThroughControl = liveAbacOn && !turnAbacOff;
      effectiveOverrides = await this.applyConfiguration(bucketName, properties, {
        ...(context ? { context } : {}),
        // go-to-k/cdkd#4969: tags `CreateBucket` already set need no Put.
        // An adopted bucket (our own leftover, or `BucketAlreadyOwnedByYou`)
        // got none from this call, so it still takes the Put.
        ...(tagsAppliedOnCreate || tagsThroughControl
          ? { skipTags: true as const }
          : { desiredTags }),
      });
      for (const [key, value] of await this.applyAllSubConfigsForCreate(
        bucketName,
        properties,
        context
      )) {
        effectiveOverrides.set(key, value);
      }
      if (tagsThroughControl && desiredTags.length > 0) {
        await this.replaceAbacBucketTags(bucketName, desiredTags);
      }
      // go-to-k/cdkd#2762: after the tags above, which `PutBucketTagging`
      // refuses once ABAC is on.
      if (desiredAbac !== ABAC_DISABLED) {
        await this.applyAbacStatus(bucketName, desiredAbac);
      }
      const metadata = metadataBag(properties['MetadataConfiguration']);
      const replaying = context?.replayingState === true;
      if (metadataRefusal !== undefined) {
        this.logger.warn(
          safeMsg`Bucket ${this.shown(bucketName)}: ${metadataRefusal}; no S3 Metadata configuration was restored`
        );
      } else if (metadata !== undefined && bucketPredates) {
        // Tolerant: an unread configuration still converges through the create.
        const live = await this.readMetadataForDrift(bucketName);
        await (live === 'unread' || live === undefined
          ? this.createMetadataConfiguration(bucketName, metadata, true)
          : this.convergeMetadataConfiguration(bucketName, metadata, live, replaying));
      } else if (metadata !== undefined) {
        await this.createMetadataConfiguration(bucketName, metadata, replaying);
      }
    } catch (innerError) {
      if (createdNewBucket) {
        try {
          await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
          bucketLeftBehind = false;
          retractCreatedResource(logicalId, resourceType, bucketName);
          this.logger.debug(
            `Cleaned up partially-created S3 bucket ${displaySafe(logicalId)} (${this.shown(bucketName)}) after wiring failure`
          );
        } catch (cleanupError) {
          // Class at warn, AWS's own text at debug — the sibling arm below
          // and the update/delete guard both do this, and for the same
          // reason: an `AccessDenied` on `DeleteBucket` reads `User:
          // arn:aws:sts::<account>:assumed-role/<role>/<session> is not
          // authorized to perform: s3:DeleteBucket ...`, so the
          // default-verbosity line would print the account id, the role name
          // and the session name. This arm predates that rule (issue #376)
          // and was the last reader in this file still interpolating an AWS
          // message into a warn.
          this.logger.debug(
            `DeleteBucket cleanup failed for S3 bucket ${displaySafe(logicalId)} (${this.shown(bucketName)}): ${describeAwsFailure(cleanupError).detail}`
          );
          // Routed through the caller's masker (security review of issue
          // #3136): `bucketName` is a RESOLVED property value, so a
          // `{{resolve:secretsmanager:...}}` is plaintext here, and a
          // provider's own `logger.warn` reaches NO engine sink. The view's
          // logger masks the line; the clause takes the masker so it can
          // WITHHOLD a command naming a secret-bearing bucket.
          this.logger.warn(
            safeMsg`Failed to clean up partially-created S3 bucket ${displaySafe(logicalId)} (${this.shown(bucketName)}) ` +
              safeMsg`(${cleanupError instanceof Error ? cleanupError.name : typeof cleanupError}). ` +
              safeMsg`${verbosePointerSentence()}` +
              safeMsg`${manualBucketDeletionClause(bucketName, this.shownMask, true)}`
          );
        }
      } else if (preflight.kind === 'indeterminate') {
        // The us-east-1 probe could not answer, so this deploy cannot tell an
        // orphan it just made from a bucket that predates it. Skipping the
        // cleanup leaves at worst an empty orphan bucket, which is
        // recoverable and named here; running it could delete a user's
        // bucket, which is not. Warn where it matters — at the moment the
        // cleanup would have run — rather than on every successful create.
        //
        // The CLASS goes in the warn and `preflight.reason` goes to debug.
        // This is the same `probeBucketRegion` failure the update/delete
        // guard reports, so it is the same caller-identity leak: on the
        // headline cohort (a bucket policy denying `s3:GetBucketLocation`)
        // AWS's text names the account, the role and the session. Fixing only
        // the guard's copy left this one printing the identical string to the
        // identical sink.
        this.logger.debug(
          `GetBucketLocation failed for S3 bucket ${this.shown(bucketName)} (${displaySafe(logicalId)}) during create: ` +
            `${preflight.reason}`
        );
        // Masked for the same reason as the sibling arm above.
        this.logger.warn(
          safeMsg`Not cleaning up S3 bucket ${displaySafe(logicalId)} (${this.shown(bucketName)}) after a wiring failure: ` +
            `this deploy could not confirm whether it created the bucket (region probe failed: ` +
            safeMsg`${preflight.errorName}), and in us-east-1 a successful CreateBucket does not ` +
            safeMsg`prove it. ${verbosePointerSentence()}If cdkd created it, the ` +
            `bucket is an orphan. ` +
            safeMsg`${manualBucketDeletionClause(bucketName, this.shownMask, false)}`
        );
      }
      // The bucket itself is in hand: an "already exists" from its wiring is
      // an auxiliary object's, not this bucket's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    const attributes = await this.buildAttributes(bucketName);
    if (metadataBag(properties['MetadataConfiguration'])) {
      Object.assign(attributes, await this.readMetadataAttributesAfterWrites(bucketName, context));
    }

    this.logger.debug(
      `Successfully created S3 bucket ${displaySafe(logicalId)}: ${this.shown(bucketName)}`
    );

    // Anything a replay downgrade SKIPPED is dropped from the recorded bag,
    // and anything it SUBSTITUTED is recorded as SENT, so state describes the
    // bucket AWS actually holds (issues #1612 / #1670).
    //
    // It is NO LONGER absent on an ordinary template-path create, and this
    // sentence said it was until issues #1707 / #1717 / #1718 — the same
    // stale-rationale class those changes fixed elsewhere in this file. The
    // per-item folds populate `substituted` whenever they change an item at
    // all: a defaulted `Enabled` / `IncludedObjectVersions` /
    // `OutputSchemaVersion`, or a destination declared in either tolerated
    // spelling. None of those needs a downgrade to be reachable.
    const effectiveProperties = S3BucketProvider.applyEffectiveOverrides(
      properties,
      effectiveOverrides
    );

    return {
      physicalId: bucketName,
      attributes,
      ...(effectiveProperties ? { effectiveProperties } : {}),
    };
  } catch (error) {
    if (ambiguousWindow !== undefined && !windowSpent) {
      holdCreateBucketWindow(logicalId, ambiguousWindow);
    }
    const thrown = this.wrapOperationError('create', logicalId, resourceType, bucketName, error);
    if (bucketLeftBehind) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, bucketName);
      // go-to-k/cdkd#4758: what a retry of this create needs to know the
      // bucket again. Only an explicit name is refused on retry.
      if (explicitBucketName) await this.holdOwnLeftover(logicalId, resourceType, bucketName);
    }
    throw thrown;
  }
}
