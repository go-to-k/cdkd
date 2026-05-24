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
 * Build a parent → child tree from the flat list of state records.
 *
 * Children are linked to their parent by `(parentStack, parentRegion)`
 * matching another entry's `(stackName, region)`. Children whose parent
 * isn't present in the input (orphans — parent state was hand-deleted,
 * or destroyed out-of-band) are reported at the root level so they stay
 * visible to `cdkd state list` rather than vanishing silently.
 *
 * A self-link (parent equals self) is treated as a missing parent — the
 * node lands at the root rather than building an infinite tree.
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

  const roots: StackTreeNode[] = [];
  for (const node of byKey.values()) {
    if (node.parentStack !== undefined) {
      const parent = byKey.get(refKey(node.parentStack, node.parentRegion));
      if (parent && parent !== node) {
        parent.children.push(node);
        continue;
      }
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
