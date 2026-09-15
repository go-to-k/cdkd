import * as readline from 'node:readline/promises';
import { getLogger } from '../../utils/logger.js';
import { DeployCancelledError } from '../../utils/error-handler.js';
import {
  PATTERN_B_NAME_OPTIONS,
  PATTERN_B_NAME_PROPERTIES,
  PATTERN_B_RESOURCE_TYPES,
  generateResourceName,
  withSkipPrefix,
  withStackName,
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
 *     physicalId `MyStack-foo` = `${stackName}-${userName}`) → next deploy
 *     computes `foo` → REPLACE pending. Flag.
 *   - Auto-generated name in pre-v0.94 state (no `Properties.RoleName`,
 *     physicalId `MyStack-MyConstructRoleF44D44CF`) → next deploy
 *     STILL computes `MyStack-MyConstructRoleF44D44CF` (`userSupplied:
 *     false` keeps the prefix regardless of the v0.94.0 default flip).
 *     NO REPLACE pending. Do NOT flag.
 *   - User-supplied name that itself starts with `${stackName}-`
 *     (`Properties.RoleName: 'MyStack-role'`, physicalId `MyStack-role`,
 *     a very common `\`${id}-role\`` convention) → post-v0.94 takes the
 *     name verbatim, so physicalId already equals the post-v0.94 name →
 *     NO rename, NO REPLACE pending. Do NOT flag.
 *
 * The discriminator recomputes BOTH name forms for the recorded
 * user-supplied name through the SAME `generateResourceName` pipeline the
 * provider used (sanitize bad chars + collapse hyphens + hash-suffix
 * truncate past maxLength) — `legacyName` (prefix applied) and `newName`
 * (`withSkipPrefix(true)`, prefix dropped). It skips when
 * `physicalId === newName` (already migrated / verbatim), and flags only
 * when `physicalId === legacyName && legacyName !== newName`. Comparing
 * generated forms (not a naive `${stackName}-` concat / strip) is
 * load-bearing for names that needed sanitization (`my_role` ->
 * `my-role`) or truncation, which a string concat would mis-compare.
 *
 * Both the naive prefix-startsWith check (false-positive on every
 * auto-generated name) AND the blind prefix-strip (false-positive on a
 * user name that starts with the stack name, blocking routine in-place
 * updates) are closed here.
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

    const nameOptions = PATTERN_B_NAME_OPTIONS[resource.resourceType];
    if (!nameOptions) continue; // defensive: should be set for every Pattern B type

    // Recompute BOTH physical-name forms for the recorded user-supplied name
    // through the SAME `generateResourceName` pipeline the provider used
    // (sanitize bad chars + collapse hyphens + hash-suffix truncate past
    // maxLength), so a name that needed sanitization (`my_role` -> `my-role`)
    // or truncation is compared EXACTLY — not via a naive prefix concat/strip.
    //
    //   - legacyName: pre-v0.94 form (stack-name prefix applied).
    //   - newName:    post-v0.94 form (`withSkipPrefix(true)` drops the prefix
    //                 on a user-supplied name) — what the next deploy targets.
    const legacyName = withStackName(stackName, () =>
      generateResourceName(userSuppliedName, { ...nameOptions, userSupplied: true })
    );
    const newName = withStackName(stackName, () =>
      withSkipPrefix(true, () =>
        generateResourceName(userSuppliedName, { ...nameOptions, userSupplied: true })
      )
    );

    // No rename pending when the resource is ALREADY in its post-v0.94 form.
    // This is the load-bearing false-positive guard: a user-supplied name that
    // merely starts with `${stackName}-` (e.g. `roleName: \`${id}-role\``, a
    // very common convention) was deployed verbatim, so its physicalId already
    // equals `newName`. The old code blindly stripped the prefix, mis-predicted
    // `MyStack-role` -> `role`, and forced a spurious REPLACEMENT prompt that
    // hard-failed every in-place update in non-interactive runs.
    if (resource.physicalId === newName) continue;

    // A REPLACE pends only when the recorded physicalId is the genuine legacy
    // auto-prefixed form AND that differs from the new (unprefixed) form.
    if (resource.physicalId !== legacyName) continue;
    if (legacyName === newName) continue; // prefix made no difference — nothing to migrate

    out.push({
      logicalId,
      resourceType: resource.resourceType,
      oldPhysicalId: resource.physicalId,
      newPhysicalId: newName,
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

/**
 * Build the `DeployEngineOptions.onCurrentStateLoaded` gate that runs the
 * prefix-migration check, or `undefined` when the check is inactive
 * (`skipPrefix === false`, i.e. the user opted back in to legacy prefixing).
 *
 * Why a gate rather than a pre-lock `getState`: prefix-skipping has been the
 * default since v0.94.0, so the previous shape issued an S3 GET on EVERY
 * deploy of EVERY stack — including brand-new stacks with no state at all —
 * and the deploy engine then read the very same object again immediately
 * after taking the lock. Running as the engine's post-lock gate reuses that
 * read. The contract the check actually depends on ("surface this before any
 * provider call runs") is preserved: the engine invokes the gate immediately
 * after loading state and before parsing, diffing, or provisioning anything.
 * Reading under the lock is also strictly more authoritative — no concurrent
 * deploy can mutate the state between the check and the diff it predicts.
 *
 * Declining the prompt raises {@link DeployCancelledError}, which the deploy
 * CLI unwinds quietly (no error output, no FAILED run event) — matching the
 * plain early `return` the pre-lock version used.
 *
 * The gate is scoped to `stackName`: nested-stack children inherit the parent
 * engine's option object, and the check is deliberately top-level-only (it was
 * never applied to children).
 */
export function createPrefixMigrationGate(opts: {
  stackName: string;
  skipPrefix: boolean;
  yes?: boolean;
}): ((stackName: string, state: StackState | undefined) => Promise<void>) | undefined {
  if (!opts.skipPrefix) return undefined;
  return async (gateStackName: string, state: StackState | undefined): Promise<void> => {
    if (gateStackName !== opts.stackName) return;
    const pending = findPendingPrefixRenames(opts.stackName, state);
    if (pending.length === 0) return;
    const proceed = await promptMigrationConfirm(pending, {
      ...(opts.yes !== undefined && { yes: opts.yes }),
    });
    if (!proceed) {
      throw new DeployCancelledError();
    }
  };
}
