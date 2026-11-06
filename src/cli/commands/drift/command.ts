/**
 * `cdkd drift`: the command driver: target selection, nested-stack expansion and the run loop.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { GetRoleCommand, GetUserCommand } from '@aws-sdk/client-iam';
import { warnIfDeprecatedRegion } from '../../options.js';
import { getLogger, reserveStdoutForPayload } from '../../../utils/logger.js';
import type { Logger } from '../../../types/config.js';
import { PartialFailureError } from '../../../utils/error-handler.js';
import { S3StateBackend, type StackStateRef } from '../../../state/s3-state-backend.js';
import { producerRecordKey } from '../../../state/record-keys.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { AwsClients, setAwsClients, runWithStackAwsClients } from '../../../utils/aws-clients.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { resolveStateBucketWithDefault } from '../../config-loader.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../provisioning/register-providers.js';
import {
  type PrincipalUniqueIdResolver,
  parseIamPrincipalArn,
} from '../../../analyzer/drift-principal-normalize.js';
import { CloudControlProvider } from '../../../provisioning/cloud-control-provider.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  safeMsg,
  STACK_REF_MAX_CODE_POINTS,
  displayIdent,
  ROLE_ARN_MAX_CODE_POINTS,
  displayAwsMessage,
} from '../../../utils/display-safe.js';
import {
  pasteableCommand,
  withheldTargetClause,
  quotedOrDescribed,
  commandHole,
} from '../../../utils/pasteable-command.js';
import {
  foldRegionOption,
  resolveEffectiveRegion,
  exportInferredRegionForSdk,
  legacyStateBucketFallbackRegion,
  regionShown,
} from '../../region-options.js';
import { isThrottlingError } from '../../../deployment/retryable-errors.js';
import {
  type StackDriftReport,
  outcomeExitSignal,
  DriftDetectedError,
  DriftComparisonIncompleteError,
  matchOutcome,
  incompleteRemediationMessage,
} from './outcome.js';
import { runDriftForStack } from './detect.js';
import { runAccept } from './accept.js';
import { runRevert } from './revert.js';
import { writeJsonReport } from './report-json.js';
import {
  stackIdentityLine,
  writeHumanReport,
  reportHeading,
  reportResource,
  reportIdent,
} from './report.js';

/**
 * `cdkd drift [<stack>...]` command implementation.
 *
 * Three operating modes (mutually exclusive):
 *
 *   1. **Detection only** (default) — reads each named stack's state from
 *      S3, asks every resource's provider for its `readCurrentState`
 *      snapshot, and compares against the state-recorded `properties`.
 *      Outputs a per-stack report and exits with `0` when no drift, `1`
 *      when drift is detected (rich human report is the only output).
 *
 *   2. **`--accept`** — state ← AWS. For each drifted property, write
 *      the AWS-current value back into cdkd state. Use this when the
 *      user manually changed something in the AWS console and wants
 *      cdkd state to "catch up" without re-deploying. Requires a stack
 *      lock. Confirms with the user unless `-y/--yes`.
 *
 *   3. **`--revert`** — AWS ← state. For each drifted resource, call
 *      `provider.update` with the cdkd-state values to push them back
 *      into AWS. Use this to undo a manual AWS console change. Requires
 *      a stack lock. Per-resource failures are collected and surface as
 *      `PartialFailureError` (exit 2) at the end of the run; one
 *      resource's failure does not abort the rest.
 *
 * `--accept` and `--revert` are mutually exclusive. Both honor `--dry-run`
 * (print the planned mutations, exit 0 without acquiring a lock).
 */
export async function driftCommand(
  stacks: string[],
  options: {
    all?: boolean;
    json: boolean;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    stackRegion?: string;
    profile?: string;
    verbose: boolean;
    yes?: boolean;
    roleArn?: string;
    accept?: boolean;
    revert?: boolean;
    dryRun?: boolean;
    concurrency?: number;
  }
): Promise<void> {
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope / globals are set (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Issue #2230: claim stdout for the payload BEFORE anything can print on it.
  // Placed ahead of `applyRoleArnIfSet` deliberately — that helper logs
  // `Assumed role ...` at INFO from `src/utils/role-arn.ts`, which is one of
  // the human-facing lines this file cannot route on its own.
  if (options.json) {
    reserveStdoutForPayload();
  }

  warnIfDeprecatedRegion(options);

  if (options.accept && options.revert) {
    throw new Error(
      '--accept and --revert are mutually exclusive. ' +
        'Use --accept to update cdkd state from AWS, or --revert to push cdkd state values back into AWS.'
    );
  }

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // go-to-k/cdkd#2100: the profile's region when none is named, not a
  // `us-east-1` literal (`resolveEffectiveRegion`).
  const effectiveRegion = await resolveEffectiveRegion(options);
  exportInferredRegionForSdk(effectiveRegion);
  // go-to-k/cdkd#2100: the resolved region, explicitly. A region-less bag
  // follows the SDK's chain, which never reads AWS_DEFAULT_REGION, so it would
  // disagree with a region inferred from it.
  const awsClients = new AwsClients({
    region: effectiveRegion.region,
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);
  // Filled by `stackRegionScope` below, destroyed with the command's clients.
  const stackRegionScopes = new Map<
    string,
    { clients: AwsClients; registry: ProviderRegistry; ccApiFallback: CloudControlProvider }
  >();

  try {
    const region = effectiveRegion.region;
    const bucket = await resolveStateBucketWithDefault(
      options.stateBucket,
      region,
      legacyStateBucketFallbackRegion(effectiveRegion)
    );
    const prefix = options.statePrefix;
    const stateConfig = { bucket, prefix };
    // The account flags a malformed-record refusal or warning prints on its
    // `cdkd state show` / `cdkd state list` pointers, so a pasted command reads
    // the bucket this run read (go-to-k/cdkd#4159).
    const refusalRecovery: LockRecoveryContext = {
      profile: options.profile,
      stateBucket: bucket,
      statePrefix: prefix,
    };

    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      region,
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();

    // Per-STACK-region clients, providers and Cloud Control fallback for the
    // detection READS (go-to-k/cdkd#4283). A provider takes its clients at
    // construction (some lazily from the ambient scope), so the registry above
    // asks the COMMAND's region about every stack. That used to read as
    // "drift unknown"; now that a not-found readback is reported as DELETED, a
    // stack in another region (`--stack-region`, `--all`) would report every
    // live resource deleted. Same shape as `cdkd diff`'s `stackRegionScope`.
    // `--revert`'s WRITES take the same per-region scope (see `runRevert`).
    const stackRegionScope = (
      scopeRegion: string
    ): { clients: AwsClients; registry: ProviderRegistry; ccApiFallback: CloudControlProvider } => {
      let scope = stackRegionScopes.get(scopeRegion);
      if (scope === undefined) {
        const clients = new AwsClients({
          region: scopeRegion,
          ...(options.profile && { profile: options.profile }),
        });
        scope = runWithStackAwsClients(clients, () => {
          const registry = new ProviderRegistry();
          registerAllProviders(registry, providerClasses);
          registry.setCustomResourceResponseBucket(bucket);
          // PR J: the CC API fallback for a type whose SDK provider has no
          // `readCurrentState`, once per region rather than per stack.
          return { clients, registry, ccApiFallback: new CloudControlProvider() };
        });
        stackRegionScopes.set(scopeRegion, scope);
      }
      return scope;
    };

    // Issue #1515: one resolver (and one cache) per command, so a stack whose
    // resources reference the same role only pays a single `iam:GetRole`.
    const resolvePrincipalUniqueId = createIamPrincipalUniqueIdResolver(awsClients);

    const stateRefs = await stateBackend.listStacks();
    const targetRefs = resolveTargetRefs(stacks, stateRefs, options);
    // go-to-k/cdkd#4533: what a nested `AWS::CloudFormation::Stack` row's own
    // `<parent>~<child>` record is in THIS run, decided once over the listing.
    const selectedKeys = new Set(targetRefs.map(stackRefKey));
    const stateKeys = new Set(stateRefs.map(stackRefKey));
    const nestedChildRecord = (childStackName: string, region: string): NestedChildRecord => {
      const key = stackRefKey({ stackName: childStackName, region });
      if (selectedKeys.has(key)) return 'selected';
      return stateKeys.has(key) ? 'unselected' : 'missing';
    };

    const reports: StackDriftReport[] = [];
    for (const ref of targetRefs) {
      if (!ref.region) {
        // Legacy `version: 1` records have no region in their key — same
        // gap surfaced by `state show`. Tell the user how to migrate.
        // The command is BUILT by the gate and printed LAST on a labelled line,
        // and the identity rides one of its own — never inside the sentence.
        // Pasting a prose `'...'` span WITH its quotes is what ran an
        // interpolated value (go-to-k/cdkd#3363), and `displayIdent` would
        // have closed only half of it: it collapses a newline, so the FORGING
        // half goes, but a `$(...)` name comes back inside its JSON quotes
        // intact — double quotes do not stop command substitution.
        //
        // Built by the SHARED gate, not by this file's own copy
        // (go-to-k/cdkd#3436's fold-in). `stackCommandFor` was the local one,
        // kept through go-to-k/cdkd#3486 because its `region` and `flags` were
        // the predicted landing place for the other three sites; those landed
        // on `pasteableCommand` instead, so the copy had one caller and two
        // parameters nothing reached. It is gone.
        //
        // The visible gain is the SENTENCE. The local helper returned
        // `undefined` with no reason, so the message had to name every reason
        // the gate has as a disjunction — and three of its four disjuncts were
        // visibly false of a name printed on the `Stack:` line right above it
        // (m19 of the go-to-k/cdkd#3486 review, which could only restate the
        // rule). `withheld` carries the REASON, so the clause says the true
        // one and cannot be keyed on a different predicate than the hole.
        // `plainIdent` as well as `patternMatched` (M17 of the go-to-k/cdkd#3613
        // review): this command sits beside a labelled line, so its value is
        // held to `isPasteableIdent` -- the same predicate `stackIdentityLine`
        // takes -- and not to the command gate alone. The command gate NAMES
        // any exactly-rendering, non-option, non-pattern value, which admits
        // `Prod<60 spaces>Migrate with: cdkd destroy --all --force #`; wrapped
        // by the terminal, the shell-quoted argument yields a screen row that
        // reads as a `Migrate with:` line whose `#` comments out the stray
        // closing quote (measured by the maintainer, rc=0). One predicate at
        // both lines means one verdict: a name is printed on BOTH or on
        // NEITHER.
        const migrate = pasteableCommand('cdkd deploy', [
          {
            value: ref.stackName,
            hole: 'stack',
            opts: { patternMatched: true, plainIdent: true },
          },
        ]);
        const identity = stackIdentityLine(ref.stackName);
        const clause = withheldTargetClause(migrate, 'stack', 'cdkd deploy');
        throw new Error(
          `A state record for this stack is a legacy one with no region, which drift cannot ` +
            `read. A cdkd write migrates it to the region-scoped layout; re-run drift ` +
            `detection after it.` +
            // Exactly ONE of the two prints. `identity` is defined iff
            // `isPasteableIdent` admits the name; `clause` is non-empty iff
            // the gate refused it, and with `plainIdent` set the gate refuses
            // exactly what `isPasteableIdent` refuses (every other arm is
            // subsumed by it). So the catch-all sentence an earlier revision
            // printed for a name the command named but the identity withheld
            // has no input left, and is gone. The clause opens with a space
            // for `state.ts`'s site, where it continues a sentence; here it
            // is a line of its own between the explanation and the command
            // (M19: an earlier comment justified the newline by a `Stack:`
            // line it followed, which since M16 cannot print beside it).
            `\n${identity ?? clause.trimStart()}` +
            `\nMigrate with: ${migrate.command}`
        );
      }
      const stackRegion = ref.region;
      const scope = stackRegionScope(stackRegion);
      const report = await runWithStackAwsClients(scope.clients, () =>
        runDriftForStack(
          ref.stackName,
          stackRegion,
          stateBackend,
          scope.registry,
          scope.ccApiFallback,
          resolvePrincipalUniqueId,
          // go-to-k/cdkd#3018: decided HERE, beside the flags, because it is the
          // only place that knows whether this run can reach a `saveState`. The
          // two flags are mutually exclusive (checked above), so either one alone
          // makes the run write-capable.
          options.accept || options.revert ? 'refuse' : 'repair',
          nestedChildRecord,
          refusalRecovery
        )
      );
      reports.push(report);
    }

    if (options.json) {
      writeJsonReport(reports);
    } else {
      writeHumanReport(reports);
    }

    // Detection-only path: exit 0 / 1 / 2 on what the run actually found,
    // regardless of subsequent flags. `--accept` / `--revert` take over
    // below if requested.
    //
    // Issue #2135: read through `outcomeExitSignal` rather than off a `kind`
    // comparison, so a new outcome variant cannot quietly join the "nothing to
    // report" side. The REFUSED subset is deliberately narrower than the
    // not-compared roll-up both renderings use; see that function.
    const signals = reports.flatMap((r) => r.outcomes.map(outcomeExitSignal));
    const drifted = signals.includes('drifted');
    const anyIncomplete = signals.includes('incomplete');

    if (!options.accept && !options.revert) {
      if (drifted) {
        throw new DriftDetectedError();
      }
      // Issue #2108. Ordered AFTER the drift check on purpose: a drifted
      // resource is the stronger signal and keeps exiting 1 even when the same
      // run also refused a comparison, so no consumer that gates on `1` loses a
      // detection it gets today. See the class note for why this is a
      // preservation of the pre-#2108 exit code rather than a new one.
      if (anyIncomplete) {
        throw new DriftComparisonIncompleteError();
      }
      return;
    }

    // Resolution path. Both flags share the prompt + lock + state-loaded
    // reports; the per-resource action differs.
    const mode = options.accept ? 'accept' : 'revert';
    // go-to-k/cdkd#4283: a resource deleted outside cdkd exits detection 1, but
    // neither flag can act on it. Refused by name FIRST, and the rest of the
    // run proceeds on the resources it can act on.
    const refusedDeleted = refuseDeletedForRemediation(reports, mode, logger);
    const anyRefusedDeleted = refusedDeleted.deleted + refusedDeleted.recordMissing > 0;
    const actionable = reports.some((r) =>
      r.outcomes.some((o) =>
        matchOutcome<boolean>(o, {
          drifted: () => true,
          clean: () => false,
          notCompared: () => false,
          unsupported: () => false,
          skipped: () => false,
          deleted: () => false,
        })
      )
    );
    if (!actionable) {
      if (anyRefusedDeleted) {
        if (anyIncomplete) {
          // Its last line says a detection-only run exits 2; with a deleted
          // resource in the stack it exits 1, so that line is replaced.
          for (const line of incompleteRemediationMessage(reports, mode).slice(0, -1)) {
            logger.info(line);
          }
          logger.info(
            safeMsg`Re-run 'cdkd drift' without --${mode} to see which resources and why — ` +
              `with a deleted resource in the stack, that run exits 1.`
          );
        }
        if (!options.dryRun) throw deletedRefusalError(refusedDeleted, mode);
        return;
      }
      // Issue #2208: `No drift detected` is FALSE for a run that did not manage
      // to compare everything -- nothing drifted only because nothing was read.
      // The exit code stays `0` on this path by design; see
      // {@link incompleteRemediationMessage} for why the fix is the message and
      // not the code.
      if (anyIncomplete) {
        for (const line of incompleteRemediationMessage(reports, mode)) {
          logger.info(line);
        }
        return;
      }
      logger.info(
        options.accept
          ? 'No drift detected — nothing to accept.'
          : 'No drift detected — nothing to revert.'
      );
      return;
    }

    // `false` is a declined prompt: nothing was attempted, so a deleted
    // resource's refusal is not reported as a partial failure on top of it.
    let outcome: false | void;
    if (options.accept) {
      outcome = await runAccept(
        reports,
        stackRegionScope,
        stateBackend,
        stateConfig,
        awsClients,
        options
      );
    } else {
      try {
        outcome = await runRevert(
          reports,
          stackRegionScope,
          stateBackend,
          stateConfig,
          awsClients,
          options
        );
      } catch (err) {
        // `--revert`'s own partial failure ends the run before the deleted
        // refusal below can; carry the deleted count into its message.
        if (anyRefusedDeleted && err instanceof PartialFailureError) {
          throw new PartialFailureError(
            `${err.message} ${deletedRefusalError(refusedDeleted, mode).message}`,
            err
          );
        }
        throw err;
      }
    }
    if (anyRefusedDeleted && !options.dryRun && outcome !== false) {
      throw deletedRefusalError(refusedDeleted, mode);
    }
  } finally {
    for (const { clients } of stackRegionScopes.values()) clients.destroy();
    awsClients.destroy();
  }
}

/**
 * Warn, per resource, that `--accept` / `--revert` will not act on a resource
 * AWS reports DELETED (go-to-k/cdkd#4283), and return how many were refused.
 *
 * Neither flag can do anything correct with one. `--revert` updates a resource
 * in place, and there is no resource to update. `--accept` writes AWS-current
 * values into state, and there are none; the only "acceptance" left would be
 * dropping the record, which silently ERASES state on a command whose contract
 * is to copy values into it (a later deploy would then recreate the resource
 * as a CREATE). The message names the explicit route instead
 * (`DELETED_RESOURCE_REMEDY`), and nothing is mutated for the resource.
 */
function refuseDeletedForRemediation(
  reports: StackDriftReport[],
  mode: 'accept' | 'revert',
  logger: Logger
): RefusedDeletedCounts {
  const refused = { deleted: 0, recordMissing: 0 };
  for (const report of reports) {
    for (const outcome of report.outcomes) {
      if (outcome.kind !== 'deleted') continue;
      if (outcome.nestedStackRecordMissing === true) {
        refused.recordMissing += 1;
        // go-to-k/cdkd#4533: no AWS read stands behind this one, so it does
        // not say AWS answered, and the remedy is the nested stack's own.
        logger.warn(
          safeMsg`  ! ${reportHeading(report)} ${reportResource(outcome)}: NOT ` +
            (mode === 'revert' ? 'reverted' : 'accepted') +
            safeMsg` — ${nestedRecordMissingClause(report, outcome)} ${NESTED_RECORD_MISSING_REMEDY}`
        );
        continue;
      }
      logger.warn(
        safeMsg`  ! ${reportHeading(report)} ${reportResource(outcome)}: NOT ` +
          (mode === 'revert'
            ? `reverted — AWS reports this resource no longer exists (deleted outside cdkd), ` +
              `and --revert updates a resource in place: it cannot recreate one.`
            : `accepted — AWS reports this resource no longer exists (deleted outside cdkd), ` +
              `so there is no AWS-current value to write to state.`) +
          safeMsg` ${DELETED_RESOURCE_REMEDY}`
      );
      refused.deleted += 1;
    }
  }
  return refused;
}

/**
 * What {@link refuseDeletedForRemediation} refused, by kind: a nested row
 * whose record is gone is counted apart (go-to-k/cdkd#4533), since
 * `cdkd state orphan` is one way it goes and it is not "outside cdkd".
 */
interface RefusedDeletedCounts {
  deleted: number;
  recordMissing: number;
}

/**
 * The exit-`2` end of a remediation run that refused a deleted resource
 * (go-to-k/cdkd#4283): the run did what it could, and at least one resource
 * still differs from state — the same "finished, something not done" meaning
 * `--revert`'s per-resource failures already carry.
 */
function deletedRefusalError(
  { deleted, recordMissing }: RefusedDeletedCounts,
  mode: 'accept' | 'revert'
): PartialFailureError {
  const verb = mode === 'accept' ? 'accepted' : 'reverted';
  const parts = [
    ...(deleted > 0 ? [`${deleted} resource(s) deleted outside cdkd`] : []),
    ...(recordMissing > 0 ? [`${recordMissing} nested stack(s) whose state record is gone`] : []),
  ];
  return new PartialFailureError(`${parts.join(' and ')} were not ${verb}; each is named above.`);
}

/**
 * What to do about a resource deleted outside cdkd. NOT "run cdkd deploy": a
 * deploy diffs the template against STATE, never AWS, so an unchanged
 * template leaves the record as it is and recreates nothing.
 */
const DELETED_RESOURCE_REMEDY =
  `First confirm it is really gone (in the AWS console or with the AWS CLI). A deploy that ` +
  `does not change it will not recreate it: to recreate it, remove it from the CDK app and ` +
  `deploy, then restore it and deploy again; if it is meant to be gone, the first of those ` +
  `deploys is enough. Anything in the app that references it has to come out with it, and ` +
  `that deploy DELETES those resources too.`;

/**
 * What to do about a nested stack whose own `<parent>~<child>` record is gone
 * (go-to-k/cdkd#4533). Two ways it happens, and their remedies are opposite:
 * `cdkd import --migrate-from-cloudformation` saves the PARENT record first and
 * the children after it, keeping the parent when that walk stops part-way --
 * there the resources are live in the source CloudFormation stack and the fix
 * is re-running the import, so the text must NOT lead with deleting them.
 * Otherwise (a hand edit, `cdkd state orphan`) cdkd no longer tracks them.
 */
const NESTED_RECORD_MISSING_REMEDY =
  `If the parent was imported with 'cdkd import --migrate-from-cloudformation' and that ` +
  `import stopped part-way, its nested stacks were not recorded yet: re-run that import ` +
  `with --force, which rebuilds the parent record from the stack and then records them. ` +
  `Otherwise the resources the nested stack held are no longer tracked by cdkd and may ` +
  `still exist in AWS, and recreating it can collide with them. A deploy that does not ` +
  `change the nested stack will not recreate it: to recreate it, remove it from the CDK ` +
  `app and deploy, then restore it and deploy again; if it is meant to be gone, the ` +
  `first of those deploys is enough.`;

/** The sentence a nested row with no record of its own reports (go-to-k/cdkd#4533). */
export function nestedRecordMissingClause(
  report: StackDriftReport,
  outcome: { logicalId: string }
): string {
  return safeMsg`its nested stack's own state record ${reportIdent(
    nestedChildStackName(report.stackName, outcome.logicalId),
    STACK_REF_MAX_CODE_POINTS
  )} is not in state.`;
}

/**
 * The state record a nested `AWS::CloudFormation::Stack` row deploys into:
 * `NestedStackProvider`'s `<parent>~<logicalId>` key, in the parent's region.
 */
export function nestedChildStackName(parentStackName: string, logicalId: string): string {
  return `${parentStackName}~${logicalId}`;
}

/** What a nested row's own record is in this run (go-to-k/cdkd#4533). */
export type NestedChildRecord = 'selected' | 'unselected' | 'missing';

/**
 * One state record's identity, for the selection sets. A legacy record's
 * missing region reads as `''`, which no region-scoped key carries.
 */
function stackRefKey(ref: StackStateRef): string {
  return producerRecordKey(ref.stackName, ref.region ?? '');
}

/**
 * Whether `ref` is a nested stack under `ancestor`, at any depth
 * (go-to-k/cdkd#4533). By KEY, as `cdkd scrub` matches them: a child is
 * recorded as `<parent>~<logicalId>` in its parent's region, and CDK's
 * stack-name rule bars `~`, so no top-level stack can carry that prefix. A
 * legacy region-less record has no nested stacks (they arrived with schema v6).
 */
function isNestedDescendantOf(ref: StackStateRef, ancestor: StackStateRef): boolean {
  return (
    ancestor.region !== undefined &&
    ref.region === ancestor.region &&
    ref.stackName.startsWith(`${ancestor.stackName}~`)
  );
}

/** Parent before child, siblings by name: a segment-wise order of `~` keys. */
function compareNestedStackNames(a: string, b: string): number {
  const as = a.split('~');
  const bs = b.split('~');
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    // Code-unit order, not `localeCompare`: the block order must not depend
    // on the host's locale.
    if (as[i]! !== bs[i]!) return as[i]! < bs[i]! ? -1 : 1;
  }
  return as.length - bs.length;
}

/**
 * Each selected record followed by every nested stack under it, each record
 * once (go-to-k/cdkd#4533). `cdkd diff` and `cdkd destroy` both act on a
 * parent's nested stacks with it, so `cdkd drift <Parent>` compares them too:
 * a resource deleted inside one is drift of the stack the user named.
 */
function withNestedDescendants(
  selected: StackStateRef[],
  stateRefs: StackStateRef[]
): StackStateRef[] {
  const out: StackStateRef[] = [];
  const seen = new Set<string>();
  const add = (ref: StackStateRef): void => {
    const key = stackRefKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  for (const ref of selected) {
    add(ref);
    stateRefs
      .filter((r) => isNestedDescendantOf(r, ref))
      .sort((a, b) => compareNestedStackNames(a.stackName, b.stackName))
      .forEach(add);
  }
  return out;
}

/**
 * Resolve the set of `(stackName, region)` pairs the command should
 * inspect. With `--all`, every state record qualifies; without `--all`,
 * each positional pattern is matched against the state index using the
 * same exact-name + region disambiguation rules as `state destroy`, and
 * each named stack brings its nested stacks with it (go-to-k/cdkd#4533).
 */
function resolveTargetRefs(
  stacks: string[],
  stateRefs: StackStateRef[],
  options: { all?: boolean; stackRegion?: string }
): StackStateRef[] {
  if (options.all) {
    if (stateRefs.length === 0) {
      throw new Error('No stacks found in state bucket.');
    }
    if (options.stackRegion) {
      return stateRefs.filter((r) => r.region === options.stackRegion);
    }
    return stateRefs;
  }

  // No positional args and no --all: mirror `cdkd deploy` / `cdkd destroy`'s
  // single-stack auto-detect. Use state as the source of truth (drift is
  // state-driven, no synth involved).
  if (stacks.length === 0) {
    const candidates = options.stackRegion
      ? stateRefs.filter((r) => r.region === options.stackRegion)
      : stateRefs;
    if (candidates.length === 0) {
      throw new Error(
        'No stacks found in state bucket. Run `cdkd deploy` first, or pass --all explicitly.'
      );
    }
    // go-to-k/cdkd#4533: a nested stack's record is part of its parent's, so
    // one parent with nested stacks is still "the single stack in state". A
    // record whose parent's record is gone counts as a stack of its own.
    const roots = candidates.filter(
      (r) => !candidates.some((a) => a !== r && isNestedDescendantOf(r, a))
    );
    if (roots.length === 1) {
      return withNestedDescendants([roots[0]!], candidates);
    }
    const listing = roots
      .map((r) => `${r.stackName}${r.region ? ` (${r.region})` : ''}`)
      .join(', ');
    throw new Error(
      `Multiple stacks found in state: ${listing}. Specify stack name(s) or use --all.`
    );
  }

  const out: StackStateRef[] = [];
  for (const stackName of stacks) {
    const matches = stateRefs.filter((r) => r.stackName === stackName);
    if (matches.length === 0) {
      throw new Error(
        `No state found for stack '${stackName}'. Run 'cdkd state list' to see available stacks.`
      );
    }
    if (options.stackRegion) {
      const ref = matches.find((r) => r.region === options.stackRegion);
      if (!ref) {
        const seen = matches.map((r) => r.region ?? '(legacy)').join(', ');
        throw new Error(
          `No state found for stack '${stackName}' in region '${options.stackRegion}'. ` +
            `Available regions: ${seen}.`
        );
      }
      out.push(ref);
      continue;
    }
    if (matches.length === 1) {
      out.push(matches[0]!);
      continue;
    }
    // Names `--stack-region`, so the stack name and every region are shown
    // only when plain and the hole is quoted (go-to-k/cdkd#4295).
    const regions = matches
      .map((r) => (r.region === undefined ? '(legacy)' : regionShown(r.region)))
      .join(', ');
    throw new Error(
      `Stack ${quotedOrDescribed(stackName, 'stack name')} has state in multiple regions: ${regions}. ` +
        `Re-run with --stack-region ${commandHole('region')} to disambiguate.`
    );
  }
  return withNestedDescendants(out, stateRefs);
}

/**
 * The live half of the #1515 principal canonicalization: resolve an IAM role /
 * user ARN to that principal's unique id (`AROA…` / `AIDA…`).
 *
 * Results are cached per ARN for the whole command — INCLUDING the failures, so
 * a deleted role (the case where AWS keeps the unique id forever, and therefore
 * the likeliest one to appear here) costs exactly one API call rather than one
 * per resource that references it.
 *
 * Every failure resolves to `undefined` rather than throwing: a missing
 * `iam:GetRole` permission, a cross-account principal, or a deleted role must
 * leave the comparison exactly as it was — the drift is then reported, which is
 * the safe direction. Drift detection must never fail because a cosmetic
 * normalization could not run.
 *
 * **The response ARN is compared back to the requested one, and that check is
 * what makes the "never hides a real change" claim true rather than aspirational.**
 * `GetRole` / `GetUser` are account-local and take a NAME, not an ARN, so the
 * lookup silently answers about the CALLER's account and about the wrong IAM
 * path: `arn:aws:iam::<other-acct>:role/Foo` and
 * `arn:aws:iam::<self>:role/prod/Foo` would both come back as this account's
 * root-path `Foo`, and the pass would then "prove" two DIFFERENT principals
 * equal and collapse a genuine drift. Round-tripping the ARN costs nothing and
 * turns both cases into an unresolved lookup, i.e. drift reported.
 */
function createIamPrincipalUniqueIdResolver(awsClients: AwsClients): PrincipalUniqueIdResolver {
  const cache = new Map<string, string | undefined>();
  let warnedOnDenied = false;
  return async (arn: string): Promise<string | undefined> => {
    if (cache.has(arn)) return cache.get(arn);
    let uniqueId: string | undefined;
    const principal = parseIamPrincipalArn(arn);
    if (principal) {
      try {
        let entityArn: string | undefined;
        let entityId: string | undefined;
        if (principal.kind === 'role') {
          const role = (await awsClients.iam.send(new GetRoleCommand({ RoleName: principal.name })))
            .Role;
          entityArn = role?.Arn;
          entityId = role?.RoleId;
        } else {
          const user = (await awsClients.iam.send(new GetUserCommand({ UserName: principal.name })))
            .User;
          entityArn = user?.Arn;
          entityId = user?.UserId;
        }
        // Same principal, not merely the same NAME — see the note above.
        // Compared case-INSENSITIVELY on the name-bearing tail: `GetRole` is
        // case-insensitive on the name, so `…:role/MyRole` legitimately comes
        // back as the ARN AWS stored, and treating that as "a different
        // entity" would refuse a principal that is provably the same one.
        if (entityArn !== undefined && entityArn.toLowerCase() === arn.toLowerCase()) {
          uniqueId = entityId;
        } else {
          // `arn` is a principal ARN lifted out of a RESOURCE POLICY — the
          // user's template, or AWS's readback of one — so it is untrusted text
          // on its way to a terminal (issue go-to-k/cdkd#3397). `entityArn` is
          // sanitized beside it rather than trusted for being AWS's answer:
          // `GetRole` echoes back a name AWS stored, and a guard on one operand
          // is no evidence about the one next to it.
          getLogger().debug(
            `Principal ${displayIdent(arn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })} resolved to ${
              entityArn === undefined
                ? 'no entity'
                : displayIdent(entityArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })
            } — ` +
              `same name in this account or under another IAM path; ` +
              `leaving the policy principal comparison untouched.`
          );
        }
      } catch (error) {
        // `.detail`, not the bare ternary: a rejection `String()` cannot
        // convert threw from here, so the resolver rejected instead of leaving
        // the principal comparison untouched (#3361).
        const message = describeAwsFailure(error).detail;
        // Classified on the ERROR NAME, never on the message: IAM's
        // `NoSuchEntity` text embeds the ROLE NAME ("The role with name
        // AccessDeniedHandlerRole cannot be found"), so a message match turns
        // an ordinary deleted role into the scary permission warning — the
        // exact swallow this classification exists to avoid.
        const name = error instanceof Error ? error.name : '';
        const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
          ?.httpStatusCode;
        const denied = /^AccessDenied|^NotAuthorized/i.test(name) || status === 403;
        if (!warnedOnDenied && denied) {
          warnedOnDenied = true;
          // The AWS message names the CALLER's principal ARN + account id, so
          // it stays at debug (below) rather than riding a warn line into a
          // screenshot or a public CI log — same reason the state-bucket
          // banner was demoted.
          getLogger().warn(
            `Cannot read IAM principals (${name || 'access denied'}). A resource policy whose ` +
              `principal AWS rendered as a unique id (AROA…/AIDA…) may therefore report drift ` +
              `that is only a spelling difference; grant iam:GetRole / iam:GetUser to resolve ` +
              `it, or re-run with --verbose for the full error.`
          );
        }
        // BOTH operands, and `message` is the load-bearing half here: the
        // comment fourteen lines up records that IAM's `NoSuchEntity` text
        // EMBEDS THE ROLE NAME verbatim, so sanitizing `arn` alone would let
        // the same bytes arrive through the error string — the "guard defeated
        // by its own neighbour" shape (issue go-to-k/cdkd#3397). `displaySafe`
        // for the message because AWS's wording legitimately carries non-ASCII.
        getLogger().debug(
          `Could not resolve the unique id of principal ${displayIdent(arn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })} (${displayAwsMessage(message)}); ` +
            `leaving the policy principal comparison untouched.`
        );
        // A THROTTLE is transient, and caching it would poison the rest of the
        // run: every later resource sharing this principal would inherit the
        // phantom drift, and `--revert` would then push the `AROA…` form at
        // S3, which rejects it outright. Mirrors `write-only-properties.ts`,
        // which likewise caches only conclusive answers.
        if (isThrottlingError(error)) return undefined;
      }
    }
    cache.set(arn, uniqueId);
    return uniqueId;
  };
}
