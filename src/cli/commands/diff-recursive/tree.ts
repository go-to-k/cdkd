import type { DestructiveChange } from '../../../analyzer/destructive-changes.js';
import type { DiffTreeNode } from './types.js';

/** True when this node has at least one real (non-`NO_CHANGE`) change. */
export function nodeHasChanges(node: DiffTreeNode): boolean {
  for (const change of node.changes.values()) {
    if (change.changeType !== 'NO_CHANGE') return true;
  }
  // Issue #1921: an Outputs-only change has no resource change at all, so this
  // arm is the ONLY thing standing between it and "No changes detected" — and
  // it is what makes `--fail` exit 1 for it, matching `cdk diff --fail`.
  //
  // go-to-k/cdkd#2943 adds the same arm for adoption, for the same reason and
  // found the same way — by running it against real AWS. An adopted record
  // whose properties already match the template diffs as NO_CHANGE, so a stack
  // whose only pending work is the adoption had every count at zero and
  // printed "No changes detected". The deploy does work there: it splices the
  // record into `resources` and persists the state without the orphan. A
  // preview that calls that nothing is wrong in the direction that matters —
  // the user ran `cdkd diff` precisely to find out whether the next deploy
  // will adopt or collide.
  //
  // go-to-k/cdkd#3018 adds the unreadable rows, for the reason `cdkd drift`
  // reports them as `notCompared`: the load DROPS them so the rest of the stack
  // can be diffed, and a dropped row the template no longer declares then has
  // no DELETE row. Without this arm `--fail` exits 0 over a record that used to
  // crash non-zero, which is the one direction this change must not take.
  return (
    node.outputChanges.length > 0 || node.adoptedOrphans.length > 0 || unreadableCount(node) > 0
  );
}

/**
 * How many things this node's record holds that the diff could not read, over
 * all three of {@link DiffTreeNode.unreadable}'s fields — the one number both
 * {@link nodeHasChanges} and the preview's count read, so the two cannot
 * disagree about whether a container counts.
 */
export function unreadableCount(node: DiffTreeNode): number {
  return node.unreadable.length + node.unreadableContainers.length + node.unreadableOrphans.length;
}

/** True when this node OR any descendant has a real change (tree-wide drift detector for `--fail`). */
/**
 * How many deploy refusals the whole tree carries (issue go-to-k/cdkd#2943).
 *
 * A COUNT rather than a boolean because the caller's message quotes it.
 * {@link treeIsWorthRendering} below IS a boolean built on this, added when
 * review found the render gate gated on changes alone — it derives from this
 * count rather than walking the tree again, so there is still one recursion to
 * keep in step.
 *
 * Deliberately SEPARATE from {@link treeHasChanges}: `--fail` answers "is
 * there a delta", and a refusal is not a delta — a user who runs
 * `cdkd diff --fail` in CI to detect drift must not have that signal merged
 * with "the deploy cannot start", which is true whether or not anything
 * changed.
 */
export function countBlocking(node: DiffTreeNode): number {
  return node.blocking.length + node.children.reduce((n, c) => n + countBlocking(c), 0);
}

/**
 * Whether `cdkd diff` should render this tree's block at all (issue
 * go-to-k/cdkd#2943).
 *
 * A named predicate rather than an inline conjunction at the call site,
 * because the two halves are easy to get wrong INDEPENDENTLY and were:
 * {@link renderDiffTree} was written to print a `Blocking` section for a node
 * with no changes, and the caller then skipped the render on
 * `!treeHasChanges` alone — so a changeless refusal would print "No changes
 * detected" and exit non-zero citing reasons that were never printed.
 */
export function treeIsWorthRendering(node: DiffTreeNode): boolean {
  // `treeHasChanges` already covers adoption since go-to-k/cdkd#2943 taught
  // `nodeHasChanges` about it, so this stays a two-term predicate.
  return treeHasChanges(node) || countBlocking(node) > 0;
}

export function treeHasChanges(node: DiffTreeNode): boolean {
  if (nodeHasChanges(node)) return true;
  return node.children.some(treeHasChanges);
}

/** Every destructive change in this node and its descendants, DFS order (`--fail-on=destructive`). */
export function treeDestructiveChanges(node: DiffTreeNode): DestructiveChange[] {
  return [...node.destructiveChanges, ...node.children.flatMap(treeDestructiveChanges)];
}
