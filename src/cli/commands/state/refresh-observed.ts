import {
  cdkdRemedy,
  pasteableCommand,
  withheldTargetClause,
  proseQuoted,
} from '../../../utils/pasteable-command.js';
import { Command } from 'commander';
import { commonOptions, deprecatedRegionOption, stateOptions } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { confirmOrRefuse } from '../confirm-prompt.js';
import { PartialFailureError, withErrorHandling } from '../../../utils/error-handler.js';
import { type StackStateRef } from '../../../state/s3-state-backend.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { type LockRecoveryContext } from '../../../state/lock-contention-message.js';
import {
  refuseMalformedResourceEntries,
  refuseMalformedState,
} from '../../../state/malformed-resources-bag.js';
import { AwsClients, runWithStackAwsClients } from '../../../utils/aws-clients.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../provisioning/register-providers.js';
import { collectAcceptRefused, readAcceptRefusedTemplate } from '../state-refresh-observed.js';
import {
  describedStackRef,
  legacyRecordSubject,
  stateListPointer,
  refIsDescribed,
  resolveSingleRegion,
} from './refs.js';
import { setupStateBackend, stackRegionOption } from './setup.js';
import { type AcceptRefusedRequest, refreshObservedForStack } from './refresh-observed-stack.js';

/**
 * The hole the legacy refusal's `cdkd deploy` prints for a name it cannot
 * name, and the key {@link withheldTargetClause} reads the reason back by. ONE
 * spelling so the two cannot drift apart (m22 of the go-to-k/cdkd#3499 review).
 */
const STACK_HOLE = 'stack';

/**
 * `cdkd state refresh-observed <stack>` command implementation.
 *
 * Walks every resource in the given stack(s) and refreshes its
 * `observedProperties` field by calling the matching provider's
 * `readCurrentState`. The result is the same baseline that a fresh
 * `cdkd deploy` would produce — but without re-deploying anything.
 *
 * Why this exists: state schema `version: 3` (`observedProperties`)
 * shipped after many users had already deployed stacks under v2.
 * `cdkd deploy` only populates `observedProperties` on resources that
 * actually go through CREATE / UPDATE — `NO_CHANGE`-skipped resources
 * stay with `observedProperties: undefined` indefinitely after the
 * upgrade, and `cdkd drift` falls back to `properties` baseline for
 * those (= the pre-v3 behavior, missing console-side changes to keys
 * the user did not template). This command lets users opt into the
 * richer drift baseline for the whole stack in one shot.
 *
 * Behavior:
 *  - Acquires a per-stack lock (scope: `state-refresh-observed`).
 *  - Calls `provider.readCurrentState` in parallel (Promise.all) for the
 *    resources that REACH it. FOUR paths do not, and review had to correct
 *    this sentence twice — first from "every resource", then from three arms
 *    to four. A resource whose record carries `observedBaselineRefused` (v10)
 *    is SKIPPED before the provider is consulted and warned about separately,
 *    since refreshing it could persist a resolved secret in plaintext. The
 *    other three all count as `unsupported`: a type
 *    `ProviderRegistry.shouldSkipResource` declines (returning before the
 *    lookup), a type with no registered provider, and a provider that does not
 *    implement `readCurrentState`. A per-resource failure is
 *    COUNTED and logged at
 *    `warn` naming the resource and the error, the rest of the stack is
 *    still refreshed and saved, and the affected resource keeps whatever
 *    `observedProperties` it already had (or none). So drift keeps
 *    comparing against that RETAINED baseline where one exists, and falls
 *    back to `properties` only where there is none — review caught the
 *    unqualified claim, which said it always falls back. The run
 *    then ends in `PartialFailureError` (exit 2) naming the count, which
 *    is what distinguishes it from a crash. (This block travelled here
 *    from `src/utils/pasteable-command.ts`, where it documented nothing;
 *    review measured that it also described the old, swallow-and-debug
 *    behaviour rather than the current one.)
 *  - Writes state with optimistic locking (`expectedEtag`).
 *  - Prints a per-stack summary: `N refreshed, M unsupported, K failed`.
 *
 * Flag set mirrors `state destroy`:
 *  - `--all` — refresh every stack in the state bucket.
 *  - `--stack-region <region>` — disambiguate when the same stackName
 *    has state in multiple regions.
 *  - `--dry-run` — print the planned refresh count per stack and exit
 *    without acquiring a lock or writing state.
 *  - `-y` / `--yes` — skip the confirmation prompt.
 *  - Standard state options + `--profile` / `--role-arn` / `--verbose`.
 */
async function stateRefreshObservedCommand(
  stackArgs: string[],
  options: {
    all?: boolean;
    yes?: boolean;
    dryRun?: boolean;
    acceptRefused?: string[];
    template?: string;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    stackRegion?: string;
    profile?: string;
    roleArn?: string;
    verbose: boolean;
  }
): Promise<void> {
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope / globals are set (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  // Issue #3466: the override is per RESOURCE of one stack, so every breadth
  // is refused before anything is read, and the template it is judged against
  // is parsed here so an unreadable file fails first.
  let accept: AcceptRefusedRequest | undefined;
  if (options.acceptRefused !== undefined) {
    if (options.acceptRefused.length !== 1) {
      throw new Error('--accept-refused takes exactly one logical id per run.');
    }
    if (options.all || stackArgs.length !== 1) {
      throw new Error(
        '--accept-refused applies to one resource of ONE stack: pass a single stack name, not --all.'
      );
    }
    if (options.template === undefined) {
      throw new Error(
        '--accept-refused requires --template <file>: the synthesized template this stack was last deployed from.'
      );
    }
    accept = {
      logicalId: options.acceptRefused[0]!,
      template: readAcceptRefusedTemplate(options.template),
      yes: options.yes ?? false,
    };
  } else if (options.template !== undefined) {
    throw new Error('--template is used only with --accept-refused.');
  }

  if (!options.all && stackArgs.length === 0) {
    throw new Error(
      `Stack name is required. Usage: ${pasteableCommand('cdkd state refresh-observed', [{ hole: 'stacks...' }]).command} | --all`
    );
  }

  const setup = await setupStateBackend(options);
  // Per-STACK-region clients and providers for the readback
  // (go-to-k/cdkd#4283): a provider takes its clients at construction, so one
  // registry built from the command's region would ask it about every stack,
  // and a not-found answer now reads as "deleted outside cdkd". Same shape as
  // `cdkd drift`'s and `cdkd diff`'s `stackRegionScope`.
  const stackRegionScopes = new Map<string, { clients: AwsClients; registry: ProviderRegistry }>();
  const stackRegionScope = (
    scopeRegion: string
  ): { clients: AwsClients; registry: ProviderRegistry } => {
    let scope = stackRegionScopes.get(scopeRegion);
    if (scope === undefined) {
      const clients = new AwsClients({
        region: scopeRegion,
        ...(options.profile && { profile: options.profile }),
      });
      const registry = runWithStackAwsClients(clients, () => {
        const scoped = new ProviderRegistry();
        registerAllProviders(scoped, providerClasses);
        scoped.setCustomResourceResponseBucket(setup.bucket);
        return scoped;
      });
      scope = { clients, registry };
      stackRegionScopes.set(scopeRegion, scope);
    }
    return scope;
  };

  try {
    const stateRefs = await setup.stateBackend.listStacks();
    let targets: StackStateRef[];

    if (options.all) {
      targets = options.stackRegion
        ? stateRefs.filter((r) => r.region === options.stackRegion)
        : stateRefs;
      if (targets.length === 0) {
        logger.info('No stacks found in state');
        return;
      }
    } else {
      // `resolveSingleRegion` rather than the open-coded copy of it this loop
      // used to carry, whose refusals interpolated the `listStacks()` regions
      // raw and hand-quoted the name (go-to-k/cdkd#3027).
      targets = stackArgs.map((stackName) =>
        resolveSingleRegion(stackName, stateRefs, options.stackRegion)
      );
    }

    const regionScoped = targets.flatMap((target) =>
      target.region ? [{ stackName: target.stackName, region: target.region }] : []
    );

    // go-to-k/cdkd#3018. A malformed record is refused per stack inside
    // `refreshObservedForStack`, but the loop below saves each stack before it
    // loads the next — so over several targets that refusal landed AFTER the
    // healthy stacks ahead of it were written, aborted the ones behind it, and
    // never reached the summary that says what was written. Checking every
    // target's SHAPE first makes the refusal a property of the run: nothing is
    // prompted for, locked or saved when a record already malformed at this
    // read would refuse.
    //
    // One extra read per stack, and only for more than one target — a single
    // target's own refusal already fires before anything is written, and a
    // prompt ahead of it writes nothing. The per-stack refusal stays, because a
    // record can change between this read and that one; this check narrows the
    // window, it does not close it. A target with no record is left to the
    // loop, whose "No state found" names it, and a legacy region-less one to the
    // refusal just before that loop.
    // ONE context for the pre-flight and the per-stack call, so a refusal of
    // the same record reads the same account whichever of the two raises it
    // (go-to-k/cdkd#3909).
    const lockRecovery: LockRecoveryContext = {
      profile: options.profile,
      stateBucket: setup.bucket,
      statePrefix: options.statePrefix,
    };
    if (regionScoped.length > 1) {
      for (const target of regionScoped) {
        const loaded = await setup.stateBackend.getState(target.stackName, target.region);
        if (!loaded) continue;
        refuseMalformedState(loaded.state, target.stackName, target.region, lockRecovery);
        refuseMalformedResourceEntries(loaded.state, target.stackName, target.region, lockRecovery);
      }
    }

    // `--accept-refused` asks its own question, naming the assertion, once the
    // record has passed the gate (in `refreshObservedForStack`).
    if (!options.yes && !options.dryRun && accept === undefined) {
      // The same rendering as the `state orphan` prompt above, for the same
      // reason: this file's OTHER confirmation prompt, built from the same S3
      // key segments (every name, under `--all`) and printed ahead of the
      // legacy refusal's labelled `Migrate with:` line, where a padded
      // regional sibling wrapped into a counterfeit one (go-to-k/cdkd#3760).
      // A described half also cannot close the sentence's own `(...)` early.
      const targetList = targets.map(describedStackRef).join(', ');
      // A described half is not an identity, so name where the records can be
      // seen as stored before the `y` is asked for.
      if (targets.some(refIsDescribed)) logger.info(stateListPointer());
      const ok = await confirmRefresh(
        `Refresh observedProperties for ${targets.length} stack(s) (${targetList})?`
      );
      if (!ok) {
        logger.info('Aborted.');
        return;
      }
    }

    // A legacy v1 record carries no region in its key; the next write would
    // migrate it, but state-driven refresh should not push a rewrite without the
    // user confirming it. Refused for EVERY target before the first stack is
    // refreshed, because it needs no read: in the loop below it used to fire
    // after the stacks ahead of it had been saved. AFTER the prompt rather than
    // ahead of it, so the prompt still names every target the run was asked
    // for, a legacy one included (the go-to-k/cdkd#3164 boundary fence renders
    // exactly that prompt). The name comes from an S3 KEY, and since
    // go-to-k/cdkd#3436 it is NOT pasted into a command here — `pasteableCommand`
    // takes the raw value and prints a hole when it cannot name it, so what the
    // prose owes the reader is a faithful IDENTITY, not a shell word.
    for (const target of targets) {
      if (!target.region) {
        // The name is an S3 KEY segment an attacker can plant, and it sits
        // beside a labelled `Migrate with:` line, so BOTH the prose and the
        // command take `isPasteableIdent` — the rule for naming a target
        // beside a labelled line (`state-malformed-containers.md`,
        // go-to-k/cdkd#3328; go-to-k/cdkd#3696). `displayIdent` is not
        // enough for the prose: it folds a newline and quotes what it alters,
        // but keeps interior spaces, so `ProdStack` + padding + `Migrate
        // with: cdkd destroy --all --force #` still wraps into a counterfeit
        // row. A name the predicate refuses is described, not shown
        // (`legacyRecordSubject`, shared with `state resources` / `state
        // show`) — the clause below gives the gate's own reason. `plainIdent`
        // makes the command's verdict the same one, so the prose never names
        // a value the command withholds.
        //
        // The command is LAST and UNWRAPPED on its own labelled line, named
        // only when the gate names it: not when it would not render EXACTLY
        // (an altered name can name a DIFFERENT stack, and `cdkd deploy`
        // WRITES), is a PATTERN (`*` deploys every stack), an OPTION (quoting
        // does not stop Commander parsing `'--all'`), or not a plain
        // identifier.
        const migrate = pasteableCommand('cdkd deploy', [
          {
            value: target.stackName,
            hole: STACK_HOLE,
            opts: { patternMatched: true, plainIdent: true },
          },
        ]);
        // The SAME shape as the two sibling refusals in this file, deliberately
        // (M5 of the go-to-k/cdkd#3499 review). `main` withheld the example
        // here and printed it inline when exact; both are safe, and that is not
        // what decides it — the three are one refusal, in one file, offering
        // one command, and the reason given for the odd one out ("the sentence
        // already says any cdkd write migrates it") is true of all three
        // sentences. Per-site judgement about what is safe HERE is the habit
        // this PR exists to end.
        throw new Error(
          `${legacyRecordSubject(target.stackName)} has only a legacy state record without a region. Migrate it to ` +
            `the region-scoped layout with any cdkd write, then re-run refresh-observed.` +
            // The clause comes from the GATE's own reason, not from a second
            // predicate here (M11 of the go-to-k/cdkd#3499 review). Keyed on
            // `displayIdent(name) === name` it disagreed with the command in
            // both directions: `Old;Stack` got "does not render exactly" above
            // a command naming it exactly, and `--all` — which `PLAIN_IDENT`
            // admits — rendered bare and authoritative above an unexplained
            // hole, inviting the operator to type the name that deploys every
            // stack in the app.
            withheldTargetClause(migrate, STACK_HOLE, 'cdkd deploy') +
            `\nMigrate with: ${migrate.command}`
        );
      }
    }
    let totalRefreshed = 0;
    let totalUnsupported = 0;
    let totalFailed = 0;
    let totalNotFound = 0;
    let totalRefusedBaseline = 0;
    let totalRefusedSticky = 0;

    for (const target of regionScoped) {
      const targetRegion = target.region;
      const scope = stackRegionScope(targetRegion);
      const counts = await runWithStackAwsClients(scope.clients, () =>
        refreshObservedForStack(
          target.stackName,
          targetRegion,
          setup.stateBackend,
          setup.lockManager,
          scope.registry,
          {
            dryRun: options.dryRun ?? false,
            logger,
            lockRecovery,
            ...(accept && { accept }),
          }
        )
      );
      totalRefreshed += counts.refreshed;
      totalUnsupported += counts.unsupported;
      totalFailed += counts.failed;
      totalNotFound += counts.notFound;
      totalRefusedBaseline += counts.refusedBaseline;
      totalRefusedSticky += counts.refusedSticky;
    }

    const summary = options.dryRun
      ? `Plan: ${totalRefreshed} resource(s) would be refreshed, ${totalUnsupported} unsupported, ${totalFailed} would fail (--dry-run, no state was written)`
      : `Done: ${totalRefreshed} resource(s) refreshed, ${totalUnsupported} unsupported, ${totalFailed} failed` +
        (totalNotFound > 0 ? `, ${totalNotFound} not found in AWS` : '');
    logger.info(safeMsg`\n${summary}`);

    // Issue #2944. Its OWN line rather than a fourth count in the summary, and
    // at `warn`: a refused resource is one the user asked to refresh and cdkd
    // declined to, for a security reason they cannot see from the record, and
    // it stays refused until that resource is deployed or updated — or, for an
    // unverifiable-parameter refusal, replaced or re-imported (issue #3465).
    // Folding it into the counts above would render it as routine attrition
    // next to `unsupported`. Printed only when it happened, so an ordinary
    // run's output is unchanged.
    if (totalRefusedBaseline > 0) {
      const head =
        safeMsg`${totalRefusedBaseline} resource(s) ${options.dryRun ? 'would NOT be refreshed' : 'were NOT refreshed'}: ` +
        `a 'cdkd import' run refused to capture their ` +
        `observed-properties baseline, because their recorded properties can no longer position the secret ` +
        `redaction — refreshing against those properties could persist a resolved secret into state.json in ` +
        `plaintext. `;
      // One tally covers resources whose remedies differ, so the
      // deploy-clearable wording is kept only when it is true of every one;
      // otherwise the count it is not true of is named, and `state show`
      // carries each resource's own remedy.
      const remedy =
        totalRefusedSticky === 0
          ? `A deploy that actually CHANGES one of them restores its baseline — a NO_CHANGE deploy ` +
            `does not, and re-running this command will refuse them again. `
          : `Re-running this command will refuse them again, and a NO_CHANGE deploy does not clear them. ` +
            safeMsg`${totalRefusedSticky} of them may keep the refusal even through a deploy that changes ` +
            `them, because it was recorded over a template parameter whose deployed value cdkd could not ` +
            `prove, or with no reason this cdkd recognizes — 'cdkd state show' names each one's ` +
            `remedy. ` +
            (totalRefusedSticky < totalRefusedBaseline
              ? `For the rest, a deploy that actually CHANGES one restores its baseline. `
              : '');
      logger.warn(
        safeMsg`${head}${remedy}Drift compares against their recorded properties until then.`
      );
    }

    if (totalFailed > 0 || totalNotFound > 0) {
      const parts: string[] = [];
      if (totalFailed > 0) {
        parts.push(
          `${totalFailed} per-resource readback failure(s); re-run ${proseQuoted(cdkdRemedy('cdkd state refresh-observed'))} to retry them.`
        );
      }
      if (totalNotFound > 0) {
        parts.push(
          `${totalNotFound} resource(s) not found in AWS (deleted outside cdkd); a retry will not ` +
            `change that, and 'cdkd drift' reports them as deleted.`
        );
      }
      throw new PartialFailureError(
        `Refresh completed with ${parts.join(' ')} ` +
          `Affected resources keep their previous observedProperties (or no observedProperties at all).`
      );
    }
  } finally {
    for (const { clients } of stackRegionScopes.values()) clients.destroy();
    setup.dispose();
  }
}

/**
 * `cdkd state refresh-observed`'s confirmation prompt. Its only call site is
 * inside the `if (!options.yes && !options.dryRun)` block above, which is what
 * keeps `confirmOrRefuse`'s non-interactive refusal (issue #2275) from firing
 * on a `--yes` run.
 *
 * Exported for unit testing — internal to the refresh-observed flow otherwise.
 */
export async function confirmRefresh(prompt: string): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    refusal:
      'The cdkd state refresh-observed confirmation prompt cannot run in a ' +
      'non-interactive environment. Pass -y / --yes to confirm the refresh, or run ' +
      'the command from a real terminal.',
  });
}

/**
 * Create the `state refresh-observed` subcommand.
 */
export function createStateRefreshObservedCommand(): Command {
  const cmd = new Command('refresh-observed')
    .description(
      'Refresh observedProperties for every resource in a stack by ' +
        'calling provider.readCurrentState — populates the drift baseline ' +
        'for stacks deployed before state schema v3, without redeploying. ' +
        'Run cdkd scrub first on state written by a pre-GHSA binary: the ' +
        'readback is redacted by POSITION against the record, so a record ' +
        'whose own properties still hold plaintext has nothing to redact from.'
    )
    .argument('[stacks...]', 'Stack name(s) to refresh (physical CloudFormation names)')
    .option('--all', 'Refresh every stack in the state bucket', false)
    .option('--dry-run', 'Print the per-stack refresh count without writing state', false)
    .option(
      '--accept-refused <logicalId>',
      'Clear the observed-baseline refusal on ONE resource and capture its baseline, asserting ' +
        'that AWS holds no secret the template does not spell as a dynamic reference. ' +
        'Requires --template and a single stack; prompts unless -y / --yes',
      collectAcceptRefused
    )
    .option(
      '--template <file>',
      'With --accept-refused: the synthesized template (JSON or YAML) this stack was last deployed from'
    )
    .addOption(stackRegionOption())
    .action(withErrorHandling(stateRefreshObservedCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
