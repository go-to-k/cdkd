/**
 * go-to-k/cdkd#4049, the "coverage edges" row on `cdkd diff`: a property
 * served by a PIECE of a `NoEcho` parameter's value (`Fn::Split`), and a
 * nested child's `CommaDelimitedList` parameter split out of the parent's
 * `NoEcho` string, printed the piece on the row, in `--json` and in the
 * resolver's lines. End to end through `computeStackDiff` / `buildDiffTree`
 * with the real resolver.
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
  computeStackDiff,
  diffTreeToJson,
  renderChangeLines,
  renderOutputChangeLines,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { getLogger } from '../../../src/utils/logger.js';

const FIRST = 'alpha-first-piece';
const SECOND = 'bravo-second-piece';
const NOECHO = `${FIRST},${SECOND}`;

function loggedText(): string {
  const log = getLogger();
  return [log.debug, log.info, log.warn, log.error]
    .flatMap((fn) => vi.mocked(fn).mock.calls.flat())
    .map((arg) => String(arg))
    .join('\n');
}

function res(properties: Record<string, unknown>): ResourceState {
  return {
    physicalId: 'pid',
    resourceType: 'AWS::SSM::Parameter',
    properties,
    attributes: {},
    dependencies: [],
  };
}

function st(resources: Record<string, ResourceState>, stackName = 'S'): StackState {
  return { stackName, region: 'us-east-1', resources, outputs: {}, version: 6, lastModified: 0 };
}

function backendOf(states: Record<string, StackState> = {}): S3StateBackend {
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

function nodeOf(result: Awaited<ReturnType<typeof computeStackDiff>>): DiffTreeNode {
  return {
    stackName: 'S',
    displayName: 'S',
    region: 'us-east-1',
    changes: result.changes,
    ccApiRoutes: new Map(),
    outputChanges: result.outputChanges,
    adoptedOrphans: [],
    blocking: [],
    unreadable: [],
    unreadableContainers: [],
    unreadableOrphans: [],
    destructiveChanges: [],
    children: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cdkd diff masks a split piece of a NoEcho value (#4049)', () => {
  function template(noEcho: boolean): CloudFormationTemplate {
    return {
      Parameters: { DbUser: { Type: 'String', NoEcho: noEcho, Default: NOECHO } },
      Resources: {
        A: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Value: { 'Fn::Select': [1, { 'Fn::Split': [',', { Ref: 'DbUser' }] }] } },
        },
      },
    } as unknown as CloudFormationTemplate;
  }

  it('masks the piece on the row, in --json and in the resolver lines', async () => {
    const result = await computeStackDiff(
      st({ A: res({ Value: 'old-value' }) }),
      template(true),
      'us-east-1',
      'S',
      backendOf(),
      new DiffCalculator()
    );
    expect(result.changes.get('A')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', newValue: '***' }),
    ]);
    const out = printed(nodeOf(result));
    expect(out).not.toContain(SECOND);
    expect(loggedText()).toContain('Resolved Fn::Split');
    expect(loggedText()).not.toContain(FIRST);
    expect(loggedText()).not.toContain(SECOND);
  });

  it('masks the stored piece of a property that stopped reading it, from the up-front record alone', async () => {
    // Nothing splits into `A` any more, so only the up-front record of the
    // value's pieces knows the stored piece. `B` holds the split, behind a
    // condition that prunes it, so no split RESOLVES in this diff: the
    // up-front record is the only source.
    const result = await computeStackDiff(
      st({ A: res({ Value: SECOND }) }),
      {
        Parameters: { DbUser: { Type: 'String', NoEcho: true, Default: NOECHO } },
        Conditions: { Never: { 'Fn::Equals': ['a', 'b'] } },
        Resources: {
          A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'new-literal' } },
          B: {
            Type: 'AWS::SSM::Parameter',
            Condition: 'Never',
            Properties: { Value: { 'Fn::Select': [0, { 'Fn::Split': [',', { Ref: 'DbUser' }] }] } },
          },
        },
      } as unknown as CloudFormationTemplate,
      'us-east-1',
      'S',
      backendOf(),
      new DiffCalculator()
    );
    expect(result.changes.get('A')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: '***', newValue: 'new-literal' }),
    ]);
    expect(printed(nodeOf(result))).not.toContain(SECOND);
  });

  it("masks the stored piece on --verbose's replacement line, printed before the split resolves", async () => {
    // `A`'s create-only TopicName held a piece and now reads a literal; its
    // replacement line is printed while `A` is diffed, before `B`'s split has
    // recorded anything.
    await computeStackDiff(
      st({
        A: { ...res({ TopicName: SECOND }), resourceType: 'AWS::SNS::Topic' },
        B: res({ Value: FIRST }),
      }),
      {
        Parameters: { DbUser: { Type: 'String', NoEcho: true, Default: NOECHO } },
        Resources: {
          A: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'new-topic-name' } },
          B: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { 'Fn::Select': [0, { 'Fn::Split': [',', { Ref: 'DbUser' }] }] } },
          },
        },
      } as unknown as CloudFormationTemplate,
      'us-east-1',
      'S',
      backendOf(),
      new DiffCalculator()
    );
    expect(loggedText()).toContain('requires replacement');
    expect(loggedText()).not.toContain(SECOND);
  });

  it('masks a stored export alias NAME equal to an up-front piece on its REMOVE row', async () => {
    // An older binary published `bravopiece-name` as an alias; nothing splits
    // it in this diff (the split resource is pruned), so only the up-front
    // pieces know it, and they stay out of the corpus a child inherits.
    const value = 'alphapiece-bravopiece';
    const result = await computeStackDiff(
      {
        ...st({ A: res({ Value: 'x' }) }),
        outputs: { 'bravopiece': 'old-alias-value' },
      },
      {
        Parameters: { DbUser: { Type: 'String', NoEcho: true, Default: value } },
        Conditions: { Never: { 'Fn::Equals': ['a', 'b'] } },
        Resources: {
          A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
          P: {
            Type: 'AWS::SSM::Parameter',
            Condition: 'Never',
            Properties: { Value: { 'Fn::Select': [1, { 'Fn::Split': ['-', { Ref: 'DbUser' }] }] } },
          },
        },
      } as unknown as CloudFormationTemplate,
      'us-east-1',
      'S',
      backendOf(),
      new DiffCalculator()
    );
    const out = printed(nodeOf(result));
    expect(result.outputChanges.some((c) => c.changeType === 'REMOVE')).toBe(true);
    expect(out).not.toContain('bravopiece');
  });

  it('prints the piece when the parameter is not NoEcho (negative control)', async () => {
    const result = await computeStackDiff(
      st({ A: res({ Value: 'old-value' }) }),
      template(false),
      'us-east-1',
      'S',
      backendOf(),
      new DiffCalculator()
    );
    expect(result.changes.get('A')?.propertyChanges).toEqual([
      expect.objectContaining({ newValue: SECOND }),
    ]);
  });
});

describe("cdkd diff --recursive masks a child's list parameter split out of the parent NoEcho value (#4049)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-noecho-split-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function diffTree(noEcho: boolean) {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        // A CDK-synthesized child parameter never says NoEcho.
        Parameters: { In: { Type: 'CommaDelimitedList' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { 'Fn::Select': [0, { Ref: 'In' }] } },
          },
        },
      })
    );
    const backend = backendOf({
      Parent: st(
        {
          Child: {
            ...res({ Parameters: { In: 'old-a,old-b' } }),
            resourceType: 'AWS::CloudFormation::Stack',
          },
        },
        'Parent'
      ),
      'Parent~Child': st({ ChildRes: res({ Value: 'old-a' }) }, 'Parent~Child'),
    });
    return buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: noEcho, Default: NOECHO } },
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { In: { Ref: 'Pw' } } },
          },
        },
      } as CloudFormationTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      parameters: { Pw: NOECHO },
      isNestedChild: false,
    });
  }

  it("masks the element on the child's row, in --json and in the child resolver's lines", async () => {
    const root = await diffTree(true);
    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', newValue: '***' }),
    ]);
    expect(printed(child)).not.toContain(FIRST);
    expect(printed(root)).not.toContain(FIRST);
    expect(loggedText()).toContain('Resolved Ref to parameter: In');
    expect(loggedText()).not.toContain(FIRST);
    expect(loggedText()).not.toContain(SECOND);
  });

  it("masks a child's Fn::Split of the parent's value through a String parameter", async () => {
    const childPath = join(dir, 'child-split.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { In: { Type: 'String' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { 'Fn::Select': [1, { 'Fn::Split': [',', { Ref: 'In' }] }] } },
          },
        },
      })
    );
    const backend = backendOf({
      Parent: st(
        {
          Child: {
            ...res({ Parameters: { In: 'old-a,old-b' } }),
            resourceType: 'AWS::CloudFormation::Stack',
          },
        },
        'Parent'
      ),
      'Parent~Child': st({ ChildRes: res({ Value: 'old-b' }) }, 'Parent~Child'),
    });
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: NOECHO } },
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child-split.json' },
            Properties: { Parameters: { In: { Ref: 'Pw' } } },
          },
        },
      } as CloudFormationTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      parameters: { Pw: NOECHO },
      isNestedChild: false,
    });
    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', newValue: '***' }),
    ]);
    expect(printed(child)).not.toContain(SECOND);
    expect(loggedText()).toContain('Resolved Fn::Split');
    expect(loggedText()).not.toContain(FIRST);
    expect(loggedText()).not.toContain(SECOND);
  });

  it("previews a child's export alias holding a parent piece as published, as its deploy publishes it", async () => {
    // The parent's template splits its NoEcho value by `-` in a resource its
    // condition prunes, so only the UP-FRONT record holds the pieces (no split
    // runs). The child reads the WHOLE value; its deploy's inherited bag holds
    // only that, so the alias is published. The preview must not refuse it
    // through the parent's up-front pieces.
    const childPath = join(dir, 'child-export.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { In: { Type: 'String' } },
        Resources: {
          ChildRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'fixed' } },
        },
        Outputs: {
          Reader: { Value: { Ref: 'In' } },
          Alias: { Value: 'alias-value', Export: { Name: 'alphapiece-x' } },
        },
      })
    );
    const value = 'alphapiece-bravopiece';
    const backend = backendOf({
      Parent: st(
        {
          Child: {
            ...res({ Parameters: { In: value } }),
            resourceType: 'AWS::CloudFormation::Stack',
          },
        },
        'Parent'
      ),
      'Parent~Child': st({ ChildRes: res({ Value: 'fixed' }) }, 'Parent~Child'),
    });
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: value } },
        Conditions: { Never: { 'Fn::Equals': ['a', 'b'] } },
        Resources: {
          P: {
            Type: 'AWS::SSM::Parameter',
            Condition: 'Never',
            Properties: { Value: { 'Fn::Select': [0, { 'Fn::Split': ['-', { Ref: 'Pw' }] }] } },
          },
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child-export.json' },
            Properties: { Parameters: { In: { Ref: 'Pw' } } },
          },
        },
      } as CloudFormationTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      parameters: { Pw: value },
      isNestedChild: false,
    });
    const child = root.children[0]!;
    expect(child.outputChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'alphapiece-x', changeType: 'ADD', isExport: true }),
      ])
    );
  });

  it('prints the element when the parent parameter is not NoEcho (negative control)', async () => {
    const root = await diffTree(false);
    expect(root.children[0]!.changes.get('ChildRes')?.propertyChanges).toEqual([
      expect.objectContaining({ newValue: FIRST }),
    ]);
  });
});
