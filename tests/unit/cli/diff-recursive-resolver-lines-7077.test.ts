/**
 * go-to-k/cdkd#7077: `cdkd diff --recursive --verbose` over go-to-k/cdkd#7068's
 * shape (a nested row parameter `X` mixing a secret reference with `<sep>`, a
 * 1-3 character text that is also another secret's plaintext). The
 * resolver's own debug lines print no `<sep>` in the child or the grandchild:
 * every piece of `X` (`Fn::Select`, `Fn::Join`, `Fn::Sub`, `Fn::If`, a
 * reader's `Ref` / `Fn::GetAtt`, the grandchild's `Y`) is masked by
 * provenance. The parent's own `Sep` lines print the user's CLI input and
 * are out of scope. Harness: the #7068 suite's.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        // A PUBLIC reference: the diff resolves it, so nothing of it is masked.
        if (command.input?.Name === '/pub/host') {
          return { Parameter: { Type: 'String', Value: 'pub.example.com' } };
        }
        // A bare `ssm:` reference a SecureString answers: the diff skips it.
        if (command.input?.Name === '/sec') {
          return { Parameter: { Type: 'SecureString', Value: 'ciphertext' } };
        }
        const e = new Error('ParameterNotFound');
        e.name = 'ParameterNotFound';
        throw e;
      }),
    },
    secretsManager: { send: vi.fn().mockRejectedValue(new Error('unused')) },
    cloudFormation: { send: () => Promise.reject(new Error('DescribeType unavailable')) },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable')),
    })),
  };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { buildDiffTree } from '../../../src/cli/commands/diff-recursive.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { DiffTreeNode } from '../../../src/cli/commands/diff-recursive/types.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const A = '{{resolve:ssm-secure:/app/a}}';
const B = '{{resolve:ssm-secure:/app/b}}';
/** A sub-floor piece of `X`: the text before the `/`. */
const PIECE = { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'X' }] }] };

/** Child leaf shapes reading `X`, each on its own replace-on-change `DBName`. */
const DB_NAME_SHAPES: Record<string, unknown> = {
  RefDb: { Ref: 'X' },
  SubDb: { 'Fn::Sub': '${X}-s' },
  SubVarDb: { 'Fn::Sub': ['${V}', { V: { Ref: 'X' } }] },
  JoinDb: { 'Fn::Join': ['-', [{ Ref: 'X' }, 'a']] },
  SelectDb: PIECE,
  IfDb: { 'Fn::If': ['Always', PIECE, 'b'] },
  // A name built from `X` (its physical id), read by `Ref` and `Fn::GetAtt`.
  RefReaderDb: { Ref: 'Named' },
  GetAttReaderDb: { 'Fn::GetAtt': ['Named', 'Value'] },
};

const FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:';

function policy(resource: unknown): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: resource }],
  };
}

function childTemplate(): Record<string, unknown> {
  const resources: Record<string, unknown> = {};
  for (const [id, dbName] of Object.entries(DB_NAME_SHAPES)) {
    resources[id] = {
      Type: 'AWS::RDS::DBInstance',
      Properties: { Engine: 'mysql', DBName: dbName },
    };
  }
  // A nested (non-replacement) leaf.
  resources['TagDb'] = {
    Type: 'AWS::RDS::DBInstance',
    Properties: { Engine: 'mysql', DBName: 'static', Tags: [{ Key: 'k', Value: PIECE }] },
  };
  resources['Named'] = {
    Type: 'AWS::SSM::Parameter',
    Properties: { Type: 'String', Name: { 'Fn::Sub': '/n/${X}' }, Value: PIECE },
  };
  // A statement built from `X`: the security table prints resolved values.
  resources['Pol'] = {
    Type: 'AWS::IAM::Policy',
    Properties: {
      PolicyName: 'p',
      Roles: ['r'],
      PolicyDocument: policy({ 'Fn::Sub': 'arn:aws:s3:::${X}' }),
    },
  };
  // A custom resource whose handler ARN is built from `X`: the deploy refuses
  // the changed token, and that refusal names the desired token.
  resources['Cr'] = {
    Type: 'Custom::Thing',
    Properties: {
      ServiceToken: { 'Fn::Join': ['', [`${FUNCTION_ARN}h-`, PIECE]] },
    },
  };
  resources['Grand'] = {
    Type: 'AWS::CloudFormation::Stack',
    Metadata: { 'aws:asset:path': 'grand.json' },
    Properties: {
      TemplateURL: 'https://s3.amazonaws.com/b/grand.json',
      Parameters: { Y: PIECE },
      // A stack tag from `X`: merged into every taggable grandchild resource.
      // Distinct from every value a needle holds, so only the tag KEY masks it.
      Tags: [{ Key: 't', Value: { 'Fn::Join': ['', [PIECE, '-t']] } }],
    },
  };
  return {
    Parameters: { X: { Type: 'String' }, W: { Type: 'String' }, Url: { Type: 'String' } },
    Conditions: { Always: { 'Fn::Equals': ['a', 'a'] } },
    Resources: resources,
    Outputs: {
      Piece: { Value: PIECE },
      Whole: { Value: { Ref: 'X' }, Export: { Name: 'exported-whole' } },
      // A sub-floor piece exported: its alias row carries the value too.
      PieceExport: { Value: PIECE, Export: { Name: 'exported-piece' } },
      // An export NAME built from `X`: its alias row's name is withheld.
      NameOut: { Value: 'v', Export: { Name: { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'X' }] }] } } },
    },
  };
}

const GRAND_TEMPLATE = {
  Parameters: { Y: { Type: 'String' } },
  Resources: {
    GrandDb: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'mysql', DBName: { Ref: 'Y' } } },
  },
};

const PUBLIC = 'https://{{resolve:ssm:/pub/host}}/x';

const PARENT_TEMPLATE = {
  Parameters: { Sep: { Type: 'String' }, TagParam: { Type: 'String' } },
  Resources: {
    Child: {
      Type: 'AWS::CloudFormation::Stack',
      Metadata: { 'aws:asset:path': 'child.json' },
      Properties: {
        TemplateURL: 'https://s3.amazonaws.com/b/child.json',
        Parameters: { X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', A]] }, W: B, Url: PUBLIC },
        // A stack tag mixing the reference, handed to the whole subtree.
        Tags: [
          { Key: 'pt', Value: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '#', A]] } },
          // Mixed only once resolved: the template spells no reference.
          { Key: 'pp', Value: { Ref: 'TagParam' } },
        ],
      },
    },
    // A reader of the row's output: the child holding the plaintext answers it.
    Reader: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Child', 'Outputs.Piece'] } },
    },
  },
};

function record(type: string, properties: Record<string, unknown>, physicalId = 'p'): ResourceState {
  return {
    physicalId,
    resourceType: type,
    properties,
    attributes: {},
    dependencies: [],
  } as unknown as ResourceState;
}

function stack(name: string, resources: Record<string, ResourceState>, outputs = {}): StackState {
  return {
    stackName: name,
    region: 'us-east-1',
    version: 17,
    lastModified: 0,
    outputs,
    resources,
  } as unknown as StackState;
}

/** The deployed states: each stored leaf `old` (the deploy's mask, or legacy plaintext). */
function states(old: string): Record<string, StackState> {
  const child: Record<string, ResourceState> = {};
  for (const id of Object.keys(DB_NAME_SHAPES)) {
    child[id] = record('AWS::RDS::DBInstance', { Engine: 'mysql', DBName: old });
  }
  child['TagDb'] = record('AWS::RDS::DBInstance', {
    Engine: 'mysql',
    DBName: 'static',
    Tags: [{ Key: 'k', Value: old }],
  });
  child['Named'] = record('AWS::SSM::Parameter', { Type: 'String', Name: old, Value: old }, old);
  child['Named']!.attributes = { Value: old };
  child['Pol'] = record('AWS::IAM::Policy', {
    PolicyName: 'p',
    Roles: ['r'],
    PolicyDocument: policy(`arn:aws:s3:::${old}`),
  });
  child['Cr'] = record('Custom::Thing', { ServiceToken: `${FUNCTION_ARN}h-old` });
  child['Grand'] = record('AWS::CloudFormation::Stack', {
    TemplateURL: 'https://s3.amazonaws.com/b/grand.json',
    Parameters: { Y: old },
    Tags: [{ Key: 't', Value: old }],
  });
  return {
    Parent: stack('Parent', {
      Child: {
        ...record('AWS::CloudFormation::Stack', {
          TemplateURL: 'https://s3.amazonaws.com/b/child.json',
          Parameters: { X: old, W: B, Url: 'https://old.example.com/x' },
          Tags: [
            { Key: 'pt', Value: old },
            { Key: 'pp', Value: old },
          ],
        }),
        attributes: { 'Outputs.Piece': old },
      },
      Reader: record('AWS::SSM::Parameter', { Type: 'String', Value: 'reader-old' }),
    }),
    'Parent~Child': stack('Parent~Child', child, { Piece: old, Whole: old, 'exported-whole': old }),
    'Parent~Child~Grand': stack('Parent~Child~Grand', {
      GrandDb: record('AWS::RDS::DBInstance', { Engine: 'mysql', DBName: old }),
    }),
  };
}

let dir: string;
const captured: string[] = [];
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-7068-'));
  writeFileSync(join(dir, 'child.json'), JSON.stringify(childTemplate()));
  writeFileSync(join(dir, 'grand.json'), JSON.stringify(GRAND_TEMPLATE));
});
// Per test: the suite's config restores spies after each one.
beforeEach(() => {
  for (const method of consoleMethods) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    });
  }
  getLogger().setLevel('debug');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  captured.length = 0;
  getLogger().setLevel('info');
  vi.restoreAllMocks();
});

async function diff(sep: string, old: string, recursive: boolean): Promise<DiffTreeNode> {
  const stored = states(old);
  return buildDiffTree({
    stackName: 'Parent',
    displayName: 'Parent',
    region: 'us-east-1',
    template: structuredClone(PARENT_TEMPLATE),
    parameters: { Sep: sep, TagParam: `${sep}%${A}` },
    nestedTemplates: { Child: join(dir, 'child.json') },
    recursive,
    stateBackend: {
      getState: async (name: string) =>
        stored[name] ? { state: structuredClone(stored[name]), etag: 'e' } : null,
    },
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
  } as never);
}

function findNode(root: DiffTreeNode, name: string): DiffTreeNode | undefined {
  if (root.stackName === name) return root;
  for (const child of root.children) {
    const hit = findNode(child, name);
    if (hit) return hit;
  }
  return undefined;
}

/** 1-3 char secrets; ASCII and non-ASCII, none spelled by the rest of the output. */
const SECRETS = ['ж', 'жщ', 'жщю', 'Q7', 'Q7Z'];


/** The parent's lines printing its own CLI input `Sep` / `TagParam` (out of scope: the user typed it). */
const USER_INPUT_LINE = /\[IntrinsicFunctionResolver\] (Parameter (Sep|TagParam): using user-provided value |Resolved Ref to parameter: Sep resolved to )/;

describe('cdkd diff --recursive --verbose: the resolver lines print no sub-floor piece (#7077)', () => {
  for (const sep of SECRETS) {
    for (const [label, old] of [
      ['masked state', '***'],
      ['legacy plaintext state', `${sep}/${sep}`],
    ] as const) {
      it(`never prints "${sep}" on a child or grandchild resolver line (${label})`, async () => {
        const root = await diff(sep, old, true);
        const lines = captured.filter(
          (line) => line.includes('[IntrinsicFunctionResolver]') && !USER_INPUT_LINE.test(line)
        );
        expect(lines.filter((line) => line.includes(sep))).toEqual([]);
        // Present, masked: the child's piece and the grandchild's parameter.
        const joined = lines.join('\n');
        expect(joined).toContain('Resolved Fn::Select: index *** resolved to ***');
        expect(joined).toContain('Parameter Y: using user-provided value ***');
        expect(joined).toContain('Resolved Ref to parameter: Y resolved to ***');
        // Display only: every reader is still the change it is.
        expect(findNode(root, 'Parent~Child~Grand')?.changes.get('GrandDb')?.changeType).not.toBe(
          'NO_CHANGE'
        );
      });
    }
  }
});
