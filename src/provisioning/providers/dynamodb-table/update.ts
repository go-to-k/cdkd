import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { requireConfigString } from '../../config-shape.js';
import type { ResourceUpdateResult, UpdateContext, SecretMasker } from '../../../types/resource.js';
import { planVectorIndexUpdates, vectorIndexesShapeDetail } from '../../dynamodb-vector-indexes.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import { hasUsableTableCapacity } from './capacity.js';
import { localSecondaryIndexesKey } from './indexes.js';
import { hasUsableDeclaredCapacity, maskLeafValue } from './table-helpers.js';
import { refuseIndexCeilingsUnderProvisioned, refuseUnsendableUpdate } from './update-preflight.js';
import { applyBillingModeUpdate, applyThroughputUpdates } from './update-billing.js';
import {
  applyIndexUpdates,
  applySseAndDeletionProtectionUpdates,
  applyStreamSpecificationUpdate,
} from './update-settings.js';

/**
 * Update a DynamoDB table
 *
 * DynamoDB tables have limited in-place update capabilities.
 * For immutable property changes (KeySchema, etc.), the deployment layer
 * handles replacement via DELETE + CREATE.
 */
export async function update(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  // Read for two things. `maskSecrets` (issue #1932 item 3, adopted here by
  // issue #1997): the update path carries the same RESOLVED bag as
  // `create()`, so the masking requirement is identical on both — a masker
  // present on one and absent from the other is not a partial fix, it is a fix
  // with a hole in the shape of whichever path a given deploy takes. And the
  // ORIGIN of the desired bag (`replayingState` / `desiredFromAwsReadback`),
  // which decides whether the pre-flight refusals below refuse (a template
  // deploy) or downgrade (a rollback revert or `cdkd drift --revert`).
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#5487: before each call that changes the table, so a
  // failure from there on (the ACTIVE / SSE / Kinesis waits, the deadline,
  // a later call) leaves the key unsettled for the next deploy to converge.
  const markUnsettled = (key: string): void => context?.markUnsettled?.(key);
  // ONE masked sink for every warning in this method (issue #1997), rather
  // than a `maskSecrets(...)` at each `this.logger.warn` call: a warning added
  // later is masked by construction instead of by the author remembering. It
  // is the OUTER of two layers — a finished message is always longer than the
  // value inside it, so it can only reach `maskSecretsInText`'s SUBSTRING arm,
  // which ignores needles below `MIN_NEEDLE_LENGTH` (4). The per-value
  // maskers in the helpers below are the inner layer, handing the masker each
  // raw string so it reaches the WHOLE-VALUE arm at any length; the mask is
  // idempotent, so applying both is free.
  const maskSecrets: SecretMasker = context?.maskSecrets ?? ((text) => text);
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  // `physicalId` is the resolved table name, so the entry line needs the
  // sink too (issue #1997) — found by a test asserting on the debug
  // stream rather than by review.
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
  debug(`Updating DynamoDB table ${logicalId}: ${maskSecrets(physicalId)}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    const { deletionProtectionChanged, sseChanged, sseRefusal } = refuseUnsendableUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context,
      maskSecrets
    );

    // Get current table description for attributes (also gives us the
    // table ARN we need for tag mutations).
    const response = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: physicalId })
    );

    const table = response.Table;

    // go-to-k/cdkd#5354: DynamoDB has no API that adds, removes or changes a
    // local secondary index on an existing table, and CloudFormation does NOT
    // replace the table for it either. Measured (us-east-1, 2026-10-26): a
    // change set for an LSI projection change reports `Replacement: False` /
    // `RequiresRecreation: Never`, and executing it — or one adding or
    // removing an LSI — fails the table's update (`UPDATE_FAILED`) and rolls
    // the stack back. So the change is REFUSED here, before any mutating
    // call, instead of being dropped: `update()` used to never read the list,
    // so the deploy went green, state recorded the new indexes, and AWS kept
    // the old ones. A change whose desired list the LIVE table already holds
    // is not refused: that is a record the old drop left wrong, or the
    // rollback of a change that was itself refused, and this update just
    // records what AWS has. The state-borne callers warn instead (no
    // template-side remedy).
    const desiredLsiKey = localSecondaryIndexesKey(properties['LocalSecondaryIndexes']);
    if (
      desiredLsiKey !== localSecondaryIndexesKey(previousProperties['LocalSecondaryIndexes']) &&
      (table === undefined ||
        desiredLsiKey !== localSecondaryIndexesKey(table.LocalSecondaryIndexes))
    ) {
      const lsiMessage =
        `AWS::DynamoDB::Table ${logicalId}: LocalSecondaryIndexes changed, but DynamoDB ` +
        `cannot add, remove or modify a local secondary index on an existing table, and ` +
        `CloudFormation fails the same update rather than replacing the table`;
      if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
        throw new ProvisioningError(
          `${lsiMessage}. Nothing was applied to the table; revert the LocalSecondaryIndexes ` +
            `change, or create a new table under a new logical ID (a new table starts empty)`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      warn(`${lsiMessage}; the LocalSecondaryIndexes change was not applied`);
    }

    // go-to-k/cdkd#2762: VectorIndexes. `UpdateTable` creates or deletes a
    // vector index and has no in-place modify, so a same-name index whose
    // definition changed is refused here, before any mutating call — the
    // GSI KeySchema / Projection rule. Planned against the LIVE list too, so
    // a record that lags AWS (an earlier deploy created the index and failed
    // before state was written) converges instead of re-sending a Create
    // AWS refuses. The state-borne callers warn and skip the change (no
    // template-side remedy), as the LSI refusal above does. An UNSETTLED
    // VectorIndexes needs no extra trigger: the engine's previous side is
    // then `readUnsettled`'s projected live list, so this comparison is
    // already against what AWS holds.
    //
    // go-to-k/cdkd#5606: an unreadable list reads as "no index declared" and
    // would delete every recorded one, so a changed one gets no plan: refused
    // on the template path, warned on the state-borne callers, leaving the
    // indexes as they are.
    const vectorIndexesChanged =
      JSON.stringify(properties['VectorIndexes']) !==
      JSON.stringify(previousProperties['VectorIndexes']);
    const vectorIndexShape = vectorIndexesChanged
      ? vectorIndexesShapeDetail(properties['VectorIndexes'])
      : undefined;
    if (vectorIndexShape !== undefined) {
      const shapeMessage = `AWS::DynamoDB::Table ${logicalId}: ${vectorIndexShape}`;
      if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
        throw new ProvisioningError(
          `${maskSecrets(shapeMessage)}. Nothing was applied to the table; fix the template value`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      warn(`${shapeMessage}; the VectorIndexes change was not applied`);
    }
    const vectorIndexPlan =
      vectorIndexesChanged && vectorIndexShape === undefined
        ? planVectorIndexUpdates(
            previousProperties['VectorIndexes'],
            properties['VectorIndexes'],
            table?.VectorIndexes ?? (table === undefined ? undefined : [])
          )
        : undefined;
    if (vectorIndexPlan !== undefined && vectorIndexPlan.changed.length > 0) {
      // Each name masked on its own (the WHOLE-VALUE arm, at any length),
      // not only inside the finished sentence, as `indexScopeAt` does.
      const vectorMessage =
        `AWS::DynamoDB::Table ${logicalId}: VectorIndexes ` +
        `${vectorIndexPlan.changed.map((n) => maskSecrets(n)).join(', ')} changed definition, which DynamoDB cannot ` +
        `modify in place`;
      if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
        throw new ProvisioningError(
          `${maskSecrets(vectorMessage)}. Nothing was applied to the table; rename the index ` +
            `(so it is dropped and re-created) or revert the change`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      warn(`${vectorMessage}; that change was not applied`);
    }

    // The StreamArn attribute returned to the deploy engine. Seeded from the
    // DescribeTable snapshot above, but the StreamSpecification branch below
    // overwrites it after an update-time enable / disable / view-type change
    // so `Fn::GetAtt [Table, StreamArn]` resolves to the freshly-materialized
    // (or cleared) stream ARN rather than the pre-update value.
    let latestStreamArn = table?.LatestStreamArn;

    // Apply tag diff if changed. DynamoDB's TagResource takes
    // [{ Key, Value }] arrays; UntagResource takes a TagKeys list.
    if (table?.TableArn) {
      await this.applyTagDiff(
        table.TableArn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags'],
        {
          forceUpsert: context?.unsettledProperties?.has('Tags') === true,
          beforeWrite: () => markUnsettled('Tags'),
          afterAdded: (keys) => {
            if (keys.length > 0) context?.markAttempted?.('Tags', keys);
          },
        }
      );
    }

    // BillingMode / ProvisionedThroughput — both ride on UpdateTable and are
    // mutable (CFn createOnly = only TableName + ImportSourceSpecification).
    // Fire a SINGLE UpdateTable when either changed so:
    //  - a pure ProvisionedThroughput capacity bump (RCU/WCU change, mode
    //    stays PROVISIONED) actually reaches AWS instead of being silently
    //    dropped (state would otherwise record the new value as applied and
    //    the next deploy would see no diff — the throw-not-swallow / no-
    //    SDK-unwired rule);
    //  - a pure BillingMode switch (PROVISIONED <-> PAY_PER_REQUEST) reaches
    //    AWS;
    //  - a combined switch-to-PROVISIONED-with-caps sends both in ONE call,
    //    BEFORE the OnDemandThroughput branch below, so AWS sees a consistent
    //    request rather than a throughput change against a still-PAY_PER_-
    //    REQUEST table (or vice versa).
    // Constraints AWS enforces and we mirror here: PAY_PER_REQUEST must NOT
    // carry ProvisionedThroughput; PROVISIONED requires it. Numeric capacity
    // values arrive as strings from the template, so coerce through
    // `coerceCfnInteger` — CloudFormation's own DynamoDB Integer grammar,
    // matching create() (issue #3147; it was `Number()` in both until then).
    //
    // Per-index ProvisionedThroughput rides this same UpdateTable on a flip
    // TO PROVISIONED, because AWS requires it there (issue #1588 — see the
    // measured A/B at the GlobalSecondaryIndexUpdates block below). A GSI-only
    // capacity change on an already-PROVISIONED table is still handled by the
    // dedicated per-index update path further down, not here.
    // TableClass rides the same UpdateTable and is mutable (CFn "Update
    // requires: No interruption"). It previously had NO update branch at
    // all, so a STANDARD <-> STANDARD_INFREQUENT_ACCESS switch was silently
    // dropped: the deploy reported success while AWS kept the old class,
    // and the next diff saw no change (state recorded the new class), so it
    // could never self-heal. Only send TableClass when it actually changed
    // — AWS rejects an UpdateTable that re-asserts the current class.
    // Normalize BOTH comparison sides first: an absent property means the
    // DynamoDB default (STANDARD), so an explicit-STANDARD <-> absent
    // template edit is NOT a real change and must not issue the doomed
    // same-class UpdateTable.
    const normalizeTableClass = (v: unknown): 'STANDARD' | 'STANDARD_INFREQUENT_ACCESS' =>
      typeof v === 'string' && v.length > 0
        ? (v as 'STANDARD' | 'STANDARD_INFREQUENT_ACCESS')
        : 'STANDARD';
    const tableClassChanged =
      normalizeTableClass(properties['TableClass']) !==
      normalizeTableClass(previousProperties['TableClass']);
    // Shape-guard the DESIRED BillingMode before the change detection
    // (issue #1545). WARN, never throw, HERE: `rollback-executor.ts` replays a
    // rollback via `provider.update(..., previousState.properties, ...)`,
    // so the desired bag here can itself be a historical state record — a
    // hard refusal would make the table un-rollbackable with no
    // template-side remedy. A template-path update carrying a CHANGED
    // malformed value never gets here: the pre-flight at the top of this
    // method refuses it before any call (issue #3740); what still reaches
    // this arm on the template path is an unchanged recorded value, for which
    // no flip is requested. An UNUSABLE desired value falls back to the
    // PREVIOUS billing mode, NOT the create-path default: defaulting would
    // make the change detection see a real flip and silently re-price a
    // live table, which is strictly worse than the pre-guard behavior (AWS
    // rejecting the junk value loudly, billing unchanged). An ABSENT value
    // keeps meaning "no flip requested" (no BillingMode sent). The PREVIOUS
    // side stays unguarded on purpose: it comes from cdkd STATE, so
    // refusing a malformed value an older binary recorded would make the
    // stack permanently un-updatable.
    //
    // A state-recorded previous that is itself UNUSABLE is replaced by the
    // table's ACTUAL billing mode (issue #1552). The warn path above keeps
    // the deploy SUCCEEDING, so the engine records the junk desired value
    // as the new state and the NEXT update sees it as the previous side.
    // Comparing a corrected template against that junk previous
    // (`null !== 'PAY_PER_REQUEST'`) reads as a real flip and sends a
    // same-mode `UpdateTable`, which DynamoDB rejects when no capacity
    // change rides along — the deploy fails, state stays unchanged, and the
    // rejection repeats on every deploy. The `DescribeTable` at the top of
    // this method already holds the live mode, so this costs no extra call.
    // An ABSENT previous is NOT unusable: it legitimately means "no billing
    // mode recorded", and seeding it from AWS would turn a no-op update
    // into a spurious change. `BillingModeSummary` is itself absent on a
    // table created without an explicit mode, which is PROVISIONED — the
    // same default `readCurrentState` assumes.
    //
    // An ABSENT value on EITHER side normalizes to the CFn type default
    // PROVISIONED (issue #1553), which is also what `create()` above
    // substitutes — so the two paths now agree on what "no BillingMode in
    // the template" means. Before this the update path left it `undefined`,
    // and a template that REMOVED the property produced a change ("undefined
    // !== PAY_PER_REQUEST") that carried no mutable field: the
    // `updateInput.BillingMode = ...` assignment was gated on the value
    // being truthy, so `UpdateTable({TableName})` went out with nothing to
    // update and DynamoDB rejected it.
    //
    // The reset semantic is MEASURED, not inferred from the type default
    // (live CFn A/B, us-east-1, 2026-08-11): a table deployed with
    // `BillingMode: PAY_PER_REQUEST` and then UPDATE'd with the property
    // REMOVED is FLIPPED to PROVISIONED — and when the template declares no
    // `ProvisionedThroughput` either, the CFn resource handler fails the
    // stack with `Property ProvisionedThroughput cannot be empty` rather
    // than retaining the old mode. So "removal retains" was the wrong
    // reading; removal resets, exactly like `TableClass` below.
    // AWS's own view, named once: the previous-side resolution, the flip
    // detection and the ACTIVE-wait budget all have to agree on it.
    const liveBillingMode = (table?.BillingModeSummary?.BillingMode ?? 'PROVISIONED') as
      | 'PROVISIONED'
      | 'PAY_PER_REQUEST';
    const recordedPrevBillingMode = previousProperties['BillingMode'];
    const recordedPrevBillingModeUsable =
      recordedPrevBillingMode === undefined ||
      (typeof recordedPrevBillingMode === 'string' && recordedPrevBillingMode.trim() !== '');
    const prevBillingMode = (
      recordedPrevBillingModeUsable
        ? ((recordedPrevBillingMode as string | undefined) ??
          // An ABSENT recorded previous resolves differently depending on
          // what the DESIRED side asks for, and the asymmetry is deliberate
          // (review catch):
          //   - desired ALSO absent -> the type default. Both sides
          //     normalize to PROVISIONED, so BillingMode contributes no
          //     change of its own — though a ProvisionedThroughput diff can
          //     still carry the resolved mode along, which is what converges
          //     a live on-demand table the template never declared.
          //   - desired EXPLICIT -> the table's LIVE mode. Taking the type
          //     default here would compare PROVISIONED against an explicit
          //     `BillingMode: PROVISIONED` and SUPPRESS the flip entirely,
          //     leaving a live PAY_PER_REQUEST table on-demand forever while
          //     state records PROVISIONED. Reachable via `cdkd import`,
          //     whose state properties come from the template, not from AWS.
          (properties['BillingMode'] !== undefined ? liveBillingMode : 'PROVISIONED'))
        : liveBillingMode
    ) as 'PROVISIONED' | 'PAY_PER_REQUEST';
    if (!recordedPrevBillingModeUsable) {
      warn(
        `AWS::DynamoDB::Table ${logicalId}: the recorded previous BillingMode is ` +
          // Masked LEAF BY LEAF before `JSON.stringify` escapes anything
          // (issue #1997): a secret carrying a quote, a backslash or a newline
          // no longer OCCURS in the finished line, so the sink alone would
          // miss it. The walk rather than a top-level `typeof` test is
          // load-bearing — this arm fires precisely when the value is NOT a
          // usable string, so the realistic shapes are an array or an object
          // with the secret nested inside. `previousProperties` is a cdkd
          // state record, whose values were resolved by an earlier deploy and
          // can be plaintext.
          `unusable (${JSON.stringify(
            maskLeafValue(recordedPrevBillingMode, maskSecrets)
          )}) — using the table's ` +
          `actual billing mode (${prevBillingMode}) as the comparison baseline for ` +
          `this update so a corrected template does not issue a same-mode UpdateTable.`
      );
    }
    let billingModeUnusable = false;
    // ABSENT resolves to the CFn type default (see the reset note above);
    // present-but-unusable still falls back to the PREVIOUS mode, because
    // there the template DID ask for something and defaulting a junk value
    // would silently re-price a live table.
    const requestedBillingMode =
      properties['BillingMode'] === undefined
        ? 'PROVISIONED'
        : requireConfigString(
            properties['BillingMode'],
            'PROVISIONED',
            'AWS::DynamoDB::Table BillingMode',
            {
              onUnusable: (message) => {
                billingModeUnusable = true;
                // "compared against", not "the table's current mode".
                //
                // This arm is only reachable with a DEFINED desired side (it
                // sits in the `!== undefined` branch above), so
                // `prevBillingMode` resolved to one of exactly two things:
                // the RECORDED previous when the record holds a usable value,
                // else the table's LIVE mode. The CFn type default is NOT
                // reachable from here — that arm needs an absent desired side.
                //
                // NEITHER outcome justifies the word "current". The record can
                // be stale (an out-of-band re-price), and the live mode is
                // itself defaulted to PROVISIONED when `BillingModeSummary` is
                // absent (see the note above `liveBillingMode`), so on both
                // branches "current" asserts a `DescribeTable` reading the
                // message may never have taken.
                //
                // The prefix matches every prefixed sibling in this provider —
                // the recorded-previous baseline warn just above, the
                // BillingMode-flip refusal, the GSI-removal guard and the
                // flip-to-PROVISIONED capacity guard: without it, a stack with
                // more than one AWS::DynamoDB::Table gives neither the user
                // nor an integ assertion any way to tell which table warned.
                // The GlobalTable twin of THIS arm is still unprefixed and
                // still says "current" — same defect, contended file, tracked
                // in issue #1739.
                warn(
                  `AWS::DynamoDB::Table ${logicalId}: ${message} The mode this update ` +
                    `compared against (${prevBillingMode}) is kept rather than flipped to ` +
                    `the default.`
                );
              },
            }
          );
    const billingMode = billingModeUnusable
      ? prevBillingMode
      : (requestedBillingMode as 'PROVISIONED' | 'PAY_PER_REQUEST');
    const billingOrThroughputChanged =
      billingMode !== prevBillingMode ||
      JSON.stringify(properties['ProvisionedThroughput']) !==
        JSON.stringify(previousProperties['ProvisionedThroughput']);
    // A flip INTO PROVISIONED while the template still declares
    // `OnDemandThroughput` is self-contradictory, and issue #1553 made it
    // newly reachable: the flip would be applied first and the on-demand
    // ceiling would then be REJECTED by AWS, leaving the table half-changed.
    //
    // REFUSE BEFORE ANY CALL rather than skipping the block. Skipping was
    // the first fix and a review showed it is the worse of the two: the
    // engine records the DESIRED properties as state after a successful
    // update, so the un-sent ceiling would be recorded as applied and the
    // next deploy would compare the new value against itself and never send
    // it — AWS stuck on the old ceiling permanently. That is the
    // silent-drop class this file refuses everywhere else.
    //
    // A refusal on the update path is normally the thing to avoid (a
    // rollback / `drift --revert` replays `update()` with a STATE record the
    // user cannot edit), but this shape cannot occur in a valid record: no
    // deploy that reaches state can carry it, and `readCurrentState` emits
    // `BillingMode` whenever `BillingModeSummary` exists, which is always
    // true for a live on-demand table. The value is template-borne in every
    // reachable case, so the user can act on the error.
    // `|| liveBillingMode === 'PAY_PER_REQUEST'` (PR review): this refusal
    // keys on the RECORDED previous while the flip itself keys on the LIVE
    // mode, and the two disagree after a `cdkd import` or an out-of-band
    // console flip. Before this change the mismatch was inert — the flip
    // failed anyway for an indexed table — but now that the flip SUCCEEDS,
    // a record saying PROVISIONED against a live on-demand table would slip
    // past the refusal, flip the table, and only then have its
    // `OnDemandThroughput` UpdateTable rejected against a now-provisioned
    // table: a half-applied deploy. Refusing on either side keeps the
    // pre-flight ahead of the mutation.
    // `billingOrThroughputChanged &&` leads (PR review round 2): without it
    // the widened live-mode arm OVER-refuses. When the recorded previous and
    // the desired side both omit `BillingMode`, both normalize to the type
    // default PROVISIONED, so no flip is sent at all — yet a live on-demand
    // table declaring `OnDemandThroughput` would hard-error on a deploy that
    // used to succeed. That shape DOES reach state (it succeeded before), so
    // it would also break the justification below and make a rollback /
    // `drift --revert` replay throw on a record the user cannot edit — the
    // exact class this file exists to avoid. The conjunct cannot weaken the
    // original arm: `prevBillingMode === 'PAY_PER_REQUEST'` with a desired
    // PROVISIONED is a mode change, so the flag is already true there.
    if (
      billingOrThroughputChanged &&
      billingMode === 'PROVISIONED' &&
      (prevBillingMode === 'PAY_PER_REQUEST' || liveBillingMode === 'PAY_PER_REQUEST') &&
      properties['OnDemandThroughput'] !== undefined
    ) {
      const absentNote =
        properties['BillingMode'] === undefined
          ? ' (BillingMode is absent from the template, which CloudFormation resets to PROVISIONED)'
          : '';
      throw new ProvisioningError(
        `AWS::DynamoDB::Table ${logicalId}: the template flips BillingMode to ` +
          `PROVISIONED${absentNote} while still declaring OnDemandThroughput, which AWS ` +
          `accepts only on a PAY_PER_REQUEST table. No BillingMode flip and no index ` +
          `change were applied. Remove ` +
          `OnDemandThroughput, or keep BillingMode: PAY_PER_REQUEST.`,
        // `resourceType` then `logicalId`, which is the CONSTRUCTOR's order
        // and was TRANSPOSED here from issue #1553 until go-to-k/cdkd#3392
        // swept the file: every other `new ProvisioningError` in this
        // provider already passed them this way, so the refusal was reporting
        // `resourceType: 'MyTable'` and `logicalId: 'AWS::DynamoDB::Table'`
        // into the deployment event and the error display.
        resourceType,
        logicalId
      );
    }
    // The PER-INDEX twin of the refusal above (issue
    // [#3392](https://github.com/go-to-k/cdkd/issues/3392)). The arm above
    // keys on `properties['OnDemandThroughput']`, the TABLE block, so a
    // template declaring the ceiling only inside `GlobalSecondaryIndexes[]`
    // slipped past it — and `applyGsiUpdates` has THREE per-index send sites
    // (the `Create` action since issue #3265, and both `Update` arms since
    // issue #3287). DynamoDB accepts `OnDemandThroughput` only on a
    // PAY_PER_REQUEST table, and all three ride the same
    // `GlobalSecondaryIndexUpdates` array, so on a PROVISIONED table AWS
    // rejects the whole request and an otherwise-valid per-index CAPACITY
    // edit sharing that action goes down with it — after the BillingMode flip
    // has already been applied. Refusing here is what keeps the pre-flight
    // ahead of the mutation. (`applyTagDiff` above has already run, exactly
    // as it has for the table-level arm since #1553; the ordering that
    // matters is against the flip and the GSI ops.)
    //
    // A mid-update warn-and-SKIP was the first shape tried, in PR
    // go-to-k/cdkd#3380, and a review returned a BLOCKER against it: the
    // deploy then SUCCEEDS, so the engine records the DESIRED bag including a
    // ceiling AWS never received, and the next deploy — the one where the
    // user FIXES the billing mode — compares desired against that record,
    // finds them equal, and returns before the send. That is #3287's own
    // defect reintroduced through the gate meant to make it safe, and it is
    // the silent-drop class the table-level twin refuses for the same reason.
    //
    // The INPUT is the EFFECTIVE mode, not `billingMode` and not
    // `liveBillingMode` alone. `billingMode` is the normalized DESIRED mode
    // and only reaches AWS when `billingOrThroughputChanged` is true; when
    // that flag is false nothing is sent and the table keeps what it already
    // has. Either binding alone is wrong in a direction this file documents
    // as reachable at the arm above (a `cdkd import`, an out-of-band console
    // flip, `BillingMode` absent on both sides): the desired mode alone
    // FALSELY REFUSES a live on-demand table whose template omits
    // `BillingMode` (both sides normalize to the type default PROVISIONED,
    // yet no flip is sent), and it FALSELY ACCEPTS a live PROVISIONED table
    // whose record and template both say PAY_PER_REQUEST, where the ceiling
    // really is rejected.
    const effectiveBillingMode = billingOrThroughputChanged ? billingMode : liveBillingMode;
    refuseIndexCeilingsUnderProvisioned.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      context,
      maskSecrets,
      warn,
      billingOrThroughputChanged,
      effectiveBillingMode
    );
    // The LIVE index list and the DESIRED index map, hoisted out of the flip
    // block because the pre-flip REMOVAL below needs both before the flip is
    // built, and the flip's per-index capacity block then needs the live list
    // MINUS whatever the removal deleted.
    const liveIndexes = table?.GlobalSecondaryIndexes ?? [];
    const desiredIndexByName = new Map<string, Record<string, unknown>>();
    for (const entry of Array.isArray(properties['GlobalSecondaryIndexes'])
      ? (properties['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)
      : []) {
      const name = entry?.['IndexName'];
      if (typeof name === 'string') desiredIndexByName.set(name, entry);
    }

    // Removing a GSI in the SAME deploy as a flip to PROVISIONED (issue
    // #1617). AWS demands per-index `ProvisionedThroughput` for every index
    // that is LIVE at flip time, and the template no longer declares the
    // removed one, so there is no capacity to send: the flip is rejected
    // (`ProvisionedThroughput must be specified for index: <name>`, measured
    // 2026-08-11) on every deploy, and `applyGsiUpdates` — which owns the
    // Delete op — runs AFTER the flip and is therefore never reached. The
    // deploy could not converge by any template-side edit.
    //
    // So issue the Delete FIRST, which is what CloudFormation does (it
    // succeeds on this shape). Only the removal moves: creates and capacity
    // updates stay after the flip, where the index they describe exists.
    //
    // Scoped to the flip-to-PROVISIONED shape because that is the only one
    // that enumerates live indexes — a flip to PAY_PER_REQUEST needs no
    // per-index capacity, and reordering its removals would be a behavior
    // change with no defect behind it.
    const preFlipDeletedIndexNames = new Set<string>();
    // A present-but-NON-ARRAY desired value (an unresolved intrinsic, a
    // mis-nested template value) reads as an empty desired set above, which
    // would classify EVERY live index as removed and delete them all before
    // the flip (PR review). That shape was non-destructive before this
    // change — the flip block warned and omitted, and `applyGsiUpdates` then
    // threw on `desired.filter` — so the removal is refused here rather than
    // newly destroying data on a malformed template.
    const desiredIndexesUnusable =
      properties['GlobalSecondaryIndexes'] != null &&
      !Array.isArray(properties['GlobalSecondaryIndexes']);
    if (
      billingOrThroughputChanged &&
      billingMode === 'PROVISIONED' &&
      liveBillingMode === 'PAY_PER_REQUEST' &&
      liveIndexes.length > 0 &&
      !desiredIndexesUnusable
    ) {
      // Only an index cdkd's PREVIOUS side knows about is removable here. A
      // live index in neither side was created out of band, and deleting it
      // is not something this deploy asked for — it stays live, lands in the
      // `unspecified` warning below, and AWS rejects the flip by name, which
      // is the same outcome as before this change.
      const previousIndexNames = new Set(
        (Array.isArray(previousProperties['GlobalSecondaryIndexes'])
          ? (previousProperties['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)
          : []
        )
          .map((entry) => entry?.['IndexName'])
          .filter((name): name is string => typeof name === 'string')
      );
      const removable: string[] = [];
      const remainingWithoutCapacity: string[] = [];
      for (const live of liveIndexes) {
        const indexName = live.IndexName;
        if (typeof indexName !== 'string') continue;
        if (!desiredIndexByName.has(indexName)) {
          if (previousIndexNames.has(indexName)) removable.push(indexName);
          else remainingWithoutCapacity.push(indexName);
          continue;
        }
        if (!hasUsableDeclaredCapacity(desiredIndexByName.get(indexName))) {
          remainingWithoutCapacity.push(indexName);
        }
      }
      // PRE-VALIDATE, because a Delete is not undoable. When the flip is
      // DOOMED for a reason already visible here, deleting first buys
      // nothing and leaves a PARTIALLY applied deploy (index gone, mode
      // unchanged) — so the shape is kept at "nothing applied".
      //
      // Two causes are foreseeable, and BOTH must be checked (PR review
      // found the second missing). AWS rejects the flip when an index that
      // will STILL be live declares no usable per-index capacity, and
      // equally when the TABLE-level `ProvisionedThroughput` is absent or
      // unusable — the flip block below deliberately leaves that one to AWS
      // (CFn parity), which is fine for the flip itself but is exactly the
      // deterministic failure a pre-flip delete must not run ahead of.
      const tableCapacityUnusable = !hasUsableTableCapacity(properties['ProvisionedThroughput']);
      if (removable.length > 0 && (remainingWithoutCapacity.length > 0 || tableCapacityUnusable)) {
        // BOTH reasons are reported when both fire (PR review): naming only
        // one sends the user round the loop again — they fix it, re-deploy,
        // and meet the second warning.
        const reasons: string[] = [];
        if (remainingWithoutCapacity.length > 0) {
          reasons.push(
            `index(es) ${remainingWithoutCapacity.join(', ')} stay live and declare no usable ` +
              `per-index ProvisionedThroughput (both ReadCapacityUnits and WriteCapacityUnits ` +
              `are required there)`
          );
        }
        if (tableCapacityUnusable) {
          reasons.push(`the template declares no usable table-level ProvisionedThroughput`);
        }
        warn(
          `AWS::DynamoDB::Table ${logicalId}: this deploy removes global secondary index(es) ` +
            // Index NAMES come out of the resolved `GlobalSecondaryIndexes`
            // bag, so each is masked as a raw value before being joined.
            `${removable.map((n) => maskSecrets(n)).join(', ')} and flips BillingMode to ` +
            `PROVISIONED. The removal would ` +
            `normally be applied BEFORE the flip, but ${reasons.join(' and ')}, so AWS rejects ` +
            `the flip either way. Nothing was removed.`
        );
      } else if (removable.length > 0) {
        // Through the masked `debug` sink in scope (the go-to-k/cdkd#3380
        // round-3 security review, S3): these are index NAMES, resolved
        // property values, and `logger.ts` masks nothing -- a name AWS echoes
        // back is byte-identical to the resolved secret that created it.
        debug(
          `Deleting GSI(s) ${removable.join(', ')} on DynamoDB table ${physicalId} before the ` +
            `BillingMode flip to PROVISIONED`
        );
        // One op per UpdateTable with a full table+indexes ACTIVE wait
        // between each — AWS's one-GSI-op-per-call budget, and the wait is
        // what returns the table to a state that accepts the flip (the same
        // index-status race issue #1553 handles).
        markUnsettled('GlobalSecondaryIndexes');
        await this.runGsiOps(
          physicalId,
          removable.map((name) => ({ Delete: { IndexName: name } })),
          undefined,
          maskSecrets
        );
        for (const name of removable) preFlipDeletedIndexNames.add(name);
        // A failure BETWEEN the deletes and the flip leaves the index gone
        // and the mode unchanged. That partial application is accepted —
        // but only because the NEXT deploy converges, and that is a
        // property of the Delete arm below rather than something to assume.
        //
        // The first version of this comment claimed the next deploy is fine
        // "because the GSI diff is already satisfied", and a PR review
        // showed that was WRONG: cdkd writes state only after `update()`
        // RETURNS, so a mid-update failure leaves the deleted index still
        // recorded in the previous side, and the next deploy would emit a
        // Delete for an index AWS no longer has — the
        // `ResourceNotFoundException` that would fail every subsequent
        // deploy forever, re-creating the very unconvergeable class this
        // change exists to remove. `applyGsiUpdates` therefore skips a
        // Delete for a name that is not LIVE, which makes the arm
        // idempotent and is what actually makes this residual recoverable.
      }
    }

    // The names that are LIVE in AWS right now — the DescribeTable snapshot
    // minus whatever the pre-flip removal just deleted. `applyGsiUpdates`
    // uses it to make its Delete arm IDEMPOTENT (issue #1617 PR review):
    // without it, a state record naming an index AWS no longer has produces
    // a `ResourceNotFoundException` on every deploy forever. That covers the
    // pre-flip deletes AND the pre-existing case of a resource whose index
    // was removed out of band or by an earlier interrupted run.
    //
    // `undefined` when there is no snapshot to reason from, which keeps the
    // pre-change behavior rather than silently skipping every removal.
    const currentLiveIndexNames = table
      ? new Set(
          liveIndexes
            .map((live) => live.IndexName)
            .filter((name): name is string => typeof name === 'string')
            .filter((name) => !preFlipDeletedIndexNames.has(name))
        )
      : undefined;

    // The live per-index DESCRIPTIONS, keyed by name. Populated whenever
    // there is a `DescribeTable` snapshot at all — for EVERY billing mode.
    // The PROVISIONED-only gate is the SEPARATE `liveCapacityComparable`
    // flag below, and conflating the two in this comment used to be
    // harmless prose; it is not any more (PR review round 4), because issue
    // #1768's `warmThroughputOpFor` reads this same map on PAY_PER_REQUEST
    // tables for its idempotency and decrease gates. Saying the map is
    // PROVISIONED-only would now describe those two gates as dead code on
    // the mode where they matter most.
    //
    // What IS PROVISIONED-only is the CAPACITY comparison (issue #1630), and
    // that gate is the whole risk of this change rather than a formality:
    // `DescribeTable` reports `ProvisionedThroughput: {0, 0}` for every index
    // of a PAY_PER_REQUEST table (the #1571 trap), so the numbers mean
    // nothing there — and when THIS deploy is flipping to PROVISIONED, the
    // flip itself delivers the capacity, which `gsiHandledByBillingFlip`
    // already suppresses through a different route.
    const currentLiveIndexByName = table
      ? new Map(
          liveIndexes
            .filter(
              (live): live is typeof live & { IndexName: string } =>
                typeof live.IndexName === 'string'
            )
            .filter((live) => !preFlipDeletedIndexNames.has(live.IndexName))
            .map((live) => [live.IndexName, live] as const)
        )
      : undefined;

    // Whether the live capacity NUMBERS are meaningful. `DescribeTable`
    // reports `ProvisionedThroughput: {0, 0}` for every index of a
    // PAY_PER_REQUEST table (the #1571 trap), and when THIS deploy is
    // flipping to PROVISIONED the flip itself delivers the capacity — so the
    // capacity half of the idempotency check stays off in both cases while
    // the EXISTENCE half still applies.
    const liveCapacityComparable = liveBillingMode === 'PROVISIONED';

    // Index names whose capacity the BillingMode flip below already delivered.
    // `applyGsiUpdates` must NOT re-assert them: real AWS rejects a no-op
    // capacity change outright (`The provisioned throughput for the index X
    // will not change. The requested value equals the current value.`), so
    // the second UpdateTable fails the whole deploy. Found by the
    // `dynamodb-ondemand` integ on the first run of this change — the unit
    // tests could not see it, because each mocks ONE call and the defect is
    // an interaction BETWEEN two of them (issue #1588). Same mechanism as
    // `gsiHandledByBillingFlip` in `dynamodb-globaltable-provider.ts`.
    const gsiHandledByBillingFlip = new Set<string>();
    await applyBillingModeUpdate.call(
      this,
      logicalId,
      physicalId,
      properties,
      previousProperties,
      markUnsettled,
      maskSecrets,
      warn,
      normalizeTableClass,
      tableClassChanged,
      liveBillingMode,
      prevBillingMode,
      billingMode,
      billingOrThroughputChanged,
      liveIndexes,
      desiredIndexByName,
      preFlipDeletedIndexNames,
      gsiHandledByBillingFlip
    );

    await applyThroughputUpdates.call(
      this,
      logicalId,
      physicalId,
      properties,
      previousProperties,
      markUnsettled,
      maskSecrets,
      debug,
      table,
      effectiveBillingMode
    );

    await applySseAndDeletionProtectionUpdates.call(
      this,
      logicalId,
      physicalId,
      properties,
      previousProperties,
      markUnsettled,
      maskSecrets,
      warn,
      debug,
      deletionProtectionChanged,
      sseChanged,
      sseRefusal,
      table
    );

    latestStreamArn = await applyStreamSpecificationUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      markUnsettled,
      maskSecrets,
      table,
      latestStreamArn
    );

    await applyIndexUpdates.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context,
      markUnsettled,
      maskSecrets,
      table,
      vectorIndexPlan,
      effectiveBillingMode,
      currentLiveIndexNames,
      currentLiveIndexByName,
      liveCapacityComparable,
      gsiHandledByBillingFlip
    );

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: table?.TableArn,
        TableId: table?.TableId,
        StreamArn: latestStreamArn,
        TableName: physicalId,
      },
    };
  } catch (error) {
    // Preserve already-actionable ProvisioningErrors (e.g. the TTL
    // attribute-name-change guard, the ResourcePolicy-ARN guard) verbatim
    // instead of double-wrapping them behind a generic "Failed to update"
    // prefix. Mirrors the create() catch.
    if (error instanceof ProvisioningError) {
      throw error;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update DynamoDB table ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
