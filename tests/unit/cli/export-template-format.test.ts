/**
 * Unit tests for the YAML template-format plumbing through the export
 * command: `templateFormat: 'yaml'` MUST propagate from the user-supplied
 * template through `executeImportChangeSet` / `executeUpdateChangeSet`
 * all the way to `CreateChangeSetCommand.TemplateBody` on the wire, and
 * `parseTemplateFile` MUST route YAML files through the CFn-aware codec.
 *
 * Mock pattern mirrors tests/unit/cli/retire-cfn-stack.test.ts — a
 * FakeCommand subclass per CFn op, captured in a per-test calls array.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
  }),
}));

const waitChangeSetCreate = vi.hoisted(() => vi.fn(async () => undefined));
const waitStackImport = vi.hoisted(() => vi.fn(async () => undefined));
const waitStackUpdate = vi.hoisted(() => vi.fn(async () => undefined));

const cfnCommands = vi.hoisted(() => {
  class FakeCommand {
    constructor(
      public readonly _name: string,
      public readonly input: Record<string, unknown>
    ) {}
  }
  return {
    CreateChangeSetCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('CreateChangeSet', input);
      }
    },
    ExecuteChangeSetCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('ExecuteChangeSet', input);
      }
    },
    DescribeChangeSetCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeChangeSet', input);
      }
    },
    DeleteChangeSetCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DeleteChangeSet', input);
      }
    },
    DescribeStackEventsCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeStackEvents', input);
      }
    },
  };
});

vi.mock('@aws-sdk/client-cloudformation', async () => {
  // Pass through every other CFn SDK export — the production code under
  // test imports a handful of utility types we don't care to re-mock.
  const real = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-cloudformation');
  return {
    ...real,
    CreateChangeSetCommand: cfnCommands.CreateChangeSetCommand,
    ExecuteChangeSetCommand: cfnCommands.ExecuteChangeSetCommand,
    DescribeChangeSetCommand: cfnCommands.DescribeChangeSetCommand,
    DeleteChangeSetCommand: cfnCommands.DeleteChangeSetCommand,
    DescribeStackEventsCommand: cfnCommands.DescribeStackEventsCommand,
    waitUntilChangeSetCreateComplete: waitChangeSetCreate,
    waitUntilStackImportComplete: waitStackImport,
    waitUntilStackUpdateComplete: waitStackUpdate,
  };
});

import {
  executeImportChangeSet,
  executeUpdateChangeSet,
  parseTemplateFile,
  type ImportPlanEntry,
} from '../../../src/cli/commands/export.js';

interface SendCall {
  name: string;
  input: Record<string, unknown>;
}

function buildCfnClient(): {
  client: { send: ReturnType<typeof vi.fn> };
  calls: SendCall[];
} {
  const calls: SendCall[] = [];
  const send = vi.fn(async (cmd: { _name: string; input: Record<string, unknown> }) => {
    calls.push({ name: cmd._name, input: cmd.input });
    return {};
  });
  return { client: { send }, calls };
}

describe('executeImportChangeSet — templateFormat plumbing', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    waitChangeSetCreate.mockReset();
    waitChangeSetCreate.mockResolvedValue(undefined);
    waitStackImport.mockReset();
    waitStackImport.mockResolvedValue(undefined);
  });

  const PLAN: ImportPlanEntry[] = [
    {
      logicalId: 'MyBucket',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'my-bucket-physical-id',
      resourceIdentifier: { BucketName: 'my-bucket-physical-id' },
    },
  ];

  const TEMPLATE: Record<string, unknown> = {
    Resources: {
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: { BucketName: 'my-bucket-physical-id' },
      },
    },
  };

  it('passes JSON TemplateBody to CreateChangeSet when templateFormat=json (default)', async () => {
    const { client, calls } = buildCfnClient();
    await executeImportChangeSet(
      client as never,
      'MyStack',
      TEMPLATE,
      PLAN,
      [],
      'json'
    );

    const create = calls.find((c) => c.name === 'CreateChangeSet')!;
    expect(create).toBeDefined();
    const body = String(create.input['TemplateBody']);
    // JSON output is brace-delimited two-space-indented.
    expect(body.trimStart().startsWith('{')).toBe(true);
    expect(body).toContain('"Resources"');
    expect(body).toContain('"Type": "AWS::S3::Bucket"');
    // Confirm the change-set type is IMPORT, not UPDATE.
    expect(create.input['ChangeSetType']).toBe('IMPORT');
  });

  it('passes YAML TemplateBody to CreateChangeSet when templateFormat=yaml', async () => {
    const { client, calls } = buildCfnClient();
    await executeImportChangeSet(
      client as never,
      'MyStack',
      TEMPLATE,
      PLAN,
      [],
      'yaml'
    );

    const create = calls.find((c) => c.name === 'CreateChangeSet')!;
    expect(create).toBeDefined();
    const body = String(create.input['TemplateBody']);
    // YAML output: no surrounding `{}` braces at the top, key:value lines.
    expect(body.trimStart().startsWith('{')).toBe(false);
    expect(body.trimStart().startsWith('[')).toBe(false);
    // The canonical YAML shape — key followed by colon and value.
    expect(body).toContain('Resources:');
    expect(body).toContain('Type: AWS::S3::Bucket');
    // No leftover JSON noise.
    expect(body).not.toContain('"Type":');
  });

  it('defaults to JSON when templateFormat argument is omitted (back-compat)', async () => {
    const { client, calls } = buildCfnClient();
    // Omit the trailing templateFormat argument entirely.
    await executeImportChangeSet(client as never, 'MyStack', TEMPLATE, PLAN, []);

    const create = calls.find((c) => c.name === 'CreateChangeSet')!;
    expect(create).toBeDefined();
    const body = String(create.input['TemplateBody']);
    expect(body.trimStart().startsWith('{')).toBe(true);
    expect(body).toContain('"Type": "AWS::S3::Bucket"');
  });
});

describe('executeUpdateChangeSet — templateFormat plumbing', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    waitChangeSetCreate.mockReset();
    waitChangeSetCreate.mockResolvedValue(undefined);
    waitStackUpdate.mockReset();
    waitStackUpdate.mockResolvedValue(undefined);
  });

  const TEMPLATE: Record<string, unknown> = {
    Resources: {
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: { BucketName: 'b' },
      },
      MyCR: {
        Type: 'Custom::Thing',
        Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:111111111111:function:f' },
      },
    },
  };

  it('passes JSON TemplateBody to CreateChangeSet when templateFormat=json (default)', async () => {
    const { client, calls } = buildCfnClient();
    await executeUpdateChangeSet(client as never, 'MyStack', TEMPLATE, [], 'json');

    const create = calls.find((c) => c.name === 'CreateChangeSet')!;
    expect(create).toBeDefined();
    const body = String(create.input['TemplateBody']);
    expect(body.trimStart().startsWith('{')).toBe(true);
    expect(body).toContain('"Type": "Custom::Thing"');
    // Confirm the change-set type is UPDATE, not IMPORT.
    expect(create.input['ChangeSetType']).toBe('UPDATE');
  });

  it('passes YAML TemplateBody to CreateChangeSet when templateFormat=yaml', async () => {
    const { client, calls } = buildCfnClient();
    await executeUpdateChangeSet(client as never, 'MyStack', TEMPLATE, [], 'yaml');

    const create = calls.find((c) => c.name === 'CreateChangeSet')!;
    expect(create).toBeDefined();
    const body = String(create.input['TemplateBody']);
    expect(body.trimStart().startsWith('{')).toBe(false);
    expect(body).toContain('Resources:');
    expect(body).toContain('Type: Custom::Thing');
    expect(body).not.toContain('"Type":');
  });

  it('defaults to JSON when templateFormat argument is omitted (back-compat)', async () => {
    const { client, calls } = buildCfnClient();
    await executeUpdateChangeSet(client as never, 'MyStack', TEMPLATE, []);

    const create = calls.find((c) => c.name === 'CreateChangeSet')!;
    expect(create).toBeDefined();
    const body = String(create.input['TemplateBody']);
    expect(body.trimStart().startsWith('{')).toBe(true);
    expect(body).toContain('"Type": "Custom::Thing"');
  });
});

describe('parseTemplateFile — JSON / YAML routing', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-yaml-cfn-test-'));
  });

  it('routes a .json file through the JSON parser', () => {
    const p = join(tmp, 'template.json');
    writeFileSync(p, '{"Resources":{"X":{"Type":"AWS::S3::Bucket"}}}');
    const { template, format } = parseTemplateFile(p);
    expect(format).toBe('json');
    expect(template).toEqual({ Resources: { X: { Type: 'AWS::S3::Bucket' } } });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('routes a .yaml file through the YAML parser and preserves CFn intrinsics', () => {
    const p = join(tmp, 'template.yaml');
    writeFileSync(
      p,
      'Resources:\n' +
        '  MyBucket:\n' +
        '    Type: AWS::S3::Bucket\n' +
        '    Properties:\n' +
        "      BucketName: !Sub '${AWS::StackName}-mybucket'\n"
    );
    const { template, format } = parseTemplateFile(p);
    expect(format).toBe('yaml');
    expect(template).toEqual({
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: { 'Fn::Sub': '${AWS::StackName}-mybucket' },
          },
        },
      },
    });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('routes a .yml file through the YAML parser', () => {
    const p = join(tmp, 'template.yml');
    writeFileSync(p, 'Resources:\n  X: !Ref Something\n');
    const { template, format } = parseTemplateFile(p);
    expect(format).toBe('yaml');
    expect(template).toEqual({ Resources: { X: { Ref: 'Something' } } });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('detects format by CONTENT, not just extension — YAML body in a .txt path still parses', () => {
    // The parser uses the codec's content-sniffing; the file extension
    // hint helper exists separately and is not consulted by
    // parseTemplateFile.
    const p = join(tmp, 'template.txt');
    writeFileSync(p, 'Resources:\n  X:\n    Type: AWS::S3::Bucket\n');
    const { template, format } = parseTemplateFile(p);
    expect(format).toBe('yaml');
    expect(template).toEqual({ Resources: { X: { Type: 'AWS::S3::Bucket' } } });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('surfaces a clear error for an invalid template', () => {
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{not-json');
    expect(() => parseTemplateFile(p)).toThrow(/not a valid CloudFormation template/);
    rmSync(tmp, { recursive: true, force: true });
  });
});
