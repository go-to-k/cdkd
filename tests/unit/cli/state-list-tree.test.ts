import { describe, it, expect } from 'vite-plus/test';
import {
  buildStackTree,
  renderStackTreeAscii,
  stackTreeToJson,
  type StackTreeEntry,
  type StackTreeNode,
} from '../../../src/cli/commands/state-list-tree.js';

describe('buildStackTree', () => {
  it('returns roots in alphabetical order when no parent links are present', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'Charlie', region: 'us-east-1' },
      { stackName: 'alpha', region: 'us-east-1' },
      { stackName: 'Bravo', region: 'us-east-1' },
    ];
    const roots = buildStackTree(entries);
    expect(roots.map((r) => r.stackName)).toEqual(['Bravo', 'Charlie', 'alpha']);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  it('nests a single child under its parent', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'Parent', region: 'us-east-1' },
      {
        stackName: 'Parent~Child',
        region: 'us-east-1',
        parentStack: 'Parent',
        parentLogicalId: 'Child',
        parentRegion: 'us-east-1',
      },
    ];
    const roots = buildStackTree(entries);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.stackName).toBe('Parent');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.stackName).toBe('Parent~Child');
  });

  it('builds a 3-level tree (parent -> child -> grandchild) for nested-stack-deep fixtures', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'NestedStackDeep', region: 'us-east-1' },
      {
        stackName: 'NestedStackDeep~Child',
        region: 'us-east-1',
        parentStack: 'NestedStackDeep',
        parentLogicalId: 'Child',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'NestedStackDeep~Child~Grandchild',
        region: 'us-east-1',
        parentStack: 'NestedStackDeep~Child',
        parentLogicalId: 'Grandchild',
        parentRegion: 'us-east-1',
      },
    ];
    const roots = buildStackTree(entries);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.stackName).toBe('NestedStackDeep');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.stackName).toBe('NestedStackDeep~Child');
    expect(roots[0]!.children[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.children[0]!.stackName).toBe(
      'NestedStackDeep~Child~Grandchild'
    );
  });

  it('handles multiple parents each with their own children', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
      {
        stackName: 'A~ChildA',
        region: 'us-east-1',
        parentStack: 'A',
        parentLogicalId: 'ChildA',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'B~ChildB',
        region: 'us-east-1',
        parentStack: 'B',
        parentLogicalId: 'ChildB',
        parentRegion: 'us-east-1',
      },
    ];
    const roots = buildStackTree(entries);
    expect(roots).toHaveLength(2);
    expect(roots[0]!.stackName).toBe('A');
    expect(roots[0]!.children.map((c) => c.stackName)).toEqual(['A~ChildA']);
    expect(roots[1]!.stackName).toBe('B');
    expect(roots[1]!.children.map((c) => c.stackName)).toEqual(['B~ChildB']);
  });

  it('promotes an orphan child (parent missing from the input) to root level', () => {
    // The parent may have been hand-deleted from S3 or destroyed out-of-band.
    // The orphan should still render so the user can see the dangling record.
    const entries: StackTreeEntry[] = [
      {
        stackName: 'Ghost~Orphan',
        region: 'us-east-1',
        parentStack: 'Ghost',
        parentLogicalId: 'Orphan',
        parentRegion: 'us-east-1',
      },
    ];
    const roots = buildStackTree(entries);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.stackName).toBe('Ghost~Orphan');
  });

  it('treats a parent in a different region as missing (no cross-region match)', () => {
    // Even if the same stackName exists in another region, the child whose
    // parentRegion explicitly points elsewhere should NOT be linked to a
    // same-name parent in a different region.
    const entries: StackTreeEntry[] = [
      { stackName: 'P', region: 'us-east-1' },
      {
        stackName: 'P~C',
        region: 'us-west-2',
        parentStack: 'P',
        parentLogicalId: 'C',
        parentRegion: 'us-west-2',
      },
    ];
    const roots = buildStackTree(entries);
    expect(roots).toHaveLength(2);
    const stacks = roots.map((r) => `${r.stackName}/${r.region ?? '-'}`).sort();
    expect(stacks).toEqual(['P/us-east-1', 'P~C/us-west-2']);
  });

  it('breaks a self-link by leaving the node at the root', () => {
    // Defensive: a hand-edited or corrupted state record claiming itself as
    // parent should not produce an infinite tree.
    const entries: StackTreeEntry[] = [
      {
        stackName: 'Loop',
        region: 'us-east-1',
        parentStack: 'Loop',
        parentLogicalId: 'Loop',
        parentRegion: 'us-east-1',
      },
    ];
    const roots = buildStackTree(entries);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.stackName).toBe('Loop');
    expect(roots[0]!.children).toHaveLength(0);
  });

  it('places both members of a two-record parent loop at the root instead of hiding them', () => {
    // Linked as given, A would be B's child and B would be A's child, so
    // neither would be a root and both would vanish from every view.
    const entries: StackTreeEntry[] = [
      { stackName: 'A', region: 'us-east-1', parentStack: 'B', parentRegion: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1', parentStack: 'A', parentRegion: 'us-east-1' },
    ];
    const roots = buildStackTree(entries);
    expect(roots.map((r) => r.stackName)).toEqual(['A', 'B']);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  it('handles two DISJOINT parent loops, one with a hanging child, in a single build', () => {
    // The outer walk must keep going after it has found one loop: a pass that
    // stopped at the first cycle would leave the second loop's members nested
    // under each other.
    const entries: StackTreeEntry[] = [
      { stackName: 'A', region: 'us-east-1', parentStack: 'B', parentRegion: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1', parentStack: 'A', parentRegion: 'us-east-1' },
      { stackName: 'C', region: 'us-east-1', parentStack: 'D', parentRegion: 'us-east-1' },
      { stackName: 'D', region: 'us-east-1', parentStack: 'C', parentRegion: 'us-east-1' },
      { stackName: 'E', region: 'us-east-1', parentStack: 'C', parentRegion: 'us-east-1' },
    ];
    const roots = buildStackTree(entries);
    expect(roots.map((r) => [r.stackName, r.children.map((c) => c.stackName)])).toEqual([
      ['A', []],
      ['B', []],
      ['C', ['E']],
      ['D', []],
    ]);
  });

  it('places every member of a five-record parent loop at the root', () => {
    // Longer than any other loop here, so a walk capped at a small fixed
    // number of steps would miss it and hide the whole loop.
    const names = ['L1', 'L2', 'L3', 'L4', 'L5'];
    const entries: StackTreeEntry[] = names.map((stackName, i) => ({
      stackName,
      region: 'us-east-1',
      parentStack: names[(i + 1) % names.length]!,
      parentRegion: 'us-east-1',
    }));
    const roots = buildStackTree(entries);
    expect(roots.map((r) => r.stackName)).toEqual(names);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  it('keeps a hanging node under its parent even when the walk reaches the loop from it first', () => {
    // `Tail` is listed FIRST, so the loop is discovered on a walk that starts
    // at `Tail`. Only the part of that walk from the repeated node on is the
    // loop; `Tail` itself must not be counted as a member.
    const entries: StackTreeEntry[] = [
      { stackName: 'Tail', region: 'us-east-1', parentStack: 'A', parentRegion: 'us-east-1' },
      { stackName: 'A', region: 'us-east-1', parentStack: 'B', parentRegion: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1', parentStack: 'A', parentRegion: 'us-east-1' },
    ];
    const roots = buildStackTree(entries);
    expect(roots.map((r) => r.stackName)).toEqual(['A', 'B']);
    expect(roots[0]!.children.map((c) => c.stackName)).toEqual(['Tail']);
    expect(roots[1]!.children).toHaveLength(0);
  });

  it('keeps a node that merely hangs off a parent loop under its parent', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'A', region: 'us-east-1', parentStack: 'C', parentRegion: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1', parentStack: 'A', parentRegion: 'us-east-1' },
      { stackName: 'C', region: 'us-east-1', parentStack: 'B', parentRegion: 'us-east-1' },
      { stackName: 'Tail', region: 'us-east-1', parentStack: 'A', parentRegion: 'us-east-1' },
    ];
    const roots = buildStackTree(entries);
    // Every stack is visible exactly once.
    const seen: string[] = [];
    const walk = (nodes: StackTreeNode[]): void => {
      for (const n of nodes) {
        seen.push(n.stackName);
        walk(n.children);
      }
    };
    walk(roots);
    expect(seen.sort()).toEqual(['A', 'B', 'C', 'Tail']);
    expect(roots.map((r) => r.stackName)).toEqual(['A', 'B', 'C']);
    expect(roots[0]!.children.map((c) => c.stackName)).toEqual(['Tail']);
  });

  it('sorts children alphabetically', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'Parent', region: 'us-east-1' },
      {
        stackName: 'Parent~Charlie',
        region: 'us-east-1',
        parentStack: 'Parent',
        parentLogicalId: 'Charlie',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'Parent~Alpha',
        region: 'us-east-1',
        parentStack: 'Parent',
        parentLogicalId: 'Alpha',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'Parent~Bravo',
        region: 'us-east-1',
        parentStack: 'Parent',
        parentLogicalId: 'Bravo',
        parentRegion: 'us-east-1',
      },
    ];
    const roots = buildStackTree(entries);
    expect(roots[0]!.children.map((c) => c.stackName)).toEqual([
      'Parent~Alpha',
      'Parent~Bravo',
      'Parent~Charlie',
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(buildStackTree([])).toEqual([]);
  });
});

describe('renderStackTreeAscii', () => {
  const fmt = (n: StackTreeNode): string =>
    n.region ? `${n.stackName} (${n.region})` : n.stackName;

  it('renders flat roots with no branch glyphs', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
    ];
    const out = renderStackTreeAscii(buildStackTree(entries), fmt);
    expect(out).toBe('A (us-east-1)\nB (us-east-1)');
  });

  it('uses tree(1)-style box-drawing for nested children', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'Parent', region: 'us-east-1' },
      {
        stackName: 'Parent~Child',
        region: 'us-east-1',
        parentStack: 'Parent',
        parentLogicalId: 'Child',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'Parent~Child~Grandchild',
        region: 'us-east-1',
        parentStack: 'Parent~Child',
        parentLogicalId: 'Grandchild',
        parentRegion: 'us-east-1',
      },
    ];
    const out = renderStackTreeAscii(buildStackTree(entries), fmt);
    expect(out).toBe(
      [
        'Parent (us-east-1)',
        '└── Parent~Child (us-east-1)',
        '    └── Parent~Child~Grandchild (us-east-1)',
      ].join('\n')
    );
  });

  it('uses `├──` for non-last siblings and `└──` for the last', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'P', region: 'us-east-1' },
      {
        stackName: 'P~A',
        region: 'us-east-1',
        parentStack: 'P',
        parentLogicalId: 'A',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'P~B',
        region: 'us-east-1',
        parentStack: 'P',
        parentLogicalId: 'B',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'P~C',
        region: 'us-east-1',
        parentStack: 'P',
        parentLogicalId: 'C',
        parentRegion: 'us-east-1',
      },
    ];
    const out = renderStackTreeAscii(buildStackTree(entries), fmt);
    expect(out).toBe(
      [
        'P (us-east-1)',
        '├── P~A (us-east-1)',
        '├── P~B (us-east-1)',
        '└── P~C (us-east-1)',
      ].join('\n')
    );
  });

  it('extends the vertical bar past a non-last child with its own descendants', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'P', region: 'us-east-1' },
      {
        stackName: 'P~A',
        region: 'us-east-1',
        parentStack: 'P',
        parentLogicalId: 'A',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'P~A~X',
        region: 'us-east-1',
        parentStack: 'P~A',
        parentLogicalId: 'X',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'P~B',
        region: 'us-east-1',
        parentStack: 'P',
        parentLogicalId: 'B',
        parentRegion: 'us-east-1',
      },
    ];
    const out = renderStackTreeAscii(buildStackTree(entries), fmt);
    expect(out).toBe(
      [
        'P (us-east-1)',
        '├── P~A (us-east-1)',
        '│   └── P~A~X (us-east-1)',
        '└── P~B (us-east-1)',
      ].join('\n')
    );
  });
});

describe('stackTreeToJson', () => {
  it('emits a nested JSON shape with explicit null for absent fields', () => {
    const entries: StackTreeEntry[] = [
      { stackName: 'Parent', region: 'us-east-1' },
      {
        stackName: 'Parent~Child',
        region: 'us-east-1',
        parentStack: 'Parent',
        parentLogicalId: 'Child',
        parentRegion: 'us-east-1',
      },
    ];
    expect(stackTreeToJson(buildStackTree(entries))).toEqual([
      {
        stackName: 'Parent',
        region: 'us-east-1',
        parentStack: null,
        parentLogicalId: null,
        parentRegion: null,
        children: [
          {
            stackName: 'Parent~Child',
            region: 'us-east-1',
            parentStack: 'Parent',
            parentLogicalId: 'Child',
            parentRegion: 'us-east-1',
            children: [],
          },
        ],
      },
    ]);
  });

  it('emits region as null for legacy entries with no region', () => {
    const entries: StackTreeEntry[] = [{ stackName: 'Legacy' /* region: undefined */ }];
    expect(stackTreeToJson(buildStackTree(entries))).toEqual([
      {
        stackName: 'Legacy',
        region: null,
        parentStack: null,
        parentLogicalId: null,
        parentRegion: null,
        children: [],
      },
    ]);
  });
});
