import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// ---- Hoisted mocks ----

const waitUntilChangeSetCreateCompleteMock = vi.hoisted(() => vi.fn());

class FakeCommand {
  constructor(
    public readonly _name: string,
    public readonly input: Record<string, unknown>
  ) {}
}

const cfnCommands = vi.hoisted(() => {
  class FakeCfnCommand {
    constructor(
      public readonly _name: string,
      public readonly input: Record<string, unknown>
    ) {}
  }
  return {
    CreateChangeSetCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('CreateChangeSet', input);
      }
    },
    DescribeChangeSetCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeChangeSet', input);
      }
    },
    GetTemplateCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('GetTemplate', input);
      }
    },
    DeleteChangeSetCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('DeleteChangeSet', input);
      }
    },
    DeleteStackCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('DeleteStack', input);
      }
    },
  };
});

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: vi.fn(),
  CreateChangeSetCommand: cfnCommands.CreateChangeSetCommand,
  DescribeChangeSetCommand: cfnCommands.DescribeChangeSetCommand,
  GetTemplateCommand: cfnCommands.GetTemplateCommand,
  DeleteChangeSetCommand: cfnCommands.DeleteChangeSetCommand,
  DeleteStackCommand: cfnCommands.DeleteStackCommand,
  waitUntilChangeSetCreateComplete: waitUntilChangeSetCreateCompleteMock,
}));

// S3 mocks for the >51,200-byte TemplateURL fallback path.
const s3SendMock = vi.hoisted(() => vi.fn(async () => ({})));
const s3DestroyMock = vi.hoisted(() => vi.fn());
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

const resolveBucketRegionMock = vi.hoisted(() => vi.fn(async () => 'us-east-1'));
vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveBucketRegion: resolveBucketRegionMock,
}));

// Logger mock (no-op + child)
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { expandMacros } from '../../../src/synthesis/macro-expander.js';
import { MacroExpansionError } from '../../../src/utils/error-handler.js';

interface SendCall {
  name: string;
  input: Record<string, unknown>;
}

function buildCfnClient(
  responses: Partial<Record<string, unknown | (() => unknown) | Error>>
): { client: { send: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const send = vi.fn(async (cmd: FakeCommand) => {
    calls.push({ name: cmd._name, input: cmd.input });
    const r = responses[cmd._name];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return (r as () => unknown)();
    if (r === undefined) {
      // Tolerate cleanup calls without an explicit response.
      if (cmd._name === 'DeleteChangeSet' || cmd._name === 'DeleteStack') return {};
      throw new Error(`Unexpected CFn command: ${cmd._name}`);
    }
    return r;
  });
  return { client: { send, destroy: vi.fn() } as never, calls };
}

const SAM_TEMPLATE = {
  Transform: ['AWS::Serverless-2016-10-31'],
  Resources: {
    Fn: {
      Type: 'AWS::Serverless::Function',
      Properties: {
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        InlineCode: 'exports.handler = async () => ({ statusCode: 200 });',
      },
    },
  },
};

const EXPANDED_TEMPLATE = {
  Resources: {
    Fn: { Type: 'AWS::Lambda::Function', Properties: {} },
    FnRole: { Type: 'AWS::IAM::Role', Properties: {} },
  },
};

const OPTS = {
  region: 'us-east-1',
  stateBucket: 'cdkd-state-123456789012',
};

beforeEach(() => {
  waitUntilChangeSetCreateCompleteMock.mockReset();
  s3SendMock.mockReset();
  s3SendMock.mockResolvedValue({});
  s3DestroyMock.mockReset();
  resolveBucketRegionMock.mockReset();
  resolveBucketRegionMock.mockResolvedValue('us-east-1');
});

describe('expandMacros — happy path', () => {
  it('CreateChangeSet → wait → GetTemplate Processed → DeleteChangeSet → DeleteStack', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client, calls } = buildCfnClient({
      CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    const result = await expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never });
    expect(result.Resources).toEqual(EXPANDED_TEMPLATE.Resources);
    // Major 3: cleanup is DeleteStack only (no DeleteChangeSet —
    // DeleteStack CASCADE-deletes the changeset, so an explicit
    // DeleteChangeSet would race on DELETE_PENDING under load).
    expect(calls.map((c) => c.name)).toEqual(['CreateChangeSet', 'GetTemplate', 'DeleteStack']);
    const createCmd = calls[0]!;
    expect(createCmd.input['StackName']).toMatch(/^cdkd-macro-expand-/);
    expect(createCmd.input['ChangeSetType']).toBe('CREATE');
    expect(createCmd.input['Capabilities']).toEqual([
      'CAPABILITY_AUTO_EXPAND',
      'CAPABILITY_NAMED_IAM',
      'CAPABILITY_IAM',
    ]);
    // No Parameters block on the input template, so no Parameters input
    // forwarded.
    expect(createCmd.input['Parameters']).toBeUndefined();
    expect(createCmd.input['TemplateBody']).toBeTypeOf('string');
  });

  it('accepts a TemplateBody returned as a JSON string', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: JSON.stringify(EXPANDED_TEMPLATE) },
    });
    const result = await expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never });
    expect(result.Resources).toEqual(EXPANDED_TEMPLATE.Resources);
  });

  it('passes synthetic placeholder values for declared no-Default parameters', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client, calls } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    const tpl = {
      Transform: ['AWS::Serverless-2016-10-31'],
      Parameters: {
        EnvName: { Type: 'String' }, // no Default → placeholder
        StageName: { Type: 'String', Default: 'prod' }, // Default → use it
      },
      Resources: {
        Fn: { Type: 'AWS::Serverless::Function', Properties: {} },
      },
    };
    await expandMacros(tpl, { ...OPTS, cfnClient: client as never });
    const params = calls[0]!.input['Parameters'] as Array<{
      ParameterKey: string;
      ParameterValue: string;
    }>;
    expect(params).toEqual([
      { ParameterKey: 'EnvName', ParameterValue: 'cdkd-macro-expand-placeholder' },
      { ParameterKey: 'StageName', ParameterValue: 'prod' },
    ]);
  });

  it('returns the template unchanged when no macro is detected (no-op short-circuit)', async () => {
    const { client, calls } = buildCfnClient({});
    const plain = { Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } } };
    const result = await expandMacros(plain, { ...OPTS, cfnClient: client as never });
    expect(result).toBe(plain); // identity preserved
    expect(calls).toEqual([]);
  });
});

describe('expandMacros — error paths', () => {
  it('CreateChangeSet rejection wraps as MacroExpansionError', async () => {
    const { client, calls } = buildCfnClient({
      CreateChangeSet: new Error('User: arn:aws:iam::123:user/x is not authorized'),
    });
    await expect(
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
    ).rejects.toThrow(MacroExpansionError);
    // Cleanup still runs — only DeleteStack (Major 3 fix: DeleteStack
    // CASCADE-deletes the changeset, so an explicit DeleteChangeSet
    // before this would race on DELETE_PENDING under load).
    expect(calls.map((c) => c.name)).toEqual(['CreateChangeSet', 'DeleteStack']);
  });

  it('FAILED status surfaces StatusReason from DescribeChangeSet verbatim', async () => {
    waitUntilChangeSetCreateCompleteMock.mockRejectedValue(new Error('waiter failed'));
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      DescribeChangeSet: {
        Status: 'FAILED',
        StatusReason: 'Transform AWS::Serverless-2016-10-31 returned: foo error',
      },
    });
    await expect(
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
    ).rejects.toThrow(/Transform AWS::Serverless-2016-10-31 returned: foo error/);
  });

  it('GetTemplate returning empty TemplateBody surfaces a clear error', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: {},
    });
    await expect(
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
    ).rejects.toThrow(/no Processed-stage template body/);
  });

  it('multi-stage macros (expanded template still contains a macro) reject explicitly', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const stillContainsMacro = {
      Resources: {
        R: { Type: 'AWS::Foo', Properties: { 'Fn::Transform': { Name: 'NestedMacro' } } },
      },
    };
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: stillContainsMacro },
    });
    await expect(
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
    ).rejects.toThrow(/Multi-stage macros/);
  });

  it('cleanup runs (DeleteStack only) even when GetTemplate throws', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client, calls } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: new Error('boom'),
    });
    await expect(
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
    ).rejects.toThrow();
    expect(calls.map((c) => c.name)).toContain('DeleteStack');
    // Major 3: no explicit DeleteChangeSet (DeleteStack CASCADEs).
    expect(calls.map((c) => c.name)).not.toContain('DeleteChangeSet');
  });

  it('cleanup-call failures (DeleteStack throwing) do not mask the outer error', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
      DeleteStack: new Error('not found'),
    });
    // Should still resolve successfully — cleanup failures are
    // logged-and-swallowed, not propagated.
    const result = await expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never });
    expect(result.Resources).toEqual(EXPANDED_TEMPLATE.Resources);
  });
});

describe('expandMacros — TemplateURL fallback (over 51,200 bytes)', () => {
  it('uploads to S3 and submits TemplateURL when template exceeds the inline ceiling', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    // Build a template > 51,200 bytes by inflating a property string.
    const big = {
      Transform: ['AWS::Serverless-2016-10-31'],
      Resources: {
        Fn: {
          Type: 'AWS::Serverless::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            InlineCode: 'x'.repeat(60_000),
          },
        },
      },
    };
    const { client, calls } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    await expandMacros(big, { ...OPTS, cfnClient: client as never });
    // S3 PutObject ran during upload.
    expect(s3SendMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const putCmd = s3SendMock.mock.calls[0]?.[0] as { _name: string; input: Record<string, unknown> };
    expect(putCmd._name).toBe('PutObject');
    expect(putCmd.input['Key']).toMatch(/^cdkd-migrate-tmp\/cdkd-macro-expand-/);
    // CreateChangeSet input used TemplateURL, not TemplateBody.
    expect(calls[0]!.input['TemplateBody']).toBeUndefined();
    expect(calls[0]!.input['TemplateURL']).toMatch(/^https:\/\//);
  });

  it('refuses templates over the 1 MB TemplateURL ceiling with an actionable error', async () => {
    const huge = {
      Transform: ['AWS::Serverless-2016-10-31'],
      Resources: {
        Fn: {
          Type: 'AWS::Serverless::Function',
          Properties: { InlineCode: 'x'.repeat(1_500_000) },
        },
      },
    };
    const { client } = buildCfnClient({});
    await expect(
      expandMacros(huge, { ...OPTS, cfnClient: client as never })
    ).rejects.toThrow(/exceeds CloudFormation's 1048576-byte TemplateURL ceiling/);
  });
});

/**
 * Type-aware Parameter placeholders (BLOCKER 2 fix): CFn validates
 * Parameter Type BEFORE the macro Lambda runs, so a bare-string
 * placeholder against a `Number` / `List<Number>` / `AWS::EC2::*::Id`
 * Parameter rejects `CreateChangeSet` with a type error. The
 * Type-aware placeholder table emits a value CFn's pre-macro
 * validator accepts.
 */
describe('expandMacros — Type-aware Parameter placeholders', () => {
  type ParamCase = {
    name: string;
    type: string;
    expected: string;
  };

  const CASES: ParamCase[] = [
    { name: 'String', type: 'String', expected: 'cdkd-macro-expand-placeholder' },
    { name: 'Number', type: 'Number', expected: '0' },
    { name: 'List<Number>', type: 'List<Number>', expected: '0' },
    { name: 'CommaDelimitedList', type: 'CommaDelimitedList', expected: '' },
    {
      name: 'AWS::EC2::AvailabilityZone::Name',
      type: 'AWS::EC2::AvailabilityZone::Name',
      expected: 'us-east-1a',
    },
    {
      name: 'AWS::EC2::SecurityGroup::Id',
      type: 'AWS::EC2::SecurityGroup::Id',
      expected: 'sg-00000000',
    },
    { name: 'AWS::EC2::VPC::Id', type: 'AWS::EC2::VPC::Id', expected: 'vpc-00000000' },
    {
      name: 'AWS::SSM::Parameter::Value<String>',
      type: 'AWS::SSM::Parameter::Value<String>',
      expected: 'placeholder',
    },
  ];

  it.each(CASES)(
    'emits the right placeholder for $name when no Default is set',
    async ({ type, expected }) => {
      waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
      const { client, calls } = buildCfnClient({
        CreateChangeSet: { Id: 'cs', StackId: 's' },
        GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
      });
      const tpl = {
        Transform: ['AWS::Serverless-2016-10-31'],
        Parameters: { P: { Type: type } },
        Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
      };
      await expandMacros(tpl, { ...OPTS, cfnClient: client as never });
      const params = calls[0]!.input['Parameters'] as Array<{
        ParameterKey: string;
        ParameterValue: string;
      }>;
      expect(params).toEqual([{ ParameterKey: 'P', ParameterValue: expected }]);
    }
  );

  it('emits a generic placeholder + warn for an unknown Type', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client, calls } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    const tpl = {
      Transform: ['AWS::Serverless-2016-10-31'],
      Parameters: { Bogus: { Type: 'AWS::Made::Up::Type' } },
      Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
    };
    await expandMacros(tpl, { ...OPTS, cfnClient: client as never });
    const params = calls[0]!.input['Parameters'] as Array<{
      ParameterKey: string;
      ParameterValue: string;
    }>;
    // Falls back to the generic string placeholder rather than crashing.
    expect(params).toEqual([
      { ParameterKey: 'Bogus', ParameterValue: 'cdkd-macro-expand-placeholder' },
    ]);
  });

  it('a Parameter with Default takes precedence over the Type-aware placeholder', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client, calls } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    const tpl = {
      Transform: ['AWS::Serverless-2016-10-31'],
      Parameters: {
        Count: { Type: 'Number', Default: 42 }, // explicit Default → '42'
      },
      Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
    };
    await expandMacros(tpl, { ...OPTS, cfnClient: client as never });
    const params = calls[0]!.input['Parameters'] as Array<{
      ParameterKey: string;
      ParameterValue: string;
    }>;
    expect(params).toEqual([{ ParameterKey: 'Count', ParameterValue: '42' }]);
  });
});

/**
 * Concurrent-call UUID independence: each `expandMacros(...)` call
 * computes `randomUUID().slice(0, 8)` AT call time (not at module
 * load), so two concurrent invocations produce different transient
 * stack names. Regression guard against accidental hoisting of the
 * UUID into a module-level constant.
 */
describe('expandMacros — concurrent UUID independence', () => {
  it('two concurrent calls produce different transient stack names', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client: clientA, calls: callsA } = buildCfnClient({
      CreateChangeSet: { Id: 'csA', StackId: 'sA' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    const { client: clientB, calls: callsB } = buildCfnClient({
      CreateChangeSet: { Id: 'csB', StackId: 'sB' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    await Promise.all([
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: clientA as never }),
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: clientB as never }),
    ]);
    const nameA = callsA[0]!.input['StackName'] as string;
    const nameB = callsB[0]!.input['StackName'] as string;
    expect(nameA).toMatch(/^cdkd-macro-expand-/);
    expect(nameB).toMatch(/^cdkd-macro-expand-/);
    expect(nameA).not.toBe(nameB);
  });
});
