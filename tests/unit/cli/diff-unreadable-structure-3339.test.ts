/**
 * Issue go-to-k/cdkd#3339: `cdkd diff` carried an unreadable CONTAINER as a
 * stand-in string in the same list as the dropped entries' logical ids, so a
 * key a record can hold read exactly like the container:
 *
 * - an entry keyed `(resources map)` read like an unreadable `resources` map,
 *   rendered bare, and lost the "shown above as a create" sentence;
 * - likewise `(orphans container)`;
 * - an orphan record with no string `logicalId` was `''` in `--json`, exactly
 *   like a `resources` entry keyed `''`.
 *
 * The node now carries each in its own field — `unreadable` (entry ids),
 * `unreadableContainers`, `unreadableOrphans` (`null` for no id) — and the
 * preview renders a container's name from the field, never from a spelling.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

import {
  buildDiffTree,
  diffTreeToJson,
  renderDiffTree,
  treeHasChanges,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const STACK = 'S';
const REGION = 'us-east-1';
const EMPTY: CloudFormationTemplate = { Resources: {} };

function record(fields: Partial<Record<keyof StackState, unknown>> = {}): StackState {
  return {
    stackName: STACK,
    region: REGION,
    version: 10,
    resources: {},
    outputs: {},
    lastModified: 0,
    ...fields,
  } as StackState;
}

async function diff(
  states: Record<string, StackState>,
  opts: { template?: CloudFormationTemplate; preview?: boolean; recursive?: boolean } = {}
): Promise<DiffTreeNode> {
  return buildDiffTree({
    stackName: STACK,
    displayName: STACK,
    region: REGION,
    template: opts.template ?? EMPTY,
    nestedTemplates: {},
    recursive: opts.recursive ?? false,
    isNestedChild: false,
    stateBackend: {
      getState: async (name: string) => (states[name] ? { state: states[name], etag: 'e' } : null),
    } as unknown as S3StateBackend,
    diffCalculator: new DiffCalculator(),
    ...(opts.preview && {
      previewOrphanAdoption: (async () => ({ adopted: {}, refusals: [] })) as unknown as Parameters<
        typeof buildDiffTree
      >[0]['previewOrphanAdoption'],
    }),
  });
}

function preview(node: DiffTreeNode): string {
  const lines: string[] = [];
  renderDiffTree(node, true, (m) => lines.push(m));
  return lines.join('\n');
}

describe('cdkd diff carries an unreadable container in structure (go-to-k/cdkd#3339)', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [container, name, torn] of [
    ['resources', '(resources map)', { resources: 'abcdef' }],
    ['orphans', '(orphans container)', { orphans: 'abc' }],
  ] as const) {
    it(`an ENTRY keyed ${name} is an entry, not the ${container} container`, async () => {
      const plantedNode = await diff({ [STACK]: record({ resources: { [name]: null } }) });
      const tornNode = await diff({ [STACK]: record(torn) });

      // The node says which: an entry id in one, a container in the other.
      expect(plantedNode.unreadable).toEqual([name]);
      expect(plantedNode.unreadableContainers).toEqual([]);
      expect(tornNode.unreadable).toEqual([]);
      expect(tornNode.unreadableContainers).toEqual([container]);

      // --json distinguishes them, and both still count for --fail.
      const plantedJson = diffTreeToJson(plantedNode);
      const tornJson = diffTreeToJson(tornNode);
      expect(plantedJson.unreadable).toEqual([name]);
      expect(plantedJson.unreadableContainers).toEqual([]);
      expect(tornJson.unreadableContainers).toEqual([container]);
      expect(tornJson.unreadable).toEqual([]);
      expect(treeHasChanges(plantedNode)).toBe(true);
      expect(treeHasChanges(tornNode)).toBe(true);

      // The preview renders the planted id QUOTED, as any id holding a space,
      // and keeps the sentence about ids the template declares...
      const planted = preview(plantedNode);
      expect(planted).toContain(`1 state record row(s) could not be read: "${name}".`);
      expect(planted).toContain('shown above as a create');
      // ...while the real container renders bare, from the field, without it.
      const real = preview(tornNode);
      expect(real).toContain(`1 state record row(s) could not be read: ${name}.`);
      expect(real).not.toContain('shown above as a create');
    });
  }

  it('an orphan record with no id is `null`, apart from an entry keyed empty', async () => {
    const orphanNode = await diff(
      { [STACK]: record({ orphans: [{ logicalId: 5, orphanedAt: 1 }] }) },
      { preview: true }
    );
    const entryNode = await diff({ [STACK]: record({ resources: { '': null } }) });

    expect(diffTreeToJson(orphanNode).unreadableOrphans).toEqual([null]);
    expect(diffTreeToJson(orphanNode).unreadable).toEqual([]);
    expect(diffTreeToJson(entryNode).unreadable).toEqual(['']);
    expect(diffTreeToJson(entryNode).unreadableOrphans).toEqual([]);
    // Still a change for --fail, and still named in the preview by the
    // warning's stand-in.
    expect(treeHasChanges(orphanNode)).toBe(true);
    expect(preview(orphanNode)).toContain('1 state record row(s) could not be read: <unrenderable>.');
  });

  it('quotes an orphan record whose id is spelled like a container', async () => {
    // The orphan loop's own `displayLogicalId` call, apart from the entry
    // loop's: the id stays raw in --json and renders quoted in the preview.
    const node = await diff(
      { [STACK]: record({ orphans: [{ logicalId: '(orphans container)', orphanedAt: 1 }] }) },
      { preview: true }
    );
    expect(diffTreeToJson(node).unreadableOrphans).toEqual(['(orphans container)']);
    expect(diffTreeToJson(node).unreadableContainers).toEqual([]);
    expect(preview(node)).toContain('1 state record row(s) could not be read: "(orphans container)".');
  });

  it('keeps the create sentence for a node whose only rows are orphan records', async () => {
    // A dropped orphan record the template still declares previews as a CREATE,
    // so the sentence applies; the suppression is for CONTAINERS only.
    const node = await diff(
      { [STACK]: record({ orphans: [{ logicalId: 'Gone', orphanedAt: 1 }] }) },
      { preview: true }
    );
    expect(node.unreadable).toEqual([]);
    expect(node.unreadableOrphans).toEqual(['Gone']);
    expect(preview(node)).toContain(
      '1 state record row(s) could not be read: Gone. One the template still declares is shown above as a create'
    );
  });

  it('names the rows in record order: entries, then the orphans container', async () => {
    const node = await diff({ [STACK]: record({ resources: { A: null }, orphans: 'abc' }) });
    expect(preview(node)).toContain(
      '2 state record row(s) could not be read: A, (orphans container).'
    );
  });

  it('caps the preview at ten names ACROSS the fields, counting the container', async () => {
    const resources: Record<string, null> = {};
    const ids = Array.from({ length: 10 }, (_, i) => `Row${i}`);
    for (const id of ids) resources[id] = null;
    const node = await diff({ [STACK]: record({ resources, orphans: 'abc' }) });
    const text = preview(node);
    expect(text).toContain(`11 state record row(s) could not be read: ${ids.join(', ')} and 1 more.`);
    expect(text).not.toContain('(orphans container)');
  });

  it('caps the orphan records too, after the resources container', async () => {
    // The other arm of the cap: the entry loop never runs here (an unreadable
    // map has no entries), so only the orphan loop's own check stops at ten.
    const orphans = Array.from({ length: 11 }, (_, i) => ({ logicalId: `O${i}`, orphanedAt: 1 }));
    const node = await diff({ [STACK]: record({ resources: 'abcdef', orphans }) }, { preview: true });
    expect(node.unreadableContainers).toEqual(['resources']);
    expect(node.unreadableOrphans).toHaveLength(11);
    const names = ['(resources map)', ...orphans.slice(0, 9).map((o) => o.logicalId)];
    expect(preview(node)).toContain(
      `12 state record row(s) could not be read: ${names.join(', ')} and 2 more.`
    );
  });

  it('carries the container out of a DELETED nested child too', async () => {
    // `buildDeletedSubtree` builds its own node from the same load, so its
    // wiring is a separate site from `buildDiffTree`'s.
    const parent = record({
      resources: {
        Gone: { physicalId: 'arn:child', resourceType: 'AWS::CloudFormation::Stack', properties: {} },
      },
    });
    const child = { ...record({ resources: 'abcdef' }), stackName: `${STACK}~Gone` };
    const node = await diff({ [STACK]: parent, [`${STACK}~Gone`]: child }, { recursive: true });
    const kid = node.children.find((c) => c.stackName === `${STACK}~Gone`);
    expect(kid, 'the deleted child node is missing').toBeDefined();
    expect(kid!.unreadableContainers).toEqual(['resources']);
    expect(diffTreeToJson(node).children[0]!.unreadableContainers).toEqual(['resources']);
    expect(kid!.unreadableOrphans).toEqual([]);
  });

  it('CONTROL: a healthy record has all three fields empty in --json', async () => {
    const json = diffTreeToJson(await diff({ [STACK]: record() }));
    expect(json.unreadable).toEqual([]);
    expect(json.unreadableContainers).toEqual([]);
    expect(json.unreadableOrphans).toEqual([]);
  });
});
