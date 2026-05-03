import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const waitUpdateMock = vi.hoisted(() => vi.fn(async () => undefined));
const waitDeleteMock = vi.hoisted(() => vi.fn(async () => undefined));

const cfnCommands = vi.hoisted(() => {
  // Defined inside vi.hoisted so they are available when vi.mock's factory
  // is called (vi.mock is hoisted above the rest of the module).
  class FakeCommand {
    constructor(
      public readonly _name: string,
      public readonly input: Record<string, unknown>
    ) {}
  }
  return {
    DescribeStacksCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeStacks', input);
      }
    },
    GetTemplateCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('GetTemplate', input);
      }
    },
    UpdateStackCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('UpdateStack', input);
      }
    },
    DeleteStackCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DeleteStack', input);
      }
    },
    DescribeStackResourcesCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeStackResources', input);
      }
    },
  };
});

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: vi.fn(),
  DescribeStacksCommand: cfnCommands.DescribeStacksCommand,
  DescribeStackResourcesCommand: cfnCommands.DescribeStackResourcesCommand,
  GetTemplateCommand: cfnCommands.GetTemplateCommand,
  UpdateStackCommand: cfnCommands.UpdateStackCommand,
  DeleteStackCommand: cfnCommands.DeleteStackCommand,
  waitUntilStackUpdateComplete: waitUpdateMock,
  waitUntilStackDeleteComplete: waitDeleteMock,
}));

const readlineQuestion = vi.hoisted(() => vi.fn<(p: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: readlineQuestion, close: readlineClose })),
}));

import {
  retireCloudFormationStack,
  injectRetainPolicies,
  getCloudFormationResourceMapping,
} from '../../../src/cli/commands/retire-cfn-stack.js';

interface SendCall {
  name: string;
  input: Record<string, unknown>;
}

function buildCfnClient(
  responses: Partial<Record<string, unknown | (() => unknown)>>
): { client: { send: ReturnType<typeof vi.fn> }; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const send = vi.fn(async (cmd: FakeCommand) => {
    calls.push({ name: cmd._name, input: cmd.input });
    const r = responses[cmd._name];
    if (typeof r === 'function') return (r as () => unknown)();
    if (r === undefined) {
      throw new Error(`Unexpected CFn command: ${cmd._name}`);
    }
    return r;
  });
  return { client: { send }, calls };
}

const TEMPLATE_NO_RETAIN = JSON.stringify({
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    Func: { Type: 'AWS::Lambda::Function', Properties: {} },
  },
});

const TEMPLATE_ALL_RETAIN = JSON.stringify({
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    Bucket: {
      Type: 'AWS::S3::Bucket',
      Properties: {},
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    },
  },
});

describe('injectRetainPolicies', () => {
  it('adds DeletionPolicy and UpdateReplacePolicy on every resource', () => {
    const { body, modified } = injectRetainPolicies(TEMPLATE_NO_RETAIN, 'S');
    expect(modified).toBe(true);
    const parsed = JSON.parse(body);
    expect(parsed.Resources.Bucket.DeletionPolicy).toBe('Retain');
    expect(parsed.Resources.Bucket.UpdateReplacePolicy).toBe('Retain');
    expect(parsed.Resources.Func.DeletionPolicy).toBe('Retain');
    expect(parsed.Resources.Func.UpdateReplacePolicy).toBe('Retain');
  });

  it('reports modified=false when every resource already has both policies', () => {
    const { modified } = injectRetainPolicies(TEMPLATE_ALL_RETAIN, 'S');
    expect(modified).toBe(false);
  });

  it('preserves a user-set DeletionPolicy: Retain (no spurious modified flag)', () => {
    const tpl = JSON.stringify({
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' },
        Func: { Type: 'AWS::Lambda::Function' },
      },
    });
    const { body, modified } = injectRetainPolicies(tpl, 'S');
    expect(modified).toBe(true); // Func still needed mutation
    const parsed = JSON.parse(body);
    // Bucket policies untouched
    expect(parsed.Resources.Bucket.DeletionPolicy).toBe('Retain');
    expect(parsed.Resources.Func.DeletionPolicy).toBe('Retain');
  });

  it('overwrites a non-Retain DeletionPolicy (e.g. Delete) — that is the whole point', () => {
    const tpl = JSON.stringify({
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Delete' },
      },
    });
    const { body, modified } = injectRetainPolicies(tpl, 'S');
    expect(modified).toBe(true);
    expect(JSON.parse(body).Resources.Bucket.DeletionPolicy).toBe('Retain');
  });

  it('throws on non-JSON template body', () => {
    expect(() => injectRetainPolicies('Resources:\n  Bucket:\n    Type: AWS::S3::Bucket', 'S'))
      .toThrow(/not valid JSON/);
  });

  it('throws on a template with no Resources section', () => {
    expect(() => injectRetainPolicies(JSON.stringify({ Outputs: {} }), 'S'))
      .toThrow(/no Resources section/);
  });
});

describe('retireCloudFormationStack', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    waitUpdateMock.mockReset();
    waitUpdateMock.mockResolvedValue(undefined);
    waitDeleteMock.mockReset();
    waitDeleteMock.mockResolvedValue(undefined);
    readlineQuestion.mockReset();
    readlineClose.mockReset();
  });

  it('runs the full Describe → GetTemplate → UpdateStack → DeleteStack flow', async () => {
    const { client, calls } = buildCfnClient({
      DescribeStacks: {
        Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: ['CAPABILITY_IAM'] }],
      },
      GetTemplate: { TemplateBody: TEMPLATE_NO_RETAIN },
      UpdateStack: { StackId: 'arn:aws:cloudformation:...' },
      DeleteStack: {},
    });

    const result = await retireCloudFormationStack({
      cfnStackName: 'MyStack',
      // Cast: the helper only uses .send().
      cfnClient: client as never,
      yes: true,
    });

    expect(result).toEqual({ outcome: 'retired' });
    expect(calls.map((c) => c.name)).toEqual([
      'DescribeStacks',
      'GetTemplate',
      'UpdateStack',
      'DeleteStack',
    ]);
    // Capabilities forwarded.
    expect(calls[2]!.input['Capabilities']).toEqual(['CAPABILITY_IAM']);
    // TemplateBody contains both Retain policies on Bucket and Func.
    const updatedBody = String(calls[2]!.input['TemplateBody']);
    expect(updatedBody).toContain('"DeletionPolicy": "Retain"');
    expect(updatedBody).toContain('"UpdateReplacePolicy": "Retain"');
    expect(waitUpdateMock).toHaveBeenCalledTimes(1);
    expect(waitDeleteMock).toHaveBeenCalledTimes(1);
  });

  it('skips UpdateStack when the template already has Retain everywhere', async () => {
    const { client, calls } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: TEMPLATE_ALL_RETAIN },
      DeleteStack: {},
    });

    const result = await retireCloudFormationStack({
      cfnStackName: 'AllRetainStack',
      cfnClient: client as never,
      yes: true,
    });

    expect(result).toEqual({ outcome: 'no-template-change' });
    expect(calls.map((c) => c.name)).toEqual(['DescribeStacks', 'GetTemplate', 'DeleteStack']);
    expect(waitUpdateMock).not.toHaveBeenCalled();
    expect(waitDeleteMock).toHaveBeenCalledTimes(1);
  });

  it('treats CFn "No updates are to be performed" as a successful skip', async () => {
    const { client, calls } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: TEMPLATE_NO_RETAIN },
      UpdateStack: () => {
        throw new Error('ValidationError: No updates are to be performed.');
      },
      DeleteStack: {},
    });

    const result = await retireCloudFormationStack({
      cfnStackName: 'S',
      cfnClient: client as never,
      yes: true,
    });

    expect(result.outcome).toBe('retired');
    // UpdateStack was attempted; waitUpdate should NOT have been called when CFn rejected.
    expect(calls.map((c) => c.name)).toEqual([
      'DescribeStacks',
      'GetTemplate',
      'UpdateStack',
      'DeleteStack',
    ]);
    expect(waitUpdateMock).not.toHaveBeenCalled();
    expect(waitDeleteMock).toHaveBeenCalledTimes(1);
  });

  it('errors when stack is in an in-progress state', async () => {
    const { client } = buildCfnClient({
      DescribeStacks: {
        Stacks: [{ StackStatus: 'UPDATE_IN_PROGRESS', Capabilities: [] }],
      },
    });

    await expect(
      retireCloudFormationStack({ cfnStackName: 'X', cfnClient: client as never, yes: true })
    ).rejects.toThrow(/UPDATE_IN_PROGRESS.*not a stable terminal state/);
  });

  it('errors with a clear message when stack does not exist', async () => {
    const { client } = buildCfnClient({
      DescribeStacks: { Stacks: [] },
    });

    await expect(
      retireCloudFormationStack({ cfnStackName: 'GhostStack', cfnClient: client as never, yes: true })
    ).rejects.toThrow(/'GhostStack' not found/);
  });

  it('cancels (no UpdateStack/DeleteStack) when user declines confirmation', async () => {
    const { client, calls } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: TEMPLATE_NO_RETAIN },
    });
    readlineQuestion.mockResolvedValue('n');

    const result = await retireCloudFormationStack({
      cfnStackName: 'X',
      cfnClient: client as never,
      yes: false,
    });

    expect(result).toEqual({ outcome: 'cancelled' });
    expect(calls.map((c) => c.name)).toEqual(['DescribeStacks', 'GetTemplate']);
  });
});

describe('getCloudFormationResourceMapping', () => {
  it('returns a Map<logicalId, physicalId> for every stack resource', async () => {
    const { client, calls } = buildCfnClient({
      DescribeStackResources: {
        StackResources: [
          { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'my-actual-bucket' },
          { LogicalResourceId: 'MyTopic', PhysicalResourceId: 'arn:aws:sns:...:my-topic' },
        ],
      },
    });

    const mapping = await getCloudFormationResourceMapping('S', client as never);

    expect(calls.map((c) => c.name)).toEqual(['DescribeStackResources']);
    expect(calls[0]!.input['StackName']).toBe('S');
    expect(mapping.get('MyBucket')).toBe('my-actual-bucket');
    expect(mapping.get('MyTopic')).toBe('arn:aws:sns:...:my-topic');
    expect(mapping.size).toBe(2);
  });

  it('skips entries missing LogicalResourceId or PhysicalResourceId', async () => {
    const { client } = buildCfnClient({
      DescribeStackResources: {
        StackResources: [
          { LogicalResourceId: 'Good', PhysicalResourceId: 'phys' },
          { LogicalResourceId: 'NoPhys' }, // mid-create or import-failed
          { PhysicalResourceId: 'NoLogical' }, // shouldn't happen but defensive
        ],
      },
    });

    const mapping = await getCloudFormationResourceMapping('S', client as never);

    expect([...mapping.entries()]).toEqual([['Good', 'phys']]);
  });

  it('returns an empty map when the stack has no resources', async () => {
    const { client } = buildCfnClient({
      DescribeStackResources: { StackResources: [] },
    });

    const mapping = await getCloudFormationResourceMapping('Empty', client as never);
    expect(mapping.size).toBe(0);
  });
});
