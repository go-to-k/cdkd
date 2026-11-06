import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  DescribeScalingPoliciesCommand,
  RegisterScalableTargetCommand,
  PutScalingPolicyCommand,
  DeleteScalingPolicyCommand,
  DeregisterScalableTargetCommand,
  type DescribeScalableTargetsCommandOutput,
  type DescribeScalingPoliciesCommandOutput,
} from '@aws-sdk/client-application-auto-scaling';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { isRefusedByName, type DeleteProgress } from '../../delete-started.js';
import { coerceCfnInteger } from '../../config-shape.js';
import { withRetry } from '../../../deployment/retry.js';
import { isInterruptedWaitError, startInterruptWatch } from '../../interrupt-watch.js';
import { isThrottlingError } from '../../../deployment/retryable-errors.js';
import {
  AUTO_SCALING_TEARDOWN_MAX_RETRIES,
  autoScalingRetriesWithinDeleteBudget,
} from '../dynamodb-delete-budget.js';
import { ElapsedBudget } from '../../../utils/elapsed-budget.js';
import { maskDeep } from '../../masked-retry-logger.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import type { SecretMasker } from '../../../types/resource.js';
import { markUnsettled } from './projection.js';
import {
  isDynamoDBScalableDimension,
  autoScalingTargetKey,
  autoScalingResourceId,
  autoScalingRetryDelays,
  DESCRIBE_SCALABLE_TARGETS_BATCH,
  type DynamoDBScalableDimension,
  type AutoScalingTargetSpec,
} from './capacity.js';
import { deepEqual } from './gsi-diff.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

/**
 * Apply an application-autoscaling diff for one (tableName, dimension)
 * pair (Issue #402 / PR closing Issue #395's deferred items).
 *
 * Dimension is either:
 *  - `dynamodb:table:WriteCapacityUnits` (table-level write capacity),
 *    paired with the local-region autoscaling client.
 *  - `dynamodb:table:ReadCapacityUnits` (per-replica read capacity),
 *    paired with a region-scoped autoscaling client returned by
 *    `getRegionalAutoScalingClient`.
 *
 * Diff semantics (idempotent upsert, per Issue #402 spec):
 *  - new auto-scaling settings present (Min/Max + TargetValue) →
 *    `RegisterScalableTarget` (upsert) + `PutScalingPolicy` (upsert).
 *    AWS's `RegisterScalableTarget` accepts no-op Min/Max changes
 *    silently, and `PutScalingPolicy` is idempotent on the same
 *    policy name (`DynamoDB{Write,Read}CapacityUtilization:table/<name>`).
 *  - old auto-scaling settings present but new ones absent (= null) →
 *    `DeleteScalingPolicy` + `DeregisterScalableTarget`. AWS rejects
 *    `DeregisterScalableTarget` on a still-policy-attached target,
 *    so the policy must be deleted FIRST.
 *  - neither side has auto-scaling settings → no-op.
 *
 * **Best-effort**: any AWS error is logged at WARN with the per-API
 * recovery command and the deploy continues — auto-scaling drift is
 * recoverable on the next deploy, and an aborted deploy is much worse
 * UX than a transient auto-scaling miss. This matches the cross-region
 * Tags propagation contract (PR #393).
 *
 * **Policy naming** matches AWS's CDK / console default:
 *   `DynamoDBWriteCapacityUtilization:table/<table-name>` (write)
 *   `DynamoDBReadCapacityUtilization:table/<table-name>`  (read)
 * so re-imports against a console-created target also match.
 *
 * **`SeedCapacity` is intentionally NOT forwarded** — it is a CFn
 * create-only field with no corresponding `RegisterScalableTarget`
 * surface; `readAutoScalingSettings` also explicitly skips it.
 */
export async function applyAutoScalingDiff(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  dimension: DynamoDBScalableDimension,
  oldSettings: Record<string, unknown> | undefined,
  newSettings: Record<string, unknown> | undefined,
  client?: ApplicationAutoScalingClient,
  indexName?: string,
  budget?: ElapsedBudget,
  // The caller's secret masker (issue #1997). The malformed-capacity warning
  // below names `MinCapacity` / `MaxCapacity` straight out of the RESOLVED
  // auto-scaling settings bag. The DELETE path passes its
  // `DeleteContext.maskSecrets` too (go-to-k/cdkd#5581): its teardown sends
  // EMPTY settings, so that warning cannot fire there, but the teardown's own
  // warnings name the table. Defaults to IDENTITY for a caller passing none.
  maskSecrets: SecretMasker = (text) => text,
  // go-to-k/cdkd#4946: the delete's flag, set once the teardown may have
  // removed a policy or target. Absent on every create / update caller.
  progress?: DeleteProgress
): Promise<void> {
  // go-to-k/cdkd#5487: the top-level key these settings belong to — an
  // index's, the table's write side, or a replica's read side.
  const autoScalingKey =
    indexName !== undefined
      ? 'GlobalSecondaryIndexes'
      : dimension.includes('Write')
        ? 'WriteProvisionedThroughputSettings'
        : 'Replicas';
  // ONE masked sink (issue #1997) — see `update()` for why both layers.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  // Issue #1955: the DELETE path calls this in a BURST — table-level plus one
  // per GSI, per non-local replica, then again locally — BEFORE the first
  // budgeted poll. Both branches below now retry throttles: the register one
  // always did, and the TEARDOWN one (the only branch the delete path takes,
  // since every delete-path caller passes `newSettings: undefined`) gained it
  // with this change, because a swallowed throttle there leaves a scalable
  // target silently REGISTERED — the PR #403 leak a future table of the same
  // name inherits, the exact mirror of the never-registered gap the register
  // branch's retry closes.
  //
  // Retrying on a path that shares one deadline with every wait after it is
  // what makes the bound necessary. `asMaxRetries` is funded from the SURPLUS
  // above a reserve, so a throttled burst cannot spend the allowance the
  // delete itself needs, and at zero the call is still ISSUED once — the
  // leak-prevention never depends on the retry. Every CREATE / UPDATE caller
  // passes no budget and keeps `withRetry`'s default schedule.
  // See `autoScalingRetriesWithinDeleteBudget` for the arithmetic.
  const asMaxRetries = autoScalingRetriesWithinDeleteBudget(
    budget,
    AUTO_SCALING_TEARDOWN_MAX_RETRIES
  );
  const isWrite = dimension.endsWith('WriteCapacityUnits');
  const metricType = isWrite
    ? 'DynamoDBWriteCapacityUtilization'
    : 'DynamoDBReadCapacityUtilization';
  // Index-level targets register against `table/<t>/index/<i>` (Issue #1419);
  // table-level keeps `table/<t>`. The policy name follows AWS's own
  // `<metricType>:<resourceId>` convention, so the table-level spelling is
  // byte-identical to what shipped before this generalization — a renamed
  // policy would orphan the existing one on every already-deployed table.
  const resourceId = autoScalingResourceId(tableName, indexName);
  const policyName = `${metricType}:${resourceId}`;

  // PR #403 review minor #4: route the no-client-arg fallback through
  // the cached `getLocalAutoScalingClient()` rather than constructing
  // a fresh client per call. Multi-stack runs with many GlobalTables
  // were leaking SDK clients (each holds its own HTTP agent).
  const asClient = client ?? (await this.getLocalAutoScalingClient());

  const oldEnabled = oldSettings !== undefined && oldSettings !== null;
  const newEnabled = newSettings !== undefined && newSettings !== null;

  if (!oldEnabled && !newEnabled) {
    return; // nothing to do
  }

  // ONE watch for all four `withRetry` calls below (issue #2053). They run
  // back to back on the same table — register + policy on the deploy path,
  // policy-delete + deregister on the teardown path — so a single Ctrl-C has
  // to abort whichever of them is currently sitting in its backoff, and a
  // watch per call would install and tear one down four times for one wait.
  //
  // Started HERE, after the no-op early return above, rather than at the top
  // of the method: the common call on a table with no auto-scaling reaches
  // neither branch, and a watch taken for it is added and removed for a
  // method that never waits. Every `return` from this point on unwinds
  // through the `finally` that disposes it.
  // Masked for the same reason as the replica-copy wait's label: it reaches
  // the user in `InterruptedWaitError`'s message on Ctrl-C.
  const watch = startInterruptWatch(maskSecrets(`DynamoDB auto-scaling for ${tableName}`));
  try {
    if (newEnabled) {
      // Register OR update scalable target (idempotent on no-op).
      //
      // `coerceCfnInteger`, the same reader `pickAutoScalingCapacity` takes
      // `MinCapacity` through for the table's own capacity (issue #3135):
      // these two FORWARD the same member to two services, and on a
      // `Number()` read a padded `" 7 "` registered a scalable target at 7
      // while the capacity derivation beside it had already dropped the
      // value and sent the announced 5/5 fallback. A spelling CloudFormation
      // rejects now takes this block's existing warn-and-skip arm, exactly
      // like a non-numeric value. The `?? 0` keeps an ABSENT member's
      // pre-existing reading (zero, which AWS refuses by name).
      const minCapacity = coerceCfnInteger(newSettings!['MinCapacity'] ?? 0);
      const maxCapacity = coerceCfnInteger(newSettings!['MaxCapacity'] ?? 0);
      if (minCapacity === undefined || maxCapacity === undefined) {
        warn(
          `Cannot apply auto-scaling diff on ${tableName} (${dimension}): ` +
            `MinCapacity / MaxCapacity must be integers CloudFormation accepts ` +
            `(an optional sign and decimal digits; no surrounding whitespace, hex, ` +
            `exponent or decimal point), got ` +
            // Masked as RAW values (issue #1997): `String()` of a resolved
            // secret is the plaintext itself, and the WHOLE-VALUE arm matches at
            // any length where the sink's substring arm needs 4 characters.
            `${maskSecrets(String(newSettings!['MinCapacity']))} / ` +
            `${maskSecrets(String(newSettings!['MaxCapacity']))}`
        );
        return;
      }
      try {
        // Throttle-only retry (Issue #1419 review): a table with many
        // indexes issues a burst of these, and application-autoscaling is
        // throttled per account. Every error here is swallowed into a WARN,
        // so an un-retried `ThrottlingException` would leave the target
        // unregistered *silently* — re-introducing, under load, exactly the
        // never-registered gap this change closes. Non-throttle failures
        // still fall straight through to the WARN below.
        markUnsettled(autoScalingKey);
        await withRetry(
          () =>
            asClient.send(
              new RegisterScalableTargetCommand({
                ServiceNamespace: 'dynamodb',
                ResourceId: resourceId,
                ScalableDimension: dimension,
                MinCapacity: minCapacity,
                MaxCapacity: maxCapacity,
              })
            ),
          `${resourceId} (${dimension})`,
          {
            // `isRetryable` is invoked as `(message, error)`. Passing
            // `isThrottlingError` DIRECTLY hands it the message STRING, on
            // which it finds no `.name` / `.$metadata` / `.cause` and always
            // returns false — and because `isRetryable` is set at all, the
            // call also opts out of the default schedule. It typechecks (a
            // 1-arg `unknown` callback is assignable) and silently disables
            // the retry entirely. Same spelling as `describe-type.ts`.
            isRetryable: (_message, error) => isThrottlingError(error),
            maxRetries: asMaxRetries,
            isInterrupted: watch.isInterrupted,
            onInterrupted: watch.onInterrupted,
            ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
          }
        );
      } catch (err) {
        // A user abort is not an AWS failure (issue #2053 review). Swallowing it
        // printed up to two "Could not ... Run: aws application-autoscaling ..."
        // lines PER dimension, per GSI and per replica -- blaming AWS for a Ctrl-C
        // -- and then carried straight on to the next teardown WRITE. Re-throwing
        // stops the burst; `delete()`'s catch passes it through unwrapped.
        if (isInterruptedWaitError(err)) throw err;
        warn(
          `Could not register auto-scaling target on ${tableName} (${dimension}): ` +
            `${describeAwsFailure(err).detail}. ` +
            `Run: ${pasteableAwsCommand(maskSecrets)`aws application-autoscaling register-scalable-target --service-namespace dynamodb --resource-id ${resourceId} --scalable-dimension ${dimension} --min-capacity ${String(minCapacity)} --max-capacity ${String(maxCapacity)}`.render()}`
        );
        return;
      }

      const tttCfg = (newSettings!['TargetTrackingScalingPolicyConfiguration'] ?? {}) as Record<
        string,
        unknown
      >;
      const targetValue = Number(tttCfg['TargetValue']);
      if (!Number.isFinite(targetValue)) {
        warn(
          `Auto-scaling target registered on ${tableName} (${dimension}) but ` +
            `TargetValue is missing or non-numeric — skipping PutScalingPolicy. ` +
            `Provide TargetTrackingScalingPolicyConfiguration.TargetValue in the template.`
        );
        return;
      }
      const targetTrackingConfig: Record<string, unknown> = {
        PredefinedMetricSpecification: { PredefinedMetricType: metricType },
        TargetValue: targetValue,
      };
      // The two cooldowns are CloudFormation Integers and are FORWARDED, so
      // they take the DynamoDB grammar too (issue #3135); a rejected spelling
      // is announced and OMITTED (the service default applies) rather than
      // sent as `Number()`'s reading or as `NaN`. `TargetValue` above is a
      // CloudFormation Double, whose grammar is unmeasured, and keeps `Number()`.
      for (const cooldown of ['ScaleInCooldown', 'ScaleOutCooldown'] as const) {
        const raw = tttCfg[cooldown];
        if (raw === undefined) continue;
        const seconds = coerceCfnInteger(raw);
        if (seconds === undefined) {
          warn(
            `Auto-scaling policy on ${tableName} (${dimension}): ` +
              `TargetTrackingScalingPolicyConfiguration.${cooldown} is not an integer ` +
              `CloudFormation accepts (got ${JSON.stringify(maskDeep(raw, maskSecrets))?.slice(0, 80)}), ` +
              `so it is omitted and the service default applies.`
          );
          continue;
        }
        targetTrackingConfig[cooldown] = seconds;
      }
      if (tttCfg['DisableScaleIn'] !== undefined) {
        targetTrackingConfig['DisableScaleIn'] = Boolean(tttCfg['DisableScaleIn']);
      }
      try {
        // Same throttle-only retry as the register above — a swallowed
        // throttle here leaves a registered target with NO policy, which
        // scales nothing.
        markUnsettled(autoScalingKey);
        await withRetry(
          () =>
            asClient.send(
              new PutScalingPolicyCommand({
                PolicyName: policyName,
                ServiceNamespace: 'dynamodb',
                ResourceId: resourceId,
                ScalableDimension: dimension,
                PolicyType: 'TargetTrackingScaling',
                // SDK input shape uses Pascal-cased keys; the inner config object
                // is the same shape we read back via DescribeScalingPolicies.
                TargetTrackingScalingPolicyConfiguration: targetTrackingConfig as never,
              })
            ),
          `${policyName}`,
          {
            isRetryable: (_message, error) => isThrottlingError(error),
            maxRetries: asMaxRetries,
            isInterrupted: watch.isInterrupted,
            onInterrupted: watch.onInterrupted,
            ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
          }
        );
        this.logger.debug(
          maskSecrets(`Upserted auto-scaling policy ${policyName} on ${tableName} (${dimension})`)
        );
      } catch (err) {
        // A user abort is not an AWS failure (issue #2053 review). Swallowing it
        // printed up to two "Could not ... Run: aws application-autoscaling ..."
        // lines PER dimension, per GSI and per replica -- blaming AWS for a Ctrl-C
        // -- and then carried straight on to the next teardown WRITE. Re-throwing
        // stops the burst; `delete()`'s catch passes it through unwrapped.
        if (isInterruptedWaitError(err)) throw err;
        warn(
          `Could not put auto-scaling policy on ${tableName} (${dimension}): ` +
            `${describeAwsFailure(err).detail}. ` +
            `Run: ${pasteableAwsCommand(maskSecrets)`aws application-autoscaling put-scaling-policy --policy-name ${policyName} --service-namespace dynamodb --resource-id ${resourceId} --scalable-dimension ${dimension} --policy-type TargetTrackingScaling`.render()}`
        );
      }
      return;
    }

    // newEnabled === false, oldEnabled === true: tear down.
    // Idempotency: AWS's application-autoscaling raises
    // `ObjectNotFoundException` ("No scaling policy found" / "No
    // scalable target found") when the resource is already gone.
    // That is success for our purposes (e.g. the `update()` BillingMode
    // flip already tore down autoscaling, and now `delete()`'s defense-
    // in-depth teardown fires). Detect via the error name AND message
    // substring (the SDK doesn't always type-name the error on first
    // exposure) and silently skip — only surface non-RNF errors as
    // WARN with the recovery command.
    const isObjectNotFound = (err: unknown): boolean => {
      if (!(err instanceof Error)) return false;
      const name = (err as Error & { name?: string }).name ?? '';
      const msg = err.message ?? '';
      return (
        name === 'ObjectNotFoundException' ||
        msg.includes('No scaling policy found') ||
        msg.includes('No scalable target found')
      );
    };
    try {
      // Throttle-only retry, the SYMMETRIC twin of the register branch's. That
      // one retries because a swallowed `ThrottlingException` leaves a target
      // silently UNregistered; a swallowed throttle HERE leaves one silently
      // REGISTERED, which is the PR #403 leak a future table of the same name
      // inherits. The teardown had no retry at all until issue #1955's review
      // found the asymmetry. `maxRetries` is the caller's bound
      // (`autoScalingRetriesWithinDeleteBudget`) rather than the default,
      // because this runs before every budgeted wait on the delete path; an
      // absent budget (every CREATE / UPDATE caller) gets the default schedule.
      // `ObjectNotFoundException` is not a throttle, so the idempotent
      // already-gone arm below still fires on the FIRST attempt.
      markUnsettled(autoScalingKey);
      await withRetry(
        () =>
          asClient.send(
            new DeleteScalingPolicyCommand({
              PolicyName: policyName,
              ServiceNamespace: 'dynamodb',
              ResourceId: resourceId,
              ScalableDimension: dimension,
            })
          ),
        `${resourceId} (${dimension})`,
        {
          isRetryable: (_message, error) => isThrottlingError(error),
          maxRetries: asMaxRetries,
          isInterrupted: watch.isInterrupted,
          onInterrupted: watch.onInterrupted,
          ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
        }
      );
      if (progress) progress.stripped = true;
    } catch (err) {
      // A user abort is not an AWS failure (issue #2053 review). Swallowing it
      // printed up to two "Could not ... Run: aws application-autoscaling ..."
      // lines PER dimension, per GSI and per replica -- blaming AWS for a Ctrl-C
      // -- and then carried straight on to the next teardown WRITE. Re-throwing
      // stops the burst; `delete()`'s catch passes it through unwrapped.
      if (isInterruptedWaitError(err)) throw err;
      // Swallowed: it may still have landed, unless nothing was there or AWS
      // refused it by name.
      if (progress && !isObjectNotFound(err) && !isRefusedByName(err)) progress.stripped = true;
      if (!isObjectNotFound(err)) {
        warn(
          `Could not delete auto-scaling policy on ${tableName} (${dimension}): ` +
            `${describeAwsFailure(err).detail}. ` +
            `Run: ${pasteableAwsCommand(maskSecrets)`aws application-autoscaling delete-scaling-policy --policy-name ${policyName} --service-namespace dynamodb --resource-id ${resourceId} --scalable-dimension ${dimension}`.render()}`
        );
      }
      // Continue to the Deregister attempt regardless — AWS may have
      // already cleaned up the policy, in which case the deregister
      // succeeds (or also returns ObjectNotFoundException, also
      // suppressed below).
    }
    try {
      // Same throttle-only retry and the same bound as the policy delete above.
      markUnsettled(autoScalingKey);
      await withRetry(
        () =>
          asClient.send(
            new DeregisterScalableTargetCommand({
              ServiceNamespace: 'dynamodb',
              ResourceId: resourceId,
              ScalableDimension: dimension,
            })
          ),
        `${resourceId} (${dimension})`,
        {
          isRetryable: (_message, error) => isThrottlingError(error),
          maxRetries: asMaxRetries,
          isInterrupted: watch.isInterrupted,
          onInterrupted: watch.onInterrupted,
          ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
        }
      );
      if (progress) progress.stripped = true;
      this.logger.debug(
        maskSecrets(`Deregistered auto-scaling target ${resourceId} (${dimension})`)
      );
    } catch (err) {
      // A user abort is not an AWS failure (issue #2053 review). Swallowing it
      // printed up to two "Could not ... Run: aws application-autoscaling ..."
      // lines PER dimension, per GSI and per replica -- blaming AWS for a Ctrl-C
      // -- and then carried straight on to the next teardown WRITE. Re-throwing
      // stops the burst; `delete()`'s catch passes it through unwrapped.
      if (isInterruptedWaitError(err)) throw err;
      if (progress && !isObjectNotFound(err) && !isRefusedByName(err)) progress.stripped = true;
      if (!isObjectNotFound(err)) {
        warn(
          `Could not deregister auto-scaling target on ${tableName} (${dimension}): ` +
            `${describeAwsFailure(err).detail}. ` +
            `Run: ${pasteableAwsCommand(maskSecrets)`aws application-autoscaling deregister-scalable-target --service-namespace dynamodb --resource-id ${resourceId} --scalable-dimension ${dimension}`.render()}`
        );
      }
    }
  } finally {
    watch.dispose();
  }
}

/**
 * Probe which of the given targets are ALREADY registered, so the
 * reconcile can skip the ones that are both present and unchanged
 * (Issue #1419).
 *
 * Per region: `DescribeScalableTargets` (batched + paginated) AND
 * `DescribeScalingPolicies`, returning the set of `autoScalingTargetKey`s
 * for which BOTH a target and a target-tracking policy exist.
 *
 * Both halves are required. A target whose `PutScalingPolicy` failed is
 * registered but scales nothing, and `applyAutoScalingDiff` swallows that
 * failure into a WARN — so probing the target alone would mark it present
 * and skip it on every later deploy, which is the same silent never-scales
 * gap this whole change exists to close, one level down.
 *
 * Best-effort: on ANY failure it returns `null`, which the caller reads as
 * "presence unknown" and falls back to upserting everything — an extra
 * idempotent call is always safer than skipping a registration that was
 * never made.
 */
export async function probeRegisteredTargets(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  specs: AutoScalingTargetSpec[],
  localRegion: string,
  // The update caller's masker (issue #2177): the debug line below names the
  // resolved table name and quotes AWS's error text. Defaults to IDENTITY.
  maskSecrets: SecretMasker = (text) => text
): Promise<Set<string> | null> {
  const byRegion = new Map<string, AutoScalingTargetSpec[]>();
  for (const spec of specs) {
    const list = byRegion.get(spec.region);
    if (list) list.push(spec);
    else byRegion.set(spec.region, [spec]);
  }

  // Re-key off the RESOURCE ID so the presence sets and the spec-keyed maps
  // share one identity: strip the `table/<t>/index/` prefix back to the
  // index name (empty at table level).
  const indexPrefix = `${autoScalingResourceId(tableName)}/index/`;
  const keyOf = (resourceId: string, dimension: string, region: string): string => {
    const suffix = resourceId.startsWith(indexPrefix) ? resourceId.slice(indexPrefix.length) : '';
    return `${region}|${dimension}|${suffix}`;
  };

  const present = new Set<string>();
  for (const [region, regionSpecs] of byRegion) {
    const resourceIds = [
      ...new Set(regionSpecs.map((s) => autoScalingResourceId(tableName, s.indexName))),
    ];
    const client = await this.autoScalingClientForRegion(region, localRegion);
    const targets = new Set<string>();
    const policies = new Set<string>();
    for (let i = 0; i < resourceIds.length; i += DESCRIBE_SCALABLE_TARGETS_BATCH) {
      const batch = resourceIds.slice(i, i + DESCRIBE_SCALABLE_TARGETS_BATCH);
      try {
        // Paginate: the API caps a page well below the batch size, so
        // reading page 1 only would report absent for the wide tables the
        // probe exists to speed up (fails safe, but defeats the point).
        let nextToken: string | undefined;
        do {
          const res: DescribeScalableTargetsCommandOutput = await client.send(
            new DescribeScalableTargetsCommand({
              ServiceNamespace: 'dynamodb',
              ResourceIds: batch,
              ...(nextToken ? { NextToken: nextToken } : {}),
            })
          );
          for (const target of res.ScalableTargets ?? []) {
            if (!target.ResourceId || !target.ScalableDimension) continue;
            targets.add(keyOf(target.ResourceId, target.ScalableDimension, region));
          }
          nextToken = res.NextToken;
        } while (nextToken);

        let policyToken: string | undefined;
        do {
          const res: DescribeScalingPoliciesCommandOutput = await client.send(
            new DescribeScalingPoliciesCommand({
              ServiceNamespace: 'dynamodb',
              ...(policyToken ? { NextToken: policyToken } : {}),
            })
          );
          for (const policy of res.ScalingPolicies ?? []) {
            if (!policy.ResourceId || !policy.ScalableDimension) continue;
            if (policy.PolicyType !== 'TargetTrackingScaling') continue;
            policies.add(keyOf(policy.ResourceId, policy.ScalableDimension, region));
          }
          policyToken = res.NextToken;
        } while (policyToken);
      } catch (err) {
        this.logger.debug(
          maskSecrets(
            `Could not probe existing auto-scaling targets on ${tableName} in ${region}: ` +
              `${describeAwsFailure(err).detail} — re-asserting every target instead.`
          )
        );
        return null;
      }
    }
    for (const key of targets) {
      if (policies.has(key)) present.add(key);
    }
  }
  return present;
}

/**
 * Reconcile the application-autoscaling targets a CFn template declares
 * against the ones its previous version declared (Issue #1419).
 *
 * **A desired target is re-asserted even when the template did not
 * change, unless it is known to already exist.** A purely diff-gated
 * register would never backfill the targets that are the entire subject
 * of this issue: on a table deployed before this fix the settings are
 * byte-identical on both sides of every subsequent deploy, so a diff
 * check sees no change and leaves the dimension unregistered forever.
 *
 * The naive form of that — upsert everything, every deploy — costs
 * `2 x (1 + N_gsi x (1 + N_replica))` serial round trips on EVERY deploy
 * of an autoscaled table (a 20-GSI, 3-replica table would spend well over
 * a hundred sequential calls re-asserting a steady state). So presence is
 * probed first with one batched `DescribeScalableTargets` per region, and
 * a target that already exists AND whose settings are unchanged is
 * skipped. When the probe fails, presence is unknown and everything is
 * upserted — the correct direction to fail.
 */
export async function reconcileAutoScalingTargets(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  previousSpecs: AutoScalingTargetSpec[],
  desiredSpecs: AutoScalingTargetSpec[],
  localRegion: string,
  alreadyApplied: ReadonlySet<string> = new Set(),
  // Forwarded to `applyAutoScalingDiff` (issue #1997) and to the presence
  // probe (issue #2177); this method logs no property value of its own.
  // Defaults to IDENTITY.
  maskSecrets: SecretMasker = (text) => text
): Promise<void> {
  // Dimensions an earlier step of this same `update()` already applied are
  // dropped here rather than re-issued. This is a DYNAMIC skip-set, not a
  // static per-dimension filter: a dimension whose diff gate SKIPPED it
  // never enters the set, so it still gets backfilled here — which is the
  // whole point. A static filter (the first cut) got this wrong in the
  // other direction, permanently excluding two dimensions from backfill.
  const previousSpecsToUse = previousSpecs.filter(
    (s) => !alreadyApplied.has(autoScalingTargetKey(s))
  );
  const desiredSpecsToUse = desiredSpecs.filter(
    (s) => !alreadyApplied.has(autoScalingTargetKey(s))
  );

  const previousByKey = new Map<string, AutoScalingTargetSpec>();
  for (const spec of previousSpecsToUse) {
    previousByKey.set(autoScalingTargetKey(spec), spec);
  }

  // The skip below requires a PREVIOUS spec, so with nothing previous
  // (create) the probe could never save a call — don't pay for it.
  const registered =
    desiredSpecsToUse.length > 0 && previousSpecsToUse.length > 0
      ? await this.probeRegisteredTargets(tableName, desiredSpecsToUse, localRegion, maskSecrets)
      : new Set<string>();

  const handled = new Set<string>();
  for (const spec of desiredSpecsToUse) {
    const key = autoScalingTargetKey(spec);
    handled.add(key);
    const previous = previousByKey.get(key);
    // Already registered (target AND policy) AND the template did not touch
    // it: nothing to do. `registered === null` means the probe failed, so
    // presence is unknown and the upsert runs.
    //
    // Note this compares the TEMPLATE's two sides, not the live Min/Max, so
    // an out-of-band console edit is not corrected while the template stays
    // put. That matches the pre-existing diff gates' contract; drift
    // correction is `cdkd drift`'s job, not the deploy path's.
    if (
      registered?.has(key) &&
      previous !== undefined &&
      deepEqual(previous.settings, spec.settings)
    ) {
      continue;
    }
    const client = await this.autoScalingClientForRegion(spec.region, localRegion);
    await this.applyAutoScalingDiff(
      tableName,
      spec.dimension,
      previous?.settings,
      spec.settings,
      client,
      spec.indexName,
      undefined,
      maskSecrets
    );
  }

  // Anything the previous template declared and this one does not: the
  // index was dropped, the replica was removed, or the user deleted the
  // auto-scaling block. Tear the target down so it does not survive in
  // AWS's application-autoscaling control plane and get silently
  // inherited by a future resource of the same name.
  for (const [key, spec] of previousByKey) {
    if (handled.has(key)) continue;
    const client = await this.autoScalingClientForRegion(spec.region, localRegion);
    await this.applyAutoScalingDiff(
      tableName,
      spec.dimension,
      spec.settings,
      undefined,
      client,
      spec.indexName,
      undefined,
      maskSecrets
    );
  }
}

/**
 * go-to-k/cdkd#5581: deregister every application-autoscaling target still
 * registered for a REMOVED replica's table in that replica's own region.
 *
 * Adding a replica to an autoscaled PROVISIONED global table makes DynamoDB
 * itself (`replication.dynamodb.amazonaws.com`, measured in CloudTrail)
 * register targets for the new replica table in its region — the write
 * dimension included, which no cdkd call ever names there. Removing the
 * replica does NOT deregister them, so before this the write target (and any
 * index target) outlived the replica and the table, and a later table of the
 * same name in that region inherited it.
 *
 * Callers run it for EVERY removed non-local replica, not only one whose
 * template declared read auto-scaling: DynamoDB registers these targets on
 * its own, so the template is no evidence either way. Do not gate it on the
 * replica's settings.
 *
 * Runs AFTER `waitForReplicaGone`, and only once the replica's table reads
 * `DELETING` or `ResourceNotFound` in its region: those are the two states a
 * table never comes back from, so no target removed here can belong to a
 * live table. A table reading any other state gets a warning instead of a
 * deregistration.
 *
 * The targets are LISTED, not named: an index target exists for whatever
 * index the replica had, which the template may no longer declare. Matched
 * on the exact resource id `table/<name>` and the prefix
 * `table/<name>/index/`, so a sibling table sharing a name prefix is never
 * touched (`/` is not a legal table-name character). Every such target goes,
 * whoever registered it — one another stack declared in that region too: it
 * names a table that is DELETING or gone, so it scales nothing.
 *
 * Best-effort, like the rest of the auto-scaling teardown: every AWS failure
 * is a masked warning naming the command to finish by hand (AWS's class at
 * warn, its text at debug, go-to-k/cdkd#2319), and nothing but a user
 * interrupt is thrown — so a ResourceNotFound read here can never reach a
 * caller that reads it as the GLOBAL table being gone.
 */
export async function deregisterRemovedReplicaScalableTargets(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  options: {
    readonly budget?: ElapsedBudget | undefined;
    readonly maskSecrets?: SecretMasker | undefined;
    readonly progress?: DeleteProgress | undefined;
  } = {}
): Promise<void> {
  const mask: SecretMasker = options.maskSecrets ?? ((text: string) => text);
  const tableResourceId = autoScalingResourceId(tableName);
  const indexPrefix = `${tableResourceId}/index/`;
  const leaveTargets = (reason: string, awsDetail?: string): void => {
    this.logger.warn(
      mask(
        `The ${region} replica of ${tableName} was removed, but its application-autoscaling ` +
          `targets there were left registered: ${reason}. Once that table is gone, run: ` +
          `${pasteableAwsCommand(mask)`aws application-autoscaling describe-scalable-targets --service-namespace dynamodb --region ${region}`.render()} ` +
          `and deregister each target whose ResourceId is ${tableResourceId} or starts with ` +
          `${indexPrefix}.`
      )
    );
    if (awsDetail !== undefined) {
      this.logger.debug(mask(`${region} replica of ${tableName}: ${awsDetail}`));
    }
  };
  // ONE watch for the read and every listing page: a Ctrl-C aborts a throttle
  // backoff like every other retry on these paths, and is checked between
  // pages too (issue #2053).
  const watch = startInterruptWatch(
    mask(`application-autoscaling target cleanup for ${tableName} in ${region}`)
  );
  const found: Array<{ dimension: DynamoDBScalableDimension; indexName?: string }> = [];
  const asClient = this.getRegionalAutoScalingClient(region);
  try {
    const retired = await this.readReplicaTableRetired(tableName, region, options.budget, watch);
    if (retired !== true) {
      leaveTargets(retired.reason, retired.awsDetail);
      return;
    }

    try {
      let nextToken: string | undefined;
      do {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        const token = nextToken;
        const res: DescribeScalableTargetsCommandOutput | undefined = await withRetry(
          () =>
            asClient.send(
              new DescribeScalableTargetsCommand({
                ServiceNamespace: 'dynamodb',
                ...(token ? { NextToken: token } : {}),
              })
            ),
          `${tableResourceId} targets in ${region}`,
          {
            isRetryable: (_message, error) => isThrottlingError(error),
            maxRetries: autoScalingRetriesWithinDeleteBudget(
              options.budget,
              AUTO_SCALING_TEARDOWN_MAX_RETRIES
            ),
            isInterrupted: watch.isInterrupted,
            onInterrupted: watch.onInterrupted,
            ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
          }
        );
        for (const target of res?.ScalableTargets ?? []) {
          const dimension = target.ScalableDimension;
          const resourceId = target.ResourceId;
          if (!resourceId || !isDynamoDBScalableDimension(dimension)) continue;
          if (resourceId === tableResourceId && dimension.startsWith('dynamodb:table:')) {
            found.push({ dimension });
          } else if (
            resourceId.startsWith(indexPrefix) &&
            resourceId.length > indexPrefix.length &&
            dimension.startsWith('dynamodb:index:')
          ) {
            found.push({ dimension, indexName: resourceId.slice(indexPrefix.length) });
          }
        }
        nextToken = res?.NextToken;
      } while (nextToken);
    } catch (err) {
      if (isInterruptedWaitError(err)) throw err;
      const failure = describeAwsFailure(err);
      leaveTargets(`listing them failed (${failure.summary})`, failure.detail);
      return;
    }
  } finally {
    watch.dispose();
  }

  for (const target of found) {
    // The teardown branch of the shared helper: policy delete, then the
    // deregister, each with its own masked warning and pasteable command,
    // `ObjectNotFoundException` silent.
    await this.applyAutoScalingDiff(
      tableName,
      target.dimension,
      {},
      undefined,
      asClient,
      target.indexName,
      options.budget,
      mask,
      options.progress
    );
  }
  if (found.length > 0) {
    this.logger.debug(
      mask(
        `Deregistered ${found.length} auto-scaling target(s) left by the removed ${region} ` +
          `replica of ${tableName}`
      )
    );
  }
}
