import { getLogger } from '../../../utils/logger.js';
import { type LockRecoveryContext } from '../../../state/lock-contention-message.js';
import {
  hasReadableResources,
  isReadableBag,
  malformedRenderedContainersWarning,
  malformedResourcesWarning,
  repairMalformedResourcesForReadOnly,
  type RenderedStateContainer,
} from '../../../state/malformed-resources-bag.js';
import type { StackState } from '../../../types/state.js';
import type { CdkdStateStackTreeWithLock } from './show.js';

/**
 * How much of a `skippedOutputs` digest the text view shows. A prefix
 * DIFFERENCE proves two records differ, which is what a reader wants at a
 * glance; a prefix MATCH proves nothing, so an exact comparison belongs to
 * `--json`, which carries the digest whole.
 */
export const SKIPPED_DIGEST_PREVIEW_LEN = 12;

/** What `formatAttributeValue` prints for a value `JSON.stringify` refuses. */
export const UNSERIALIZABLE = '(unserializable)';

/**
 * The `skippedOutputs` rows a state record owes, sorted by key.
 *
 * The `?? {}` covers an ABSENT field — every pre-#2740 record, plus the writers
 * that drop it. A non-object one is emptied at the render entry instead
 * (`repairRenderedContainers`, issue go-to-k/cdkd#3187), so this walk and
 * {@link rendersSkippedBlock}'s cannot disagree about how many rows exist.
 */
export function sortedSkippedOutputs(state: StackState): [string, string][] {
  return Object.entries(state.skippedOutputs ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

/** Whether one record renders the block. The ONE copy of that condition. */
export function rendersSkippedBlock(state: StackState): boolean {
  return Object.keys(state.skippedOutputs ?? {}).length > 0;
}

/**
 * The explanation printed under a `Skipped outputs:` block.
 *
 * At column ZERO, unlike the rows it follows. At the rows' two-space indent a
 * reader — or a `grep '^  '` — takes these lines for another key. It also
 * quotes `Outputs:` mid-sentence, so a test matching that as a SUBSTRING has
 * to anchor on the section's own line to mean anything.
 *
 * Emitted ONCE per render rather than per block: under `--show-nested` the
 * same explanation would otherwise repeat for every child that skipped
 * anything.
 *
 * That placement is why the opening sentence NAMES its referent rather than
 * saying "these". At the end of a tree render it follows every rendered stack
 * block, so it is not adjacent to the block it explains and a bare
 * demonstrative reads as belonging to whichever stack printed last. The
 * single-stack path still has the adjacency; the wording holds in both.
 *
 * It does not claim `Outputs:` is on the screen. That block is omitted when
 * the bag is empty, which includes the first-deploy case this record exists
 * for — every output failed, so `outputs` is `{}` while `skippedOutputs` is
 * populated.
 */
export function skippedOutputsLegend(): string[] {
  return [
    '',
    'The last deploy could not resolve the keys listed under `Skipped outputs:`',
    'above, and recorded a digest of their template inputs. While the record',
    'binds and a key is still absent from the stored outputs, `cdkd diff`',
    'previews it as ABSENT — no row, no warning. A key whose earlier value',
    'was retained is also stored under `Outputs:` here, where the record does',
    'NOT suppress it: the ordinary rules apply, up to `cdkd diff` suppressing',
    'its whole Outputs section if the key still cannot resolve.',
    'Binding rule: `bindingSkippedOutputs` in src/analyzer/skipped-outputs.ts.',
  ];
}

/**
 * The order {@link repairRenderedContainers} names repaired containers in.
 *
 * Fixed here rather than taken from the order they were found in, so two
 * records that lost the same containers produce the same warning line and a
 * test can assert the text rather than a set.
 */
const RENDERED_CONTAINER_ORDER: readonly RenderedStateContainer[] = [
  'outputs',
  'skippedOutputs',
  'attributes',
  'properties',
];

/** Every container {@link renderStateBlock}'s text walks. */
const SHOW_RENDERED_CONTAINERS: ReadonlySet<RenderedStateContainer> = new Set(
  RENDERED_CONTAINER_ORDER
);

/**
 * What `cdkd state resources` walks: the attribute bag alone.
 *
 * `properties` is deliberately absent — that command excludes them from every
 * mode (`docs/cli-state.md` says so and `stateResourcesCommand`'s own doc
 * repeats it), so warning about a container it never renders would report a
 * defect the user cannot see in the output in front of them. `outputs` and
 * `skippedOutputs` are absent for the same reason.
 */
export const RESOURCES_RENDERED_CONTAINERS: ReadonlySet<RenderedStateContainer> = new Set([
  'attributes' as const,
]);

/**
 * Empty every container this view walks but cannot read, and warn ONCE naming
 * the ones that were emptied (issue go-to-k/cdkd#3187).
 *
 * `renderStateBlock` and `stateResourcesCommand --long` walk four more
 * containers with `Object.entries` than the `resources` bag go-to-k/cdkd#3185
 * guarded, and `Object.entries` takes a string, a list, a number and a boolean
 * as readily as an object. Measured on the shipped bundle: `cdkd state show`
 * over a record whose `outputs` is a 5,000,000-character string and whose
 * `resources` bag is HEALTHY costs ~1616 ms and ~1010 MB RSS and emits
 * 5,000,002 lines; the same shape in `skippedOutputs` costs ~2436 ms and
 * ~2148 MB. `--show-nested` pays that per node.
 *
 * AT THE RENDER ENTRY, not at the four loops, which is the rule
 * `src/state/malformed-resources-bag.ts`'s header records and the measurement
 * behind it. Here the reason the entry wins is narrower but the same in kind:
 * the per-resource containers are reached from inside the resource loop, so a
 * guard written there is one decision repeated per resource per container, and
 * the `?? {}` already sitting at each of them is exactly the spelling that
 * looks like a guard and is not.
 *
 * **Absent is NOT malformed here, and that is a different call from the one
 * {@link hasReadableResources} makes.** `undefined` and `null` both mean "no
 * such container" for all four, and the `?? {}` at each walk has always
 * rendered the nullish case as empty, so none of them can fabricate a row.
 * An unreadable `resources` bag is judged the other way because
 * `Object.entries(null)` THROWS and takes the whole render with it.
 *
 * The stronger half of the reason covers TWO of the four, not all of them, and
 * saying so is the point: `skippedOutputs?` and `attributes?` are OPTIONAL in
 * `src/types/state.ts`, so cdkd itself writes records without them and warning
 * would be a false positive on healthy state. `outputs` and `properties` are
 * REQUIRED there, so a nullish one IS a malformed record and this exemption
 * rests on the weaker reason alone — it cannot invent a row, and it renders
 * identically to the empty bag the reader would otherwise see. Warning on a
 * nullish REQUIRED container would be defensible; it is not done because the
 * harm this guard exists for is fabrication (review of go-to-k/cdkd#3190).
 *
 * Callers must have repaired the `resources` bag first; both do — one line up
 * in `repairRecordForTextRender`, and ~30 lines up in `stateResourcesCommand`,
 * where the mode gate sits between them.
 * The bag test below is that ORDER made local rather than a fallback: an
 * unreadable bag is emptied by the repair, so the record renders zero resources
 * and owns no per-resource container to repair. It reads
 * {@link isReadableBag} rather than {@link hasReadableResources} on purpose —
 * the latter is the probe `tests/unit/cli/state-record-shape.test.ts` counts to
 * measure the nested walk, and a second caller here would silently inflate it.
 */
export function repairRenderedContainers(
  state: StackState,
  walked: ReadonlySet<RenderedStateContainer>,
  stackName: string,
  region: string,
  logger: ReturnType<typeof getLogger>,
  recovery: LockRecoveryContext
): void {
  const repaired = new Set<RenderedStateContainer>();
  const emptyIfUnwalkable = (
    owner: Record<string, unknown>,
    name: RenderedStateContainer
  ): void => {
    if (!walked.has(name)) return;
    const container = owner[name];
    if (container === undefined || container === null) return;
    if (isReadableBag(container)) return;
    owner[name] = {};
    repaired.add(name);
  };

  const record = state as unknown as Record<string, unknown>;
  emptyIfUnwalkable(record, 'outputs');
  emptyIfUnwalkable(record, 'skippedOutputs');
  if ((walked.has('attributes') || walked.has('properties')) && isReadableBag(state.resources)) {
    // A non-object ENTRY carries no container: `renderStateBlock` and the
    // `details` map both read it through `(entry ?? {})`, so a string, a number
    // or a `null` there already renders its fields as `undefined` rather than
    // walking anything (issue #2947).
    for (const entry of Object.values(state.resources) as unknown[]) {
      if (!isReadableBag(entry)) continue;
      const fields = entry as Record<string, unknown>;
      emptyIfUnwalkable(fields, 'attributes');
      emptyIfUnwalkable(fields, 'properties');
    }
  }

  if (repaired.size === 0) return;
  logger.warn(
    malformedRenderedContainersWarning(
      stackName,
      region,
      RENDERED_CONTAINER_ORDER.filter((name) => repaired.has(name)),
      recovery
    )
  );
}

/**
 * Give the TEXT render a readable `resources` bag and readable value
 * containers, and warn when either was a repair rather than a no-op.
 *
 * {@link renderStateBlock} walks the bag with `Object.entries`, which takes a
 * string, a list, a number and a boolean as readily as an object. A planted
 * `"abcdef"` rendered six `[index, character]` pairs as six resources that do
 * not exist, under a `Resources (6):` header — and the cost grows with the
 * planted length, since one pair is allocated per character.
 *
 * Called AFTER every `--json` branch rather than at the load, which is this
 * command's one departure from the rule `src/state/malformed-resources-bag.ts`
 * states, and is deliberate: `cdkd state show --json` is the command
 * `cdkd state list --long` names as the way to SEE a record it could not count,
 * so repairing above that branch would hand the operator a well-formed
 * `"resources": {}` and delete the evidence they came for.
 *
 * That placement is only safe because ONE thing reads the bag earlier — the
 * `--show-nested` walker — and `walkCdkdStateStackTree` now returns a childless
 * node on an unreadable bag before it dereferences one. The comment at that
 * guard carries what the walker did with such a bag before, in both directions:
 * a scalar-element bag yielded no children but still allocated per element, and
 * a LIST of resource objects hard-failed. Do not move this call up, and do not
 * drop that guard: either one alone leaves the other half live.
 *
 * The guard is in the WALKER and not at its caller because the walker recurses.
 * A caller-side test covers the root record only, which is what an earlier cut
 * of this fix shipped — a healthy root naming a nested child still walked that
 * child's bag unguarded.
 *
 * The container pass runs SECOND and under the same `--json` placement, for one
 * reason each. Second, because {@link repairRenderedContainers} reads the
 * resource entries and the repair above is what guarantees there is a map to
 * read them from. Under the same placement, because `--json` emits the record
 * as parsed and a non-object `outputs` is evidence there exactly as a
 * non-object `resources` bag is — and because the payload carries the stored
 * value whole, it fabricates nothing to emit it.
 */
export function repairRecordForTextRender(
  state: StackState,
  stackName: string,
  region: string,
  logger: ReturnType<typeof getLogger>,
  recovery: LockRecoveryContext
): void {
  if (repairMalformedResourcesForReadOnly(state)) {
    logger.warn(malformedResourcesWarning(stackName, region, recovery));
  }
  repairRenderedContainers(state, SHOW_RENDERED_CONTAINERS, stackName, region, logger, recovery);
}

/**
 * The same repair for every node {@link renderTreeWithChildren} will render,
 * the root included. Each node carries its own record, so a CHILD with a
 * malformed bag fabricates rows exactly as the root does; one warning per
 * repaired record names which stack it came from.
 *
 * Both identifiers are strings by construction rather than record fields: the
 * walker builds a child's name as `` `${parent}~${logicalId}` `` and threads the
 * region it walked against, having already refused any child whose recorded
 * region disagrees.
 */
export function repairTreeForTextRender(
  node: CdkdStateStackTreeWithLock,
  logger: ReturnType<typeof getLogger>,
  recovery: LockRecoveryContext
): void {
  repairRecordForTextRender(node.state, node.stackName, node.region, logger, recovery);
  for (const child of node.children) repairTreeForTextRender(child, logger, recovery);
}

/**
 * Say which nodes the walk could not read, WITHOUT repairing any of them.
 *
 * `--show-nested --json` is the one mode that must not repair — it exists to
 * show the operator the stored record — but "cannot repair" is not "must stay
 * silent". An unreadable bag makes the walk return that node childless, and a
 * childless node is byte-indistinguishable from a genuine leaf: a consumer
 * enumerating `children` reads a CUT subtree as a complete one. The text views
 * do not have this problem, because a cut node renders `Resources (0):` where
 * the operator expected rows.
 *
 * `logger.warn` writes to stderr, and `stateShowCommand` has already called
 * `reserveStdoutForPayload()` for this branch, so this cannot corrupt the JSON.
 */
export function warnUnreadableTreeNodes(
  node: CdkdStateStackTreeWithLock,
  logger: ReturnType<typeof getLogger>,
  recovery: LockRecoveryContext
): void {
  if (!hasReadableResources(node.state)) {
    logger.warn(malformedResourcesWarning(node.stackName, node.region, recovery));
  }
  for (const child of node.children) warnUnreadableTreeNodes(child, logger, recovery);
}
