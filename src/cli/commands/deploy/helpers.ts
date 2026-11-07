import { getLogger } from '../../../utils/logger.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { DeployResult } from '../../../deployment/deploy-engine.js';

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
