import { Command } from 'commander';
import { commonOptions, deprecatedRegionOption, stateOptions } from '../../options.js';
import { getLogger, reserveStdoutForPayload } from '../../../utils/logger.js';
import { refusedBaselineRemedy } from '../refused-baseline-remedy.js';
import { withErrorHandling } from '../../../utils/error-handler.js';
import { LockManager } from '../../../state/lock-manager.js';
import {
  displayStackName,
  stringifyJsonPayload,
  truncateCodePoints,
  STACK_REF_MAX_CODE_POINTS,
} from '../../../utils/display-safe.js';
import { producerRecordKey } from '../../../state/record-keys.js';
import { stripForDisplay } from '../../../utils/regexp.js';
import { buildCdkdStateStackTree, type CdkdStateStackTree } from '../export.js';
import type { LockInfo, StackState, ResourceState } from '../../../types/state.js';
import { withStackInstanceIdWithheld } from '../../../state/stack-instance-id.js';
import {
  secretSegmentsOfState,
  withSecretPhysicalIdsMaskedInState,
} from '../../../provisioning/secret-physical-id.js';
import { formatStackRefSafe, legacyRecordRefusal, resolveSingleRegion } from './refs.js';
import { type StateSetup, setupStateBackend, renderRecovery, stackRegionOption } from './setup.js';
import {
  formatAttributeValue,
  formatIdentField,
  formatDependencyList,
  formatLastModified,
  formatLockSummary,
} from './resources.js';
import {
  SKIPPED_DIGEST_PREVIEW_LEN,
  UNSERIALIZABLE,
  sortedSkippedOutputs,
  rendersSkippedBlock,
  skippedOutputsLegend,
  repairRecordForTextRender,
  repairTreeForTextRender,
  warnUnreadableTreeNodes,
} from './show-containers.js';

/**
 * `cdkd state show <stack>` command implementation
 *
 * Renders the full state record for one stack: stack-level metadata, lock
 * status, outputs, skipped outputs, and every resource (including properties).
 * The deepest / most verbose `state` subcommand — use `state list` / `state resources` for
 * lighter inspection.
 *
 * When the same stack name has state in multiple regions, requires
 * `--stack-region <region>` to disambiguate.
 *
 * - Default: human-readable multi-line format.
 * - `--json`: a `{state, lock}` object containing the raw `StackState` plus
 *   the lock record (or null). With `--show-nested`, the object additionally
 *   carries a `children` array of the same shape recursively.
 * - `--show-nested` (issue #555 A4): when the stack contains
 *   `AWS::CloudFormation::Stack` rows, recursively load every child state
 *   record (`cdkd/<parent>~<childLogicalId>/<region>/state.json`) and append
 *   its block after the parent's. With no nested children the rendered
 *   blocks are the same, though a `Skipped outputs:` explanation moves to
 *   the end of the tree.
 */
async function stateShowCommand(
  stackName: string,
  options: {
    json: boolean;
    showNested: boolean;
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
    await printStackShow(stackName, options, setup);
  } finally {
    setup.dispose();
  }
}

/**
 * The body of `stateShowCommand` against a backend the caller set up and
 * disposes, so `cdkd state browse` renders exactly what the command prints
 * without setting up a backend per view.
 */
export async function printStackShow(
  stackName: string,
  options: Parameters<typeof stateShowCommand>[1],
  setup: StateSetup
): Promise<void> {
  const logger = getLogger();
  const refs = await setup.stateBackend.listStacks();
  const ref = resolveSingleRegion(stackName, refs, options.stackRegion);
  if (!ref.region) {
    throw legacyRecordRefusal(stackName);
  }

  const [stateResult, lockInfo] = await Promise.all([
    setup.stateBackend.getState(stackName, ref.region),
    setup.lockManager.getLockInfo(stackName, ref.region),
  ]);

  if (!stateResult) {
    throw new Error(
      `No state found for stack ${formatStackRefSafe(ref)} in s3://${setup.bucket}/${setup.prefix}/. ` +
        `Run 'cdkd state list' to see available stacks.`
    );
  }

  if (options.showNested) {
    // No unreadable-bag test HERE, deliberately. An earlier cut of issue
    // go-to-k/cdkd#3172 put one at this call site, which covered the ROOT
    // record and nothing below it: `walkCdkdStateStackTree` RECURSES, so a
    // healthy root naming a nested child still walked that child's bag
    // unguarded — re-measured live at 1623 ms / 1277 MB for a planted
    // 5,000,000-character CHILD bag, in `--json` as well as the text view.
    // The predicate now lives inside the walker, at the one place every depth
    // passes through, and its comment there carries the measurements.
    const tree: CdkdStateStackTree = await buildCdkdStateStackTree(
      stackName,
      ref.region,
      setup.stateBackend,
      stateResult.state,
      // The account flags of the missing-child refusal's drop command
      // (go-to-k/cdkd#4648).
      renderRecovery(options, setup)
    );
    const treeWithLocks = await loadLocksForTree(tree, setup.lockManager, lockInfo);

    if (options.json) {
      // WARNED but not repaired. This is the one mode where an unreadable bag
      // is invisible in the payload's SHAPE: the node comes back with
      // `children: []`, which is exactly what a leaf looks like, so a consumer
      // enumerating the tree concludes it is complete when a subtree was cut.
      // The record itself is still emitted verbatim, so the evidence survives.
      warnUnreadableTreeNodes(treeWithLocks, logger, renderRecovery(options, setup));
      process.stdout.write(
        `${stringifyJsonPayload(treeToShowJson(treeWithLocks, treeSecretSegments(treeWithLocks)))}\n`
      );
      return;
    }

    repairTreeForTextRender(treeWithLocks, logger, renderRecovery(options, setup));
    const lines = renderTreeWithChildren(treeWithLocks);
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (options.json) {
    process.stdout.write(
      `${stringifyJsonPayload({ state: withStackInstanceIdWithheld(withSecretPhysicalIdsMaskedInState(stateResult.state)), lock: lockInfo })}\n`
    );
    return;
  }

  repairRecordForTextRender(
    stateResult.state,
    stackName,
    ref.region,
    logger,
    renderRecovery(options, setup)
  );
  process.stdout.write(
    `${renderStateBlock(stateResult.state, lockInfo, true, secretSegmentsOfState(stateResult.state)).join('\n')}\n`
  );
}

/**
 * Render one stack's state record as a human-readable multi-line block —
 * the shared body used by both the single-stack default output and each
 * nested child rendered under `--show-nested`.
 *
 * Every caller must have run {@link repairRecordForTextRender} over the
 * record first (`repairTreeForTextRender` does it per node for the tree): the
 * resource walk below is what fabricates rows from a non-object bag, and the
 * `state.ts names renderStateBlock in CODE exactly 1 + 3 times` case in
 * `tests/unit/cli/state-record-shape.test.ts` refuses a fourth call site so
 * that choice cannot be made silently.
 */
function renderStateBlock(
  recordState: StackState,
  lockInfo: LockInfo | null,
  // No default: both tree call sites pass `false` and the single-stack one
  // passes `true`, so a default would only hide which mode a call is in.
  withLegend: boolean,
  /**
   * go-to-k/cdkd#5868: the keys to mask (`secretSegmentsOfState`, or a
   * nested tree's union). An id that IS a bearer credential, and every value
   * it was copied to, renders as `****last4` (stdout reaches no log masker);
   * the record keeps it whole.
   */
  secretSegments: readonly string[]
): string[] {
  const state = withSecretPhysicalIdsMaskedInState(recordState, secretSegments);
  const lines: string[] = [];

  // Every RECORD-derived string interpolated into a row below is stripped —
  // state here, and lock.json through `formatLockSummary`. The rule is flat on
  // purpose: `renderStateBlock` returns lines that the caller joins with `\n`,
  // and `stripForDisplay` removes U+0000-U+001F — newline included — and
  // replaces U+2028 / U+2029, which a log viewer breaks a line on, so any
  // unstripped field can forge rows, not merely colour them. A per-field
  // argument about which ones CloudFormation constrains is what left the
  // resource logical id raw until issue #2772; the constraint is not enforced
  // on a record read as an unchecked cast.
  //
  // Which guard a value takes follows from whether its runtime type is
  // GUARANTEED, not from where it came from. A record FIELD's declared type is
  // an unchecked cast, so the fields below take `formatAttributeValue`: that
  // strips identically for a string and also survives a wrong type, where the
  // bare strip throws and empties the whole render. `stripForDisplay` is kept
  // where the value is a string by construction — an `Object.entries` key.
  // `dependencies` and `lastModified` take their own guards, each for a second
  // reason named at its helper.
  //
  // `Version` takes none, and is the one field here whose type IS enforced:
  // `S3StateBackend.parseStateBody` refuses any value but a readable schema
  // number or `undefined` before a renderer sees the record, so a hand-edited
  // one fails THERE rather than reaching this row. A guard here would be
  // unreachable by that route and could only be pinned by a test that mocks the
  // read away. What that failure SAYS goes through `displaySafe`, so a value
  // that throws on coercion, or carries a control character, still yields the
  // schema message on one line (go-to-k/cdkd#2947).
  //
  // The IDENTIFIER rows go further, through `formatIdentField`: a stack name,
  // a region and a logical id have a known charset, and the `Parent:` row
  // prints cdkd's own ` (region)` and `, logical id:` annotations beside them,
  // which a value keeping its interior spaces could carry itself
  // (go-to-k/cdkd#3179).
  lines.push(`Stack: ${formatIdentField(state.stackName, STACK_REF_MAX_CODE_POINTS)}`);
  if (state.region) lines.push(`  Region: ${formatIdentField(state.region)}`);
  lines.push(`  Version: ${state.version}`);
  lines.push(`  Last Modified: ${formatLastModified(state.lastModified)}`);
  lines.push(`  Lock: ${formatLockSummary(lockInfo)}`);
  if (state.parentStack !== undefined) {
    const parentRegionStr = state.parentRegion ? ` (${formatIdentField(state.parentRegion)})` : '';
    const logicalIdStr =
      state.parentLogicalId !== undefined
        ? `, logical id: ${formatIdentField(state.parentLogicalId)}`
        : '';
    lines.push(
      `  Parent: ${formatIdentField(state.parentStack, STACK_REF_MAX_CODE_POINTS)}${parentRegionStr}${logicalIdStr}`
    );
  }

  // The `?? {}` here — and at the four other container walks, two above in
  // the `skippedOutputs` helpers and two below in the resource loop — covers the
  // ABSENT case alone (`undefined` / `null`), which is what it has always done.
  // A non-object `outputs` is NOT guarded here: it is emptied at the render
  // entry by `repairRenderedContainers`, because a guard repeated at four
  // walks is four decisions where one belongs (issue go-to-k/cdkd#3187).
  const outputEntries = Object.entries(state.outputs ?? {});
  if (outputEntries.length > 0) {
    lines.push('');
    lines.push('Outputs:');
    for (const [k, v] of outputEntries) {
      // The KEY is stripped here; the VALUE by `formatAttributeValue`
      // (issue #1948). An Outputs bag KEY can be an `Export.Name` that cdkd
      // RESOLVED from an `Fn::Sub` / parameter / SSM value, so it passed no
      // CFn validator and may carry ANSI escapes or bidi overrides that
      // rewrite the surrounding terminal output. The diff's rows, the only
      // other place a stored Outputs bag is rendered, go further: their names
      // render through `secretSafeKeyDisplay`'s verdict (#4015).
      lines.push(`  ${stripForDisplay(k)}: ${formatAttributeValue(v)}`);
    }
  }

  // The field #2740 added, rendered because its effect on `cdkd diff` is
  // deliberately SILENT — a key the diff suppresses gets no row and no
  // warning — so this view is where a user looks for why an Output has no
  // diff row. Suppression needs the record to bind AND the key to be absent
  // from the stored outputs; a binding digest alone does not suppress a key
  // state already holds. Absent field renders nothing, which means only that
  // no skipped set was recorded: pre-#2740 records never carried one, and
  // several writers DROP it (see the field's doc in `types/state.ts`).
  if (rendersSkippedBlock(state)) {
    lines.push('');
    lines.push('Skipped outputs:');
    for (const [k, digest] of sortedSkippedOutputs(state)) {
      // The KEY is stripped like every other key this block prints. The
      // `Export.Name` argument above does not reach these: they are template
      // `Outputs` keys, so this is defence against a template cdkd never
      // validated rather than against a value it resolved.
      //
      // The DIGEST goes through `formatAttributeValue`, like the Outputs value
      // above. The argument is stronger than for the key: a key is a string
      // whatever an operator put there, while a VALUE can be any JSON type, and
      // state is read as an unchecked cast that validates neither. A String
      // method called on it directly would throw on a hand-edited number or
      // `null` and take the WHOLE render with it: `renderStateBlock` builds
      // every line before anything is written, so one bad digest costs the
      // stack header and every resource, and under `--show-nested` the parent
      // and every sibling.
      //
      // `skippedOutputsEqual` normalises a hand-edited `null` RECORD on this
      // same field — a different level from a null DIGEST inside it, but the
      // same premise: an operator edits this field by hand.
      //
      // Stripped BEFORE truncating. The order does NOT decide terminal
      // safety — stripping after slicing removes the ESC just as well. What it
      // decides is how many PRINTABLE characters the reader gets: strip-first
      // spends none of the 12 on a control character, slice-first spends one
      // slot per control character inside the window on something that then
      // vanishes. For a digest with one leading ESC and printable text past
      // the window that is 12 against 11. Neither recovers a sequence's
      // printable tail, so `ESC [ 2 J` still costs 3 of the 12.
      //
      // Truncated: a prefix DIFFERENCE tells two records apart at a glance,
      // which is this view's job. A prefix MATCH proves nothing, so exact
      // comparison belongs to `--json`, which carries the digest whole.
      // Marked when it actually happened, so a value that is EXACTLY the
      // window's length is not read as one that was cut, and a cut value is
      // not read as whole.
      //
      // The formatter's own sentinel is exempt: `(unserializable)` is longer
      // than the window, and cut to `(unserializa…` it reads as a hash prefix
      // rather than as the guard having fired.
      const fullDigest = formatAttributeValue(digest);
      // Cut by CODE POINT, not by UTF-16 unit: a hand-edited digest whose 12th
      // and 13th units are a surrogate pair left a lone high surrogate at the
      // end of the preview (issue #2947). `truncateCodePoints` owns that rule,
      // so the next truncation site inherits it.
      const cut = truncateCodePoints(fullDigest, SKIPPED_DIGEST_PREVIEW_LEN);
      const shownDigest =
        cut.truncated && fullDigest !== UNSERIALIZABLE ? `${cut.text}…` : fullDigest;
      lines.push(`  ${stripForDisplay(k)}: ${shownDigest}`);
    }
    if (withLegend) lines.push(...skippedOutputsLegend());
  }

  // Possibly-`null` ENTRIES, for the reason `state resources` spells out (issue
  // #2947): the loop below dereferenced a hand-edited `{"R": null}` and took the
  // whole render with it.
  //
  // No `?? {}` on the BAG, for the reason the same command's load site gives:
  // every caller has repaired it, so a fallback that can no longer fire only
  // makes a later reader think the bag is guarded here instead of at the entry
  // to the render. The two sites now state one rule rather than two.
  const resourceEntries = (Object.entries(state.resources) as Array<[string, ResourceState | null]>)
    .map(([logicalId, entry]): [string, ResourceState] => [
      logicalId,
      (entry ?? {}) as ResourceState,
    ])
    .sort(([a], [b]) => a.localeCompare(b));
  lines.push('');
  lines.push(`Resources (${resourceEntries.length}):`);
  for (const [logicalId, resource] of resourceEntries) {
    lines.push('');
    // Stripped like every other key this block prints. CloudFormation
    // constrains a logical id to [A-Za-z0-9], but nothing enforces that
    // constraint HERE — state is read as an unchecked cast, so a hand-edited
    // record can carry anything. A case in the `state show` suite spells a
    // logical id `Skipped outputs:` for a different reason and demonstrates
    // exactly that.
    lines.push(stripForDisplay(logicalId));
    lines.push(`  Type: ${formatAttributeValue(resource.resourceType)}`);
    // The formatter makes a corrupt id read like an ordinary one: a `null`
    // renders as the literal `null`, which the string `"null"` also does. That
    // ambiguity is the trade already accepted for every Outputs, attribute and
    // property value here, and `--json` is where a reader settles it.
    lines.push(`  PhysicalID: ${formatAttributeValue(resource.physicalId)}`);
    // v7+ (#614): show the provisioning layer so users can see which
    // resources took the Cloud Control auto-route. Absent on pre-v7
    // state — print "(sdk, legacy default)" so the absence is explicit.
    const provisionedBy = resource.provisionedBy ?? '(sdk, legacy default)';
    lines.push(`  ProvisionedBy: ${formatAttributeValue(provisionedBy)}`);
    // v10+ (issue #2944): printed ONLY when set, unlike `ProvisionedBy` above,
    // whose absence is itself a fact worth naming. Here absence is the norm,
    // and a `(not refused)` row on every resource of every stack would bury the
    // one that matters. This is the row a user needs when `cdkd state
    // refresh-observed` starts declining a resource — `--json` carries the
    // field for free, but the human view is where they will look first.
    if (resource.observedBaselineRefused === true) {
      // The remedy depends on WHY it was refused (issue #3465): a deploy does
      // not clear an unverifiable-parameter refusal.
      const remedy = refusedBaselineRemedy(resource);
      lines.push(
        `  ObservedBaseline: REFUSED by 'cdkd import' — no baseline will be captured` +
          (remedy === undefined
            ? ` (deploy a change to this resource to restore one)`
            : `. ${remedy}`)
      );
    }
    lines.push(`  Dependencies: ${formatDependencyList(resource.dependencies)}`);

    // Absent-only fallback, like the Outputs walk above: a non-object
    // `attributes` or `properties` was emptied at the render entry.
    const attrEntries = Object.entries(resource.attributes ?? {});
    if (attrEntries.length === 0) {
      lines.push('  Attributes: (none)');
    } else {
      lines.push('  Attributes:');
      for (const [k, v] of attrEntries) {
        // The KEY is stripped for the same reason the Outputs key is: a
        // provider-returned attribute name and a template-authored property
        // name both reach here without passing a CloudFormation validator.
        lines.push(`    ${stripForDisplay(k)}: ${formatAttributeValue(v)}`);
      }
    }

    const propEntries = Object.entries(resource.properties ?? {});
    if (propEntries.length === 0) {
      lines.push('  Properties: (none)');
    } else {
      lines.push('  Properties:');
      for (const [k, v] of propEntries) {
        lines.push(`    ${stripForDisplay(k)}: ${formatAttributeValue(v)}`);
      }
    }
  }
  return lines;
}

/**
 * One node of the nested-stack tree augmented with its lock record — built
 * by {@link loadLocksForTree} so the renderers see `state + lock` in one
 * shape regardless of depth.
 */
export interface CdkdStateStackTreeWithLock {
  stackName: string;
  region: string;
  state: StackState;
  lock: LockInfo | null;
  children: CdkdStateStackTreeWithLock[];
}

/**
 * Walk a {@link CdkdStateStackTree} and resolve every non-root node's lock
 * record in parallel (one `getLockInfo` per child). The root's lock was
 * already fetched alongside its state so it's threaded through as an
 * argument rather than re-fetched.
 *
 * A transient lock-read failure on one child degrades to `null` so a
 * missing-lock-key race on one child does not kill the whole
 * `--show-nested` render.
 */
async function loadLocksForTree(
  tree: CdkdStateStackTree,
  lockManager: LockManager,
  rootLock: LockInfo | null
): Promise<CdkdStateStackTreeWithLock> {
  // {@link producerRecordKey}, not a separator (go-to-k/cdkd#3323). Same
  // `(stackName, region)` record identity as `listStacks`' dedupe, reached the
  // same way — both halves are S3 key segments.
  const nodeKey = (node: { stackName: string; region: string }): string =>
    producerRecordKey(node.stackName, node.region);
  const rootKey = nodeKey(tree);
  const flat: CdkdStateStackTree[] = [];
  const collect = (node: CdkdStateStackTree): void => {
    flat.push(node);
    for (const child of node.nestedChildren.values()) collect(child);
  };
  collect(tree);

  const lockByKey = new Map<string, LockInfo | null>();
  lockByKey.set(rootKey, rootLock);
  await Promise.all(
    flat.map(async (node) => {
      const key = nodeKey(node);
      if (key === rootKey) return;
      try {
        lockByKey.set(key, await lockManager.getLockInfo(node.stackName, node.region));
      } catch {
        lockByKey.set(key, null);
      }
    })
  );

  const decorate = (node: CdkdStateStackTree): CdkdStateStackTreeWithLock => ({
    stackName: node.stackName,
    region: node.region,
    state: node.state,
    lock: lockByKey.get(nodeKey(node)) ?? null,
    children: [...node.nestedChildren.values()].map(decorate),
  });
  return decorate(tree);
}

/**
 * Whether any node in this tree owes a `Skipped outputs:` block, and so
 * whether the tree render owes the legend once at its end. Asked through
 * {@link rendersSkippedBlock}, the same predicate the block's own guard uses.
 */
function treeOwesSkippedLegend(node: CdkdStateStackTreeWithLock): boolean {
  return rendersSkippedBlock(node.state) || node.children.some(treeOwesSkippedLegend);
}

/**
 * Render the parent's block followed by every descendant in DFS order,
 * each separated by a blank line and prefixed with a `Nested stack: ...`
 * header so the user can scan the tree top-down in one screen.
 *
 * Children are rendered flat (column 0) rather than indented — the
 * existing single-stack output is already verbose with 2-space indent,
 * and stacking another layer makes it hard to read.
 */
function renderTreeWithChildren(root: CdkdStateStackTreeWithLock): string[] {
  const lines: string[] = [];
  const segments = treeSecretSegments(root);
  lines.push(...renderStateBlock(root.state, root.lock, false, segments));
  appendDescendants(root.children, lines, segments);
  // Once for the whole tree, and only when some node rendered the block — the
  // alternative repeats it per child. Both this and the block's own guard call
  // `rendersSkippedBlock`, which is the only copy of that condition. Scanning
  // the rendered lines for the header instead looks tempting and is wrong: a
  // resource logical id is printed as its own line, and stripping it does not
  // change a hand-edited `Skipped outputs:`, so such a record would emit a
  // legend having skipped nothing.
  if (treeOwesSkippedLegend(root)) lines.push(...skippedOutputsLegend());
  return lines;
}

function appendDescendants(
  children: readonly CdkdStateStackTreeWithLock[],
  out: string[],
  segments: readonly string[]
): void {
  for (const child of children) {
    out.push('');
    // Not read from a record: `walkCdkdStateStackTree` builds it as
    // `` `${parent}~${logicalId}` `` from a resources KEY, so it is always a
    // string -- and the logical id half is attacker-chosen, so it takes
    // `displayStackName`'s boundary and cap like every other stack name this
    // view prints (go-to-k/cdkd#3179). A plain `Parent~Child` is unchanged.
    out.push(`Nested stack: ${displayStackName(child.stackName)}`);
    out.push(...renderStateBlock(child.state, child.lock, false, segments));
    appendDescendants(child.children, out, segments);
  }
}

/**
 * JSON-friendly shape for `state show --show-nested --json`: the same
 * `{state, lock}` object the non-nested mode emits, plus a `children`
 * array of the same shape recursively. `children` is always present
 * (empty array on leaves) so consumers see a stable key set.
 */
interface StateShowJson {
  state: StackState;
  lock: LockInfo | null;
  children: StateShowJson[];
}

function treeToShowJson(
  node: CdkdStateStackTreeWithLock,
  segments: readonly string[]
): StateShowJson {
  return {
    // go-to-k/cdkd#5064: never the id the stack's names derive from.
    state: withStackInstanceIdWithheld(withSecretPhysicalIdsMaskedInState(node.state, segments)),
    lock: node.lock,
    children: node.children.map((child) => treeToShowJson(child, segments)),
  };
}

/**
 * Every key a nested tree's records hold (go-to-k/cdkd#5868), masked in every
 * node: a parent passes values to its children, so a child's parameter can
 * hold a key only the parent's record names.
 */
function treeSecretSegments(node: CdkdStateStackTreeWithLock): string[] {
  return [
    ...secretSegmentsOfState(node.state),
    ...node.children.flatMap((child) => treeSecretSegments(child)),
  ];
}

/**
 * Create the `state show` subcommand.
 */
export function createStateShowCommand(): Command {
  const cmd = new Command('show')
    .description('Show the full cdkd state record for a stack (metadata, outputs, resources)')
    .argument('<stack>', 'Stack name (physical CloudFormation name)')
    .option('--json', 'Output the raw state and lock as JSON', false)
    .option(
      '--show-nested',
      'Recursively show every nested-stack child under the target stack',
      false
    )
    .addOption(stackRegionOption())
    .action(withErrorHandling(stateShowCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for state subcommands (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime via
  // warnIfDeprecatedRegion (called from setupStateBackend).
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
