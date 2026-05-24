import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
  injectRetainPoliciesRecursive,
  getCloudFormationResourceTree,
  RecursiveRetainInjectionError,
  type CfnStackResourceTree,
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

  it('accepts a YAML template body (CFn-aware codec preserves shorthand intrinsics)', () => {
    const { body, modified, format } = injectRetainPolicies(
      'Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n',
      'S'
    );
    expect(modified).toBe(true);
    expect(format).toBe('yaml');
    // YAML output retains YAML shape (key: value, not braces / quotes).
    expect(body).toContain('Type: AWS::S3::Bucket');
    expect(body).toContain('DeletionPolicy: Retain');
    expect(body).toContain('UpdateReplacePolicy: Retain');
  });

  it('throws on a body that is neither valid JSON nor valid YAML', () => {
    // Unbalanced flow-map inside a YAML block-collection — sniffs as
    // YAML (first byte is `a`, not `{` / `[`), then fails the YAML
    // parse with a clear syntax error.
    expect(() => injectRetainPolicies('a: { foo: bar', 'S')).toThrow(/not a valid CloudFormation/);
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

  it('runs the full flow inline when the source template is small YAML', async () => {
    // Small YAML template that fits inline (51,200-byte limit). Mirrors
    // the JSON inline test above to cover the small-YAML branch.
    const smallYaml = 'Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n';
    const { client, calls } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: smallYaml },
      UpdateStack: { StackId: 'arn:aws:cloudformation:...' },
      DeleteStack: {},
    });

    const result = await retireCloudFormationStack({
      cfnStackName: 'SmallYamlStack',
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
    // Confirm inline path (TemplateBody set, no TemplateURL — no S3 upload).
    const updateCmd = calls.find((c) => c.name === 'UpdateStack')!;
    expect(updateCmd.input['TemplateBody']).toBeDefined();
    expect(updateCmd.input['TemplateURL']).toBeUndefined();
    // The body is the modified YAML (with Retain policies), NOT JSON.
    const body = String(updateCmd.input['TemplateBody']);
    expect(body.trimStart().startsWith('{')).toBe(false);
    expect(body).toContain('Type: AWS::S3::Bucket');
    expect(body).toContain('DeletionPolicy: Retain');
    expect(body).toContain('UpdateReplacePolicy: Retain');
    // S3 was NOT touched on the inline path.
    expect(s3SendCalls).toEqual([]);
  });

  it('forwards existing stack Parameters via UsePreviousValue on UpdateStack', async () => {
    // Real cdkd bug surfaced by the cdkd migrate integ on 2026-05-22: when
    // the source CFn stack has declared Parameters, UpdateStack without a
    // Parameters argument falls back to CFn template defaults. If a
    // parameter has no default the call validates-fails; if a parameter has
    // a default that differs from the current value, the metadata-only
    // Retain injection accidentally re-evaluates Fn::Sub references and
    // rolls back. The fix forwards each existing parameter via
    // UsePreviousValue: true so the retire is truly metadata-only.
    const { client, calls } = buildCfnClient({
      DescribeStacks: {
        Stacks: [
          {
            StackStatus: 'CREATE_COMPLETE',
            Capabilities: [],
            Parameters: [
              { ParameterKey: 'ResourceSuffix', ParameterValue: '0725000' },
              { ParameterKey: 'Environment', ParameterValue: 'integ' },
            ],
          },
        ],
      },
      GetTemplate: { TemplateBody: TEMPLATE_NO_RETAIN },
      UpdateStack: { StackId: 'arn:aws:cloudformation:...' },
      DeleteStack: {},
    });

    const result = await retireCloudFormationStack({
      cfnStackName: 'ParameterizedStack',
      cfnClient: client as never,
      yes: true,
      stateBucket: 'test-state-bucket',
    });

    expect(result).toEqual({ outcome: 'retired' });
    const updateCmd = calls.find((c) => c.name === 'UpdateStack')!;
    expect(updateCmd.input['Parameters']).toEqual([
      { ParameterKey: 'ResourceSuffix', UsePreviousValue: true },
      { ParameterKey: 'Environment', UsePreviousValue: true },
    ]);
  });

  it('omits Parameters entirely when the source stack declared none', async () => {
    // A stack without Parameters should not surface an empty Parameters
    // array on UpdateStack — leave the field absent so the SDK does not
    // serialize Parameters: [] on the wire.
    const { client, calls } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: TEMPLATE_NO_RETAIN },
      UpdateStack: { StackId: 'arn:aws:cloudformation:...' },
      DeleteStack: {},
    });

    await retireCloudFormationStack({
      cfnStackName: 'NoParamStack',
      cfnClient: client as never,
      yes: true,
      stateBucket: 'test-state-bucket',
    });

    const updateCmd = calls.find((c) => c.name === 'UpdateStack')!;
    expect(updateCmd.input['Parameters']).toBeUndefined();
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

  it('uses a .yaml key suffix and YAML content-type when the source template is YAML', async () => {
    // Big YAML template — same shape as the JSON variant above but
    // written in YAML so the format-aware upload stamps `.yaml` /
    // `application/x-yaml` on the transient S3 object.
    const big =
      'Resources:\n' +
      Array.from({ length: 200 }, (_, i) =>
        `  R${i}:\n    Type: AWS::S3::Bucket\n    Properties:\n      Tag: ${'x'.repeat(400)}\n`
      ).join('');
    const { client, calls } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: big },
      UpdateStack: { StackId: 'arn:...' },
      DeleteStack: {},
    });

    const result = await retireCloudFormationStack({
      cfnStackName: 'BigYamlStack',
      cfnClient: client as never,
      yes: true,
      stateBucket: 'state-bucket',
    });

    expect(result).toEqual({ outcome: 'retired' });
    const put = s3SendCalls.find((c) => c.name === 'PutObject')!;
    expect(String(put.input['Key'])).toMatch(/^cdkd-migrate-tmp\/BigYamlStack\/\d+\.yaml$/);
    expect(put.input['ContentType']).toBe('application/x-yaml');
    const updateCmd = calls.find((c) => c.name === 'UpdateStack')!;
    const url = String(updateCmd.input['TemplateURL']);
    expect(url).toMatch(
      /^https:\/\/state-bucket\.s3\.eu-west-1\.amazonaws\.com\/cdkd-migrate-tmp\/BigYamlStack\/\d+\.yaml$/
    );
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

// ---------------------------------------------------------------------------
// PR for issue #464 — recursive nested-stack support tests
// ---------------------------------------------------------------------------

describe('injectRetainPolicies (skip rule for nested-stack rows)', () => {
  it('skips AWS::CloudFormation::Stack rows from Retain injection', () => {
    // Retain on a nested-stack row would tell CFn's parent DeleteStack to
    // NOT cascade-delete the child stack record — leaving a stranded
    // child stack on AWS. The recursive flow relies on this skip so
    // cascade-delete propagates into each child where the child's OWN
    // leaf resources are Retain-marked (preventing AWS resource deletion
    // without preventing CFn record cleanup).
    const tpl = JSON.stringify({
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
      },
    });
    const { body, modified } = injectRetainPolicies(tpl, 'P');
    expect(modified).toBe(true);
    const parsed = JSON.parse(body);
    expect(parsed.Resources.Bucket.DeletionPolicy).toBe('Retain');
    expect(parsed.Resources.Bucket.UpdateReplacePolicy).toBe('Retain');
    // Child row stays untouched — no DeletionPolicy / UpdateReplacePolicy.
    expect(parsed.Resources.Child.DeletionPolicy).toBeUndefined();
    expect(parsed.Resources.Child.UpdateReplacePolicy).toBeUndefined();
  });
});

describe('getCloudFormationResourceTree', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
  });

  it('returns a single-node tree when the root has no nested children', async () => {
    const { client, calls } = buildCfnClient({
      DescribeStackResources: {
        StackResources: [
          { LogicalResourceId: 'B', PhysicalResourceId: 'b-phys', ResourceType: 'AWS::S3::Bucket' },
        ],
      },
    });
    const tree = await getCloudFormationResourceTree('Root', client as never);
    expect(tree.stackName).toBe('Root');
    expect(tree.physicalId).toBe('Root');
    expect([...tree.resources.entries()]).toEqual([['B', 'b-phys']]);
    expect(tree.nested.size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('walks a 3-level tree (parent → child → grandchild) recursively', async () => {
    const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid1';
    const grandchildArn = 'arn:aws:cloudformation:us-east-1:123:stack/Grandchild/uuid2';
    // Each level returns a different response based on StackName input.
    const responses: Record<string, { StackResources: unknown[] }> = {
      Root: {
        StackResources: [
          { LogicalResourceId: 'BucketA', PhysicalResourceId: 'a', ResourceType: 'AWS::S3::Bucket' },
          { LogicalResourceId: 'Child', PhysicalResourceId: childArn, ResourceType: 'AWS::CloudFormation::Stack' },
        ],
      },
      [childArn]: {
        StackResources: [
          { LogicalResourceId: 'BucketB', PhysicalResourceId: 'b', ResourceType: 'AWS::S3::Bucket' },
          { LogicalResourceId: 'Grandchild', PhysicalResourceId: grandchildArn, ResourceType: 'AWS::CloudFormation::Stack' },
        ],
      },
      [grandchildArn]: {
        StackResources: [
          { LogicalResourceId: 'BucketC', PhysicalResourceId: 'c', ResourceType: 'AWS::S3::Bucket' },
        ],
      },
    };
    const calls: { StackName: string }[] = [];
    const send = vi.fn(async (cmd: FakeCommand) => {
      const stackName = cmd.input['StackName'] as string;
      calls.push({ StackName: stackName });
      const r = responses[stackName];
      if (!r) throw new Error(`Unexpected DescribeStackResources for '${stackName}'`);
      return r;
    });
    const client = { send };

    const tree = await getCloudFormationResourceTree('Root', client as never);

    // 3 round-trips total (one per stack).
    expect(calls.map((c) => c.StackName).sort()).toEqual([childArn, grandchildArn, 'Root'].sort());
    expect(tree.stackName).toBe('Root');
    expect(tree.nested.size).toBe(1);
    const childNode = tree.nested.get('Child')!;
    expect(childNode.stackName).toBe(childArn);
    expect(childNode.physicalId).toBe(childArn);
    expect(childNode.nested.size).toBe(1);
    const grandNode = childNode.nested.get('Grandchild')!;
    expect(grandNode.stackName).toBe(grandchildArn);
    expect([...grandNode.resources.keys()]).toEqual(['BucketC']);
    expect(grandNode.nested.size).toBe(0);
  });

  it('fetches sibling children in parallel (single nesting level)', async () => {
    // Two children at the parent level: the walker should issue both
    // DescribeStackResources calls without serializing on the first.
    const childAArn = 'arn:aws:cloudformation:...:stack/A/u1';
    const childBArn = 'arn:aws:cloudformation:...:stack/B/u2';
    const inflight = { count: 0, max: 0 };
    const send = vi.fn(async (cmd: FakeCommand) => {
      const stackName = cmd.input['StackName'] as string;
      inflight.count++;
      inflight.max = Math.max(inflight.max, inflight.count);
      // Tiny delay so concurrency is observable on the counter.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      inflight.count--;
      if (stackName === 'Root') {
        return {
          StackResources: [
            { LogicalResourceId: 'A', PhysicalResourceId: childAArn, ResourceType: 'AWS::CloudFormation::Stack' },
            { LogicalResourceId: 'B', PhysicalResourceId: childBArn, ResourceType: 'AWS::CloudFormation::Stack' },
          ],
        };
      }
      return { StackResources: [] };
    });

    await getCloudFormationResourceTree('Root', { send } as never);
    expect(inflight.max).toBeGreaterThanOrEqual(2);
  });

  it('propagates child-level DescribeStackResources failures via Promise.all rejection', async () => {
    // Sibling children are fetched via `Promise.all` for parallelism —
    // if ANY child-level DescribeStackResources rejects, the rejection
    // must propagate out of the walker (caller's `cdkd import
    // --migrate-from-cloudformation` flow aborts before any state write
    // / Retain injection runs). Without this, a transient child-level
    // AWS failure would silently produce a partial tree and downstream
    // `validateNestedStackShape` would surface as a confusing
    // "BOnly was reported by AWS but the synth template only lists
    // AOnly" mismatch.
    const childAArn = 'arn:aws:cloudformation:...:stack/ChildA/uuid-a';
    const childBArn = 'arn:aws:cloudformation:...:stack/ChildB/uuid-b';
    const send = vi.fn(async (cmd: FakeCommand) => {
      const stackName = cmd.input['StackName'] as string;
      if (stackName === 'Root') {
        return {
          StackResources: [
            {
              LogicalResourceId: 'ChildA',
              PhysicalResourceId: childAArn,
              ResourceType: 'AWS::CloudFormation::Stack',
            },
            {
              LogicalResourceId: 'ChildB',
              PhysicalResourceId: childBArn,
              ResourceType: 'AWS::CloudFormation::Stack',
            },
          ],
        };
      }
      if (stackName === childAArn) {
        return { StackResources: [] };
      }
      if (stackName === childBArn) {
        throw new Error('AWS: ChildB disappeared');
      }
      throw new Error(`Unexpected DescribeStackResources for '${stackName}'`);
    });

    await expect(
      getCloudFormationResourceTree('Root', { send } as never)
    ).rejects.toThrow(/AWS: ChildB disappeared/);
  });
});

describe('injectRetainPoliciesRecursive', () => {
  beforeEach(() => {
    s3SendCalls.length = 0;
    s3SendMock.mockClear();
    s3DestroyMock.mockClear();
    resolveBucketRegionMock.mockClear();
    resolveBucketRegionMock.mockResolvedValue('eu-west-1');
  });

  it('flat (no nested children) → no GetTemplate / no S3 upload, modified template only', async () => {
    const tpl = JSON.stringify({
      Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } },
    });
    const tree: CfnStackResourceTree = {
      stackName: 'P',
      physicalId: 'P',
      resources: new Map([['B', 'b']]),
      nested: new Map(),
    };
    const send = vi.fn();
    const result = await injectRetainPoliciesRecursive(tpl, 'P', tree, {
      cfnClient: { send } as never,
      stateBucket: 'state-bucket',
    });
    expect(send).not.toHaveBeenCalled();
    expect(s3SendCalls).toHaveLength(0);
    expect(result.cleanups).toHaveLength(0);
    expect(result.modified).toBe(true);
    const parsed = JSON.parse(result.body);
    expect(parsed.Resources.B.DeletionPolicy).toBe('Retain');
  });

  it('one nested child → GetTemplate on child, recursive injection, child upload, parent URL rewrite', async () => {
    const childArn = 'arn:aws:cloudformation:...:stack/Child/uuid';
    const parentBody = JSON.stringify({
      Resources: {
        ParentBucket: { Type: 'AWS::S3::Bucket' },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://example.com/old-child.json' },
        },
      },
    });
    const childBody = JSON.stringify({
      Resources: { ChildBucket: { Type: 'AWS::S3::Bucket' } },
    });
    const tree: CfnStackResourceTree = {
      stackName: 'P',
      physicalId: 'P',
      resources: new Map([['ParentBucket', 'pb'], ['Child', childArn]]),
      nested: new Map([
        [
          'Child',
          {
            stackName: childArn,
            physicalId: childArn,
            resources: new Map([['ChildBucket', 'cb']]),
            nested: new Map(),
          },
        ],
      ]),
    };

    const cfnCalls: { name: string; StackName: string }[] = [];
    const send = vi.fn(async (cmd: FakeCommand) => {
      cfnCalls.push({ name: cmd._name, StackName: cmd.input['StackName'] as string });
      if (cmd._name === 'GetTemplate') return { TemplateBody: childBody };
      throw new Error(`Unexpected CFn command: ${cmd._name}`);
    });

    const result = await injectRetainPoliciesRecursive(parentBody, 'P', tree, {
      cfnClient: { send } as never,
      stateBucket: 'state-bucket',
    });

    // CFn: GetTemplate on the child (Original stage).
    expect(cfnCalls).toEqual([{ name: 'GetTemplate', StackName: childArn }]);
    // S3: one PutObject for the modified child body. cleanup callback
    // returned for the caller to drain in `finally`.
    const puts = s3SendCalls.filter((c) => c.name === 'PutObject');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.input['Bucket']).toBe('state-bucket');
    expect(String(puts[0]!.input['Key'])).toContain('P__nested__Child');
    expect(result.cleanups).toHaveLength(1);

    // Parent body: Retain on ParentBucket, NOT on Child (skip rule),
    // TemplateURL rewritten to point at our uploaded child body.
    const parsedParent = JSON.parse(result.body);
    expect(parsedParent.Resources.ParentBucket.DeletionPolicy).toBe('Retain');
    expect(parsedParent.Resources.Child.DeletionPolicy).toBeUndefined();
    expect(parsedParent.Resources.Child.Properties.TemplateURL).toMatch(/^https:\/\//);
    expect(parsedParent.Resources.Child.Properties.TemplateURL).not.toBe(
      'https://example.com/old-child.json'
    );
    expect(result.modified).toBe(true);
  });

  it('depth-2 (parent → child → grandchild) → recursive injection on every level + grandchild upload + parent + child URL rewrites', async () => {
    // Verifies that the recursion goes more than one level deep — that is,
    // the child's own `injectRetainPoliciesRecursiveInternal` call walks
    // into ITS nested-stack rows the same way the root parent's call does.
    // Concretely: a depth-2 tree (P → Child → Grandchild) should produce
    // (a) two `GetTemplate` round-trips (child + grandchild), (b) two
    // PutObject uploads (modified child body + modified grandchild body),
    // (c) Retain injected on every non-nested-stack resource at every
    // level, (d) `TemplateURL` rewritten on the parent's Child row AND
    // on the child's Grandchild row.
    const childArn = 'arn:aws:cloudformation:...:stack/Child/uuid-c';
    const grandchildArn = 'arn:aws:cloudformation:...:stack/Grandchild/uuid-g';
    const parentBody = JSON.stringify({
      Resources: {
        ParentBucket: { Type: 'AWS::S3::Bucket' },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://example.com/old-child.json' },
        },
      },
    });
    const childBody = JSON.stringify({
      Resources: {
        ChildBucket: { Type: 'AWS::S3::Bucket' },
        Grandchild: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://example.com/old-grandchild.json' },
        },
      },
    });
    const grandchildBody = JSON.stringify({
      Resources: { GrandchildBucket: { Type: 'AWS::S3::Bucket' } },
    });
    const tree: CfnStackResourceTree = {
      stackName: 'P',
      physicalId: 'P',
      resources: new Map([['ParentBucket', 'pb'], ['Child', childArn]]),
      nested: new Map([
        [
          'Child',
          {
            stackName: childArn,
            physicalId: childArn,
            resources: new Map([['ChildBucket', 'cb'], ['Grandchild', grandchildArn]]),
            nested: new Map([
              [
                'Grandchild',
                {
                  stackName: grandchildArn,
                  physicalId: grandchildArn,
                  resources: new Map([['GrandchildBucket', 'gb']]),
                  nested: new Map(),
                },
              ],
            ]),
          },
        ],
      ]),
    };

    const cfnCalls: { name: string; StackName: string }[] = [];
    const send = vi.fn(async (cmd: FakeCommand) => {
      cfnCalls.push({ name: cmd._name, StackName: cmd.input['StackName'] as string });
      if (cmd._name === 'GetTemplate') {
        const stackName = cmd.input['StackName'];
        if (stackName === childArn) return { TemplateBody: childBody };
        if (stackName === grandchildArn) return { TemplateBody: grandchildBody };
      }
      throw new Error(`Unexpected CFn command: ${cmd._name}(${JSON.stringify(cmd.input)})`);
    });

    const result = await injectRetainPoliciesRecursive(parentBody, 'P', tree, {
      cfnClient: { send } as never,
      stateBucket: 'state-bucket',
    });

    // CFn: one GetTemplate per nesting level (child + grandchild). Order
    // doesn't matter for correctness, but the existing depth-1 test
    // pins order so we do too — depth-first: child first, then
    // grandchild (which is awaited inside the child's recursion).
    expect(cfnCalls.map((c) => c.name)).toEqual(['GetTemplate', 'GetTemplate']);
    expect(cfnCalls.map((c) => c.StackName).sort()).toEqual([childArn, grandchildArn].sort());

    // S3: one PutObject per uploaded transient (modified child body +
    // modified grandchild body).
    const puts = s3SendCalls.filter((c) => c.name === 'PutObject');
    expect(puts).toHaveLength(2);
    const keys = puts.map((p) => String(p.input['Key']));
    expect(keys.some((k) => k.includes('__nested__Child'))).toBe(true);
    expect(keys.some((k) => k.includes('__nested__Grandchild'))).toBe(true);
    // Caller receives 2 cleanup callbacks to drain in `finally`.
    expect(result.cleanups).toHaveLength(2);

    // Parent body: Retain on ParentBucket, NOT on Child (skip rule),
    // TemplateURL on the Child row rewritten away from the original.
    const parsedParent = JSON.parse(result.body);
    expect(parsedParent.Resources.ParentBucket.DeletionPolicy).toBe('Retain');
    expect(parsedParent.Resources.ParentBucket.UpdateReplacePolicy).toBe('Retain');
    expect(parsedParent.Resources.Child.DeletionPolicy).toBeUndefined();
    expect(parsedParent.Resources.Child.UpdateReplacePolicy).toBeUndefined();
    expect(parsedParent.Resources.Child.Properties.TemplateURL).toMatch(/^https:\/\//);
    expect(parsedParent.Resources.Child.Properties.TemplateURL).not.toBe(
      'https://example.com/old-child.json'
    );

    // Child body inside the uploaded transient: Retain on ChildBucket,
    // NOT on Grandchild (skip rule), TemplateURL on the Grandchild row
    // rewritten away from the original.
    const childPut = puts.find((p) => String(p.input['Key']).includes('__nested__Child'))!;
    const parsedChild = JSON.parse(childPut.input['Body'] as string);
    expect(parsedChild.Resources.ChildBucket.DeletionPolicy).toBe('Retain');
    expect(parsedChild.Resources.ChildBucket.UpdateReplacePolicy).toBe('Retain');
    expect(parsedChild.Resources.Grandchild.DeletionPolicy).toBeUndefined();
    expect(parsedChild.Resources.Grandchild.UpdateReplacePolicy).toBeUndefined();
    expect(parsedChild.Resources.Grandchild.Properties.TemplateURL).toMatch(/^https:\/\//);
    expect(parsedChild.Resources.Grandchild.Properties.TemplateURL).not.toBe(
      'https://example.com/old-grandchild.json'
    );

    // Grandchild body inside the uploaded transient: Retain on
    // GrandchildBucket (leaf-level Retain injection at depth 2).
    const grandchildPut = puts.find((p) =>
      String(p.input['Key']).includes('__nested__Grandchild')
    )!;
    const parsedGrandchild = JSON.parse(grandchildPut.input['Body'] as string);
    expect(parsedGrandchild.Resources.GrandchildBucket.DeletionPolicy).toBe('Retain');
    expect(parsedGrandchild.Resources.GrandchildBucket.UpdateReplacePolicy).toBe('Retain');

    expect(result.modified).toBe(true);
  });

  it('rejects when modified nested-stack template exceeds the 1 MB CloudFormation TemplateURL limit', async () => {
    // Defensive guard against a 1 MB+ child template — the
    // CloudFormation `TemplateURL` ceiling is structurally non-negotiable,
    // so the recursive flow must reject up front before any S3 upload
    // happens (a transient over 1 MB would be a wasted round-trip we
    // couldn't submit anyway, AND the size check must precede the
    // upload so `cleanups` carries 0 entries on the rejection path).
    const childArn = 'arn:aws:cloudformation:...:stack/Child/uuid-big';
    const parentBody = JSON.stringify({
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'x' },
        },
      },
    });
    // Pad the child template so the post-Retain-injection body crosses
    // 1 MB. The `Description` field is forwarded verbatim through the
    // CFn parse/stringify roundtrip, so stuffing 1.1 MB of `a`s in
    // Properties.Description guarantees overflow.
    const padding = 'a'.repeat(1_100_000);
    const childBody = JSON.stringify({
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: { Description: padding } },
      },
    });
    const tree: CfnStackResourceTree = {
      stackName: 'P',
      physicalId: 'P',
      resources: new Map([['Child', childArn]]),
      nested: new Map([
        [
          'Child',
          {
            stackName: childArn,
            physicalId: childArn,
            resources: new Map([['Bucket', 'b']]),
            nested: new Map(),
          },
        ],
      ]),
    };
    const send = vi.fn(async (cmd: FakeCommand) => {
      if (cmd._name === 'GetTemplate') return { TemplateBody: childBody };
      throw new Error(`Unexpected CFn command: ${cmd._name}`);
    });

    let thrown: unknown;
    try {
      await injectRetainPoliciesRecursive(parentBody, 'P', tree, {
        cfnClient: { send } as never,
        stateBucket: 'state-bucket',
      });
    } catch (err) {
      thrown = err;
    }

    // Wrapped in RecursiveRetainInjectionError so caller's `finally` can
    // still drain whatever cleanups accumulated (zero in this case, since
    // the size check fires BEFORE the upload).
    expect(thrown).toBeInstanceOf(RecursiveRetainInjectionError);
    const err = thrown as RecursiveRetainInjectionError;
    expect(err.message).toMatch(/exceeds the CloudFormation TemplateURL limit/);
    expect(err.cleanups).toHaveLength(0);
    // No PutObject ever issued — the size guard runs before upload.
    expect(s3SendCalls.filter((c) => c.name === 'PutObject')).toHaveLength(0);
  });

  it('throws RecursiveRetainInjectionError carrying partial cleanups on mid-walk failure', async () => {
    // Two children at the parent level; we let the first child succeed
    // (1 transient upload accumulated), then fail GetTemplate on the
    // second. The thrown error must carry that one accumulated cleanup
    // so the caller's finally can reap it.
    const child1Arn = 'arn:aws:cloudformation:...:stack/C1/u1';
    const child2Arn = 'arn:aws:cloudformation:...:stack/C2/u2';
    const parentBody = JSON.stringify({
      Resources: {
        C1: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
        C2: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'y' } },
      },
    });
    const child1Body = JSON.stringify({ Resources: { B: { Type: 'AWS::S3::Bucket' } } });
    const tree: CfnStackResourceTree = {
      stackName: 'P',
      physicalId: 'P',
      resources: new Map([['C1', child1Arn], ['C2', child2Arn]]),
      nested: new Map([
        ['C1', { stackName: child1Arn, physicalId: child1Arn, resources: new Map(), nested: new Map() }],
        ['C2', { stackName: child2Arn, physicalId: child2Arn, resources: new Map(), nested: new Map() }],
      ]),
    };
    let callIdx = 0;
    const send = vi.fn(async (cmd: FakeCommand) => {
      callIdx++;
      if (cmd._name !== 'GetTemplate') throw new Error('unexpected');
      if (callIdx === 1) return { TemplateBody: child1Body };
      throw new Error('AWS: child2 disappeared');
    });

    let thrown: unknown;
    try {
      await injectRetainPoliciesRecursive(parentBody, 'P', tree, {
        cfnClient: { send } as never,
        stateBucket: 'state-bucket',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecursiveRetainInjectionError);
    const err = thrown as RecursiveRetainInjectionError;
    // C1's transient upload accumulated before C2 failed.
    expect(err.cleanups.length).toBeGreaterThanOrEqual(1);
  });
});

describe('retireCloudFormationStack (nested-stack-aware path)', () => {
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

  it('uses caller-supplied resourceTree for the recursive walk (no extra DescribeStackResources)', async () => {
    const childArn = 'arn:aws:cloudformation:...:stack/Child/uuid';
    const parentBody = JSON.stringify({
      Resources: {
        P: { Type: 'AWS::S3::Bucket' },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://old/child.json' },
        },
      },
    });
    const childBody = JSON.stringify({
      Resources: { C: { Type: 'AWS::S3::Bucket' } },
    });
    const tree: CfnStackResourceTree = {
      stackName: 'Parent',
      physicalId: 'Parent',
      resources: new Map([['P', 'p'], ['Child', childArn]]),
      nested: new Map([
        [
          'Child',
          {
            stackName: childArn,
            physicalId: childArn,
            resources: new Map([['C', 'c']]),
            nested: new Map(),
          },
        ],
      ]),
    };

    // Track ALL CFn calls. We expect NO DescribeStackResources because
    // the caller pre-built the tree.
    const cfnCalls: { name: string }[] = [];
    const send = vi.fn(async (cmd: FakeCommand) => {
      cfnCalls.push({ name: cmd._name });
      if (cmd._name === 'DescribeStacks') {
        return { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] };
      }
      if (cmd._name === 'GetTemplate') {
        // First GetTemplate is for the parent; second is for the child.
        return { TemplateBody: cfnCalls.filter((c) => c.name === 'GetTemplate').length === 1 ? parentBody : childBody };
      }
      if (cmd._name === 'UpdateStack') return { StackId: 'arn' };
      if (cmd._name === 'DeleteStack') return {};
      throw new Error(`Unexpected: ${cmd._name}`);
    });

    const result = await retireCloudFormationStack({
      cfnStackName: 'Parent',
      cfnClient: { send } as never,
      yes: true,
      stateBucket: 'state-bucket',
      resourceTree: tree,
    });

    expect(result).toEqual({ outcome: 'retired' });
    // Sequence: DescribeStacks → GetTemplate(parent) → GetTemplate(child)
    // → UpdateStack(parent) → DeleteStack(parent). No DescribeStackResources.
    expect(cfnCalls.map((c) => c.name)).toEqual([
      'DescribeStacks',
      'GetTemplate',
      'GetTemplate',
      'UpdateStack',
      'DeleteStack',
    ]);
    // Child template body was uploaded to S3 + deleted at end (cleanup
    // happens in `retireCloudFormationStack`'s finally).
    const puts = s3SendCalls.filter((c) => c.name === 'PutObject');
    const deletes = s3SendCalls.filter((c) => c.name === 'DeleteObject');
    expect(puts).toHaveLength(1);
    expect(deletes).toHaveLength(1);
  });

  it('throws on resourceTree.stackName / cfnStackName mismatch up front', async () => {
    const tree: CfnStackResourceTree = {
      stackName: 'WrongName',
      physicalId: 'WrongName',
      resources: new Map(),
      nested: new Map(),
    };
    await expect(
      retireCloudFormationStack({
        cfnStackName: 'Right',
        cfnClient: { send: vi.fn() } as never,
        yes: true,
        stateBucket: 'state-bucket',
        resourceTree: tree,
      })
    ).rejects.toThrow(/resourceTree.stackName='WrongName' does not match cfnStackName='Right'/);
  });

  it('drains nested-template uploads when the user cancels at the confirmation prompt', async () => {
    // Regression for the code-reviewer-flagged leak on PR #564:
    // when `injectRetainPoliciesRecursive` had already uploaded one or
    // more transient child-template bodies BEFORE the interactive
    // confirmation prompt fired, a user `n` answer would return
    // `outcome: 'cancelled'` without draining the cleanups — leaking
    // S3 objects under the `cdkd-migrate-tmp/` prefix.
    const childArn = 'arn:aws:cloudformation:...:stack/Child/uuid';
    const parentBody = JSON.stringify({
      Resources: {
        P: { Type: 'AWS::S3::Bucket', Properties: {} },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://old/child.json' },
        },
      },
    });
    const childBody = JSON.stringify({
      Resources: { C: { Type: 'AWS::S3::Bucket', Properties: {} } },
    });
    const tree: CfnStackResourceTree = {
      stackName: 'Parent',
      physicalId: 'Parent',
      resources: new Map([
        ['P', 'p'],
        ['Child', childArn],
      ]),
      nested: new Map([
        [
          'Child',
          {
            stackName: childArn,
            physicalId: childArn,
            resources: new Map([['C', 'c']]),
            nested: new Map(),
          },
        ],
      ]),
    };
    const { client } = buildCfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      // First GetTemplate = parent, second = child. The recursive walk
      // pre-fetches both BEFORE the prompt fires.
      GetTemplate: (() => {
        let n = 0;
        return () => ({ TemplateBody: ++n === 1 ? parentBody : childBody });
      })(),
    });
    // User declines the prompt.
    readlineQuestion.mockResolvedValue('n');

    const result = await retireCloudFormationStack({
      cfnStackName: 'Parent',
      cfnClient: client as never,
      yes: false,
      stateBucket: 'state-bucket',
      resourceTree: tree,
    });

    expect(result).toEqual({ outcome: 'cancelled' });
    // Child template was uploaded (PutObject) AND deleted (DeleteObject)
    // — the cancel path must reap the leak before returning.
    const puts = s3SendCalls.filter((c) => c.name === 'PutObject');
    const deletes = s3SendCalls.filter((c) => c.name === 'DeleteObject');
    expect(puts.length).toBeGreaterThanOrEqual(1);
    expect(deletes.length).toBe(puts.length);
  });
});
