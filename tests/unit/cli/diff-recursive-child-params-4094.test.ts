/**
 * go-to-k/cdkd#4094: `buildDiffTree` resolved a nested child's input
 * `Parameters` against the node's INPUT parameters (none at the root) and no
 * condition map, while the deploy resolves that row on the parent engine's
 * context: bound template parameters (defaults, SSM-typed lookups) and
 * evaluated conditions. A child fed `{Ref: <parent template param>}`, or an
 * `Fn::If` in its row, therefore diffed as a phantom UPDATE on every
 * `cdkd diff --recursive`, and `--fail` never went green.
 *
 * End to end through `buildDiffTree` with the real resolver.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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

// The recursive walk warms the create-only `DescribeType` cache; answered
// with a refusal, which that best-effort lookup tolerates.
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

import {
  buildDiffTree,
  diffTreeToJson,
  renderChangeLines,
  renderOutputChangeLines,
  treeHasChanges,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { getLogger } from '../../../src/utils/logger.js';

const NOECHO = 'noecho-plain-4094';
const TOKEN = '{{resolve:secretsmanager:cdkd-4094-secret:SecretString:k::}}';

function res(properties: Record<string, unknown>): ResourceState {
  return {
    physicalId: 'pid',
    resourceType: 'AWS::SSM::Parameter',
    properties,
    attributes: {},
    dependencies: [],
  };
}

function st(resources: Record<string, ResourceState>, stackName: string): StackState {
  return { stackName, region: 'us-east-1', resources, outputs: {}, version: 6, lastModified: 0 };
}

function backendOf(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'e' } : null;
    },
    saveState: vi.fn(),
    putState: vi.fn(),
    deleteState: vi.fn(),
  } as unknown as S3StateBackend;
}

function printed(node: DiffTreeNode): string {
  const lines: string[] = [];
  renderChangeLines(node.changes, (line) => lines.push(line));
  renderOutputChangeLines(node.outputChanges, (line) => lines.push(line));
  return `${lines.join('\n')}\n${JSON.stringify(diffTreeToJson(node))}`;
}

function warned(): string {
  return vi
    .mocked(getLogger().warn)
    .mock.calls.flat()
    .map((arg) => String(arg))
    .join('\n');
}

describe('cdkd diff --recursive resolves a child row against the parent bound parameters and conditions (#4094)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-4094-'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A root whose one nested row hands the child `P: <rowValue>`; the child
   * stores `ChildRes.Value = <childValue>` and reads `P` through `childReads`.
   * The parent row's stored `Parameters` equal what the row resolves to, so
   * the ROOT diffs clean whenever the child input resolves as the deploy did.
   */
  async function treeOf(args: {
    rootParameters: Record<string, unknown>;
    rootConditions?: Record<string, unknown>;
    rowValue: unknown;
    storedRowValue: unknown;
    childParameter: Record<string, unknown>;
    childValue: unknown;
    childReads?: unknown;
    childConditions?: Record<string, unknown>;
    inputParameters?: Record<string, unknown>;
  }): Promise<DiffTreeNode> {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { P: args.childParameter },
        ...(args.childConditions && { Conditions: args.childConditions }),
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: args.childReads ?? { Ref: 'P' } },
          },
        },
      })
    );
    const backend = backendOf({
      Root: st(
        {
          Child: {
            ...res({ Parameters: { P: args.storedRowValue } }),
            resourceType: 'AWS::CloudFormation::Stack',
          },
        },
        'Root'
      ),
      'Root~Child': st({ ChildRes: res({ Value: args.childValue }) }, 'Root~Child'),
    });
    return buildDiffTree({
      stackName: 'Root',
      displayName: 'Root',
      region: 'us-east-1',
      template: {
        Parameters: args.rootParameters,
        ...(args.rootConditions && { Conditions: args.rootConditions }),
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { P: args.rowValue } },
          },
        },
      } as CloudFormationTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      ...(args.inputParameters && { parameters: args.inputParameters }),
      isNestedChild: false,
    });
  }

  it("resolves a child input Ref to a root parameter bound from its Default: no phantom UPDATE", async () => {
    const root = await treeOf({
      rootParameters: { Stage: { Type: 'String', Default: 'prod' } },
      rowValue: { Ref: 'Stage' },
      storedRowValue: 'prod',
      childParameter: { Type: 'String' },
      childValue: 'prod',
    });

    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')?.changeType).toBe('NO_CHANGE');
    expect(root.changes.get('Child')?.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
  });

  it('still reports a real change of the Default-bound value in the child', async () => {
    const root = await treeOf({
      rootParameters: { Stage: { Type: 'String', Default: 'prod' } },
      rowValue: { Ref: 'Stage' },
      storedRowValue: 'dev',
      childParameter: { Type: 'String' },
      childValue: 'dev',
    });

    expect(root.children[0]!.changes.get('ChildRes')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: 'dev', newValue: 'prod' }),
    ]);
  });

  it("takes an Fn::If in the child row down the branch the root's condition selects", async () => {
    const root = await treeOf({
      rootParameters: { Stage: { Type: 'String', Default: 'prod' } },
      rootConditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
      rowValue: { 'Fn::If': ['IsProd', 'on', 'off'] },
      storedRowValue: 'on',
      childParameter: { Type: 'String' },
      childValue: 'on',
    });

    expect(root.children[0]!.changes.get('ChildRes')?.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
    // The resolver warns and takes FALSE when the condition map lacks the name.
    expect(warned()).not.toContain('IsProd');
  });

  it("takes an Fn::If in the child row down the FALSE branch when the root's condition is false", async () => {
    // A negative control for the case above: the verdict is the root's, not a
    // constant, so a condition that evaluates false still selects `off`.
    const root = await treeOf({
      rootParameters: { Stage: { Type: 'String', Default: 'dev' } },
      rootConditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
      rowValue: { 'Fn::If': ['IsProd', 'on', 'off'] },
      storedRowValue: 'on',
      childParameter: { Type: 'String' },
      childValue: 'on',
    });

    expect(root.children[0]!.changes.get('ChildRes')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: 'on', newValue: 'off' }),
    ]);
    expect(warned()).not.toContain('IsProd');
  });

  it('hands a list-typed root parameter down joined, as the deploy puts it on the wire', async () => {
    // The bound bag holds `Subnets` as an ARRAY. Passed on as one, the child's
    // binding (scalars only) ignores it and binds its own `Default` instead.
    const root = await treeOf({
      rootParameters: { Subnets: { Type: 'CommaDelimitedList', Default: 'a,b' } },
      rowValue: { Ref: 'Subnets' },
      storedRowValue: ['a', 'b'],
      childParameter: { Type: 'CommaDelimitedList', Default: 'x' },
      childReads: { 'Fn::Join': ['|', { Ref: 'P' }] },
      childValue: 'a|b',
    });

    expect(root.children[0]!.changes.get('ChildRes')?.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
  });

  it('keeps a redacted list-typed parent parameter in the shape the child state holds', async () => {
    // A node fed a secret token for a list-typed parameter binds it as an
    // ARRAY of expressions (`tokenValueForComparison`); the child must still
    // receive the token itself, which it re-shapes against its own type. The
    // child's `Fn::If` makes its binding observable: handed the array, the
    // binding fails, its conditions are skipped and the row reads `x`.
    const root = await treeOf({
      rootParameters: { Tok: { Type: 'CommaDelimitedList' } },
      inputParameters: { Tok: TOKEN },
      rowValue: { Ref: 'Tok' },
      storedRowValue: [TOKEN],
      childParameter: { Type: 'CommaDelimitedList' },
      childConditions: { Always: { 'Fn::Equals': ['a', 'a'] } },
      childReads: { 'Fn::If': ['Always', { Ref: 'P' }, 'x'] },
      childValue: [TOKEN],
    });

    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')?.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
  });

  it('keeps a redacted String parent parameter as its expression in the child', async () => {
    const root = await treeOf({
      rootParameters: { Tok: { Type: 'String' } },
      inputParameters: { Tok: TOKEN },
      rowValue: { Ref: 'Tok' },
      storedRowValue: TOKEN,
      childParameter: { Type: 'String' },
      childValue: TOKEN,
    });

    expect(root.children[0]!.changes.get('ChildRes')?.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
  });

  it('falls back to the input bag when the node cannot bind its own parameters', async () => {
    // `Req` has no Default and no value, so this node's binding fails; the row
    // still resolves `{Ref: In}` from the bag handed to the node, as before.
    const root = await treeOf({
      rootParameters: { In: { Type: 'String' }, Req: { Type: 'String' } },
      inputParameters: { In: 'handed-down' },
      rowValue: { Ref: 'In' },
      storedRowValue: 'handed-down',
      childParameter: { Type: 'String' },
      childValue: 'handed-down',
    });

    expect(root.children[0]!.changes.get('ChildRes')?.changeType).toBe('NO_CHANGE');
  });

  it('omits a row parameter whose Fn::If selects AWS::NoValue, as the deploy does', async () => {
    // The deploy drops the key, so the child sees no value for `P`. Its own
    // binding fails on `Q` here, which leaves the handed-down bag as its
    // parameters: the `Ref` must stay unresolved, never become the NoValue
    // marker.
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { P: { Type: 'String' }, Q: { Type: 'String' } },
        Resources: {
          ChildRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'P' } } },
        },
      })
    );
    const backend = backendOf({
      Root: st(
        {
          Child: {
            ...res({ Parameters: {} }),
            resourceType: 'AWS::CloudFormation::Stack',
          },
        },
        'Root'
      ),
      'Root~Child': st({ ChildRes: res({ Value: 'stored' }) }, 'Root~Child'),
    });
    const root = await buildDiffTree({
      stackName: 'Root',
      displayName: 'Root',
      region: 'us-east-1',
      template: {
        Parameters: { Stage: { Type: 'String', Default: 'dev' } },
        Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: {
              Parameters: { P: { 'Fn::If': ['IsProd', 'on', { Ref: 'AWS::NoValue' }] } },
            },
          },
        },
      } as CloudFormationTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    expect(root.children[0]!.changes.get('ChildRes')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: 'stored', newValue: { Ref: 'P' } }),
    ]);
  });

  it("masks a root NoEcho Default the child now resolves, on both sides of its row", async () => {
    // Before the fix the child's new side stayed the unresolved `Ref`; with the
    // bound bag it is the NoEcho value, which the inherited corpus must mask.
    const root = await treeOf({
      rootParameters: { Pw: { Type: 'String', NoEcho: true, Default: NOECHO } },
      rowValue: { Ref: 'Pw' },
      storedRowValue: 'rotated-old',
      childParameter: { Type: 'String' },
      childValue: 'rotated-old',
    });

    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: '***', newValue: '***' }),
    ]);
    expect(printed(root)).not.toContain(NOECHO);
    expect(printed(child)).not.toContain(NOECHO);
    const logged = [getLogger().debug, getLogger().info, getLogger().warn, getLogger().error]
      .flatMap((fn) => vi.mocked(fn).mock.calls.flat())
      .map((arg) => String(arg))
      .join('\n');
    expect(logged).not.toContain(NOECHO);
  });
});
