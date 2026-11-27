/**
 * go-to-k/cdkd#7090: the passed-secret provenance of go-to-k/cdkd#7068 carried
 * across stacks. A producer root `Prod` exports a piece of a nested row's
 * output, where the row's parameter mixes a secret dynamic reference with
 * other text, and the row record is a legacy one holding that piece in
 * plaintext. A consumer `Cons` diffed in the same run reads it by
 * `Fn::ImportValue` / `Fn::GetStackOutput` and must print it nowhere: not in
 * text, `--json`, `--recursive`, `--verbose`, or its security table. The value
 * is masked by PROVENANCE, never by value, so a 2-char piece is masked too.
 *
 * Generated over: every consumer read shape x the producer's output changed
 * (the preview answers it) or unchanged (the consumer reads state) x secret
 * lengths x the consumer's record (differs, or already holds the value). A
 * consumer already holding the value stays NO_CHANGE: only the display is
 * masked, never the comparison (go-to-k/cdkd#7060). A producer whose row is
 * not secret-fed is the control: there the value IS printed, so each channel
 * scanned below reaches the output.
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
import { CrossStackPreview } from '../../../src/analyzer/cross-stack-preview.js';
import {
  buildDiffTree,
  diffTreeToJson,
  renderDiffTree,
} from '../../../src/cli/commands/diff-recursive.js';
import { getLogger } from '../../../src/utils/logger.js';
import { MIN_NEEDLE_LENGTH } from '../../../src/deployment/secret-redaction.js';
import type { DiffTreeNode } from '../../../src/cli/commands/diff-recursive/types.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { markAppProducerTaint } from '../../../src/cli/commands/diff-recursive/cross-stack-taint.js';

const A = '{{resolve:ssm-secure:/app/a}}';
const IMPORT = { 'Fn::ImportValue': 'piece-export' };

/** How the consumer reads the producer's output, and the leaf it stores when it already holds `v`. */
const READ_SHAPES: Record<string, { value: unknown; holding: (v: string) => string }> = {
  importValue: { value: IMPORT, holding: (v) => v },
  joinedImport: { value: { 'Fn::Join': ['', ['pre-', IMPORT]] }, holding: (v) => `pre-${v}` },
  // An export name this diff cannot match to a producer: tainted whenever any output is.
  computedName: {
    value: { 'Fn::ImportValue': { 'Fn::Join': ['-', ['piece', 'export']] } },
    holding: (v) => v,
  },
  stackOutput: {
    value: { 'Fn::GetStackOutput': { StackName: 'Prod', OutputName: 'Out' } },
    holding: (v) => v,
  },
};

function record(type: string, properties: Record<string, unknown>, extra = {}): ResourceState {
  return {
    physicalId: 'p',
    resourceType: type,
    properties,
    attributes: {},
    dependencies: [],
    ...extra,
  } as unknown as ResourceState;
}

function stack(name: string, resources: Record<string, ResourceState>, outputs = {}): StackState {
  return {
    stackName: name,
    region: 'us-east-1',
    version: 17,
    lastModified: 0,
    outputs,
    exportNames: Object.keys(outputs).filter((k) => k.includes('-')),
    resources,
  } as unknown as StackState;
}

function policy(resource: unknown): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: resource }],
  };
}

let dir: string;
const captured: string[] = [];
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-7090-'));
  writeFileSync(
    join(dir, 'piece.json'),
    JSON.stringify({
      Parameters: { X: { Type: 'String' } },
      Resources: {},
      Outputs: { Piece: { Value: { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'X' }] }] } } },
    })
  );
  writeFileSync(
    join(dir, 'inner.json'),
    JSON.stringify({
      Parameters: { P: { Type: 'String' } },
      Resources: {
        Inner: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: { Ref: 'P' } } },
      },
    })
  );
});
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

interface Case {
  secret: string;
  /** The row's parameter mixes the secret reference (else the control: a plain `Ref`). */
  secretFed: boolean;
  /** The producer's stored output already holds the value: the consumer reads state. */
  producerUnchanged: boolean;
  /** The consumer's records already hold the value. */
  consumerHolds: boolean;
  shape: string;
  /**
   * `cdkd diff Cons` alone: the producer is not diffed, so only the app-wide
   * marks (`markAppProducerTaint`, as `diff.ts` makes them) reach the consumer.
   */
  consumerOnly?: boolean;
}

/**
 * Diffs `Prod` then `Cons` with one preview. `consLog` holds the log lines of
 * the consumer's diff alone: the producer's own resolver lines are
 * go-to-k/cdkd#7077's.
 */
async function diffPair(
  c: Case
): Promise<{
  prod: DiffTreeNode | undefined;
  cons: DiffTreeNode;
  prodLog: string[];
  consLog: string[];
}> {
  const { secret } = c;
  const read = READ_SHAPES[c.shape]!;
  const held = c.consumerHolds ? read.holding(secret) : 'old-import';
  const stored = c.producerUnchanged ? secret : 'old';
  const states: Record<string, StackState> = {
    Prod: stack(
      'Prod',
      {
        Row: record(
          'AWS::CloudFormation::Stack',
          { TemplateURL: 'u', Parameters: { X: c.secretFed ? `${secret}/${A}` : secret } },
          // The legacy record: the piece in plaintext, where a current deploy stores `***`.
          { attributes: { 'Outputs.Piece': secret } }
        ),
      },
      { Out: stored, 'piece-export': stored }
    ),
    Cons: stack(
      'Cons',
      {
        Reader: record('AWS::SSM::Parameter', { Type: 'String', Value: held }, {
          attributes: { Value: held },
        }),
        // A reader of the reader: tainted through the fixed point.
        Echo: record('AWS::SSM::Parameter', { Type: 'String', Value: c.consumerHolds ? held : 'old-echo' }),
        Pol: record('AWS::IAM::Policy', {
          PolicyName: 'p',
          Roles: ['r'],
          PolicyDocument: policy(c.consumerHolds ? `arn:aws:s3:::${held}` : 'arn:aws:s3:::old'),
        }),
        Row2: record('AWS::CloudFormation::Stack', {
          TemplateURL: 'u2',
          Parameters: { P: held },
        }),
      },
      { Shown: held }
    ),
    'Cons~Row2': stack('Cons~Row2', {
      Inner: record('AWS::SSM::Parameter', { Type: 'String', Value: held }),
    }),
  };
  const backend = {
    listStacks: async () => [
      { stackName: 'Prod', region: 'us-east-1' },
      { stackName: 'Cons', region: 'us-east-1' },
    ],
    getState: async (name: string) =>
      states[name] ? { state: structuredClone(states[name]), etag: 'e' } : null,
  };
  const preview = new CrossStackPreview();
  const common = {
    region: 'us-east-1',
    stateBackend: backend,
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
    crossStackPreview: preview,
    recursive: true,
  };
  const prodTemplate = {
  Parameters: { Sep: { Type: 'String' } },
  Resources: {
    Row: {
      Type: 'AWS::CloudFormation::Stack',
      Metadata: { 'aws:asset:path': 'piece.json' },
      Properties: {
        TemplateURL: 'u',
        Parameters: {
          X: c.secretFed ? { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', A]] } : { Ref: 'Sep' },
        },
      },
    },
  },
  Outputs: {
    Out: { Value: { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] }, Export: { Name: 'piece-export' } },
  },
} as CloudFormationTemplate;
  const prod = c.consumerOnly
    ? (markAppProducerTaint(preview, [{ stackName: 'Prod', template: prodTemplate }]), undefined)
    : await buildDiffTree({
        ...common,
        stackName: 'Prod',
        displayName: 'Prod',
        parameters: { Sep: secret },
        nestedTemplates: { Row: join(dir, 'piece.json') },
        template: prodTemplate,
      } as never);
  const prodLog = captured.splice(0);
  const cons = await buildDiffTree({
    ...common,
    stackName: 'Cons',
    displayName: 'Cons',
    nestedTemplates: { Row2: join(dir, 'inner.json') },
    template: {
      Resources: {
        Reader: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: read.value } },
        Echo: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Reader', 'Value'] } },
        },
        Pol: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyName: 'p',
            Roles: ['r'],
            PolicyDocument: policy({ 'Fn::Join': ['', ['arn:aws:s3:::', read.value]] }),
          },
        },
        Row2: {
          Type: 'AWS::CloudFormation::Stack',
          Metadata: { 'aws:asset:path': 'inner.json' },
          Properties: { TemplateURL: 'u2', Parameters: { P: read.value } },
        },
      },
      Outputs: { Shown: { Value: read.value } },
    },
  } as never);
  return { prod, cons, prodLog, consLog: captured.splice(0) };
}

async function securityTables(node: DiffTreeNode): Promise<string[]> {
  const own = (await node.securityDiff?.())?.rendered ?? '';
  const below = await Promise.all(node.children.map(securityTables));
  return [own, ...below.flat()];
}

/** Everything printed: text, `--json`, the security tables, every log line but the resolver's. */
async function printed(node: DiffTreeNode, log: readonly string[]): Promise<string> {
  const lines: string[] = [];
  renderDiffTree(node, true, (line) => lines.push(line));
  return [
    ...lines,
    JSON.stringify(diffTreeToJson(node)),
    ...(await securityTables(node)),
    ...log.filter((line) => !line.includes('[IntrinsicFunctionResolver]')),
  ].join('\n');
}

function changeTypeOf(node: DiffTreeNode, logicalId: string): string | undefined {
  return node.changes.get(logicalId)?.changeType;
}

/** Secrets of 2 chars (under the value scan's floor) and of a normal length. */
const SECRETS = ['Q7', 'жщ', 'Q7longsecretvalue'];

describe('cdkd diff: a consumer reading a secret-fed producer output (#7090)', () => {
  for (const shape of Object.keys(READ_SHAPES)) {
    for (const secret of SECRETS) {
      for (const [producerUnchanged, consumerOnly] of [
        [false, false],
        [true, false],
        [true, true],
      ] as const) {
        for (const consumerHolds of [false, true]) {
          const producer = consumerOnly ? 'not diffed' : producerUnchanged ? 'unchanged' : 'changed';
          const label = `${shape}, "${secret}", producer ${producer}, consumer ${consumerHolds ? 'holds it' : 'differs'}`;
          it(`never prints the value (${label})`, async () => {
            const { prod, cons, prodLog, consLog } = await diffPair({
              secret,
              secretFed: true,
              producerUnchanged,
              consumerHolds,
              shape,
              consumerOnly,
            });
            const text = [
              prod === undefined ? '' : await printed(prod, prodLog),
              await printed(cons, consLog),
            ].join('\n');
            expect(text.includes(secret), text).toBe(false);
            // The consumer's resolver lines too (`--verbose`), once the value
            // clears the masker's floor (a sub-floor piece there is #7077's).
            // Not when the producer is not diffed: the app-wide marks carry no
            // value to mask the resolver's lines with. Its fix is resolver-side,
            // folded into go-to-k/cdkd#7077 as this case.
            if (secret.length >= MIN_NEEDLE_LENGTH && !consumerOnly) {
              const resolved = consLog.join('\n');
              expect(resolved.includes(secret), resolved).toBe(false);
            }
            // Display only: a consumer already holding the value plans nothing.
            if (consumerHolds) {
              for (const id of ['Reader', 'Echo', 'Pol']) {
                expect(changeTypeOf(cons, id), id).toBe('NO_CHANGE');
              }
              expect(cons.outputChanges, JSON.stringify(cons.outputChanges)).toEqual([]);
            }
          });
        }
      }
    }
  }

  // A NESTED child's export: only `--recursive` diffs the child, whose own
  // node marks the export (`markProducerTaint`); the consumer reads it from
  // the child's legacy state.
  for (const [secret, recursive] of SECRETS.flatMap((v) => [
    [v, true],
    [v, false],
  ] as const)) {
    it(`never prints a nested child's export read by a consumer ("${secret}", recursive: ${recursive})`, async () => {
      writeFileSync(
        join(dir, 'exporting.json'),
        JSON.stringify({
          Parameters: { X: { Type: 'String' } },
          Resources: {},
          Outputs: {
            Piece: {
              Value: { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'X' }] }] },
              Export: { Name: 'child-export' },
            },
          },
        })
      );
      const states: Record<string, StackState> = {
        Prod: stack('Prod', {
          Row: record(
            'AWS::CloudFormation::Stack',
            { TemplateURL: 'u', Parameters: { X: `${secret}/${A}` } },
            { attributes: { 'Outputs.Piece': secret } }
          ),
        }),
        'Prod~Row': stack('Prod~Row', {}, { Piece: secret, 'child-export': secret }),
        Cons: stack('Cons', {
          Reader: record('AWS::SSM::Parameter', { Type: 'String', Value: 'old-import' }),
        }),
      };
      const backend = {
        listStacks: async () =>
          Object.keys(states).map((stackName) => ({ stackName, region: 'us-east-1' })),
        getState: async (name: string) =>
          states[name] ? { state: structuredClone(states[name]), etag: 'e' } : null,
      };
      const preview = new CrossStackPreview();
      const common = {
        region: 'us-east-1',
        stateBackend: backend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
        crossStackPreview: preview,
        recursive,
      };
      const prodTemplate = {
        Parameters: { Sep: { Type: 'String' } },
        Resources: {
          Row: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'exporting.json' },
            Properties: {
              TemplateURL: 'u',
              Parameters: { X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', A]] } },
            },
          },
        },
      } as CloudFormationTemplate;
      // As `diff.ts` does before any diff: the app's templates, nested ones included.
      markAppProducerTaint(preview, [
        {
          stackName: 'Prod',
          template: prodTemplate,
          nestedTemplates: { Row: join(dir, 'exporting.json') },
        },
      ]);
      const prod = await buildDiffTree({
        ...common,
        stackName: 'Prod',
        displayName: 'Prod',
        parameters: { Sep: secret },
        nestedTemplates: { Row: join(dir, 'exporting.json') },
        template: prodTemplate,
      } as never);
      const prodLog = captured.splice(0);
      const cons = await buildDiffTree({
        ...common,
        stackName: 'Cons',
        displayName: 'Cons',
        nestedTemplates: {},
        template: {
          Resources: {
            Reader: {
              Type: 'AWS::SSM::Parameter',
              Properties: { Type: 'String', Value: { 'Fn::ImportValue': 'child-export' } },
            },
          },
        },
      } as never);
      const consLog = captured.splice(0);
      expect(preview.exportTainted('us-east-1', 'child-export')).toBe(true);
      const text = [await printed(prod, prodLog), await printed(cons, consLog)].join('\n');
      expect(text.includes(secret), text).toBe(false);
      expect(changeTypeOf(cons, 'Reader')).toBe('UPDATE');
    });
  }

  // The control: the row is not secret-fed, so the import is an ordinary value
  // and every channel above prints it. Without this, a channel that never
  // reached the output would pass the scan.
  for (const shape of ['importValue', 'stackOutput']) {
    it(`prints a value that is not secret-fed (${shape})`, async () => {
      const secret = 'Q7plainvalue';
      const { cons } = await diffPair({
        secret,
        secretFed: false,
        producerUnchanged: false,
        consumerHolds: false,
        shape,
      });
      const lines: string[] = [];
      renderDiffTree(cons, true, (line) => lines.push(line));
      const json = JSON.stringify(diffTreeToJson(cons));
      expect(lines.join('\n')).toContain(secret);
      expect(json).toContain(secret);
      expect((await securityTables(cons)).join('\n')).toContain(secret);
      expect(changeTypeOf(cons, 'Reader')).toBe('UPDATE');
    });
  }
});
