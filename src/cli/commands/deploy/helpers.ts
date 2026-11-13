import { getLogger } from '../../../utils/logger.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { awsEndpointOverrideActive } from '../../../utils/aws-client-defaults.js';
import type { DeployResult } from '../../../deployment/deploy-engine.js';
import { promptYesNo } from '../confirm-prompt.js';
import { abortInFlightMultipartUploads } from '../../../assets/file-asset-publisher.js';

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

/** How long deploy's force-quit waits for in-flight uploads to abort. */
export const FORCE_QUIT_ABORT_BUDGET_MS = 5000;

/**
 * Deploy's second Ctrl-C: abort the multipart uploads in flight, THEN exit
 * (go-to-k/cdkd#6162). `process.exit` first would leave their parts billed in
 * the bucket. Bounded: an abort that hangs (a dead network is a likely reason
 * for the user to hit Ctrl-C twice) still exits after `budgetMs`. Exported for
 * its test.
 */
export function exitAfterAbortingUploads(
  exit: (code: number) => void,
  abort: () => Promise<void> = abortInFlightMultipartUploads,
  budgetMs: number = FORCE_QUIT_ABORT_BUDGET_MS
): Promise<void> {
  let exited = false;
  const finish = (): void => {
    if (exited) return;
    exited = true;
    exit(130);
  };
  const timer = setTimeout(finish, budgetMs);
  return abort()
    .catch(() => undefined)
    .then(() => {
      clearTimeout(timer);
      finish();
    });
}

export interface DeploySigintHandlerOptions {
  /** Called on the first signal, after its notice. */
  onFirst: () => void;
  /** Test seams; default to the process. */
  write?: (text: string) => void;
  exit?: (code: number) => void;
  abort?: () => Promise<void>;
  budgetMs?: number;
}

/**
 * Deploy's SIGINT handler (SIGTERM is forwarded to it).
 *
 * - First signal: say so, and let the operations in progress finish — asset
 *   uploads included, as the notice promises (go-to-k/cdkd#6162).
 * - Second: print the lock-recovery command, abort the in-flight multipart
 *   uploads, THEN exit 130 ({@link exitAfterAbortingUploads}).
 * - Third, while that abort runs: exit at once.
 *
 * Exported for its test.
 */
export function createDeploySigintHandler(options: DeploySigintHandlerOptions): () => void {
  const write = options.write ?? ((text: string) => void process.stderr.write(text));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let signals = 0;
  return () => {
    signals++;
    if (signals === 1) {
      write('\nInterrupted — waiting for in-progress operations to complete...\n');
      options.onFirst();
      return;
    }
    if (signals > 2) {
      exit(130);
      return;
    }
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
    void exitAfterAbortingUploads(exit, options.abort, options.budgetMs);
  };
}
