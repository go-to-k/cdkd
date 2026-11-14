import { Command, Option } from 'commander';
import { cliArgParser } from '../arg-parser.js';
import { commonOptions } from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { gcCommand, type GcOptions } from './gc/command.js';

export { collectAssetReferences, type AssetReferences } from './gc/asset-references.js';
export {
  listResponsePlaceholderCandidates,
  promptGcConfirm,
  type ResponsePlaceholderCandidate,
} from './gc/candidates.js';
export { gcCommand, type GcOptions } from './gc/command.js';

/**
 * `cdkd gc` — garbage-collect unreferenced objects / images from the
 * cdkd-owned asset storage of ONE region (issue #1012).
 *
 * cdkd-owned asset storage (issue #1002) is content-addressed and never
 * deleted on `cdkd destroy` (another stack or a future rollback may
 * reference the same hash), so the asset bucket / container-asset ECR repo
 * grow without bound — and `cdk gc` cannot reach them by design. cdkd can
 * gc them PRECISELY because its state files record exactly which assets
 * are in use.
 *
 * Safety posture (this command DELETES user data — every ambiguity is
 * biased toward NOT deleting):
 *
 * - Names come from the region's bootstrap marker, never recomputed from
 *   the naming convention (custom-name compatibility, issue #1011). No
 *   marker → no ASSET storage in scope; since issue #2052 the run continues
 *   to the state-bucket placeholder sweep rather than ending, and is a
 *   friendly no-op only when neither side has anything. CDK bootstrap
 *   storage (`cdk-hnb659fds-*`) is never touched — that stays `cdk gc`'s
 *   job.
 * - Abandoned `custom-resource-responses/{requestId}.json` placeholders in
 *   the STATE bucket are collected too (issue #2052). Two things make that
 *   the one arm needing its own guard: it is gc's only DESTRUCTIVE call
 *   against the state bucket, and it is ACCOUNT-scoped where every other arm
 *   is region-scoped (the keys carry no region). It matches the producer's
 *   own key shape rather than sweeping the prefix by age alone, so a stack
 *   deployed with a colliding `--state-prefix` cannot have its `state.json`
 *   collected.
 * - The reference scan lists EVERY state file in the WHOLE state bucket
 *   (any `--state-prefix`), and a state file that fails to JSON-parse
 *   aborts the whole run — deleting on partial knowledge is how a live
 *   asset gets deleted.
 * - Any stack lock in the bucket aborts the run: a deploy in flight may
 *   have published assets whose state write has not landed yet.
 * - `--older-than` (default 30d) age-guards every deletion: an object /
 *   image newer than the cutoff is kept even when unreferenced (protects
 *   in-flight publishes and recent rollback targets). Missing timestamps
 *   are treated as "new" (kept).
 * - Every S3 call pins `ExpectedBucketOwner`; a 403 on the asset bucket is
 *   a foreign-bucket refusal like the create / teardown sides.
 */

/** Default `--older-than` when the flag is not passed. */
const DEFAULT_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/**
 * Parse the `--older-than` age guard: `<n>d` (days) or `<n>h` (hours),
 * decimals allowed (`1.5d`). Zero, negative, missing-unit, and
 * unknown-unit values are rejected at parse time — a zero / negative age
 * guard would disable the in-flight-publish protection entirely.
 *
 * Kept local (rather than extending `parseDuration` in `options.ts`):
 * the deploy-side duration grammar is seconds/minutes/hours for
 * per-resource deadlines, while gc ages are naturally days — mixing `30s`
 * into an age guard invites typos that all but disable it.
 */
export function parseOlderThan(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([dh])$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid --older-than "${value}": expected '<number>d' or '<number>h' (e.g. 30d, 12h)`
    );
  }
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid --older-than "${value}": must be greater than zero`);
  }
  const multiplier = match[2] === 'd' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return Math.round(num * multiplier);
}

/**
 * Create the `cdkd gc` command (upstream `cdk gc` parity naming).
 */
export function createGcCommand(): Command {
  const cmd = new Command('gc')
    .description(
      "Garbage-collect unreferenced objects / images from ONE region's cdkd-owned asset " +
        'storage (asset bucket + container-asset ECR repo), plus abandoned custom-resource ' +
        'response placeholders in the state bucket (account-wide). References are collected ' +
        'from every cdkd state file; CDK bootstrap storage is never touched (use cdk gc).'
    )
    .option(
      '--state-bucket <bucket>',
      'S3 bucket holding cdkd state (default: cdkd-state-{accountId})'
    )
    .addOption(
      new Option(
        '--older-than <duration>',
        'Never delete an object / image newer than this age, even when unreferenced ' +
          '(protects in-flight publishes and recent rollback targets). Accepts <n>d / <n>h.'
      )
        .default(DEFAULT_OLDER_THAN_MS, '30d')
        .argParser(cliArgParser(parseOlderThan))
    )
    .option('--dry-run', 'Print the reclaim plan (per-item list + totals) without deleting', false)
    .addOption(
      // Picks WHICH region's asset storage to gc (issue #2029). The "refuses if
      // none is configured" clause an earlier cut carried here was false —
      // `resolveEffectiveRegion` ends at the us-east-1 literal and gc proceeds.
      new Option(
        '--region <region>',
        'Region whose cdkd asset storage to garbage-collect ' +
          '(defaults to AWS_REGION, then AWS_DEFAULT_REGION, then your AWS ' +
          "profile's region, then us-east-1)"
      )
    )
    .action(
      withErrorHandling(async (options: GcOptions): Promise<void> => {
        await gcCommand(options);
      })
    );

  // Add common options (--profile, --role-arn, --verbose, --yes)
  commonOptions.forEach((opt) => cmd.addOption(opt));

  return cmd;
}
