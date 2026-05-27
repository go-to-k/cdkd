/**
 * Unit tests for `cdkd diff --recursive` (issue #555 A5) — the recursive
 * nested-stack diff walker, the per-resource diff helper, the
 * template-loading helpers, and the JSON / has-changes projections in
 * `src/cli/commands/diff-recursive.ts`.
 *
 * The logger is mocked quiet (DiffCalculator / IntrinsicFunctionResolver
 * both call `getLogger().child(...)`). Templates use only literal property
 * values so the real IntrinsicFunctionResolver never reaches AWS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import {
  buildDiffTree,
  computeStackDiff,
  indexNestedChildTemplates,
  readNestedTemplate,
  nodeHasChanges,
  treeHasChanges,
  diffTreeToJson,
  renderDiffTree,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const NESTED = 'AWS::CloudFormation::Stack';

function res(resourceType: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'pid', resourceType, properties, attributes: {}, dependencies: [] };
}

function st(stackName: string, resources: Record<string, ResourceState>): StackState {
  return { stackName, region: 'us-east-1', resources, outputs: {}, version: 6, lastModified: 0 };
}

/** Fake S3StateBackend whose getState reads from an in-memory map. */
function fakeBackend(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string, _region: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
  } as unknown as S3StateBackend;
}

/** Build a CREATE-only change map (for the pure projection helpers). */
function changeMap(changes: ResourceChange[]): Map<string, ResourceChange> {
  return new Map(changes.map((c) => [c.logicalId, c]));
}

describe('indexNestedChildTemplates', () => {
  it('maps each AWS::CloudFormation::Stack row to its resolved sibling template path', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Plain: { Type: 'AWS::SSM::Parameter', Properties: {} },
        Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
      },
    };
    const out = indexNestedChildTemplates(template, '/tmp/cdk.out/Parent.template.json');
    expect(out).toEqual({ Child: join('/tmp/cdk.out', 'child.json') });
  });

  it('skips nested rows that carry no aws:asset:path metadata', () => {
    const template: CloudFormationTemplate = {
      Resources: { Child: { Type: NESTED, Properties: {} } },
    };
    expect(indexNestedChildTemplates(template, '/tmp/x.json')).toEqual({});
  });

  it('throws on an absolute aws:asset:path', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Child: { Type: NESTED, Metadata: { 'aws:asset:path': '/abs/child.json' }, Properties: {} },
      },
    };
    expect(() => indexNestedChildTemplates(template, '/tmp/x.json')).toThrow(/absolute/);
  });
});

describe('readNestedTemplate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-rec-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads and parses a JSON template from disk', () => {
    const p = join(dir, 't.json');
    writeFileSync(p, JSON.stringify({ Resources: { A: { Type: 'AWS::SSM::Parameter' } } }));
    expect(readNestedTemplate(p).Resources['A']!.Type).toBe('AWS::SSM::Parameter');
  });

  it('throws a clear error on a missing file', () => {
    expect(() => readNestedTemplate(join(dir, 'nope.json'))).toThrow(/Failed to read/);
  });

  it('throws a clear error on invalid JSON', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not json');
    expect(() => readNestedTemplate(p)).toThrow(/Failed to parse/);
  });
});

describe('nodeHasChanges / treeHasChanges', () => {
  const leaf = (id: string, changes: ResourceChange[]): DiffTreeNode => ({
    stackName: id,
    displayName: id,
    region: 'us-east-1',
    changes: changeMap(changes),
    ccApiRoutes: new Map(),
    children: [],
  });

  it('nodeHasChanges is false when every entry is NO_CHANGE', () => {
    const n = leaf('X', [{ logicalId: 'A', changeType: 'NO_CHANGE', resourceType: 'T' }]);
    expect(nodeHasChanges(n)).toBe(false);
  });

  it('nodeHasChanges is true when at least one entry is a real change', () => {
    const n = leaf('X', [
      { logicalId: 'A', changeType: 'NO_CHANGE', resourceType: 'T' },
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'T' },
    ]);
    expect(nodeHasChanges(n)).toBe(true);
  });

  it('treeHasChanges fires when only a deep descendant changed', () => {
    const grandchild = leaf('P~C~G', [{ logicalId: 'G', changeType: 'UPDATE', resourceType: 'T' }]);
    const child = leaf('P~C', [{ logicalId: 'C', changeType: 'NO_CHANGE', resourceType: 'T' }]);
    child.children = [grandchild];
    const root = leaf('P', [{ logicalId: 'R', changeType: 'NO_CHANGE', resourceType: 'T' }]);
    root.children = [child];

    expect(nodeHasChanges(root)).toBe(false);
    expect(treeHasChanges(root)).toBe(true);
  });

  it('treeHasChanges is false when no node anywhere changed', () => {
    const root = leaf('P', [{ logicalId: 'R', changeType: 'NO_CHANGE', resourceType: 'T' }]);
    root.children = [leaf('P~C', [{ logicalId: 'C', changeType: 'NO_CHANGE', resourceType: 'T' }])];
    expect(treeHasChanges(root)).toBe(false);
  });
});

describe('diffTreeToJson', () => {
  it('drops NO_CHANGE, keeps property/attribute changes, and always emits children', () => {
    const node: DiffTreeNode = {
      stackName: 'P',
      displayName: 'P',
      region: 'us-east-1',
      changes: changeMap([
        { logicalId: 'Keep', changeType: 'NO_CHANGE', resourceType: 'T' },
        {
          logicalId: 'Up',
          changeType: 'UPDATE',
          resourceType: 'AWS::SSM::Parameter',
          propertyChanges: [{ path: 'Value', oldValue: 'a', newValue: 'b', requiresReplacement: false }],
        },
      ]),
      ccApiRoutes: new Map(),
      children: [
        {
          stackName: 'P~C',
          displayName: 'P~C',
          region: 'us-east-1',
          changes: changeMap([{ logicalId: 'New', changeType: 'CREATE', resourceType: 'T' }]),
          ccApiRoutes: new Map(),
          children: [],
        },
      ],
    };

    const json = diffTreeToJson(node);
    expect(json.stack).toBe('P');
    expect(json.region).toBe('us-east-1');
    expect(json.changes).toHaveLength(1);
    expect(json.changes[0]!.logicalId).toBe('Up');
    expect(json.changes[0]!.propertyChanges).toHaveLength(1);
    expect(json.children).toHaveLength(1);
    expect(json.children[0]!.changes[0]!.changeType).toBe('CREATE');
    expect(json.children[0]!.children).toEqual([]);
  });

  it('carries attributeChanges (DeletionPolicy flip) through to JSON', () => {
    const node: DiffTreeNode = {
      stackName: 'P',
      displayName: 'P',
      region: 'us-east-1',
      changes: changeMap([
        {
          logicalId: 'Bucket',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          attributeChanges: [{ attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' }],
        },
      ]),
      ccApiRoutes: new Map(),
      children: [],
    };
    const json = diffTreeToJson(node);
    expect(json.changes[0]!.attributeChanges).toEqual([
      { attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' },
    ]);
    expect(json.changes[0]!.propertyChanges).toBeUndefined();
  });
});

describe('renderDiffTree', () => {
  const leaf = (
    stackName: string,
    displayName: string,
    changes: ResourceChange[],
    ccApiRoutes: Map<string, string[]> = new Map()
  ): DiffTreeNode => ({
    stackName,
    displayName,
    region: 'us-east-1',
    changes: changeMap(changes),
    ccApiRoutes,
    children: [],
  });

  it('renders root as "Stack <name>:" and nested children as "Nested stack: <name>" in DFS order', () => {
    const grandchild = leaf('P~C~G', 'P~C~G', [
      { logicalId: 'GrandRes', changeType: 'UPDATE', resourceType: 'AWS::SSM::Parameter', propertyChanges: [{ path: 'Value', oldValue: 'g0', newValue: 'g1', requiresReplacement: false }] },
    ]);
    const child = leaf('P~C', 'P~C', [{ logicalId: 'ChildRes', changeType: 'NO_CHANGE', resourceType: 'T' }]);
    child.children = [grandchild];
    const root = leaf('P', 'P', [{ logicalId: 'NewRes', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket' }]);
    root.children = [child];

    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    expect(text).toContain('Stack P:');
    expect(text).toContain('[+] NewRes (AWS::S3::Bucket)');
    // The unchanged child node is walked silently (no block of its own)...
    expect(text).not.toContain('Nested stack: P~C\n');
    // ...but the changed grandchild gets a Nested stack header.
    expect(text).toContain('Nested stack: P~C~G');
    expect(text).toContain('[~] GrandRes (AWS::SSM::Parameter)');
    expect(text).toContain('- Value:');
    // Root block precedes the grandchild block (DFS).
    expect(text.indexOf('Stack P:')).toBeLessThan(text.indexOf('Nested stack: P~C~G'));
  });

  it('emits nothing for a node (and subtree) with no changes', () => {
    const root = leaf('P', 'P', [{ logicalId: 'A', changeType: 'NO_CHANGE', resourceType: 'T' }]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    expect(lines).toEqual([]);
  });

  it('annotates CREATE / UPDATE lines with [via CC API: <props>] when ccApiRoutes carries the logical id (#614)', () => {
    const root = leaf(
      'P',
      'P',
      [
        { logicalId: 'MyLambda', changeType: 'CREATE', resourceType: 'AWS::Lambda::Function' },
        {
          logicalId: 'OtherFn',
          changeType: 'UPDATE',
          resourceType: 'AWS::Lambda::Function',
          propertyChanges: [{ path: 'Runtime', oldValue: 'nodejs18.x', newValue: 'nodejs20.x', requiresReplacement: false }],
        },
        { logicalId: 'NoTag', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue' },
      ],
      new Map<string, string[]>([
        ['MyLambda', ['LoggingConfig']],
        ['OtherFn', ['LoggingConfig', 'SnapStart']],
      ])
    );
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    // CREATE + UPDATE lines get the annotation; the comma-joined property
    // list appears verbatim so users can audit which property triggered
    // the CC-route.
    expect(text).toContain('[+] MyLambda (AWS::Lambda::Function) [via CC API: LoggingConfig]');
    expect(text).toContain('[~] OtherFn (AWS::Lambda::Function) [via CC API: LoggingConfig, SnapStart]');
    // Sibling without a hit still renders the plain line — no spurious tag.
    expect(text).toContain('[+] NoTag (AWS::SQS::Queue)');
    expect(text).not.toContain('NoTag (AWS::SQS::Queue) [via CC API');
  });

  it('does not annotate DELETE lines (deletes route via state-recorded provisionedBy, not template)', () => {
    const root = leaf(
      'P',
      'P',
      [{ logicalId: 'GoneLambda', changeType: 'DELETE', resourceType: 'AWS::Lambda::Function' }],
      // Even when a hit is recorded, DELETE skips the annotation since
      // routing is not derived from the template at delete time.
      new Map<string, string[]>([['GoneLambda', ['LoggingConfig']]])
    );
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');
    expect(text).toContain('[-] GoneLambda (AWS::Lambda::Function)');
    expect(text).not.toContain('GoneLambda (AWS::Lambda::Function) [via CC API');
  });

  it('renders [requires replacement], attribute changes, and prunes unchanged/intrinsic nested keys', () => {
    const root = leaf('P', 'P', [
      {
        logicalId: 'Bucket',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        propertyChanges: [
          {
            path: 'Config',
            // 'keep' is unchanged, 'ref' is an intrinsic on both sides, only 'changed' differs.
            oldValue: { keep: 'same', changed: 'old', ref: { Ref: 'X' } },
            newValue: { keep: 'same', changed: 'new', ref: { Ref: 'X' } },
            requiresReplacement: true,
          },
        ],
        attributeChanges: [{ attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' }],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    expect(text).toContain('[requires replacement]');
    expect(text).toContain('DeletionPolicy: [metadata only, no AWS API call]');
    expect(text).toContain('old: Delete');
    expect(text).toContain('new: Retain');
    // stripUnchangedValues kept only the changed key, dropped 'keep' (equal) and 'ref' (intrinsic).
    expect(text).toContain('"changed"');
    expect(text).not.toContain('"keep"');
    expect(text).not.toContain('"ref"');
  });
});

describe('computeStackDiff', () => {
  it('reports all CREATE against an empty state', async () => {
    const template: CloudFormationTemplate = {
      Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    };
    const empty = st('S', {});
    const changes = await computeStackDiff(
      empty,
      template,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator()
    );
    expect(changes.get('A')!.changeType).toBe('CREATE');
  });

  it('reports NO_CHANGE when state matches the template', async () => {
    const template: CloudFormationTemplate = {
      Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    };
    const state = st('S', { A: res('AWS::SSM::Parameter', { Value: 'x' }) });
    const changes = await computeStackDiff(
      state,
      template,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator()
    );
    expect(changes.get('A')!.changeType).toBe('NO_CHANGE');
  });
});

describe('buildDiffTree (recursive nested-stack diff)', () => {
  let dir: string;

  // A 3-level tree: Parent -> Child -> Grandchild, each owning one SSM param.
  function writeTemplates(grandchildValue: string): {
    parentTemplate: CloudFormationTemplate;
    nestedTemplates: Record<string, string>;
  } {
    const childPath = join(dir, 'child.json');
    const grandPath = join(dir, 'grand.json');
    writeFileSync(
      grandPath,
      JSON.stringify({
        Resources: { GrandRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: grandchildValue } } },
      })
    );
    writeFileSync(
      childPath,
      JSON.stringify({
        Resources: {
          ChildRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'c1' } },
          Grandchild: { Type: NESTED, Metadata: { 'aws:asset:path': 'grand.json' }, Properties: {} },
        },
      })
    );
    const parentTemplate: CloudFormationTemplate = {
      Resources: {
        ParentRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'p1' } },
        Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
      },
    };
    return { parentTemplate, nestedTemplates: { Child: childPath } };
  }

  function deployedStates(grandchildValue: string): Record<string, StackState> {
    return {
      Parent: st('Parent', {
        ParentRes: res('AWS::SSM::Parameter', { Value: 'p1' }),
        Child: res(NESTED, {}),
      }),
      'Parent~Child': st('Parent~Child', {
        ChildRes: res('AWS::SSM::Parameter', { Value: 'c1' }),
        Grandchild: res(NESTED, {}),
      }),
      'Parent~Child~Grandchild': st('Parent~Child~Grandchild', {
        GrandRes: res('AWS::SSM::Parameter', { Value: grandchildValue }),
      }),
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-tree-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds parent -> child -> grandchild and detects an UPDATE deep in the tree', async () => {
    const { parentTemplate, nestedTemplates } = writeTemplates('g-new');
    // State has the OLD grandchild value -> grandchild UPDATE, everything else NO_CHANGE.
    const backend = fakeBackend(deployedStates('g-old'));

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate,
      nestedTemplates,
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
    });

    expect(root.children).toHaveLength(1);
    const child = root.children[0]!;
    expect(child.stackName).toBe('Parent~Child');
    expect(child.children).toHaveLength(1);
    const grandchild = child.children[0]!;
    expect(grandchild.stackName).toBe('Parent~Child~Grandchild');

    expect(nodeHasChanges(root)).toBe(false);
    expect(nodeHasChanges(child)).toBe(false);
    expect(nodeHasChanges(grandchild)).toBe(true);
    expect(grandchild.changes.get('GrandRes')!.changeType).toBe('UPDATE');
    expect(treeHasChanges(root)).toBe(true);
  });

  it('does not descend when recursive is false', async () => {
    const { parentTemplate, nestedTemplates } = writeTemplates('g-old');
    const backend = fakeBackend(deployedStates('g-old'));

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate,
      nestedTemplates,
      recursive: false,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
    });

    expect(root.children).toEqual([]);
    expect(treeHasChanges(root)).toBe(false);
  });

  it('synthesizes an all-CREATE block for an undeployed nested child (no child state)', async () => {
    const { parentTemplate, nestedTemplates } = writeTemplates('g-old');
    // Parent state exists (Child row present, NO_CHANGE) but the child + grandchild
    // were never deployed -> their state files are missing.
    const backend = fakeBackend({
      Parent: st('Parent', {
        ParentRes: res('AWS::SSM::Parameter', { Value: 'p1' }),
        Child: res(NESTED, {}),
      }),
    });

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate,
      nestedTemplates,
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
    });

    expect(nodeHasChanges(root)).toBe(false); // parent unchanged
    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')!.changeType).toBe('CREATE');
    expect(child.changes.get('Grandchild')!.changeType).toBe('CREATE');
    // Grandchild recursion: template row present, no state -> all CREATE.
    const grandchild = child.children[0]!;
    expect(grandchild.changes.get('GrandRes')!.changeType).toBe('CREATE');
    expect(treeHasChanges(root)).toBe(true);
  });

  it('recursively reports DELETE for a nested stack removed from the template', async () => {
    // Parent template no longer declares the Child nested stack, but state still
    // carries the whole Parent -> Child -> Grandchild tree.
    const parentTemplate: CloudFormationTemplate = {
      Resources: { ParentRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'p1' } } },
    };
    const backend = fakeBackend(deployedStates('g-old'));

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate,
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
    });

    // Parent's own diff: the Child nested-stack row is in state but not template -> DELETE.
    expect(root.changes.get('Child')!.changeType).toBe('DELETE');
    expect(root.children).toHaveLength(1);
    const child = root.children[0]!;
    expect(child.stackName).toBe('Parent~Child');
    expect(child.changes.get('ChildRes')!.changeType).toBe('DELETE');
    expect(child.changes.get('Grandchild')!.changeType).toBe('DELETE');
    const grandchild = child.children[0]!;
    expect(grandchild.changes.get('GrandRes')!.changeType).toBe('DELETE');
    expect(treeHasChanges(root)).toBe(true);
  });

  it('populates ccApiRoutes for resources whose template uses #614 silent-drop properties (e.g. Lambda LoggingConfig)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        SilentDropLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: 'foo',
            Role: 'arn:aws:iam::1:role/r',
            Code: { ZipFile: 'x' },
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            // Top-level CFn property cdkd's SDK provider does not yet wire.
            LoggingConfig: { LogFormat: 'JSON' },
          },
        },
        // A sibling Lambda whose template uses NO silent-drop property —
        // the route should NOT pick it up, so the rendered diff stays clean.
        OkayLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: 'bar',
            Role: 'arn:aws:iam::1:role/r',
            Code: { ZipFile: 'x' },
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
          },
        },
      },
    };
    const backend = fakeBackend({});

    const root = await buildDiffTree({
      stackName: 'Leaf',
      displayName: 'Leaf',
      region: 'us-east-1',
      template,
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
    });

    expect(root.ccApiRoutes.get('SilentDropLambda')).toEqual(['LoggingConfig']);
    expect(root.ccApiRoutes.has('OkayLambda')).toBe(false);

    // The annotation makes it into the human renderer + the JSON projection.
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    expect(lines.join('\n')).toContain(
      '[+] SilentDropLambda (AWS::Lambda::Function) [via CC API: LoggingConfig]'
    );

    const json = diffTreeToJson(root);
    const silentDropChange = json.changes.find((c) => c.logicalId === 'SilentDropLambda');
    const okayChange = json.changes.find((c) => c.logicalId === 'OkayLambda');
    expect(silentDropChange?.ccApi).toEqual(['LoggingConfig']);
    expect(okayChange?.ccApi).toBeUndefined();
  });

  it('treats a leaf stack with no nested rows as a single node', async () => {
    const template: CloudFormationTemplate = {
      Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    };
    const backend = fakeBackend({ Leaf: st('Leaf', { A: res('AWS::SSM::Parameter', { Value: 'x' }) }) });

    const root = await buildDiffTree({
      stackName: 'Leaf',
      displayName: 'Leaf',
      region: 'us-east-1',
      template,
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
    });

    expect(root.children).toEqual([]);
    expect(treeHasChanges(root)).toBe(false);
  });

  it('throws when a template nested row lacks a synthesized child template path', async () => {
    const parentTemplate: CloudFormationTemplate = {
      Resources: { Child: { Type: NESTED, Properties: {} } },
    };
    const backend = fakeBackend({ Parent: st('Parent', { Child: res(NESTED, {}) }) });

    await expect(
      buildDiffTree({
        stackName: 'Parent',
        displayName: 'Parent',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: {}, // no path for Child
        recursive: true,
        stateBackend: backend,
        diffCalculator: new DiffCalculator(),
      })
    ).rejects.toThrow(/Nested template file not found/);
  });
});
