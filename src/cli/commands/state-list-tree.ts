/**
 * Helpers for `cdkd state list --tree`: reconstruct the parent → child stack
 * tree from a flat list of state records and render it.
 *
 * The actual S3 reads happen in {@link import('./state.js')} — this module
 * stays pure / synchronous so the tree-building logic can be unit-tested
 * without mocking the state backend.
 */

/**
 * One entry in the flat input list. Mirrors {@link import('../../state/s3-state-backend.js').StackStateRef}
 * plus the three v6 parent-link fields read from the state record itself
 * (undefined on top-level stacks).
 */
export interface StackTreeEntry {
  stackName: string;
  region?: string;
  parentStack?: string;
  parentLogicalId?: string;
  parentRegion?: string;
}

/**
 * Output node in the parent → child tree.
 */
export interface StackTreeNode extends StackTreeEntry {
  children: StackTreeNode[];
}

/**
 * How deep a node may sit below its root, counting the root as 0.
 *
 * A node that would sit deeper is made a root instead (see
 * {@link buildStackTree}). The value is far beyond any nesting an app is
 * written with: CloudFormation stops at five levels of nested stacks, so an
 * app that also has to deploy through CloudFormation cannot exceed that.
 * cdkd deploys nested stacks through its own engine and imposes no limit of
 * its own, so a deliberately deeper app CAN produce a tree this reshapes —
 * which is the point. The view stays whole either way.
 *
 * It exists because every step AFTER the tree is built recurses once per
 * level: this module's own child sort, the box-drawing renderer and
 * {@link stackTreeToJson}, plus the `JSON.stringify` that serializes that
 * shape for `--tree --json`. Capping the tree bounds all four at once, which
 * an iterative rewrite of any of them could not: `JSON.stringify` recurses
 * into whatever nesting it is handed, and the text view indents four
 * characters per level, so a chain deep enough would need more indentation
 * than a string can hold.
 *
 * It bounds the DEPTH, not the bucket, and what it does to the failure at the
 * far end is change its KIND. Before the cap, one deep chain exhausted the
 * CALL STACK, at a record count nothing fixes — V8's budget moves with frame
 * size and with what else is on the stack. After it, every recursion is at
 * most a hundred frames and the remaining ceiling is V8's maximum STRING
 * length: a capped tree still costs a roughly constant number of characters
 * per record (the cap's own pretty-print indent dominates in `--tree --json`),
 * so `JSON.stringify` refuses a large enough bucket deterministically instead
 * of at a moving depth. Both are far past `renderTreeMode`'s unbounded
 * one-read-per-reference fan-out, which gives out first. Read the cap as what
 * stops a SINGLE chain taking the view down, not as a total bound.
 */
export const MAX_STACK_TREE_DEPTH = 100;

/**
 * Build a parent → child tree from the flat list of state records.
 *
 * Children are linked to their parent by `(parentStack, parentRegion)`
 * matching another entry's `(stackName, region)`. Children whose parent
 * isn't present in the input (orphans — parent state was hand-deleted,
 * or destroyed out-of-band) are reported at the root level so they stay
 * visible to `cdkd state list` rather than vanishing silently.
 *
 * Every node on a parent LOOP lands at the root rather than building an
 * infinite tree. A self-link (parent equals self) is the one-node loop. A
 * longer one (A names B, B names A) used to be linked as given, so each member
 * was filed as the other's child, none was a root, and the whole loop vanished
 * from both the text and the JSON view. A node hanging off a loop still sits
 * under its parent, which is now visible (issue #3069).
 *
 * A node that would sit deeper than {@link MAX_STACK_TREE_DEPTH} levels below
 * its root is placed at the root too, so the chain resumes there as its own
 * tree. Every record still appears exactly once, and a tree within the cap is
 * built as before. Without it a long enough chain took the whole view down with
 * a `RangeError` instead of costing only its own rows, since the recursive
 * steps AFTER this function are not covered by the per-stack guard around the
 * state read. Reaching the depths that failed takes thousands of records — in
 * practice a hand-edited bucket, or records planted by someone holding
 * `s3:PutObject` on it — but nothing in cdkd bounds the depth, so the cap does
 * (issue #3155).
 *
 * The roots and every child list are sorted alphabetically by `stackName`,
 * then by `region` (legacy `undefined` last), so output is stable across
 * runs.
 */
export function buildStackTree(entries: readonly StackTreeEntry[]): StackTreeNode[] {
  const refKey = (stackName: string, region?: string): string => `${stackName}\0${region ?? ''}`;

  const byKey = new Map<string, StackTreeNode>();
  for (const entry of entries) {
    byKey.set(refKey(entry.stackName, entry.region), { ...entry, children: [] });
  }

  const parentOf = (node: StackTreeNode): StackTreeNode | undefined =>
    node.parentStack === undefined
      ? undefined
      : byKey.get(refKey(node.parentStack, node.parentRegion));
  // Every node on a parent loop, found in ONE pass over the parent links so
  // the cost stays linear in the number of records: each node is walked at
  // most once, and a walk stops at a node an earlier walk already settled. A
  // walk that reaches a node still on its OWN path has found a loop, whose
  // members are the path from that node on. A self-link is the one-node case.
  const loopMembers = new Set<StackTreeNode>();
  const settled = new Set<StackTreeNode>();
  for (const start of byKey.values()) {
    const path: StackTreeNode[] = [];
    const onPath = new Map<StackTreeNode, number>();
    let current: StackTreeNode | undefined = start;
    while (current !== undefined && !settled.has(current) && !onPath.has(current)) {
      onPath.set(current, path.length);
      path.push(current);
      current = parentOf(current);
    }
    if (current !== undefined && onPath.has(current)) {
      for (const member of path.slice(onPath.get(current)!)) loopMembers.add(member);
    }
    for (const node of path) settled.add(node);
  }

  // Each node's depth below its root, capped at MAX_STACK_TREE_DEPTH — a node
  // that would sit deeper becomes a root itself, the treatment an orphan or a
  // loop member already gets, so the chain continues as a sibling tree instead
  // of a deeper one. Found in ONE pass over the parent links, like the loop
  // detection above: walk up to the first node whose depth is already known,
  // then assign downward. A node is walked at most once, so THIS pass costs no
  // stack frames for a chain of any length (the child sort below still recurses,
  // which is exactly what the cap bounds), and the answer depends only on the
  // chain above a node, never on the order `byKey` yields them in.
  //
  // Every loop member is SEEDED at 0 rather than walked to. It is a root by the
  // rule above, so 0 is its depth — and seeding is also what makes the walk
  // below terminate without a visited set of its own, since the only way it
  // could repeat a node is a cycle and every cycle node is seeded here.
  //
  // That last step is the one worth deriving rather than asserting, because a
  // walk that reaches a cycle it does not recognize does not FAIL — it never
  // returns, which is worse than the `RangeError` this cap exists to stop.
  // `parentOf` gives each node at most ONE parent, so the parent links form a
  // functional graph and its cycles are disjoint. The detection pass above
  // writes `settled` only AFTER a walk completes, so the first walk to touch
  // any cycle finds no member of it settled: it runs the cycle all the way
  // round to a node still on its own path, and `path.slice(onPath.get(...))`
  // is exactly that cycle's member set. So no cycle is ever partially
  // detected, and `loopMembers` covers every one of them. Change either pass
  // and this is the property to re-derive.
  const depthOf = new Map<StackTreeNode, number>();
  for (const member of loopMembers) depthOf.set(member, 0);
  for (const start of byKey.values()) {
    // A short-circuit, NOT a guard: a start that already has a depth walks
    // nowhere and assigns nothing, so removing this line changes no output —
    // it only skips setting the walk up. Said plainly because a clause no test
    // can pin reads like one that was never checked.
    if (depthOf.has(start)) continue;
    const path: StackTreeNode[] = [];
    let current: StackTreeNode | undefined = start;
    while (current !== undefined && !depthOf.has(current)) {
      path.push(current);
      current = parentOf(current);
    }
    // -1 so the topmost node on the path — one with no parent in the input —
    // comes out at 0.
    let depth = current === undefined ? -1 : depthOf.get(current)!;
    // Downward, from the top of the path: each node's depth is read off the one
    // above it, so the walk's own direction must be reversed here.
    for (let i = path.length - 1; i >= 0; i--) {
      depth = depth + 1 > MAX_STACK_TREE_DEPTH ? 0 : depth + 1;
      depthOf.set(path[i]!, depth);
    }
  }

  const roots: StackTreeNode[] = [];
  for (const node of byKey.values()) {
    const parent = parentOf(node);
    // Depth 0 is what every root has, by all three routes: no parent in the
    // input, a parent LOOP, or a chain the cap re-rooted. The last two DO have
    // a parent here and are placed at the root anyway, which is why the depth
    // is the test rather than the parent alone.
    if (parent && depthOf.get(node)! > 0) {
      parent.children.push(node);
      continue;
    }
    roots.push(node);
  }

  const cmp = (a: StackTreeNode, b: StackTreeNode): number => {
    if (a.stackName < b.stackName) return -1;
    if (a.stackName > b.stackName) return 1;
    // Sort legacy v1 records (no region) last. AWS region strings are ASCII,
    // so U+FFFF can never collide with a real region value.
    const ar = a.region ?? '￿';
    const br = b.region ?? '￿';
    if (ar < br) return -1;
    if (ar > br) return 1;
    return 0;
  };
  const sortRecursive = (list: StackTreeNode[]): void => {
    list.sort(cmp);
    for (const node of list) sortRecursive(node.children);
  };
  sortRecursive(roots);
  return roots;
}

/**
 * Render the tree using `tree(1)`-style box-drawing prefixes.
 *
 * Each line is built by `formatLine(node)`. The caller picks the
 * human-readable shape (e.g. `Stack (region)`); this helper only owns the
 * indentation.
 */
export function renderStackTreeAscii(
  roots: readonly StackTreeNode[],
  formatLine: (node: StackTreeNode) => string
): string {
  const lines: string[] = [];
  for (const root of roots) {
    lines.push(formatLine(root));
    renderChildren(root.children, '', lines, formatLine);
  }
  return lines.join('\n');
}

function renderChildren(
  children: readonly StackTreeNode[],
  prefix: string,
  out: string[],
  formatLine: (node: StackTreeNode) => string
): void {
  const lastIdx = children.length - 1;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const isLast = i === lastIdx;
    const branch = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';
    out.push(`${prefix}${branch}${formatLine(child)}`);
    renderChildren(child.children, prefix + childPrefix, out, formatLine);
  }
}

/**
 * JSON-friendly nested shape for `cdkd state list --tree --json`.
 *
 * All optional fields are emitted as explicit `null` so consumers see a
 * stable key set on every node (mirrors the existing `--json` contract
 * where `region` is `null` for legacy records).
 */
export interface StackTreeJson {
  stackName: string;
  region: string | null;
  parentStack: string | null;
  parentLogicalId: string | null;
  parentRegion: string | null;
  children: StackTreeJson[];
}

export function stackTreeToJson(roots: readonly StackTreeNode[]): StackTreeJson[] {
  return roots.map((node) => ({
    stackName: node.stackName,
    region: node.region ?? null,
    parentStack: node.parentStack ?? null,
    parentLogicalId: node.parentLogicalId ?? null,
    parentRegion: node.parentRegion ?? null,
    children: stackTreeToJson(node.children),
  }));
}
