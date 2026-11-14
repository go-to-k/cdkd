import { CrossPrefixGuard } from '../../../state/stack-registry.js';
import {
  cdkdRemedy,
  pasteableCommand,
  plainOrDescribed,
  proseQuoted,
} from '../../../utils/pasteable-command.js';
import { warnIfDeprecatedRegion } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { AwsClients, runWithStackAwsClients, setAwsClients } from '../../../utils/aws-clients.js';
import { loadProviderClasses } from '../../../provisioning/register-providers.js';
import { dropFailedJournalEntry, refuseDropFailedConflicts } from '../rollback-drop-failed.js';
import { setupStateBackend, resolveSingleRegion } from '../state.js';
import type { StackStateRef } from '../../../state/s3-state-backend.js';
import { isPasteableIdent, safeMsg } from '../../../utils/display-safe.js';
import { type RollbackOptions, findJournalCandidates } from './options.js';
import { runRollbackReplay } from './replay.js';

export async function rollbackCommand(
  stackArg: string | undefined,
  options: RollbackOptions
): Promise<void> {
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope / globals are set (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }
  warnIfDeprecatedRegion(options);
  // go-to-k/cdkd#4633: before any AWS call, so a bad combination costs nothing.
  if (options.dropFailed !== undefined) refuseDropFailedConflicts(options);

  const setup = await setupStateBackend(options);
  const skipConfirmation = options.force === true || options.yes === true;
  // Stack-region-pinned client set installed as the process-global for the
  // replay (see the note at its construction below); the original set is
  // restored and this one disposed in the outer finally.
  let stackAwsClients: AwsClients | undefined;

  try {
    // 1. Resolve the target stack + region.
    let ref: StackStateRef;
    if (stackArg) {
      const refs = await setup.stateBackend.listStacks();
      ref = resolveSingleRegion(stackArg, refs, options.stackRegion);
    } else {
      const candidates = await findJournalCandidates(setup.stateBackend, setup.prefix);
      const inRegion = options.stackRegion
        ? candidates.filter((c) => c.region === options.stackRegion)
        : candidates;
      // A nested child's journal is its PARENT's to replay (issue #3754): a
      // parent's `cdkd rollback` reverts the child row from it. So a child
      // (`<parent>~<id>`) whose parent is itself a candidate in the same region
      // is not a separate choice to offer.
      const scoped = inRegion.filter((c) => {
        const cut = c.stackName.lastIndexOf('~');
        if (cut <= 0) return true;
        const parent = c.stackName.slice(0, cut);
        return !inRegion.some((p) => p.stackName === parent && p.region === c.region);
      });
      if (scoped.length === 0) {
        logger.info(
          'Nothing to roll back — no stack has a rollback journal. ' +
            safeMsg`Run ${proseQuoted(cdkdRemedy('cdkd deploy'))} to (re)deploy, or ${proseQuoted(cdkdRemedy('cdkd destroy'))} to clean up.`
        );
        return;
      }
      if (scoped.length > 1) {
        // These rows are what the user picks a `cdkd rollback <stack>` argument
        // from, beside a quoted command template. Both values come from journal
        // S3 keys, so each is named only when it is a plain identifier: padding
        // that wraps on screen could otherwise spell a counterfeit labelled row
        // (go-to-k/cdkd#3760). A real stack name and region always are.
        const list = scoped
          .map(
            (c) =>
              `  - ${plainOrDescribed(c.stackName, 'stack name')} ` +
              `(${plainOrDescribed(c.region ?? '', 'region')})`
          )
          .join('\n');
        // A described row cannot be told apart from another, so say where the
        // records are listed as stored.
        const described = scoped.some(
          (c) => !isPasteableIdent(c.stackName) || !isPasteableIdent(c.region ?? '')
        )
          ? `A row whose stack name or region is not a plain identifier is described, not named; ` +
            `list the records as stored with ${proseQuoted(cdkdRemedy('cdkd state list', '--long'))}.\n`
          : '';
        throw new Error(
          `Multiple stacks have a rollback journal. Pick one:\n${list}\n` +
            described +
            `Re-run ${pasteableCommand('cdkd rollback', [{ hole: 'stack' }]).command} (add --stack-region if the same name spans regions).`
        );
      }
      ref = scoped[0]!;
    }
    const stackName = ref.stackName;
    const region = ref.region ?? (await setup.regionFor(ref.stackName));

    // go-to-k/cdkd#4633: journal only — no providers, no AWS clients, no replay.
    if (options.dropFailed !== undefined) {
      await dropFailedJournalEntry({
        stateBackend: setup.stateBackend,
        lockManager: setup.lockManager,
        stackName,
        region,
        logicalId: options.dropFailed,
        skipConfirmation,
        logger,
      });
      return;
    }

    // go-to-k/cdkd#4705: the replay deletes what the failed deploy created, and
    // for a stack the bucket also records under another state prefix that can
    // be the other deployment's resource (a create handed it back). Started
    // here, awaited under the lock before the plan, the prompt and any replay.
    // Never rejects.
    const crossPrefixScan = new CrossPrefixGuard(setup.stateBackend).full(stackName, region);

    // Region-pinned clients for the whole replay: the pre-delete final
    // snapshots a `DeletionPolicy: Snapshot` rolled-back CREATE takes (issue
    // #1358) AND the provider deletes those snapshots precede. Both must run
    // against the TARGET STACK's region, which `--stack-region` can point
    // away from the CLI's --region / AWS_REGION: a wrong-region snapshot call
    // 404s as a NotFound, which reads as "source gone" and would silently
    // skip the snapshot, and a wrong-region delete trips `assertRegionMatch`.
    // Pinning only the snapshot would be worse than not pinning it at all —
    // it would take a real, billable snapshot and then fail the delete.
    //
    // Built UNCONDITIONALLY rather than under a `region !== setup.region`
    // guard: `region` can be a record's own region or one held on the old
    // us-east-1 default (go-to-k/cdkd#2100), while `setup.awsClients`
    // resolves through the SDK chain (profile config), so the two can
    // disagree while the labels match. `setAwsClients` mirrors
    // what `destroy-runner.ts` does for a cross-region destroy; the original
    // set is restored in the outer finally.
    stackAwsClients = new AwsClients({
      region,
      ...(options.profile && { profile: options.profile }),
    });
    setAwsClients(stackAwsClients);
    const finalSnapshotClients = stackAwsClients;

    // go-to-k/cdkd#4932: the registry AND the replay run inside the stack AWS
    // scope, as deploy does. `setAwsClients` above pins only the providers
    // that read `getAwsClients()`; a provider building its own SDK client
    // reads its region from `ambientRegion()` at construction, which outside
    // a scope is the CLI's `AWS_REGION`, so without it a rollback of a stack
    // recorded in another region would delete, create or update a same-named
    // resource in the ambient region. The registry is built inside so every
    // provider it constructs captures the stack's region.
    await runWithStackAwsClients(stackAwsClients, () =>
      runRollbackReplay({
        providerClasses,
        setup,
        options,
        logger,
        stackName,
        region,
        crossPrefixScan,
        finalSnapshotClients,
        skipConfirmation,
      })
    );
  } finally {
    // Restore the process-global client set BEFORE disposing ours, so a
    // later consumer in the same process never reaches a destroyed client.
    if (stackAwsClients) {
      setAwsClients(setup.awsClients);
      stackAwsClients.destroy();
    }
    setup.dispose();
  }
}
