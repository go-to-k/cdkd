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
const s3SendMock = vi.hoisted(() => vi.fn(async (_cmd: unknown) => ({})));
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

// Logger mock — surface `warn` / `debug` calls so tests can assert
// on cleanup-failure WARN paths (TR-MJ4) and other diagnostic logs.
const loggerWarnMock = vi.hoisted(() => vi.fn());
const loggerDebugMock = vi.hoisted(() => vi.fn());
const loggerInfoMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: loggerDebugMock,
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    child: () => ({
      debug: loggerDebugMock,
      info: loggerInfoMock,
      warn: loggerWarnMock,
      error: loggerErrorMock,
    }),
  }),
}));

import { expandMacros, retryDelays } from '../../../src/synthesis/macro-expander.js';
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
  loggerWarnMock.mockReset();
  loggerDebugMock.mockReset();
  loggerInfoMock.mockReset();
  loggerErrorMock.mockReset();
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

  // TR-MF1: STRING form Transform (not array). The detector already
  // accepts both `Transform: '...'` and `Transform: ['...']` shapes;
  // this test pins the expander's behavior end-to-end on the string
  // form so a future detector refactor cannot silently change it.
  it('expands a template with STRING-form Transform (Transform: "AWS::Serverless-...")', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client, calls } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    const tpl = {
      Transform: 'AWS::Serverless-2016-10-31', // STRING, not array
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
    const result = await expandMacros(tpl, { ...OPTS, cfnClient: client as never });
    expect(result.Resources).toEqual(EXPANDED_TEMPLATE.Resources);
    // Same flow as the array-form happy path: 3 calls in order.
    expect(calls.map((c) => c.name)).toEqual(['CreateChangeSet', 'GetTemplate', 'DeleteStack']);
  });

  // TR-MJ3: nested Fn::Transform ONLY (no top-level Transform). The
  // detector returns true on this shape too (Fn::Transform anywhere
  // under Resources / Outputs / Mappings / Conditions / Rules), so
  // the expander should still kick in.
  it('expands a template with nested Fn::Transform but no top-level Transform', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client, calls } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    const tpl = {
      // NO top-level Transform.
      Resources: {
        IncludedBucket: {
          'Fn::Transform': {
            Name: 'AWS::Include',
            Parameters: { Location: 's3://bucket/snippets/bucket.json' },
          },
        },
      },
    };
    const result = await expandMacros(tpl, { ...OPTS, cfnClient: client as never });
    expect(result.Resources).toEqual(EXPANDED_TEMPLATE.Resources);
    expect(calls.map((c) => c.name)).toEqual(['CreateChangeSet', 'GetTemplate', 'DeleteStack']);
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

  // TR-MJ5: waiter fails AND the follow-up DescribeChangeSet also
  // throws. The expander's existing `.catch(() => undefined)` swallows
  // the describe failure, the StatusReason falls back to
  // 'unknown (DescribeChangeSet failed)', and the outer error names it.
  it('waiter failure with DescribeChangeSet also failing surfaces "unknown (DescribeChangeSet failed)"', async () => {
    waitUntilChangeSetCreateCompleteMock.mockRejectedValue(new Error('waiter timeout'));
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      DescribeChangeSet: new Error('AccessDenied: cloudformation:DescribeChangeSet'),
    });
    await expect(
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
    ).rejects.toThrow(/status=UNKNOWN.*unknown \(DescribeChangeSet failed\)/);
  });

  // TR-MJ6: realistic AWS SDK error shape (carries `name` +
  // `$metadata`) propagates through MacroExpansionError's `cause`
  // field. CR-MJ4 — operators rely on the `cause` chain to surface
  // the underlying SDK error class + httpStatusCode.
  it('preserves an AWS SDK-shaped error as MacroExpansionError.cause on CreateChangeSet rejection', async () => {
    // Mimic the wire shape of an aws-sdk-js-v3 ServiceException.
    const awsErr = Object.assign(new Error('ChangeSet [cs] failed validation'), {
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400, requestId: 'abc-123' },
    });
    const { client } = buildCfnClient({
      CreateChangeSet: awsErr,
    });
    try {
      await expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never });
      throw new Error('expected MacroExpansionError but no error was thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MacroExpansionError);
      // The MacroExpansionError must carry the original AWS error as
      // its `cause` — operators trace through to inspect $metadata.
      const cause = (err as Error).cause;
      expect(cause).toBe(awsErr);
      expect((cause as { name?: string }).name).toBe('ValidationException');
      expect(
        (cause as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      ).toBe(400);
    }
  });

  // TR-MJ6 (companion): waiter timeout also propagates through
  // MacroExpansionError.cause so operators can distinguish bounded
  // waiter timeout vs CFn-side FAILED status.
  it('preserves the waiter error as MacroExpansionError.cause on waiter timeout', async () => {
    const waiterTimeoutErr = Object.assign(new Error('Waiter has timed out'), {
      name: 'TimeoutError',
    });
    waitUntilChangeSetCreateCompleteMock.mockRejectedValue(waiterTimeoutErr);
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      DescribeChangeSet: { Status: 'CREATE_IN_PROGRESS', StatusReason: 'Still expanding' },
    });
    try {
      await expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never });
      throw new Error('expected MacroExpansionError but no error was thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MacroExpansionError);
      const cause = (err as Error).cause;
      expect(cause).toBe(waiterTimeoutErr);
      expect((cause as { name?: string }).name).toBe('TimeoutError');
    }
  });

  // CR-M2: malformed Processed-stage body (non-object at top level)
  // surfaces a structural-sanity-check error instead of being silently
  // cast to `CloudFormationTemplate` and crashing downstream.
  it('rejects a malformed Processed-stage body (non-object top level)', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      // CFn-side regression: TemplateBody is a string but not a JSON object.
      GetTemplate: { TemplateBody: '"a-string-not-an-object"' },
    });
    await expect(
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
    ).rejects.toThrow(/malformed Processed-stage template body.*expected a JSON object/);
  });

  // CR-M2: malformed `Resources` (string instead of object map) is
  // caught at the structural sanity check rather than producing a
  // crash deep in the analyzer pipeline.
  it('rejects a Processed-stage body whose Resources is not an object map', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: { Resources: 'not-an-object' } },
    });
    await expect(
      expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
    ).rejects.toThrow(/'Resources' must be an object map/);
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

  // TR-MJ4: cleanup-failure WARN on the TemplateURL upload path.
  // S3 PutObject succeeds (template uploaded; CreateChangeSet
  // consumes the URL), then `s3Cleanup` (DeleteObjectCommand) throws
  // during the finally block. The expander logs a WARN with the
  // recovery-prefix `cdkd-migrate-tmp/` and the offending bucket
  // name, then continues to surface the SUCCESSFUL expansion result.
  it('s3Cleanup failure → WARN with recovery hint, expansion still succeeds', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const big = {
      Transform: ['AWS::Serverless-2016-10-31'],
      Resources: {
        Fn: {
          Type: 'AWS::Serverless::Function',
          Properties: { InlineCode: 'x'.repeat(60_000) },
        },
      },
    };
    // Sequence the S3 client: first call (PutObject) succeeds, second
    // call (DeleteObject from cleanup) throws.
    s3SendMock.mockReset();
    s3SendMock
      .mockResolvedValueOnce({}) // PutObject succeeds
      .mockRejectedValueOnce(new Error('S3 AccessDenied'));
    const { client } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    // Expansion SUCCEEDS — cleanup failure must not mask the outcome.
    const result = await expandMacros(big, { ...OPTS, cfnClient: client as never });
    expect(result.Resources).toEqual(EXPANDED_TEMPLATE.Resources);
    // WARN was logged, naming the bucket + recovery-prefix.
    const warns = loggerWarnMock.mock.calls.map((c) => String(c[0]));
    const cleanupWarn = warns.find((w) => w.includes('cdkd-migrate-tmp/'));
    expect(cleanupWarn).toBeDefined();
    expect(cleanupWarn).toContain('cdkd-state-123456789012'); // the bucket name from OPTS
    expect(cleanupWarn).toContain('S3 AccessDenied'); // the underlying error message
    // And the recovery command's `aws s3 rm` form is present.
    expect(cleanupWarn).toContain('aws s3 rm');
  });

  // CR-MJ1: oversize template + no stateBucket → MacroExpansionError
  // with an actionable recovery hint, instead of leaking a sentinel
  // string into the S3 upload helper (the pre-PR behavior threaded
  // `'cdkd-state-unresolved-not-needed-for-inline'` and waited for
  // the underlying SDK call to reject).
  it('refuses oversize templates when stateBucket is undefined', async () => {
    const big = {
      Transform: ['AWS::Serverless-2016-10-31'],
      Resources: {
        Fn: {
          Type: 'AWS::Serverless::Function',
          Properties: { InlineCode: 'x'.repeat(60_000) },
        },
      },
    };
    const { client } = buildCfnClient({});
    await expect(
      expandMacros(big, {
        region: 'us-east-1',
        // NO stateBucket — testing that the upload branch rejects with
        // a clear MacroExpansionError naming --state-bucket.
        cfnClient: client as never,
      })
    ).rejects.toThrow(/cdkd needs a state bucket to upload.*--state-bucket/s);
  });

  // CR-MJ1 (companion): sub-51 KB templates DON'T need stateBucket,
  // so passing `undefined` should run the inline path cleanly.
  it('inline path (sub-51 KB) accepts undefined stateBucket without consulting it', async () => {
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    const { client, calls } = buildCfnClient({
      CreateChangeSet: { Id: 'cs', StackId: 's' },
      GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
    });
    const result = await expandMacros(SAM_TEMPLATE, {
      region: 'us-east-1',
      // NO stateBucket.
      cfnClient: client as never,
    });
    expect(result.Resources).toEqual(EXPANDED_TEMPLATE.Resources);
    // Inline TemplateBody was used; no S3 PutObject ran.
    expect(calls[0]!.input['TemplateBody']).toBeTypeOf('string');
    expect(calls[0]!.input['TemplateURL']).toBeUndefined();
    expect(s3SendMock).not.toHaveBeenCalled();
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

  // TR-MN8 (per feedback_codify_with_calibration_set.md): exhaustive
  // table covering every entry in PARAMETER_TYPE_PLACEHOLDERS plus the
  // SSM Parameter::Value<*> shape detection. A missing row in this
  // table on the next provider-extension PR fires a regression here
  // instead of surfacing at deploy time against AWS's pre-macro
  // validator.
  const CASES: ParamCase[] = [
    // Scalar / list scalar.
    { name: 'String', type: 'String', expected: 'cdkd-macro-expand-placeholder' },
    { name: 'Number', type: 'Number', expected: '0' },
    { name: 'List<Number>', type: 'List<Number>', expected: '0' },
    { name: 'CommaDelimitedList', type: 'CommaDelimitedList', expected: '' },
    { name: 'List<String>', type: 'List<String>', expected: '' },
    // AWS-specific scalars.
    {
      name: 'AWS::EC2::AvailabilityZone::Name',
      type: 'AWS::EC2::AvailabilityZone::Name',
      expected: 'us-east-1a',
    },
    { name: 'AWS::EC2::Image::Id', type: 'AWS::EC2::Image::Id', expected: 'ami-00000000' },
    { name: 'AWS::EC2::Instance::Id', type: 'AWS::EC2::Instance::Id', expected: 'i-00000000' },
    {
      name: 'AWS::EC2::KeyPair::KeyName',
      type: 'AWS::EC2::KeyPair::KeyName',
      expected: 'placeholder-key',
    },
    {
      name: 'AWS::EC2::SecurityGroup::GroupName',
      type: 'AWS::EC2::SecurityGroup::GroupName',
      expected: 'placeholder-sg',
    },
    {
      name: 'AWS::EC2::SecurityGroup::Id',
      type: 'AWS::EC2::SecurityGroup::Id',
      expected: 'sg-00000000',
    },
    { name: 'AWS::EC2::Subnet::Id', type: 'AWS::EC2::Subnet::Id', expected: 'subnet-00000000' },
    { name: 'AWS::EC2::Volume::Id', type: 'AWS::EC2::Volume::Id', expected: 'vol-00000000' },
    { name: 'AWS::EC2::VPC::Id', type: 'AWS::EC2::VPC::Id', expected: 'vpc-00000000' },
    {
      name: 'AWS::Route53::HostedZone::Id',
      type: 'AWS::Route53::HostedZone::Id',
      expected: 'Z00000000000000000000',
    },
    { name: 'AWS::SSM::Parameter::Name', type: 'AWS::SSM::Parameter::Name', expected: 'placeholder' },
    // AWS-specific lists.
    {
      name: 'List<AWS::EC2::AvailabilityZone::Name>',
      type: 'List<AWS::EC2::AvailabilityZone::Name>',
      expected: 'us-east-1a',
    },
    {
      name: 'List<AWS::EC2::Image::Id>',
      type: 'List<AWS::EC2::Image::Id>',
      expected: 'ami-00000000',
    },
    {
      name: 'List<AWS::EC2::Instance::Id>',
      type: 'List<AWS::EC2::Instance::Id>',
      expected: 'i-00000000',
    },
    {
      name: 'List<AWS::EC2::SecurityGroup::GroupName>',
      type: 'List<AWS::EC2::SecurityGroup::GroupName>',
      expected: 'placeholder-sg',
    },
    {
      name: 'List<AWS::EC2::SecurityGroup::Id>',
      type: 'List<AWS::EC2::SecurityGroup::Id>',
      expected: 'sg-00000000',
    },
    {
      name: 'List<AWS::EC2::Subnet::Id>',
      type: 'List<AWS::EC2::Subnet::Id>',
      expected: 'subnet-00000000',
    },
    {
      name: 'List<AWS::EC2::Volume::Id>',
      type: 'List<AWS::EC2::Volume::Id>',
      expected: 'vol-00000000',
    },
    {
      name: 'List<AWS::EC2::VPC::Id>',
      type: 'List<AWS::EC2::VPC::Id>',
      expected: 'vpc-00000000',
    },
    {
      name: 'List<AWS::Route53::HostedZone::Id>',
      type: 'List<AWS::Route53::HostedZone::Id>',
      expected: 'Z00000000000000000000',
    },
    // SSM Parameter::Value<...> fallbacks (CR-MJ3): scalar inner → single
    // placeholder, list inner → comma-delimited placeholder so CFn's
    // pre-macro Type validator accepts both forms.
    {
      name: 'AWS::SSM::Parameter::Value<String>',
      type: 'AWS::SSM::Parameter::Value<String>',
      expected: 'placeholder',
    },
    {
      name: 'AWS::SSM::Parameter::Value<AWS::EC2::VPC::Id>',
      type: 'AWS::SSM::Parameter::Value<AWS::EC2::VPC::Id>',
      expected: 'placeholder',
    },
    {
      name: 'AWS::SSM::Parameter::Value<List<String>>',
      type: 'AWS::SSM::Parameter::Value<List<String>>',
      expected: 'placeholder,placeholder',
    },
    {
      name: 'AWS::SSM::Parameter::Value<List<AWS::EC2::Subnet::Id>>',
      type: 'AWS::SSM::Parameter::Value<List<AWS::EC2::Subnet::Id>>',
      expected: 'placeholder,placeholder',
    },
    {
      name: 'AWS::SSM::Parameter::Value<CommaDelimitedList>',
      type: 'AWS::SSM::Parameter::Value<CommaDelimitedList>',
      expected: 'placeholder,placeholder',
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
 * computes `randomUUID().slice(0, 16)` AT call time (not at module
 * load), so two concurrent invocations produce different transient
 * stack names. Regression guard against accidental hoisting of the
 * UUID into a module-level constant. CR-MJ2 widened the slice from
 * 8 to 16 chars for stronger collision resistance; the test stays
 * unchanged because it only asserts the canonical `cdkd-macro-expand-`
 * prefix + distinct-suffix invariant.
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

describe('expandMacros — EarlyValidation hook retry (issue #1151)', () => {
  const EARLY_VALIDATION_REASON =
    'The following hook(s)/validation failed: [AWS::EarlyValidation::ResourceExistenceCheck]. ' +
    'To troubleshoot Early Validation errors, use the DescribeEvents API for detailed failure information.';

  it('retries an EarlyValidation-rejected changeset with a fresh transient stack and succeeds', async () => {
    const sleepSpy = vi.spyOn(retryDelays, 'sleep').mockResolvedValue(undefined);
    try {
      // Attempt 1: waiter fails, DescribeChangeSet reports the hook
      // rejection. Attempt 2: waiter passes, GetTemplate returns the
      // expanded template.
      waitUntilChangeSetCreateCompleteMock
        .mockRejectedValueOnce(new Error('waiter saw FAILED'))
        .mockResolvedValueOnce({});
      const { client, calls } = buildCfnClient({
        CreateChangeSet: { Id: 'cs', StackId: 's' },
        DescribeChangeSet: { Status: 'FAILED', StatusReason: EARLY_VALIDATION_REASON },
        GetTemplate: { TemplateBody: EXPANDED_TEMPLATE },
      });
      const result = await expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never });
      expect(result.Resources).toEqual(EXPANDED_TEMPLATE.Resources);
      const creates = calls.filter((c) => c.name === 'CreateChangeSet');
      expect(creates).toHaveLength(2);
      // Each attempt mints a FRESH transient stack name.
      expect(creates[0]!.input['StackName']).not.toBe(creates[1]!.input['StackName']);
      // The failed attempt's transient stack was cleaned up too (one
      // DeleteStack per attempt).
      expect(calls.filter((c) => c.name === 'DeleteStack')).toHaveLength(2);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(2000);
    } finally {
      sleepSpy.mockRestore();
    }
  });

  it('gives up after 3 consecutive EarlyValidation rejections with the original error', async () => {
    const sleepSpy = vi.spyOn(retryDelays, 'sleep').mockResolvedValue(undefined);
    try {
      waitUntilChangeSetCreateCompleteMock.mockRejectedValue(new Error('waiter saw FAILED'));
      const { client, calls } = buildCfnClient({
        CreateChangeSet: { Id: 'cs', StackId: 's' },
        DescribeChangeSet: { Status: 'FAILED', StatusReason: EARLY_VALIDATION_REASON },
      });
      await expect(
        expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
      ).rejects.toThrow(/AWS::EarlyValidation::ResourceExistenceCheck/);
      expect(calls.filter((c) => c.name === 'CreateChangeSet')).toHaveLength(3);
      // Exponential backoff: 2s then 4s.
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 2000);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 4000);
    } finally {
      sleepSpy.mockRestore();
    }
  });

  it('does NOT retry a FAILED changeset whose reason is not an EarlyValidation hook', async () => {
    const sleepSpy = vi.spyOn(retryDelays, 'sleep').mockResolvedValue(undefined);
    try {
      waitUntilChangeSetCreateCompleteMock.mockRejectedValue(new Error('waiter saw FAILED'));
      const { client, calls } = buildCfnClient({
        CreateChangeSet: { Id: 'cs', StackId: 's' },
        DescribeChangeSet: {
          Status: 'FAILED',
          StatusReason: 'No updates are to be performed.',
        },
      });
      await expect(
        expandMacros(SAM_TEMPLATE, { ...OPTS, cfnClient: client as never })
      ).rejects.toThrow(MacroExpansionError);
      expect(calls.filter((c) => c.name === 'CreateChangeSet')).toHaveLength(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    } finally {
      sleepSpy.mockRestore();
    }
  });
});
