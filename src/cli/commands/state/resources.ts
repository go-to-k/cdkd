import { Command } from 'commander';
import { commonOptions, deprecatedRegionOption, stateOptions } from '../../options.js';
import { getLogger, reserveStdoutForPayload } from '../../../utils/logger.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import { withErrorHandling } from '../../../utils/error-handler.js';
import { displayIdent, stringifyJsonPayload } from '../../../utils/display-safe.js';
import {
  formatLockExpiry,
  formatLockOperation,
  formatLockOwner,
} from '../../../state/lock-contention-message.js';
import {
  malformedResourcesWarning,
  repairMalformedResourcesForReadOnly,
} from '../../../state/malformed-resources-bag.js';
import { stripForDisplay } from '../../../utils/regexp.js';
import { withSecretPhysicalIdsMaskedInState } from '../../../provisioning/secret-physical-id.js';
import type { LockInfo, ResourceState } from '../../../types/state.js';
import {
  type ResourceDetail,
  formatStackRefSafe,
  legacyRecordRefusal,
  resolveSingleRegion,
} from './refs.js';
import { type StateSetup, setupStateBackend, renderRecovery, stackRegionOption } from './setup.js';
import {
  UNSERIALIZABLE,
  RESOURCES_RENDERED_CONTAINERS,
  repairRenderedContainers,
} from './show-containers.js';

/**
 * `cdkd state resources <stack>` command implementation
 *
 * Lists the resources recorded in a single stack's state file.
 *
 * - Default: aligned three-column output (LogicalID, Type, PhysicalID)
 *   sorted alphabetically by logical id.
 * - `--long`/`-l`: per-resource block including dependencies and attributes.
 * - `--json`: emit a JSON array of full resource detail objects.
 *
 * When the same stack name has state in multiple regions, requires
 * `--stack-region <region>` to disambiguate. The error message lists
 * candidate regions so the next attempt is one keystroke away.
 *
 * Properties are intentionally omitted from all output modes — `state show`
 * is the right command when properties are needed.
 */
async function stateResourcesCommand(
  stackName: string,
  options: {
    long: boolean;
    json: boolean;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    stackRegion?: string;
    profile?: string;
    roleArn?: string;
    verbose: boolean;
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  // Issue #2280: claim stdout for the payload BEFORE anything can print on
  // it. `setupStateBackend` runs `applyRoleArnIfSet`, whose `Assumed role
  // ...` INFO line lives in `src/utils/role-arn.ts` — a module this file
  // cannot route on its own, which is why the reservation is module-level.
  if (options.json) {
    reserveStdoutForPayload();
  }

  const setup = await setupStateBackend(options);
  try {
    await printStackResources(stackName, options, setup);
  } finally {
    setup.dispose();
  }
}

/**
 * The body of `stateResourcesCommand` against a backend the caller set up and
 * disposes, so `cdkd state browse` renders exactly what the command prints
 * without setting up a backend per view.
 */
export async function printStackResources(
  stackName: string,
  options: Parameters<typeof stateResourcesCommand>[1],
  setup: StateSetup
): Promise<void> {
  const logger = getLogger();
  const refs = await setup.stateBackend.listStacks();
  const ref = resolveSingleRegion(stackName, refs, options.stackRegion);
  if (!ref.region) {
    throw legacyRecordRefusal(stackName);
  }
  const stateResult = await setup.stateBackend.getState(stackName, ref.region);
  if (!stateResult) {
    throw new Error(
      `No state found for stack ${formatStackRefSafe(ref)} in s3://${setup.bucket}/${setup.prefix}/. ` +
        `Run ${proseQuoted(cdkdRemedy('cdkd state list'))} to see available stacks.`
    );
  }

  // `resources` is an unchecked cast, so a hand-edited or truncated record can
  // hold a string, a list, a number or a boolean there — and `Object.entries`
  // accepts all of them. `"abcdef"` yields six `[index, character]` pairs,
  // which this command rendered as six resources that do not exist. BOTH
  // output modes fabricated them: `details` is built above the `--json`
  // branch, so the array that mode emits is the same one the text views
  // render from.
  //
  // Repaired at the LOAD, never at the loop:
  // `src/state/malformed-resources-bag.ts` owns that rule and the measurement
  // behind it. This command cannot write state, so it repairs and WARNS
  // rather than refusing — refusing the diagnostic that shows what is wrong
  // with a record is the opposite of useful, and `cdkd state list --long`
  // sends operators here for exactly that reason.
  if (repairMalformedResourcesForReadOnly(stateResult.state)) {
    logger.warn(malformedResourcesWarning(stackName, ref.region, renderRecovery(options, setup)));
  }
  // And the same for the one VALUE container this command renders — each
  // resource's `attributes` (issue go-to-k/cdkd#3187). `properties`,
  // `outputs` and `skippedOutputs` are deliberately out of scope here: this
  // command renders none of them, and the set it passes says so
  // (`RESOURCES_RENDERED_CONTAINERS`).
  //
  // Gated on the two modes that CARRY attributes, and by the same rule that
  // excludes the other three containers rather than by a second one. The
  // default three-column listing prints logicalId / type / physicalId and
  // nothing else, so an `attributes` it never walks can neither fabricate a
  // row nor be described by a warning whose text promises "this view shows no
  // rows there" — the warning would name a block that does not exist in the
  // output in front of the reader. `cdkd state show` is where that record's
  // attributes are visible, and this command's own `--long` is one flag away.
  //
  // `--json` is INSIDE the gate, not outside it, which is where this departs
  // from `cdkd state show`: `details` is a PROJECTION rather than the stored
  // record — it already substitutes `[]` for an absent `dependencies` and
  // `{}` for an absent `attributes` — so leaving it alone would hand a script
  // a non-object where the shape it consumes says otherwise, with nothing
  // said about it. `cdkd state show --json` remains the mode that answers
  // "what does the record hold", and this warning's text sends the reader
  // there.
  if (options.long || options.json) {
    repairRenderedContainers(
      stateResult.state,
      RESOURCES_RENDERED_CONTAINERS,
      stackName,
      ref.region,
      logger,
      renderRecovery(options, setup)
    );
  }
  // No `?? {}`: the repair above leaves a plain object behind whatever the
  // record held, and a fallback that can no longer fire only makes a later
  // reader think the bag is guarded one line down instead of at the load.
  // go-to-k/cdkd#5868: a display copy, every key the state's records hold
  // (resources, orphans, superseded copies) as `****last4`, wherever a value
  // copied it (stdout reaches no log masker).
  const resources = withSecretPhysicalIdsMaskedInState(stateResult.state).resources;
  const details: ResourceDetail[] = (
    Object.entries(resources) as Array<[string, ResourceState | null]>
  )
    .map(([logicalId, entry]) => {
      // Possibly `null`: `resources` is an unchecked cast, and a hand-edited
      // `{"R": null}` threw on `.resourceType` here in all three modes —
      // `--json` included, since the details are built before the JSON branch
      // (issue #2947). A null entry now renders the way the other malformed
      // shapes already did: a number or a string there never threw, its
      // missing fields rendering as `undefined` or their defaults.
      const resource = (entry ?? {}) as ResourceState;
      return {
        logicalId,
        resourceType: resource.resourceType,
        physicalId: resource.physicalId,
        dependencies: resource.dependencies ?? [],
        // Absent-only fallback: a non-object `attributes` was emptied at the
        // load above, so what reaches `--long`'s `Object.entries` and the
        // `--json` payload is a map either way (issue go-to-k/cdkd#3187).
        attributes: resource.attributes ?? {},
      };
    })
    .sort((a, b) => a.logicalId.localeCompare(b.logicalId));

  if (options.json) {
    process.stdout.write(`${stringifyJsonPayload(details)}\n`);
    return;
  }

  if (details.length === 0) {
    // Nothing to print; leaving output empty matches `state list` semantics
    // for an empty bucket.
    return;
  }

  if (options.long) {
    const lines: string[] = [];
    for (const detail of details) {
      // Same rule and the same split as `renderStateBlock`: a KEY takes
      // `stripForDisplay`, a record FIELD takes `formatAttributeValue`, which
      // renders a string identically and survives a hand-edited non-string. These lines are
      // joined with `\n` too, so an unstripped field forges rows here as well.
      lines.push(stripForDisplay(detail.logicalId));
      lines.push(`  Type: ${formatAttributeValue(detail.resourceType)}`);
      lines.push(`  PhysicalID: ${formatAttributeValue(detail.physicalId)}`);
      lines.push(`  Dependencies: ${formatDependencyList(detail.dependencies)}`);
      const attrEntries = Object.entries(detail.attributes);
      if (attrEntries.length === 0) {
        lines.push('  Attributes: (none)');
      } else {
        lines.push('  Attributes:');
        for (const [k, v] of attrEntries) {
          lines.push(`    ${stripForDisplay(k)}: ${formatAttributeValue(v)}`);
        }
      }
      lines.push('');
    }
    // Drop trailing blank line for tidy output.
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  // Default: aligned three-column output, under the same rule as `--long`
  // above. Rendering happens BEFORE the widths are measured so that a width
  // describes the string actually printed. Measuring the raw values instead
  // does NOT misalign the columns — every row pads to the same width, so they
  // still line up — it pads them all wider, by
  // `max(raw lengths) - max(stripped lengths)`, with a gap that has nothing
  // in it. `resourceType` and `physicalId` take the field guard here rather
  // than raw interpolation, so a hand-edited non-string cannot make `.length`
  // / `.padEnd` throw and lose the listing; `logicalId` is a map key, so
  // `stripForDisplay` is right for it.
  const rows = details.map((d) => ({
    logicalId: stripForDisplay(d.logicalId),
    resourceType: formatAttributeValue(d.resourceType),
    physicalId: formatAttributeValue(d.physicalId),
  }));
  const idWidth = Math.max(...rows.map((r) => r.logicalId.length));
  const typeWidth = Math.max(...rows.map((r) => r.resourceType.length));
  for (const row of rows) {
    process.stdout.write(
      `${row.logicalId.padEnd(idWidth)}  ${row.resourceType.padEnd(typeWidth)}  ${row.physicalId}\n`
    );
  }
}

/**
 * Render one record-derived value into a human row.
 *
 * Named for its first caller and used well beyond an attribute now: a state or
 * lock record is read as an unchecked cast, so a field declared `string` can
 * hold anything, and `stripForDisplay` throws on it and empties the whole
 * render. This survives that, and for an actual string it is byte-identical to
 * `stripForDisplay` — which is why it is the default choice for a record FIELD,
 * and `stripForDisplay` is called directly only where the value is a string by
 * construction.
 *
 * Scalar values render as-is; objects/arrays are JSON-encoded inline so a
 * resource block stays compact even when an attribute is structured.
 *
 * Control characters are stripped HERE rather than at each call site (issue
 * #1948 review), because every caller has the same provenance problem and the
 * same answer: an Outputs value, a resource PROPERTY and a provider-returned
 * ATTRIBUTE are all values cdkd resolved or read back, none of them passed a
 * CloudFormation validator, and all three land in the same terminal. Doing it
 * once means a future caller cannot forget — the half-applied version of this
 * guard is what the review caught.
 *
 * The FULL class (C0 included), unlike `diff-recursive`'s
 * `stripDisplayOnlyChars`: that narrower guard exists to protect a
 * PRETTY-PRINTED payload's structural newlines, and this function never
 * pretty-prints — `JSON.stringify` is called without an indent, so a newline
 * here is content injected by the value, not layout.
 *
 * Only the human path routes through this, which is the same split
 * `renderOutputChangeLines` makes. `--json` is the OTHER side of it rather than
 * a byte-faithful echo: `state show --json` reserializes the parsed record and
 * the lock it prints was sanitised upstream, and `state resources --json` emits
 * a constructed summary with defaults filled in. What `--json` does not do is
 * pass a value through THIS function.
 */
export function formatAttributeValue(value: unknown): string {
  if (value === null) return 'null';
  // `undefined` BEFORE the JSON branch: `JSON.stringify(undefined)` returns
  // `undefined`, not a string, so the strip below would throw on it. This arm is
  // DEFENSIVE like the two below: JSON cannot encode `undefined`, and every
  // OPTIONAL field a record may omit is either guarded by a conditional or given
  // a default before it reaches here, so arriving through a parsed record takes a
  // missing REQUIRED field. It is kept for the same reason — this function is the
  // guard every row depends on, and `'undefined'` is a better row than a throw.
  if (value === undefined) return 'undefined';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return stripForDisplay(String(value));
  }
  // `JSON.stringify` returns `undefined` — not a string — for a symbol or a
  // function value, so stripping its result directly would throw. No record read
  // from S3 can hold either (JSON has neither), so THAT half is unreachable
  // through both commands, and is kept because this function is the shared guard
  // every row depends on: a total function is worth more here than one fewer
  // branch, and naming an odd value beats throwing on it.
  // The THROWING half is NOT unreachable, which is why it is a `try` and not a
  // second `=== undefined` test. A BigInt and a circular reference cannot survive
  // S3, but NESTING DEPTH can: `JSON.stringify` recurses and exhausts the stack
  // with a RangeError, while `JSON.parse` does not recurse and handles depths far
  // past that (measured on Node 24: 8_000, 100_000 and 1_000_000 nested arrays
  // all parse, and all three refuse to stringify). So stored bytes really can
  // reach here, and a case in the `state show` suite builds such a value through
  // `JSON.parse` rather than hand-constructing an unstorable one.
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return json === undefined ? UNSERIALIZABLE : stripForDisplay(json);
}

/**
 * A record IDENTIFIER field (a stack name, a region, a logical id) for a
 * `state show` row: `displayIdent`'s boundary when it is a string, so a value
 * cannot pass for cdkd's own annotation beside it, and
 * {@link formatAttributeValue} for any other runtime type -- the field's
 * declared type is an unchecked cast. A non-string renders as it always did: an
 * object or array as its JSON, a number or boolean bare, neither able to spoof
 * an annotation.
 */
export function formatIdentField(value: unknown, maxCodePoints?: number): string {
  if (typeof value !== 'string') return formatAttributeValue(value);
  return displayIdent(value, maxCodePoints === undefined ? undefined : { maxCodePoints });
}

/**
 * Render a whole `Dependencies` row from a list that is an unchecked cast.
 *
 * It owns the `(none)` case as well as the values, so that no caller touches
 * `.length` on a value whose type it cannot trust — reading `.length` is itself
 * a throw site, and `"A".length > 0` would pass an emptiness test and then
 * throw inside `join`, which is a method of an ARRAY. So the test is
 * array-ness. Elements are rendered ONE AT A TIME through the field guard
 * rather than joined by it: an element that throws on STRING COERCION
 * (`{"toString": null}` is valid JSON, and `JSON.stringify` handles it fine)
 * throws INSIDE `join`, where no guard wrapping the result can catch it.
 *
 * ABSENT and `null` part company here, deliberately. An absent field is a
 * record saying nothing, which `(none)` states correctly; a `null` is a record
 * saying `null`, and printing `(none)` over it would claim something the record
 * does not. JSON can express `null` here and a hand-edited record can carry it,
 * so the difference is worth the surprise of seeing `Dependencies: null`.
 */
export function formatDependencyList(deps: unknown): string {
  if (Array.isArray(deps)) {
    return deps.length > 0 ? deps.map((dep) => formatAttributeValue(dep)).join(', ') : '(none)';
  }
  return deps === undefined ? '(none)' : formatAttributeValue(deps);
}

/**
 * Render `Last Modified` from a record whose `lastModified` is an unchecked cast.
 *
 * `new Date(x).toISOString()` throws a RangeError on a value it cannot date —
 * an out-of-range number, most non-numeric strings — and that empties the whole
 * render, the failure `formatAttributeValue` exists to stop everywhere else in
 * this block. `new Date` ITSELF throws a TypeError on an object whose
 * `toString` is unusable (`{"toString": null}` is valid JSON), which is why the
 * construction is inside the `try` and not only the formatting.
 *
 * Only the throw is guarded: the value still reaches `new Date` as-is, so every
 * input the previous line already dated renders the same ISO string — an ISO or
 * `YYYY-MM-DD` string, `null` and a boolean included. Anything else falls
 * through to the guard the other fields take.
 */
export function formatLastModified(value: unknown): string {
  try {
    // No `Number.isNaN(getTime())` check: an Invalid Date's `toISOString` throws
    // into this same catch and reaches this same fallback, so the check would be
    // a branch no test could tell from its absence.
    return new Date(value as string | number).toISOString();
  } catch {
    return formatAttributeValue(value);
  }
}

/**
 * Render lock metadata for the `state show` block.
 *
 * Control characters are handled upstream: `LockManager.getLockRecord` passes
 * `owner` and `operation` through `displaySafe`, which coerces and replaces the
 * whole control class with spaces, and absorbs a value whose coercion THROWS
 * (go-to-k/cdkd#2947). That keeps the spaces, though, so an owner reading
 * `x (operation: deploy), expired 3h ago` would make a live lock look expired:
 * both go through `formatLockOwner` / `formatLockOperation` (go-to-k/cdkd#4109).
 *
 * `expiresAt` is declared a number and is not guaranteed to be one, but it
 * reaches the row only through `formatLockExpiry`, which tests the raw value
 * with `Number.isFinite` and renders a fixed phrase or a duration, so no
 * character the record carries can survive into the output either. A
 * non-finite value — absent, `{}`, `"soon"`, or the `NaN` that `getLockRecord`
 * substitutes for a coercion that throws (go-to-k/cdkd#2947) — reads as an
 * unknown deadline rather than `expired NaNmNaNs ago` (issue #3083); the
 * helper is shared with the contention refusal and `LockManager` (issue
 * #3085) so the row cannot drift from them.
 */
export function formatLockSummary(lockInfo: LockInfo | null): string {
  if (!lockInfo) return 'unlocked';
  // Described unless plain: an owner carrying `(operation: deploy), expired 3h
  // ago` would otherwise make a live lock read as expired (go-to-k/cdkd#4109).
  const opStr = lockInfo.operation
    ? ` (operation: ${formatLockOperation(lockInfo.operation)})`
    : '';
  return `locked by ${formatLockOwner(lockInfo.owner)}${opStr}, ${formatLockExpiry(lockInfo.expiresAt)}`;
}

/**
 * Create the `state resources` subcommand.
 */
export function createStateResourcesCommand(): Command {
  const cmd = new Command('resources')
    .description("List resources recorded in a stack's state")
    .argument('<stack>', 'Stack name (physical CloudFormation name)')
    .option('-l, --long', 'Include dependencies and attributes per resource', false)
    .option('--json', 'Output as JSON', false)
    .addOption(stackRegionOption())
    .action(withErrorHandling(stateResourcesCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for state subcommands (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime via
  // warnIfDeprecatedRegion (called from setupStateBackend).
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
