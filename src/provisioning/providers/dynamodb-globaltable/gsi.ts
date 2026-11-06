import type {
  GlobalSecondaryIndex,
  OnDemandThroughput,
  ProvisionedThroughput,
} from '@aws-sdk/client-dynamodb';
import { coerceCfnInteger } from '../../config-shape.js';
import { coerceWarmThroughput } from '../../dynamodb-warm-throughput.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { TABLE_READ_PROVISIONED_KEY } from './replica-shape.js';
import { DEFAULT_CAPACITY_UNITS, asRecord } from './capacity.js';
import {
  warmThroughputDiagnostic,
  mergeExplicitThroughputBlock,
  reportUnresolvedRawMember,
  reportUnresolvedProvisionedCapacity,
  deriveWriteCapacityUnits,
  deriveReadCapacityUnits,
  globalSecondaryIndexesShapeDetail,
  type ThroughputDiagnostic,
  type CapacitySource,
} from './throughput.js';

/**
 * Translate the CFn `AWS::DynamoDB::GlobalTable` `GlobalSecondaryIndexes[]`
 * blob into the SDK's `GlobalSecondaryIndex[]` shape (Issue #1387).
 *
 * The two schemas model per-GSI throughput COMPLETELY differently, and the
 * AWS SDK v3 serializer silently drops unknown members — so the pre-fix raw
 * cast meant a PROVISIONED GlobalTable with a GSI failed `CreateTable`
 * outright (AWS requires `ProvisionedThroughput` on every GSI), and every
 * `TableV2` per-GSI on-demand limit vanished without a trace.
 *
 * Verified mapping (CFn registry schema `AWS::DynamoDB::GlobalTable` +
 * `@aws-sdk/client-dynamodb` `models_0.d.ts`, both read 2026-08-09; the CFn
 * side additionally confirmed against a real `cdk synth` of `TableV2` with a
 * GSI under both billing modes):
 *
 * | CFn                                                                    | SDK                                     |
 * | ---------------------------------------------------------------------- | --------------------------------------- |
 * | `GSI.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings` | `ProvisionedThroughput.WriteCapacityUnits` |
 * | `Replicas[local].GlobalSecondaryIndexes[].ReadProvisionedThroughputSettings.ReadCapacityUnits` | `ProvisionedThroughput.ReadCapacityUnits` |
 * | `GSI.WriteOnDemandThroughputSettings.MaxWriteRequestUnits`             | `OnDemandThroughput.MaxWriteRequestUnits` |
 * | `Replicas[local].GlobalSecondaryIndexes[].ReadOnDemandThroughputSettings.MaxReadRequestUnits` | `OnDemandThroughput.MaxReadRequestUnits` |
 * | `GSI.WarmThroughput`                                                   | `WarmThroughput` (same spelling)        |
 *
 * READ capacity really does live on the REPLICA's GSI entry, not on the
 * top-level GSI — CDK's `globalSecondaryIndexes[].readCapacity` synthesizes
 * to `Replicas[?Region==<deploy region>].GlobalSecondaryIndexes[].
 * ReadProvisionedThroughputSettings`. `CreateTable` only ever provisions the
 * LOCAL replica, so the local entry is the right source. The GSI-level
 * `ReadProvisionedThroughputSettings` / `ReadOnDemandThroughputSettings`
 * (which the schema also permits) are honored as a fallback for
 * hand-authored templates.
 *
 * Already-SDK-shaped `ProvisionedThroughput` / `OnDemandThroughput` members
 * win over the derivation: the CFn schema forbids them, but cdkd state
 * written before this fix (and hand-authored templates) can carry them, and
 * silently re-deriving over an explicit value would be a regression.
 */
export function toSdkGlobalSecondaryIndexes(
  properties: Record<string, unknown>,
  region: string,
  billingMode: string,
  source: CapacitySource = 'min',
  diagnostics?: ThroughputDiagnostic[],
  onUnusableIndexes?: (message: string) => void,
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178). Threaded
  // on to every diagnostic helper this function calls, so the whole GSI
  // translation masks by construction rather than per author-memory.
  maskSecrets: MaskerFn = (text) => text
): GlobalSecondaryIndex[] {
  const rawIndexes = properties['GlobalSecondaryIndexes'];
  // A NON-ARRAY value (an unresolved `Fn::If`, a malformed template) must not
  // collapse to "no indexes": that would create the table with ZERO GSIs and
  // report success, which is the very silent-drop class this function exists
  // to close, one level up. Absent is legitimately empty; present-but-wrong
  // is an error, and naming it here beats AWS's opaque 400. Matches the
  // per-ENTRY policy below, which also refuses to swallow a bad entry.
  //
  // `onUnusableIndexes` (issue #1544) is the STATE-REPLAY downgrade, wired
  // from `replayWarn` at the `create()` call site and — since issue #1551 —
  // from `update()` too: on the rollback executor's reverse-replacement
  // replay (create) and on a rollback / `drift --revert` replay (update) the
  // properties are a cdkd state record the user cannot edit, so the refusal
  // would leave the old table unrestorable / un-rollbackable. This helper
  // always returns the well-defined EMPTY list on the downgrade — never a
  // fabricated value — and the CALLER states the consequence in its warning,
  // because the two differ: on create an empty list means "a table with no
  // indexes", while on update it would mean "delete every live index", which
  // is why `update()` suppresses its GSI diff instead of applying the result.
  // Any call site that leaves the hook undefined keeps the refusal.
  const shapeDetail = globalSecondaryIndexesShapeDetail(rawIndexes, maskSecrets);
  if (shapeDetail !== undefined) {
    if (onUnusableIndexes) {
      onUnusableIndexes(shapeDetail);
      return [];
    }
    // A plain Error on purpose: this is a module-level pure helper with no
    // logicalId to build a ProvisioningError from. `update()` runs inside a
    // wrapping catch that converts it; `create()` does NOT, so its call site
    // converts it explicitly. Both paths therefore surface a ProvisioningError
    // carrying the resource context.
    throw new Error(
      `${shapeDetail} An unresolved intrinsic here would otherwise deploy a table with no indexes.`
    );
  }
  const cfnIndexes = (rawIndexes ?? []) as unknown[];
  if (cfnIndexes.length === 0) return [];

  const replicas = (properties['Replicas'] ?? []) as Array<Record<string, unknown>>;
  const localReplica = Array.isArray(replicas)
    ? replicas.find((r) => asRecord(r)?.['Region'] === region)
    : undefined;
  const localReplicaIndexes = (localReplica?.['GlobalSecondaryIndexes'] ?? []) as unknown[];
  const localByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(localReplicaIndexes)) {
    for (const entry of localReplicaIndexes) {
      const record = asRecord(entry);
      const name = record?.['IndexName'];
      if (record && typeof name === 'string') localByName.set(name, record);
    }
  }

  const result: GlobalSecondaryIndex[] = [];
  for (const entry of cfnIndexes) {
    const gsi = asRecord(entry);
    // A non-object entry is an unresolved intrinsic or a malformed
    // template — pass it through untouched so AWS surfaces the real
    // validation error instead of cdkd swallowing it.
    if (!gsi) {
      result.push(entry as GlobalSecondaryIndex);
      continue;
    }
    const indexName = gsi['IndexName'] as string | undefined;
    const localEntry = typeof indexName === 'string' ? localByName.get(indexName) : undefined;

    const sdk: GlobalSecondaryIndex = {
      IndexName: indexName,
      KeySchema: gsi['KeySchema'] as GlobalSecondaryIndex['KeySchema'],
      Projection: gsi['Projection'] as GlobalSecondaryIndex['Projection'],
    };
    // `WarmThroughput` is coerced HERE, in the one translation every send site
    // reads from (issue #1857). Doing it at the three `UpdateTable` sites
    // instead would leave `create()` forwarding the raw bag, and would let the
    // "did it change?" comparisons at two of those sites run on a raw previous
    // side against a coerced desired one — where a state-recorded `12000` and
    // a template's `'12000'` read as a change and re-issue a pointless call.
    // Translating once makes both sides numbers and the wire shape identical.
    const warmCoercion = coerceWarmThroughput(gsi['WarmThroughput']);
    if (warmCoercion.spec) {
      sdk.WarmThroughput = warmCoercion.spec;
    }
    const warmDiagnostic = warmThroughputDiagnostic(
      gsi['WarmThroughput'],
      warmCoercion,
      typeof indexName === 'string' ? indexName : undefined
    );
    if (warmDiagnostic) diagnostics?.push(warmDiagnostic);

    // An explicit already-SDK-shaped block is MERGED over the derived one, per
    // member, after coercion, and only on the side the billing mode allows
    // (issue #1428 — the pre-fix code forwarded it verbatim, which skipped
    // coercion, let a partial block suppress valid derived siblings, and sent
    // a PROVISIONED block on a PAY_PER_REQUEST table). The CFn schema forbids
    // these members, so this only fires for pre-#1387 cdkd state and
    // hand-authored templates.
    const explicitProvisioned = asRecord(gsi['ProvisionedThroughput']);
    const explicitOnDemand = asRecord(gsi['OnDemandThroughput']);
    // The billing gate drops the block AWS would reject rather than
    // forwarding it into a guaranteed 400. Reported, never silent: the
    // template did ask for something, and dropping it without a word is the
    // same silent-wrong-action class the merge exists to remove.
    if (explicitProvisioned && billingMode !== 'PROVISIONED') {
      diagnostics?.push({
        kind: 'billing-mode-mismatch',
        ...(typeof indexName === 'string' && { indexName }),
        member: 'ProvisionedThroughput',
        message:
          `an explicit ProvisionedThroughput block was dropped because the table's ` +
          `BillingMode is ${billingMode}; AWS rejects provisioned capacity on an ` +
          `on-demand table. Remove the block, or set BillingMode: PROVISIONED.`,
      });
    }
    if (explicitOnDemand && billingMode === 'PROVISIONED') {
      diagnostics?.push({
        kind: 'billing-mode-mismatch',
        ...(typeof indexName === 'string' && { indexName }),
        member: 'OnDemandThroughput',
        message:
          `an explicit OnDemandThroughput block was dropped because the table's ` +
          `BillingMode is PROVISIONED; AWS rejects on-demand ceilings on a ` +
          `provisioned table. Remove the block, or set BillingMode: PAY_PER_REQUEST.`,
      });
    }

    if (billingMode === 'PROVISIONED') {
      // Capacity diagnostics fire from HERE, where the value is lost, for the
      // same reason the on-demand ones do (#1444 A): the per-GSI reset gate in
      // `update()` never runs for a first-time set or across a billing flip,
      // which are the two likeliest ways to hit this (#1511).
      const rawLocalRead = localEntry?.['ReadProvisionedThroughputSettings'];
      const rawGsiRead = gsi['ReadProvisionedThroughputSettings'];
      const rawWrite = gsi['WriteProvisionedThroughputSettings'];
      const derivedRead =
        deriveReadCapacityUnits(asRecord(rawLocalRead), source) ??
        deriveReadCapacityUnits(asRecord(rawGsiRead), source);
      const derivedWrite = deriveWriteCapacityUnits(asRecord(rawWrite), source);
      // An explicit SDK-shaped member wins in the merge below, so a value it
      // supplies is what reaches AWS and there is nothing to warn about.
      // The merge's own reader (`coerceCfnInteger`), so "covers" means the
      // member really reaches AWS: on the wider `toFiniteNumber` a padded
      // `" 7 "` counted as covered while the merge dropped it and the derived
      // default stood in with no diagnostic (issue #3135).
      const explicitCovers = (member: string): boolean =>
        explicitProvisioned !== undefined &&
        coerceCfnInteger(explicitProvisioned[member]) !== undefined;
      if (derivedRead === undefined && !explicitCovers('ReadCapacityUnits')) {
        // The replica spelling is the canonical CDK one and is blamed when
        // DECLARED, matching the on-demand half's choice of which of the two
        // read spellings to name.
        const fromReplica = rawLocalRead !== undefined;
        reportUnresolvedProvisionedCapacity(
          fromReplica ? rawLocalRead : rawGsiRead,
          'Read',
          source,
          { appliedUnits: DEFAULT_CAPACITY_UNITS },
          diagnostics,
          {
            ...(typeof indexName === 'string' && { indexName }),
            blockName: fromReplica
              ? 'Replicas[local].GlobalSecondaryIndexes[].ReadProvisionedThroughputSettings'
              : 'ReadProvisionedThroughputSettings',
          },
          maskSecrets
        );
      }
      if (derivedWrite === undefined && !explicitCovers('WriteCapacityUnits')) {
        reportUnresolvedProvisionedCapacity(
          rawWrite,
          'Write',
          source,
          { appliedUnits: DEFAULT_CAPACITY_UNITS },
          diagnostics,
          {
            ...(typeof indexName === 'string' && { indexName }),
            blockName: 'WriteProvisionedThroughputSettings',
          },
          maskSecrets
        );
      }
      // The derived side always yields both members (defaulting to 5/5), so
      // the merge can never come back `undefined` here — AWS REQUIRES
      // `ProvisionedThroughput` on every GSI of a provisioned table.
      sdk.ProvisionedThroughput = mergeExplicitThroughputBlock<ProvisionedThroughput>(
        explicitProvisioned,
        {
          ReadCapacityUnits: derivedRead ?? DEFAULT_CAPACITY_UNITS,
          WriteCapacityUnits: derivedWrite ?? DEFAULT_CAPACITY_UNITS,
        },
        ['ReadCapacityUnits', 'WriteCapacityUnits'],
        diagnostics,
        {
          ...(typeof indexName === 'string' && { indexName }),
          blockName: 'ProvisionedThroughput',
        },
        maskSecrets
      );
    } else {
      // Raw-key diagnostics fire regardless of whether the value survives
      // coercion, and regardless of whether this index ends up `modified` —
      // that is the whole point of raising them here (#1444 A).
      const rawWrite = asRecord(gsi['WriteOnDemandThroughputSettings'])?.['MaxWriteRequestUnits'];
      const rawReadLocal = asRecord(localEntry?.['ReadOnDemandThroughputSettings'])?.[
        'MaxReadRequestUnits'
      ];
      const rawReadGsi = asRecord(gsi['ReadOnDemandThroughputSettings'])?.['MaxReadRequestUnits'];
      reportUnresolvedRawMember(
        rawWrite,
        diagnostics,
        {
          ...(typeof indexName === 'string' && { indexName }),
          blockName: 'WriteOnDemandThroughputSettings',
          member: 'MaxWriteRequestUnits',
        },
        maskSecrets
      );
      // The replica spelling is the canonical CDK one and wins when it
      // coerces, so only report the GSI-level fallback when the replica entry
      // contributed nothing — otherwise a hand-authored leftover would draw a
      // warning about a value that was never going to be used.
      const rawRead = rawReadLocal !== undefined ? rawReadLocal : rawReadGsi;
      reportUnresolvedRawMember(
        rawRead,
        diagnostics,
        {
          ...(typeof indexName === 'string' && { indexName }),
          blockName:
            rawReadLocal !== undefined
              ? 'Replicas[local].GlobalSecondaryIndexes[].ReadOnDemandThroughputSettings'
              : 'ReadOnDemandThroughputSettings',
          member: 'MaxReadRequestUnits',
        },
        maskSecrets
      );

      const maxWrite = coerceCfnInteger(rawWrite);
      const maxRead = coerceCfnInteger(rawReadLocal) ?? coerceCfnInteger(rawReadGsi);
      const merged = mergeExplicitThroughputBlock<OnDemandThroughput>(
        explicitOnDemand,
        {
          ...(maxRead !== undefined && { MaxReadRequestUnits: maxRead }),
          ...(maxWrite !== undefined && { MaxWriteRequestUnits: maxWrite }),
        },
        ['MaxReadRequestUnits', 'MaxWriteRequestUnits'],
        diagnostics,
        { ...(typeof indexName === 'string' && { indexName }), blockName: 'OnDemandThroughput' },
        maskSecrets
      );
      if (merged) sdk.OnDemandThroughput = merged;
    }

    result.push(sdk);
  }
  return result;
}

/**
 * Remove every PROVISIONED-only capacity member from a desired-property bag
 * (issue #1726).
 *
 * Used by `create()`'s `BillingMode` warn-and-SUBSTITUTE arm and by its ABSENT
 * sibling: whenever the create resolves to `PAY_PER_REQUEST` on a bag that was
 * not written for it, the same create skips `createParams.ProvisionedThroughput`
 * and every per-index / per-replica provisioned member is dropped before the
 * call (each of the reads below is gated on `billingMode === 'PROVISIONED'`).
 * Recording those keys describes capacity AWS never received.
 *
 * The set is the intersection of two questions, and BOTH are needed — taking
 * either alone is what the review of the first cut corrected:
 *
 * - **what could not have been SENT** — every member `toSdkGlobalSecondaryIndexes`
 *   / `toSdkReplicaThroughputOverrides` read behind a PROVISIONED gate, which
 *   includes the two legacy SDK-shaped spellings a pre-#1387 cdkd wrote into
 *   state (`GlobalSecondaryIndexes[].ProvisionedThroughput`,
 *   `Replicas[].ProvisionedThroughputOverride`). A state replay is exactly that
 *   population, so leaving them out made the strip narrower than its own rule.
 * - **what `readCurrentState` can REPORT under the new mode** — the top-level
 *   `WriteProvisionedThroughputSettings` emits `{}` for an on-demand table and
 *   every other member here is omitted entirely, so a surviving key is a record
 *   the readback can never match.
 *
 * DELIBERATELY NOT removed: every `*OnDemand*` member. `OnDemandThroughput` is
 * attached to `CreateTable` precisely when the mode is not PROVISIONED, so those
 * WERE sent — a blanket "strip anything throughput-shaped" would record a loss
 * that did not happen, and a unit row plus an integ phase fence exactly that.
 *
 * Pure and non-mutating at every level — the caller's bag is
 * `previousState.properties` on the replay path and the rollback executor
 * spreads the answer shallowly, so an in-place edit would corrupt a record the
 * caller still holds.
 */
export function stripProvisionedCapacityKeys(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...properties };
  delete result['WriteProvisionedThroughputSettings'];
  delete result[TABLE_READ_PROVISIONED_KEY];
  // Note the deliberate asymmetry with the replica-index husk pruning below: a
  // top-level array is left as-is (even when empty), while an ALREADY-empty
  // `Replicas[].GlobalSecondaryIndexes` is removed along with the husks.
  // `readCurrentState` never emits that key as `[]`, so removing it converges
  // either way, and special-casing "empty on the way in" would buy nothing.

  const indexes = result['GlobalSecondaryIndexes'];
  if (Array.isArray(indexes)) {
    result['GlobalSecondaryIndexes'] = indexes.map((entry) => {
      const gsi = asRecord(entry);
      if (!gsi) return entry;
      const copy = { ...gsi };
      delete copy['WriteProvisionedThroughputSettings'];
      // The hand-authored fallback the translator reads only under PROVISIONED
      // (the CFn shape puts the READ half on the replica), and the pre-#1387
      // SDK spelling.
      delete copy['ReadProvisionedThroughputSettings'];
      delete copy['ProvisionedThroughput'];
      return copy;
    });
  }

  const replicas = result['Replicas'];
  if (Array.isArray(replicas)) {
    result['Replicas'] = replicas.map((entry) => {
      const replica = asRecord(entry);
      if (!replica) return entry;
      const copy = { ...replica };
      delete copy['ReadProvisionedThroughputSettings'];
      delete copy['ProvisionedThroughputOverride'];
      const replicaIndexes = copy['GlobalSecondaryIndexes'];
      if (Array.isArray(replicaIndexes)) {
        const stripped = replicaIndexes.map((indexEntry) => {
          const gsi = asRecord(indexEntry);
          if (!gsi) return indexEntry;
          const indexCopy = { ...gsi };
          delete indexCopy['ReadProvisionedThroughputSettings'];
          delete indexCopy['ProvisionedThroughputOverride'];
          return indexCopy;
        });
        // An entry whose ONLY remaining member is `IndexName` is a HUSK: the
        // per-replica index block exists solely to carry capacity overrides,
        // and `readCurrentState` attaches `Replicas[].GlobalSecondaryIndexes`
        // only for entries with more than `IndexName`
        // (`Object.keys(replicaEntry).length > 1`). Leaving the husk behind
        // re-creates the phantom drift this strip exists to remove, one level
        // down — measured live: `cdkd drift` reported the whole `Replicas`
        // array as changed because the baseline carried `[{IndexName:"gsi1"}]`
        // and the readback carried no key at all. Drop the husks, and drop the
        // key entirely when none survives.
        const kept = stripped.filter((entry) => {
          const gsi = asRecord(entry);
          if (!gsi) return true;
          return Object.keys(gsi).some((k) => k !== 'IndexName');
        });
        if (kept.length > 0) {
          copy['GlobalSecondaryIndexes'] = kept;
        } else {
          delete copy['GlobalSecondaryIndexes'];
        }
      }
      return copy;
    });
  }

  return result;
}

/**
 * The capacity member keys that can only reach AWS while the table is
 * PROVISIONED, per container level (issue #1738).
 *
 * Identical to the set {@link stripProvisionedCapacityKeys} removes, and that
 * is not a coincidence: both answer "which members are unsendable once the mode
 * is PAY_PER_REQUEST". The two spellings a pre-#1387 cdkd wrote into state
 * (`ProvisionedThroughput` / `ProvisionedThroughputOverride`) are included for
 * the same reason — a state replay is exactly that population.
 */
const PROVISIONED_ONLY_CAPACITY_KEYS = {
  table: ['WriteProvisionedThroughputSettings', 'ReadProvisionedThroughputSettings'],
  index: [
    'WriteProvisionedThroughputSettings',
    'ReadProvisionedThroughputSettings',
    'ProvisionedThroughput',
  ],
  replica: ['ReadProvisionedThroughputSettings', 'ProvisionedThroughputOverride'],
  replicaIndex: ['ReadProvisionedThroughputSettings', 'ProvisionedThroughputOverride'],
} as const;

/**
 * The mirror set: capacity members that can only reach AWS while the table is
 * PAY_PER_REQUEST (issue #1738).
 *
 * `stripProvisionedCapacityKeys` has no equivalent because the create arm it
 * serves always substitutes PAY_PER_REQUEST — the mode under which these ARE
 * sent, which is why its header says they are deliberately not stripped. On the
 * UPDATE path the kept mode can be PROVISIONED, and then it is this half that
 * never leaves the process.
 */
const ON_DEMAND_ONLY_CAPACITY_KEYS = {
  table: ['WriteOnDemandThroughputSettings', 'ReadOnDemandThroughputSettings'],
  index: [
    'WriteOnDemandThroughputSettings',
    'ReadOnDemandThroughputSettings',
    'OnDemandThroughput',
  ],
  replica: ['ReadOnDemandThroughputSettings', 'OnDemandThroughputOverride'],
  replicaIndex: ['ReadOnDemandThroughputSettings', 'OnDemandThroughputOverride'],
} as const;

/**
 * Replace every capacity member the KEPT billing mode cannot send with the
 * PREVIOUS record's value (issue #1738).
 *
 * Called from `update()`'s `BillingMode` warn-and-KEEP arm, where an unusable
 * desired mode suppresses the flip: AWS is left holding the mode it already
 * had, so every block belonging to the OTHER mode was silently dropped on the
 * way out while the engine recorded what the template declared.
 *
 * **The split is per MEMBER against the KEPT mode**, and each side was read off
 * the gates in this file rather than off the member's name-shape (the
 * name-shape trap #1726 records — an on-demand ceiling looks like capacity and
 * goes on the wire under precisely the on-demand mode):
 *
 * - KEPT `PROVISIONED` — the on-demand half is unsendable. Step 3's table-level
 *   `OnDemandThroughput` is gated on `newBilling !== 'PROVISIONED'`;
 *   `toSdkGlobalSecondaryIndexes` and `toSdkReplicaThroughputOverrides` both
 *   drop their on-demand branch under PROVISIONED. The provisioned half is NOT
 *   retained: step 4b and step 6b's auto-scaling reconcile are live whenever
 *   either side is PROVISIONED, and step 6's GSI diff carries per-index
 *   `ProvisionedThroughput` — those blocks really are applied.
 * - KEPT `PAY_PER_REQUEST` — the provisioned half is unsendable. The table-level
 *   `ProvisionedThroughput` rides step 4's flip and nothing else, the two
 *   auto-scaling reconciles are gated on either side being PROVISIONED, and both
 *   translators drop their provisioned branch. The on-demand half is NOT
 *   retained: step 3 sends the table-level ceilings and step 6 the per-index
 *   ones under exactly this mode.
 *
 * One residual is deliberately NOT covered, because the suppression did not
 * create it: the TABLE-level provisioned capacity NUMBER rides step 4's flip
 * and nothing else, so on ANY non-flip PROVISIONED -> PROVISIONED update it is
 * unsent while its `*CapacityAutoScalingSettings` sibling in the same block IS
 * reconciled. Retaining the block wholesale under a kept PROVISIONED mode would
 * therefore erase a real auto-scaling update to hide a pre-existing gap — so
 * the block stays as declared and the gap stays where it already lives.
 *
 * Retaining rather than DROPPING is the UPDATE row of
 * `.claude/rules/providers.md`: the call never ran, so AWS still holds the
 * previously-applied block and that IS what state should describe. Dropping
 * would leave a later template that REMOVES the block deriving no removal, so
 * the live setting would survive forever.
 *
 * **The previous side is VALIDATED before it is retained** (the #1653-review
 * rule) through `asRecord` — the SAME predicate every wire read of these blocks
 * applies, so the two cannot disagree about what a bare string / an array / a
 * number means. Be honest about what that buys: it refuses exactly the
 * not-a-plain-object shapes, and a block whose NUMERIC member is an unresolved
 * intrinsic passes it, because the wire accepts that block too (and then sends
 * nothing for the member, which is the same "AWS keeps what it had" outcome).
 * When the previous side is unusable OR absent the key is DROPPED — there is no
 * value cdkd can vouch for either way.
 *
 * COPIES each retained block one level rather than aliasing it: the rollback
 * executor spreads the returned bag shallowly, so handing back the previous
 * record's own object would leave two state records sharing one mutable value.
 * Scope that claim honestly — it covers the retained blocks only; every other
 * key of the input bag stays aliased, exactly as the sibling arms leave it.
 *
 * Deliberately NOT paired with a `canonicalizeDesiredProperties` twin: this is
 * a SKIP, not a narrowing, so there is no pure function of the desired bag to
 * fold both comparison sides with, and folding one would derive a REMOVAL of a
 * live capacity block from a template whose only fault is `BillingMode`.
 *
 * Pure and non-mutating at every level.
 */
export function retainUnsendableCapacityMembers(
  desired: Record<string, unknown>,
  previous: Record<string, unknown>,
  keptBillingMode: string
): Record<string, unknown> {
  const unsendable =
    keptBillingMode === 'PROVISIONED'
      ? ON_DEMAND_ONLY_CAPACITY_KEYS
      : PROVISIONED_ONLY_CAPACITY_KEYS;

  const result = retainCapacityKeys({ ...desired }, previous, unsendable.table);

  const indexes = result['GlobalSecondaryIndexes'];
  if (Array.isArray(indexes)) {
    const previousIndexes = indexCapacityContainers(
      previous['GlobalSecondaryIndexes'],
      'IndexName'
    );
    result['GlobalSecondaryIndexes'] = indexes.map((entry) => {
      const gsi = asRecord(entry);
      if (!gsi) return entry;
      const previousGsi = previousIndexes.get(gsi['IndexName']);
      return retainCapacityKeys({ ...gsi }, previousGsi, unsendable.index);
    });
  }

  const replicas = result['Replicas'];
  if (Array.isArray(replicas)) {
    const previousReplicas = indexCapacityContainers(previous['Replicas'], 'Region');
    result['Replicas'] = replicas.map((entry) => {
      const replica = asRecord(entry);
      if (!replica) return entry;
      const previousReplica = previousReplicas.get(replica['Region']);
      const copy = retainCapacityKeys({ ...replica }, previousReplica, unsendable.replica);
      const replicaIndexes = copy['GlobalSecondaryIndexes'];
      if (Array.isArray(replicaIndexes)) {
        const previousReplicaIndexes = indexCapacityContainers(
          previousReplica?.['GlobalSecondaryIndexes'],
          'IndexName'
        );
        const retained = replicaIndexes.map((indexEntry) => {
          const gsi = asRecord(indexEntry);
          if (!gsi) return indexEntry;
          const previousGsi = previousReplicaIndexes.get(gsi['IndexName']);
          return retainCapacityKeys({ ...gsi }, previousGsi, unsendable.replicaIndex);
        });
        // Same HUSK prune `stripProvisionedCapacityKeys` applies, for the same
        // measured reason: a per-replica index block exists ONLY to carry
        // capacity overrides, and `readCurrentState` attaches
        // `Replicas[].GlobalSecondaryIndexes` only for entries with more than
        // `IndexName`. A DROP arm above can empty an entry down to that husk, so
        // without this the fix would close one never-matchable shape by opening
        // another — live-measured on the sibling as `cdkd drift` reporting the
        // whole `Replicas` array as changed.
        const kept = retained.filter((entry) => {
          const gsi = asRecord(entry);
          if (!gsi) return true;
          return Object.keys(gsi).some((k) => k !== 'IndexName');
        });
        if (kept.length > 0) {
          copy['GlobalSecondaryIndexes'] = kept;
        } else {
          delete copy['GlobalSecondaryIndexes'];
        }
      }
      return copy;
    });
  }

  return result;
}

/**
 * Retain (or drop) one container's unsendable capacity members, in place on a
 * bag the caller already copied.
 *
 * The counterpart container being `undefined` — no matching index / replica in
 * the previous record — is the ABSENT case, not a special one: there is nothing
 * to vouch for, so the key is dropped exactly as it is for an unusable value.
 */
function retainCapacityKeys(
  target: Record<string, unknown>,
  previousContainer: Record<string, unknown> | undefined,
  keys: readonly string[]
): Record<string, unknown> {
  for (const key of keys) {
    const previousValue = asRecord(previousContainer?.[key]);
    if (previousValue) {
      target[key] = { ...previousValue };
    } else {
      delete target[key];
    }
  }
  return target;
}

/**
 * Index a previous-side array by its identity member, so a per-index /
 * per-replica retain reads the counterpart entry rather than the positional
 * one — AWS does not guarantee readback order and a template edit can reorder
 * either list.
 */
function indexCapacityContainers(
  value: unknown,
  identityKey: 'IndexName' | 'Region'
): Map<unknown, Record<string, unknown>> {
  const byIdentity = new Map<unknown, Record<string, unknown>>();
  if (!Array.isArray(value)) return byIdentity;
  for (const entry of value) {
    const record = asRecord(entry);
    const identity = record?.[identityKey];
    if (record && typeof identity === 'string') byIdentity.set(identity, record);
  }
  return byIdentity;
}

/**
 * True when a CFn sub-object is nothing but an unresolved intrinsic
 * (`{"Fn::If": […]}` / `{"Ref": …}`), i.e. the template DID declare the block
 * but its value could not be resolved to a shape with members.
 *
 * Needed because presence is otherwise tested on the MEMBER key: an
 * intrinsic-valued block IS a record, so `asRecord` succeeds while
 * `['MaxReadRequestUnits']` is undefined — reporting "not declared" and firing
 * the destructive `-1` reset on a ceiling the template was trying to SET. That
 * is issue #1440 one level up from where the member test looks.
 */
export function isUnresolvedIntrinsicBlock(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const keys = Object.keys(record);
  return keys.length > 0 && keys.every((k) => k === 'Ref' || k.startsWith('Fn::'));
}

/** Which on-demand members a GSI's CFn side actually DECLARES (issue #1440). */
export interface RawOnDemandDeclaration {
  readonly readDeclared: boolean;
  readonly writeDeclared: boolean;
}

/**
 * Per-index RAW presence of the two per-GSI on-demand members, keyed by
 * `IndexName` (issue #1440).
 *
 * The per-GSI reset needs to know "did the template DROP this member", and the
 * only faithful answer is whether the CFn key is THERE — not whether its value
 * coerced. `toSdkGlobalSecondaryIndexes` runs every value through
 * `coerceCfnInteger`, which returns `undefined` for a present-but-
 * unparseable value (an unresolved `{Ref: …}`, `''`, an object). Deciding
 * "dropped" from that collapsed view sent the `-1` reset for a member the
 * template was actively trying to SET, silently clearing the ceiling — the same
 * silent-wrong-action class the reset exists to remove, and the exact hazard
 * the table-level path was corrected for in #1434's PR.
 *
 * So this walks the same two sources as `toSdkGlobalSecondaryIndexes` — the
 * top-level GSI for the write half, the LOCAL replica's index entry (with the
 * GSI-level spelling as the documented fallback) for the read half — and
 * reports presence only. Keeping it beside that function is deliberate: the
 * two must agree on where each member lives, and a divergence between them is
 * exactly what would re-open the bug.
 *
 * A missing entry means "not declared", which lets the reset FIRE — i.e. the
 * DESTRUCTIVE direction, not a conservative one. Two DIFFERENT mechanisms keep
 * that safe, and neither is "the translation validates everything":
 *   - a non-array `GlobalSecondaryIndexes` is refused LOUDLY by
 *     `toSdkGlobalSecondaryIndexes` before any of this runs;
 *   - a malformed per-ENTRY shape is NOT refused — it is passed through
 *     untouched so AWS surfaces the real error — but such an entry carries no
 *     usable `IndexName`, so the reset loop skips it before consulting this map.
 * Do not relax either behavior on the assumption that this helper degrades
 * safely on its own; it does not.
 */
export function collectRawOnDemandDeclarations(
  properties: Record<string, unknown>,
  region: string
): Map<string, RawOnDemandDeclaration> {
  const out = new Map<string, RawOnDemandDeclaration>();
  const rawIndexes = properties['GlobalSecondaryIndexes'];
  if (!Array.isArray(rawIndexes)) return out;

  const replicas = properties['Replicas'];
  const localReplica = Array.isArray(replicas)
    ? replicas.find((r) => asRecord(r)?.['Region'] === region)
    : undefined;
  const localReplicaIndexes = asRecord(localReplica)?.['GlobalSecondaryIndexes'];
  const localByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(localReplicaIndexes)) {
    for (const entry of localReplicaIndexes) {
      const record = asRecord(entry);
      const name = record?.['IndexName'];
      if (record && typeof name === 'string') localByName.set(name, record);
    }
  }

  for (const entry of rawIndexes) {
    const gsi = asRecord(entry);
    const name = gsi?.['IndexName'];
    if (!gsi || typeof name !== 'string') continue;
    const localEntry = localByName.get(name);
    // An already-SDK-shaped `OnDemandThroughput` no longer WINS over the
    // derived members — since #1428 the two are MERGED per member — so this
    // has to be the UNION of both sources, not the explicit block alone.
    // Reading only the explicit block would report a member not-declared that
    // the derived side does declare, and the reset would then clear a ceiling
    // the template was actively setting.
    const explicitOnDemand = asRecord(gsi['OnDemandThroughput']);
    // A block that is ITSELF an unresolved intrinsic counts as declared: the
    // member test cannot see into it, and reporting "not declared" would fire
    // the destructive reset on a ceiling the template was trying to set.
    // That applies to the EXPLICIT SDK-shaped block too — an
    // `OnDemandThroughput: {"Fn::If": …}` has no member keys, so without this
    // arm it reported "not declared" for BOTH members and the reset cleared a
    // ceiling a hand-authored template was setting (review catch on this PR;
    // the same class as #1440, one spelling over).
    const explicitIsIntrinsic = isUnresolvedIntrinsicBlock(gsi['OnDemandThroughput']);
    const readBlocks = [
      localEntry?.['ReadOnDemandThroughputSettings'],
      gsi['ReadOnDemandThroughputSettings'],
    ];
    const writeBlock = gsi['WriteOnDemandThroughputSettings'];
    out.set(name, {
      // Same sources as the SDK translation: replica entry first, GSI-level
      // spelling as the hand-authored fallback, explicit SDK-shaped block on
      // top. Declared in ANY place counts — the translation resolves "first
      // PARSEABLE", so an OR here is a safe superset for suppression (it can
      // never report not-declared for a member the translation did resolve).
      readDeclared:
        explicitOnDemand?.['MaxReadRequestUnits'] !== undefined ||
        explicitIsIntrinsic ||
        readBlocks.some(
          (block) =>
            asRecord(block)?.['MaxReadRequestUnits'] !== undefined ||
            isUnresolvedIntrinsicBlock(block)
        ),
      writeDeclared:
        explicitOnDemand?.['MaxWriteRequestUnits'] !== undefined ||
        explicitIsIntrinsic ||
        asRecord(writeBlock)?.['MaxWriteRequestUnits'] !== undefined ||
        isUnresolvedIntrinsicBlock(writeBlock),
    });
  }
  return out;
}
