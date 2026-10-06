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

const debugLines: string[] = [];
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: (...args: unknown[]) => void debugLines.push(args.map(String).join(' ')),
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
import { hasMaskableValues } from '../../../src/deployment/secret-redaction.js';
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
    expect(lines).toContain('Queue.Arn resolved to');
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

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await diffLines('plain-queue-name');
    expect(lines).toContain('sdin-diff-secret-queue');
  });

  it("masks a parent row's Ref passed to a nested child, on the child-parameter resolution too", async () => {
    // The parent row's `Parameters` resolve twice: in the parent's own diff,
    // and again to bind the child's inputs (`resolveChildStackParameters`).
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3869-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({ Parameters: { QueueUrl: { Type: 'String' } }, Resources: {} })
      );
      const parent = state('{{resolve:secretsmanager:sdin:SecretString:queue::}}');
      parent.resources['Child'] = {
        physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/S-Child/1',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: { Parameters: { QueueUrl: URL } },
        attributes: {},
        dependencies: ['Queue'],
      };
      const tpl = template('{{resolve:secretsmanager:sdin:SecretString:queue::}}');
      tpl.Resources['Child'] = {
        Type: 'AWS::CloudFormation::Stack',
        Metadata: { 'aws:asset:path': 'child.json' },
        Properties: { Parameters: { QueueUrl: { Ref: 'Queue' } } },
      };
      const child: StackState = {
        stackName: 'S~Child',
        region: 'us-east-1',
        version: 9,
        resources: {},
        outputs: {},
        lastModified: 0,
      };
      const states: Record<string, StackState> = { S: parent, 'S~Child': child };
      debugLines.length = 0;
      await buildDiffTree({
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
      const lines = debugLines.join('\n');
      const refLines = lines.split('\n').filter((l) => l.includes('Ref to resource: Queue resolved to'));
      // Premise: the parent pass AND the child-parameter pass both printed it.
      expect(refLines.length).toBeGreaterThanOrEqual(2);
      for (const line of refLines) expect(line).not.toContain('sdin-diff-secret-queue');
      // The CHILD's own lines over the value it received still print it: the
      // nested-child item, which stays open on go-to-k/cdkd#3869.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
