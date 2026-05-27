/**
 * Interactive confirmation prompt for `cdkd deploy --recreate-via-cc-api`
 * (issue [#649]).
 *
 * Mirror of {@link ../prefix-migration-check.ts}'s `promptMigrationConfirm`
 * but for the recreate-via-cc-api destroy+recreate cycle:
 *
 *   - `opts.yes` (CDK CLI parity `-y` / `--yes`) skips the prompt and
 *     prints the per-target plan as a `WARN` block (the existing v1
 *     surface). CI use case.
 *   - When `opts.yes` is false, the prompt fires after the per-target
 *     plan. Default is `N` because the side effect is destructive
 *     (a per-resource destroy + recreate cycle).
 *   - Non-TTY guard: if `opts.yes` is false AND stdin is not a TTY,
 *     throws with an actionable message rather than hanging or
 *     silently declining. CI runs without `--yes` would otherwise look
 *     like a successful skipped-deploy.
 *
 * The per-target plan surfaces a **DATA LOSS** prefix for stateful
 * targets (those with a non-null `statefulReason` after the live
 * `s3:ListObjectsV2` probe — see issue [#648]); these reached pre-flight
 * only because the user opted in with `--force-stateful-recreation`,
 * so the prompt's **DATA LOSS** wording is the third "stop and think"
 * moment.
 */

import readline from 'node:readline/promises';
import { getLogger } from '../../utils/logger.js';
import type { RecreateTarget } from '../../deployment/recreate-targets.js';

export async function promptRecreateConfirm(input: {
  stackName: string;
  targets: ReadonlyArray<RecreateTarget>;
  yes: boolean;
}): Promise<boolean> {
  if (input.targets.length === 0) return true;

  const logger = getLogger();
  logger.warn('');
  logger.warn(
    `--recreate-via-cc-api will destroy + recreate ${input.targets.length} ` +
      `resource(s) via Cloud Control API on stack ${input.stackName}:`
  );
  for (const t of input.targets) {
    const stateful = t.statefulReason !== null;
    const dataLossPrefix = stateful ? '**DATA LOSS** ' : '';
    const stateNote = stateful
      ? ` — stateful (${t.statefulReason}); --force-stateful-recreation acknowledged`
      : '';
    logger.warn(`  - ${dataLossPrefix}${t.logicalId} (${t.resourceType})${stateNote}`);
    if (stateful) {
      logger.warn(
        `    DATA: all data in ${t.logicalId} will be lost (no automatic data migration)`
      );
    }
  }
  logger.warn(
    '  The destroy + recreate cycle is per-resource; sibling resources are unaffected. ' +
      "Downstream consumers of any recreated resource's outputs (Fn::GetStackOutput / " +
      'Fn::ImportValue) will need a re-deploy to see the new physical id.'
  );

  if (input.yes) return true;

  // Non-TTY guard: reject explicitly rather than hanging on a closed
  // stdin or silently treating EOF as decline. CI runs without `--yes`
  // would otherwise look like a successful skipped-deploy; surface the
  // misconfiguration with an actionable error instead.
  if (process.stdin.isTTY !== true) {
    throw new Error(
      '--recreate-via-cc-api confirm prompt cannot run in a non-interactive ' +
        'environment. Pass --yes / -y to confirm the destroy + recreate cycle, ' +
        'or run the deploy from a real terminal.'
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question('\nContinue? (y/N): ');
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === 'y' || trimmed === 'yes') return true;
    logger.info('Deploy cancelled — no resources modified.');
    return false;
  } finally {
    rl.close();
  }
}
