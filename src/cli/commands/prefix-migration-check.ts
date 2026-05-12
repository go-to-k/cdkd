import * as readline from 'node:readline/promises';
import { getLogger } from '../../utils/logger.js';
import {
  PATTERN_B_NAME_PROPERTIES,
  PATTERN_B_RESOURCE_TYPES,
} from '../../provisioning/resource-name.js';
import type { StackState } from '../../types/state.js';

/**
 * A pending REPLACEMENT predicted by the `--no-prefix-user-supplied-names`
 * migration check. One entry per Pattern B resource in state whose
 * `physicalId` still carries the legacy `${stackName}-` prefix.
 */
export interface PendingRename {
  /** CFn logical ID (the key in `state.resources`). */
  logicalId: string;
  /** AWS resource type (one of `PATTERN_B_RESOURCE_TYPES`). */
  resourceType: string;
  /** Current physical id recorded in cdkd state (prefixed). */
  oldPhysicalId: string;
  /** Expected new physical id after the flag flips (prefix stripped). */
  newPhysicalId: string;
}

/**
 * Inspect `state` and return the list of Pattern B resources whose
 * `physicalId` starts with `${stackName}-` AND was originally given a
 * user-supplied physical name (state's recorded `properties[<NameField>]`
 * is set). These are the resources whose next deploy under the v0.94.0
 * default would silently propose REPLACEMENT, because the new template
 * intent is the unprefixed user-supplied name. The caller surfaces them
 * via {@link promptMigrationConfirm} before any provider call runs.
 *
 * **Why the user-supplied gate** (load-bearing): Pattern B types accept
 * BOTH user-supplied names (`new iam.Role(this, 'X', { roleName: 'foo' })`)
 * AND auto-generated logical-id-fallback names (`new iam.Role(this, 'X')`).
 * Pre-v0.94 the prefix was applied to BOTH. Post-v0.94 the prefix is
 * applied only to the auto-generated path; user-supplied names are taken
 * verbatim. So:
 *
 *   - User-supplied name in pre-v0.94 state (`Properties.RoleName: 'foo'`,
 *     physicalId `MyStack-foo`) → next deploy computes `foo` →
 *     REPLACE pending. Flag.
 *   - Auto-generated name in pre-v0.94 state (no `Properties.RoleName`,
 *     physicalId `MyStack-MyConstructRoleF44D44CF`) → next deploy
 *     STILL computes `MyStack-MyConstructRoleF44D44CF` (`userSupplied:
 *     false` keeps the prefix regardless of the v0.94.0 default flip).
 *     NO REPLACE pending. Do NOT flag.
 *
 * The naive prefix-startsWith check (without the user-supplied gate)
 * surfaces a false-positive WARNING on every auto-generated name in
 * every pre-v0.94 stack. Closes that bug.
 *
 * Pattern A resources are intentionally NOT considered — they never got
 * the prefix on a user-supplied name to begin with, so the flag is a
 * no-op for them.
 *
 * Returns an empty array when state is `undefined` (first-time deploy
 * with no existing state — nothing to migrate), when no resource is of
 * a Pattern B type, when every Pattern B resource is already unprefixed
 * (e.g. the stack was originally deployed with the flag on), OR when
 * every prefix-style Pattern B resource is auto-generated (the common
 * case for stacks that never opted into user-supplied names).
 */
export function findPendingPrefixRenames(
  stackName: string,
  state: StackState | undefined
): PendingRename[] {
  if (!state) return [];

  const patternB = new Set<string>(PATTERN_B_RESOURCE_TYPES);
  const prefix = `${stackName}-`;
  const out: PendingRename[] = [];

  for (const [logicalId, resource] of Object.entries(state.resources)) {
    if (!patternB.has(resource.resourceType)) continue;
    if (typeof resource.physicalId !== 'string') continue;
    if (!resource.physicalId.startsWith(prefix)) continue;

    // Gate on user-supplied. The deploy engine only drops the prefix
    // for resources whose name property was explicitly set in CDK
    // code. State records this as `properties[<NameField>]`. Empty
    // string or undefined means the resource went through the
    // logical-id fallback path — prefix kept regardless of the
    // v0.94.0 default flip — no REPLACE pending.
    const nameProperty = PATTERN_B_NAME_PROPERTIES[resource.resourceType];
    if (!nameProperty) continue; // defensive: should be set for every Pattern B type
    const userSuppliedName = resource.properties?.[nameProperty];
    if (typeof userSuppliedName !== 'string' || userSuppliedName === '') continue;

    const newPhysicalId = resource.physicalId.slice(prefix.length);
    // Edge case: physicalId is exactly `${stackName}-` (= empty
    // resource-name suffix). Skip rather than report a `→ ""` rename
    // entry that the user would not be able to act on.
    if (newPhysicalId.length === 0) continue;

    out.push({
      logicalId,
      resourceType: resource.resourceType,
      oldPhysicalId: resource.physicalId,
      newPhysicalId,
    });
  }

  return out;
}

/**
 * Print a warning listing every pending REPLACEMENT and (unless
 * `opts.yes`) prompt the user for confirmation. Returns `true` when
 * the deploy should proceed, `false` when the user declined.
 *
 * `opts.yes` short-circuits the prompt and returns `true` (the warning
 * is still printed so the side effect remains visible in non-interactive
 * runs / CI logs).
 *
 * The prompt defaults to `N` because the side effect is a destructive
 * REPLACEMENT — mirrors `cdkd destroy --remove-protection`'s flipped
 * default for the same reason.
 */
export async function promptMigrationConfirm(
  renames: PendingRename[],
  opts: { yes?: boolean }
): Promise<boolean> {
  if (renames.length === 0) return true;

  const logger = getLogger();
  logger.warn('');
  logger.warn(
    `WARNING: --no-prefix-user-supplied-names will REPLACE ${renames.length} ` +
      `resource(s) whose AWS physical name is still prefixed with the stack name:`
  );
  for (const r of renames) {
    logger.warn(`  - ${r.logicalId} (${r.resourceType}): ${r.oldPhysicalId} -> ${r.newPhysicalId}`);
  }
  logger.warn(
    'These resources will be REPLACED because the new naming convention drops ' +
      'the stack-name prefix.'
  );

  if (opts.yes) return true;

  // Non-TTY guard: reject explicitly rather than hanging on a closed
  // stdin or silently treating EOF as decline. CI runs without `--yes`
  // would otherwise look like a successful skipped-deploy; surface the
  // misconfiguration with an actionable error instead.
  if (process.stdin.isTTY !== true) {
    throw new Error(
      '--no-prefix-user-supplied-names migration confirm prompt cannot run in a ' +
        'non-interactive environment. Pass --yes / -y to confirm the REPLACEMENT, ' +
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
