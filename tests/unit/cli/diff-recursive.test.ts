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
    outputChanges: [],
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
      children: [
        {
          stackName: 'P~C',
          displayName: 'P~C',
          region: 'us-east-1',
          changes: changeMap([{ logicalId: 'New', changeType: 'CREATE', resourceType: 'T' }]),
          ccApiRoutes: new Map(),
          outputChanges: [],
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
      undefined,
      canonicalize
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
      undefined,
      undefined,
      false
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
        { Req: 'given' }
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
      assetRedirect,
    });

    expect(root.children).toHaveLength(1);
    expect(nodeHasChanges(root.children[0]!)).toBe(false);
    expect(treeHasChanges(root)).toBe(false);
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
      { [PARAM]: 'my-topic' }
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
    });

    const grandchild = node.children[0]!.children[0]!;
    expect(grandchild.stackName).toBe('P~Gone~Deeper');
    expect(grandchild.outputChanges[0]!.oldValueRedacted).toBe(true);
    expect(JSON.stringify(grandchild.outputChanges)).not.toContain('hunter2');
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
    });
    expect(diffTreeToJson(node).outputChanges).toEqual([]);
  });
});
