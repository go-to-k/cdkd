/**
 * `cdkd diff --verbose` masks a physical name derived from a secret
 * (go-to-k/cdkd#3869): a `Ref` / `Fn::GetAtt` to a resource whose state record
 * still spells its name as a `{{resolve:` reference resolves to that name (or
 * an ARN embedding it), which the resolver's `resolved to` line printed. The
 * diff now gives each context the shared judge and a print-only sink.
 *
 * The REAL resolver, over state alone: every read is served from the record
 * (`physicalId`, recorded `attributes`), so nothing leaves the process.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const debugLines = vi.hoisted(() => [] as string[]);
// Each line through the sink masker `ConsoleLogger` applies, so a line masked
// only by a bag bound around it (`withPrintingSecrets`) reads as printed.
vi.mock('../../../src/utils/logger.js', async () => {
  const { currentLogLineMasker: sink } = await import('../../../src/utils/log-line-masker.js');
  const fns = {
    setLevel: vi.fn(),
    debug: (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      debugLines.push(sink()?.(line) ?? line);
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// A changed row asks CloudFormation for the type's create-only properties; a
// refusal falls back to the bundled schema, so nothing leaves the process.
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiffTree, computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  hasMaskableValues,
  maskSecretsInText,
  recordLogOnlyValue,
} from '../../../src/deployment/secret-redaction.js';
import {
  maskedInputFingerprint,
  maskedPropertyFingerprint,
  parameterInputsFor,
} from '../../../src/deployment/masked-property-fingerprints.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/sdin-diff-secret-queue';
const ARN = 'arn:aws:sqs:us-east-1:123456789012:sdin-diff-secret-queue';

function template(queueName: string): CloudFormationTemplate {
  return {
    Resources: {
      Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: queueName } },
      Policy: {
        Type: 'AWS::SQS::QueuePolicy',
        Properties: {
          Queues: [{ Ref: 'Queue' }],
          PolicyDocument: { Statement: [{ Resource: { 'Fn::GetAtt': ['Queue', 'Arn'] } }] },
        },
      },
    },
  };
}

function state(queueName: string): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    version: 9,
    resources: {
      Queue: {
        physicalId: URL,
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: queueName },
        attributes: { Arn: ARN },
        dependencies: [],
      },
      Policy: {
        physicalId: 'policy-1',
        resourceType: 'AWS::SQS::QueuePolicy',
        // Equal to what the template resolves to, so the row is NO_CHANGE and
        // the diff asks AWS for no create-only schema; the reads still resolve.
        properties: { Queues: [URL], PolicyDocument: { Statement: [{ Resource: ARN }] } },
        attributes: {},
        dependencies: ['Queue'],
      },
    },
    outputs: {},
    exportNames: [],
    lastModified: 0,
  };
}

const backend = { getState: async () => null } as unknown as S3StateBackend;

async function diffLines(queueName: string): Promise<string> {
  debugLines.length = 0;
  await computeStackDiff(
    state(queueName),
    template(queueName),
    'us-east-1',
    'S',
    backend,
    new DiffCalculator()
  );
  return debugLines.join('\n');
}

describe('cdkd diff --verbose masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  beforeEach(() => {
    debugLines.length = 0;
  });

  it("masks a Ref / Fn::GetAtt to a secret-named resource on the resolver's lines", async () => {
    const lines = await diffLines('{{resolve:secretsmanager:sdin:SecretString:queue::}}');
    // Premise: the reads were resolved and printed.
    expect(lines).toContain('Ref to resource: Queue resolved to');
    expect(lines).toContain('Queue.Arn resolved to');
    expect(lines).not.toContain('sdin-diff-secret-queue');
  });

  it("keeps the reads out of the corpus a nested child inherits", async () => {
    // `printingSecrets` is what a child's diff inherits; a needle there would
    // change the child's export-alias preview.
    const result = await computeStackDiff(
      state('{{resolve:secretsmanager:sdin:SecretString:queue::}}'),
      template('{{resolve:secretsmanager:sdin:SecretString:queue::}}'),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    expect(debugLines.join('\n')).toContain('Ref to resource: Queue resolved to');
    expect(hasMaskableValues(result.printingSecrets)).toBe(false);
  });

  it.each([
    ['a secret-named target', '{{resolve:secretsmanager:sdin:SecretString:queue::}}', false],
    ['negative control, an ordinary name', 'plain-queue-name', true],
  ])('masks the rows it renders, a reader\'s changed value included: %s', async (_l, name, shown) => {
    // The reader's recorded document differs from what it now resolves to, so
    // its row carries the ARN; without `--verbose`, this is what prints.
    const s = state(name);
    (s.resources['Policy']!.properties as Record<string, unknown>)['PolicyDocument'] = {
      Statement: [{ Resource: 'arn:aws:sqs:us-east-1:123456789012:older-queue' }],
    };
    const result = await computeStackDiff(s, template(name), 'us-east-1', 'S', backend, new DiffCalculator());
    // What the renderer prints: the property rows.
    const row = JSON.stringify(result.changes.get('Policy')?.propertyChanges);
    // Premise: the row is rendered (a masked new side withholds the old one).
    expect(row).toContain('"path":"PolicyDocument"');
    expect(row.includes('sdin-diff-secret-queue')).toBe(shown);
  });

  it("masks an OUTPUT reading a secret-named resource, on the outputs pass's line", async () => {
    const tpl = template('{{resolve:secretsmanager:sdin:SecretString:queue::}}');
    tpl.Outputs = { QueueArn: { Value: { 'Fn::GetAtt': ['Queue', 'Arn'] } } };
    debugLines.length = 0;
    const result = await computeStackDiff(
      state('{{resolve:secretsmanager:sdin:SecretString:queue::}}'),
      tpl,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    const lines = debugLines.join('\n');
    // Premise: the outputs pass resolved it too, not only the reader's row.
    expect(lines.split('\n').filter((l) => l.includes('Queue.Arn resolved to')).length).toBeGreaterThanOrEqual(2);
    expect(lines).not.toContain('sdin-diff-secret-queue');
    // The outputs pass's own bag decides export aliases: it holds nothing.
    expect(hasMaskableValues(result.printingSecrets)).toBe(false);
  });

  it.each([
    ['the stack-wide NoEcho values judge it', true],
    ['negative control, a non-NoEcho parameter', false],
  ])('masks a resource named from a NoEcho value in the spelling AWS keeps: %s', async (_l, noEcho) => {
    // RDS lower-cases the identifier: the id is no substring of the NoEcho
    // value the diff masks, only its lower-cased spelling is.
    const tpl: CloudFormationTemplate = {
      Parameters: { DbName: { Type: 'String', Default: 'TeamSecretDb', ...(noEcho && { NoEcho: true }) } },
      Resources: {
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: { Ref: 'DbName' } } },
        Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'Db' } } },
      },
    };
    const s: StackState = {
      stackName: 'S',
      region: 'us-east-1',
      version: 9,
      resources: {
        Db: {
          physicalId: 'teamsecretdb',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceIdentifier: 'TeamSecretDb' },
          attributes: {},
          dependencies: [],
        },
        Reader: {
          physicalId: 'reader',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: 'teamsecretdb' },
          attributes: {},
          dependencies: ['Db'],
        },
      },
      outputs: {},
      exportNames: [],
      lastModified: 0,
    };
    debugLines.length = 0;
    await computeStackDiff(s, tpl, 'us-east-1', 'S', backend, new DiffCalculator());
    const lines = debugLines.join('\n');
    expect(lines).toContain('Ref to resource: Db resolved to');
    expect(lines.includes('teamsecretdb')).toBe(!noEcho);
  });

  it("keeps an output's Fn::Base64 of the name out of the corpus a child inherits, with a NoEcho value in it", async () => {
    // The outputs pass sets `printingSecrets` (the diff bag, holding the
    // NoEcho value) AND the sink: the encoding belongs to the sink only.
    const tpl = template('{{resolve:secretsmanager:sdin:SecretString:queue::}}');
    tpl.Parameters = { Tok: { Type: 'String', NoEcho: true, Default: 'unrelated-noecho-token' } };
    tpl.Outputs = { Enc: { Value: { 'Fn::Base64': { Ref: 'Queue' } } } };
    debugLines.length = 0;
    const result = await computeStackDiff(
      state('{{resolve:secretsmanager:sdin:SecretString:queue::}}'),
      tpl,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    const encoded = Buffer.from(URL).toString('base64');
    expect(debugLines.join('\n')).toContain('Resolved Fn::Base64');
    expect(debugLines.join('\n')).not.toContain(encoded);
    expect(maskSecretsInText(encoded, result.printingSecrets)).toBe(encoded);
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await diffLines('plain-queue-name');
    expect(lines).toContain('sdin-diff-secret-queue');
  });

  describe("the masked-input pass's reads (previewMaskedInputs)", () => {
    // A reader whose masked property reads the Queue. The Queue's TEMPLATE
    // name is now a literal, so the pass's taint check lets the read through,
    // while its STATE record still spells the name as a reference: the judge
    // reads the record, so the read is secret-named.
    //
    // SHARED: the main pass resolves the same `Ref: Queue` first, so the row
    // is the one the Queue's replacement makes.
    const SHARED = {
      'Fn::Base64': {
        'Fn::Join': ['', [{ Ref: 'Queue' }, ';pw=', '{{resolve:secretsmanager:app-pw}}']],
      },
    };
    // ONLY_HERE: a read only this pass makes. The custom resource's record
    // lacks `OutArn`, so the main pass refuses `${Thing.OutArn}` (an `*Arn`
    // name takes no physical-id fallback) before reaching `${Queue}` and
    // leaves `Value` as written; this pass keeps the opaque attribute as
    // written and resolves the Queue alone.
    const ONLY_HERE = {
      'Fn::Base64': { 'Fn::Sub': '${Thing.OutArn}-${Queue};pw={{resolve:secretsmanager:app-pw}}' },
    };
    const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:thing';
    const inputTemplate = (value: unknown): CloudFormationTemplate => ({
      Resources: {
        Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'plain-literal-queue' } },
        Thing: { Type: 'Custom::Thing', Properties: { ServiceToken: TOKEN } },
        R: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'n', Type: 'String', Value: value } },
      },
    });
    async function inputState(stateName: string, value: unknown): Promise<StackState> {
      const tpl = inputTemplate(value);
      const fingerprint = await maskedInputFingerprint(value, {
        template: tpl,
        parameterInput: parameterInputsFor({ template: tpl, values: {} }).parameterInput,
        // Stamped over the URL, as the deploy that wrote the record saw it.
        // Only the Queue is resolved: the custom attribute is opaque.
        resolve: async (node: unknown) => {
          if (JSON.stringify(node) !== JSON.stringify({ Ref: 'Queue' })) {
            throw new Error(`unexpected node ${JSON.stringify(node)}`);
          }
          return { value: URL, secrets: new Map() };
        },
      });
      expect(fingerprint).toBeDefined();
      const s = state(stateName);
      delete s.resources['Policy'];
      s.resources['Thing'] = {
        physicalId: 'thing-1',
        resourceType: 'Custom::Thing',
        properties: { ServiceToken: TOKEN },
        attributes: {},
        dependencies: [],
      };
      s.resources['R'] = {
        physicalId: 'n',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: 'n', Type: 'String', Value: '***' },
        attributes: {},
        dependencies: ['Queue', 'Thing'],
        maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(value) },
        maskedPropertyInputFingerprints: { Value: fingerprint! },
      };
      return s;
    }
    async function run(stateName: string, value: unknown, preview: boolean) {
      debugLines.length = 0;
      const result = await computeStackDiff(
        await inputState(stateName, value),
        inputTemplate(value),
        'us-east-1',
        'S',
        backend,
        new DiffCalculator(),
        { previewMaskedInputs: preview }
      );
      const lines = debugLines.join('\n');
      const refLines = lines.split('\n').filter((l) => l.includes('Ref to resource: Queue resolved to'));
      return { result, lines, refLines };
    }
    const SECRET_NAME = '{{resolve:ssm:/sdin/queue-name}}';

    it("masks the name on the pass's own resolver lines, a read no other pass makes", async () => {
      const off = await run(SECRET_NAME, ONLY_HERE, false);
      const on = await run(SECRET_NAME, ONLY_HERE, true);
      // Premise: only this pass resolved the read, and it printed it.
      expect(off.refLines).toEqual([]);
      expect(on.refLines.length).toBeGreaterThan(0);
      expect(on.lines).not.toContain('sdin-diff-secret-queue');
    });

    it('negative control: an ordinary name prints as it is', async () => {
      const on = await run('plain-older-queue', ONLY_HERE, true);
      expect(on.refLines.length).toBeGreaterThan(0);
      expect(on.lines).toContain('sdin-diff-secret-queue');
    });

    it("keeps the needles out of the pass's deciding bag: no masked-expression change", async () => {
      const off = await run(SECRET_NAME, SHARED, false);
      const { result, refLines } = await run(SECRET_NAME, SHARED, true);
      // Premise: the pass resolved the read too.
      expect(refLines.length).toBeGreaterThan(off.refLines.length);
      const change = result.changes.get('R')!;
      expect(change.propertyChanges?.length).toBe(1);
      // A needle in the bag the pass returns would class the read as a secret
      // input, so the stamped fingerprint would no longer match.
      expect(change.propertyChanges?.some((p) => 'maskedExpressionChanged' in p)).toBe(false);
      // The row stays what the Queue's replacement makes it.
      expect(change.propertyChanges).toEqual([
        expect.objectContaining({ path: 'Value', replacementPropagated: true }),
      ]);
    });
  });

  it.each([
    ['a secret-named target', '{{resolve:secretsmanager:sdin:SecretString:queue::}}', false],
    ['negative control, an ordinary name', 'plain-queue-name', true],
  ])(
    "masks a parent row's Ref passed to a nested child, on the child's own walk too: %s",
    async (_l, queueName, shown) => {
      // The parent row's `Parameters` resolve twice: in the parent's own diff,
      // and again to bind the child's inputs (`resolveChildStackParameters`).
      // The child then binds the value as its OWN parameter and prints it on
      // its parameter and `Ref` lines and in its rendered rows.
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-3869-'));
      try {
        const childPath = join(dir, 'child.json');
        writeFileSync(
          childPath,
          JSON.stringify({
            Parameters: { QueueUrl: { Type: 'String' } },
            Resources: {
              Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'QueueUrl' } } },
            },
          })
        );
        const parent = state(queueName);
        parent.resources['Child'] = {
          physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/S-Child/1',
          resourceType: 'AWS::CloudFormation::Stack',
          properties: { Parameters: { QueueUrl: URL } },
          attributes: {},
          dependencies: ['Queue'],
        };
        const tpl = template(queueName);
        tpl.Resources['Child'] = {
          Type: 'AWS::CloudFormation::Stack',
          Metadata: { 'aws:asset:path': 'child.json' },
          Properties: { Parameters: { QueueUrl: { Ref: 'Queue' } } },
        };
        const child: StackState = {
          stackName: 'S~Child',
          region: 'us-east-1',
          version: 9,
          resources: {
            // A recorded value that differs, so the child's row renders the
            // value it now reads.
            Reader: {
              physicalId: 'reader-param',
              resourceType: 'AWS::SSM::Parameter',
              properties: { Value: 'https://sqs.us-east-1.amazonaws.com/123456789012/older' },
              attributes: {},
              dependencies: [],
            },
          },
          outputs: {},
          lastModified: 0,
        };
        const states: Record<string, StackState> = { S: parent, 'S~Child': child };
        debugLines.length = 0;
        const tree = await buildDiffTree({
          stackName: 'S',
          displayName: 'S',
          region: 'us-east-1',
          template: tpl,
          nestedTemplates: { Child: childPath },
          recursive: true,
          stateBackend: {
            getState: async (name: string) =>
              states[name] ? { state: states[name], etag: 'e' } : null,
          } as unknown as S3StateBackend,
          diffCalculator: new DiffCalculator(),
          isNestedChild: false,
        });
        const lines = debugLines.join('\n').split('\n');
        const refLines = lines.filter((l) => l.includes('Ref to resource: Queue resolved to'));
        // Premise: the parent pass AND the child-parameter pass both printed it.
        expect(refLines.length).toBeGreaterThanOrEqual(2);
        // The child's own lines over the value it received.
        const childLines = lines.filter(
          (l) =>
            l.includes('Parameter QueueUrl: using user-provided value') ||
            l.includes('Resolved Ref to parameter: QueueUrl')
        );
        // Premise: both child lines printed.
        expect(childLines.some((l) => l.startsWith('Parameter QueueUrl'))).toBe(true);
        expect(childLines.some((l) => l.includes('Resolved Ref to parameter'))).toBe(true);
        for (const line of [...refLines, ...childLines]) {
          expect(line.includes('sdin-diff-secret-queue')).toBe(shown);
        }
        // The child's rendered row.
        const childNode = tree.children.find((c) => c.stackName === 'S~Child');
        const row = JSON.stringify(childNode?.changes.get('Reader')?.propertyChanges);
        // Premise: the row is rendered.
        expect(row).toContain('"path":"Value"');
        expect(row.includes('sdin-diff-secret-queue')).toBe(shown);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['a secret-named target', '{{resolve:secretsmanager:sdin:SecretString:queue::}}', false],
    ['negative control, an ordinary name', 'plain-queue-name', true],
  ])(
    "masks a name a parent row USED to pass, in a live child's stored value: %s",
    async (_l, queueName, shown) => {
      // The row now passes a literal, so nothing this walk resolves reads the
      // queue for the child; only the parent's state says the child's stored
      // value is the secret-named queue's URL.
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-3869-'));
      try {
        const childPath = join(dir, 'child.json');
        writeFileSync(
          childPath,
          JSON.stringify({
            Parameters: { QueueUrl: { Type: 'String' } },
            Resources: {
              Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'QueueUrl' } } },
            },
          })
        );
        const parent = state(queueName);
        parent.resources['Child'] = {
          physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/S-Child/1',
          resourceType: 'AWS::CloudFormation::Stack',
          properties: { Parameters: { QueueUrl: URL } },
          attributes: {},
          dependencies: ['Queue'],
        };
        const tpl = template(queueName);
        // Nothing else reads the queue either, so the parent's own rows record
        // no needle of it.
        delete tpl.Resources['Policy'];
        delete parent.resources['Policy'];
        tpl.Resources['Child'] = {
          Type: 'AWS::CloudFormation::Stack',
          Metadata: { 'aws:asset:path': 'child.json' },
          Properties: { Parameters: { QueueUrl: 'https://example.invalid/plain' } },
        };
        const child: StackState = {
          stackName: 'S~Child',
          region: 'us-east-1',
          version: 9,
          resources: {
            Reader: {
              physicalId: 'reader-param',
              resourceType: 'AWS::SSM::Parameter',
              properties: { Value: URL },
              attributes: {},
              dependencies: [],
            },
          },
          outputs: {},
          lastModified: 0,
        };
        const states: Record<string, StackState> = { S: parent, 'S~Child': child };
        const tree = await buildDiffTree({
          stackName: 'S',
          displayName: 'S',
          region: 'us-east-1',
          template: tpl,
          nestedTemplates: { Child: childPath },
          recursive: true,
          stateBackend: {
            getState: async (name: string) =>
              states[name] ? { state: states[name], etag: 'e' } : null,
          } as unknown as S3StateBackend,
          diffCalculator: new DiffCalculator(),
          isNestedChild: false,
        });
        const childNode = tree.children.find((c) => c.stackName === 'S~Child');
        const row = JSON.stringify(childNode?.changes.get('Reader')?.propertyChanges);
        // Premise: the row is rendered, its new side in the clear.
        expect(row).toContain('"path":"Value"');
        expect(row).toContain('https://example.invalid/plain');
        expect(row.includes('sdin-diff-secret-queue')).toBe(shown);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['the parent NoEcho values judge it', true],
    ['negative control, a non-NoEcho parameter', false],
  ])(
    "masks a parent's NoEcho-named record in a live child's stored value: %s",
    async (_l, noEcho) => {
      // A pre-v11 parent record stores the NoEcho value itself, and RDS
      // lower-cases the identifier the child's row used to receive.
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-3869-'));
      try {
        const childPath = join(dir, 'child.json');
        writeFileSync(
          childPath,
          JSON.stringify({
            Parameters: { DbId: { Type: 'String' } },
            Resources: {
              Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'DbId' } } },
            },
          })
        );
        const tpl: CloudFormationTemplate = {
          Parameters: {
            DbName: { Type: 'String', Default: 'TeamSecretDb', ...(noEcho && { NoEcho: true }) },
          },
          Resources: {
            Db: {
              Type: 'AWS::RDS::DBInstance',
              Properties: { DBInstanceIdentifier: { Ref: 'DbName' } },
            },
            Child: {
              Type: 'AWS::CloudFormation::Stack',
              Metadata: { 'aws:asset:path': 'child.json' },
              Properties: { Parameters: { DbId: 'plain-db-id' } },
            },
          },
        };
        const parent: StackState = {
          stackName: 'S',
          region: 'us-east-1',
          version: 9,
          resources: {
            Db: {
              physicalId: 'teamsecretdb',
              resourceType: 'AWS::RDS::DBInstance',
              properties: { DBInstanceIdentifier: 'TeamSecretDb' },
              attributes: {},
              dependencies: [],
            },
            Child: {
              physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/S-Child/1',
              resourceType: 'AWS::CloudFormation::Stack',
              properties: { Parameters: { DbId: 'teamsecretdb' } },
              attributes: {},
              dependencies: ['Db'],
            },
          },
          outputs: {},
          exportNames: [],
          lastModified: 0,
        };
        const child: StackState = {
          stackName: 'S~Child',
          region: 'us-east-1',
          version: 9,
          resources: {
            Reader: {
              physicalId: 'reader-param',
              resourceType: 'AWS::SSM::Parameter',
              properties: { Value: 'teamsecretdb' },
              attributes: {},
              dependencies: [],
            },
          },
          outputs: {},
          lastModified: 0,
        };
        const states: Record<string, StackState> = { S: parent, 'S~Child': child };
        const tree = await buildDiffTree({
          stackName: 'S',
          displayName: 'S',
          region: 'us-east-1',
          template: tpl,
          nestedTemplates: { Child: childPath },
          recursive: true,
          stateBackend: {
            getState: async (name: string) =>
              states[name] ? { state: states[name], etag: 'e' } : null,
          } as unknown as S3StateBackend,
          diffCalculator: new DiffCalculator(),
          isNestedChild: false,
        });
        const childNode = tree.children.find((c) => c.stackName === 'S~Child');
        const row = JSON.stringify(childNode?.changes.get('Reader')?.propertyChanges);
        // Premise: the child's row is rendered, its new side in the clear.
        expect(row).toContain('plain-db-id');
        expect(row.includes('teamsecretdb')).toBe(!noEcho);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  describe("a DELETED child's stored values, masked with the parent's secret-named records", () => {
    // The parent no longer declares the child, so its stored outputs render
    // as REMOVE rows with their old values; only the parent's records can say
    // what those hold.
    async function deletedChildRow(
      parentResources: StackState['resources'],
      readerValue: string,
      parameters?: CloudFormationTemplate['Parameters'],
      childResources: StackState['resources'] = {}
    ): Promise<string> {
      const parent: StackState = {
        stackName: 'S',
        region: 'us-east-1',
        version: 9,
        resources: {
          ...parentResources,
          Child: {
            physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/S-Child/1',
            resourceType: 'AWS::CloudFormation::Stack',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        exportNames: [],
        lastModified: 0,
      };
      const child: StackState = {
        stackName: 'S~Child',
        region: 'us-east-1',
        version: 9,
        resources: childResources,
        outputs: { Out: readerValue },
        lastModified: 0,
      };
      const tpl: CloudFormationTemplate = {
        ...(parameters && { Parameters: parameters }),
        Resources: Object.fromEntries(
          Object.entries(parentResources).map(([id, r]) => [
            id,
            { Type: r.resourceType, Properties: r.properties as Record<string, unknown> },
          ])
        ),
      };
      const states: Record<string, StackState> = { S: parent, 'S~Child': child };
      const tree = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: tpl,
        nestedTemplates: {},
        recursive: true,
        stateBackend: {
          getState: async (name: string) =>
            states[name] ? { state: states[name], etag: 'e' } : null,
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      const childNode = tree.children.find((c) => c.stackName === 'S~Child');
      return JSON.stringify(childNode?.outputChanges.find((c) => c.name === 'Out'));
    }

    it.each([
      ['the parent NoEcho values judge it', true],
      ['negative control, a non-NoEcho parameter', false],
    ])("masks a parent's NoEcho-named record: %s", async (_l, noEcho) => {
      const row = await deletedChildRow(
        {
          Db: {
            physicalId: 'teamsecretdb',
            resourceType: 'AWS::RDS::DBInstance',
            properties: { DBInstanceIdentifier: 'TeamSecretDb' },
            attributes: {},
            dependencies: [],
          },
        },
        'teamsecretdb',
        { DbName: { Type: 'String', Default: 'TeamSecretDb', ...(noEcho && { NoEcho: true }) } }
      );
      // Premise: the deleted child's row is rendered.
      expect(row).toContain('"changeType":"REMOVE"');
      expect(row.includes('teamsecretdb')).toBe(!noEcho);
    });

    it("judges the deleted child's OWN composite-id record the same way", async () => {
      // The secret-named record lives in the deleted child itself.
      const row = await deletedChildRow(
        {},
        'arn:aws:logs:us-east-1:123:log-group:plain-log-group:* sdin-secret-filter',
        undefined,
        {
          SecretFilter: {
            physicalId: 'plain-log-group|sdin-secret-filter',
            resourceType: 'AWS::Logs::MetricFilter',
            properties: { FilterName: '***', LogGroupName: 'plain-log-group' },
            attributes: {},
            dependencies: [],
          },
        }
      );
      expect(row).toContain('"changeType":"REMOVE"');
      expect(row).toContain('log-group:plain-log-group:*');
      expect(row).not.toContain('sdin-secret-filter');
    });

    it("shows a public segment of a secret-named composite id, and masks the secret one", async () => {
      // Named from a NoEcho value, which state stores as the mask (a
      // `{{resolve:` reference would withhold every value of a deleted child).
      const parentResources: StackState['resources'] = {
        SecretFilter: {
          physicalId: 'plain-log-group|sdin-secret-filter',
          resourceType: 'AWS::Logs::MetricFilter',
          properties: {
            FilterName: '***',
            LogGroupName: 'plain-log-group',
          },
          attributes: {},
          dependencies: [],
        },
      };
      const row = await deletedChildRow(
        parentResources,
        'arn:aws:logs:us-east-1:123:log-group:plain-log-group:* sdin-secret-filter'
      );
      expect(row).toContain('"changeType":"REMOVE"');
      expect(row).toContain('log-group:plain-log-group:*');
      expect(row).not.toContain('sdin-secret-filter');
    });
  });

  it("never judges a parent record named like a NoEcho value's Fn::Split fragment, for a child", async () => {
    // The parent's walk records the fragment `AlphaQ` of the NoEcho value
    // `AlphaQ-beta` (the Split reader). Judged by it, the ordinary queue named
    // `AlphaQ` would hand its lower-cased spelling to the child and mask the
    // child's ordinary stored copy of it.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3869-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Resources: {
            Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'no-longer-the-queue' } },
          },
        })
      );
      const tpl: CloudFormationTemplate = {
        Parameters: { Tok: { Type: 'String', NoEcho: true, Default: 'AlphaQ-beta' } },
        Resources: {
          Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'AlphaQ' } },
          Split: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { 'Fn::Select': [0, { 'Fn::Split': ['-', { Ref: 'Tok' }] }] } },
          },
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: {},
          },
        },
      };
      const parent: StackState = {
        stackName: 'S',
        region: 'us-east-1',
        version: 11,
        resources: {
          Queue: {
            physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/AlphaQ',
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: 'AlphaQ' },
            attributes: {},
            dependencies: [],
          },
          Split: {
            physicalId: 'split',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Value: 'older' },
            attributes: {},
            dependencies: [],
          },
          Child: {
            physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/S-Child/1',
            resourceType: 'AWS::CloudFormation::Stack',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        exportNames: [],
        lastModified: 0,
      };
      const child: StackState = {
        stackName: 'S~Child',
        region: 'us-east-1',
        version: 11,
        resources: {
          Reader: {
            physicalId: 'reader-param',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Value: 'alphaq-lowercased-copy' },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        lastModified: 0,
      };
      const states: Record<string, StackState> = { S: parent, 'S~Child': child };
      const tree = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: tpl,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: {
          getState: async (name: string) =>
            states[name] ? { state: states[name], etag: 'e' } : null,
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      // Premise: the parent's walk read the fragment (its Split row masks it).
      const splitRow = JSON.stringify(tree.changes.get('Split')?.propertyChanges);
      expect(splitRow).toContain('"path":"Value"');
      expect(splitRow).not.toContain('AlphaQ');
      const childNode = tree.children.find((c) => c.stackName === 'S~Child');
      const row = JSON.stringify(childNode?.changes.get('Reader')?.propertyChanges);
      // Premise: the child's row is rendered.
      expect(row).toContain('no-longer-the-queue');
      expect(row).toContain('alphaq-lowercased-copy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the inherited derived names out of the corpus a grandchild inherits", async () => {
    // Mask-only, as on the deploy path: `printingSecrets` is a grandchild's
    // `inheritedSecrets`, whose needles its export-alias preview reads.
    const inheritedDerivedNames = new Map<string, string>();
    recordLogOnlyValue(inheritedDerivedNames, 'sdin-diff-secret-queue');
    const tpl: CloudFormationTemplate = {
      Parameters: { QueueUrl: { Type: 'String' } },
      Resources: {
        Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'QueueUrl' } } },
      },
    };
    const result = await computeStackDiff(
      {
        stackName: 'S~Child',
        region: 'us-east-1',
        version: 9,
        resources: {
          Reader: {
            physicalId: 'reader-param',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Value: 'older' },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        lastModified: 0,
      },
      tpl,
      'us-east-1',
      'S~Child',
      backend,
      new DiffCalculator(),
      { parameters: { QueueUrl: URL }, inheritedDerivedNames }
    );
    // The row is masked with it. Premise: the row is rendered.
    const row = JSON.stringify(result.changes.get('Reader')?.propertyChanges);
    expect(row).toContain('"path":"Value"');
    expect(row).not.toContain('sdin-diff-secret-queue');
    expect(hasMaskableValues(result.printingSecrets)).toBe(false);
  });

  describe('below the child: a grandchild the value is passed on to', () => {
    const SECRET_NAME = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
    const empty = (stackName: string, resources: StackState['resources'] = {}): StackState => ({
      stackName,
      region: 'us-east-1',
      version: 9,
      resources,
      outputs: {},
      lastModified: 0,
    });
    const nestedRow = (path: string, parameters: Record<string, unknown>) => ({
      Type: 'AWS::CloudFormation::Stack',
      Metadata: { 'aws:asset:path': path },
      Properties: { Parameters: parameters },
    });
    const stackRecord = (id: string, parameters: Record<string, unknown>) => ({
      physicalId: `arn:aws:cloudformation:us-east-1:123456789012:stack/${id}/1`,
      resourceType: 'AWS::CloudFormation::Stack',
      properties: { Parameters: parameters },
      attributes: {},
      dependencies: [],
    });

    /**
     * Parent -> Child (fed `Ref Queue`) -> GC (fed the child's `Ref QueueUrl`,
     * a parameter, so the child row reads no secret-named resource itself).
     * `liveGc: false` drops GC from the child's template: its stored output
     * then diffs as a REMOVE.
     */
    async function diffThreeLevels(
      recordedQueueName: string,
      templateQueueName: string,
      liveGc: boolean
    ) {
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-3869-gc-'));
      try {
        const gcPath = join(dir, 'gc.json');
        const childPath = join(dir, 'child.json');
        writeFileSync(
          gcPath,
          JSON.stringify({
            Parameters: { QueueUrl: { Type: 'String' } },
            Resources: {
              Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'QueueUrl' } } },
            },
          })
        );
        writeFileSync(
          childPath,
          JSON.stringify({
            Parameters: { QueueUrl: { Type: 'String' } },
            Resources: liveGc ? { GC: nestedRow('gc.json', { QueueUrl: { Ref: 'QueueUrl' } }) } : {},
          })
        );
        const parent = state(recordedQueueName);
        parent.resources['Child'] = { ...stackRecord('S-Child', { QueueUrl: URL }), dependencies: ['Queue'] };
        const tpl = template(templateQueueName);
        tpl.Resources['Child'] = nestedRow('child.json', { QueueUrl: { Ref: 'Queue' } });
        const gc = empty('S~Child~GC', {
          Reader: {
            physicalId: 'reader-param',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Value: 'older' },
            attributes: {},
            dependencies: [],
          },
        });
        gc.outputs = { GOut: URL };
        const states: Record<string, StackState> = {
          S: parent,
          'S~Child': empty('S~Child', { GC: stackRecord('S-Child-GC', { QueueUrl: URL }) }),
          'S~Child~GC': gc,
        };
        const tree = await buildDiffTree({
          stackName: 'S',
          displayName: 'S',
          region: 'us-east-1',
          template: tpl,
          nestedTemplates: { Child: childPath },
          recursive: true,
          stateBackend: {
            getState: async (name: string) =>
              states[name] ? { state: states[name], etag: 'e' } : null,
          } as unknown as S3StateBackend,
          diffCalculator: new DiffCalculator(),
          isNestedChild: false,
        });
        const child = tree.children.find((c) => c.stackName === 'S~Child');
        return child?.children.find((c) => c.stackName === 'S~Child~GC');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it.each([
      ['a secret-named target', SECRET_NAME, false],
      ['negative control, an ordinary name', 'plain-queue-name', true],
    ])("masks a live grandchild's rows: %s", async (_l, name, shown) => {
      const gc = await diffThreeLevels(name, name, true);
      const row = JSON.stringify(gc?.changes.get('Reader')?.propertyChanges);
      // Premise: the row is rendered.
      expect(row).toContain('"path":"Value"');
      expect(row.includes('sdin-diff-secret-queue')).toBe(shown);
    });

    it.each([
      ['a secret-named target', SECRET_NAME, false],
      ['negative control, an ordinary name', 'plain-queue-name', true],
    ])("masks a deleted grandchild's stored output: %s", async (_l, recorded, shown) => {
      // The template now names the queue literally, so no template above is
      // secret-bearing and the REMOVE row keeps its old value: only the
      // derived name the record still spells as a reference can mask it.
      const gc = await diffThreeLevels(recorded, 'plain-queue-name', false);
      const out = JSON.stringify(gc?.outputChanges.find((c) => c.name === 'GOut'));
      // Premise: the REMOVE row carries its old value (masked or not).
      expect(out).toContain('"changeType":"REMOVE"');
      expect(out).toContain('"oldValue"');
      expect(out.includes('sdin-diff-secret-queue')).toBe(shown);
    });

    it.each([
      ['a secret-named target', SECRET_NAME, false],
      ['negative control, an ordinary name', 'plain-queue-name', true],
    ])("masks a deleted child's stored output with the root's own reads: %s", async (_l, recorded, shown) => {
      // The root's Policy reads the queue; the child row is gone from the
      // template, so only the root's own derived names can mask its output.
      const parent = state(recorded);
      parent.resources['Child'] = { ...stackRecord('S-Child', { QueueUrl: URL }), dependencies: ['Queue'] };
      // And a deleted stack below it: the names pass from deleted to deleted.
      const child = empty('S~Child', { GC: stackRecord('S-Child-GC', { QueueUrl: URL }) });
      child.outputs = { COut: URL };
      const gc = empty('S~Child~GC');
      gc.outputs = { GOut: URL };
      const states: Record<string, StackState> = { S: parent, 'S~Child': child, 'S~Child~GC': gc };
      const tree = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: template('plain-queue-name'),
        nestedTemplates: {},
        recursive: true,
        stateBackend: {
          getState: async (name: string) =>
            states[name] ? { state: states[name], etag: 'e' } : null,
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      const node = tree.children.find((c) => c.stackName === 'S~Child');
      const deletedGc = node?.children.find((c) => c.stackName === 'S~Child~GC');
      for (const out of [
        JSON.stringify(node?.outputChanges.find((c) => c.name === 'COut')),
        JSON.stringify(deletedGc?.outputChanges.find((c) => c.name === 'GOut')),
      ]) {
        expect(out).toContain('"changeType":"REMOVE"');
        expect(out).toContain('"oldValue"');
        expect(out.includes('sdin-diff-secret-queue')).toBe(shown);
      }
    });

    it.each([
      ['a secret-named record', SECRET_NAME, false],
      ['negative control, an ordinary name', 'plain-queue-name', true],
    ])("masks a deleted child's stored output when no live row reads the record: %s", async (_l, recorded, shown) => {
      // The removed row was the ONLY reader: the root template keeps the queue
      // under a literal name and nothing reads it, so the root's own reads hold
      // no needle; only its state record still spells the name from a secret.
      const parent = state(recorded);
      delete parent.resources['Policy'];
      parent.resources['Child'] = { ...stackRecord('S-Child', { QueueUrl: URL }), dependencies: ['Queue'] };
      const child = empty('S~Child');
      child.outputs = { COut: URL };
      const states: Record<string, StackState> = { S: parent, 'S~Child': child };
      const tree = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: {
          Resources: { Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'plain-queue-name' } } },
        },
        nestedTemplates: {},
        recursive: true,
        stateBackend: {
          getState: async (name: string) =>
            states[name] ? { state: states[name], etag: 'e' } : null,
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      const node = tree.children.find((c) => c.stackName === 'S~Child');
      const out = JSON.stringify(node?.outputChanges.find((c) => c.name === 'COut'));
      expect(out).toContain('"changeType":"REMOVE"');
      expect(out).toContain('"oldValue"');
      expect(out.includes('sdin-diff-secret-queue')).toBe(shown);
    });

    it("never hands the row's reads to the child as inheritedSecrets: its export alias still previews", async () => {
      // A child export NAMED from the parent-passed URL. An inherited needle
      // there would seed the child's NoEcho export-name verdict, which then
      // withholds the alias the deploy publishes: the derived names are
      // mask-only, so the alias row stays (its name display masked).
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-3869-alias-'));
      try {
        const childPath = join(dir, 'child.json');
        writeFileSync(
          childPath,
          JSON.stringify({
            Parameters: { QueueUrl: { Type: 'String' } },
            Resources: { Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
            Outputs: {
              QName: {
                Value: 'v',
                Export: { Name: { 'Fn::Select': [4, { 'Fn::Split': ['/', { Ref: 'QueueUrl' }] }] } },
              },
            },
          })
        );
        const parent = state(SECRET_NAME);
        parent.resources['Child'] = { ...stackRecord('S-Child', { QueueUrl: URL }), dependencies: ['Queue'] };
        const tpl = template(SECRET_NAME);
        tpl.Resources['Child'] = nestedRow('child.json', { QueueUrl: { Ref: 'Queue' } });
        const states: Record<string, StackState> = {
          S: parent,
          'S~Child': empty('S~Child', {
            Reader: {
              physicalId: 'reader-param',
              resourceType: 'AWS::SSM::Parameter',
              properties: { Value: 'x' },
              attributes: {},
              dependencies: [],
            },
          }),
        };
        const tree = await buildDiffTree({
          stackName: 'S',
          displayName: 'S',
          region: 'us-east-1',
          template: tpl,
          nestedTemplates: { Child: childPath },
          recursive: true,
          stateBackend: {
            getState: async (name: string) =>
              states[name] ? { state: states[name], etag: 'e' } : null,
          } as unknown as S3StateBackend,
          diffCalculator: new DiffCalculator(),
          isNestedChild: false,
        });
        const child = tree.children.find((c) => c.stackName === 'S~Child');
        // Premise: the output itself previews.
        expect(child?.outputChanges.some((c) => c.name === 'QName')).toBe(true);
        const alias = child?.outputChanges.find((c) => c.isExport === true);
        expect(alias?.changeType).toBe('ADD');
        expect(JSON.stringify(alias?.nameDisplay)).not.toContain('sdin-diff-secret-queue');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      ['a secret-named record', SECRET_NAME, false],
      ['negative control, an ordinary name', 'plain-queue-name', true],
    ])("masks a deleted grandchild's output with its deleted parent's own records: %s", async (_l, recorded, shown) => {
      // The secret-named queue lives in the DELETED child's state, never in
      // the root's: only the deleted child's own records can name it.
      const parent = state('plain-root-queue');
      parent.resources['Child'] = stackRecord('S-Child', {});
      const child = empty('S~Child', {
        Queue: {
          physicalId: URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: recorded },
          attributes: {},
          dependencies: [],
        },
        GC: stackRecord('S-Child-GC', { QueueUrl: URL }),
      });
      // And the deleted child's OWN output: masked by its own records.
      child.outputs = { COut: URL };
      const gc = empty('S~Child~GC');
      gc.outputs = { GOut: URL };
      const states: Record<string, StackState> = { S: parent, 'S~Child': child, 'S~Child~GC': gc };
      const tree = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: template('plain-root-queue'),
        nestedTemplates: {},
        recursive: true,
        stateBackend: {
          getState: async (name: string) =>
            states[name] ? { state: states[name], etag: 'e' } : null,
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      const deletedChild = tree.children.find((c) => c.stackName === 'S~Child');
      const deletedGc = deletedChild?.children.find((c) => c.stackName === 'S~Child~GC');
      for (const out of [
        JSON.stringify(deletedChild?.outputChanges.find((c) => c.name === 'COut')),
        JSON.stringify(deletedGc?.outputChanges.find((c) => c.name === 'GOut')),
      ]) {
        expect(out).toContain('"changeType":"REMOVE"');
        expect(out).toContain('"oldValue"');
        expect(out.includes('sdin-diff-secret-queue')).toBe(shown);
      }
    });
  });

  describe('a name only the OLD state value holds (the replacement line)', () => {
    // An access key moves from a user named from a secret to an ordinary one.
    // `UserName` is create-only, so the row is a replacement whose OLD side is
    // the record's resolved copy of the secret user's name. Nothing in the
    // template reads that user any more, so no resolution records its name.
    const SECRET_USER = 'sdin-diff-secret-user';
    const PLAIN_USER = 'S-PlainUser-ABC123';
    const userTemplate = (userName: string): CloudFormationTemplate => ({
      Resources: {
        SecretUser: { Type: 'AWS::IAM::User', Properties: { UserName: userName } },
        PlainUser: { Type: 'AWS::IAM::User', Properties: {} },
        Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: { Ref: 'PlainUser' } } },
      },
    });
    const userState = (userName: string): StackState => ({
      stackName: 'S',
      region: 'us-east-1',
      version: 9,
      resources: {
        SecretUser: {
          physicalId: SECRET_USER,
          resourceType: 'AWS::IAM::User',
          properties: { UserName: userName },
          attributes: {},
          dependencies: [],
        },
        PlainUser: {
          physicalId: PLAIN_USER,
          resourceType: 'AWS::IAM::User',
          properties: {},
          attributes: {},
          dependencies: [],
        },
        Key: {
          physicalId: 'sdin-access-key-id-1',
          resourceType: 'AWS::IAM::AccessKey',
          properties: { UserName: SECRET_USER },
          attributes: {},
          dependencies: ['SecretUser'],
        },
      },
      outputs: {},
      exportNames: [],
      lastModified: 0,
    });

    it.each([
      ['a secret-named user', '{{resolve:secretsmanager:sdin:SecretString:user::}}', false],
      ['negative control, an ordinary name', SECRET_USER, true],
    ])('masks it on the replacement line and the row: %s', async (_l, userName, shown) => {
      debugLines.length = 0;
      const result = await computeStackDiff(
        userState(userName),
        userTemplate(userName),
        'us-east-1',
        'S',
        backend,
        new DiffCalculator()
      );
      const replacement = debugLines.filter((l) => l.includes('requires replacement (from')).join('\n');
      // Premise: the replacement line printed, its new side in the clear.
      expect(replacement).toContain('Property UserName of AWS::IAM::AccessKey');
      expect(replacement).toContain(PLAIN_USER);
      expect(replacement.includes(SECRET_USER)).toBe(shown);
      const row = JSON.stringify(result.changes.get('Key')?.propertyChanges);
      expect(row).toContain('"path":"UserName"');
      expect(row).toContain(PLAIN_USER);
      expect(row.includes(SECRET_USER)).toBe(shown);
    });

    it.each([
      ['the stack-wide NoEcho values judge it', true],
      ['negative control, a non-NoEcho parameter', false],
    ])('judges a record holding a NoEcho value in plaintext: %s', async (_l, noEcho) => {
      // A pre-v11 record stores the NoEcho value itself, and RDS lower-cases
      // the identifier: the reader's stored copy is no substring of the value
      // the diff masks, and nothing reads the instance any more.
      const tpl: CloudFormationTemplate = {
        Parameters: {
          DbName: { Type: 'String', Default: 'TeamSecretDb', ...(noEcho && { NoEcho: true }) },
        },
        Resources: {
          Db: {
            Type: 'AWS::RDS::DBInstance',
            Properties: { DBInstanceIdentifier: { Ref: 'DbName' } },
          },
          Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'no-longer-the-db' } },
        },
      };
      const s: StackState = {
        stackName: 'S',
        region: 'us-east-1',
        version: 9,
        resources: {
          Db: {
            physicalId: 'teamsecretdb',
            resourceType: 'AWS::RDS::DBInstance',
            properties: { DBInstanceIdentifier: 'TeamSecretDb' },
            attributes: {},
            dependencies: [],
          },
          Reader: {
            physicalId: 'reader',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Value: 'teamsecretdb' },
            attributes: {},
            dependencies: ['Db'],
          },
        },
        outputs: {},
        exportNames: [],
        lastModified: 0,
      };
      const result = await computeStackDiff(s, tpl, 'us-east-1', 'S', backend, new DiffCalculator());
      const row = JSON.stringify(result.changes.get('Reader')?.propertyChanges);
      // Premise: the row is rendered, its new side in the clear.
      expect(row).toContain('no-longer-the-db');
      expect(row.includes('teamsecretdb')).toBe(!noEcho);
    });

    it.each([
      ['a secret-named user', '{{resolve:secretsmanager:sdin:SecretString:user::}}', false],
      ['negative control, an ordinary name', SECRET_USER, true],
    ])("masks an OUTPUT's stored old value no record holds: %s", async (_l, userName, shown) => {
      // The output moves off the secret-named user; only the stored outputs
      // bag still spells its name (the key already reads the ordinary user).
      const s = userState(userName);
      (s.resources['Key']!.properties as Record<string, unknown>)['UserName'] = PLAIN_USER;
      s.outputs = { UserOut: SECRET_USER };
      const tpl = userTemplate(userName);
      tpl.Outputs = { UserOut: { Value: { Ref: 'PlainUser' } } };
      const result = await computeStackDiff(s, tpl, 'us-east-1', 'S', backend, new DiffCalculator());
      const out = JSON.stringify(result.outputChanges.find((c) => c.name === 'UserOut'));
      // Premise: the output row is rendered, its new side in the clear.
      expect(out).toContain(PLAIN_USER);
      expect(out.includes(SECRET_USER)).toBe(shown);
    });

    it("never judges a record by a NoEcho value's Fn::Split piece", async () => {
      // An ordinary queue named `AlphaQ`, and a NoEcho value `AlphaQ-beta`
      // split on `-`: the piece is masked where it prints, as written, but it
      // is no evidence the queue's name came from the value. Judged by it,
      // the queue's lower-cased spelling would become a needle and mask a
      // copy another record stores.
      const tpl: CloudFormationTemplate = {
        Parameters: { Tok: { Type: 'String', NoEcho: true, Default: 'AlphaQ-beta' } },
        Resources: {
          Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'AlphaQ' } },
          Split: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { 'Fn::Select': [1, { 'Fn::Split': ['-', { Ref: 'Tok' }] }] } },
          },
          Reader: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'no-longer-the-queue' } },
        },
      };
      const s: StackState = {
        stackName: 'S',
        region: 'us-east-1',
        version: 11,
        resources: {
          Queue: {
            physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/AlphaQ',
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: 'AlphaQ' },
            attributes: {},
            dependencies: [],
          },
          Split: {
            physicalId: 'split',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Value: '***' },
            attributes: {},
            dependencies: [],
          },
          Reader: {
            physicalId: 'reader',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Value: 'alphaq-lowercased-copy' },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        exportNames: [],
        lastModified: 0,
      };
      const result = await computeStackDiff(s, tpl, 'us-east-1', 'S', backend, new DiffCalculator(), {
        parameters: { Tok: 'AlphaQ-beta' },
      });
      const row = JSON.stringify(result.changes.get('Reader')?.propertyChanges);
      // Premise: the row is rendered.
      expect(row).toContain('no-longer-the-queue');
      expect(row).toContain('alphaq-lowercased-copy');
    });

    it.each([
      ['a secret-named user', '{{resolve:secretsmanager:sdin:SecretString:user::}}', false],
      ['negative control, an ordinary name', SECRET_USER, true],
    ])('judges a record the orphan adoption splices in too: %s', async (_l, userName, shown) => {
      // The secret-named user is a rollback orphan this deploy re-adopts, so
      // only the adoption's record says the key's stored value is its name.
      const s = userState(userName);
      const adopted = s.resources['SecretUser']!;
      delete s.resources['SecretUser'];
      s.orphans = [{ logicalId: 'SecretUser', orphanedAt: 1, state: adopted }];
      debugLines.length = 0;
      const result = await computeStackDiff(
        s,
        userTemplate(userName),
        'us-east-1',
        'S',
        backend,
        new DiffCalculator(),
        {
          previewOrphanAdoption: async () => ({ adopted: { SecretUser: adopted }, refusals: [] }),
        }
      );
      // Premise: the record was adopted, so its row is no CREATE.
      expect(result.adoptedOrphans).toEqual(['SecretUser']);
      const replacement = debugLines.filter((l) => l.includes('requires replacement (from')).join('\n');
      expect(replacement).toContain('Property UserName of AWS::IAM::AccessKey');
      expect(replacement.includes(SECRET_USER)).toBe(shown);
      const row = JSON.stringify(result.changes.get('Key')?.propertyChanges);
      expect(row).toContain(PLAIN_USER);
      expect(row.includes(SECRET_USER)).toBe(shown);
    });
  });
});
