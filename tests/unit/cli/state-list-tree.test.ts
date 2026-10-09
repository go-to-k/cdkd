import { describe, it, expect } from 'vite-plus/test';
import {
  buildStackTree,
  renderStackTreeAscii,
  stackTreeToJson,
  MAX_STACK_TREE_DEPTH,
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

/**
 * Issue #3155: four steps in the `--tree` path recurse once per level of the
 * tree — this module's child sort, its ASCII renderer, `stackTreeToJson`, and
 * the `JSON.stringify` `state.ts` wraps that shape in. None sits inside
 * `renderTreeMode`'s per-stack guard, which covers only the state READ, so a
 * long enough parent chain took the WHOLE view down with a `RangeError`
 * instead of costing only its own rows. `MAX_STACK_TREE_DEPTH` bounds all four
 * at once by re-rooting a node that would sit deeper.
 *
 * Two of the chains below are far longer than the cap on purpose. Measured
 * against the pre-fix module — `origin/main`'s copy with only the constant
 * appended so it compiles — this FILE reports `5 failed | 22 passed (27)`.
 * Two of the five throw `RangeError: Maximum call stack size exceeded` inside
 * `sortRecursive` (the 30000-record case and the loop-chain case), so those
 * inputs really do exceed the runner's recursion limit rather than merely
 * exercising the new arithmetic; the past-cap, resume and branching cases fail
 * on their assertions.
 *
 * Two cases here PASS pre-fix, each for its own reason. The at-cap case,
 * because a chain of exactly 101 records is built identically with and without
 * the cap — that is the in-cap compatibility this change owes, which the
 * file's 20 pre-existing cases carry the bulk of. And the order-independence
 * case, because pre-fix has no memoized pass whose entry point could matter:
 * it watches the pass this change ADDS, not `origin/main`.
 *
 * The depths at which each step gives out are not fixed — V8's budget moves
 * with frame size and what else is on the stack — which is why a case that
 * asserts a depth at all asserts the CAP, never a threshold.
 */
describe('buildStackTree depth cap', () => {
  /** A chain of `count` records, each naming the previous one as its parent. */
  const chainEntries = (count: number, prefix: string): StackTreeEntry[] => {
    const entries: StackTreeEntry[] = [];
    for (let i = 0; i < count; i++) {
      entries.push({
        stackName: `${prefix}${i}`,
        region: 'us-east-1',
        ...(i > 0 && {
          parentStack: `${prefix}${i - 1}`,
          parentLogicalId: 'Child',
          parentRegion: 'us-east-1',
        }),
      });
    }
    return entries;
  };

  /**
   * Walk the built tree with an EXPLICIT stack. A recursive walk here would
   * hit the same limit as the code under test, so a pass would say nothing
   * about the subject.
   */
  const walk = (roots: readonly StackTreeNode[]): { names: string[]; maxDepth: number } => {
    const names: string[] = [];
    let maxDepth = 0;
    const pending: Array<{ node: StackTreeNode; depth: number }> = roots.map((node) => ({
      node,
      depth: 0,
    }));
    while (pending.length > 0) {
      const { node, depth } = pending.pop()!;
      names.push(node.stackName);
      if (depth > maxDepth) maxDepth = depth;
      for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
    }
    return { names, maxDepth };
  };

  it('builds, renders and serializes a 30000-record parent chain without exhausting the stack', () => {
    const roots = buildStackTree(chainEntries(30_000, 'Chain'));

    // 30000 records in segments of 101 (a root plus MAX_STACK_TREE_DEPTH
    // levels under it): 297 full segments and a 3-record remainder. Written as
    // a literal so the expectation does not re-derive itself from the cap the
    // subject applies.
    expect(roots).toHaveLength(298);

    const { names, maxDepth } = walk(roots);
    expect(names).toHaveLength(30_000);
    expect(new Set(names).size).toBe(30_000);
    expect(maxDepth).toBe(MAX_STACK_TREE_DEPTH);

    // The two output steps recurse per level too, so they are part of the
    // assertion rather than a smoke check.
    const text = renderStackTreeAscii(roots, (node) => node.stackName);
    expect(text.split('\n')).toHaveLength(30_000);
    const json = JSON.stringify(stackTreeToJson(roots), null, 2);
    expect(JSON.parse(json)).toHaveLength(298);
    // An explicit bound, not latency policing: building 30000 nodes measured
    // 0.8-1.2 s alone but 4.5 s beside nineteen peer vitest processes, and
    // vitest's default is 5 s. Its job is to stop a HANG.
  }, 30_000);

  it('keeps a chain exactly at the cap as one tree', () => {
    const roots = buildStackTree(chainEntries(MAX_STACK_TREE_DEPTH + 1, 'AtCap'));
    expect(roots).toHaveLength(1);
    expect(roots[0]!.stackName).toBe('AtCap0');

    const { names, maxDepth } = walk(roots);
    expect(names).toHaveLength(MAX_STACK_TREE_DEPTH + 1);
    expect(maxDepth).toBe(MAX_STACK_TREE_DEPTH);
  });

  it('re-roots the first node PAST the cap, keeping its parent link visible', () => {
    const roots = buildStackTree(chainEntries(MAX_STACK_TREE_DEPTH + 2, 'PastCap'));
    expect(roots).toHaveLength(2);

    const promoted = roots.find((r) => r.stackName === `PastCap${MAX_STACK_TREE_DEPTH + 1}`);
    expect(promoted).toBeDefined();
    expect(promoted!.children).toHaveLength(0);
    // The record is shown at the root, but its own parent link is untouched —
    // all THREE fields, and through `stackTreeToJson`, because that is the
    // shape `--tree --json` emits and the one the claim is about. Asserting
    // `parentStack` on the node alone leaves the other two free to be dropped.
    expect(stackTreeToJson(roots).find((n) => n.stackName === promoted!.stackName)).toEqual({
      stackName: `PastCap${MAX_STACK_TREE_DEPTH + 1}`,
      region: 'us-east-1',
      parentStack: `PastCap${MAX_STACK_TREE_DEPTH}`,
      parentLogicalId: 'Child',
      parentRegion: 'us-east-1',
      children: [],
    });

    // "Shown at the root instead" is what docs/cli-state.md tells the user, and
    // the DEFAULT view is the text one — so assert the rendered row, at column
    // 0 with no `└── ` connector, rather than only the JSON shape.
    const lines = renderStackTreeAscii(roots, (node) => node.stackName).split('\n');
    expect(lines).toContain(`PastCap${MAX_STACK_TREE_DEPTH + 1}`);
    expect(lines[lines.length - 1]).toBe(`PastCap${MAX_STACK_TREE_DEPTH + 1}`);

    const { names, maxDepth } = walk(roots);
    expect(names).toHaveLength(MAX_STACK_TREE_DEPTH + 2);
    expect(maxDepth).toBe(MAX_STACK_TREE_DEPTH);
  });

  it('resumes the chain UNDER the re-rooted node rather than flattening the rest', () => {
    // Re-rooting EVERY node past the cap — turning a long chain into a flat
    // list — is already rejected by the 30000-record case's root count, but
    // only arithmetically: 29900 roots instead of 298. This says the same
    // thing as a SHAPE, on an input small enough to read.
    const roots = buildStackTree(chainEntries(MAX_STACK_TREE_DEPTH + 3, 'Resume'));
    expect(roots).toHaveLength(2);

    const promoted = roots.find((r) => r.stackName === `Resume${MAX_STACK_TREE_DEPTH + 1}`)!;
    expect(promoted.children.map((c) => c.stackName)).toEqual([
      `Resume${MAX_STACK_TREE_DEPTH + 2}`,
    ]);
  });

  it('re-roots each over-cap child of a BRANCHING node independently', () => {
    // Every other case here is a straight chain, so `children` is never longer
    // than one and the cap is only ever reached by a single node. A parent
    // sitting exactly AT the cap with two children is the shape that says
    // whether the depth is per-node or per-chain.
    const entries: StackTreeEntry[] = [
      ...chainEntries(MAX_STACK_TREE_DEPTH + 1, 'Branch'),
      ...['Left', 'Right'].flatMap((side) => [
        {
          stackName: `Branch-${side}`,
          region: 'us-east-1',
          parentStack: `Branch${MAX_STACK_TREE_DEPTH}`,
          parentLogicalId: side,
          parentRegion: 'us-east-1',
        },
        {
          stackName: `Branch-${side}-Leaf`,
          region: 'us-east-1',
          parentStack: `Branch-${side}`,
          parentLogicalId: 'Leaf',
          parentRegion: 'us-east-1',
        },
      ]),
    ];

    const roots = buildStackTree(entries);
    expect(roots.map((r) => r.stackName)).toEqual(['Branch-Left', 'Branch-Right', 'Branch0']);

    // Each over-cap child becomes its own root and KEEPS its own subtree —
    // re-rooting one does not pull the other's leaf up with it.
    for (const side of ['Left', 'Right']) {
      const promoted = roots.find((r) => r.stackName === `Branch-${side}`)!;
      expect(promoted.parentStack).toBe(`Branch${MAX_STACK_TREE_DEPTH}`);
      expect(promoted.children.map((c) => c.stackName)).toEqual([`Branch-${side}-Leaf`]);
    }

    const { names, maxDepth } = walk(roots);
    expect(names).toHaveLength(MAX_STACK_TREE_DEPTH + 5);
    expect(new Set(names).size).toBe(MAX_STACK_TREE_DEPTH + 5);
    expect(maxDepth).toBe(MAX_STACK_TREE_DEPTH);

    // The order-independence case only samples a LINEAR chain; this is the
    // branching topology in the reverse arrival order, so a start at a leaf
    // walks up through the capped parent before its sibling has a depth.
    expect(JSON.stringify(stackTreeToJson(buildStackTree([...entries].reverse())))).toBe(
      JSON.stringify(stackTreeToJson(roots))
    );
  });

  it('caps a deep chain hanging off a parent LOOP', () => {
    // The maintainer's shape on issue #3155: before loop members were rooted
    // (issue #3069 / PR #3157), a chain hanging off a 2-cycle was invisible
    // rather than fatal, because no member was a root. Rooting them correctly
    // made the chain their subtree — and so reachable by every recursive step.
    const entries: StackTreeEntry[] = [
      {
        stackName: 'LoopA',
        region: 'us-east-1',
        parentStack: 'LoopB',
        parentLogicalId: 'A',
        parentRegion: 'us-east-1',
      },
      {
        stackName: 'LoopB',
        region: 'us-east-1',
        parentStack: 'LoopA',
        parentLogicalId: 'B',
        parentRegion: 'us-east-1',
      },
      ...chainEntries(12_000, 'Hang').map((entry, i) =>
        i === 0
          ? {
              ...entry,
              parentStack: 'LoopA',
              parentLogicalId: 'Hang',
              parentRegion: 'us-east-1',
            }
          : entry
      ),
    ];

    const roots = buildStackTree(entries);
    const { names, maxDepth } = walk(roots);
    expect(names).toHaveLength(12_002);
    expect(new Set(names).size).toBe(12_002);
    expect(maxDepth).toBe(MAX_STACK_TREE_DEPTH);

    // Both loop members stay at the root, as they were before the cap.
    expect(roots.map((r) => r.stackName)).toContain('LoopA');
    expect(roots.map((r) => r.stackName)).toContain('LoopB');
    // The chain still hangs off LoopA for its first MAX_STACK_TREE_DEPTH
    // levels — the cap re-roots, it does not detach the whole chain.
    const loopA = roots.find((r) => r.stackName === 'LoopA')!;
    expect(loopA.children.map((c) => c.stackName)).toEqual(['Hang0']);

    expect(() => renderStackTreeAscii(roots, (node) => node.stackName)).not.toThrow();
    expect(() => JSON.stringify(stackTreeToJson(roots), null, 2)).not.toThrow();

    // The loop topology in the reverse arrival order: the walks then reach the
    // 2-cycle from the far end of the hanging chain first, so the seeded loop
    // is met from below before anything else has a depth. Only `LoopA` is met:
    // the walk halts at the first node carrying a depth, so `LoopB` is never
    // walked to in that pass.
    expect(JSON.stringify(stackTreeToJson(buildStackTree([...entries].reverse())))).toBe(
      JSON.stringify(stackTreeToJson(roots))
    );
    // Bounded for the same reason as the 30000-record case above.
  }, 30_000);

  it('builds the identical tree whatever order the records arrive in', () => {
    // What this pins is the DEPTH PASS, not the cap: the pass memoizes and
    // walks up from an arbitrary start, so an entry order that reaches a chain
    // from its deepest record first — or a reversal of the downward assignment
    // loop — must still produce the identical tree. The cap is asserted by the
    // cases above.
    const entries = chainEntries(MAX_STACK_TREE_DEPTH * 3, 'Order');
    const forward = JSON.stringify(stackTreeToJson(buildStackTree(entries)));
    const reversed = JSON.stringify(stackTreeToJson(buildStackTree([...entries].reverse())));
    expect(reversed).toBe(forward);

    // A full reversal is the degenerate order: every start after the first hits
    // the already-computed short-circuit, so it does one walk. What an
    // INTERLEAVED order adds is a first walk that STARTS at a node the cap
    // re-rooted, before any of the chain above it exists in `depthOf` — so the
    // long second walk assigns downward from a memoized base and crosses a cap
    // reset on the way. (Measured, because the obvious claim is wrong: it is
    // the FORWARD order that stops at memoized nodes of non-zero depth, ~300
    // times; this order's one such stop is at depth 0.)
    const interleaved = [
      entries[MAX_STACK_TREE_DEPTH + 1]!,
      entries[entries.length - 1]!,
      ...entries.filter(
        (_, i) => i !== MAX_STACK_TREE_DEPTH + 1 && i !== entries.length - 1
      ),
    ];
    expect(JSON.stringify(stackTreeToJson(buildStackTree(interleaved)))).toBe(forward);
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
