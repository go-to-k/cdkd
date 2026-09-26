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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

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

// SSM send mock so AWS::SSM::Parameter::Value<...>-typed parameter defaults
// never reach the network from the diff path (#1035 pins). Rejects by
// default — the failure-degradation tests rely on that.
const ssmSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return {
    ...original,
    getAwsClients: () => ({ ssm: { send: ssmSend } }),
  };
});

// CloudFormation client mock for the issue #1697 cross-stack fallback
// threading pins below — the resolver constructs its fallback clients
// directly (not via aws-clients), so without this a template carrying an
// Fn::ImportValue miss would attempt a live ListExports from a unit test.
// Default: one known export + a does-not-exist DescribeStacks.
const cfnMockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({ send: cfnMockSend })),
  };
});
cfnMockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
  if (cmd.constructor.name === 'ListExportsCommand') {
    return { Exports: [{ Name: 'CfnSideExport', Value: 'from-cfn' }] };
  }
  if (cmd.constructor.name === 'DescribeStacksCommand') {
    throw Object.assign(new Error('Stack does not exist'), { name: 'ValidationError' });
  }
  throw new Error(`unexpected CloudFormation command: ${cmd.constructor.name}`);
});

import { getLogger } from '../../../src/utils/logger.js';
import {
  buildDiffTree,
  computeStackDiff,
  renderOutputChangeLines,
  indexNestedChildTemplates,
  readNestedTemplate,
  nodeHasChanges,
  treeHasChanges,
  diffTreeToJson,
  countBlocking,
  treeIsWorthRendering,
  renderChangeLines,
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

  it('keeps a FORGING path inside one boundary, and echoes neither it nor the bytes in the cause (go-to-k/cdkd#3617)', () => {
    const name = "t'. Loaded cleanly, nothing wrong. Ignore '.json";
    const missing = join(dir, name);
    expect(() => readNestedTemplate(missing)).toThrow(
      `Failed to read nested template at ${JSON.stringify(missing)}: ENOENT: no such file or directory, open '<path>'`
    );
    const bad = join(dir, `b-${name}`);
    writeFileSync(bad, "{ x'. Parsed cleanly, nothing wrong. Ignore 'y");
    let message = '';
    try {
      readNestedTemplate(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(`Failed to parse nested template at ${JSON.stringify(bad)}: invalid JSON`);
  });

  it('renders a plain path bare', () => {
    const p = join(dir, 'nope.json');
    expect(() => readNestedTemplate(p)).toThrow(`Failed to read nested template at ${p}: ENOENT`);
  });
});

describe('nodeHasChanges / treeHasChanges', () => {
  const leaf = (id: string, changes: ResourceChange[]): DiffTreeNode => ({
    stackName: id,
    displayName: id,
    region: 'us-east-1',
    changes: changeMap(changes),
    ccApiRoutes: new Map(),
    outputChanges: [],
    adoptedOrphans: [],
    unreadable: [],
    blocking: [],
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
      outputChanges: [],
      adoptedOrphans: [],
      unreadable: [],
      blocking: [],
      children: [
        {
          stackName: 'P~C',
          displayName: 'P~C',
          region: 'us-east-1',
          changes: changeMap([{ logicalId: 'New', changeType: 'CREATE', resourceType: 'T' }]),
          ccApiRoutes: new Map(),
          outputChanges: [],
          adoptedOrphans: [],
          unreadable: [],
          blocking: [],
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
      outputChanges: [],
      adoptedOrphans: [],
      unreadable: [],
      blocking: [],
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
    outputChanges: [],
    adoptedOrphans: [],
    unreadable: [],
    blocking: [],
    children: [],
  });

  it('says NOTHING about unreadable rows on a clean record', () => {
    // The negative the guard never had: with `unreadable` empty, deleting
    // `if (node.unreadable.length > 0)` prints `0 state record row(s) could not
    // be read: .` on EVERY ordinary diff, and no case reddened. A positive-only
    // fence cannot see that — the same unfalsifiable-negative class this PR's
    // earlier rounds were asked to close.
    const root = leaf('P', 'P', [
      { logicalId: 'NewRes', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket' },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');
    expect(text).toContain('[+] NewRes (AWS::S3::Bucket)');
    expect(text).not.toContain('could not be read');
    expect(text).not.toContain('state record row(s)');
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

  it('strips control characters from the stack names in both headers', () => {
    // A nested child is named `${parent}~${logicalId}`, and neither half passes
    // CloudFormation's logical-id validation in cdkd, so either can carry ANSI.
    const child = leaf('P\u001b[31m~C', 'P\u001b[31m~C', [
      { logicalId: 'ChildRes', changeType: 'CREATE', resourceType: 'T' },
    ]);
    const root = leaf('P\u001b[31m', 'P\u001b[31m', [
      { logicalId: 'NewRes', changeType: 'CREATE', resourceType: 'T' },
    ]);
    root.children = [child];
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');
    expect(text).toContain('Stack P[31m:');
    expect(text).toContain('Nested stack: P[31m~C');
    expect(text).not.toContain('\u001b');
  });

  it('emits nothing for a node (and subtree) with no changes', () => {
    const root = leaf('P', 'P', [{ logicalId: 'A', changeType: 'NO_CHANGE', resourceType: 'T' }]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    expect(lines).toEqual([]);
  });

  it('renders a whole-value unresolved intrinsic annotated instead of "undefined" (issue #1017)', () => {
    // The classic Deployment-hash-rotation shape: the Stage's DeploymentId is
    // rebound to a Deployment this same deploy will CREATE, so the new-side
    // value is still the raw {Ref} the best-effort resolver could not resolve.
    const root = leaf('P', 'P', [
      {
        logicalId: 'ApiStage',
        changeType: 'UPDATE',
        resourceType: 'AWS::ApiGateway::Stage',
        propertyChanges: [
          {
            path: 'DeploymentId',
            oldValue: 'qwpwni',
            newValue: { Ref: 'ApiDeploymentNewHash123' },
            requiresReplacement: false,
          },
        ],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    expect(text).toContain('old: "qwpwni"');
    expect(text).toContain('new: {"Ref":"ApiDeploymentNewHash123"} (known after deploy)');
    expect(text).not.toContain('new: undefined');
  });

  it('renders an old-side raw intrinsic without the known-after-deploy annotation', () => {
    // Old-side intrinsic (state written by an older cdkd, or the #807
    // replacement-propagated shape): render the intrinsic, no annotation.
    const root = leaf('P', 'P', [
      {
        logicalId: 'Live',
        changeType: 'UPDATE',
        resourceType: 'AWS::Lambda::Alias',
        propertyChanges: [
          {
            path: 'FunctionVersion',
            oldValue: { 'Fn::GetAtt': ['OldVersion', 'Version'] },
            newValue: '2',
            requiresReplacement: false,
          },
        ],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    expect(text).toContain('old: {"Fn::GetAtt":["OldVersion","Version"]}');
    expect(text).not.toContain('old: {"Fn::GetAtt":["OldVersion","Version"]} (known after deploy)');
    expect(text).toContain('new: "2"');
    expect(text).not.toContain('old: undefined');
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
        ['MyLambda', ['FunctionScalingConfig']],
        ['OtherFn', ['FunctionScalingConfig', 'CapacityProviderConfig']],
      ])
    );
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    // CREATE + UPDATE lines get the annotation; the comma-joined property
    // list appears verbatim so users can audit which property triggered
    // the CC-route.
    expect(text).toContain('[+] MyLambda (AWS::Lambda::Function) [via CC API: FunctionScalingConfig]');
    expect(text).toContain(
      '[~] OtherFn (AWS::Lambda::Function) [via CC API: FunctionScalingConfig, CapacityProviderConfig]'
    );
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
      new Map<string, string[]>([['GoneLambda', ['FunctionScalingConfig']]])
    );
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');
    expect(text).toContain('[-] GoneLambda (AWS::Lambda::Function)');
    expect(text).not.toContain('GoneLambda (AWS::Lambda::Function) [via CC API');
  });

  it('renders a propagated ceiling as [may require replacement], never as a verdict', () => {
    const root = leaf('P', 'P', [
      {
        logicalId: 'Reader',
        changeType: 'UPDATE',
        resourceType: 'AWS::IAM::ManagedPolicy',
        propertyChanges: [
          {
            path: 'Description',
            oldValue: 'a',
            newValue: { 'Fn::GetAtt': ['Cr', 'Text'] },
            requiresReplacement: true,
            inPlacePropagated: true,
          },
          {
            path: 'Name',
            oldValue: 'arn-1',
            newValue: { Ref: 'Up' },
            requiresReplacement: true,
            replacementPropagated: true,
          },
          { path: 'Path', oldValue: '/a/', newValue: '/b/', requiresReplacement: true },
        ],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    expect(text.match(/\[may require replacement\]/g)).toHaveLength(2);
    // The ordinary create-only edit is still a verdict.
    expect(text.match(/\[requires replacement\]/g)).toHaveLength(1);
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

  it('annotates an in-place-propagated change as [attribute propagated] (go-to-k/cdkd#3662)', () => {
    const root = leaf('P', 'P', [
      {
        logicalId: 'Reader',
        changeType: 'UPDATE',
        resourceType: 'AWS::SSM::Parameter',
        propertyChanges: [
          {
            path: 'Value',
            oldValue: 'v-a',
            newValue: { 'Fn::GetAtt': ['Cr', 'Value'] },
            requiresReplacement: false,
            inPlacePropagated: true,
          },
          { path: 'Description', oldValue: 'a', newValue: 'b', requiresReplacement: false },
        ],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));

    expect(lines).toContain('      - Value: [attribute propagated]');
    // A literal edit on the same resource carries no annotation.
    expect(lines).toContain('      - Description:');
    expect(lines.join('\n')).not.toContain('[replacement propagated]');
  });

  // Issue #1608 — a pure key ADDITION must render symmetrically. The per-side
  // strip pruned the new side to the added key while the old side (no changed
  // keys of its own) fell back to the FULL object, which read as "everything
  // else is being removed".
  it('renders a pure key addition as old: {} / new: {AddedKey} (#1608)', () => {
    const statement = {
      Sid: 'stmt',
      Effect: 'Allow',
      Principal: { AWS: 'arn:aws:iam::123456789012:root' },
      Action: 'events:PutEvents',
    };
    const root = leaf('P', 'P', [
      {
        logicalId: 'BusPolicy',
        changeType: 'UPDATE',
        resourceType: 'AWS::Events::EventBusPolicy',
        propertyChanges: [
          {
            path: 'Statement',
            oldValue: statement,
            newValue: { ...statement, Condition: { StringEquals: { k: 'v' } } },
            requiresReplacement: false,
          },
        ],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    expect(text).toContain('old: {}');
    expect(text).toContain('"Condition"');
    // The unchanged keys must appear on NEITHER side — before the fix the old
    // side printed the full statement (Sid / Principal / Action included).
    expect(text).not.toContain('"Sid"');
    expect(text).not.toContain('"Principal"');
    expect(text).not.toContain('"Action"');
  });

  it('renders a pure key removal as old: {RemovedKey} / new: {} (#1608)', () => {
    const base = { Sid: 'stmt', Action: 'events:PutEvents' };
    const root = leaf('P', 'P', [
      {
        logicalId: 'BusPolicy',
        changeType: 'UPDATE',
        resourceType: 'AWS::Events::EventBusPolicy',
        propertyChanges: [
          {
            path: 'Statement',
            oldValue: { ...base, Condition: { StringEquals: { k: 'v' } } },
            newValue: base,
            requiresReplacement: false,
          },
        ],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    expect(text).toContain('new: {}');
    expect(text).toContain('"Condition"');
    expect(text).not.toContain('"Sid"');
    expect(text).not.toContain('"Action"');
  });

  it('renders a NESTED key addition symmetrically pruned to the changed subtree (#1608)', () => {
    const root = leaf('P', 'P', [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        propertyChanges: [
          {
            path: 'Config',
            oldValue: { Nested: { keep: 1 } },
            newValue: { Nested: { keep: 1, added: 2 } },
            requiresReplacement: false,
          },
        ],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    expect(text).toContain('old: {}');
    expect(text).toContain('"added"');
    expect(text).not.toContain('"keep"');
  });

  // PR #1614 review: `in` walks the prototype chain, so a user map key named
  // after an Object.prototype member (legal in CFn env vars / tags parsed
  // from JSON) would be silently dropped from the union of keys.
  it('renders an added key named after an Object.prototype member (toString) (#1608)', () => {
    const root = leaf('P', 'P', [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: 'AWS::Lambda::Function',
        propertyChanges: [
          {
            path: 'Environment',
            oldValue: { A: '1' },
            newValue: { A: '2', toString: 'x' },
            requiresReplacement: false,
          },
        ],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    expect(text).toContain('"toString"');
    expect(text).toContain('"A"');
  });

  it('falls back to FULL values on BOTH sides when the only differences are intrinsic-valued keys (#1608)', () => {
    const root = leaf('P', 'P', [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        propertyChanges: [
          {
            path: 'Config',
            oldValue: { same: 'x', ref: { Ref: 'A' } },
            newValue: { same: 'x', ref: { Ref: 'B' } },
            requiresReplacement: false,
          },
        ],
      },
    ]);
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    const text = lines.join('\n');

    // Both results pruned to nothing -> the fallback shows the full value on
    // BOTH sides (never one-sided).
    const oldLines = lines.filter((l) => l.includes('old:'));
    const newLines = lines.filter((l) => l.includes('new:'));
    expect(oldLines.join('\n')).toContain('"same"');
    expect(newLines.join('\n')).toContain('"same"');
    expect(text).toContain('"ref"');
  });
});

describe('computeStackDiff / buildDiffTree canonicalizer wiring (#1591)', () => {
  // The round-2 blocker was that `cdkd diff` never received the property
  // normalizer the deploy engine applies, so the PREVIEW forecast a
  // REPLACEMENT the apply would never perform. The fix threads a function
  // through three sites — computeStackDiff, buildDiffTree, and the nested
  // recursion — and a review found all three unpinned: breaking every one of
  // them left the whole suite green.
  const ROUTE = 'AWS::EC2::Route';
  const narrowedRoute = { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16' };
  const invalidRouteProps = {
    RouteTableId: 'rtb-1',
    DestinationCidrBlock: '10.0.0.0/16',
    DestinationIpv6CidrBlock: '::/0',
  };
  const routeTemplate: CloudFormationTemplate = {
    Resources: { R: { Type: ROUTE, Properties: invalidRouteProps } },
  };
  // Narrows exactly like the provider does, without depending on it here.
  const canonicalize = (resourceType: string, properties: Record<string, unknown>) => {
    if (resourceType !== ROUTE) return properties;
    const keys = ['DestinationCidrBlock', 'DestinationIpv6CidrBlock', 'DestinationPrefixListId'];
    const declared = keys.filter((k) => Boolean(properties[k]));
    if (declared.length <= 1) return properties;
    const out = { ...properties };
    for (const losing of declared.slice(1)) delete out[losing];
    return out;
  };

  it('computeStackDiff forwards it — without it the preview disagrees with the apply', async () => {
    const state = st('S', { R: res(ROUTE, narrowedRoute) });

    const { changes: withFn } = await computeStackDiff(
      state,
      routeTemplate,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      {
        parameters: undefined,
        canonicalizeProperties: canonicalize,
      }
    );
    expect(withFn.get('R')!.changeType).toBe('NO_CHANGE');

    // The control: this is what `cdkd diff` printed before the fix, and what
    // it would print again if the argument were dropped.
    const { changes: withoutFn } = await computeStackDiff(
      state,
      routeTemplate,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator()
    );
    expect(withoutFn.get('R')!.changeType).toBe('UPDATE');
  });

  it('buildDiffTree forwards it to the ROOT stack', async () => {
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: routeTemplate,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({ S: st('S', { R: res(ROUTE, narrowedRoute) }) }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalize,
    });

    expect(node.changes.get('R')!.changeType).toBe('NO_CHANGE');
  });

  it('buildDiffTree forwards it into a NESTED child', async () => {
    // The recursion is its own site: forwarding at the root while dropping it
    // one level down leaves a nested route previewing a phantom replacement.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-1591-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({ Resources: { R: { Type: ROUTE, Properties: invalidRouteProps } } })
      );
      const parentTemplate: CloudFormationTemplate = {
        Resources: {
          Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
        },
      };

      const node = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: fakeBackend({
          S: st('S', { Child: res(NESTED, {}) }),
          'S~Child': st('S~Child', { R: res(ROUTE, narrowedRoute) }),
        }),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
        canonicalizeProperties: canonicalize,
      });

      const child = node.children.find((c) => c.stackName === 'S~Child');
      expect(child).toBeDefined();
      expect(child!.changes.get('R')!.changeType).toBe('NO_CHANGE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('computeStackDiff / buildDiffTree cfnFallback threading (#1697)', () => {
  // The diff's resolvers must honor `--no-cfn-fallback` exactly like the
  // deploy engine ("preview and apply resolve identically"). Four resolver
  // construction sites thread the flag: computeStackDiff, buildDiffTree's
  // root call, the nested-child recursion, and resolveChildStackParameters.
  // Both polarities are pinned behaviorally (memory rule
  // `feedback_pin_both_polarities_of_threaded_flag`): default ON resolves
  // the import via the mocked CFn exports (NO_CHANGE + a CFn call); OFF
  // leaves the intrinsic unresolved (previewed change + ZERO CFn calls,
  // which covers every site at once).
  const SSM = 'AWS::SSM::Parameter';
  const importTemplate: CloudFormationTemplate = {
    Resources: {
      P: { Type: SSM, Properties: { Value: { 'Fn::ImportValue': 'CfnSideExport' } } },
    },
  };
  const resolvedState = () => st('S', { P: res(SSM, { Value: 'from-cfn' }) });
  /** fakeBackend + the listStacks the ImportValue scan needs. */
  function fbBackend(states: Record<string, StackState>): S3StateBackend {
    return {
      getState: async (stackName: string) => {
        const state = states[stackName];
        return state ? { state, etag: 'fake' } : null;
      },
      listStacks: async () =>
        Object.values(states).map((s) => ({ stackName: s.stackName, region: s.region })),
    } as unknown as S3StateBackend;
  }

  beforeEach(() => {
    cfnMockSend.mockClear();
  });

  it('computeStackDiff default: the CFn fallback resolves the import (preview matches apply)', async () => {
    const { changes } = await computeStackDiff(
      resolvedState(),
      importTemplate,
      'us-east-1',
      'S',
      fbBackend({ S: resolvedState() }),
      new DiffCalculator()
    );
    expect(changes.get('P')!.changeType).toBe('NO_CHANGE');
    expect(cfnMockSend).toHaveBeenCalled();
  });

  it('computeStackDiff cfnFallback:false: no CFn call, the import stays unresolved (previewed change)', async () => {
    const { changes } = await computeStackDiff(
      resolvedState(),
      importTemplate,
      'us-east-1',
      'S',
      fbBackend({ S: resolvedState() }),
      new DiffCalculator(),
      { cfnFallback: false }
    );
    expect(changes.get('P')!.changeType).toBe('UPDATE');
    expect(cfnMockSend).not.toHaveBeenCalled();
  });

  it('buildDiffTree forwards the flag to the ROOT stack (both polarities)', async () => {
    const on = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: importTemplate,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fbBackend({ S: resolvedState() }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(on.changes.get('P')!.changeType).toBe('NO_CHANGE');
    expect(cfnMockSend).toHaveBeenCalled();

    cfnMockSend.mockClear();
    const off = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: importTemplate,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fbBackend({ S: resolvedState() }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      cfnFallback: false,
    });
    expect(off.changes.get('P')!.changeType).toBe('UPDATE');
    expect(cfnMockSend).not.toHaveBeenCalled();
  });

  it('buildDiffTree forwards the flag into a NESTED child + its input-parameter resolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-1697-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Parameters: { InP: { Type: 'String' } },
          Resources: {
            P: { Type: SSM, Properties: { Value: { 'Fn::ImportValue': 'CfnSideExport' } } },
          },
        })
      );
      const parentTemplate: CloudFormationTemplate = {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            // The child-input Parameters block is what routes through
            // resolveChildStackParameters — the fourth threading site.
            Properties: { Parameters: { InP: { 'Fn::ImportValue': 'CfnSideExport' } } },
          },
        },
      };
      const states = () => ({
        S: st('S', { Child: res(NESTED, {}) }),
        'S~Child': st('S~Child', { P: res(SSM, { Value: 'from-cfn' }) }),
      });

      const on = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: fbBackend(states()),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      const onChild = on.children.find((c) => c.stackName === 'S~Child');
      expect(onChild).toBeDefined();
      expect(onChild!.changes.get('P')!.changeType).toBe('NO_CHANGE');
      expect(cfnMockSend).toHaveBeenCalled();

      cfnMockSend.mockClear();
      const off = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: fbBackend(states()),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
        cfnFallback: false,
      });
      const offChild = off.children.find((c) => c.stackName === 'S~Child');
      expect(offChild).toBeDefined();
      expect(offChild!.changes.get('P')!.changeType).toBe('UPDATE');
      // ZERO CFn calls across root diff, child-parameter resolution, AND
      // the child's own diff — covers every threading site at once.
      expect(cfnMockSend).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('computeStackDiff', () => {
  it('reports all CREATE against an empty state', async () => {
    const template: CloudFormationTemplate = {
      Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    };
    const empty = st('S', {});
    const { changes } = await computeStackDiff(
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
    const { changes } = await computeStackDiff(
      state,
      template,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator()
    );
    expect(changes.get('A')!.changeType).toBe('NO_CHANGE');
  });

  // Issue #1027 — the diff must mirror the deploy engine's parameter /
  // condition preprocessing (deploy-engine steps 2.5-2.7), or raw-CFn
  // templates (CfnInclude et al.) report spurious changes deploy never makes.
  describe('template Parameters / Conditions parity with deploy (#1027)', () => {
    const paramTemplate = (
      resources: CloudFormationTemplate['Resources']
    ): CloudFormationTemplate => ({
      Parameters: {
        Env: { Type: 'String', Default: 'dev' },
      },
      Conditions: {
        IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] },
      },
      Resources: resources,
    });

    it('binds template Parameter defaults so an unchanged param-derived value is NO_CHANGE', async () => {
      const template = paramTemplate({
        A: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: { 'Fn::Join': ['-', ['p', { Ref: 'Env' }]] },
            Value: { 'Fn::Sub': '${Env}-suffix' },
          },
        },
      });
      const state = st('S', {
        A: res('AWS::SSM::Parameter', { Name: 'p-dev', Value: 'dev-suffix' }),
      });
      const { changes } = await computeStackDiff(
        state,
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator()
      );
      expect(changes.get('A')!.changeType).toBe('NO_CHANGE');
    });

    it('prunes a condition-false resource instead of reporting CREATE', async () => {
      const template = paramTemplate({
        ProdOnly: {
          Type: 'AWS::SSM::Parameter',
          Condition: 'IsProd',
          Properties: { Value: 'prod-only' },
        },
        Always: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
      });
      const { changes } = await computeStackDiff(
        st('S', {}),
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator()
      );
      expect(changes.has('ProdOnly')).toBe(false);
      expect(changes.get('Always')!.changeType).toBe('CREATE');
    });

    it('reports DELETE for a condition-false resource still in state (deploy parity)', async () => {
      const template = paramTemplate({
        ProdOnly: {
          Type: 'AWS::SSM::Parameter',
          Condition: 'IsProd',
          Properties: { Value: 'prod-only' },
        },
      });
      const state = st('S', { ProdOnly: res('AWS::SSM::Parameter', { Value: 'prod-only' }) });
      const { changes } = await computeStackDiff(
        state,
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator()
      );
      expect(changes.get('ProdOnly')!.changeType).toBe('DELETE');
    });

    it('resolves Fn::If in property values via the evaluated conditions', async () => {
      const template = paramTemplate({
        A: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Value: { 'Fn::If': ['IsProd', 'prod-v', 'dev-v'] } },
        },
      });
      const state = st('S', { A: res('AWS::SSM::Parameter', { Value: 'dev-v' }) });
      const { changes } = await computeStackDiff(
        state,
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator()
      );
      expect(changes.get('A')!.changeType).toBe('NO_CHANGE');
    });

    it('lets nested input parameters satisfy a required template parameter', async () => {
      const template: CloudFormationTemplate = {
        Parameters: { Req: { Type: 'String' } },
        Resources: {
          A: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'Req' } } },
        },
      };
      const state = st('S', { A: res('AWS::SSM::Parameter', { Value: 'given' }) });
      const { changes } = await computeStackDiff(
        state,
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator(),
        { parameters: { Req: 'given' } }
      );
      expect(changes.get('A')!.changeType).toBe('NO_CHANGE');
    });

    it('keeps condition-gated resources when a required parameter cannot be bound (no phantom DELETE)', async () => {
      // The resolver downgrades an unevaluable condition (Ref to the unbound
      // parameter) to FALSE — so condition evaluation must be skipped
      // entirely on a binding failure, or a condition-gated resource in
      // state would be pruned and reported as a spurious DELETE.
      const template: CloudFormationTemplate = {
        Parameters: { Req: { Type: 'String' } },
        Conditions: { IsX: { 'Fn::Equals': [{ Ref: 'Req' }, 'x'] } },
        Resources: {
          Gated: {
            Type: 'AWS::SSM::Parameter',
            Condition: 'IsX',
            Properties: { Value: 'v' },
          },
        },
      };
      const state = st('S', { Gated: res('AWS::SSM::Parameter', { Value: 'v' }) });
      const { changes } = await computeStackDiff(
        state,
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator()
      );
      expect(changes.get('Gated')!.changeType).not.toBe('DELETE');
    });

    it('resolves Fn::FindInMap keyed by a bound parameter (#1035 pin)', async () => {
      const template: CloudFormationTemplate = {
        Parameters: { Env: { Type: 'String', Default: 'dev' } },
        Mappings: { EnvMap: { dev: { Suffix: 'dev-q' }, prod: { Suffix: 'prod-q' } } },
        Resources: {
          A: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Value: { 'Fn::FindInMap': ['EnvMap', { Ref: 'Env' }, 'Suffix'] },
            },
          },
        },
      };
      const state = st('S', { A: res('AWS::SSM::Parameter', { Value: 'dev-q' }) });
      const { changes } = await computeStackDiff(
        state,
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator()
      );
      expect(changes.get('A')!.changeType).toBe('NO_CHANGE');
    });

    it('degrades to the raw-template diff when an SSM-typed parameter lookup fails (#1035 pin)', async () => {
      // The diff path now calls resolveParameters, which resolves
      // AWS::SSM::Parameter::Value<...>-typed defaults via GetParameter.
      // A lookup failure (no bootstrap, no permission, transient error)
      // must degrade to the pre-binding raw-template diff — never crash.
      ssmSend.mockRejectedValueOnce(new Error('ParameterNotFound'));
      const template: CloudFormationTemplate = {
        Parameters: {
          SsmVal: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/some/path' },
        },
        Resources: {
          A: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'SsmVal' } } },
        },
      };
      const state = st('S', { A: res('AWS::SSM::Parameter', { Value: 'x' }) });
      const { changes } = await computeStackDiff(
        state,
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator()
      );
      // Raw fallback keeps the unresolved Ref → reported as a change, not a crash.
      expect(changes.get('A')!.changeType).toBe('UPDATE');
    });

    it('skips the SSM lookup for an unreferenced SSM-typed parameter (BootstrapVersion diff pin, #1035)', async () => {
      // The CDK default synthesizer's BootstrapVersion parameter is SSM-typed
      // and referenced only by Rules cdkd never evaluates. The diff path must
      // inherit resolveParameters' unreferenced-skip (#1002) so diffing does
      // not suddenly require `cdk bootstrap` in the target region.
      ssmSend.mockClear();
      const template: CloudFormationTemplate = {
        Parameters: {
          Env: { Type: 'String', Default: 'dev' },
          BootstrapVersion: {
            Type: 'AWS::SSM::Parameter::Value<String>',
            Default: '/cdk-bootstrap/hnb659fds/version',
          },
        },
        Resources: {
          A: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'Env' } } },
        },
      };
      const state = st('S', { A: res('AWS::SSM::Parameter', { Value: 'dev' }) });
      const { changes } = await computeStackDiff(
        state,
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator()
      );
      expect(changes.get('A')!.changeType).toBe('NO_CHANGE');
      expect(ssmSend).not.toHaveBeenCalled();
    });

    it('applies parameter/condition preprocessing through buildDiffTree (walker wiring, #1035)', async () => {
      const template: CloudFormationTemplate = {
        Parameters: { Env: { Type: 'String', Default: 'dev' } },
        Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
        Resources: {
          A: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { 'Fn::Sub': '${Env}-suffix' } },
          },
          ProdOnly: {
            Type: 'AWS::SSM::Parameter',
            Condition: 'IsProd',
            Properties: { Value: 'prod-only' },
          },
        },
      };
      const backend = fakeBackend({
        S: st('S', { A: res('AWS::SSM::Parameter', { Value: 'dev-suffix' }) }),
      });
      const root = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template,
        nestedTemplates: {},
        recursive: false,
        stateBackend: backend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      expect(root.changes.get('A')!.changeType).toBe('NO_CHANGE');
      expect(root.changes.has('ProdOnly')).toBe(false);
      expect(treeHasChanges(root)).toBe(false);
    });

    it('falls back to the raw-template diff when a required parameter cannot be bound', async () => {
      const template: CloudFormationTemplate = {
        Parameters: { Req: { Type: 'String' } },
        Resources: {
          A: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'Req' } } },
        },
      };
      const state = st('S', { A: res('AWS::SSM::Parameter', { Value: 'given' }) });
      // No parameters supplied and no default — binding fails, the diff must
      // not throw and keeps the pre-#1027 raw-intrinsic comparison (UPDATE).
      const { changes } = await computeStackDiff(
        state,
        template,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator()
      );
      expect(changes.get('A')!.changeType).toBe('UPDATE');
    });
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
      isNestedChild: false,
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

  it('applies the #1002 asset-reference rewrite to nested child templates (assetRedirect set)', async () => {
    const { buildAssetRedirectMap } = await import('../../../src/assets/asset-redirect.js');
    const cdkBucketLiteral = 'cdk-hnb659fds-assets-123456789012-us-east-1';
    const cdkdBucket = 'cdkd-assets-123456789012-us-east-1';
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: `s3://${cdkBucketLiteral}/key.zip` },
          },
        },
      })
    );
    const parentTemplate: CloudFormationTemplate = {
      Resources: {
        Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
      },
    };
    const assetRedirect = buildAssetRedirectMap(
      {
        version: '38.0.0',
        files: {
          aaaa1111: {
            displayName: 'Code',
            source: { path: 'asset.aaaa1111', packaging: 'zip' },
            destinations: { d1: { bucketName: cdkBucketLiteral, objectKey: 'key.zip' } },
          },
        },
        dockerImages: {},
      },
      {
        assetBucket: cdkdBucket,
        containerRepo: 'cdkd-container-assets-123456789012-us-east-1',
        assetSupportVersion: 1,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      '123456789012',
      'us-east-1'
    );
    // State already carries the REWRITTEN (cdkd) location — the child diff
    // must therefore report NO change, proving the walker rewrote the child
    // template it read from disk before diffing.
    const backend = fakeBackend({
      Parent: st('Parent', { Child: res(NESTED, {}) }),
      'Parent~Child': st('Parent~Child', {
        ChildRes: res('AWS::SSM::Parameter', { Value: `s3://${cdkdBucket}/key.zip` }),
      }),
    });

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      assetRedirect,
    });

    expect(root.children).toHaveLength(1);
    expect(nodeHasChanges(root.children[0]!)).toBe(false);
    expect(treeHasChanges(root)).toBe(false);
  });

  it('follows the RAW aws:asset:path in asset-redirect mode, the file the deploy follows (go-to-k/cdkd#3450)', async () => {
    // The rewrite walks every string, `Metadata['aws:asset:path']` included, so
    // a path segment spelling a bootstrap bucket is rewritten like any other
    // occurrence. Indexed AFTER the rewrite, the walk followed `<TARGET>/x.json`
    // while `NestedStackProvider.readChildTemplate` (index first) deploys
    // `<SRC>/x.json`. The two files hold different resources, so the
    // grandchild's rows say which one was read.
    const { buildAssetRedirectMap } = await import('../../../src/assets/asset-redirect.js');
    const SRC = 'cdk-hnb659fds-assets-123456789012-us-east-1';
    const TARGET = 'cdkd-assets-123456789012-us-east-1';
    const assetRedirect = buildAssetRedirectMap(
      {
        version: '38.0.0',
        files: {
          aaaa1111: {
            displayName: 'Code',
            source: { path: 'asset.aaaa1111', packaging: 'zip' },
            destinations: {
              d1: {
                bucketName: 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}',
                objectKey: 'aaaa1111.zip',
              },
            },
          },
        },
        dockerImages: {},
      },
      {
        assetBucket: TARGET,
        containerRepo: 'cdkd-container-assets-123456789012-us-east-1',
        assetSupportVersion: 1,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      '123456789012',
      'us-east-1'
    );
    mkdirSync(join(dir, SRC));
    mkdirSync(join(dir, TARGET));
    const leaf = (logicalId: string) =>
      JSON.stringify({
        Resources: {
          [logicalId]: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'v' } },
        },
      });
    writeFileSync(join(dir, SRC, 'x.json'), leaf('FromRawPath'));
    writeFileSync(join(dir, TARGET, 'x.json'), leaf('FromRewrittenPath'));
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Resources: {
          Grand: { Type: NESTED, Metadata: { 'aws:asset:path': `${SRC}/x.json` }, Properties: {} },
        },
      })
    );
    const parentTemplate: CloudFormationTemplate = {
      Resources: {
        Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
      },
    };

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      assetRedirect,
    });

    const grand = root.children[0]!.children[0]!;
    expect(grand.stackName).toBe('Parent~Child~Grand');
    expect([...grand.changes.keys()]).toEqual(['FromRawPath']);
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
      isNestedChild: false,
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
      isNestedChild: false,
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
      isNestedChild: false,
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

  describe('a condition-gated nested row (go-to-k/cdkd#3815)', () => {
    // The child's CURRENT template turns `ChildRes` into a nested stack, a Type
    // change the deploy refuses — but only if it reaches the child engine. A
    // walk of the live template would report it; a DELETE subtree cannot.
    async function diffWithCondition(equals: [string, string]): Promise<DiffTreeNode> {
      writeFileSync(join(dir, 'grand.json'), JSON.stringify({ Resources: {} }));
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Resources: {
            ChildRes: { Type: NESTED, Metadata: { 'aws:asset:path': 'grand.json' }, Properties: {} },
            NewRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'n' } },
          },
        })
      );
      const parentTemplate: CloudFormationTemplate = {
        Conditions: { Gate: { 'Fn::Equals': equals } },
        Resources: {
          ParentRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'p1' } },
          Child: {
            Type: NESTED,
            Condition: 'Gate',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: {},
          },
        },
      };
      const backend = fakeBackend({
        Parent: st('Parent', {
          ParentRes: res('AWS::SSM::Parameter', { Value: 'p1' }),
          Child: res(NESTED, {}),
        }),
        'Parent~Child': st('Parent~Child', {
          ChildRes: res('AWS::SSM::Parameter', { Value: 'c1' }),
        }),
      });
      return buildDiffTree({
        stackName: 'Parent',
        displayName: 'Parent',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: indexNestedChildTemplates(parentTemplate, join(dir, 'parent.json')),
        recursive: true,
        stateBackend: backend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
    }

    it('condition false: walks the child as a DELETE subtree, never its template', async () => {
      const root = await diffWithCondition(['a', 'b']);

      expect(root.changes.get('Child')!.changeType).toBe('DELETE');
      expect(root.children).toHaveLength(1);
      const child = root.children[0]!;
      expect(child.stackName).toBe('Parent~Child');
      expect([...child.changes.entries()].map(([id, c]) => [id, c.changeType])).toEqual([
        ['ChildRes', 'DELETE'],
      ]);
      expect(child.blocking).toEqual([]);
      expect(child.children).toEqual([]);
      expect(countBlocking(root)).toBe(0);
    });

    it('condition true (control): walks the child template and reports its Type-change refusal', async () => {
      const root = await diffWithCondition(['a', 'a']);

      expect(root.changes.get('Child')!.changeType).toBe('NO_CHANGE');
      expect(root.children).toHaveLength(1);
      const child = root.children[0]!;
      expect(child.changes.get('NewRes')!.changeType).toBe('CREATE');
      expect(child.blocking).toHaveLength(1);
      expect(countBlocking(root)).toBe(1);
    });
  });

  it('populates ccApiRoutes for resources whose template uses #614 silent-drop properties (e.g. Lambda FunctionScalingConfig)', async () => {
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
            FunctionScalingConfig: { MinExecutionEnvironments: 1, MaxExecutionEnvironments: 2 },
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
      isNestedChild: false,
    });

    expect(root.ccApiRoutes.get('SilentDropLambda')).toEqual(['FunctionScalingConfig']);
    expect(root.ccApiRoutes.has('OkayLambda')).toBe(false);

    // The annotation makes it into the human renderer + the JSON projection.
    const lines: string[] = [];
    renderDiffTree(root, true, (m) => lines.push(m));
    expect(lines.join('\n')).toContain(
      '[+] SilentDropLambda (AWS::Lambda::Function) [via CC API: FunctionScalingConfig]'
    );

    const json = diffTreeToJson(root);
    const silentDropChange = json.changes.find((c) => c.logicalId === 'SilentDropLambda');
    const okayChange = json.changes.find((c) => c.logicalId === 'OkayLambda');
    expect(silentDropChange?.ccApi).toEqual(['FunctionScalingConfig']);
    expect(okayChange?.ccApi).toBeUndefined();
  });

  it('annotates sticky-CC resources (provisionedBy: cc-api in state, no silent-drop in template) with [via CC API: sticky] — matches live-progress label + design §8', async () => {
    // The Lambda's template has NO silent-drop property — the SDK provider's
    // coverage caught up between deploys. But cdkd state still pins routing
    // to CC API (sticky semantics), so `getProviderFor` rule 2 will route
    // the next UPDATE via CC API. Without sticky-state visibility, the diff
    // line would render plain while the live-progress label correctly tags
    // it `[CC API]` — that divergence is what this test prevents.
    const template: CloudFormationTemplate = {
      Resources: {
        StickyLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: 'foo',
            Role: 'arn:aws:iam::1:role/r',
            Code: { ZipFile: 'x' },
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
          },
        },
      },
    };
    const backend = fakeBackend({
      Leaf: st('Leaf', {
        StickyLambda: {
          ...res('AWS::Lambda::Function', {
            FunctionName: 'foo',
            Role: 'arn:aws:iam::1:role/r',
            Code: { ZipFile: 'x' },
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
          }),
          provisionedBy: 'cc-api',
        },
      }),
    });

    const root = await buildDiffTree({
      stackName: 'Leaf',
      displayName: 'Leaf',
      region: 'us-east-1',
      template,
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    expect(root.ccApiRoutes.get('StickyLambda')).toEqual(['sticky']);

    // Even when there is no actual change to render (NO_CHANGE on every
    // field), the routing annotation is queryable via the JSON projection
    // — important for users auditing routing without forcing a real diff.
    const json = diffTreeToJson(root);
    // NO_CHANGE entries are dropped from JSON, so we won't have a per-change
    // entry here; the route info is captured on the tree itself.
    expect(json.changes).toHaveLength(0);
    expect(root.ccApiRoutes.has('StickyLambda')).toBe(true);
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
      isNestedChild: false,
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
        isNestedChild: false,
      })
    ).rejects.toThrow(/Nested template file not found/);
  });

  it('names a FORGING stack and nested row inside their own boundaries when the template path is missing (go-to-k/cdkd#3479)', async () => {
    const F = (tag: string): string => `${tag}'. Template found, nothing missing. Ignore 'X`;
    const STACK = F('Parent');
    const CHILD = F('Child');
    const parentTemplate: CloudFormationTemplate = {
      Resources: { [CHILD]: { Type: NESTED, Properties: {} } },
    };
    const backend = fakeBackend({ [STACK]: st(STACK, { [CHILD]: res(NESTED, {}) }) });

    const message = await buildDiffTree({
      stackName: STACK,
      displayName: STACK,
      region: 'us-east-1',
      template: parentTemplate,
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    }).then(
      () => '',
      (e: unknown) => (e as Error).message
    );

    expect(message).toContain(
      `Nested template file not found for AWS::CloudFormation::Stack ${JSON.stringify(CHILD)} under stack ${JSON.stringify(STACK)}. `
    );
    expect(
      [STACK, CHILD].reduce((t, v) => t.split(JSON.stringify(v)).join(''), message)
    ).not.toContain('nothing missing');
  });
});

/**
 * Issue go-to-k/cdkd#3239: the TEMPLATE arm of the recursive walk had no
 * visited set and no self-reference check, so a relative
 * `Metadata['aws:asset:path']` resolving back onto the same nesting chain was
 * joined unconditionally and the walk followed the cycle.
 * `indexNestedChildTemplates` refuses an ABSOLUTE asset path already, and its
 * message names the threat model this closes ("the synth output was
 * hand-modified or generated by a non-CDK toolchain").
 *
 * **What the cycle cost is a DIAGNOSIS, not termination, and these cases are
 * written against the REAL bound rather than the apparent one.** Measured live
 * against the pre-fix binary, `cdkd diff --recursive` on a self-referencing
 * assembly ends with `StateError: ... Your key is too long` after ~190 levels:
 * `loadStateOrEmpty` runs at every node against a `childStackName` that grows
 * by one `~<logicalId>` per level, so S3's key limit bounds this arm exactly as
 * it bounds the state-only one. The error names a stack that does not exist and
 * never mentions the asset path.
 *
 * So do NOT read a crash in these cases as the bug: `fakeBackend` enforces no
 * key length, which is why the pre-fix module runs away HERE and merely fails
 * confusingly in production. That divergence is the mock endorsing an
 * assumption the wire does not — the reason the live run above is quoted rather
 * than a unit measurement.
 *
 * The acyclic and diamond cases pass pre-fix, by design — they are the
 * compatibility half, and the diamond is the one a GLOBAL visited set would
 * have broken.
 */
describe('buildDiffTree template-arm cycle refusal (go-to-k/cdkd#3239)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-3239-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write `name` as a template whose nested rows point at `children`. */
  const writeTemplate = (name: string, children: Record<string, string>): string => {
    const resources: Record<string, unknown> = {
      [`${name.replace(/\W/g, '')}Res`]: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Value: name },
      },
    };
    for (const [logicalId, assetPath] of Object.entries(children)) {
      resources[logicalId] = {
        Type: NESTED,
        Metadata: { 'aws:asset:path': assetPath },
        Properties: {},
      };
    }
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify({ Resources: resources }));
    return p;
  };

  const rootTemplate = (children: Record<string, string>): CloudFormationTemplate => {
    const resources: Record<string, unknown> = {};
    for (const logicalId of Object.keys(children)) {
      resources[logicalId] = { Type: NESTED, Metadata: {}, Properties: {} };
    }
    return { Resources: resources } as CloudFormationTemplate;
  };

  it('refuses a child template whose asset path points at ITSELF, naming the row AND the path', async () => {
    // `self.json` declares a nested row resolving back to `self.json`.
    const selfPath = writeTemplate('self.json', { Loop: 'self.json' });

    // One call, three assertions on the captured rejection. The message IS the
    // deliverable of this fix — it replaces a `Your key is too long` naming a
    // stack that does not exist — so each of its three moving parts gets its
    // own assertion. The PATH especially: a probe replacing that interpolation
    // with a literal left the whole file green, because every other case stops
    // at `resolves to nested template` and reads no further.
    const err = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: rootTemplate({ Child: 'ignored' }),
      nestedTemplates: { Child: selfPath },
      recursive: true,
      stateBackend: fakeBackend({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    }).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    expect(err).toBeInstanceOf(Error);
    const message = err!.message;
    // Which row, and under which stack.
    expect(message).toContain("Nested stack Loop under stack Parent~Child");
    // WHICH FILE closed the cycle — the part nothing else watches. Compared as
    // a substring against the resolved path rather than via a regex, so no
    // escaping question arises for a temp dir containing regex metacharacters.
    expect(message).toContain(resolve(selfPath));
    // And the diagnosis itself.
    expect(message).toContain('closes a cycle');
    expect(message).toContain('Refusing to diff');
  });

  it('keeps a forging template path inside one boundary in the cycle refusal (go-to-k/cdkd#3590)', async () => {
    const forgedFile = "x'. Contained and healthy. Nothing 'y.json";
    const selfPath = writeTemplate(forgedFile, { Loop: forgedFile });

    const err = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: rootTemplate({ Child: 'ignored' }),
      nestedTemplates: { Child: selfPath },
      recursive: true,
      stateBackend: fakeBackend({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    }).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    const shown = JSON.stringify(resolve(selfPath));
    expect(err!.message).toContain(`resolves to nested template ${shown}, which`);
    expect(err!.message.split(shown).join('')).not.toContain('Contained and healthy');
  });

  it('names a FORGING row and stack inside their own boundaries in the cycle refusal (go-to-k/cdkd#3617)', async () => {
    const LOOP = "Loop'. Cycle checked, nothing repeated. Ignore 'X";
    const selfPath = writeTemplate('self.json', { [LOOP]: 'self.json' });

    const message = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: rootTemplate({ Child: 'ignored' }),
      nestedTemplates: { Child: selfPath },
      recursive: true,
      stateBackend: fakeBackend({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    }).then(
      () => '',
      (e: unknown) => (e as Error).message
    );

    expect(message).toContain(
      `Nested stack ${JSON.stringify(LOOP)} under stack Parent~Child resolves to nested template `
    );
    expect(message.split(JSON.stringify(LOOP)).join('')).not.toContain('nothing repeated');
  });

  it('refuses a LONGER cycle a self-reference check alone would miss', async () => {
    // a.json -> b.json -> a.json. Neither row points at its own file, so a
    // `childPath === ownPath` guard would walk straight past both.
    writeTemplate('b.json', { ToA: 'a.json' });
    const aPath = writeTemplate('a.json', { ToB: 'b.json' });

    await expect(
      buildDiffTree({
        stackName: 'Parent',
        displayName: 'Parent',
        region: 'us-east-1',
        template: rootTemplate({ Child: 'ignored' }),
        nestedTemplates: { Child: aPath },
        recursive: true,
        stateBackend: fakeBackend({}),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      })
    ).rejects.toThrow(/Nested stack ToA under stack Parent~Child~ToB resolves/);
  });

  it('sanitizes every value it interpolates into the refusal', async () => {
    // The refusal fires ONLY on a hand-modified assembly, so all three of its
    // inputs are attacker-controlled — the logical id is a template key, the
    // stack name is built from template keys below the root, and the path comes
    // from `aws:asset:path`. Without this case, dropping `displaySafe` from all
    // three leaves the file green (measured), while the changelog asserts the
    // sanitization and the code comment calls it security-load-bearing.
    //
    // Same shape as the `renderOutputChangeLines` pin further down this file:
    // C1 (``) and the bidi overrides pass straight through `JSON.stringify`
    // and through ordinary string building, and they are what forges terminal
    // lines inside an error the user is being asked to trust.
    const hostile = 'LoopX‮Y';
    const outer = hostile.replace('Loop', 'Outer');
    const inner = hostile.replace('Loop', 'Inner');
    // The PATH is poisoned through the FILE NAME, which is the only way to
    // reach that interpolation: the refusal fires on a path already in the
    // ancestor set, so the file had to be read at a higher level and therefore
    // has to exist. macOS and Linux both accept these bytes in a name and round
    // -trip them (probed). Without this the path argument is the one of the
    // three that stays green when its `displaySafe` is removed.
    const hostileFile = hostile.replace('Loop', 'file') + '.json';
    const selfPath = writeTemplate(hostileFile, { [inner]: hostileFile });

    // BOTH logical ids carry the hostile bytes, and that is load-bearing
    // rather than belt-and-braces. The refusal names `logicalId` and
    // `stackName` separately, and `stackName` at the refusal point is
    // `Parent~<outer id>` — so poisoning only the inner row pins `logicalId`
    // and leaves `stackName` free: measured, dropping `displaySafe` from
    // `stackName` alone stayed GREEN in that shape. One hostile id per
    // interpolated value.
    const err = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: rootTemplate({ [outer]: 'ignored' }),
      nestedTemplates: { [outer]: selfPath },
      recursive: true,
      stateBackend: fakeBackend({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    }).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    expect(err).toBeInstanceOf(Error);
    const message = err!.message;
    // The refusal still fires, still identifies the row, and still names the
    // stack — the sanitizer must not swallow the diagnosis it protects.
    expect(message).toContain('closes a cycle');
    expect(message).toContain('Inner');
    expect(message).toContain('Parent~Outer');
    // But neither the C1 byte nor the bidi override survives into it, from
    // either value.
    expect(message).not.toContain('');
    expect(message).not.toContain('‮');
  });

  it('resolves before comparing — a DEFENSIVE guard, pinned on a shape synth cannot emit', async () => {
    // Read this case for what it is: normalizing the key is defensive here
    // (`templateIdentity` resolves the directory, go-to-k/cdkd#3450), and this
    // input is UNREACHABLE from the real pipeline. Synth builds every root
    // entry as `join(assemblyDir, assetPath)` (`src/synthesis/assembly-reader.ts`),
    // and `path.join` normalizes, so no `.` segment survives into
    // `nestedTemplates`; every deeper path comes from this module's own
    // `path.join`. With production inputs a raw string comparison would behave
    // identically, which is why the case has to construct the spelling by hand.
    //
    // It is pinned anyway because the guard is cheap and a future caller
    // feeding `buildDiffTree` an unnormalized map is exactly what it covers.
    // What it measures is WHICH node refuses: spelled with a `.` segment the
    // raw string entering the ancestor set is `<dir>/./a.json` while the
    // cycle's own `path.join` yields `<dir>/a.json`. Resolved, those are one
    // path and `Parent~Child` refuses; raw, they differ and the refusal comes
    // one level later from `Parent~Child~Loop`. Asserting only "it throws"
    // would be GREEN with `path.resolve` removed (measured), and so would an
    // assertion on the message's PATH, which is canonical either way.
    writeTemplate('a.json', { Loop: 'a.json' });
    const nonCanonicalRoot = `${dir}${sep}.${sep}a.json`;
    // Pin the premise rather than assuming it: this spelling must differ from
    // its resolved form, or the case proves nothing about resolving.
    expect(nonCanonicalRoot).not.toBe(resolve(nonCanonicalRoot));

    await expect(
      buildDiffTree({
        stackName: 'Parent',
        displayName: 'Parent',
        region: 'us-east-1',
        template: rootTemplate({ Child: 'ignored' }),
        nestedTemplates: { Child: nonCanonicalRoot },
        recursive: true,
        stateBackend: fakeBackend({}),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      })
      // Assert the path CONTENT here too, not just the owning stack.
      //
      // What this does NOT pin, stated so nobody re-hunts it: WHICH variable
      // the message interpolates. Swapping `resolvedChildPath` for the raw
      // `childTemplatePath` measures green everywhere, and that is an identity
      // rather than a gap — at any refusal site the child's path was produced
      // by `indexNestedChildTemplates`' own `path.join`, which normalizes, so
      // the two are the same string. Only the ROOT entry can be non-canonical,
      // and the root never refuses: its ancestor set is empty.
    ).rejects.toThrow(
      new RegExp(
        `under stack Parent~Child resolves to nested template ${resolve(nonCanonicalRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, which`
      )
    );
  });

  it('still diffs a legitimately DEEP acyclic chain', async () => {
    // 40 levels, each naming the next — past nothing, but it is the case the
    // refusal must not reach. A depth cap set low enough to stop a cycle
    // cheaply would have broken exactly this.
    const DEPTH = 40;
    writeTemplate(`lvl${DEPTH - 1}.json`, {});
    for (let i = DEPTH - 2; i >= 0; i--) {
      writeTemplate(`lvl${i}.json`, { Next: `lvl${i + 1}.json` });
    }

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: rootTemplate({ Child: 'ignored' }),
      nestedTemplates: { Child: join(dir, 'lvl0.json') },
      recursive: true,
      stateBackend: fakeBackend({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    // Walk with an EXPLICIT stack: a recursive walk here would hit the same
    // limit as the code under test and say nothing about it.
    let depth = 0;
    const pending = [{ node: root, d: 0 }];
    while (pending.length > 0) {
      const { node, d } = pending.pop()!;
      if (d > depth) depth = d;
      for (const child of node.children) pending.push({ node: child, d: d + 1 });
    }
    expect(depth).toBe(DEPTH);
  });

  it('refuses a cycle spelled through a symlinked DIRECTORY at its first repeat (go-to-k/cdkd#3450)', async () => {
    // `d -> .`, and `child.json` names `d/child.json`: one file, but every
    // level joins one more `d/`, so a LEXICAL key never repeats. The walk then
    // ran on until the path or S3's key limit stopped it. The refusal must
    // come from the FIRST repeat, the `Loop` row under `Parent~Child`.
    symlinkSync('.', join(dir, 'd'), 'dir');
    const childPath = writeTemplate('child.json', { Loop: 'd/child.json' });

    const message = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: rootTemplate({ Child: 'ignored' }),
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    }).then(
      () => '',
      (e: unknown) => (e as Error).message
    );

    expect(message).toContain('Nested stack Loop under stack Parent~Child resolves to nested template');
    // The path is the one the assembly SPELLS, not the identity key.
    expect(message).toContain(resolve(join(dir, 'd', 'child.json')));
    expect(message).toContain('closes a cycle');
  });

  it('allows two SIBLING rows to name the same template (a diamond is not a cycle)', async () => {
    // The ancestor chain is per-branch, not global. A global visited set would
    // refuse this — which is why the set is threaded down rather than shared,
    // and this case is what pins that choice.
    writeTemplate('shared.json', {});
    const forkPath = writeTemplate('fork.json', { Left: 'shared.json', Right: 'shared.json' });

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: rootTemplate({ Child: 'ignored' }),
      nestedTemplates: { Child: forkPath },
      recursive: true,
      stateBackend: fakeBackend({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    const fork = root.children[0]!;
    expect(fork.stackName).toBe('Parent~Child');
    expect(fork.children.map((c) => c.stackName)).toEqual([
      'Parent~Child~Left',
      'Parent~Child~Right',
    ]);
  });
});

/**
 * Regression for the spurious-change bug the `nested-stack-3level` integ
 * found: a nested child template whose property derives from a DOWN-passed
 * `Parameter` (CDK's `referenceto<Parent>...` synthesized input) diffed as a
 * spurious UPDATE on a freshly-deployed tree, because the recursive diff
 * resolver was never given the resolved parameter values that the deploy
 * engine forwarded to the child (`NestedStackProvider.extractParameters` ->
 * `DeployEngineOptions.parameters`). The state held the resolved string while
 * the diff kept the raw `Fn::Join`/`Ref` intrinsic -> `valuesEqual` reported
 * "changed".
 */
describe('buildDiffTree — down-passed nested-stack Parameters (spurious-change regression)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-param-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const PARAM = 'referencetoParentTopicName';

  // Parent owns a Topic; its name is threaded DOWN into the child as a
  // synthesized nested-stack Parameter. The child's SSM param Value is
  // `Fn::Join['', ['prefix:', {Ref: PARAM}]]` — exactly the great-grandchild
  // shape from the fixture (one boundary is enough to reproduce).
  function writeChildTemplate(): string {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [PARAM]: { Type: 'String' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Type: 'String',
              Value: { 'Fn::Join': ['', ['prefix:', { Ref: PARAM }]] },
            },
          },
        },
      })
    );
    return childPath;
  }

  function parentTemplate(): CloudFormationTemplate {
    return {
      Resources: {
        ParentTopic: { Type: 'AWS::SNS::Topic', Properties: {} },
        Child: {
          Type: NESTED,
          Metadata: { 'aws:asset:path': 'child.json' },
          Properties: {
            // CDK passes the parent topic name DOWN via Fn::GetAtt on the
            // AWS::CloudFormation::Stack row's Parameters block.
            Parameters: { [PARAM]: { 'Fn::GetAtt': ['ParentTopic', 'TopicName'] } },
          },
        },
      },
    };
  }

  // Freshly-deployed state: the parent topic's physical id is its name, the
  // child's SSM Value is the RESOLVED `prefix:<topic-name>` string (what the
  // deploy engine wrote after forwarding the resolved parameter).
  function freshStates(): Record<string, StackState> {
    return {
      Parent: st('Parent', {
        ParentTopic: {
          physicalId: 'arn:aws:sns:us-east-1:111111111111:my-topic',
          resourceType: 'AWS::SNS::Topic',
          properties: {},
          attributes: { TopicName: 'my-topic' },
          dependencies: [],
        },
        Child: res(NESTED, { Parameters: { [PARAM]: 'my-topic' } }),
      }),
      'Parent~Child': st('Parent~Child', {
        ChildRes: res('AWS::SSM::Parameter', { Type: 'String', Value: 'prefix:my-topic' }),
      }),
    };
  }

  it('diffs a freshly-deployed down-passed-parameter child as NO_CHANGE', async () => {
    const childPath = writeChildTemplate();
    const backend = fakeBackend(freshStates());

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate(),
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    expect(root.children).toHaveLength(1);
    const child = root.children[0]!;
    expect(child.stackName).toBe('Parent~Child');
    // The crux: the child's down-passed-parameter property must NOT surface as
    // a spurious change on a freshly-deployed tree.
    expect(child.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    expect(nodeHasChanges(child)).toBe(false);
    expect(treeHasChanges(root)).toBe(false);
  });

  it('still detects a genuine change to the resolved down-passed value (regression guard)', async () => {
    const childPath = writeChildTemplate();
    // State holds a STALE resolved value (topic was renamed out of band /
    // the prefix changed) -> the child must diff as UPDATE.
    const states = freshStates();
    states['Parent~Child']!.resources['ChildRes']!.properties['Value'] = 'prefix:OLD-topic';
    const backend = fakeBackend(states);

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate(),
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')!.changeType).toBe('UPDATE');
    expect(treeHasChanges(root)).toBe(true);
  });

  it('computeStackDiff resolves a Ref to a supplied parameter (NO_CHANGE)', async () => {
    const template: CloudFormationTemplate = {
      Parameters: { [PARAM]: { Type: 'String' } },
      Resources: {
        A: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Type: 'String', Value: { 'Fn::Join': ['', ['prefix:', { Ref: PARAM }]] } },
        },
      },
    };
    const state = st('S', { A: res('AWS::SSM::Parameter', { Type: 'String', Value: 'prefix:my-topic' }) });
    const { changes } = await computeStackDiff(
      state,
      template,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      { parameters: { [PARAM]: 'my-topic' } }
    );
    expect(changes.get('A')!.changeType).toBe('NO_CHANGE');
  });

  it('computeStackDiff without the parameter reports the spurious change (proves the fix path)', async () => {
    const template: CloudFormationTemplate = {
      Parameters: { [PARAM]: { Type: 'String' } },
      Resources: {
        A: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Type: 'String', Value: { 'Fn::Join': ['', ['prefix:', { Ref: PARAM }]] } },
        },
      },
    };
    const state = st('S', { A: res('AWS::SSM::Parameter', { Type: 'String', Value: 'prefix:my-topic' }) });
    // No parameters passed -> the Ref cannot resolve -> raw intrinsic kept ->
    // spurious UPDATE. This is the pre-fix behavior the recursive walker hit.
    const { changes } = await computeStackDiff(
      state,
      template,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator()
    );
    expect(changes.get('A')!.changeType).toBe('UPDATE');
  });
});

describe('Outputs-only change (issue #1921)', () => {
  // `cdkd deploy` persists an Outputs-only change (#875) but `cdkd diff` did
  // not report one: the calculator compares Resources alone, so a stack that
  // gained an export with a byte-identical Resources section printed "No
  // changes detected" and `--fail` exited 0 — steering the user away from the
  // very deploy that would repair a downstream Fn::ImportValue.
  const ARN = 'arn:aws:ssm:us-east-1:1:parameter/p';

  /** Template whose single resource matches `stateWithOutputs`'s resource exactly. */
  function template(outputs?: CloudFormationTemplate['Outputs']): CloudFormationTemplate {
    return {
      Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
      ...(outputs && { Outputs: outputs }),
    };
  }

  function stateWith(outputs: Record<string, unknown>): StackState {
    return {
      stackName: 'S',
      region: 'us-east-1',
      resources: { A: res('AWS::SSM::Parameter', { Value: 'x' }) },
      outputs,
      version: 6,
      lastModified: 0,
    };
  }

  const diffFor = async (state: StackState, tpl: CloudFormationTemplate) =>
    computeStackDiff(state, tpl, 'us-east-1', 'S', fakeBackend({}), new DiffCalculator());

  it('an added export is reported even though every resource is NO_CHANGE', async () => {
    const { changes, outputChanges } = await diffFor(
      stateWith({}),
      template({ Arn: { Value: ARN, Export: { Name: 'S:Arn' } } })
    );
    expect([...changes.values()].every((c) => c.changeType === 'NO_CHANGE')).toBe(true);
    expect(outputChanges).toEqual([
      { name: 'Arn', changeType: 'ADD', newValue: ARN, isExport: false },
      { name: 'S:Arn', changeType: 'ADD', newValue: ARN, isExport: true },
    ]);
  });

  it('a changed value and a removed key are both reported', async () => {
    const { outputChanges } = await diffFor(
      stateWith({ Kept: 'old', Gone: 'bye' }),
      template({ Kept: { Value: 'new' } })
    );
    expect(outputChanges).toEqual([
      { name: 'Kept', changeType: 'MODIFY', oldValue: 'old', newValue: 'new', isExport: false },
      { name: 'Gone', changeType: 'REMOVE', oldValue: 'bye', isExport: false },
    ]);
  });

  it('an unchanged stack with unchanged outputs reports NO delta (no phantom)', async () => {
    // The acceptance criterion that guards against the fix over-firing: the two
    // resolution paths must agree, or every diff of a clean stack shows churn.
    const { outputChanges } = await diffFor(
      stateWith({ Arn: ARN, 'S:Arn': ARN }),
      template({ Arn: { Value: ARN, Export: { Name: 'S:Arn' } } })
    );
    expect(outputChanges).toEqual([]);
  });

  it('a stack with no Outputs on either side reports NO delta', async () => {
    const { outputChanges } = await diffFor(stateWith({}), template());
    expect(outputChanges).toEqual([]);
  });

  it('nodeHasChanges / treeHasChanges are TRUE for an Outputs-only delta', async () => {
    const backend = fakeBackend({ S: stateWith({}) });
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: template({ Arn: { Value: ARN, Export: { Name: 'S:Arn' } } }),
      nestedTemplates: {},
      recursive: false,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    // Without the #1921 arm both are false and `cdkd diff` prints
    // "No changes detected" while `--fail` exits 0.
    expect(nodeHasChanges(node)).toBe(true);
    expect(treeHasChanges(node)).toBe(true);
  });

  it('an unchanged stack stays FALSE (the fix does not make every diff dirty)', async () => {
    const backend = fakeBackend({ S: stateWith({ Arn: ARN, 'S:Arn': ARN }) });
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: template({ Arn: { Value: ARN, Export: { Name: 'S:Arn' } } }),
      nestedTemplates: {},
      recursive: false,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(treeHasChanges(node)).toBe(false);
  });

  it('an output referencing a not-yet-created resource suppresses the delta, not the diff', async () => {
    // Best-effort resolution: the reference cannot resolve until the CREATE
    // lands, so reporting it would be a phantom the apply never writes. The
    // resource CREATE is still reported.
    const tpl: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
        New: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } },
      },
      Outputs: { Pending: { Value: { 'Fn::GetAtt': ['New', 'Arn'] } } },
    };
    const { changes, outputChanges } = await diffFor(stateWith({}), tpl);
    expect(changes.get('New')!.changeType).toBe('CREATE');
    expect(outputChanges).toEqual([]);
  });

  it('renders a human Outputs section, marking the export row', async () => {
    const backend = fakeBackend({ S: stateWith({ Old: 'x' }) });
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: template({ Arn: { Value: ARN, Export: { Name: 'S:Arn' } } }),
      nestedTemplates: {},
      recursive: false,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const out = lines.join('\n');
    expect(out).toContain('Outputs:');
    expect(out).toContain('[+] Arn');
    // The `[export]` tag is the load-bearing half: that string is what a
    // consumer's Fn::ImportValue resolves against.
    expect(out).toContain('[+] S:Arn [export]');
    expect(out).toContain('[-] Old');
    expect(out).toContain('2 output(s) to add, 0 to change, 1 to remove');
    // The resource summary stays resource-scoped — an Outputs write is not an
    // AWS operation and must not inflate the create/update/delete counts.
    expect(out).toContain('0 to create, 0 to update, 0 to delete');
  });

  it('WIRING (issue #1942): the stored bag decides a literal export alias, so the section SURVIVES', async () => {
    // End-to-end through `computeStackDiff`, which is what actually threads
    // `currentState.outputs` into the resolver. Before this the whole Outputs
    // section was suppressed for a stack shaped like this and a genuine export
    // change went unreported (the #875 case).
    //
    // The secret uses the `Fn::Join` shape a CDK L2 renders: a plain string
    // would pass the signal for the wrong reason (a shallow scan finds it),
    // which is how the last defect in this file survived a round.
    const secretJoin = {
      'Fn::Join': ['', ['pre-', '{{resolve:secretsmanager:prod/db:SecretString:pw}}']],
    };
    const tpl: CloudFormationTemplate = {
      Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
      Outputs: {
        DbSecret: { Value: secretJoin },
        Exporter: { Value: ARN, Export: { Name: 'S:Arn' } },
      },
    };

    const { outputChanges } = await diffFor(
      stateWith({ 'S:Arn': 'arn:aws:ssm:us-east-1:1:parameter/OLD', Exporter: ARN }),
      tpl
    );

    const aliasRow = outputChanges.find((c) => c.name === 'S:Arn');
    expect(aliasRow?.changeType).toBe('MODIFY');
    expect(aliasRow?.isExport).toBe(true);
    expect(aliasRow?.newValue).toBe(ARN);
  });

  it('WIRING (issue #1942): still suppressed when the stored bag lacks the alias key', async () => {
    const secretJoin = {
      'Fn::Join': ['', ['pre-', '{{resolve:secretsmanager:prod/db:SecretString:pw}}']],
    };
    const tpl: CloudFormationTemplate = {
      Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
      Outputs: {
        DbSecret: { Value: secretJoin },
        Exporter: { Value: ARN, Export: { Name: 'S:Arn' } },
      },
    };

    const { outputChanges } = await diffFor(stateWith({ Exporter: 'something-else' }), tpl);
    expect(outputChanges).toEqual([]);
  });

  it('WIRING (issue #1948): a deleted secret output prints no stored plaintext', async () => {
    // The template's ONLY remaining secret reference is in a RESOURCE, so
    // `secretSourceKeys` is empty and the record reads as post-GHSA — which is
    // exactly the shape whose stored plaintext used to render as a REMOVE row.
    // This test is what proves `declaredKeys` / `templateHasSecretReference`
    // actually reach `computeOutputsDiff`; the analyzer suite alone would pass
    // with the arguments never threaded.
    const tpl: CloudFormationTemplate = {
      Resources: {
        A: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Value: 'x',
            Description: '{{resolve:secretsmanager:prod/db:SecretString:pw}}',
          },
        },
      },
      Outputs: { ApiUrl: { Value: 'https://new.example.com' } },
    };

    const { outputChanges } = await diffFor(
      stateWith({ DbPassword: 'hunter2', ApiUrl: 'https://old.example.com' }),
      tpl
    );

    const removed = outputChanges.find((c) => c.name === 'DbPassword');
    expect(removed?.changeType).toBe('REMOVE');
    expect(removed?.oldValueRedacted).toBe(true);
    expect(removed?.oldValue).toBeUndefined();
    // Per-key: the accountable row keeps its value.
    const modified = outputChanges.find((c) => c.name === 'ApiUrl');
    expect(modified?.oldValue).toBe('https://old.example.com');
    expect(JSON.stringify(outputChanges)).not.toContain('hunter2');
  });

  it('WIRING (issue #1948): an ordinary stack still prints its REMOVE value', async () => {
    // The control for the wiring above — without it the test could pass on a
    // gate that fires for every stack.
    const { outputChanges } = await diffFor(
      stateWith({ Gone: 'arn:aws:s3:::gone', ApiUrl: 'https://old.example.com' }),
      template({ ApiUrl: { Value: 'https://new.example.com' } })
    );
    const removed = outputChanges.find((c) => c.name === 'Gone');
    expect(removed?.oldValue).toBe('arn:aws:s3:::gone');
    expect(removed?.oldValueRedacted).toBeUndefined();
  });

  it('renders a MODIFY row with both sides and the change count', () => {
    const lines: string[] = [];
    const counts = renderOutputChangeLines(
      [{ name: 'Out', changeType: 'MODIFY', oldValue: 'a', newValue: 'b', isExport: false }],
      (m) => lines.push(m)
    );
    const out = lines.join('\n');
    expect(out).toContain('[~] Out');
    expect(out).toContain('old: "a"');
    expect(out).toContain('new: "b"');
    expect(counts).toEqual({ add: 0, change: 1, remove: 0 });
  });

  it('WITHHOLDS a redacted legacy-plaintext old value in the human render', () => {
    const lines: string[] = [];
    renderOutputChangeLines(
      [
        {
          name: 'DbPassword',
          changeType: 'MODIFY',
          newValue: '{{resolve:secretsmanager:prod/db:SecretString:password}}',
          isExport: false,
          oldValueRedacted: true,
        },
      ],
      (m) => lines.push(m)
    );
    const out = lines.join('\n');
    expect(out).toContain('<redacted: may be legacy plaintext in state');
    expect(out).not.toContain('hunter2');
  });

  it('strips control characters from a template-controlled output name', () => {
    // An Export.Name is a RESOLVED value (Fn::Sub / parameter / SSM), so unlike
    // a CFn logical id it never passed a validator and can carry ANSI escapes
    // that would rewrite the surrounding diff output.
    const lines: string[] = [];
    renderOutputChangeLines(
      [{ name: 'Evil\u001b[2KName\r', changeType: 'ADD', newValue: 'v', isExport: true }],
      (m) => lines.push(m)
    );
    const out = lines.join('\n');
    // The ESC is what makes `[2K` an ERASE-LINE command; stripping it leaves the
    // residual bracket text as inert characters, which is the point -- the
    // sequence can no longer act on the terminal.
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\r');
    expect(out).toContain('[export]');
  });

  it('WITHHOLDS a redacted legacy-plaintext old value in --json too', () => {
    const node: DiffTreeNode = {
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      changes: changeMap([]),
      ccApiRoutes: new Map(),
      outputChanges: [
        {
          name: 'DbPassword',
          changeType: 'MODIFY',
          newValue: '{{resolve:secretsmanager:prod/db:SecretString:password}}',
          isExport: false,
          oldValueRedacted: true,
        },
      ],
      adoptedOrphans: [],
      unreadable: [],
      blocking: [],
      children: [],
    };
    const json = diffTreeToJson(node);
    expect(json.outputChanges[0]!.oldValueRedacted).toBe(true);
    expect(Object.keys(json.outputChanges[0]!)).not.toContain('oldValue');
    expect(JSON.stringify(json)).not.toContain('hunter2');
  });

  it('threads evaluated conditions, so a condition-false output is not reported', async () => {
    // Without `conditions` reaching resolveTemplateOutputs, a condition-false
    // output would be resolved and reported as an ADD the deploy never writes.
    const tpl: CloudFormationTemplate = {
      Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
      Conditions: { IsDev: { 'Fn::Equals': ['a', 'b'] } },
      Outputs: { DevOnly: { Value: 'dev', Condition: 'IsDev' } },
    };
    const { outputChanges } = await diffFor(stateWith({}), tpl);
    expect(outputChanges).toEqual([]);
  });

  it('a nested child carries its OWN Outputs delta under --recursive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-1921-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
          Outputs: { ChildOut: { Value: 'child-value' } },
        })
      );
      const parentTemplate: CloudFormationTemplate = {
        Resources: {
          Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
        },
      };
      const backend = fakeBackend({
        P: st('P', { Child: res(NESTED, {}) }),
        'P~Child': stateWith({}),
      });
      const node = await buildDiffTree({
        stackName: 'P',
        displayName: 'P',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: backend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      expect(node.outputChanges).toEqual([]);
      expect(node.children[0]!.outputChanges).toEqual([
        { name: 'ChildOut', changeType: 'ADD', newValue: 'child-value', isExport: false },
      ]);
      // The parent node is clean, so only the CHILD's delta can make the tree dirty.
      expect(treeHasChanges(node)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a nested child removed from the template reports its outputs as REMOVE', async () => {
    const backend = fakeBackend({
      P: st('P', { Gone: res(NESTED, {}) }),
      'P~Gone': stateWith({ OldOut: 'v' }),
    });
    const node = await buildDiffTree({
      stackName: 'P',
      displayName: 'P',
      region: 'us-east-1',
      template: { Resources: {} },
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(node.children[0]!.outputChanges).toEqual([
      { name: 'OldOut', changeType: 'REMOVE', oldValue: 'v', isExport: false },
    ]);
  });

  it('WITHHOLDS a deleted nested child\'s stored values when the PARENT proves a secret (issue #1948 review)', async () => {
    // The child is diffed against an EMPTY template, so it can compute nothing
    // about secrets from its own input: `templateHasSecretReference` is false,
    // `declaredKeys` and `desired` are empty, and none of the three withholding
    // arms can fire — a pre-GHSA child's WHOLE stored bag rendered with values,
    // one level up from the #1948 top-level case. The parent's template is the
    // evidence, threaded down by `buildDeletedSubtree`.
    const backend = fakeBackend({
      P: st('P', { Gone: res(NESTED, {}) }),
      'P~Gone': stateWith({ DbPassword: 'hunter2', ApiUrl: 'https://old.example.com' }),
    });
    const node = await buildDiffTree({
      stackName: 'P',
      displayName: 'P',
      region: 'us-east-1',
      template: {
        Resources: {
          Fn: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              Environment: {
                Variables: { PW: '{{resolve:secretsmanager:prod/db:SecretString:pw}}' },
              },
            },
          },
        },
      },
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    const rows = node.children[0]!.outputChanges;
    expect(rows.map((c) => c.name).sort()).toEqual(['ApiUrl', 'DbPassword']);
    // Both rows are still REPORTED — only the values are withheld.
    for (const row of rows) {
      expect(row.changeType).toBe('REMOVE');
      expect(row.oldValueRedacted).toBe(true);
      expect(row.oldValue).toBeUndefined();
    }
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });

  it('a deleted nested child in an ORDINARY parent still prints its values', async () => {
    // The control. Without it the assertion above would pass on a rule that
    // withholds every deleted child's bag on every stack.
    const backend = fakeBackend({
      P: st('P', { Gone: res(NESTED, {}) }),
      'P~Gone': stateWith({ ApiUrl: 'https://old.example.com' }),
    });
    const node = await buildDiffTree({
      stackName: 'P',
      displayName: 'P',
      region: 'us-east-1',
      template: { Resources: {} },
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(node.children[0]!.outputChanges).toEqual([
      { name: 'ApiUrl', changeType: 'REMOVE', oldValue: 'https://old.example.com', isExport: false },
    ]);
  });

  it('propagates the parent signal to a deleted GRANDchild', async () => {
    // The recursion re-passes the flag rather than recomputing it: a
    // grandchild's template is gone for the same reason its parent's is.
    const backend = fakeBackend({
      P: st('P', { Gone: res(NESTED, {}) }),
      'P~Gone': { ...st('P~Gone', { Deeper: res(NESTED, {}) }), outputs: {} },
      'P~Gone~Deeper': stateWith({ DbPassword: 'hunter2' }),
    });
    const node = await buildDiffTree({
      stackName: 'P',
      displayName: 'P',
      region: 'us-east-1',
      template: {
        Resources: {
          Fn: {
            Type: 'AWS::Lambda::Function',
            Properties: { Pw: '{{resolve:secretsmanager:prod/db:SecretString:pw}}' },
          },
        },
      },
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    const grandchild = node.children[0]!.children[0]!;
    expect(grandchild.stackName).toBe('P~Gone~Deeper');
    expect(grandchild.outputChanges[0]!.oldValueRedacted).toBe(true);
    expect(JSON.stringify(grandchild.outputChanges)).not.toContain('hunter2');
  });

  it('an INTERMEDIATE live template without a secret does not break the chain (issue #1948 review)', async () => {
    // The per-level version of this was wrong: each `buildDiffTree` armed its
    // own deleted children from its OWN template only. Root references a
    // secret, the live middle child does not, and the deleted GRANDchild holds
    // a pre-GHSA bag — so the level that mattered answered `false` and the
    // stored plaintext printed. The flag now accumulates with OR down the walk.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-1948-'));
    const midPath = join(dir, 'mid.template.json');
    writeFileSync(
      midPath,
      // `Gone` is deliberately ABSENT here while state still carries it — that
      // is what makes it a DELETED grandchild. No secret reference either.
      JSON.stringify({
        Resources: { MidRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'ordinary' } } },
      })
    );
    const backend = fakeBackend({
      P: st('P', { Mid: res(NESTED, {}) }),
      'P~Mid': st('P~Mid', { Gone: res(NESTED, {}) }),
      'P~Mid~Gone': stateWith({ DbPassword: 'hunter2' }),
    });
    const node = await buildDiffTree({
      stackName: 'P',
      displayName: 'P',
      region: 'us-east-1',
      // The ROOT carries the only secret reference in the tree.
      template: {
        Resources: {
          Mid: { Type: NESTED, Properties: {} },
          Fn: {
            Type: 'AWS::Lambda::Function',
            Properties: { Pw: '{{resolve:secretsmanager:prod/db:SecretString:pw}}' },
          },
        },
      },
      // The intermediate child's own template has NO secret reference.
      nestedTemplates: { Mid: midPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    const deletedGrandchild = node.children[0]!.children[0]!;
    expect(deletedGrandchild.stackName).toBe('P~Mid~Gone');
    expect(deletedGrandchild.outputChanges[0]!.oldValueRedacted).toBe(true);
    expect(JSON.stringify(deletedGrandchild.outputChanges)).not.toContain('hunter2');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT warn when the suppressed delta is only the pending output itself', async () => {
    // The regression this pins: this resolver DROPS an unresolved key (deploy
    // keeps it as `undefined`), so a naive diff reads it as a REMOVE and the
    // suppression warning fires on the ordinary, expected pending-resource case
    // -- including the first diff of a never-deployed stack.
    const warn = vi.mocked(getLogger().warn);
    warn.mockClear();
    const tpl: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
        New: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } },
      },
      Outputs: { Pending: { Value: { 'Fn::GetAtt': ['New', 'Arn'] } } },
    };
    const { outputChanges } = await diffFor(stateWith({ Pending: 'stale' }), tpl);
    expect(outputChanges).toEqual([]);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes('could not be resolved'))).toEqual([]);
  });

  it('DOES warn when a genuine other-key delta was suppressed', async () => {
    const warn = vi.mocked(getLogger().warn);
    warn.mockClear();
    const tpl: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
        New: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } },
      },
      Outputs: {
        Pending: { Value: { 'Fn::GetAtt': ['New', 'Arn'] } },
        Real: { Value: 'changed' },
      },
    };
    const { outputChanges } = await diffFor(stateWith({ Real: 'was' }), tpl);
    expect(outputChanges).toEqual([]);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('could not be resolved'))).toBe(true);
  });

  describe('a no-change stack previews the deploy merge beside a failing output (issue #3101)', () => {
    // `Gone` is in neither the template nor state, so `Fn::GetAtt` on it THROWS
    // in the real resolver: the failure the deploy engine records too (its
    // catch stores `undefined`). Every case keeps the resource diff empty
    // except the pending-resource-change cases.
    const FAILING = { 'Fn::GetAtt': ['Gone', 'Arn'] };

    /**
     * Clears the warn mock, and returns a reader for the section-suppression
     * warnings since. Keyed on the diff's own sentence: the resolver's warning
     * for a kept `Fn::Sub` placeholder also says "could not be resolved".
     */
    function captureSuppressionWarnings(): () => string[] {
      const warn = vi.mocked(getLogger().warn);
      warn.mockClear();
      return () =>
        warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes('omitting the Outputs section from this diff'));
    }

    /** The merged-path warnings naming the outputs this diff could not resolve. */
    function carriedOutputWarnings(): string[] {
      return vi
        .mocked(getLogger().warn)
        .mock.calls.map((c) => String(c[0]))
        .filter((m) => m.includes('output(s) could not be resolved for this diff.'));
    }

    it('reports a sibling ADD, and no row for a failed output that keeps its stored value', async () => {
      const suppressed = captureSuppressionWarnings();
      const { changes, outputChanges } = await diffFor(
        stateWith({ Out: 'stored', Plain: 'p' }),
        template({ Out: { Value: FAILING }, Plain: { Value: 'p' }, Plain2: { Value: 'p2' } })
      );
      expect([...changes.values()].every((c) => c.changeType === 'NO_CHANGE')).toBe(true);
      // Pre-fix: `[]` plus the suppression warning. A merge fed the resolver's
      // bag without `Out` present-as-undefined would also print a REMOVE of it.
      expect(outputChanges).toEqual([
        { name: 'Plain2', changeType: 'ADD', newValue: 'p2', isExport: false },
      ]);
      expect(suppressed()).toEqual([]);
      // ...but not silent about the output it could not see.
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      expect(carried[0]).toContain(
        '1 output(s) could not be resolved for this diff. Compared at their stored values: Out.'
      );
      // Only `Out` failed, and it is stored (m17).
      expect(carried[0]).not.toContain('No stored value under their own names');
      // `Out`'s stored plaintext forces the verdict, but the section is a single
      // ADD, so nothing is withheld and the sentence must not claim otherwise
      // (review M14).
      expect(carried[0]).not.toContain('Previous values in this Outputs section are withheld');
    });

    it('makes the stack dirty for --fail', async () => {
      const node = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } }),
        nestedTemplates: {},
        recursive: false,
        stateBackend: fakeBackend({ S: stateWith({ Out: 'stored' }) }),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      expect(treeHasChanges(node)).toBe(true);
    });

    // Every resource change kind, since the gate is "any change", not "a CREATE".
    it.each([
      {
        changeType: 'CREATE',
        logicalId: 'New',
        edit: (tpl: CloudFormationTemplate, _state: StackState): void => {
          tpl.Resources['New'] = { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } };
        },
      },
      {
        changeType: 'UPDATE',
        logicalId: 'A',
        edit: (tpl: CloudFormationTemplate, _state: StackState): void => {
          tpl.Resources['A'] = { Type: 'AWS::SSM::Parameter', Properties: { Value: 'changed' } };
        },
      },
      {
        changeType: 'DELETE',
        logicalId: 'Old',
        edit: (_tpl: CloudFormationTemplate, state: StackState): void => {
          state.resources['Old'] = res('AWS::SSM::Parameter', { Value: 'z' });
        },
      },
    ])(
      'keeps the suppression while a resource $changeType is pending',
      async ({ changeType, logicalId, edit }) => {
        const suppressed = captureSuppressionWarnings();
        const tpl = template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } });
        const state = stateWith({ Out: 'stored' });
        edit(tpl, state);
        const { changes, outputChanges } = await diffFor(state, tpl);
        expect(changes.get(logicalId)!.changeType).toBe(changeType);
        expect(outputChanges).toEqual([]);
        expect(suppressed()).toHaveLength(1);
      }
    );

    it('reports a changed sibling and a key the merge removes', async () => {
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'stored', Plain: 'old', Deleted: 'bye' }),
        template({ Out: { Value: FAILING }, Plain: { Value: 'new' } })
      );
      // Both rows render; their old values are withheld because `Out` is carried
      // at a stored value that is not a secret expression (see the B2 cases).
      expect(outputChanges).toEqual([
        { name: 'Plain', changeType: 'MODIFY', newValue: 'new', isExport: false, oldValueRedacted: true },
        { name: 'Deleted', changeType: 'REMOVE', isExport: false, oldValueRedacted: true },
      ]);
    });

    it('never previews a failed output with no stored value as an ADD', async () => {
      // Pins the no-ADD outcome only. With no stored value the merge answers
      // the same whether or not the failed key is present as `undefined`; that
      // injection is pinned by the stored-value case above.
      vi.mocked(getLogger().warn).mockClear();
      const { outputChanges } = await diffFor(
        stateWith({}),
        template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } })
      );
      expect(outputChanges).toEqual([
        { name: 'Plain2', changeType: 'ADD', newValue: 'p2', isExport: false },
      ]);
      // Nothing was carried, so the warning must not claim a comparison at all
      // (review M9): only the left-out part appears.
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      expect(carried[0]).toContain('No stored value under their own names: Out.');
      expect(carried[0]).not.toContain('Compared at their stored values');
    });

    it('carries the literal export alias the previous record published', async () => {
      // `previousExportNames` comes from the record: without it the merge drops
      // the alias and this prints a REMOVE of `S:Out`.
      const state: StackState = {
        ...stateWith({ Out: 'stored', 'S:Out': 'stored' }),
        exportNames: ['S:Out'],
      };
      const { outputChanges } = await diffFor(
        state,
        template({ Out: { Value: FAILING, Export: { Name: 'S:Out' } }, Plain2: { Value: 'p2' } })
      );
      expect(outputChanges).toEqual([
        { name: 'Plain2', changeType: 'ADD', newValue: 'p2', isExport: false },
      ]);
    });

    it('tags the export alias of a resolved sibling in the merged bag', async () => {
      // The alias row is `isExport: true` only if BOTH the merge's input export
      // set and the set the comparison reads carry it.
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'stored' }),
        template({
          Out: { Value: FAILING },
          Shared: { Value: 'v', Export: { Name: 'S:Shared' } },
        })
      );
      expect(outputChanges).toEqual([
        { name: 'Shared', changeType: 'ADD', newValue: 'v', isExport: false },
        { name: 'S:Shared', changeType: 'ADD', newValue: 'v', isExport: true },
      ]);
    });

    it('keeps a resolved __proto__ export alias in the bag handed to the merge', async () => {
      // `withFailedOutputsUndefined` copies into a null-prototype bag: on a
      // plain object the `__proto__` write hits the prototype setter, the key
      // is dropped, and the merge never sees the alias.
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'stored' }),
        template({
          Out: { Value: FAILING },
          Shared: { Value: 'v', Export: { Name: '__proto__' } },
        })
      );
      expect(outputChanges).toEqual([
        { name: 'Shared', changeType: 'ADD', newValue: 'v', isExport: false },
        { name: '__proto__', changeType: 'ADD', newValue: 'v', isExport: true },
      ]);
    });

    it('keeps the suppression when the deploy would keep the previous bag whole', async () => {
      // A failed output with a stored value and an INTRINSIC `Export.Name`:
      // the merge refuses, so the deploy writes nothing and neither may this.
      const suppressed = captureSuppressionWarnings();
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'stored', 'S-Out': 'stored' }),
        template({
          // `TemplateOutput` types the name as a string; CloudFormation allows an intrinsic.
          Out: {
            Value: FAILING,
            Export: { Name: { 'Fn::Join': ['-', ['S', 'Out']] } as unknown as string },
          },
          Plain2: { Value: 'p2' },
        })
      );
      expect(outputChanges).toEqual([]);
      expect(suppressed()).toHaveLength(1);
    });

    it('keeps the suppression for a failure only the diff reports', async () => {
      // An undeclared `Fn::Sub` head keeps its literal placeholder: the deploy
      // writes that string, so the output is not a failed key there.
      const suppressed = captureSuppressionWarnings();
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'stored' }),
        template({ Out: { Value: { 'Fn::Sub': '${Gone.Arn}-suffix' } }, Plain2: { Value: 'p2' } })
      );
      expect(outputChanges).toEqual([]);
      expect(suppressed()).toHaveLength(1);
    });

    it('keeps the suppression when an Export.Name cannot be resolved', async () => {
      const suppressed = captureSuppressionWarnings();
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'stored' }),
        template({
          Out: { Value: FAILING },
          Named: { Value: 'v', Export: { Name: { Ref: 'Missing' } as unknown as string } },
        })
      );
      expect(outputChanges).toEqual([]);
      expect(suppressed()).toHaveLength(1);
    });

    it('keeps the suppression when an Export.Name keeps an unsubstituted Fn::Sub placeholder', async () => {
      // An undeclared `Fn::Sub` head keeps its placeholder, so the name comes
      // back as a STRING carrying `${Gone.Arn}` rather than throwing. This is
      // the placeholder arm; a surviving intrinsic OBJECT is covered in
      // tests/unit/analyzer/outputs-diff.test.ts.
      const suppressed = captureSuppressionWarnings();
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'stored' }),
        template({
          Out: { Value: FAILING },
          Named: {
            Value: 'v',
            Export: { Name: { 'Fn::Sub': '${Gone.Arn}-name' } as unknown as string },
          },
        })
      );
      expect(outputChanges).toEqual([]);
      expect(suppressed()).toHaveLength(1);
    });

    it('carries the literal alias of a pre-v9 record whose export set is unknown', async () => {
      // No `exportNames` on the record: every stored key counts as importable.
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'stored', 'S:Out': 'stored' }),
        template({ Out: { Value: FAILING, Export: { Name: 'S:Out' } }, Plain2: { Value: 'p2' } })
      );
      expect(outputChanges).toEqual([
        { name: 'Plain2', changeType: 'ADD', newValue: 'p2', isExport: false },
      ]);
    });

    it('names every failed output in the warning, stored or not, with control characters stripped', async () => {
      // Two failures: `A` keeps a stored value, the second has none and a
      // template-controlled name carrying an escape sequence.
      const second = 'B\u001b[31m';
      captureSuppressionWarnings();
      const { outputChanges } = await diffFor(
        stateWith({ A: 'stored' }),
        template({ A: { Value: FAILING }, [second]: { Value: FAILING } })
      );
      expect(outputChanges).toEqual([]);
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      // Only `A` is carried; the second has no stored value, so the merge does
      // not carry it and the warning must not claim it was compared (review M9).
      expect(carried[0]).toContain(
        '2 output(s) could not be resolved for this diff. Compared at their stored values: A. ' +
          'No stored value under their own names: B[31m.'
      );
      expect(carried[0]).not.toContain('\u001b');
      expect(carried[0]).toContain('The next deploy may write a value for any of them it can resolve.');
    });

    it('names the mixed-generation keep-whole reason in the suppression warning', async () => {
      // Carrying `Old` into a bag that gains its FIRST secret expression is the
      // merge's mixed-generation refusal; the warning must name that reason,
      // not the intrinsic-Export.Name one.
      const warn = vi.mocked(getLogger().warn);
      warn.mockClear();
      await diffFor(
        stateWith({ Old: 'maybe-a-pre-ghsa-plaintext' }),
        template({
          Old: { Value: FAILING },
          Sec: { Value: '{{resolve:secretsmanager:s:SecretString:k}}' },
        })
      );
      const messages = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('omitting the Outputs section from this diff'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('would put a redacted secret reference beside a carried value');
      expect(messages[0]).not.toContain('intrinsic Export.Name');
      expect(carriedOutputWarnings()).toEqual([]);
    });

    it('keeps the suppression when a condition reads a secret-valued parameter', async () => {
      // Condition evaluation is skipped (a condition reads a secret-valued
      // parameter). No condition verdict can reach an output in this template,
      // so the refusal is the `conditions` gate's; the unbound-parameter case
      // below reaches that gate by the other route.
      const suppressed = captureSuppressionWarnings();
      const tpl: CloudFormationTemplate = {
        ...template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } }),
        Parameters: { Secret: { Type: 'String' } },
        Conditions: { IsOn: { 'Fn::Equals': [{ Ref: 'Secret' }, 'x'] } },
      };
      const { outputChanges } = await computeStackDiff(
        stateWith({ Out: 'stored' }),
        tpl,
        'us-east-1',
        'S',
        fakeBackend({}),
        new DiffCalculator(),
        { parameters: { Secret: '{{resolve:secretsmanager:s:SecretString:k}}' } }
      );
      expect(outputChanges).toEqual([]);
      expect(suppressed()).toHaveLength(1);
    });

    it('keeps the suppression when template parameters cannot be bound', async () => {
      const suppressed = captureSuppressionWarnings();
      const tpl: CloudFormationTemplate = {
        ...template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } }),
        Parameters: { Required: { Type: 'String' } },
      };
      const { outputChanges } = await diffFor(stateWith({ Out: 'stored' }), tpl);
      expect(outputChanges).toEqual([]);
      expect(suppressed()).toHaveLength(1);
    });

    it('names the keep-whole reason in the suppression warning', async () => {
      const warn = vi.mocked(getLogger().warn);
      warn.mockClear();
      await diffFor(
        stateWith({ Out: 'stored', 'S-Out': 'stored' }),
        template({
          Out: {
            Value: FAILING,
            Export: { Name: { 'Fn::Join': ['-', ['S', 'Out']] } as unknown as string },
          },
          Plain2: { Value: 'p2' },
        })
      );
      const messages = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('omitting the Outputs section from this diff'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('An unresolved output declares an intrinsic Export.Name');
      expect(messages[0]).not.toContain('yet to create');
    });

    // A secret-bearing output that FAILS: the join resolves its `Fn::GetAtt`
    // part first, which throws.
    const SECRET_JOIN = {
      'Fn::Join': [
        '',
        ['{{resolve:secretsmanager:', { 'Fn::GetAtt': ['Gone', 'Arn'] }, ':SecretString:pw}}'],
      ],
    };

    it("withholds a legacy record's stored values on the merge path", async () => {
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'LEGACY-PLAINTEXT', Plain: 'old-plain' }),
        template({ Out: { Value: SECRET_JOIN }, Plain: { Value: 'new' } })
      );
      expect(outputChanges).toEqual([
        {
          name: 'Plain',
          changeType: 'MODIFY',
          newValue: 'new',
          isExport: false,
          oldValueRedacted: true,
        },
      ]);
      const lines: string[] = [];
      renderOutputChangeLines(outputChanges, (m) => lines.push(m));
      const shown = JSON.stringify(outputChanges) + lines.join('\n');
      expect(shown).not.toContain('LEGACY-PLAINTEXT');
      expect(shown).not.toContain('old-plain');
    });

    it('withholds a deleted key beside a failing secret-bearing output', async () => {
      const { outputChanges } = await diffFor(
        stateWith({ Out: 'x', Deleted: 'DELETED-PLAINTEXT' }),
        template({ Out: { Value: SECRET_JOIN } })
      );
      expect(outputChanges).toEqual([
        { name: 'Deleted', changeType: 'REMOVE', isExport: false, oldValueRedacted: true },
      ]);
      const lines: string[] = [];
      renderOutputChangeLines(outputChanges, (m) => lines.push(m));
      expect(JSON.stringify(outputChanges) + lines.join('\n')).not.toContain('DELETED-PLAINTEXT');
    });

    it('withholds a deleted key when the only secret reference is in an unchanged resource', async () => {
      // No output is secret-bearing, so the legacy-record arm stays off; only the
      // template-wide secret-reference gate can withhold the deleted key's value.
      const SECRET_REF = '{{resolve:secretsmanager:s:SecretString:k}}';
      const state: StackState = {
        ...stateWith({ Out: 'stored', Deleted: 'DELETED-ONLY-PLAINTEXT' }),
        resources: { A: res('AWS::SSM::Parameter', { Value: SECRET_REF }) },
      };
      const tpl: CloudFormationTemplate = {
        Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: SECRET_REF } } },
        Outputs: { Out: { Value: FAILING } },
      };
      const { changes, outputChanges } = await diffFor(state, tpl);
      expect([...changes.values()].every((c) => c.changeType === 'NO_CHANGE')).toBe(true);
      expect(outputChanges).toEqual([
        { name: 'Deleted', changeType: 'REMOVE', isExport: false, oldValueRedacted: true },
      ]);
      expect(JSON.stringify(outputChanges)).not.toContain('DELETED-ONLY-PLAINTEXT');
    });

    // Issue #3101 review (B2): `F` resolves to a secret expression when it
    // resolves (an `Fn::GetAtt` to an attribute the record stores as one), which
    // is what marks this pre-GHSA record legacy on the fully-resolved path.
    // Failing, it is carried at its stored PLAINTEXT and that evidence is gone,
    // so the carry itself must force the verdict. `A` holds the template's only
    // literal secret reference unless a case removes it.
    const SECRET_REF = '{{resolve:secretsmanager:s:SecretString:k}}';
    const WITHHELD_REASON =
      'Previous values in this Outputs section are withheld because a value carried from state for a failed output is not a secret reference, so this diff cannot rule out legacy plaintext in state. That reason no longer applies once every failed output resolves, though other legacy-plaintext checks still can withhold them.';
    function legacyStack(opts: {
      storedOutputs: Record<string, unknown>;
      attributes: Record<string, unknown>;
      secretInTemplate?: boolean;
    }): { state: StackState; tpl: CloudFormationTemplate } {
      const aValue = opts.secretInTemplate === false ? 'x' : SECRET_REF;
      const mySecret = { ...res('AWS::SSM::Parameter', { Value: 'y' }), attributes: opts.attributes };
      return {
        state: {
          ...stateWith(opts.storedOutputs),
          resources: { A: res('AWS::SSM::Parameter', { Value: aValue }), MySecret: mySecret },
        },
        tpl: {
          Resources: {
            A: { Type: 'AWS::SSM::Parameter', Properties: { Value: aValue } },
            MySecret: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } },
          },
          Outputs: {
            F: { Value: { 'Fn::GetAtt': ['MySecret', 'SecretArn'] } },
            G: { Value: 'new-g' },
          },
        },
      };
    }

    it('withholds a legacy record when the output that proves it resolves (premise)', async () => {
      vi.mocked(getLogger().warn).mockClear();
      const { state, tpl } = legacyStack({
        storedOutputs: { F: 'F-PLAINTEXT', G: 'old-g' },
        attributes: { SecretArn: SECRET_REF },
      });
      const { outputChanges } = await diffFor(state, tpl);
      expect(carriedOutputWarnings()).toEqual([]);
      expect(outputChanges.find((c) => c.name === 'G')).toEqual({
        name: 'G',
        changeType: 'MODIFY',
        newValue: 'new-g',
        isExport: false,
        oldValueRedacted: true,
      });
    });

    // The last two are the shapes a template-wide or bag-wide condition let
    // through: the fully-resolved path withholds `G` in both.
    it.each([
      {
        shape: 'a plaintext carried beside a secret reference in the template',
        opts: { storedOutputs: { F: 'F-PLAINTEXT', G: 'old-g' }, attributes: {} },
      },
      {
        shape: 'no secret reference anywhere in the template',
        opts: {
          storedOutputs: { F: 'F-PLAINTEXT', G: 'old-g' },
          attributes: {},
          secretInTemplate: false,
        },
      },
      {
        // Pass 1's veto excuses only a STRING leaf, so a list holding a secret
        // expression cannot excuse the carried key, and the force does not either
        // (`isSecretBearingReferenceString` is false for a non-string). The
        // carried list also marks the record legacy through `desired`, so this is
        // a behaviour case rather than a pin of the force alone.
        shape: 'a carried stored value that is a list holding a secret expression',
        opts: { storedOutputs: { F: [SECRET_REF], G: 'old-g' }, attributes: {} },
      },
      {
        shape: 'a secret expression stored under another key',
        opts: { storedOutputs: { F: 'F-PLAINTEXT', G: 'old-g', H: SECRET_REF }, attributes: {} },
      },
    ])('never lets a carried output exonerate a legacy record: $shape', async ({ opts }) => {
      vi.mocked(getLogger().warn).mockClear();
      const { state, tpl } = legacyStack(opts);
      const { changes, outputChanges } = await diffFor(state, tpl);
      expect([...changes.values()].every((c) => c.changeType === 'NO_CHANGE')).toBe(true);
      // PREMISE: F failed and was carried, so this is the merge path.
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      // The warning says why the old values are gone (review M10).
      expect(carried[0]).toContain(WITHHELD_REASON);
      expect(outputChanges.find((c) => c.name === 'G')).toEqual({
        name: 'G',
        changeType: 'MODIFY',
        newValue: 'new-g',
        isExport: false,
        oldValueRedacted: true,
      });
      const lines: string[] = [];
      renderOutputChangeLines(outputChanges, (m) => lines.push(m));
      const shown = JSON.stringify(outputChanges) + lines.join('\n');
      expect(shown).not.toContain('old-g');
      expect(shown).not.toContain('F-PLAINTEXT');
    });

    it('does not explain a withholding the carried values did not force', async () => {
      // `F` is carried at a stored secret expression, so the verdict is NOT
      // forced; the record is still legacy through pass 1, because `H`'s template
      // value is a secret reference while its stored value is plaintext. Rows are
      // withheld, but the sentence names a reason that does not hold here, so it
      // must stay silent: this pins the `withheld &&` half of its gate, a gap a maintainer-checklist pass found on the round-4 fixes.
      vi.mocked(getLogger().warn).mockClear();
      const { outputChanges } = await diffFor(
        stateWith({ F: SECRET_REF, H: 'H-PLAINTEXT', G: 'old-g' }),
        template({
          F: { Value: FAILING },
          H: { Value: '{{resolve:secretsmanager:h:SecretString:k}}' },
          G: { Value: 'new-g' },
        })
      );
      expect(outputChanges.find((c) => c.name === 'G')).toEqual({
        name: 'G',
        changeType: 'MODIFY',
        newValue: 'new-g',
        isExport: false,
        oldValueRedacted: true,
      });
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      expect(carried[0]).toContain('Compared at their stored values: F.');
      expect(carried[0]).not.toContain('Previous values in this Outputs section are withheld');
    });

    it('explains the withholding truthfully when only a failed output ALIAS is carried', async () => {
      // `Out` has no stored value under its own name, but its literal alias does
      // and was published, so the merge carries the alias alone (review M15).
      // The reason must not say a failed output was compared at a stored value.
      vi.mocked(getLogger().warn).mockClear();
      const { outputChanges } = await diffFor(
        stateWith({ 'S:Out': 'ALIAS-PLAINTEXT', G: 'old-g' }),
        template({ Out: { Value: FAILING, Export: { Name: 'S:Out' } }, G: { Value: 'new-g' } })
      );
      expect(outputChanges).toEqual([
        { name: 'G', changeType: 'MODIFY', newValue: 'new-g', isExport: false, oldValueRedacted: true },
      ]);
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      expect(carried[0]).toContain(
        '1 output(s) could not be resolved for this diff. No stored value under their own names: Out.'
      );
      expect(carried[0]).not.toContain('Compared at their stored values');
      expect(carried[0]).toContain(WITHHELD_REASON);
      expect(JSON.stringify(outputChanges)).not.toContain('ALIAS-PLAINTEXT');
    });

    it('forces the verdict when the carried plaintext is an export alias', async () => {
      // `merge.carriedKeys` holds carried ALIASES too. Here the output key's
      // stored value is a secret expression while its alias's is not, so only
      // the alias can force the verdict (review m11).
      vi.mocked(getLogger().warn).mockClear();
      const { state, tpl } = legacyStack({
        storedOutputs: { F: SECRET_REF, 'S:F': 'ALIAS-PLAINTEXT', G: 'old-g' },
        attributes: {},
      });
      (tpl.Outputs ??= {})['F'] = {
        Value: { 'Fn::GetAtt': ['MySecret', 'SecretArn'] },
        Export: { Name: 'S:F' },
      };
      const { outputChanges } = await diffFor(state, tpl);
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      expect(carried[0]).toContain(WITHHELD_REASON);
      expect(outputChanges.find((c) => c.name === 'G')).toEqual({
        name: 'G',
        changeType: 'MODIFY',
        newValue: 'new-g',
        isExport: false,
        oldValueRedacted: true,
      });
      const lines: string[] = [];
      renderOutputChangeLines(outputChanges, (m) => lines.push(m));
      expect(JSON.stringify(outputChanges) + lines.join('\n')).not.toContain('ALIAS-PLAINTEXT');
    });

    it('forces the verdict when ANY carried key is not a secret expression, not only the first', async () => {
      vi.mocked(getLogger().warn).mockClear();
      const { state, tpl } = legacyStack({
        storedOutputs: { E: SECRET_REF, F: 'F-PLAINTEXT', G: 'old-g' },
        attributes: {},
      });
      // `E` fails too and is declared first, so the carried keys are [E, F]: an
      // expression first, a plaintext second.
      tpl.Outputs = { E: { Value: FAILING }, ...tpl.Outputs };
      const { outputChanges } = await diffFor(state, tpl);
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      expect(carried[0]).toContain(
        '2 output(s) could not be resolved for this diff. Compared at their stored values: E, F.'
      );
      expect(outputChanges.find((c) => c.name === 'G')).toEqual({
        name: 'G',
        changeType: 'MODIFY',
        newValue: 'new-g',
        isExport: false,
        oldValueRedacted: true,
      });
    });

    it.each([
      {
        without: 'a carried key (the failed output had no stored value)',
        opts: { storedOutputs: { G: 'old-g' }, attributes: {} },
      },
      {
        without: 'a carried key whose stored value is anything but a secret expression',
        opts: { storedOutputs: { F: SECRET_REF, G: 'old-g' }, attributes: {} },
      },
    ])('does not force the legacy verdict without $without', async ({ opts }) => {
      vi.mocked(getLogger().warn).mockClear();
      const { state, tpl } = legacyStack(opts);
      const { outputChanges } = await diffFor(state, tpl);
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      expect(carried[0]).not.toContain(WITHHELD_REASON);
      expect(outputChanges.find((c) => c.name === 'G')).toEqual({
        name: 'G',
        changeType: 'MODIFY',
        oldValue: 'old-g',
        newValue: 'new-g',
        isExport: false,
      });
    });

    it('previews the merge for a record that has no outputs bag at all', async () => {
      // A hand-edited or pre-outputs record: the merge must read it as empty.
      const state = { ...stateWith({}), outputs: undefined as unknown as Record<string, unknown> };
      const { outputChanges } = await diffFor(
        state,
        template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } })
      );
      expect(outputChanges).toEqual([
        { name: 'Plain2', changeType: 'ADD', newValue: 'p2', isExport: false },
      ]);
    });

    it('keeps the suppression when the failed output reads a declared condition', async () => {
      // Conditions ARE evaluated here, but best-effort: the diff can still reach
      // a verdict the deploy does not, and an `Fn::If` in the output's own value
      // is a route by which it reaches the output, so the failure is not carried.
      const suppressed = captureSuppressionWarnings();
      const tpl: CloudFormationTemplate = {
        ...template({
          Out: { Value: { 'Fn::If': ['IsOn', FAILING, 'fallback'] } },
          Plain2: { Value: 'p2' },
        }),
        Conditions: { IsOn: { 'Fn::Equals': ['a', 'a'] } },
      };
      const { outputChanges } = await diffFor(stateWith({ Out: 'stored' }), tpl);
      expect(outputChanges).toEqual([]);
      expect(suppressed()).toHaveLength(1);
    });

    it('strips control characters from the stack name, parameter name and declared type in the parameter-type warning', async () => {
      // Both names are template-controlled: a nested child is named
      // `${parent}~${logicalId}`, and a parameter name is never validated here.
      const warn = vi.mocked(getLogger().warn);
      warn.mockClear();
      const param = 'Secret\u001b[31m';
      // A list type still reaches the warning with an escape in it, so the
      // declared type's strip is pinned too.
      await computeStackDiff(
        stateWith({}),
        { ...template(), Parameters: { [param]: { Type: 'List<X\u001b[31m>' } } },
        'us-east-1',
        'S\u001b[31m',
        fakeBackend({}),
        new DiffCalculator(),
        { parameters: { [param]: '{{resolve:secretsmanager:s:SecretString:k}}' } }
      );
      const messages = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('is fed a secret dynamic reference'));
      expect(messages).toHaveLength(1);
      // Each name renders through `displayIdent`: the escape byte is blanked, which
      // makes the value non-plain, so it gets a boundary of its own.
      expect(messages[0]).toContain(
        'Stack "S [31m": parameter "Secret [31m" is declared Type: "List<X [31m>"'
      );
      expect(messages[0]).not.toContain('\u001b');
    });

    it('renders ordinary names bare in the parameter-type warning, and a List<...> type as one JSON string', async () => {
      // `<` and `>` are outside the plain-identifier set, so every `List<...>`
      // type gets a boundary of its own while `CommaDelimitedList` stays bare.
      const warn = vi.mocked(getLogger().warn);
      const fed = (type: string) => async (): Promise<string[]> => {
        warn.mockClear();
        await computeStackDiff(
          stateWith({}),
          { ...template(), Parameters: { Secret: { Type: type } } },
          'us-east-1',
          'S',
          fakeBackend({}),
          new DiffCalculator(),
          { parameters: { Secret: '{{resolve:secretsmanager:s:SecretString:k}}' } }
        );
        return warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes('is fed a secret dynamic reference'));
      };
      expect(await fed('List<Number>')()).toEqual([
        expect.stringContaining('Stack S: parameter Secret is declared Type: "List<Number>"'),
      ]);
      expect(await fed('CommaDelimitedList')()).toEqual([
        expect.stringContaining('Stack S: parameter Secret is declared Type: CommaDelimitedList '),
      ]);
    });

    it('previews the merge for the env-agnostic CDK shape, whose only condition gates CDKMetadata', async () => {
      // What an env-agnostic CDK app synthesizes under cdkd, which turns version
      // reporting on: `CDKMetadataAvailable`, referenced by the
      // `AWS::CDK::Metadata` resource and by nothing an output can reach.
      const suppressed = captureSuppressionWarnings();
      const base = template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } });
      const tpl: CloudFormationTemplate = {
        ...base,
        Resources: {
          ...base.Resources,
          CDKMetadata: {
            Type: 'AWS::CDK::Metadata',
            Properties: { Analytics: 'v2:deflate64:H4sIAAAAAAAA' },
            Condition: 'CDKMetadataAvailable',
          },
        },
        Conditions: {
          CDKMetadataAvailable: {
            'Fn::Or': [
              { 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'us-east-1'] },
              { 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'eu-west-1'] },
            ],
          },
        },
      };
      const { changes, outputChanges } = await diffFor(stateWith({ Out: 'stored' }), tpl);
      expect([...changes.values()].every((c) => c.changeType === 'NO_CHANGE')).toBe(true);
      expect(outputChanges).toEqual([
        { name: 'Plain2', changeType: 'ADD', newValue: 'p2', isExport: false },
      ]);
      expect(suppressed()).toEqual([]);
      expect(carriedOutputWarnings()).toHaveLength(1);
    });

    it('strips control characters from the stack name in both Outputs warnings', async () => {
      const warn = vi.mocked(getLogger().warn);
      warn.mockClear();
      const name = 'S\u001b[31m';
      // Merged: the carried-output warning.
      await computeStackDiff(
        stateWith({ Out: 'stored' }),
        template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } }),
        'us-east-1',
        name,
        fakeBackend({}),
        new DiffCalculator()
      );
      // A pending CREATE: the suppression warning.
      const withCreate = template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } });
      withCreate.Resources['New'] = { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } };
      await computeStackDiff(
        stateWith({ Out: 'stored' }),
        withCreate,
        'us-east-1',
        name,
        fakeBackend({}),
        new DiffCalculator()
      );
      const messages = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.startsWith('Outputs of stack '));
      expect(messages.filter((m) => m.startsWith('Outputs of stack S[31m: 1 output(s)'))).toHaveLength(1);
      expect(
        messages.filter((m) => m.startsWith('Outputs of stack S[31m may have changed'))
      ).toHaveLength(1);
      expect(messages.filter((m) => m.includes('\u001b'))).toEqual([]);
    });

    it.each([
      {
        route: "the output's own Condition",
        edit: (tpl: CloudFormationTemplate): void => {
          (tpl.Outputs ??= {})['Out'] = { Value: FAILING, Condition: 'IsOn' };
        },
      },
      {
        route: 'an Fn::If in a mapping',
        edit: (tpl: CloudFormationTemplate): void => {
          tpl.Mappings = { M: { k: { V: { 'Fn::If': ['IsOn', 'a', 'b'] } } } };
        },
      },
    ])(
      'keeps the suppression when a condition verdict can reach an output through $route',
      async ({ edit }) => {
        const suppressed = captureSuppressionWarnings();
        const tpl: CloudFormationTemplate = {
          ...template({ Out: { Value: FAILING }, Plain2: { Value: 'p2' } }),
          Conditions: { IsOn: { 'Fn::Equals': ['a', 'a'] } },
        };
        edit(tpl);
        const { changes, outputChanges } = await diffFor(stateWith({ Out: 'stored' }), tpl);
        expect([...changes.values()].every((c) => c.changeType === 'NO_CHANGE')).toBe(true);
        expect(outputChanges).toEqual([]);
        const messages = suppressed();
        expect(messages).toHaveLength(1);
        // With no resource change pending, a resource this deploy creates is not
        // the cause, so the warning must not name one.
        expect(messages[0]).not.toContain('yet to create');
        expect(messages[0]).toContain('The stack has no resource change;');
        expect(messages[0]).not.toContain('Export.Name');
      }
    );

    it('names a failed output keyed by a secret the diff never fetches', async () => {
      // The mapping key stays an unresolved token here, so the lookup throws;
      // the deploy decrypts it and resolves the output. The carried stored
      // value is therefore not a claim that the output is unchanged.
      const suppressed = captureSuppressionWarnings();
      const tpl: CloudFormationTemplate = {
        ...template({
          Out: {
            Value: {
              'Fn::FindInMap': ['M', '{{resolve:secretsmanager:s:SecretString:k}}', 'V'],
            },
          },
        }),
        Mappings: { M: { prod: { V: 'new' } } },
      };
      const { outputChanges } = await diffFor(stateWith({ Out: 'old' }), tpl);
      expect(outputChanges).toEqual([]);
      expect(suppressed()).toEqual([]);
      const carried = carriedOutputWarnings();
      expect(carried).toHaveLength(1);
      expect(carried[0]).toContain(
        '1 output(s) could not be resolved for this diff. Compared at their stored values: Out.'
      );
    });
  });

  it('keeps the pretty-printer newlines in a multi-line value', () => {
    // The regression this pins: the full control-char class includes \n, and
    // stripping ran AFTER the indent replace, so every multi-line value
    // collapsed onto one line. JSON.stringify already escapes < 0x20 INSIDE
    // strings, so C0 on this path is only the structural newlines.
    const lines: string[] = [];
    renderOutputChangeLines(
      [{ name: 'Out', changeType: 'ADD', newValue: ['a', 'b'], isExport: false }],
      (m) => lines.push(m)
    );
    const valueLine = lines.find((l) => l.includes('new:'))!;
    expect(valueLine.split('\n').length).toBeGreaterThan(1);
    expect(valueLine).toContain('"a"');
    expect(valueLine).toContain('"b"');
  });

  it('strips control characters from rendered VALUES too, not just names', () => {
    // JSON.stringify escapes everything below 0x20 but passes C1 and the bidi
    // marks through unchanged.
    const lines: string[] = [];
    renderOutputChangeLines(
      [{ name: 'Out', changeType: 'ADD', newValue: 'a\u009bBb\u202Ec', isExport: false }],
      (m) => lines.push(m)
    );
    const out = lines.join('\n');
    expect(out).not.toContain('\u009b');
    expect(out).not.toContain('\u202e');
  });

  it('renders nothing for an empty Outputs delta', () => {
    const lines: string[] = [];
    const counts = renderOutputChangeLines([], (m) => lines.push(m));
    expect(lines).toEqual([]);
    expect(counts).toEqual({ add: 0, change: 0, remove: 0 });
  });

  it('carries the Outputs delta into --json, omitting the absent side per kind', async () => {
    const backend = fakeBackend({ S: stateWith({ Old: 'x' }) });
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: template({ Arn: { Value: ARN, Export: { Name: 'S:Arn' } } }),
      nestedTemplates: {},
      recursive: false,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    const json = diffTreeToJson(node);
    expect(json.outputChanges).toEqual([
      { name: 'Arn', changeType: 'ADD', newValue: ARN, export: false },
      { name: 'S:Arn', changeType: 'ADD', newValue: ARN, export: true },
      { name: 'Old', changeType: 'REMOVE', oldValue: 'x', export: false },
    ]);
    // An ADD carries no `oldValue` key at all (not `oldValue: null`).
    expect(Object.keys(json.outputChanges[0]!)).not.toContain('oldValue');
    expect(Object.keys(json.outputChanges[2]!)).not.toContain('newValue');
  });

  it('--json keeps the outputChanges key present when there is no delta', async () => {
    const backend = fakeBackend({ S: stateWith({}) });
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: template(),
      nestedTemplates: {},
      recursive: false,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(diffTreeToJson(node).outputChanges).toEqual([]);
  });
});

describe('rollback-orphan adoption preview (go-to-k/cdkd#2943)', () => {
  const ROLE = 'AWS::IAM::Role';
  const orphanRecord = (logicalId = 'KeptRole', physicalId = 'S-KeptRole') => ({
    logicalId,
    orphanedAt: 1,
    state: { ...res(ROLE, { Path: '/svc/' }), physicalId },
  });
  const declaring: CloudFormationTemplate = {
    Resources: { KeptRole: { Type: ROLE, Properties: { Path: '/svc/' } } },
  };
  const stateWithRecord = (): StackState =>
    ({ ...st('S', {}), orphans: [orphanRecord()] }) as StackState;

  it('an ADOPTED record turns a CREATE into an UPDATE — the whole point of the preview', async () => {
    const { changes, adoptedOrphans, blocking } = await computeStackDiff(
      stateWithRecord(),
      declaring,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      {
        previewOrphanAdoption: async () => ({
          adopted: { KeptRole: { ...res(ROLE, { Path: '/app/' }), physicalId: 'S-KeptRole' } },
          refusals: [],
        }),
      }
    );

    // Without the splice the resource is ABSENT from state, and `DiffCalculator`
    // decides CREATE by absence — which is the CREATE `cdkd deploy` will not
    // perform, i.e. the defect. Deleting the splice reds exactly this line.
    expect(changes.get('KeptRole')!.changeType).toBe('UPDATE');
    expect(adoptedOrphans).toEqual(['KeptRole']);
    expect(blocking).toEqual([]);
  });

  it('does NOT mutate the caller-supplied state — the deploy may, this may not', async () => {
    const state = stateWithRecord();
    await computeStackDiff(state, declaring, 'us-east-1', 'S', fakeBackend({}), new DiffCalculator(), {
      previewOrphanAdoption: async () => ({
        adopted: { KeptRole: { ...res(ROLE, { Path: '/app/' }), physicalId: 'S-KeptRole' } },
        refusals: [],
      }),
    });

    // `buildDiffTree` hands this same record to `resolveChildStackParameters`
    // and `collectCcApiRoutes` after the diff, and this function's doc promises
    // it only reads. `DeployEngine` writes through its own copy because it goes
    // on to deploy from it; that is the asymmetry, and it is deliberate.
    expect(state.resources['KeptRole']).toBeUndefined();
    expect(state.orphans).toHaveLength(1);
  });

  it('a REFUSED record is carried as blocking and is NOT spliced', async () => {
    const { changes, adoptedOrphans, blocking } = await computeStackDiff(
      stateWithRecord(),
      declaring,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      {
        previewOrphanAdoption: async () => ({
          adopted: {},
          refusals: ['KeptRole: S-KeptRole is already recorded by another cdkd stack.'],
        }),
      }
    );

    // Reported, AND still a create: the deploy refuses, so nothing is adopted,
    // and showing the row as an update would be the opposite lie to the one
    // this feature fixes.
    expect(blocking).toHaveLength(1);
    expect(adoptedOrphans).toEqual([]);
    expect(changes.get('KeptRole')!.changeType).toBe('CREATE');
  });

  it('returns the adopted RECORDS, not only their names', async () => {
    const adopted = {
      KeptRole: { ...res(ROLE, { Path: '/app/' }), physicalId: 'S-KeptRole', provisionedBy: 'cc-api' as const },
    };
    const { adoptedRecords } = await computeStackDiff(
      stateWithRecord(),
      declaring,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      { previewOrphanAdoption: async () => ({ adopted, refusals: [] }) }
    );

    // `buildDiffTree` merges these into the state it hands `collectCcApiRoutes`
    // and `resolveChildStackParameters`. Names alone cannot serve either: the
    // first reads `provisionedBy` off the record — an adopted `cc-api` row
    // would print with no routing annotation while the deploy routes it via
    // Cloud Control — and the second resolves a child's `Parameters` against
    // the parent's records.
    expect(adoptedRecords['KeptRole']?.provisionedBy).toBe('cc-api');
  });

  it('is not consulted at all when the state holds no records', async () => {
    const preview = vi.fn();
    const { adoptedOrphans, blocking } = await computeStackDiff(
      st('S', {}),
      declaring,
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      { previewOrphanAdoption: preview as never }
    );

    // The cost argument for putting a PROVIDER call on the diff path rests on
    // this: a stack that never had a rollback orphan something pays nothing.
    expect(preview).not.toHaveBeenCalled();
    expect(adoptedOrphans).toEqual([]);
    expect(blocking).toEqual([]);
  });

  it('renders Blocking after the rows, and counts refusals across the tree', () => {
    const node: DiffTreeNode = {
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      changes: changeMap([{ logicalId: 'New', changeType: 'CREATE', resourceType: 'T' }]),
      ccApiRoutes: new Map(),
      outputChanges: [],
      adoptedOrphans: [],
      unreadable: [],
      blocking: ['KeptRole: S-KeptRole is already recorded by another cdkd stack.'],
      children: [
        {
          stackName: 'S~C',
          displayName: 'S~C',
          region: 'us-east-1',
          changes: changeMap([]),
          ccApiRoutes: new Map(),
          outputChanges: [],
          adoptedOrphans: [],
          unreadable: [],
          blocking: ['ChildRole: S~C-ChildRole is already recorded by another cdkd stack.'],
          children: [],
        },
      ],
    };
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const out = lines.join('\n');

    expect(out).toContain('Blocking (cdkd deploy will refuse):');
    expect(out).toContain('! KeptRole: S-KeptRole is already recorded');
    // AFTER the summary, not before it: the user came for the preview.
    expect(out.indexOf('to create,')).toBeLessThan(out.indexOf('Blocking'));
    // The CHILD has no changes, so `nodeHasChanges` is false for it. Its
    // refusal must still print — a refusal nobody prints is the one outcome
    // the section exists to prevent.
    expect(out).toContain('Nested stack: S~C');
    expect(out).toContain('! ChildRole:');
    expect(countBlocking(node)).toBe(2);
  });

  it('a changeless tree that BLOCKS is still worth rendering', () => {
    const node: DiffTreeNode = {
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      changes: changeMap([]),
      ccApiRoutes: new Map(),
      outputChanges: [],
      adoptedOrphans: [],
      unreadable: [],
      blocking: ['KeptRole: conflict'],
      children: [],
    };

    // The renderer prints a Blocking section for a changeless node, and the
    // caller has to agree. Gating the CALL on changes alone put the
    // coincidence back one level up: "No changes detected" followed by a
    // non-zero exit citing reasons "reported above" that never printed.
    expect(treeIsWorthRendering(node)).toBe(true);
    expect(treeHasChanges(node)).toBe(false);
    expect(treeIsWorthRendering({ ...node, blocking: [] })).toBe(false);
  });

  it('an adoption whose row is NO_CHANGE is still reported', () => {
    const node: DiffTreeNode = {
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      // NO_CHANGE, which `renderChangeLines` has no case for — the adopted
      // record's properties already match the template. This is the shape the
      // real-AWS fixture hit: every count zero, the row unrendered, and the
      // preview silent about the one thing the user ran it to learn.
      changes: changeMap([
        { logicalId: 'KeptRole', changeType: 'NO_CHANGE', resourceType: 'AWS::IAM::Role' },
      ]),
      ccApiRoutes: new Map(),
      outputChanges: [],
      adoptedOrphans: ['KeptRole'],
      unreadable: [],
      blocking: [],
      children: [],
    };
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const out = lines.join('\n');

    // The deploy DOES work here — it splices the record into `resources` and
    // persists the state without the orphan — so "No changes detected" is
    // wrong, and the per-row annotation cannot carry it.
    expect(nodeHasChanges(node)).toBe(true);
    expect(treeIsWorthRendering(node)).toBe(true);
    expect(out).toContain('1 resource(s) to adopt from a previous rollback: KeptRole');
    // Without an adoption the same node must stay quiet, or the arm would
    // report every unchanged stack.
    expect(nodeHasChanges({ ...node, adoptedOrphans: [] })).toBe(false);
  });

  it('--json carries both keys, so a CI consumer can gate on the refusal', () => {
    const node: DiffTreeNode = {
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      changes: changeMap([]),
      ccApiRoutes: new Map(),
      outputChanges: [],
      adoptedOrphans: ['KeptRole'],
      unreadable: [],
      blocking: ['KeptRole: conflict'],
      children: [],
    };
    const json = diffTreeToJson(node);

    // `changes` alone cannot carry this: an adopted record produces an
    // ordinary UPDATE row and a refused one an ordinary CREATE row, so a
    // consumer reading only `changes` sees a runnable plan either way.
    expect(json.adoptedOrphans).toEqual(['KeptRole']);
    expect(json.blocking).toEqual(['KeptRole: conflict']);
  });

  it('annotates the adopted row, and keeps the CC-API annotation beside it', () => {
    const lines: string[] = [];
    renderChangeLines(
      changeMap([{ logicalId: 'KeptRole', changeType: 'UPDATE', resourceType: ROLE }]),
      (m: string) => lines.push(m),
      new Map([['KeptRole', ['SomeProp']]]),
      ['KeptRole']
    );

    // Both annotations, adoption first — it says why the row exists at all,
    // where the routing says how it will be carried out. An unannotated `[~]`
    // reads as cdkd having quietly kept managing a resource the user last saw
    // FAIL and drop out of state.
    expect(lines[0]).toContain('[adopted from a rollback orphan]');
    expect(lines[0]).toContain('[via CC API: SomeProp]');
    expect(lines[0]!.indexOf('adopted')).toBeLessThan(lines[0]!.indexOf('via CC API'));
  });
});

/**
 * Issue [#3018](https://github.com/go-to-k/cdkd/issues/3018): `loadStateOrEmpty`
 * repaired the resources BAG since go-to-k/cdkd#3159, and that left the ENTRY
 * half of the same class open in this file.
 *
 * `hasReadableResources` tests the bag, so `{"resources": {"R": null}}` survives
 * the repair and the two nested-child walks below it dereference
 * `resource.resourceType` — a raw `TypeError` from `cdkd diff`, the command
 * go-to-k/cdkd#3159's entry explicitly says it fixed. The gap was invisible to
 * the eligibility-minus-remedy sweep that named the rest of the class: this file
 * IMPORTS the remedy module, so it subtracted out whether or not it had taken
 * the half that applies to it.
 *
 * REPAIR rather than refuse because `cdkd diff` never writes — asserted, not
 * assumed, by the refuse-vs-repair fence in
 * `tests/unit/state/malformed-resources-bag.test.ts`.
 */
describe('buildDiffTree over a record with an unreadable entry (issue #3018)', () => {
  /** Identity: this suite is about the record's SHAPE, not about narrowing. */
  const canonicalizeIdentity = (_resourceType: string, properties: Record<string, unknown>) =>
    properties;

  /**
   * The WARNING is half the behaviour, and the half a CREATE-preview assertion
   * cannot see: dropping a row silently is exactly the "clean verdict about
   * nothing" the repair helper's own doc forbids. Read off the mocked logger,
   * which every case in this file shares, so it is cleared per case.
   */
  const warnSpy = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    warnSpy.mockClear();
  });

  function warnings(): string {
    return warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  // Every unreadable ENTRY shape, at THIS call site: a guard narrowed here —
  // `if (typeof entry !== 'boolean')`, say — is invisible to the helper's own
  // tests, and the non-throwing shapes are the ones whose bypass produces a
  // diff row for a resource that does not exist.
  for (const [shape, badEntry] of [
    ['null', null],
    ['a string', 'ab'],
    ['a number', 5],
    ['zero', 0],
    ['negative zero', -0],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a list', []],
    // Why THESE: each is a shape `JSON.parse` really produces and whose
    // bypass would be INVISIBLE in output. The empty string and the two
    // zeroes are falsy, so a truthiness check lets them through, and `-0`
    // additionally survives a `=== 0` exemption written as `Object.is`.
    // The infinities come from `JSON.parse('1e400')`, which is a number a
    // hand-edited record can hold. The two list sizes separate a
    // SHAPE-based guard from a LENGTH-based one — both are dereferenced
    // the same way, so only a length-dependent bypass tells them apart.
    // `NaN` is absent because `JSON.parse` cannot produce it.
    ['an empty string', ''],
    ['a populated list', [{ physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {} }]],
    // An OBJECT with no resource type. It passes an object-ness test and then
    // throws on `resource.resourceType.startsWith(...)`, which is why the entry
    // predicate asks for the type rather than only for object-ness.
    ['an object with no resourceType', { physicalId: 'p', properties: {} }],
    ['true', true],
    ['false', false],
  ] as const) {
    it(`drops an entry that is ${shape} and still diffs the rest of the stack`, async () => {
      const broken = st('S', { R: res('AWS::SSM::Parameter', { Value: 'v' }) });
      // Planted AFTER construction: `st()` is typed, and the whole point is a
      // record whose stored shape violates that type.
      (broken.resources as Record<string, unknown>)['BrokenRow'] = badEntry;

      const node = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: {
          Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } } },
        },
        nestedTemplates: {},
        recursive: true,
        stateBackend: fakeBackend({ S: broken }),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
        canonicalizeProperties: canonicalizeIdentity,
      });

      expect(node.changes.get('R')!.changeType).toBe('NO_CHANGE');
      expect(node.changes.has('BrokenRow')).toBe(false);
      const warned = warnings();
      expect(warned).toContain('BrokenRow');
      expect(warned).toContain('State for S (us-east-1)');
    });
  }

  it('drops the entry and still diffs the rest of the stack', async () => {
    const broken = st('S', { R: res('AWS::SSM::Parameter', { Value: 'v' }) });
    // Planted AFTER construction: `st()` is typed, and the whole point is a
    // record whose stored shape violates that type.
    (broken.resources as Record<string, unknown>)['BrokenRow'] = null;

    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } } },
      },
      nestedTemplates: {},
      recursive: true,
      stateBackend: fakeBackend({ S: broken }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    // The healthy row is still compared — the discriminator against a fix that
    // aborted, and against one that emptied the whole bag.
    expect(node.changes.get('R')!.changeType).toBe('NO_CHANGE');
    // The dropped row is not previewed as anything at all: it names no resource
    // type, so a DELETE row for it would be an invention.
    expect(node.changes.has('BrokenRow')).toBe(false);
    // ...and the drop is ANNOUNCED. Without this the guard could stop warning
    // and every assertion above would still pass, which is the shape the repair
    // helper's doc calls a clean verdict about nothing.
    const warned = warnings();
    expect(warned).toContain('BrokenRow');
    expect(warned).toContain('Continuing WITHOUT them');
    expect(warned).toContain('State for S (us-east-1)');

    // The template-ABSENT half (go-to-k/cdkd#3018 review, M7). `BrokenRow` is a
    // row the template does not declare, so a readable record there would be a
    // DELETE; dropped, it reaches no change row at all. Every other change here
    // is NO_CHANGE, so without the unreadable rows `--fail` (which reads
    // `treeHasChanges`) exits 0 over a record that used to crash non-zero.
    expect(node.unreadable).toEqual(['BrokenRow']);
    expect(nodeHasChanges(node)).toBe(true);
    expect(treeHasChanges(node)).toBe(true);
    // ...and it is in the machine-readable payload, not only the exit code.
    expect(diffTreeToJson(node).unreadable).toEqual(['BrokenRow']);
    // ...and in the human preview, beside counts that do NOT include it.
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    expect(lines.join('\n')).toContain('1 state record row(s) could not be read: BrokenRow.');
  });

  it('reports a dropped row in a NON-recursive diff too — plain `cdkd diff --fail`', async () => {
    // The polarity every other case here skips: `recursive: false`, which is
    // what plain `cdkd diff` runs. `buildDiffTree` returns early for it, so a
    // refactor that moved the `unreadable` assignment below that return would
    // put plain `cdkd diff --fail` back at exit 0 over a malformed record — the
    // blocker this rule was added for, in the one mode no case watched.
    const broken = st('S', { R: res('AWS::SSM::Parameter', { Value: 'v' }) });
    (broken.resources as Record<string, unknown>)['BrokenRow'] = null;

    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } } },
      },
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({ S: broken }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    expect(node.unreadable).toEqual(['BrokenRow']);
    expect(treeHasChanges(node)).toBe(true);
    expect(diffTreeToJson(node).unreadable).toEqual(['BrokenRow']);
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    expect(lines.join('\n')).toContain('1 state record row(s) could not be read: BrokenRow.');
  });

  it('reports an unreadable resources MAP as one row, and --fail sees it', async () => {
    // The bag half of the same rule. A string bag is repaired to empty, and
    // against a template declaring nothing that leaves no change row at all —
    // the deleted-subtree shape, where nothing else could make `--fail` fire.
    const broken = st('S', {});
    (broken as unknown as { resources: unknown }).resources = 'abcdef';

    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: { Resources: {} },
      nestedTemplates: {},
      recursive: true,
      stateBackend: fakeBackend({ S: broken }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    // The spelling itself, independently of the shared constant.
    expect(node.unreadable).toEqual(['(resources map)']);
    expect(treeHasChanges(node)).toBe(true);
    expect(diffTreeToJson(node).unreadable).toEqual(['(resources map)']);
    // The map row is not a logical id, so it gets no sentence about ids the
    // template declares.
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const preview = lines.join('\n');
    expect(preview).toContain('1 state record row(s) could not be read: (resources map).');
    expect(preview).not.toContain('shown above as a create');
  });

  it('CAPS the preview at ten names while --json keeps every id', async () => {
    const broken = st('S', {});
    const ids = Array.from({ length: 12 }, (_, i) => `Row${i}`);
    for (const id of ids) (broken.resources as Record<string, unknown>)[id] = null;

    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: { Resources: {} },
      nestedTemplates: {},
      recursive: true,
      stateBackend: fakeBackend({ S: broken }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    expect(diffTreeToJson(node).unreadable).toEqual(ids);
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const preview = lines.join('\n');
    expect(preview).toContain(`12 state record row(s) could not be read: ${ids.slice(0, 10).join(', ')} and 2 more.`);
    expect(preview).not.toContain('Row10');
    // Ids ARE present, so the sentence about declared ids is kept.
    expect(preview).toContain('shown above as a create');
  });

  it('says no "and 0 more" at EXACTLY the ten-name cap', async () => {
    // The boundary the 12-row case above cannot reach: with exactly ten rows
    // `rest` is 0, and widening `rest > 0` to `rest >= 0` appends a literal
    // `and 0 more` that no case reddened.
    const broken = st('S', {});
    const ids = Array.from({ length: 10 }, (_, i) => `Row${i}`);
    for (const id of ids) (broken.resources as Record<string, unknown>)[id] = null;

    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: { Resources: {} },
      nestedTemplates: {},
      recursive: true,
      stateBackend: fakeBackend({ S: broken }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const preview = lines.join('\n');
    expect(preview).toContain(`10 state record row(s) could not be read: ${ids.join(', ')}.`);
    expect(preview).not.toContain('more');
  });

  it('carries EVERY dropped id into `unreadable`, sanitized in the preview', async () => {
    // Several ids, not one: a `dropped.slice(0, 1)` at the push would keep the
    // exit code right while the payload and the preview named one row of many.
    // One id carries U+2028, a line separator `stripControlChars` leaves in
    // place, so the preview must go through the identifier sanitizer.
    const broken = st('S', { R: res('AWS::SSM::Parameter', { Value: 'v' }) });
    const forged = `Evil${String.fromCharCode(0x2028)}Row`;
    for (const id of ['A1', 'B2', forged]) {
      (broken.resources as Record<string, unknown>)[id] = null;
    }

    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } } },
      },
      nestedTemplates: {},
      recursive: true,
      stateBackend: fakeBackend({ S: broken }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    expect(node.unreadable).toEqual(['A1', 'B2', forged]);
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const preview = lines.join('\n');
    // The forged id is QUOTED because sanitizing altered it — the rule that
    // keeps an id padded or rewritten to match a healthy sibling from
    // rendering bare beside it.
    expect(preview).toContain('3 state record row(s) could not be read: A1, B2, "Evil Row".');
    expect(preview).not.toContain(String.fromCharCode(0x2028));
  });

  it('never names a PADDED dropped id bare, and cuts a long one with a visible marker', async () => {
    // `Bucket ` is the discriminator the `"Evil Row"` case above cannot be: that
    // id holds an inner space, which quotes it on its own, while this one is
    // plain once trimmed — so only the raw-versus-sanitized comparison keeps it
    // from rendering as the healthy `Bucket` beside it. `Queue` is the control
    // that must stay bare.
    const broken = st('S', { Bucket: res('AWS::SSM::Parameter', { Value: 'v' }) });
    for (const id of ['Bucket ', 'Queue', 'L'.repeat(5000)]) {
      (broken.resources as Record<string, unknown>)[id] = null;
    }
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: { Bucket: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } } },
      },
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({ S: broken }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const preview = lines.join('\n');
    expect(preview).toContain(
      `could not be read: "Bucket", Queue, ${'L'.repeat(255)} [cut: 4745 more characters withheld].`
    );
    expect(preview).not.toContain('L'.repeat(256));
  });

  it('reports the unreadable rows of a DELETED nested child too', async () => {
    // `buildDeletedSubtree` loads the child through the same repair but builds
    // its own node, so the propagation is a separate site from `buildDiffTree`'s.
    // A deleted child diffs against an EMPTY template, so a dropped row there is
    // exactly the template-absent case that would otherwise vanish.
    const child = st('P~Gone', { Kept: res('AWS::SSM::Parameter', { Value: 'v' }) });
    (child.resources as Record<string, unknown>)['BrokenRow'] = null;
    const node = await buildDiffTree({
      stackName: 'P',
      displayName: 'P',
      region: 'us-east-1',
      template: { Resources: {} },
      nestedTemplates: {},
      recursive: true,
      stateBackend: fakeBackend({ P: st('P', { Gone: res(NESTED, {}) }), 'P~Gone': child }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    expect(node.children[0]!.unreadable).toEqual(['BrokenRow']);
    expect(diffTreeToJson(node).children[0]!.unreadable).toEqual(['BrokenRow']);
  });

  it('names EVERY dropped entry, not the first', async () => {
    // The WIRING at this call site, separate from drift's: a
    // `dropped.slice(0, 1)` here still drops all six and names one.
    const broken = st('S', { R: res('AWS::SSM::Parameter', { Value: 'v' }) });
    for (const id of ['A1', 'B2', 'C3', 'D4', 'E5', 'F6']) {
      (broken.resources as Record<string, unknown>)[id] = null;
    }

    await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } } },
      },
      nestedTemplates: {},
      recursive: true,
      stateBackend: fakeBackend({ S: broken }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    const warned = warnings();
    expect(warned).toContain('6 resource record(s)');
    for (const id of ['A1', 'B2', 'C3', 'D4', 'E5']) expect(warned).toContain(id);
    expect(warned).toContain('and 1 more');
    expect(warned).not.toContain('F6');
  });

  it('says NOTHING about a healthy record', async () => {
    // The negative direction, missing until a review round asked for it: with
    // the guards forced to `if (true)` every malformed case above stays green
    // while a healthy record is labelled malformed on every `cdkd diff`. A
    // warning about a record that is fine is not a small regression — it is the
    // one this whole change exists to make meaningful.
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } } },
      },
      nestedTemplates: {},
      recursive: true,
      stateBackend: fakeBackend({ S: st('S', { R: res('AWS::SSM::Parameter', { Value: 'v' }) }) }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    expect(node.changes.get('R')!.changeType).toBe('NO_CHANGE');
    expect(warnings()).not.toContain('Continuing');
    expect(warnings()).not.toContain('malformed or truncated');
    // No unreadable rows, so `--fail` stays quiet on an unchanged healthy stack
    // — the direction a blanket `unreadable.length >= 0` would break.
    expect(node.unreadable).toEqual([]);
    expect(treeHasChanges(node)).toBe(false);
    // Always present in `--json`, empty when there is nothing, so the key set
    // a CI gate reads is stable.
    expect(diffTreeToJson(node).unreadable).toEqual([]);
  });

  it('a dropped entry the TEMPLATE still declares previews as a CREATE', async () => {
    // The consequence of DROPPING rather than hiding, pinned rather than left
    // to the warning's wording. With no record of the row, the diff has nothing
    // to compare the template against, so it previews the resource as new —
    // exactly what an emptied BAG does to a whole stack, one row down. A reader
    // who takes the preview at face value would re-create a live resource, which
    // is why the warning has to be loud and why this is asserted here rather
    // than described in a comment.
    const broken = st('S', {});
    (broken.resources as Record<string, unknown>)['R'] = null;

    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } } },
      },
      nestedTemplates: {},
      recursive: true,
      stateBackend: fakeBackend({ S: broken }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      canonicalizeProperties: canonicalizeIdentity,
    });

    expect(node.changes.get('R')!.changeType).toBe('CREATE');
    // The warning is what stands between that CREATE and a reader acting on it.
    expect(warnings()).toContain('R');
    expect(warnings()).toContain('Continuing WITHOUT them');
    // Listed as unreadable too, although it has a row: the CREATE is the
    // preview of a record cdkd could not read, not of a new resource, and
    // `unreadable` is what says so in `--json`.
    expect(node.unreadable).toEqual(['R']);
  });

  it('drops an unreadable entry in a NESTED child too', async () => {
    // The recursion is its own site: the repair sits at the shared load, but a
    // fix applied only at the root would leave a healthy parent naming a
    // malformed child walking that child's entries unguarded — the exact shape
    // go-to-k/cdkd#3185 had to move a guard for on the export walker.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3018-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'v' } } },
        })
      );
      const child = st('S~Child', { R: res('AWS::SSM::Parameter', { Value: 'v' }) });
      (child.resources as Record<string, unknown>)['BrokenRow'] = null;

      const node = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: {
          Resources: {
            Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
          },
        },
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: fakeBackend({ S: st('S', { Child: res(NESTED, {}) }), 'S~Child': child }),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
        canonicalizeProperties: canonicalizeIdentity,
      });

      expect(node.children).toHaveLength(1);
      expect(node.children[0]!.changes.get('R')!.changeType).toBe('NO_CHANGE');
      expect(node.children[0]!.changes.has('BrokenRow')).toBe(false);
      // Named with the CHILD's stack name, not the parent's — a warning naming
      // the parent would send the reader to a healthy record.
      const warned = warnings();
      expect(warned).toContain('BrokenRow');
      expect(warned).toContain('S~Child');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue go-to-k/cdkd#3453, through `buildDiffTree` with the real
 * `DiffCalculator`: the node's routing annotation must see the diff's own
 * changes (a replaced `cc-api` row is not `sticky`), and a Type change into or
 * out of `AWS::CloudFormation::Stack` must be previewed as the refusal
 * `cdkd deploy` raises for it, at the root and at a nested node alike.
 */
describe('buildDiffTree replacement routing and the nested-stack Type-change refusal (go-to-k/cdkd#3453)', () => {
  const ccApi = (r: ResourceState): ResourceState => ({ ...r, provisionedBy: 'cc-api' });
  const tree = (
    template: CloudFormationTemplate,
    resources: Record<string, ResourceState>,
    isNestedChild = false
  ) =>
    buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({ S: st('S', resources) }),
      diffCalculator: new DiffCalculator(),
      isNestedChild,
    });

  it('does not annotate a Type-changed cc-api row as sticky', async () => {
    const node = await tree(
      { Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'v' } } } },
      { R: ccApi(res('AWS::SQS::Queue', { QueueName: 'q' })) }
    );
    expect(node.changes.get('R')?.changeType).toBe('UPDATE');
    expect(node.ccApiRoutes.has('R')).toBe(false);
    // Not a nested-stack pair, so nothing blocks.
    expect(node.blocking).toEqual([]);
  });

  it('does not annotate a cc-api row replaced by a create-only change as sticky', async () => {
    const node = await tree(
      { Resources: { R: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q2' } } } },
      { R: ccApi(res('AWS::SQS::Queue', { QueueName: 'q1' })) }
    );
    // PREMISE: the real calculator marks the rename as a replacement.
    expect(node.changes.get('R')?.propertyChanges?.[0]?.requiresReplacement).toBe(true);
    expect(node.ccApiRoutes.has('R')).toBe(false);
  });

  it('keeps `sticky` on an IN-PLACE update through the real calculator', async () => {
    const node = await tree(
      {
        Resources: {
          R: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q', VisibilityTimeout: 60 } },
        },
      },
      { R: ccApi(res('AWS::SQS::Queue', { QueueName: 'q', VisibilityTimeout: 30 })) }
    );
    expect(node.changes.get('R')?.changeType).toBe('UPDATE');
    expect(node.changes.get('R')?.propertyChanges?.[0]?.requiresReplacement).toBe(false);
    expect(node.ccApiRoutes.get('R')).toEqual(['sticky']);
  });

  it('keeps `sticky` on an unchanged cc-api row (the control)', async () => {
    const node = await tree(
      { Resources: { R: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } } },
      { R: ccApi(res('AWS::SQS::Queue', { QueueName: 'q' })) }
    );
    expect(node.ccApiRoutes.get('R')).toEqual(['sticky']);
  });

  it('blocks a Type change INTO a nested stack, naming the row and both types', async () => {
    const node = await tree(
      { Resources: { R: { Type: NESTED, Properties: {} } } },
      { R: res('AWS::SQS::Queue', { QueueName: 'q' }) }
    );
    expect(node.blocking).toHaveLength(1);
    expect(node.blocking[0]).toContain(
      `R: Type changes from AWS::SQS::Queue to ${NESTED}. cdkd does not replace`
    );
    expect(countBlocking(node)).toBe(1);
  });

  it('blocks a Type change OUT OF a nested stack', async () => {
    const node = await tree(
      { Resources: { R: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } } },
      { R: res(NESTED, {}) }
    );
    expect(node.blocking).toHaveLength(1);
    expect(node.blocking[0]).toContain(`R: Type changes from ${NESTED} to AWS::SQS::Queue.`);
  });

  it('blocks on a NESTED node too, where the child engine raises the same refusal', async () => {
    const node = await tree(
      { Resources: { R: { Type: NESTED, Properties: {} } } },
      { R: res('AWS::SQS::Queue', { QueueName: 'q' }) },
      true
    );
    expect(node.blocking).toHaveLength(1);
  });

  it('renders a hostile logical id inside its own boundary', async () => {
    const ID = 'R: Type changes from A to B. Nothing ';
    const node = await tree(
      { Resources: { [ID]: { Type: NESTED, Properties: {} } } },
      { [ID]: res('AWS::SQS::Queue', { QueueName: 'q' }) }
    );
    expect(node.blocking[0]!.startsWith(`${JSON.stringify(ID.trim())}: Type changes`)).toBe(true);
  });

  it('reads the state AFTER the rollback-orphan splice, as the deploy does', async () => {
    // The record exists only as an orphan the preview adopts, so a guard fed
    // the un-spliced state sees a CREATE and blocks nothing. The adoption's
    // own refusal must survive beside the new reason.
    const { blocking } = await computeStackDiff(
      {
        ...st('S', {}),
        orphans: [{ logicalId: 'R', orphanedAt: 1, state: res('AWS::SQS::Queue', {}) }],
      } as StackState,
      { Resources: { R: { Type: NESTED, Properties: {} } } },
      'us-east-1',
      'S',
      fakeBackend({}),
      new DiffCalculator(),
      {
        previewOrphanAdoption: async () => ({
          adopted: { R: res('AWS::SQS::Queue', {}) },
          refusals: ['Other: refused'],
        }),
      }
    );
    expect(blocking).toHaveLength(2);
    expect(blocking[0]).toBe('Other: refused');
    expect(blocking[1]).toContain(`R: Type changes from AWS::SQS::Queue to ${NESTED}.`);
  });

  it('renders a hostile RECORDED type inside its own boundary', async () => {
    const TYPE = 'AWS::SQS::Queue to X. Fine ';
    const node = await tree(
      { Resources: { R: { Type: NESTED, Properties: {} } } },
      { R: res(TYPE, {}) }
    );
    expect(node.blocking[0]).toContain(`from ${JSON.stringify(TYPE.trim())} to ${NESTED}.`);
  });

  it('renders a hostile TEMPLATE type inside its own boundary', async () => {
    const TYPE = 'AWS::SQS::Queue. Fine ';
    const node = await tree({ Resources: { R: { Type: TYPE, Properties: {} } } }, { R: res(NESTED, {}) });
    expect(node.blocking[0]).toContain(`to ${JSON.stringify(TYPE.trim())}. cdkd`);
  });
});
