/**
 * go-to-k/cdkd#7068: `cdkd diff` over a nested row parameter whose value MIXES
 * a secret dynamic reference with other text (`<sep>/{{resolve:ssm-secure:/app/a}}`),
 * where that other text is a sub-floor secret's plaintext (`/app/b` resolves to
 * the same `<sep>`). The diff never holds that plaintext and the value scan
 * skips a 1-3 char needle, so every displayed leaf reading the parameter is
 * masked by PROVENANCE: the parent's `Parameters` row, every child leaf
 * reading it through any intrinsic, a resource named from it and its readers,
 * the child's outputs, a grandchild fed from it, and the `--verbose`
 * replacement line. Generated over leaf shapes x 1-3 char secrets x the
 * stored side (masked, or legacy plaintext), scanning the WHOLE rendered
 * output (text, `--json`, every log line) for the plaintext.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async () => {
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
import {
  buildDiffTree,
  diffTreeToJson,
  renderDiffTree,
} from '../../../src/cli/commands/diff-recursive.js';
import { getLogger } from '../../../src/utils/logger.js';
import { MIN_NEEDLE_LENGTH } from '../../../src/deployment/secret-redaction.js';
import type { DiffTreeNode } from '../../../src/cli/commands/diff-recursive/types.js';
import {
  SECURITY_TABLE_WITHHELD,
  maskPassedSecretChanges,
} from '../../../src/cli/commands/diff-recursive/passed-secret-display.js';
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
  resources['Grand'] = {
    Type: 'AWS::CloudFormation::Stack',
    Metadata: { 'aws:asset:path': 'grand.json' },
    Properties: { TemplateURL: 'https://s3.amazonaws.com/b/grand.json', Parameters: { Y: PIECE } },
  };
  return {
    Parameters: { X: { Type: 'String' }, W: { Type: 'String' } },
    Conditions: { Always: { 'Fn::Equals': ['a', 'a'] } },
    Resources: resources,
    Outputs: {
      Piece: { Value: PIECE },
      Whole: { Value: { Ref: 'X' }, Export: { Name: 'exported-whole' } },
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

const PARENT_TEMPLATE = {
  Parameters: { Sep: { Type: 'String' } },
  Resources: {
    Child: {
      Type: 'AWS::CloudFormation::Stack',
      Metadata: { 'aws:asset:path': 'child.json' },
      Properties: {
        TemplateURL: 'https://s3.amazonaws.com/b/child.json',
        Parameters: { X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', A]] }, W: B },
      },
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
  child['Grand'] = record('AWS::CloudFormation::Stack', {
    TemplateURL: 'https://s3.amazonaws.com/b/grand.json',
    Parameters: { Y: old },
  });
  return {
    Parent: stack('Parent', {
      Child: record('AWS::CloudFormation::Stack', {
        TemplateURL: 'https://s3.amazonaws.com/b/child.json',
        Parameters: { X: old, W: B },
      }),
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
    parameters: { Sep: sep },
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

async function securityTables(node: DiffTreeNode): Promise<string[]> {
  const own = (await node.securityDiff?.())?.rendered ?? '';
  const below = await Promise.all(node.children.map(securityTables));
  return [own, ...below.flat()];
}

/**
 * Everything the command prints: the text tree, `--json`, and every log line
 * but the resolver's own. Those print each resolution's value, a sub-floor
 * piece of the mixed value included, which only a resolver-side mask can
 * close; `resolverLines` holds them for the whole-value check below.
 */
function everythingPrinted(root: DiffTreeNode): string {
  const lines: string[] = [];
  renderDiffTree(root, true, (line) => lines.push(line));
  return [
    ...lines,
    JSON.stringify(diffTreeToJson(root)),
    ...captured.filter((line) => !line.includes('[IntrinsicFunctionResolver]')),
  ].join('\n');
}

function resolverLines(): string {
  return captured.filter((line) => line.includes('[IntrinsicFunctionResolver]')).join('\n');
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

describe('cdkd diff: a nested row parameter mixing a secret reference (#7068)', () => {
  for (const sep of SECRETS) {
    for (const [label, old] of [
      ['masked state', '***'],
      ['legacy plaintext state', `${sep}/${sep}`],
    ] as const) {
      it(`never prints "${sep}" (${label}), recursive`, async () => {
        const root = await diff(sep, old, true);
        const tables = await securityTables(root);
        const printed = [everythingPrinted(root), ...tables].join('\n');
        expect(printed.includes(sep), printed).toBe(false);
        // The resolver's lines never carry the value WHOLE, nor a stored
        // physical id built from it once that clears the masker's floor.
        const resolved = resolverLines();
        expect(resolved.includes(`${sep}/{{`), resolved).toBe(false);
        if (old.length >= MIN_NEEDLE_LENGTH) expect(resolved.includes(old), resolved).toBe(false);

        // Nothing is hidden: every reading row is still a change.
        const child = findNode(root, 'Parent~Child')!;
        for (const id of [...Object.keys(DB_NAME_SHAPES), 'TagDb', 'Named', 'Pol', 'Grand']) {
          expect(child.changes.get(id)?.changeType, id).not.toBe('NO_CHANGE');
        }
        expect(root.changes.get('Child')?.changeType).toBe('UPDATE');
        expect(findNode(root, 'Parent~Child~Grand')?.changes.get('GrandDb')?.changeType).not.toBe(
          'NO_CHANGE'
        );
        // The shown values are the mask, and the unrelated row key stays readable.
        const parameters = root.changes.get('Child')?.propertyChanges?.find(
          (change) => change.path === 'Parameters'
        );
        expect((parameters?.newValue as Record<string, unknown>)['X']).toBe('***');
        // The child's IAM change is still reported, its table withheld.
        expect(tables).toContain(SECURITY_TABLE_WITHHELD);
        // The replacement line is still logged, masked.
        expect(captured.some((line) => /Property DBName of AWS::RDS::DBInstance requires replacement \(from \*\*\* to \*\*\*\)/.test(line))).toBe(true);
      });
    }

    for (const old of ['***', `${sep}/${sep}`]) {
    it(`never prints "${sep}" on the parent row, non-recursive (stored ${old === '***' ? 'masked' : 'legacy plaintext'})`, async () => {
      const root = await diff(sep, old, false);
      expect(root.changes.get('Child')?.changeType).toBe('UPDATE');
      const printed = everythingPrinted(root);
      expect(printed.includes(sep), printed).toBe(false);
    });
    }
  }
});

describe('maskPassedSecretChanges: a nested row Parameters side that is no plain object (#7068)', () => {
  const row = (oldValue: unknown, newValue: unknown) =>
    new Map([
      [
        'Child',
        {
          logicalId: 'Child',
          changeType: 'UPDATE' as const,
          resourceType: 'AWS::CloudFormation::Stack',
          propertyChanges: [{ path: 'Parameters', oldValue, newValue, requiresReplacement: false }],
        },
      ],
    ]);
  const shown = (changes: ReturnType<typeof row>, template: unknown, tainted: string[]) =>
    maskPassedSecretChanges(changes, template as never, new Set(tainted)).get('Child')
      ?.propertyChanges?.[0];

  it('masks every side whole when one side is a string holding a mixed value', () => {
    const pc = shown(row(`Q7/${A}`, { X: 'plain' }), { Resources: {} }, []);
    expect([pc?.oldValue, pc?.newValue]).toEqual(['***', '***']);
  });

  it('masks every side whole when the template Parameters is an intrinsic reading a tainted name', () => {
    const template = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { 'Fn::If': ['C', { Y: { Ref: 'X' } }, { Y: 'b' }] } },
        },
      },
    };
    const pc = shown(row({ Y: 'old' }, { Y: 'Q7' }), template, ['X']);
    expect([pc?.oldValue, pc?.newValue]).toEqual(['***', '***']);
  });

  it('leaves a row that holds and reads nothing of the kind as it is', () => {
    const changes = row({ X: 'a' }, { X: 'b', W: B });
    expect(maskPassedSecretChanges(changes, { Resources: {} } as never, new Set())).toBe(changes);
  });
});
