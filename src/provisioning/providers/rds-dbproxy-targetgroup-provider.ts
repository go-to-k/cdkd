import {
  RDSClient,
  RegisterDBProxyTargetsCommand,
  DeregisterDBProxyTargetsCommand,
  DescribeDBProxyTargetGroupsCommand,
  DescribeDBProxyTargetsCommand,
  ModifyDBProxyTargetGroupCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  ListTagsForResourceCommand,
  DBProxyNotFoundFault,
  DBProxyTargetGroupNotFoundFault,
  DBProxyTargetNotFoundFault,
} from '@aws-sdk/client-rds';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { markNonRetryable, markRedactedCause } from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import type { CreateContext, ResourceNotFound, UpdateContext } from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { markAuxiliaryFailure } from '../auxiliary-failure.js';
import { holdsSecretDerivedEntry, recordedPrincipalsRepair } from '../iam-policy-targets.js';
import {
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
  planTagDiff,
  readTagList,
  refuseMalformedDesiredTags,
  tagPlanWarning,
} from '../tag-list.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../redacted-delete-address.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import { unchangedBehindSecretReference } from '../secret-reference-immutable.js';

/**
 * A SUPERSET of an RDS DB cluster or DB instance identifier: a letter, then up
 * to 62 letters, digits or hyphens, at RDS's 63-character cap. RDS also forbids
 * a trailing hyphen and `--`, which this admits (AWS rejects those itself). An
 * entry outside it names no proxy target.
 */
const RDS_TARGET_IDENTIFIER = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;

/** The two target lists, each passed as the caller's own read of its bag. */
type TargetListValues = {
  DBClusterIdentifiers: unknown;
  DBInstanceIdentifiers: unknown;
};
type TargetListKind = keyof TargetListValues;

/** What {@link readTargetLists} found: every well-formed list, and which were not. */
interface TargetLists {
  /** A well-formed list as its identifiers; an absent or malformed one as `[]`. */
  lists: Record<TargetListKind, string[]>;
  malformed: TargetListKind[];
  /** The malformed kinds holding a dynamic reference or cdkd's mask. */
  secretDerived: TargetListKind[];
}

/**
 * Read `DBClusterIdentifiers` / `DBInstanceIdentifiers` before any call names a
 * target (go-to-k/cdkd#3945). `undefined` / `null` is absent (no targets); a
 * list whose every entry is an {@link RDS_TARGET_IDENTIFIER} is itself; ANY
 * other value is malformed. The lists used to be cast to `string[]`, so a
 * string was walked character by character: `new Set("prod-cluster")` made
 * `update()` deregister the real target and register `p`, `r`, `o`, ... —
 * one-letter identifiers an unrelated DB instance can carry. `create()` and
 * `delete()` handed the value to the SDK, whose serializer sends NO list for a
 * string, so the call named no target at all. A caller refuses a malformed
 * list before any AWS call.
 */
function readTargetLists(values: TargetListValues): TargetLists {
  const lists: Record<TargetListKind, string[]> = {
    DBClusterIdentifiers: [],
    DBInstanceIdentifiers: [],
  };
  const malformed: TargetListKind[] = [];
  const secretDerived: TargetListKind[] = [];
  for (const kind of ['DBClusterIdentifiers', 'DBInstanceIdentifiers'] as const) {
    const value = values[kind];
    if (value === undefined || value === null) continue;
    if (
      Array.isArray(value) &&
      value.every((v) => typeof v === 'string' && RDS_TARGET_IDENTIFIER.test(v))
    ) {
      lists[kind] = value as string[];
      continue;
    }
    malformed.push(kind);
    if (holdsSecretDerivedEntry(value)) secretDerived.push(kind);
  }
  return { lists, malformed, secretDerived };
}

/**
 * What an `update()` refusal says about a secret-derived recorded list: it is
 * refused only while a DESIRED list is malformed too, since otherwise
 * `update()` reads the recorded side from the proxy instead.
 */
const SECRET_DERIVED_TARGETS_REPAIR =
  'cdkd reads it from the proxy instead once the desired lists are well-formed';

/**
 * A recorded or desired `DBProxyName`, or `undefined` when it is not a
 * non-empty string. Never cast: the SDK sends `{}` as `[object Object]`, whose
 * NotFound a delete would read as "already gone".
 */
function readProxyName(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The entries of `from` absent from `against`, compared case-insensitively:
 * RDS stores identifiers lowercased, so `MyCluster` and `mycluster` name one
 * target, and a case-only difference must not deregister and re-register it.
 */
function missingIdentifiers(from: readonly string[], against: readonly string[]): string[] {
  const seen = new Set(against.map((id) => id.toLowerCase()));
  const out: string[] = [];
  for (const id of from) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * The `ResourceDeleteResult.reason` for a delete whose recorded target list is
 * malformed. Fixed wording: a reason is classified by SUBSTRING
 * (`.claude/rules/provider-delete-path.md`).
 */
export const MALFORMED_TARGETS_SKIP_REASON =
  'malformed target list in state — no target deregistered';

/** The same, for a recorded `TargetGroupName` other than `default`. */
export const NON_DEFAULT_GROUP_SKIP_REASON =
  'target group name other than default in state — no target deregistered';

/**
 * AWS RDS DBProxyTargetGroup Provider
 *
 * Implements resource provisioning for `AWS::RDS::DBProxyTargetGroup`.
 *
 * **Why a dedicated SDK provider** (per `feedback_dedicated_provider_over_special_case.md`):
 * pre-PR this type went through Cloud Control API, but CC API's resource
 * handler for `AWS::RDS::DBProxyTargetGroup` fails the delete path with
 * `Value null at 'dBProxyName' failed to satisfy constraint`. The handler
 * cannot derive `DBProxyName` from the TargetGroup ARN (the primary
 * identifier), so the underlying RDS API call goes out with
 * `DBProxyName: null` and AWS rejects it (Issue #385).
 *
 * **What this resource actually does on AWS**: a CFn
 * `AWS::RDS::DBProxyTargetGroup` is a wiring resource — every DBProxy gets
 * a default TargetGroup (`TargetGroupName: 'default'`) auto-created by AWS;
 * the CFn resource only manages target REGISTRATIONS
 * (`RegisterDBProxyTargets` / `DeregisterDBProxyTargets`) and the
 * connection pool config (`ModifyDBProxyTargetGroup`). The TargetGroup
 * object itself is not deleted on resource delete — it lives and dies with
 * the parent DBProxy.
 *
 * **Lifecycle**:
 * - `create`: optionally `ModifyDBProxyTargetGroup` (connection pool), then
 *   `RegisterDBProxyTargets` (cluster IDs and / or instance IDs), then
 *   `DescribeDBProxyTargetGroups` to recover the TargetGroupArn for state,
 *   then `AddTagsToResource` on that ARN when `Tags` is declared (the schema
 *   is `tagOnCreate: false`, so tagging is always a separate call).
 * - `update`: `ModifyDBProxyTargetGroup` for a pool config change, then
 *   `DeregisterDBProxyTargets` / `RegisterDBProxyTargets` for the target
 *   diff, then the `Tags` diff; a `DBProxyName` / `TargetGroupName` change is
 *   rejected via `ResourceUpdateNotSupportedError`.
 * - `delete`: `DeregisterDBProxyTargets` for every registered target.
 *   `DBProxyNotFoundFault` / `DBProxyTargetGroupNotFoundFault` /
 *   `DBProxyTargetNotFoundFault` are treated as idempotent success
 *   (region-match-gated) — the parent DBProxy may already have been
 *   deleted by a sibling cdkd delete or by AWS CASCADE.
 * - Every method that names a target reads both target lists through
 *   `readTargetLists` first and refuses (or, on delete, skips) a malformed one
 *   before any AWS call (go-to-k/cdkd#3945).
 * - `getAttribute`: `TargetGroupArn` returns the physicalId; `TargetGroupName`
 *   returns `'default'`.
 *
 * **physicalId** = TargetGroupArn (matches the CFn `primaryIdentifier`).
 */
export class RDSDBProxyTargetGroupProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('RDSDBProxyTargetGroupProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBProxyTargetGroup',
      new Set([
        'DBProxyName',
        'TargetGroupName',
        'DBClusterIdentifiers',
        'DBInstanceIdentifiers',
        'ConnectionPoolConfigurationInfo',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): RDSClient {
    if (!this.rdsClient) {
      this.rdsClient = new RDSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.rdsClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const dbProxyName = readProxyName(properties['DBProxyName']);
    if (!dbProxyName) {
      throw new ProvisioningError(
        `DBProxyName is required for AWS::RDS::DBProxyTargetGroup ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const targetGroupName = requireConfigString(
      properties['TargetGroupName'],
      'default',
      'AWS::RDS::DBProxyTargetGroup TargetGroupName',
      replayWarn(this.logger, context)
    );
    // go-to-k/cdkd#3945: refused before any call, the pool config included — a
    // rollback's reverse-replacement create replays a state record here too.
    const targets = readTargetLists({
      DBClusterIdentifiers: properties['DBClusterIdentifiers'],
      DBInstanceIdentifiers: properties['DBInstanceIdentifiers'],
    });
    if (targets.malformed.length > 0) {
      throw new ProvisioningError(
        `${targets.malformed.join(' / ')} of AWS::RDS::DBProxyTargetGroup ${logicalId} is not a ` +
          `list of RDS DB identifiers — no target registered`,
        resourceType,
        logicalId
      );
    }
    const dbClusterIdentifiers = targets.lists.DBClusterIdentifiers;
    const dbInstanceIdentifiers = targets.lists.DBInstanceIdentifiers;
    const connectionPoolConfig = properties['ConnectionPoolConfigurationInfo'] as
      | Record<string, unknown>
      | undefined;
    const mask = context?.maskSecrets ?? ((t: string) => t);
    // Refused before the first call: a malformed list would otherwise surface
    // only after the targets are registered. A state replay cannot fix its
    // record from the template, so there it warns and skips tagging, and the
    // key is dropped from what gets recorded.
    const desiredRead = readTagList(properties['Tags'], 'desired', DBPROXY_TAG_OPTIONS);
    const skipTags = context?.replayingState === true && desiredRead.kind === 'malformed';
    if (skipTags) {
      const reason = desiredRead.secretDerived
        ? 'holds a dynamic reference or its mask where a tag key belongs'
        : `is not ${DBPROXY_TAGS_WHAT}`;
      this.logger.warn(
        safeMsg`${logicalId}: the recorded Tags ${reason}; re-creating the target group without tags.`
      );
    }
    const tags = skipTags
      ? []
      : refuseMalformedDesiredTags(
          properties['Tags'],
          resourceType,
          logicalId,
          undefined,
          'Tags',
          DBPROXY_TAGS_WHAT,
          DBPROXY_TAG_OPTIONS
        );

    const client = this.getClient();

    if (connectionPoolConfig) {
      this.logger.debug(
        mask(`Applying connection pool config to ${dbProxyName}/${targetGroupName}`)
      );
      try {
        await client.send(
          new ModifyDBProxyTargetGroupCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            ConnectionPoolConfig: connectionPoolConfig as never,
          })
        );
      } catch (error) {
        // An adjustment of the proxy's own target group, not the registration
        // this resource creates: never this resource's collision (#3826).
        throw markAuxiliaryFailure(
          this.wrapError(error, 'CREATE (pool config)', resourceType, logicalId, undefined),
          logicalId
        );
      }
    }

    if (dbClusterIdentifiers.length > 0 || dbInstanceIdentifiers.length > 0) {
      this.logger.debug(
        mask(
          `Registering targets for ${dbProxyName}/${targetGroupName}: ` +
            `clusters=[${dbClusterIdentifiers.map(mask).join(',')}], ` +
            `instances=[${dbInstanceIdentifiers.map(mask).join(',')}]`
        )
      );
      try {
        await client.send(
          new RegisterDBProxyTargetsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            DBClusterIdentifiers:
              dbClusterIdentifiers.length > 0 ? dbClusterIdentifiers : undefined,
            DBInstanceIdentifiers:
              dbInstanceIdentifiers.length > 0 ? dbInstanceIdentifiers : undefined,
          })
        );
      } catch (error) {
        throw this.wrapError(
          error,
          'CREATE (register targets)',
          resourceType,
          logicalId,
          undefined
        );
      }
    }

    let targetGroupArn: string | undefined;
    try {
      const describeResponse = await client.send(
        new DescribeDBProxyTargetGroupsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
        })
      );
      targetGroupArn = describeResponse.TargetGroups?.[0]?.TargetGroupArn;
    } catch (error) {
      // Every throw from here on leaves the registration above live with
      // nothing recorded, so each retires it first.
      throw await this.retireRegistrationAfterFailedCreate(
        this.wrapError(error, 'CREATE (describe)', resourceType, logicalId, undefined),
        dbProxyName,
        targetGroupName,
        dbClusterIdentifiers,
        dbInstanceIdentifiers,
        context?.maskSecrets
      );
    }

    if (!targetGroupArn) {
      throw await this.retireRegistrationAfterFailedCreate(
        new ProvisioningError(
          `Failed to recover TargetGroupArn for ${dbProxyName}/${targetGroupName} after create`,
          resourceType,
          logicalId
        ),
        dbProxyName,
        targetGroupName,
        dbClusterIdentifiers,
        dbInstanceIdentifiers,
        context?.maskSecrets
      );
    }

    if (tags.length > 0) {
      try {
        await client.send(
          new AddTagsToResourceCommand({ ResourceName: targetGroupArn, Tags: tags })
        );
      } catch (error) {
        throw await this.retireRegistrationAfterFailedCreate(
          this.wrapError(error, 'CREATE (add tags)', resourceType, logicalId, undefined),
          dbProxyName,
          targetGroupName,
          dbClusterIdentifiers,
          dbInstanceIdentifiers,
          context?.maskSecrets
        );
      }
    }

    return {
      physicalId: targetGroupArn,
      attributes: {
        TargetGroupArn: targetGroupArn,
        TargetGroupName: targetGroupName,
      },
      ...(skipTags && { effectiveProperties: withoutKey(properties, 'Tags') }),
    };
  }

  /**
   * In-place update support: target add/remove (DBClusterIdentifiers /
   * DBInstanceIdentifiers diff) via `RegisterDBProxyTargets` /
   * `DeregisterDBProxyTargets`, and ConnectionPoolConfigurationInfo
   * rewrite via `ModifyDBProxyTargetGroup`. DBProxyName + TargetGroupName
   * are part of the resource identity — a diff in either surfaces as
   * replacement upstream (not handled here).
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    const dbProxyName = readProxyName(properties['DBProxyName']);
    if (!dbProxyName) {
      throw new ProvisioningError(
        `DBProxyName is required for AWS::RDS::DBProxyTargetGroup ${logicalId} update`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    // WARN, not throw: a rollback replays through `update()` with a historical
    // cdkd STATE record as the desired bag, so refusing here could leave a
    // resource un-rollbackable with no template-side remedy (issue #1513). The
    // `delete()` / `readCurrentState` reads below stay unguarded for the same
    // reason — both are state-side, never template-borne.
    //
    // Kept as a warning on EVERY caller, the template path included, when the
    // #3728 split was widened (issue #3740). `TargetGroupName` is createOnly
    // (CFn schema), so a changed value is a REPLACEMENT and never reaches
    // `update()`: a malformed value arriving here is one the recorded target
    // group already carries, and the only template edit that changes it
    // replaces the resource — not a repair a refusal could point at.
    const targetGroupName = requireConfigString(
      properties['TargetGroupName'],
      'default',
      'AWS::RDS::DBProxyTargetGroup TargetGroupName',
      { onUnusable: (message) => this.logger.warn(message) }
    );

    // Defensive: reject diffs in immutable identity fields. Replacement-rules.ts
    // SHOULD have routed those to a CREATE+DELETE replacement upstream; we
    // double-check here so a missing rule entry doesn't silently corrupt state.
    // The fields let through below because their recorded side is a secret
    // reference: confirmed against AWS before any write (see the probe).
    const exemptedBySecretReference: string[] = [];
    for (const field of ['DBProxyName', 'TargetGroupName']) {
      const oldVal = previousProperties[field];
      // Compare the GUARDED value for TargetGroupName, not the raw one. The
      // guard above may have warned and substituted 'default'; comparing the
      // raw `null` here would then throw `ResourceUpdateNotSupportedError` and
      // send the engine into a REPLACEMENT — making the warning's "using the
      // default for this update" a lie twelve lines after it was logged.
      const newVal = field === 'TargetGroupName' ? targetGroupName : properties[field];
      // TargetGroupName defaults to 'default' on AWS — treat undefined and
      // 'default' as equivalent on either side to avoid false-positive diff.
      const normalize = (v: unknown) =>
        field === 'TargetGroupName' && (v === undefined || v === 'default') ? 'default' : v;
      // A secret-derived name is recorded as its `{{resolve:...}}` reference
      // and handed here resolved, which is no change (go-to-k/cdkd#4275). The
      // physical id is the target group ARN, which names neither field.
      if (JSON.stringify(normalize(oldVal)) === JSON.stringify(normalize(newVal))) continue;
      if (
        await unchangedBehindSecretReference({
          resourceType,
          key: field,
          desired: newVal,
          previous: oldVal,
          maskSecrets: context?.maskSecrets,
        })
      ) {
        exemptedBySecretReference.push(field);
      } else {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `${field} is immutable on AWS::RDS::DBProxyTargetGroup — destroy + redeploy to change it`
        );
      }
    }

    // Refused on every path, before any call: a malformed desired list read as
    // empty would untag every live key (tag-list.ts).
    refuseMalformedDesiredTags(
      properties['Tags'],
      resourceType,
      logicalId,
      physicalId,
      'Tags',
      DBPROXY_TAGS_WHAT,
      DBPROXY_TAG_OPTIONS
    );

    // Every AWS call below -- the live target read, the pool, deregister and
    // register calls -- addresses the proxy by NAME, which another region can
    // also hold, and the deregister arm reads NotFound as success: refuse a
    // wrong-region client before any of them goes out.
    // The client region is resolved only when there is a recorded region to
    // hold it to: without one the check is a no-op, and resolving it can fail
    // on a client with no region configured.
    if (context?.expectedRegion) {
      assertRegionMatch(
        await this.getClient().config.region(),
        context.expectedRegion,
        resourceType,
        logicalId,
        physicalId,
        'pre-update'
      );
    }

    // go-to-k/cdkd#4275: every write below is addressed by the DESIRED proxy
    // and target group names, not by the physical id. A field exempted above
    // proves only that its desired value is still secret-derived, and a secret
    // ROTATED under an unchanged reference resolves to another proxy's name:
    // AWS must confirm the desired names still address the recorded target
    // group (its ARN is the physical id) before anything is written. Any
    // failure to confirm keeps the refusal.
    //
    // A rollback revert re-resolves BOTH sides with today's secret, so they
    // compare equal and nothing is exempted above, while the names may now
    // address another proxy: a replay is confirmed the same way, whatever the
    // names' provenance (the masker's substring floor misses a short name).
    const replayCheck = exemptedBySecretReference.length === 0 && context?.replayingState === true;
    if (exemptedBySecretReference.length > 0 || replayCheck) {
      const fields = replayCheck
        ? 'DBProxyName / TargetGroupName'
        : exemptedBySecretReference.join(' / ');
      const provenance = replayCheck
        ? 'replayed by a rollback, which resolves any secret they come from again'
        : 'secret-derived';
      // Each resolved name masked as a VALUE first, so one below the masker's
      // substring floor is caught where AWS quotes it, then the whole line.
      const base = context?.maskSecrets ?? ((t: string) => t);
      const maskNames = (text: string): string => {
        let out = text;
        // Longest first: a name inside the other must not break its match.
        for (const name of [dbProxyName, targetGroupName].sort((a, b) => b.length - a.length)) {
          const masked = base(name);
          if (name !== '' && masked !== name) out = out.split(name).join(masked);
        }
        return base(out);
      };
      let liveArn: string | undefined;
      let lookupFailure: unknown;
      try {
        const response = await this.getClient().send(
          new DescribeDBProxyTargetGroupsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
          })
        );
        liveArn = response.TargetGroups?.[0]?.TargetGroupArn;
      } catch (error) {
        // A NOT-FOUND answer is an answer, not a failure: the resolved names
        // address nothing, which is the usual shape of a rotated proxy name
        // (AWS throws rather than returning an empty list). It falls through
        // to the non-retryable rotation refusal below; re-running would never
        // help it.
        const notFound =
          error instanceof Error &&
          (error.name === 'DBProxyNotFoundFault' ||
            error.name === 'DBProxyTargetGroupNotFoundFault');
        if (!notFound) lookupFailure = error ?? new Error('an empty rejection');
        this.logger.debug(
          maskNames(
            `Could not confirm that the resolved names address ${logicalId}'s target group: ` +
              describeAwsFailure(error).detail
          )
        );
      }
      if (lookupFailure !== undefined) {
        // The refusal names the failure's CLASS only (the wire code, e.g.
        // `ThrottlingException`, `AccessDenied`): it
        // is not a rotation, and the operator's next step depends on which.
        // A `ProvisioningError`, NOT `ResourceUpdateNotSupportedError`: the
        // engine turns the latter into a replacement under `--replace`, and an
        // unconfirmed lookup is no evidence of a rename. The AWS text stays on
        // the cause (masked by the engine's error path), stamped so the retry
        // classifiers read it: a throttle stays retryable.
        const failureClass =
          lookupFailure instanceof Error && lookupFailure.name !== ''
            ? lookupFailure.name
            : 'an unreadable failure';
        const refusal = new ProvisioningError(
          `${fields} of AWS::RDS::DBProxyTargetGroup ${logicalId} is ${provenance}, and whether ` +
            `${replayCheck ? 'the names still address' : 'the value its secret resolves to still addresses'} the recorded target group could ` +
            `not be confirmed (${maskNames(failureClass)}) — re-run once the lookup can succeed`,
          resourceType,
          logicalId,
          physicalId,
          lookupFailure instanceof Error ? lookupFailure : undefined
        );
        markRedactedCause(refusal);
        throw refusal;
      }
      if (liveArn !== physicalId) {
        // A `ProvisioningError`, NOT `ResourceUpdateNotSupportedError`
        // (go-to-k/cdkd#4275): the template still spells the same reference, so
        // this is a rotation, not a rename, and the engine turns the typed error
        // into a replacement under `--replace`. Under `UpdateReplacePolicy:
        // Retain` that replacement is create-only, and `create()` registers the
        // targets on whatever proxy the secret now names, which can be another
        // environment's. Non-retryable: re-running reads the same secret.
        throw markNonRetryable(
          new ProvisioningError(
            `${fields} of AWS::RDS::DBProxyTargetGroup ${logicalId} is ${provenance}, and ` +
              `${replayCheck ? 'the names now address' : 'the value its secret now resolves to addresses'} ` +
              `${liveArn === undefined ? 'no target group' : 'a different target group'} ` +
              `(${replayCheck ? 'the proxy, or a secret its name comes from, may have changed' : 'the secret may have been rotated'}). ` +
              `cdkd does not move registered targets to another proxy, with or without ` +
              `--replace: ${replayCheck ? 'make the names address the proxy that holds this target group again' : "restore the secret's value to the proxy that holds this target group"}`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
    }

    // go-to-k/cdkd#3945: both sides are read as target lists before ANY call,
    // the pool config included. The previous side is the state record, and a
    // rollback revert or `drift --revert` replays this method with a recorded
    // bag as the DESIRED side, so neither is trusted to be a list. A refusal,
    // not a warning, on every caller: a malformed list names no target, and
    // any diff against it deregisters a real one or registers a stranger.
    const next = readTargetLists({
      DBClusterIdentifiers: properties['DBClusterIdentifiers'],
      DBInstanceIdentifiers: properties['DBInstanceIdentifiers'],
    });
    let prev = readTargetLists({
      DBClusterIdentifiers: previousProperties['DBClusterIdentifiers'],
      DBInstanceIdentifiers: previousProperties['DBInstanceIdentifiers'],
    });
    const mask = context?.maskSecrets ?? ((t: string) => t);
    // A recorded list cdkd keeps as a dynamic reference or its mask is read
    // from the proxy instead, when the desired side is well-formed (the IAM
    // `readPrincipalSides` rule, go-to-k/cdkd#3906). ADD-only: the live list
    // is narrowed to the desired identifiers, so nothing is deregistered on
    // its evidence — a target registered elsewhere stays, and is warned about.
    if (
      next.malformed.length === 0 &&
      prev.malformed.length > 0 &&
      prev.malformed.every((k) => prev.secretDerived.includes(k))
    ) {
      let live: Record<TargetListKind, string[]>;
      try {
        live = await this.readLiveTargets(dbProxyName, targetGroupName);
      } catch (error) {
        throw new ProvisioningError(
          `the recorded ${prev.malformed.join(' / ')} of AWS::RDS::DBProxyTargetGroup ${logicalId} ` +
            `is secret-derived and could not be read from the proxy — no target registered or ` +
            `deregistered, and the connection pool left unchanged`,
          resourceType,
          logicalId,
          physicalId,
          error instanceof Error ? error : undefined
        );
      }
      const lists = { ...prev.lists };
      for (const kind of prev.malformed) {
        const extra = missingIdentifiers(live[kind], next.lists[kind]);
        lists[kind] = missingIdentifiers(live[kind], extra);
        if (extra.length > 0) {
          this.logger.warn(
            safeMsg`The recorded ${kind} of DB proxy target group ${logicalId} is secret-derived, so cdkd read it from the proxy; the proxy also holds ${extra.length} target(s) the template does not declare, which cdkd leaves registered.`
          );
        }
      }
      prev = { lists, malformed: [], secretDerived: [] };
    }
    if (next.malformed.length > 0 || prev.malformed.length > 0) {
      const which = [
        ...next.malformed.map((k) => `desired ${k}`),
        ...prev.malformed.map((k) => `recorded ${k}`),
      ];
      throw new ProvisioningError(
        `${which.join(' / ')} of AWS::RDS::DBProxyTargetGroup ${logicalId} is not a list of RDS ` +
          `DB identifiers — no target registered or deregistered, and the connection pool ` +
          `left unchanged` +
          (prev.malformed.length > 0
            ? `: ${recordedPrincipalsRepair(
                prev.malformed,
                prev.secretDerived,
                'RDS DB identifiers',
                SECRET_DERIVED_TARGETS_REPAIR
              )}`
            : ''),
        resourceType,
        logicalId,
        physicalId
      );
    }

    const tagPlan = planTagDiff(
      previousProperties['Tags'],
      properties['Tags'],
      DBPROXY_TAG_OPTIONS
    );
    const tagWarning = tagPlanWarning(tagPlan, resourceType, logicalId);
    if (tagWarning !== undefined) this.logger.warn(tagWarning);

    const client = this.getClient();

    // 1. ConnectionPoolConfigurationInfo diff.
    const oldPool = previousProperties['ConnectionPoolConfigurationInfo'] as
      | Record<string, unknown>
      | undefined;
    const newPool = properties['ConnectionPoolConfigurationInfo'] as
      | Record<string, unknown>
      | undefined;
    if (JSON.stringify(oldPool) !== JSON.stringify(newPool)) {
      this.logger.debug(
        mask(`Updating connection pool config for ${dbProxyName}/${targetGroupName}`)
      );
      try {
        await client.send(
          new ModifyDBProxyTargetGroupCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            // Pass new config (may be empty {} when user removed the block;
            // AWS treats empty as "reset to defaults").
            ConnectionPoolConfig: (newPool ?? {}) as never,
          })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (pool config)', resourceType, logicalId, physicalId);
      }
    }

    // 2. Target diff: deregister removed, register added. Process clusters
    // and instances independently so the SDK call shape stays clean.
    const clustersToRemove = missingIdentifiers(
      prev.lists.DBClusterIdentifiers,
      next.lists.DBClusterIdentifiers
    );
    const clustersToAdd = missingIdentifiers(
      next.lists.DBClusterIdentifiers,
      prev.lists.DBClusterIdentifiers
    );
    const instancesToRemove = missingIdentifiers(
      prev.lists.DBInstanceIdentifiers,
      next.lists.DBInstanceIdentifiers
    );
    const instancesToAdd = missingIdentifiers(
      next.lists.DBInstanceIdentifiers,
      prev.lists.DBInstanceIdentifiers
    );

    if (clustersToRemove.length > 0 || instancesToRemove.length > 0) {
      this.logger.debug(
        mask(
          `Deregistering targets from ${dbProxyName}/${targetGroupName}: ` +
            `clusters=[${clustersToRemove.map(mask).join(',')}], ` +
            `instances=[${instancesToRemove.map(mask).join(',')}]`
        )
      );
      try {
        await client.send(
          new DeregisterDBProxyTargetsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            DBClusterIdentifiers: clustersToRemove.length > 0 ? clustersToRemove : undefined,
            DBInstanceIdentifiers: instancesToRemove.length > 0 ? instancesToRemove : undefined,
          })
        );
      } catch (error) {
        // Idempotent: a target that's already gone is fine. The region was
        // checked before the first call, so this NotFound is this region's.
        if (!(error instanceof DBProxyTargetNotFoundFault)) {
          throw this.wrapError(error, 'UPDATE (deregister)', resourceType, logicalId, physicalId);
        }
      }
    }

    if (clustersToAdd.length > 0 || instancesToAdd.length > 0) {
      this.logger.debug(
        mask(
          `Registering targets to ${dbProxyName}/${targetGroupName}: ` +
            `clusters=[${clustersToAdd.map(mask).join(',')}], ` +
            `instances=[${instancesToAdd.map(mask).join(',')}]`
        )
      );
      try {
        await client.send(
          new RegisterDBProxyTargetsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            DBClusterIdentifiers: clustersToAdd.length > 0 ? clustersToAdd : undefined,
            DBInstanceIdentifiers: instancesToAdd.length > 0 ? instancesToAdd : undefined,
          })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (register)', resourceType, logicalId, physicalId);
      }
    }

    // 3. Tags diff, addressed by the physicalId (the TargetGroupArn).
    const tagsToRemove = tagPlan.remove;
    const tagsToAdd = [...tagPlan.set].map(([Key, Value]) => ({ Key, Value }));
    if (tagsToRemove.length > 0) {
      try {
        await client.send(
          new RemoveTagsFromResourceCommand({ ResourceName: physicalId, TagKeys: tagsToRemove })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (remove tags)', resourceType, logicalId, physicalId);
      }
    }
    if (tagsToAdd.length > 0) {
      try {
        await client.send(
          new AddTagsToResourceCommand({ ResourceName: physicalId, Tags: tagsToAdd })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (add tags)', resourceType, logicalId, physicalId);
      }
    }

    return { physicalId, wasReplaced: false };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    const props = properties ?? {};
    // go-to-k/cdkd#3952: DeregisterDBProxyTargets names the proxy, the group
    // and each target from the record, and the NotFound faults below read as
    // "already gone" -- a redacted one would DROP the record over live targets.
    // The physicalId is the target group ARN, which names none of them.
    const redactedSkip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      'DB proxy target group',
      redactedDeleteAddressFields({
        DBProxyName: props['DBProxyName'],
        TargetGroupName: props['TargetGroupName'],
        DBClusterIdentifiers: props['DBClusterIdentifiers'],
        DBInstanceIdentifiers: props['DBInstanceIdentifiers'],
      })
    );
    if (redactedSkip) return redactedSkip;
    // A non-string name is read as absent, not cast: the SDK sends `{}` as
    // `[object Object]`, and the NotFound arm below would then read the miss as
    // "already gone" and drop the record over the live targets. `default` is
    // the only group name CloudFormation accepts.
    const dbProxyName = readProxyName(props['DBProxyName']);
    const targetGroupName = requireConfigString(
      props['TargetGroupName'],
      'default',
      'AWS::RDS::DBProxyTargetGroup TargetGroupName',
      { onUnusable: (message) => this.logger.warn(message) }
    );
    // go-to-k/cdkd#3945: a recorded list that is not a list of identifiers is
    // skipped before any call rather than guessing which targets it names: the
    // SDK sends no list for a string, so the Deregister below would name no
    // target, and returning after it drops the record over the still-registered
    // real one.
    const targets = readTargetLists({
      DBClusterIdentifiers: props['DBClusterIdentifiers'],
      DBInstanceIdentifiers: props['DBInstanceIdentifiers'],
    });
    // A well-formed record naming no target has nothing to deregister, whatever
    // its proxy or group name says: it finishes before either name is needed.
    if (
      targets.malformed.length === 0 &&
      targets.lists.DBClusterIdentifiers.length === 0 &&
      targets.lists.DBInstanceIdentifiers.length === 0
    ) {
      this.logger.debug(`No targets recorded for ${logicalId}; nothing to deregister`);
      return;
    }

    // CloudFormation accepts only `default` here, so any other recorded name
    // addresses no group this resource made: a NotFound for it proves nothing
    // about the real `default` group's targets, and reading it as "already
    // gone" (the Deregister catch below) would drop the record over them.
    // Checked BEFORE the missing-DBProxyName remedy, which would otherwise
    // paste the bogus name into a command. A parent proxy that is itself gone
    // still finishes.
    if (targetGroupName !== 'default') {
      if (
        dbProxyName &&
        (await this.proxyConfirmedGone(
          dbProxyName,
          undefined,
          resourceType,
          logicalId,
          physicalId,
          context
        ))
      ) {
        return;
      }
      this.logger.warn(
        safeMsg`The state record for DB proxy target group ${logicalId} holds a TargetGroupName other than 'default', the only value CloudFormation accepts — skipping deletion rather than addressing a group this resource did not make. No deregistration is issued, so its targets stay REGISTERED on the proxy unless this run later deletes the parent DB proxy. The state record is KEPT: repair TargetGroupName in state.json to 'default' and re-run, or deregister the targets by hand. A deploy-side REPLACEMENT or rollback delete instead FAILS the resource (https://github.com/go-to-k/cdkd/issues/1762); there, deregister the targets by hand.`
      );
      return { outcome: 'skipped', reason: NON_DEFAULT_GROUP_SKIP_REASON };
    }

    if (!dbProxyName) {
      // No way to deregister without DBProxyName. This shouldn't happen
      // when cdkd state was populated by this provider's create(), but
      // could occur on an imported / hand-edited state. Surface as a real
      // error rather than silently no-op so the user knows to clean up
      // manually. The group name is state-borne, so the command goes through
      // `pasteableAwsCommand` (go-to-k/cdkd#3136). Only `default` reaches here
      // — any other recorded name took the skip above — so the command never
      // pastes a record-chosen name.
      const aws = pasteableAwsCommand();
      const command =
        aws`aws rds deregister-db-proxy-targets --db-proxy-name '<proxy-name>' --target-group-name ${targetGroupName}`.render();
      throw new ProvisioningError(
        `DBProxyName missing from state.properties for AWS::RDS::DBProxyTargetGroup ${logicalId}; cannot deregister targets. ` +
          `Manually run ${command} ` +
          `with --db-cluster-identifiers / --db-instance-identifiers naming the registered targets`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (targets.malformed.length > 0) {
      // Exhaust the live source before skipping: a proxy or group already
      // gone (deleted earlier in this run, or by CASCADE) is a finished delete,
      // not a skip that would repeat on every destroy. Any other probe outcome
      // — the group exists, or the probe failed — keeps the skip.
      if (
        await this.proxyConfirmedGone(
          dbProxyName,
          targetGroupName,
          resourceType,
          logicalId,
          physicalId,
          context
        )
      ) {
        return;
      }
      this.logger.warn(
        safeMsg`The state record for DB proxy target group ${logicalId} holds a ${targets.malformed.join(' / ')} that is not a list of RDS DB identifiers — skipping deletion rather than guessing which targets it names. The target group still exists (or could not be checked) and no deregistration is issued, so the targets stay REGISTERED on the proxy unless this run later deletes the parent DB proxy (then only the record is stale). The state record is KEPT: on 'cdkd destroy' / 'cdkd state destroy' (which exits non-zero) and on the plain DELETE of a resource removed from the template during cdkd deploy, repair the recorded list in state.json to the identifiers the target group holds ('aws rds describe-db-proxy-targets' lists them) and re-run, or deregister the targets by hand. A deploy-side REPLACEMENT or rollback delete instead FAILS the resource (https://github.com/go-to-k/cdkd/issues/1762); there, deregister the targets by hand.`
      );
      return { outcome: 'skipped', reason: MALFORMED_TARGETS_SKIP_REASON };
    }
    const dbClusterIdentifiers = targets.lists.DBClusterIdentifiers;
    const dbInstanceIdentifiers = targets.lists.DBInstanceIdentifiers;

    // Unmasked: `delete()` has no masker (provider-delete-path.md), and every
    // identifier here passed `readTargetLists` after the redacted-address skip,
    // so none is a reference, a mask, or anything but a plain RDS identifier.
    this.logger.debug(
      `Deregistering targets from ${dbProxyName}/${targetGroupName}: ` +
        `clusters=[${dbClusterIdentifiers.join(',')}], ` +
        `instances=[${dbInstanceIdentifiers.join(',')}]`
    );

    try {
      await this.getClient().send(
        new DeregisterDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          DBClusterIdentifiers: dbClusterIdentifiers.length > 0 ? dbClusterIdentifiers : undefined,
          DBInstanceIdentifiers:
            dbInstanceIdentifiers.length > 0 ? dbInstanceIdentifiers : undefined,
        })
      );
    } catch (error) {
      // Idempotent success when the parent DBProxy, the TargetGroup, or
      // any individual target is already gone — typically because a sibling
      // cdkd delete or AWS-side CASCADE already removed them. Region-match
      // guard prevents silently masking a wrong-region destroy that would
      // otherwise leave the actual AWS resources orphaned.
      if (
        error instanceof DBProxyNotFoundFault ||
        error instanceof DBProxyTargetGroupNotFoundFault ||
        error instanceof DBProxyTargetNotFoundFault
      ) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `${dbProxyName}/${targetGroupName} or its target is already gone, treating as success`
        );
        return;
      }
      throw this.wrapError(error, 'DELETE', resourceType, logicalId, physicalId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- attribute resolution does not need AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'TargetGroupArn':
        return physicalId;
      case 'TargetGroupName':
        return 'default';
      default:
        this.logger.warn(
          `Unknown attribute ${attributeName} for AWS::RDS::DBProxyTargetGroup, returning undefined`
        );
        return undefined;
    }
  }

  /**
   * Adopt an existing DBProxyTargetGroup into cdkd state.
   *
   * **Explicit override only.** AWS rejects `aws:`-prefixed tag writes, so
   * no `aws:cdk:path` tag exists to look the target group up by. Users must pass
   * `--resource <logicalId>=<TargetGroupArn>`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return {
        physicalId: input.knownPhysicalId,
        attributes: {
          TargetGroupArn: input.knownPhysicalId,
          TargetGroupName: 'default',
        },
      };
    }
    return null;
  }

  /**
   * Read the AWS-current configuration as CFn property shape. Used by
   * `cdkd drift` for the SDK-provider path (without it the comparator
   * falls back to CC API, which is broken on this type — Issue #385 the
   * SDK provider was added to fix in the first place).
   *
   * Maps:
   * - `DescribeDBProxyTargetGroups` → `ConnectionPoolConfigurationInfo`
   *   (the connection pool config CFn template carries).
   * - `DescribeDBProxyTargets` → `DBClusterIdentifiers` /
   *   `DBInstanceIdentifiers` reverse-mapped from the AWS-side target
   *   list via `Type` discriminator. The full target list also carries
   *   per-target Endpoint / Port / TargetHealth but those are read-only
   *   AWS-managed fields, intentionally not surfaced.
   *
   * A missing parent DBProxyName (state corruption) surfaces as `undefined`
   * (drift comparator skips the resource), not a crash. A gone proxy, or a
   * gone `default` group, is `RESOURCE_NOT_FOUND`; a group NotFound for any
   * other recorded name addresses no group this resource made, so it stays
   * `undefined`.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const dbProxyName = readProxyName(properties['DBProxyName']);
    const targetGroupName = requireConfigString(
      properties['TargetGroupName'],
      'default',
      'AWS::RDS::DBProxyTargetGroup TargetGroupName',
      { onUnusable: (message) => this.logger.warn(message) }
    );
    if (!dbProxyName) {
      // No way to recover the AWS-side state without the parent name —
      // happens on imported / hand-edited state that lost DBProxyName.
      return undefined;
    }

    const client = this.getClient();
    const groupGone = (error: unknown): boolean =>
      error instanceof DBProxyNotFoundFault ||
      (targetGroupName === 'default' && error instanceof DBProxyTargetGroupNotFoundFault);

    let connectionPoolConfig: Record<string, unknown> | undefined;
    try {
      const tgResp = await client.send(
        new DescribeDBProxyTargetGroupsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
        })
      );
      const tg = tgResp.TargetGroups?.[0];
      // AWS-side `ConnectionPoolConfig` (the Describe response shape) maps
      // 1:1 to the CFn `ConnectionPoolConfigurationInfo` field (the input
      // shape). Surfacing it always (even when AWS returns defaults) lets
      // a console-side change to MaxConnectionsPercent / etc. show as
      // drift on the v3 observedProperties baseline.
      connectionPoolConfig = tg?.ConnectionPoolConfig as Record<string, unknown> | undefined;
    } catch (error) {
      if (groupGone(error)) return RESOURCE_NOT_FOUND;
      if (error instanceof DBProxyTargetGroupNotFoundFault) return undefined;
      throw error;
    }

    let live: Record<TargetListKind, string[]>;
    try {
      live = await this.readLiveTargets(dbProxyName, targetGroupName);
    } catch (error) {
      if (groupGone(error)) return RESOURCE_NOT_FOUND;
      if (
        error instanceof DBProxyTargetGroupNotFoundFault ||
        error instanceof DBProxyTargetNotFoundFault
      ) {
        return undefined;
      }
      throw error;
    }

    // RDS reports identifiers lowercased; a live id matching a recorded one
    // case-insensitively is reported in the RECORDED spelling, so a template's
    // `MyCluster` is not phantom drift against AWS's `mycluster` (the same
    // equality `update()`'s diff uses).
    const recorded = readTargetLists({
      DBClusterIdentifiers: properties['DBClusterIdentifiers'],
      DBInstanceIdentifiers: properties['DBInstanceIdentifiers'],
    }).lists;
    const inRecordedSpelling = (ids: string[], spellings: string[]): string[] => {
      const byKey = new Map(spellings.map((s) => [s.toLowerCase(), s]));
      return ids.map((id) => byKey.get(id.toLowerCase()) ?? id);
    };
    const result: Record<string, unknown> = {
      DBProxyName: dbProxyName,
      TargetGroupName: targetGroupName,
      DBClusterIdentifiers: inRecordedSpelling(
        live.DBClusterIdentifiers,
        recorded.DBClusterIdentifiers
      ),
      DBInstanceIdentifiers: inRecordedSpelling(
        live.DBInstanceIdentifiers,
        recorded.DBInstanceIdentifiers
      ),
    };
    if (connectionPoolConfig !== undefined) {
      result['ConnectionPoolConfigurationInfo'] = connectionPoolConfig;
    }
    // Omitted, not `[]`, when the tag read fails: "could not read" must not
    // read as "has no tags".
    try {
      const tagResp = await client.send(
        new ListTagsForResourceCommand({ ResourceName: physicalId })
      );
      result['Tags'] = normalizeAwsTagsToCfn(tagResp.TagList ?? []);
    } catch (error) {
      this.logger.debug(
        safeMsg`ListTagsForResource failed for ${physicalId}: ${describeAwsFailure(error).detail}`
      );
    }
    return result;
  }

  /**
   * Deregister what a failing `create()` registered, then hand back the
   * ORIGINAL error — with the manual command appended when the cleanup
   * itself fails.
   */
  private async retireRegistrationAfterFailedCreate(
    original: ProvisioningError,
    dbProxyName: string,
    targetGroupName: string,
    dbClusterIdentifiers: string[] | undefined,
    dbInstanceIdentifiers: string[] | undefined,
    maskSecrets: ((text: string) => string) | undefined
  ): Promise<ProvisioningError> {
    const clusters = dbClusterIdentifiers?.length ? dbClusterIdentifiers : undefined;
    const instances = dbInstanceIdentifiers?.length ? dbInstanceIdentifiers : undefined;
    if (!clusters && !instances) return original;
    try {
      await this.getClient().send(
        new DeregisterDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          DBClusterIdentifiers: clusters,
          DBInstanceIdentifiers: instances,
        })
      );
      return original;
    } catch (cleanupError) {
      // Template-chosen names, so the command renders through
      // `pasteableAwsCommand` (issue #3136) and is withheld rather than
      // printed inexactly.
      const aws = pasteableAwsCommand(maskSecrets);
      let targets = aws``;
      if (clusters) {
        targets = aws`${targets} --db-cluster-identifiers`;
        for (const id of clusters) targets = aws`${targets} ${id}`;
      }
      if (instances) {
        targets = aws`${targets} --db-instance-identifiers`;
        for (const id of instances) targets = aws`${targets} ${id}`;
      }
      original.message +=
        ` The targets this create registered are still registered and could not be ` +
        `deregistered (${describeAwsFailure(cleanupError).detail}). Manual cleanup: ` +
        aws`aws rds deregister-db-proxy-targets --db-proxy-name ${dbProxyName} --target-group-name ${targetGroupName}${targets}`.render();
      return original;
    }
  }

  /**
   * Whether `delete()` may read the parent as already gone, from
   * `DescribeDBProxyTargetGroups`. With a `targetGroupName`, a missing proxy OR
   * group counts; without one (the recorded name is not `default`, so a group
   * NotFound would prove nothing), only a missing proxy does. A NotFound is
   * region-gated like every other idempotent arm; any other outcome is `false`,
   * and a failed probe is logged at debug so the skip that follows is
   * traceable.
   */
  private async proxyConfirmedGone(
    dbProxyName: string,
    targetGroupName: string | undefined,
    resourceType: string,
    logicalId: string,
    physicalId: string,
    context: DeleteContext | undefined
  ): Promise<boolean> {
    try {
      await this.getClient().send(
        new DescribeDBProxyTargetGroupsCommand({
          DBProxyName: dbProxyName,
          ...(targetGroupName !== undefined ? { TargetGroupName: targetGroupName } : {}),
        })
      );
      return false;
    } catch (error) {
      if (
        error instanceof DBProxyNotFoundFault ||
        (targetGroupName !== undefined && error instanceof DBProxyTargetGroupNotFoundFault)
      ) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `${dbProxyName}/${targetGroupName ?? '*'} is already gone; the record needs no deregistration`
        );
        return true;
      }
      this.logger.debug(
        safeMsg`Could not confirm whether the proxy of DB proxy target group ${logicalId} still exists (${error instanceof Error ? error.name : 'unknown error'}); keeping the skip`
      );
      return false;
    }
  }

  /**
   * The proxy target group's registered targets as the two CFn lists, from
   * `DescribeDBProxyTargets`. Shared by `readCurrentState` and `update()`'s
   * secret-derived recorded side; throws whatever the call throws.
   */
  private async readLiveTargets(
    dbProxyName: string,
    targetGroupName: string
  ): Promise<Record<TargetListKind, string[]>> {
    const live: Record<TargetListKind, string[]> = {
      DBClusterIdentifiers: [],
      DBInstanceIdentifiers: [],
    };
    let marker: string | undefined;
    do {
      const targetsResp = await this.getClient().send(
        new DescribeDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          ...(marker ? { Marker: marker } : {}),
        })
      );
      for (const target of targetsResp.Targets ?? []) {
        const id = target.RdsResourceId;
        if (!id) continue;
        if (target.Type === 'TRACKED_CLUSTER') {
          live.DBClusterIdentifiers.push(id);
        } else if (target.Type === 'RDS_INSTANCE' && !target.TrackedClusterId) {
          // A member instance of a registered cluster is listed as its own
          // `RDS_INSTANCE` target carrying `TrackedClusterId`; it is the
          // cluster's registration, not a `DBInstanceIdentifiers` entry.
          live.DBInstanceIdentifiers.push(id);
        }
        // `RDS_SERVERLESS_ENDPOINT` targets are silently skipped — the
        // CFn `AWS::RDS::DBProxyTargetGroup` schema has no input slot for
        // them (only `DBClusterIdentifiers` / `DBInstanceIdentifiers`),
        // so they can't drift on a cdkd-managed target group.
      }
      marker = targetsResp.Marker;
    } while (marker);
    return live;
  }

  private wrapError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined
  ): ProvisioningError {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error : undefined;
    return new ProvisioningError(
      `${op} failed for ${logicalId}: ${message}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  }
}

function withoutKey(bag: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = bag;
  return rest;
}
