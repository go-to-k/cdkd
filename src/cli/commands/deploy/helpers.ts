import { getLogger } from '../../../utils/logger.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { awsEndpointOverrideActive } from '../../../utils/aws-client-defaults.js';
import type { DeployResult } from '../../../deployment/deploy-engine.js';
import { promptYesNo } from '../confirm-prompt.js';

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
