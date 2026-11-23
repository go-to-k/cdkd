import { getLogger } from '../../../utils/logger.js';
import { cdkdRemedy, pasteableCommand, proseQuoted } from '../../../utils/pasteable-command.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { awsEndpointOverrideActive } from '../../../utils/aws-client-defaults.js';
import type { DeployResult } from '../../../deployment/deploy-engine.js';
import { promptYesNo } from '../confirm-prompt.js';
import {
  abortInFlightMultipartUploads,
  type InFlightAbort,
} from '../../../assets/file-asset-publisher.js';
import {
  type StartedForceQuitFlush,
  startForceQuitFlushes,
} from '../../../deployment/force-quit-journal.js';

/**
 * The `Release with:` command deploy's force-quit prints: both values are
 * quoted holes, since one run can hold several stacks' locks, and the shared
 * builder appends the run's typed `--profile` / `--state-bucket` /
 * `--state-prefix` so a paste unlocks in the same account and bucket
 * (go-to-k/cdkd#4177). Exported for its test.
 */
export function forceQuitReleaseCommand(): string {
  return pasteableCommand('cdkd force-unlock', [
    { hole: 'stackName' },
    { flag: '--stack-region', hole: 'region' },
  ]).command;
}

/**
 * Splits `DeployResult.updatePartial` into this stack's own partial rows and
 * the part nested-stack descendants reported (issue #1989), for the summary's
 * `Updated:` total, which counts this stack's own rows only. The descendant
 * figure is clamped into `[0, updatePartial]`, so the two always sum to
 * `updatePartial` and the exit code's count is never re-derived from them.
 * Exported for its test.
 */
export function splitUpdatePartial(
  result: Pick<DeployResult, 'updatePartial' | 'nestedUpdatePartial'>
): { ownUpdatePartial: number; nestedUpdatePartial: number } {
  const reported = result.nestedUpdatePartial ?? 0;
  const nestedUpdatePartial = Math.min(Math.max(reported, 0), result.updatePartial);
  // The engine adds a descendant's partials to both counters, so a clamp that
  // fires means that invariant broke; say so rather than correct it silently.
  if (nestedUpdatePartial !== reported) {
    getLogger().debug(
      safeMsg`nestedUpdatePartial ${reported} is outside [0, updatePartial ${result.updatePartial}]; clamped to ${nestedUpdatePartial}`
    );
  }
  return { ownUpdatePartial: result.updatePartial - nestedUpdatePartial, nestedUpdatePartial };
}

/**
 * The per-region asset-storage auto-create's confirmation (issue #1007):
 * interactive runs are prompted once per region; `--yes` / non-TTY runs
 * create with an info line. Under `--aws-emulator` it never prompts
 * (go-to-k/cdkd#6186): AWS Emulator is a throwaway local sandbox whose
 * storage is gone on every restart. Exported for its test.
 */
export async function confirmAutoAssetStorageCreate(args: {
  assetRegion: string;
  accountId: string;
  yes: boolean;
}): Promise<boolean> {
  const { assetRegion, accountId } = args;
  const logger = getLogger();
  if (awsEndpointOverrideActive()) {
    logger.info(
      safeMsg`Creating cdkd asset storage for region '${assetRegion}' in AWS Emulator ` +
        `(no prompt under --aws-emulator; opt out with --no-auto-asset-storage).`
    );
    return true;
  }
  if (args.yes || !process.stdin.isTTY) {
    logger.info(
      safeMsg`Creating cdkd asset storage for region '${assetRegion}' (first deploy into this ` +
        `region; opt out with --no-auto-asset-storage).`
    );
    return true;
  }
  return promptYesNo(
    `Region '${assetRegion}' has no cdkd asset storage yet. Create it now ` +
      `(S3 bucket cdkd-assets-${accountId}-${assetRegion} + container-asset ECR repo, ` +
      `out of 'cdk gc' reach)?`
  );
}

/**
 * How long deploy's force-quit waits for in-flight uploads to abort and for
 * the rollback journal to be written (go-to-k/cdkd#6894), both at once.
 */
export const FORCE_QUIT_ABORT_BUDGET_MS = 5000;

/** The `cdkd rollback` line printed once a force-quit recorded a stack's changes. */
export function forceQuitRollbackLine(stackName: string): string {
  const command = pasteableCommand('cdkd rollback', [{ value: stackName, hole: 'stack' }]).command;
  return `What the deploy changed so far was recorded; revert it with: ${command}\n`;
}

/**
 * Deploy's force-quit: abort the multipart uploads in flight
 * (go-to-k/cdkd#6162) and write the rollback journal of each deploy still
 * running (go-to-k/cdkd#6894), say what happened, THEN exit. `process.exit`
 * first would leave the uploads' parts billed in the bucket and the changes
 * already made unrecorded, so `cdkd rollback` could not revert them; and the
 * lines are written HERE, because the exit races the uploads' own rejections
 * up to the work graph. Bounded: an abort or a journal write that hangs (a dead
 * network is a likely reason to hit Ctrl-C twice) still exits after
 * `budgetMs`. Exported for its test.
 */
export function exitAfterAbortingUploads(
  exit: (code: number) => void,
  write: (text: string) => void,
  abort: () => InFlightAbort = abortInFlightMultipartUploads,
  budgetMs: number = FORCE_QUIT_ABORT_BUDGET_MS,
  flush: () => StartedForceQuitFlush = startForceQuitFlushes,
  code = 130
): Promise<void> {
  let started: InFlightAbort;
  try {
    started = abort();
  } catch {
    started = { destinations: [], done: Promise.resolve() };
  }
  let flushing: StartedForceQuitFlush;
  try {
    flushing = flush();
  } catch {
    flushing = { pending: 0, done: Promise.resolve([]) };
  }
  const { destinations } = started;
  let exited = false;
  const finish = (recorded: string[] | undefined): void => {
    if (exited) return;
    exited = true;
    const confirmed = recorded !== undefined;
    if (destinations.length > 0) {
      const list = destinations.map((d) => displaySafe(d)).join(', ');
      write(
        confirmed
          ? `Interrupted: aborted the in-flight asset upload(s) ${list}.\n`
          : `Interrupted: exiting before the abort of the in-flight asset upload(s) ${list} ` +
              `was confirmed; the asset bucket's lifecycle rule removes what is left.\n`
      );
    }
    if (recorded === undefined && flushing.pending > 0) {
      write(
        'Force-quit: exiting before the rollback journal was written; ' +
          `${proseQuoted(cdkdRemedy('cdkd rollback'))} may not be able to revert what this deploy changed.\n`
      );
    }
    for (const stackName of recorded ?? []) write(forceQuitRollbackLine(stackName));
    exit(code);
  };
  const timer = setTimeout(() => finish(undefined), budgetMs);
  return Promise.all([
    started.done.catch(() => undefined),
    flushing.done.catch(() => [] as string[]),
  ]).then(([, recorded]) => {
    clearTimeout(timer);
    finish(recorded);
  });
}

export interface DeploySigintHandlerOptions {
  /** Called on the first signal, after its notice, and on a hang-up. */
  onFirst: () => void;
  /** Test seams; default to the process. */
  write?: (text: string) => void;
  exit?: (code: number) => void;
  abort?: () => InFlightAbort;
  flush?: () => StartedForceQuitFlush;
  budgetMs?: number;
}

/** Deploy's SIGINT handler, with its SIGHUP entry on the same state. */
export interface DeploySignalHandler {
  (): void;
  /**
   * SIGHUP (go-to-k/cdkd#6894): the terminal is gone, so no second Ctrl-C can
   * follow and no notice can be read. Force-quit at once, journal included,
   * and exit 129 (128 + SIGHUP), the code an unhandled hang-up leaves.
   */
  hangup(): void;
}

/** The exit code of a deploy ended by a hang-up (128 + SIGHUP). */
export const SIGHUP_EXIT_CODE = 129;

/**
 * Deploy's SIGINT handler (SIGTERM is forwarded to it; SIGHUP enters through
 * `hangup`).
 *
 * - First signal: say so, and let the operations in progress finish — asset
 *   uploads included, as the notice promises (go-to-k/cdkd#6162).
 * - Second: print the lock-recovery command, abort the in-flight multipart
 *   uploads and write the rollback journal of the deploys still running, THEN
 *   exit 130 ({@link exitAfterAbortingUploads}).
 * - Third, while that runs: exit at once — unless the force-quit came from a
 *   hang-up, which nothing cuts short.
 *
 * Exported for its test.
 */
export function createDeploySigintHandler(
  options: DeploySigintHandlerOptions
): DeploySignalHandler {
  const write = options.write ?? ((text: string) => void process.stderr.write(text));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let signals = 0;
  // The exit code of the force-quit under way, once one started.
  let forceQuitting: number | undefined;
  const forceQuit = (code: number): void => {
    forceQuitting = code;
    // Force-exit bypasses every `finally`, so per-stack locks may be left
    // behind. Print the recovery command (parity with destroy's force-quit
    // path) — the lock TTL reclaims them automatically otherwise.
    write(
      '\nForce-quit: stack locks may not be released. ' +
        'If the next run reports a lock, run this for EACH stack it names, ' +
        'in the region-qualified form — see the message that run prints.' +
        // The holes are QUOTED, and on a labelled line of their own. A bare
        // `<stackName>` is two shell redirections: `<stackName` reads stdin
        // from a file and the `>` takes the next word as an output TARGET
        // and creates it (measured on go-to-k/cdkd#3436). `commandHole`
        // prints `'<stackName>'`, so this line is inert BY DESIGN and stays
        // inert if a flag is appended (go-to-k/cdkd#3613's M8).
        // Built through the shared builder so it carries the run's typed
        // `--profile` / `--state-bucket` / `--state-prefix` (go-to-k/cdkd#4177).
        `\nRelease with: ${forceQuitReleaseCommand()}\n`
    );
    void exitAfterAbortingUploads(
      exit,
      write,
      options.abort,
      options.budgetMs,
      options.flush,
      code
    );
  };
  const handler = (): void => {
    signals++;
    // A hang-up's force-quit is not cut short: no one at a closed terminal
    // asked for it, and its budget bounds it anyway.
    if (forceQuitting === SIGHUP_EXIT_CODE) return;
    if (forceQuitting !== undefined) {
      exit(130);
      return;
    }
    if (signals === 1) {
      write('\nInterrupted — waiting for in-progress operations to complete...\n');
      options.onFirst();
      return;
    }
    forceQuit(130);
  };
  return Object.assign(handler, {
    hangup: (): void => {
      // A hang-up during a force-quit already under way changes nothing.
      if (forceQuitting !== undefined) return;
      // Stop the run starting another stack while the journal is written.
      options.onFirst();
      forceQuit(SIGHUP_EXIT_CODE);
    },
  });
}
