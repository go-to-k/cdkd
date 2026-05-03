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

// S3 mocks for the >51,200-byte TemplateURL fallback path. The
// `s3SendCalls` array captures every command's `_name` + `input` so each
// test can assert the upload + delete sequence without re-mocking S3.
const s3SendCalls = vi.hoisted(
  () => [] as { name: string; input: Record<string, unknown> }[]
);
const s3DestroyMock = vi.hoisted(() => vi.fn());
const s3SendMock = vi.hoisted(() =>
  vi.fn(async (cmd: { _name: string; input: Record<string, unknown> }) => {
    s3SendCalls.push({ name: cmd._name, input: cmd.input });
    return {};
  })
);

const s3Commands = vi.hoisted(() => {
  class FakeS3Command {
    constructor(
      public readonly _name: string,
      public readonly input: Record<string, unknown>
    ) {}
  }
  return {
    PutObjectCommand: class extends FakeS3Command {
      constructor(input: Record<string, unknown>) {
        super('PutObject', input);
      }
    },
    DeleteObjectCommand: class extends FakeS3Command {
      constructor(input: Record<string, unknown>) {
        super('DeleteObject', input);
      }
    },
  };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: s3SendMock, destroy: s3DestroyMock })),
  PutObjectCommand: s3Commands.PutObjectCommand,
  DeleteObjectCommand: s3Commands.DeleteObjectCommand,
}));

const resolveBucketRegionMock = vi.hoisted(() => vi.fn(async () => 'eu-west-1'));
vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveBucketRegion: resolveBucketRegionMock,
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
    s3SendCalls.length = 0;
    s3SendMock.mockClear();
    s3DestroyMock.mockClear();
    resolveBucketRegionMock.mockClear();
    resolveBucketRegionMock.mockResolvedValue('eu-west-1');
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
      stateBucket: 'test-state-bucket',
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
      stateBucket: 'test-state-bucket',
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
      stateBucket: 'test-state-bucket',
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
      retireCloudFormationStack({
        cfnStackName: 'X',
        cfnClient: client as never,
        yes: true,
        stateBucket: 'test-state-bucket',
      })
    ).rejects.toThrow(/UPDATE_IN_PROGRESS.*not a stable terminal state/);
  });

  it('errors with a clear message when stack does not exist', async () => {
    const { client } = buildCfnClient({
      DescribeStacks: { Stacks: [] },
    });

    await expect(
      retireCloudFormationStack({
        cfnStackName: 'GhostStack',
        cfnClient: client as never,
        yes: true,
        stateBucket: 'test-state-bucket',
      })
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
      stateBucket: 'test-state-bucket',
    });

    expect(result).toEqual({ outcome: 'cancelled' });
    expect(calls.map((c) => c.name)).toEqual(['DescribeStacks', 'GetTemplate']);
  });

  it('uploads to the state bucket and uses TemplateURL when the modified template exceeds 51,200 bytes', async () => {
    // Build a template whose Retain-injected re-serialization is comfortably
    // above the 51,200-byte inline limit. Padding lives in a non-special
    // property to avoid tripping any validation.
    const big = JSON.stringify({
      Resources: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `R${i}`,
          { Type: 'AWS::S3::Bucket', Properties: { Tag: 'x'.repeat(400) } },
        ])
      ),
    });
    const { client, calls } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: big },
      UpdateStack: { StackId: 'arn:...' },
      DeleteStack: {},
    });

    const result = await retireCloudFormationStack({
      cfnStackName: 'BigStack',
      cfnClient: client as never,
      yes: true,
      stateBucket: 'state-bucket',
    });

    expect(result).toEqual({ outcome: 'retired' });

    // S3: PutObject then DeleteObject — both against the cdkd state bucket
    // under the canonical migrate-tmp prefix.
    expect(s3SendCalls.map((c) => c.name)).toEqual(['PutObject', 'DeleteObject']);
    const put = s3SendCalls[0]!;
    expect(put.input['Bucket']).toBe('state-bucket');
    expect(String(put.input['Key'])).toMatch(/^cdkd-migrate-tmp\/BigStack\/\d+\.json$/);
    expect(put.input['ContentType']).toBe('application/json');

    // UpdateStack should use TemplateURL (NOT TemplateBody) and the URL must
    // point at the bucket's actual region returned by resolveBucketRegion.
    const updateCmd = calls.find((c) => c.name === 'UpdateStack')!;
    expect(updateCmd.input['TemplateBody']).toBeUndefined();
    const url = String(updateCmd.input['TemplateURL']);
    expect(url).toMatch(
      /^https:\/\/state-bucket\.s3\.eu-west-1\.amazonaws\.com\/cdkd-migrate-tmp\/BigStack\/\d+\.json$/
    );
    // DeleteObject targets the same key uploaded by PutObject.
    expect(s3SendCalls[1]!.input['Key']).toBe(put.input['Key']);
    // Region resolution actually ran (cached or not).
    expect(resolveBucketRegionMock).toHaveBeenCalledWith('state-bucket', expect.anything());
  });

  it('still deletes the uploaded template when UpdateStack fails (cleanup is in finally)', async () => {
    const big = JSON.stringify({
      Resources: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `R${i}`,
          { Type: 'AWS::S3::Bucket', Properties: { Tag: 'x'.repeat(400) } },
        ])
      ),
    });
    const { client } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: big },
      UpdateStack: () => {
        throw new Error('AccessDenied: nope');
      },
    });

    await expect(
      retireCloudFormationStack({
        cfnStackName: 'BigFail',
        cfnClient: client as never,
        yes: true,
        stateBucket: 'state-bucket',
      })
    ).rejects.toThrow(/AccessDenied/);

    // Even though UpdateStack threw, the upload must have been deleted.
    expect(s3SendCalls.map((c) => c.name)).toEqual(['PutObject', 'DeleteObject']);
    expect(s3DestroyMock).toHaveBeenCalled();
  });

  it('logs a warning instead of throwing when DeleteObject cleanup itself fails', async () => {
    const big = JSON.stringify({
      Resources: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `R${i}`,
          { Type: 'AWS::S3::Bucket', Properties: { Tag: 'x'.repeat(400) } },
        ])
      ),
    });
    s3SendMock.mockImplementation(async (cmd) => {
      s3SendCalls.push({ name: cmd._name, input: cmd.input });
      if (cmd._name === 'DeleteObject') throw new Error('S3 access denied on delete');
      return {};
    });
    const { client } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: big },
      UpdateStack: { StackId: 'arn:...' },
      DeleteStack: {},
    });

    // The retire flow should still succeed — cleanup failure is best-effort.
    const result = await retireCloudFormationStack({
      cfnStackName: 'BigStack',
      cfnClient: client as never,
      yes: true,
      stateBucket: 'state-bucket',
    });
    expect(result.outcome).toBe('retired');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to delete temporary template upload.*cdkd-migrate-tmp/)
    );
  });

  it('rejects templates over the 1 MB CloudFormation TemplateURL limit with a clear error', async () => {
    // Force injectRetainPolicies to produce a template larger than the
    // 1,048,576-byte TemplateURL ceiling. The exact size doesn't matter — we
    // just need the re-serialized output to exceed that.
    const huge = JSON.stringify({
      Resources: Object.fromEntries(
        Array.from({ length: 1500 }, (_, i) => [
          `R${i}`,
          { Type: 'AWS::S3::Bucket', Properties: { Tag: 'x'.repeat(800) } },
        ])
      ),
    });
    const { client } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: huge },
    });

    await expect(
      retireCloudFormationStack({
        cfnStackName: 'HugeStack',
        cfnClient: client as never,
        yes: true,
        stateBucket: 'state-bucket',
      })
    ).rejects.toThrow(/exceeds the CloudFormation UpdateStack TemplateURL limit \(1048576\)/);

    // No S3 round-trips when we reject up front.
    expect(s3SendCalls).toHaveLength(0);
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
