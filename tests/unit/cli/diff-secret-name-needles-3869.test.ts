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
      { stackName: 'S~Child', region: 'us-east-1', version: 9, resources: {}, outputs: {}, lastModified: 0 },
      tpl,
      'us-east-1',
      'S~Child',
      backend,
      new DiffCalculator(),
      { parameters: { QueueUrl: URL }, inheritedDerivedNames }
    );
    // Premise: the row is masked with it.
    expect(JSON.stringify(result.changes.get('Reader'))).not.toContain('sdin-diff-secret-queue');
    expect(hasMaskableValues(result.printingSecrets)).toBe(false);
  });
});
