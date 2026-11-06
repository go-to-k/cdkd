/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import type { CfnTagEntry } from '../../tag-list.js';
import type { CreateContext } from '../../../types/resource.js';
import {
  INVENTORY_DEFAULT_ENABLED,
  INVENTORY_DEFAULT_INCLUDED_OBJECT_VERSIONS,
  INVENTORY_DESTINATION_DEFAULT_FORMAT,
  effectiveIntelligentTieringItem,
  effectiveInventoryItem,
} from './effective-items.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import {
  type ObjectOwnership,
  PutBucketIntelligentTieringConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketReplicationCommand,
  PutObjectLockConfigurationCommand,
} from '@aws-sdk/client-s3';
import type { PerItemApplyOutcome } from './shared.js';
import { S3BucketProvider } from '../s3-bucket-provider.js';
import {
  coerceCfnBoolean,
  configBooleanRefusal,
  configStringRefusal,
  readConfigString,
  replayWarn,
  requireConfigArray,
  requireConfigObject,
  requireConfigString,
} from '../../config-shape.js';

/**
 * Apply intelligent tiering configurations
 *
 * CFn property: IntelligentTieringConfigurations[]
 * SDK: PutBucketIntelligentTieringConfiguration (one per configuration, keyed by Id)
 *
 * @returns what happened to each item, as {@link PerItemApplyOutcome} — the
 *   per-item unit of `effectiveProperties` (issue #1612). Its per-item
 *   `Status` read takes the SKIP downgrade rather than a substitution (issue
 *   #1595 — defaulting to `Enabled` would start archiving objects), so no
 *   MALFORMED value is ever recorded here. The `substituted` map is still
 *   populated for the defaulted-but-SENT arm (issue #1718): an item that
 *   simply OMITS `Status` is sent `Enabled` and read back with it, so a record
 *   without the key compares unequal to the readback for the whole array.
 *   That is the audit #1718 asks for on the sibling appliers — `metrics` has
 *   no defaulted scalar member at all (it sends only `Id` plus a `Filter`
 *   derived from the declared predicates), so it needs no fold.
 */
export async function applyIntelligentTieringConfigurations(
  this: S3BucketProvider,
  bucketName: string,
  configs: Array<Record<string, unknown>>,
  onUnusable?: (message: string) => void
): Promise<PerItemApplyOutcome> {
  const skipped: number[] = [];
  const substituted = new Map<number, Record<string, unknown>>();
  // A plain `for…of` over `configs` with a hand-kept index, NOT
  // `configs.entries()`: the nested-key critic's write pass (retired by issue
  // #3723) could not follow an array-destructuring binding back to the
  // desired property bag.
  let index = -1;
  for (const config of configs) {
    index += 1;
    const id = config['Id'] as string;
    // Per-item `Status` (issue #1595) — the read below carries no
    // `onUnusable`, so a state replay hard-threw. The fallback `Enabled`
    // would switch a live intelligent-tiering configuration ON and start
    // moving objects into archive tiers, so the downgrade is a SKIP. The
    // Put is per-Id, so the unit is this configuration item — matching the
    // `TagFilters` guard a few lines below.
    if (
      this.skipOnUnusableConfigString(
        config,
        'Status',
        'Enabled',
        'AWS::S3::Bucket IntelligentTieringConfigurations[]',
        'Skipping this intelligent tiering configuration',
        onUnusable
      )
    ) {
      skipped.push(index);
      continue;
    }
    const tierings = config['Tierings'] as Array<Record<string, unknown>> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itConfig: any = {
      Id: id,
      Status: readConfigString(
        config,
        'Status',
        'Enabled',
        'AWS::S3::Bucket IntelligentTieringConfigurations[]'
      ),
      Tierings: (tierings || []).map((t: Record<string, unknown>) => ({
        AccessTier: t['AccessTier'] as string,
        Days: t['Days'] as number,
      })),
    };

    // Filter. Same predicate-count rule as applyAnalyticsConfigurations —
    // the old kind-count guard dropped every tag after the first when
    // Prefix was absent (issue #1573; And-with-only-Tags live-probed
    // 2026-08-11).
    const prefix = config['Prefix'] as string | undefined;
    // Non-array `TagFilters` guard (issue #1579) — see the metrics sibling,
    // including why the binding must stay a direct bag read.
    const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }> | undefined;
    if (
      tagFilters != null &&
      requireConfigArray(
        tagFilters,
        'AWS::S3::Bucket IntelligentTieringConfigurations[].TagFilters',
        { ...(onUnusable ? { onUnusable } : {}) }
      ) === undefined
    ) {
      skipped.push(index);
      continue;
    }
    const tagCount = tagFilters?.length ?? 0;
    if ((prefix ? 1 : 0) + tagCount > 1) {
      itConfig.Filter = { And: { Prefix: prefix, Tags: tagFilters } };
    } else if (prefix) {
      itConfig.Filter = { Prefix: prefix };
    } else if (tagFilters && tagFilters.length === 1) {
      itConfig.Filter = { Tag: tagFilters[0] };
    }

    await this.s3Client.send(
      new PutBucketIntelligentTieringConfigurationCommand({
        Bucket: bucketName,
        Id: id,
        IntelligentTieringConfiguration: itConfig,
      })
    );
    // Recorded only once the Put has SUCCEEDED — see the analytics sibling.
    const sentItem = effectiveIntelligentTieringItem(config);
    if (sentItem !== config) substituted.set(index, sentItem);
  }
  this.logger.debug(
    `Applied ${configs.length - skipped.length} intelligent tiering configuration(s) to bucket ` +
      `${this.shown(bucketName)}`
  );
  return { skipped, substituted };
}

/**
 * Apply inventory configurations
 *
 * CFn property: InventoryConfigurations[]
 * SDK: PutBucketInventoryConfiguration (one per configuration, keyed by Id)
 *
 * @returns what happened to each item, as {@link PerItemApplyOutcome} — the
 *   per-item unit of `effectiveProperties` (issues #1612 / #1670). Both arms
 *   are reachable here: `IncludedObjectVersions` / the schedule frequency pair
 *   / the destination guard SKIP the item, while the destination `Format` read
 *   warns and SENDS a substituted default.
 */
export async function applyInventoryConfigurations(
  this: S3BucketProvider,
  bucketName: string,
  configs: Array<Record<string, unknown>>,
  onUnusable?: (message: string) => void,
  // TRAILING with an identity default (same shape as
  // `resolveS3BucketDestination` below it): the masker only reaches the
  // destination-shape refusals, so an absent one leaves today's behaviour
  // exactly as it was.
  maskSecrets: MaskerFn = (text) => text
): Promise<PerItemApplyOutcome> {
  const skipped: number[] = [];
  const substituted = new Map<number, Record<string, unknown>>();
  // A plain `for…of` over `configs` with a hand-kept index, NOT
  // `configs.entries()`: the nested-key critic's write pass (retired by issue
  // #3723) could not follow an array-destructuring binding back to the
  // desired property bag.
  let index = -1;
  for (const config of configs) {
    index += 1;
    const id = config['Id'] as string;
    // Per-item `IncludedObjectVersions` (issue #1595) — same replay split as
    // the intelligent-tiering sibling. Defaulting to `All` here is not
    // destructive, but it silently changes what the live inventory report
    // contains, and the destination guard immediately below already skips
    // the item on an unusable value — so the SKIP unit is taken from the
    // guard right next to it rather than invented. This applier is NOT
    // uniform overall and the comment used to claim it was: `Format` still
    // warns-and-defaults, and the `ScheduleFrequency` / `Schedule.Frequency`
    // pair takes a THIRD shape — fall through to the second source, then skip
    // the item when that is unusable too (issue #1605, below).
    if (
      this.skipOnUnusableConfigString(
        config,
        'IncludedObjectVersions',
        'All',
        'AWS::S3::Bucket InventoryConfigurations[]',
        'Skipping this inventory configuration',
        onUnusable
      )
    ) {
      skipped.push(index);
      continue;
    }
    // `Enabled` (issue #1751). The BOOLEAN sibling of the string guard above,
    // and the one member of this item that used to coerce SILENTLY: the wire
    // read was `(config['Enabled'] as boolean) ?? true`, so a declared
    // `Enabled: null` went out as `true` with no guard and no warning — while
    // the record kept `null`, which `readCurrentState` can never match.
    //
    // The direction is the one the file's siblings already take, not the
    // cheaper recording-side one the issue offered as its alternative:
    // defaulting a malformed `Enabled` to `true` on a LIVE inventory ENABLES
    // a report the template may have been trying to disable, which is exactly
    // the destructive-default class #1595 refuses. So the SKIP unit is taken
    // from the guard immediately above (this Put is per-`Id`) rather than
    // invented, and the CREATE path throws, matching every other member here.
    //
    // A CFn string boolean (`'false'`) is NOT malformed — CloudFormation is
    // stringly typed and cdkd is not — so the predicate is
    // `configBooleanRefusal`, which runs `coerceCfnBoolean`, i.e. literally
    // the function the wire read below calls.
    //
    // A NUMBER is refused, and that is a decision rather than an oversight —
    // the string sibling records its own `coerceNumber` relaxation the same
    // way. `requireConfigString` accepts a number at the sites where CFn's
    // scalar coercion makes one legitimate (an unquoted YAML `IpProtocol: -1`
    // deploys today); there is no such shape for `Enabled`, whose CFn type is
    // `boolean`, so a `1` here is a template bug and forwarding it — which is
    // what the pre-#1751 read did — put a non-boolean on the wire.
    const enabledRefusal = configBooleanRefusal(
      config,
      'Enabled',
      'AWS::S3::Bucket InventoryConfigurations[]'
    );
    if (enabledRefusal !== undefined) {
      if (!onUnusable) {
        throw new Error(
          `${enabledRefusal}. Omit the field entirely to use the default (${INVENTORY_DEFAULT_ENABLED})`
        );
      }
      onUnusable(
        `${enabledRefusal}. Skipping this inventory configuration: defaulting to ` +
          `${INVENTORY_DEFAULT_ENABLED} would ENABLE an inventory report the template may have ` +
          `been disabling; the same value is REFUSED on a template-path create`
      );
      skipped.push(index);
      continue;
    }
    const inventoryDestPath = 'AWS::S3::Bucket InventoryConfigurations[].Destination';
    const rawDest = config['Destination'];
    const s3Dest = this.resolveS3BucketDestination(
      rawDest,
      inventoryDestPath,
      onUnusable,
      maskSecrets
    );
    // See the analytics sibling: a warned-away destination leaves the live
    // configuration untouched instead of sending a request S3 rejects.
    if (s3Dest === undefined && rawDest != null) {
      skipped.push(index);
      continue;
    }
    // The value that goes ON THE WIRE for the one read a warn-and-SUBSTITUTE
    // downgrade can replace — see the analytics sibling (issue #1670). The
    // schedule frequency below is the other one, and both are handed to
    // {@link effectiveInventoryItem} after the Put succeeds.
    let sentFormat: string | undefined;

    // The schedule frequency is a TWO-SOURCE precedence read, so its replay
    // downgrade is neither of the two shapes #1595 settled (issue #1605):
    // for a malformed FIRST source the right answer is to FALL THROUGH to
    // the second, which is a value the record also carries and the one a
    // correct record would have used. When there is nothing to fall back to,
    // the item is SKIPPED with the same unit its `IncludedObjectVersions`
    // sibling above already uses (the Put is per-Id) — inventing a `Weekly`
    // cadence for a LIVE report is the substitution this guard class refuses.
    //
    // "Nothing to fall back to" includes an ABSENT second source, and that
    // is the case that matters rather than a corner (PR review blocker):
    // `ScheduleFrequency` is the ONLY spelling the CFn schema declares —
    // `tests/fixtures/cfn-schemas/AWS-S3-Bucket.json` has no `Schedule`
    // member — so a record with a broken `ScheduleFrequency` almost never
    // carries one. Treating an absent container as "usable" (which it is,
    // for a guard whose job is to reject a MALFORMED value) let the fall-
    // through land on `readConfigString`'s own `Weekly` default and made the
    // whole downgrade inert for real input.
    const scheduleFrequencyRefusal = onUnusable
      ? configStringRefusal(
          config,
          'ScheduleFrequency',
          'Weekly',
          'AWS::S3::Bucket InventoryConfigurations[]'
        )
      : undefined;
    if (scheduleFrequencyRefusal !== undefined && config['Schedule'] == null) {
      onUnusable?.(
        `${scheduleFrequencyRefusal}. Skipping this inventory configuration: there is no ` +
          `Schedule.Frequency to fall back to, and defaulting to Weekly would silently ` +
          `re-cadence a live inventory report; the same value is REFUSED on a template-path ` +
          `create`
      );
      skipped.push(index);
      continue;
    }
    if (scheduleFrequencyRefusal !== undefined) {
      onUnusable?.(
        `${scheduleFrequencyRefusal}. Falling back to Schedule.Frequency; the same value is ` +
          `REFUSED on a template-path create`
      );
    }
    const useScheduleFrequency =
      config['ScheduleFrequency'] !== undefined && scheduleFrequencyRefusal === undefined;
    if (
      !useScheduleFrequency &&
      this.skipOnUnusableConfigString(
        config['Schedule'],
        'Frequency',
        'Weekly',
        'AWS::S3::Bucket InventoryConfigurations[].Schedule',
        'Skipping this inventory configuration',
        onUnusable
      )
    ) {
      skipped.push(index);
      continue;
    }
    const frequency = useScheduleFrequency
      ? requireConfigString(
          config['ScheduleFrequency'],
          'Weekly',
          'AWS::S3::Bucket InventoryConfigurations[].ScheduleFrequency'
        )
      : readConfigString(
          config['Schedule'],
          'Frequency',
          'Weekly',
          'AWS::S3::Bucket InventoryConfigurations[].Schedule'
        );
    // The fall-through is a SUBSTITUTION too, and the one this applier's
    // three-shape comment made easiest to miss (issue #1670): the warning
    // above announces `Schedule.Frequency`, the Put SUCCEEDS carrying it, and
    // `inventorySdkToCfn` maps the live `Schedule.Frequency` BACK to
    // `ScheduleFrequency` — so leaving the malformed declared value in the
    // record is the same permanent phantom drift as the `Format` arm below.
    // The value recorded is `frequency` itself, i.e. what went on the wire.
    //
    // Issue #1686 is the SHAPE half of that, and it is why the condition is
    // not merely the refusal: `ScheduleFrequency` is the ONLY spelling the
    // readback can produce (`inventorySdkToCfn` reads the live
    // `Schedule.Frequency` and emits `ScheduleFrequency`, never a `Schedule`
    // member — confirmed against the live CFn registry schema, which declares
    // `ScheduleFrequency` REQUIRED and has no `Schedule` member at all). So a
    // record carrying `Schedule` describes a key AWS can never report, and
    // every `cdkd drift` re-reports it while `--revert` re-issues the same
    // Put. That is reachable with NO refusal in sight — an item declaring
    // only the SDK spelling sends the right cadence and records the wrong
    // key — so the normalization keys off the DECLARED shape.
    //
    // The decision this settles (the issue offered the opposite as its other
    // candidate): the SDK spelling stays ACCEPTED and is normalized on the
    // recording side. Refusing it instead would retract the #1605
    // fall-through, whose whole purpose is that a malformed
    // `ScheduleFrequency` lands on the value the record ALSO carries rather
    // than skipping a live inventory report.
    //
    // The `canonicalizeDesiredProperties` TWIN the rule requires alongside
    // this fold shipped in issue #1717 — see
    // {@link S3BucketProvider.canonicalizeDesiredProperties}, which folds the
    // SAME key through the SAME helper ({@link effectiveInventoryItem}) on
    // BOTH comparison sides. Until it did, an UNCHANGED template redeployed as
    // `1 to update` forever (measured us-east-1, 2026-08-12), because state
    // held the folded spelling while the template still declared the SDK one.
    // Folding both sides is also what HEALS the already-deployed population:
    // an item whose value never changes is never re-Put, so the recording side
    // alone could never reach a record written before the fold.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inventoryConfig: any = {
      Id: id,
      // The `??` is safe HERE and only here (issue #1751): the guard at the
      // top of the loop has already refused every declared-but-unusable
      // value, so the one way to reach the fallback is an ABSENT key — which
      // is the case a default belongs to. `coerceCfnBoolean`, not a cast: a
      // CFn `'false'` must reach AWS as `false`, and it is the same primitive
      // the guard ran.
      IsEnabled: coerceCfnBoolean(config['Enabled']) ?? INVENTORY_DEFAULT_ENABLED,
      IncludedObjectVersions: readConfigString(
        config,
        'IncludedObjectVersions',
        INVENTORY_DEFAULT_INCLUDED_OBJECT_VERSIONS,
        'AWS::S3::Bucket InventoryConfigurations[]'
      ),
      Schedule: {
        // Same class as the guarded siblings above (issue #1471): a
        // malformed `Schedule` used to index to `undefined` and silently
        // default to Weekly. The two-source precedence is preserved.
        Frequency: frequency,
      },
      Destination: {
        S3BucketDestination: s3Dest
          ? {
              Bucket: s3Dest['BucketArn'] as string,
              AccountId: s3Dest['BucketAccountId'] as string | undefined,
              // Same update-path downgrade as the analytics sibling, and the
              // same record-what-was-SENT rule (issue #1670) —
              // `inventorySdkToCfn` reads `Format` back, so a recorded
              // declared value AWS never received is permanent phantom drift.
              Format: (sentFormat = this.readSubstitutedConfigString(
                s3Dest,
                'Format',
                INVENTORY_DESTINATION_DEFAULT_FORMAT,
                inventoryDestPath,
                { ...(onUnusable ? { onUnusable } : {}) }
              )),
              Prefix: s3Dest['Prefix'] as string | undefined,
            }
          : undefined,
      },
      OptionalFields: config['OptionalFields'] as string[] | undefined,
      Filter: config['Prefix'] ? { Prefix: config['Prefix'] as string } : undefined,
    };

    await this.s3Client.send(
      new PutBucketInventoryConfigurationCommand({
        Bucket: bucketName,
        Id: id,
        InventoryConfiguration: inventoryConfig,
      })
    );
    // Recorded only once the Put has SUCCEEDED — see the analytics sibling.
    // The fold reads `config['Schedule']` itself and drops it, so there is no
    // second place that decides which items carry the SDK spelling.
    const sentItem = effectiveInventoryItem(config, {
      frequency,
      ...(sentFormat !== undefined ? { format: sentFormat } : {}),
    });
    if (sentItem !== config) substituted.set(index, sentItem);
  }
  this.logger.debug(
    `Applied ${configs.length - skipped.length} inventory configuration(s) to bucket ${this.shown(bucketName)}`
  );
  return { skipped, substituted };
}

/**
 * Apply replication configuration
 *
 * CFn property: ReplicationConfiguration
 *   - Role (IAM role ARN)
 *   - Rules[] (replication rules)
 * SDK: PutBucketReplication with ReplicationConfiguration
 */
/**
 * Build the SDK `Destination` for one replication rule.
 *
 * Before issue #1495 this was an inline literal carrying `Bucket` / `Account`
 * / `StorageClass` only, so FOUR whole sub-blocks the CFn schema declares
 * were accepted from the template and never sent — each one silently:
 *
 * - `AccessControlTranslation` — cross-account replication with owner
 *   override; without it the replicas keep the SOURCE account's ownership.
 * - `EncryptionConfiguration.ReplicaKmsKeyID` — the replica-side SSE-KMS key;
 *   dropped, the replicas are not encrypted with the declared key. CDK's
 *   `aws-s3` L2 emits this for a `replicationRules` entry with a KMS key.
 * - `ReplicationTime` + `Metrics` — S3 Replication Time Control. RTC is a
 *   billed SLA feature and both blocks are required to enable it, so a
 *   template asking for RTC got plain asynchronous replication.
 *
 * CFn and the SDK spell every member identically here (verified against
 * `@aws-sdk/client-s3`'s `Destination`), but the block is assembled member by
 * member rather than forwarded so a CFn-only member cannot ride through.
 */
export function buildReplicationDestination(
  this: S3BucketProvider,
  dest: Record<string, unknown>
): Record<string, unknown> {
  const sdkDest: Record<string, unknown> = {
    Bucket: dest['Bucket'] as string,
    Account: dest['Account'] as string | undefined,
    StorageClass: dest['StorageClass'] as string | undefined,
  };

  // Every gate below is `!= null`, not truthiness: a FALSY malformed value
  // (`''`, `0`) must not be silently skipped — that is the #1493 gate bug one
  // level down, and `.claude/rules/providers.md` requires the `!= null` form.
  // Each block is also assembled into a local and only attached when it
  // carries at least one member, so a template's `AccessControlTranslation: {}`
  // does not become `{Owner: undefined}` on the wire (AWS rejects that, where
  // the pre-fix code sent nothing at all).
  // Each block is written as a NAMED assignment rather than through a helper
  // taking a string-literal key (a shape the nested-key critic's retired
  // write pass needed), so the empty-block guard is inlined per block.
  const acl = dest['AccessControlTranslation'] as Record<string, unknown> | undefined;
  if (acl != null && acl['Owner'] !== undefined) {
    sdkDest['AccessControlTranslation'] = { Owner: acl['Owner'] as string };
  }

  const encryption = dest['EncryptionConfiguration'] as Record<string, unknown> | undefined;
  if (encryption != null && encryption['ReplicaKmsKeyID'] !== undefined) {
    sdkDest['EncryptionConfiguration'] = {
      ReplicaKmsKeyID: encryption['ReplicaKmsKeyID'] as string,
    };
  }

  const replicationTime = dest['ReplicationTime'] as Record<string, unknown> | undefined;
  if (replicationTime != null) {
    const time = replicationTime['Time'] as Record<string, unknown> | undefined;
    const rt: Record<string, unknown> = {};
    if (replicationTime['Status'] !== undefined) rt['Status'] = replicationTime['Status'];
    if (time != null && time['Minutes'] !== undefined) {
      rt['Time'] = { Minutes: time['Minutes'] as number };
    }
    if (Object.keys(rt).length > 0) sdkDest['ReplicationTime'] = rt;
  }

  const metrics = dest['Metrics'] as Record<string, unknown> | undefined;
  if (metrics != null) {
    const threshold = metrics['EventThreshold'] as Record<string, unknown> | undefined;
    const m: Record<string, unknown> = {};
    if (metrics['Status'] !== undefined) m['Status'] = metrics['Status'];
    if (threshold != null && threshold['Minutes'] !== undefined) {
      m['EventThreshold'] = { Minutes: threshold['Minutes'] as number };
    }
    if (Object.keys(m).length > 0) sdkDest['Metrics'] = m;
  }

  return sdkDest;
}

/**
 * @returns `true` when the Put was issued, `false` when a replay downgrade
 *   SKIPPED the whole configuration (issue #1612).
 */
export async function applyReplicationConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  replConfig: Record<string, unknown>,
  onUnusable?: (message: string) => void
): Promise<boolean> {
  const rules = replConfig['Rules'] as Array<Record<string, unknown>> | undefined;
  // Validate every rule's `Filter` CONTAINER up front (issue #1581) — the
  // third instance of the class in this file, and the one with the widest
  // blast radius. A present-but-non-OBJECT `Filter` indexes the `And` /
  // `Prefix` / `TagFilter` probes below to `undefined` and falls through to
  // the "empty / unrecognized filter object" arm, which emits `Filter: {}` —
  // the valid CFn form meaning "replicate EVERY object". So a malformed
  // container silently replicated the WHOLE bucket instead of the declared
  // subset: data leaving its intended scope, at cross-region transfer cost.
  // A FALSY malformed value (`Filter: ''`) additionally skipped the
  // truthiness gate below and fell to the top-level-`Prefix` arm, which is
  // the #1493 gate-bug shape — so the gate is `!= null` here too.
  // Refuse on a template-path create; on the state-replay paths warn and
  // leave the WHOLE live replication configuration alone, since
  // `PutBucketReplication` replaces every rule at once — the same skip unit,
  // and the same reason, as the lifecycle Put.
  for (const rule of rules || []) {
    const rawFilter = rule['Filter'];
    if (
      rawFilter != null &&
      requireConfigObject(rawFilter, 'AWS::S3::Bucket ReplicationConfiguration.Rules[].Filter', {
        ...(onUnusable ? { onUnusable } : {}),
      }) === undefined
    ) {
      return false;
    }
    // The per-rule `Status` in the same loop (issue #1595) — the fourth
    // per-item refusal of this class and the one most likely to be mistaken
    // for already-handled, since it sits in the applier whose `Filter`
    // container is guarded directly above. Its read is in the `.map` below
    // and carries no `onUnusable`. The fallback `Enabled` would START
    // replicating for a rule the template had disabled — objects leaving the
    // bucket, at cross-region transfer cost — so the downgrade is a SKIP,
    // and `PutBucketReplication` replaces every rule at once, so the unit is
    // the whole Put.
    if (
      this.skipOnUnusableConfigString(
        rule,
        'Status',
        'Enabled',
        'AWS::S3::Bucket ReplicationConfiguration.Rules[]',
        // Path-neutral, for the same reason as the lifecycle sibling.
        'Leaving the whole replication configuration unapplied here',
        onUnusable
      )
    ) {
      return false;
    }
  }
  await this.s3Client.send(
    new PutBucketReplicationCommand({
      Bucket: bucketName,
      ReplicationConfiguration: {
        Role: replConfig['Role'] as string,
        Rules: (rules || []).map((rule) => {
          const dest = rule['Destination'] as Record<string, unknown>;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sdkRule: any = {
            ID: rule['Id'] as string | undefined,
            Status: readConfigString(
              rule,
              'Status',
              'Enabled',
              'AWS::S3::Bucket ReplicationConfiguration.Rules[]'
            ),
            Priority: rule['Priority'] as number | undefined,
            Destination: this.buildReplicationDestination(dest),
          };

          // SourceSelectionCriteria (issue #1495): which source objects are
          // eligible for replication. Never built before, so a rule opting
          // into replica-modification or SSE-KMS-object replication was
          // accepted from the template and never sent — silently replicating
          // a different set of objects than declared.
          const criteria = rule['SourceSelectionCriteria'] as Record<string, unknown> | undefined;
          if (criteria != null) {
            const sdkCriteria: Record<string, unknown> = {};
            const replicaMods = criteria['ReplicaModifications'] as
              | Record<string, unknown>
              | undefined;
            if (replicaMods != null && replicaMods['Status'] !== undefined) {
              sdkCriteria['ReplicaModifications'] = {
                Status: replicaMods['Status'] as string,
              };
            }
            const sseKms = criteria['SseKmsEncryptedObjects'] as
              | Record<string, unknown>
              | undefined;
            if (sseKms != null && sseKms['Status'] !== undefined) {
              sdkCriteria['SseKmsEncryptedObjects'] = {
                Status: sseKms['Status'] as string,
              };
            }
            if (Object.keys(sdkCriteria).length > 0) {
              sdkRule['SourceSelectionCriteria'] = sdkCriteria;
            }
          }

          // Filter (V2). An empty `Filter: {}` is the valid CFn "replicate every
          // object" form and MUST be preserved — S3's V2 replication schema
          // requires a `Filter` on every rule, so dropping the empty object
          // produces an invalid PutBucketReplication payload (the same element-
          // wise-transform-drops-a-valid-shape class as the lifecycle V1/V2 bug).
          const filter = rule['Filter'] as Record<string, unknown> | undefined;
          // `!= null` rather than the truthiness gate this used to be: after
          // the pre-pass guard at the top of this method only `null` /
          // `undefined` / a plain object can reach here, and every plain
          // object is truthy — so the two spellings are now equivalent and NO
          // test can distinguish them. Kept as defense-in-depth so the site
          // stays correct if the pre-pass is ever narrowed or moved; issue
          // #1581's hazard was precisely a falsy malformed value slipping
          // through a truthiness gate here.
          if (filter != null) {
            // CFn's ReplicationRuleFilter shapes, faithfully translated to the
            // S3 SDK shape (which differs only in `TagFilter`->`Tag` and
            // `And.TagFilters`->`And.Tags`):
            //   { And: { Prefix?, TagFilters[] } } <- the ONLY way CFn/CDK
            //       combine a prefix + tags (CDK's L2 emits this when a rule
            //       sets both `prefix` and `tags`). It was previously NOT read
            //       at all, so a combined filter silently fell through to the
            //       empty-filter branch below and replicated EVERY object
            //       instead of the prefix+tag subset (a silent scope-broadening
            //       divergence — same class as the lifecycle V1/V2 bug).
            //   { Prefix }     <- prefix-only
            //   { TagFilter }  <- single-tag-only
            //   {}             <- replicate-all (must be preserved; see #936)
            const and = filter['And'] as Record<string, unknown> | undefined;
            const prefix = filter['Prefix'] as string | undefined;
            const tagFilter = filter['TagFilter'] as { Key: string; Value: string } | undefined;
            if (and) {
              const andPrefix = and['Prefix'] as string | undefined;
              const andTags = and['TagFilters'] as
                | Array<{ Key: string; Value: string }>
                | undefined;
              const sdkAnd: Record<string, unknown> = {};
              if (andPrefix !== undefined) sdkAnd['Prefix'] = andPrefix;
              if (andTags !== undefined) sdkAnd['Tags'] = andTags;
              sdkRule['Filter'] = { And: sdkAnd };
            } else if (prefix !== undefined && tagFilter) {
              // Non-canonical template that put both at the top level; CFn
              // requires `And` to combine, but translate gracefully anyway.
              sdkRule['Filter'] = { And: { Prefix: prefix, Tags: [tagFilter] } };
            } else if (prefix !== undefined) {
              sdkRule['Filter'] = { Prefix: prefix };
            } else if (tagFilter) {
              sdkRule['Filter'] = { Tag: tagFilter };
            } else {
              // Empty / unrecognized filter object -> empty V2 filter (replicate all).
              sdkRule['Filter'] = {};
            }
          } else if (rule['Prefix'] !== undefined) {
            sdkRule['Prefix'] = rule['Prefix'] as string;
          }

          // DeleteMarkerReplication
          if (rule['DeleteMarkerReplication']) {
            const dmr = rule['DeleteMarkerReplication'] as Record<string, unknown>;
            sdkRule['DeleteMarkerReplication'] = { Status: dmr['Status'] as string };
          }

          return sdkRule;
        }),
      },
    })
  );
  this.logger.debug(`Applied replication configuration to bucket ${this.shown(bucketName)}`);
  return true;
}

/**
 * Apply object lock configuration
 *
 * CFn property: ObjectLockConfiguration
 *   - ObjectLockEnabled: 'Enabled'
 *   - Rule.DefaultRetention (Mode, Days, Years, DefaultEventHold)
 * SDK: PutObjectLockConfiguration with ObjectLockConfiguration
 *
 * Note: ObjectLockEnabled at bucket level must be set at creation time.
 * This method only applies the rule/default retention config post-creation.
 *
 * Returns whether the Put was issued. A malformed `DefaultEventHold`
 * container SKIPS the whole Put (see the guard below), and the callers owe
 * `effectiveProperties` the previous value when it does.
 */
export async function applyObjectLockConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  config: Record<string, unknown>,
  // The state-replay downgrade (issue #1605). Present only on a replay-
  // reachable call -- the reverse-replacement create and the update path.
  onUnusable?: (message: string) => void
): Promise<boolean> {
  const rule = config['Rule'] as Record<string, unknown> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objectLockConfig: any = {
    ObjectLockEnabled: 'Enabled',
  };
  if (rule) {
    const retention = rule['DefaultRetention'] as Record<string, unknown> | undefined;
    if (retention) {
      // `DefaultEventHold` is the newest member of `DefaultRetention` (CFn
      // schema capture 2026-09-11, `@aws-sdk/client-s3` >= 3.1129.0), and it
      // is the only OBJECT here. That is why it takes a shape guard its
      // scalar siblings do not need: a malformed SCALAR stringifies onto the
      // wire and S3 rejects it loudly, while a malformed CONTAINER indexes to
      // `undefined` on every member and vanishes as an empty
      // `DefaultEventHold: {}` -- the declared WORM protection silently gone
      // from a Put that otherwise succeeds (the #1581 silent-DROP class).
      //
      // The skip unit is the WHOLE Put, not the member:
      // `PutObjectLockConfiguration` replaces the entire rule, so sending
      // retention MINUS the hold would apply a weaker configuration than the
      // template declared -- exactly the substitution this guard family
      // refuses. An ABSENT hold keeps defaulting (`!= null`), since most
      // templates declare none.
      const declaredHold = retention['DefaultEventHold'];
      let eventHold: Record<string, unknown> | undefined;
      if (declaredHold != null) {
        // The two-arm split, spelled as two CALLS rather than as one call
        // with a possibly-`undefined` option: under
        // `exactOptionalPropertyTypes` an explicit `{ onUnusable: undefined }`
        // is not assignable to the optional member. The no-options arm is the
        // THROWING overload -- the template-path create answer -- while a
        // replay-reachable caller passes a real callback and gets
        // warn-and-skip.
        const path =
          'AWS::S3::Bucket ObjectLockConfiguration.Rule.DefaultRetention.DefaultEventHold';
        eventHold = onUnusable
          ? requireConfigObject(declaredHold, path, { onUnusable })
          : requireConfigObject(declaredHold, path);
        if (eventHold === undefined) {
          // Announced by `requireConfigObject` itself. Reported to the
          // caller so state records what AWS still holds rather than the
          // malformed desired bag (issue #1612).
          return false;
        }
      }
      objectLockConfig.Rule = {
        DefaultRetention: {
          Mode: retention['Mode'] as string | undefined,
          Days: retention['Days'] as number | undefined,
          Years: retention['Years'] as number | undefined,
          DefaultEventHold: eventHold
            ? {
                Days: eventHold['Days'] as number | undefined,
                Years: eventHold['Years'] as number | undefined,
              }
            : undefined,
        },
      };
    }
  }
  await this.s3Client.send(
    new PutObjectLockConfigurationCommand({
      Bucket: bucketName,
      ObjectLockConfiguration: objectLockConfig,
    })
  );
  this.logger.debug(`Applied object lock configuration to bucket ${this.shown(bucketName)}`);
  return true;
}

/**
 * Apply additional bucket configuration after creation.
 *
 * `options.skipDiffManaged` is passed by `update()` for the three
 * sub-configs that moved onto the diff path (`VersioningConfiguration` /
 * `OwnershipControls` / `BucketEncryption`, issue #1466). They stay here for
 * CREATE — where there is no previous side to diff against — but on UPDATE
 * they must go through `applySubConfigDiffs` so a REMOVED property is reset
 * to the CloudFormation default instead of silently surviving. Applying them
 * in both places would double-PUT.
 */
export async function applyConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  properties: Record<string, unknown>,
  options: { skipDiffManaged?: boolean; context?: CreateContext } & (
    | { skipTags: true }
    // The list `refuseMalformedDesiredTags` returned (go-to-k/cdkd#3994):
    // required whenever tags are applied, so no caller can drop them.
    | { skipTags?: false; desiredTags: CfnTagEntry[] }
  )
): Promise<Map<string, unknown>> {
  const { skipDiffManaged = false, context } = options;
  const skipTags = options.skipTags === true;
  const desiredTags = options.skipTags === true ? [] : options.desiredTags;
  // `effectiveProperties` overrides for anything a replay downgrade SKIPPED
  // (issue #1612). This method only runs the versioning applier on the CREATE
  // path — `update()` passes `skipDiffManaged` and lets `applySubConfigDiffs`
  // own it — so an override recorded here always means a replayed create
  // where NOTHING was applied and the key must be DROPPED, never retained.
  const overrides = new Map<string, unknown>();
  // Issue #1605: this method is reached by the reverse-replacement create as
  // well as the template one, and its versioning read is a refusal. Its
  // sibling `applyAllSubConfigsForCreate` already took the context for
  // exactly this reason (#1463); this one did not, so a state record
  // carrying a malformed `VersioningConfiguration` made the old bucket
  // unrestorable.
  const replayOnUnusable = replayWarn(this.logger, context).onUnusable;

  // Versioning
  const versioningConfig = properties['VersioningConfiguration'];
  // `!= null`, not truthiness: a falsy non-object ('' / 0 / false) is
  // MALFORMED and must reach the apply call so create refuses it the same
  // way update does (issue #1471). A truthy check silently skipped it on
  // create only, and a truthy-but-malformed value ('Enabled') then had its
  // missing `Status` defaulted to Suspended. Same rationale as the
  // OwnershipControls / BucketEncryption gates below; nullish rather than
  // strict-undefined to match `diffSubConfig`'s treatment of a desired null.
  if (!skipDiffManaged && versioningConfig != null) {
    const applied = await this.applyVersioning(bucketName, versioningConfig, replayOnUnusable);
    if (!applied) overrides.set('VersioningConfiguration', undefined);
  }

  // Tags. Only applied at create time here (`applyTags` is full-replace, no
  // removal). For update, the caller passes `skipTags=true` and uses the
  // diff-aware `applyTagDiff` helper instead. A create whose `CreateBucket`
  // already carried the tags passes `skipTags` too (go-to-k/cdkd#4969).
  if (!skipTags && desiredTags.length > 0) {
    await this.applyTags(bucketName, desiredTags);
  }

  // Ownership Controls (e.g., BucketOwnerPreferred for CloudFront logs)
  const ownershipControls = properties['OwnershipControls'] as
    | { Rules: Array<{ ObjectOwnership: string }> }
    | undefined;
  // Normalized so an empty `Rules: []` (the readCurrentState placeholder, or
  // a condition-pruned template) is treated as not-declared instead of
  // firing a Put that AWS 400s — mirroring the encryption branch below.
  const normalizedOwnership = S3BucketProvider.emptyListConfigToUndefined(
    ownershipControls,
    'Rules'
  );
  // `!== undefined`, not truthiness: a falsy non-object ('' / 0 / false) is
  // MALFORMED and must reach the apply call so create fails the same way
  // update does. A truthy check would silently skip it on create only.
  if (!skipDiffManaged && normalizedOwnership !== undefined) {
    await this.applyOwnershipControls(bucketName, normalizedOwnership);
  }

  // Public Access Block Configuration
  const publicAccessBlock = properties['PublicAccessBlockConfiguration'] as
    | Record<string, unknown>
    | undefined;
  if (publicAccessBlock) {
    await this.applyPublicAccessBlockConfiguration(bucketName, publicAccessBlock);
  }

  // Bucket Encryption. Skip empty-rules placeholder (Class 2): AWS
  // rejects `PutBucketEncryption` when the rules array is empty
  // (`ServerSideEncryptionConfiguration must contain at least one
  // Rule`). `readCurrentState` always-emits
  // `BucketEncryption: { ServerSideEncryptionConfiguration: [] }` for
  // buckets without explicit SSE — that placeholder must NOT be pushed
  // back through `update()` on a `cdkd drift --revert` round-trip.
  //
  // Routed through the SAME normalizer the update path uses, so create and
  // update agree on what "empty" means. The previous inline
  // `Array.isArray(...) && length > 0` guard silently SKIPPED a malformed
  // value on create (leaving the bucket unencrypted-by-declaration with no
  // error and nothing for drift to see) while update failed loudly on it.
  const normalizedEncryption = S3BucketProvider.emptyListConfigToUndefined(
    properties['BucketEncryption'] as
      | { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
      | undefined,
    'ServerSideEncryptionConfiguration'
  );
  if (!skipDiffManaged && normalizedEncryption !== undefined) {
    await this.applyBucketEncryption(bucketName, normalizedEncryption);
  }
  return overrides;
}

/**
 * CFn property: OwnershipControls
 * SDK: PutBucketOwnershipControls
 */
export async function applyOwnershipControls(
  this: S3BucketProvider,
  bucketName: string,
  ownershipControls: { Rules: Array<{ ObjectOwnership: string }> }
): Promise<void> {
  // A malformed value reaches here by design (the normalizer passes it
  // through rather than reading it as a removal). Name the property instead
  // of letting `.map` throw a bare "Cannot read properties of undefined".
  if (!Array.isArray(ownershipControls?.Rules)) {
    throw new Error(
      `OwnershipControls.Rules must be an array (got ` +
        `${ownershipControls?.Rules === undefined ? 'undefined' : typeof ownershipControls.Rules}` +
        `) — check for an unresolved intrinsic or a mis-nested template value`
    );
  }
  await this.s3Client.send(
    new PutBucketOwnershipControlsCommand({
      Bucket: bucketName,
      OwnershipControls: {
        Rules: ownershipControls.Rules.map((r) => ({
          ObjectOwnership: r.ObjectOwnership as ObjectOwnership,
        })),
      },
    })
  );
  this.logger.debug(`Applied ownership controls to bucket ${this.shown(bucketName)}`);
}
