import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  }),
}));

// Hoisted FakeCommand classes so vi.mock factory sees them at hoist time.
const cfnCommands = vi.hoisted(() => {
  class FakeCommand {
    public _name: string;
    public input: Record<string, unknown>;
    constructor(name: string, input: Record<string, unknown>) {
      this._name = name;
      this.input = input;
    }
  }
  return {
    DescribeStacksCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeStacks', input);
      }
    },
    DescribeStackResourcesCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeStackResources', input);
      }
    },
    ListExportsCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('ListExports', input);
      }
    },
  };
});

interface SentCall {
  name: string;
  input: Record<string, unknown>;
}

const sentCalls = vi.hoisted(() => [] as SentCall[]);
const clientCtorOpts = vi.hoisted(() => [] as Array<{ region?: string; profile?: string }>);
const cfnSendMock = vi.hoisted(() =>
  vi.fn(async (_cmd: { _name: string; input: Record<string, unknown> }): Promise<unknown> => undefined)
);
const cfnDestroyMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: vi.fn((opts: { region?: string; profile?: string }) => {
    clientCtorOpts.push(opts);
    return {
      send: async (cmd: { _name: string; input: Record<string, unknown> }) => {
        sentCalls.push({ name: cmd._name, input: cmd.input });
        return cfnSendMock(cmd);
      },
      destroy: cfnDestroyMock,
    };
  }),
  DescribeStacksCommand: cfnCommands.DescribeStacksCommand,
  DescribeStackResourcesCommand: cfnCommands.DescribeStackResourcesCommand,
  ListExportsCommand: cfnCommands.ListExportsCommand,
}));

import {
  CfnLocalStateProvider,
  buildResourceStateMap,
  buildOutputsMap,
  fetchAllExports,
  formatAwsErrorForWarn,
} from '../../../src/local/cfn-local-state-provider.js';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';

beforeEach(() => {
  warnSpy.mockReset();
  debugSpy.mockReset();
  sentCalls.length = 0;
  clientCtorOpts.length = 0;
  cfnSendMock.mockReset();
  cfnDestroyMock.mockReset();
});

describe('buildResourceStateMap', () => {
  it('builds a synthetic ResourceState per (LogicalId, PhysicalId, Type) tuple', () => {
    const out = buildResourceStateMap([
      { LogicalResourceId: 'Table', PhysicalResourceId: 'MyTable', ResourceType: 'AWS::DynamoDB::Table' },
      { LogicalResourceId: 'Func', PhysicalResourceId: 'my-func-abc', ResourceType: 'AWS::Lambda::Function' },
    ]);
    expect(Object.keys(out).sort()).toEqual(['Func', 'Table']);
    expect(out['Table']).toEqual({
      physicalId: 'MyTable',
      resourceType: 'AWS::DynamoDB::Table',
      properties: {},
      attributes: {},
      dependencies: [],
    });
    expect(out['Func']).toEqual({
      physicalId: 'my-func-abc',
      resourceType: 'AWS::Lambda::Function',
      properties: {},
      attributes: {},
      dependencies: [],
    });
  });

  it('skips half-populated entries (no LogicalResourceId / PhysicalResourceId / ResourceType)', () => {
    const out = buildResourceStateMap([
      { LogicalResourceId: 'Good', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      { LogicalResourceId: 'NoPhysical', ResourceType: 'AWS::S3::Bucket' },
      { PhysicalResourceId: 'p2', ResourceType: 'AWS::S3::Bucket' },
      { LogicalResourceId: 'NoType', PhysicalResourceId: 'p3' },
      {},
    ]);
    expect(Object.keys(out)).toEqual(['Good']);
  });
});

describe('buildOutputsMap', () => {
  it('builds a stringly-typed map from DescribeStacks.Outputs[]', () => {
    const out = buildOutputsMap([
      { OutputKey: 'TableName', OutputValue: 'MyTable' },
      { OutputKey: 'FuncArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:f' },
    ]);
    expect(out).toEqual({
      TableName: 'MyTable',
      FuncArn: 'arn:aws:lambda:us-east-1:123:function:f',
    });
  });

  it('skips entries with missing OutputKey or OutputValue', () => {
    const out = buildOutputsMap([
      { OutputKey: 'A', OutputValue: '1' },
      { OutputValue: 'orphan-value' },
      { OutputKey: 'orphan-key' },
      {},
    ]);
    expect(out).toEqual({ A: '1' });
  });
});

describe('fetchAllExports', () => {
  it('walks every page of ListExports and merges into a single map', async () => {
    // 2-page response: page 1 returns A+B with NextToken; page 2 returns C with no NextToken.
    cfnSendMock.mockImplementationOnce(async () => ({
      Exports: [
        { Name: 'A', Value: 'a-value' },
        { Name: 'B', Value: 'b-value' },
      ],
      NextToken: 'tok-1',
    }));
    cfnSendMock.mockImplementationOnce(async () => ({
      Exports: [{ Name: 'C', Value: 'c-value' }],
    }));
    const client = new CloudFormationClient({ region: 'us-east-1' });
    const result = await fetchAllExports(client);
    expect(result.size).toBe(3);
    expect(result.get('A')).toBe('a-value');
    expect(result.get('B')).toBe('b-value');
    expect(result.get('C')).toBe('c-value');
    expect(sentCalls.map((c) => c.name)).toEqual(['ListExports', 'ListExports']);
    expect(sentCalls[1]!.input).toEqual({ NextToken: 'tok-1' });
  });

  it('skips export entries with missing Name or Value', async () => {
    cfnSendMock.mockImplementationOnce(async () => ({
      Exports: [
        { Name: 'A', Value: 'a' },
        { Value: 'orphan-value' },
        { Name: 'orphan-name' },
      ],
    }));
    const client = new CloudFormationClient({ region: 'us-east-1' });
    const result = await fetchAllExports(client);
    expect(result.size).toBe(1);
    expect(result.get('A')).toBe('a');
  });

  it('throws on a NextToken loop > 50 pages (defense against malformed pagination)', async () => {
    cfnSendMock.mockImplementation(async () => ({
      Exports: [{ Name: 'X', Value: 'x' }],
      NextToken: 'always-the-same',
    }));
    const client = new CloudFormationClient({ region: 'us-east-1' });
    await expect(fetchAllExports(client)).rejects.toThrow(/pagination exceeded 50 pages/);
  });

  // Issue #611 test gap: the existing 2-page test exercises pagination but
  // no test directly asserts the canonical `{ Exports: [...] }` (no
  // NextToken) shape works correctly. A regression that always sends
  // `NextToken: undefined` instead of omitting the field (via the
  // `...nextToken !== undefined && {...}` spread) would slip through
  // because AWS tolerates it.
  it('does exactly 1 ListExports send when the response omits NextToken (no second page)', async () => {
    cfnSendMock.mockImplementationOnce(async () => ({
      Exports: [
        { Name: 'A', Value: 'a-value' },
        { Name: 'B', Value: 'b-value' },
      ],
      // No NextToken — single page.
    }));
    const client = new CloudFormationClient({ region: 'us-east-1' });
    const result = await fetchAllExports(client);
    expect(result.size).toBe(2);
    expect(result.get('A')).toBe('a-value');
    expect(result.get('B')).toBe('b-value');
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0]!.name).toBe('ListExports');
    // The first-page call must omit the `NextToken` field entirely
    // (the `...nextToken !== undefined && { NextToken: ... }` spread
    // produces an empty object when nextToken is undefined).
    expect(sentCalls[0]!.input).toEqual({});
    expect('NextToken' in sentCalls[0]!.input).toBe(false);
  });

  // Issue #611 test gap: `resp.Exports ?? []` guard is currently
  // untested. Cover both shapes AWS could return on an empty account.
  it('returns an empty map when Exports is an empty array', async () => {
    cfnSendMock.mockImplementationOnce(async () => ({ Exports: [] }));
    const client = new CloudFormationClient({ region: 'us-east-1' });
    const result = await fetchAllExports(client);
    expect(result.size).toBe(0);
    expect(sentCalls).toHaveLength(1);
  });

  it('returns an empty map when Exports is undefined', async () => {
    cfnSendMock.mockImplementationOnce(async () => ({ Exports: undefined }));
    const client = new CloudFormationClient({ region: 'us-east-1' });
    const result = await fetchAllExports(client);
    expect(result.size).toBe(0);
    expect(sentCalls).toHaveLength(1);
  });

  // Issue #611 NIT 3: defense against `NextToken === ''`. The SDK type
  // allows `string | undefined`; the loop condition is
  // `nextToken !== undefined && nextToken !== ''` so an empty string
  // terminates the walk and we do NOT fire a second `ListExports`.
  it('treats an empty-string NextToken as terminal (no follow-up page)', async () => {
    cfnSendMock.mockImplementationOnce(async () => ({
      Exports: [
        { Name: 'OnlyPage', Value: 'only-value' },
      ],
      NextToken: '',
    }));
    const client = new CloudFormationClient({ region: 'us-east-1' });
    const result = await fetchAllExports(client);
    expect(result.size).toBe(1);
    expect(result.get('OnlyPage')).toBe('only-value');
    expect(sentCalls).toHaveLength(1);
  });
});

describe('CfnLocalStateProvider.load — happy path', () => {
  it('returns LocalStateRecord with resources + outputs populated and region echoed', async () => {
    cfnSendMock.mockImplementation(async (cmd) => {
      if (cmd._name === 'DescribeStackResources') {
        return {
          StackResources: [
            {
              LogicalResourceId: 'Table',
              PhysicalResourceId: 'MyTable',
              ResourceType: 'AWS::DynamoDB::Table',
            },
            {
              LogicalResourceId: 'Func',
              PhysicalResourceId: 'my-func-abc',
              ResourceType: 'AWS::Lambda::Function',
            },
          ],
        };
      }
      if (cmd._name === 'DescribeStacks') {
        return {
          Stacks: [
            {
              StackName: 'MyCfnStack',
              Outputs: [
                { OutputKey: 'TableName', OutputValue: 'MyTable' },
                { OutputKey: 'FuncArn', OutputValue: 'arn:...' },
              ],
            },
          ],
        };
      }
      throw new Error(`Unexpected: ${cmd._name}`);
    });

    const provider = new CfnLocalStateProvider({
      cfnStackName: 'MyCfnStack',
      region: 'us-east-1',
    });
    const record = await provider.load('CdkdStackName', 'us-east-1');
    expect(record).toBeDefined();
    expect(record!.region).toBe('us-east-1');
    expect(Object.keys(record!.resources).sort()).toEqual(['Func', 'Table']);
    expect(record!.resources['Table']!.physicalId).toBe('MyTable');
    expect(record!.resources['Func']!.resourceType).toBe('AWS::Lambda::Function');
    expect(record!.outputs).toEqual({
      TableName: 'MyTable',
      FuncArn: 'arn:...',
    });
    provider.dispose();
  });
});

describe('CfnLocalStateProvider.load — failure modes', () => {
  it('returns undefined when DescribeStackResources throws (stack not found)', async () => {
    cfnSendMock.mockImplementationOnce(async () => {
      throw new Error('Stack with id MyCfnStack does not exist');
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'MyCfnStack',
      region: 'us-east-1',
    });
    const record = await provider.load('CdkdStackName', 'us-east-1');
    expect(record).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]![0]).toContain('--from-cfn-stack');
    expect(warnSpy.mock.calls[0]![0]).toContain('DescribeStackResources');
  });

  it('returns LocalStateRecord with empty outputs when DescribeStacks throws', async () => {
    cfnSendMock.mockImplementation(async (cmd) => {
      if (cmd._name === 'DescribeStackResources') {
        return {
          StackResources: [
            {
              LogicalResourceId: 'X',
              PhysicalResourceId: 'p',
              ResourceType: 'AWS::S3::Bucket',
            },
          ],
        };
      }
      if (cmd._name === 'DescribeStacks') {
        throw new Error('access denied');
      }
      throw new Error('unexpected');
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'MyCfnStack',
      region: 'us-east-1',
    });
    const record = await provider.load('CdkdStackName', 'us-east-1');
    expect(record).toBeDefined();
    expect(record!.outputs).toEqual({});
    expect(record!.resources['X']!.physicalId).toBe('p');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns LocalStateRecord with empty outputs when DescribeStacks returns no stack', async () => {
    cfnSendMock.mockImplementation(async (cmd) => {
      if (cmd._name === 'DescribeStackResources') {
        return { StackResources: [] };
      }
      if (cmd._name === 'DescribeStacks') {
        return { Stacks: [] };
      }
      throw new Error('unexpected');
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'MyCfnStack',
      region: 'us-east-1',
    });
    const record = await provider.load('CdkdStackName', 'us-east-1');
    expect(record).toBeDefined();
    expect(record!.outputs).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]![0]).toContain('returned no stack');
  });
});

describe('CfnLocalStateProvider — region routing', () => {
  it('constructs CloudFormationClient with the provided region', async () => {
    cfnSendMock.mockImplementation(async (cmd) => {
      if (cmd._name === 'DescribeStackResources') return { StackResources: [] };
      if (cmd._name === 'DescribeStacks') return { Stacks: [{}] };
      throw new Error('unexpected');
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-west-2',
    });
    await provider.load('X', undefined);
    expect(clientCtorOpts.some((o) => o.region === 'us-west-2')).toBe(true);
  });
});

describe('CfnLocalStateProvider — profile threading (Issue #628)', () => {
  it('threads `--profile` into the CloudFormationClient constructor when set', async () => {
    cfnSendMock.mockImplementation(async (cmd) => {
      if (cmd._name === 'DescribeStackResources') return { StackResources: [] };
      if (cmd._name === 'DescribeStacks') return { Stacks: [{}] };
      throw new Error('unexpected');
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
      profile: 'test-profile',
    });
    await provider.load('X', undefined);
    // The CFn client must be constructed with both region and profile
    // so the SDK reads creds from `~/.aws/credentials` / `~/.aws/config`
    // under [test-profile]. Pre-fix this option was captured but never
    // passed to the SDK, so `--profile` was silently ignored.
    const ctor = clientCtorOpts.find((o) => o.region === 'us-east-1');
    expect(ctor).toBeDefined();
    expect(ctor!.profile).toBe('test-profile');
  });

  it('omits `profile` from the CloudFormationClient constructor when not set', async () => {
    cfnSendMock.mockImplementation(async (cmd) => {
      if (cmd._name === 'DescribeStackResources') return { StackResources: [] };
      if (cmd._name === 'DescribeStacks') return { Stacks: [{}] };
      throw new Error('unexpected');
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
      // profile omitted — provider must fall back to the SDK default
      // credential chain (env vars / AWS_PROFILE / shared config /
      // IAM role) and NOT pass an explicit `profile` field, since a
      // literal `profile: undefined` would otherwise tell the SDK to
      // resolve a profile named `undefined`.
    });
    await provider.load('X', undefined);
    const ctor = clientCtorOpts.find((o) => o.region === 'us-east-1');
    expect(ctor).toBeDefined();
    expect('profile' in ctor!).toBe(false);
  });

  it('threads profile through buildCrossStackResolver as well (same lazy client)', async () => {
    cfnSendMock.mockImplementationOnce(async () => ({ Exports: [{ Name: 'A', Value: 'a' }] }));
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'eu-west-1',
      profile: 'another-profile',
    });
    const resolver = await provider.buildCrossStackResolver('eu-west-1');
    expect(resolver).toBeDefined();
    await resolver!.resolveImport('A');
    const ctor = clientCtorOpts.find((o) => o.region === 'eu-west-1');
    expect(ctor).toBeDefined();
    expect(ctor!.profile).toBe('another-profile');
  });
});

describe('CfnLocalStateProvider.buildCrossStackResolver', () => {
  it('resolves Fn::ImportValue via ListExports (paginated, page 2 hit)', async () => {
    cfnSendMock.mockImplementationOnce(async () => ({
      Exports: [{ Name: 'ProducerExport', Value: 'first-page-value' }],
      NextToken: 'tok',
    }));
    cfnSendMock.mockImplementationOnce(async () => ({
      Exports: [{ Name: 'TargetExport', Value: 'second-page-value' }],
    }));
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    const resolver = await provider.buildCrossStackResolver('us-east-1');
    expect(resolver).toBeDefined();
    const v = await resolver!.resolveImport('TargetExport');
    expect(v).toBe('second-page-value');
    // Subsequent lookups should not re-fetch (memoization).
    const before = sentCalls.length;
    await resolver!.resolveImport('ProducerExport');
    expect(sentCalls.length).toBe(before);
  });

  it('returns undefined and warns when ListExports throws', async () => {
    cfnSendMock.mockImplementationOnce(async () => {
      throw new Error('throttled');
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    const resolver = await provider.buildCrossStackResolver('us-east-1');
    expect(resolver).toBeDefined();
    const v = await resolver!.resolveImport('Any');
    expect(v).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('ListExports'))).toBe(true);
  });

  it('rejects Fn::GetStackOutput with a warn naming the cdkd-vs-CFn gap', async () => {
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    const resolver = await provider.buildCrossStackResolver('us-east-1');
    expect(resolver).toBeDefined();
    const v = await resolver!.resolveGetStackOutput('Producer', 'us-east-1', 'OutputName');
    expect(v).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]![0]).toContain('Fn::GetStackOutput');
    expect(warnSpy.mock.calls[0]![0]).toContain('cdkd-specific');
  });

  // Issue #611 test gap: `resolveImport(<missing>)` after cache is
  // populated must return `undefined` AND not fire another ListExports
  // walk. The "export not found" case was implicit in the impl but not
  // pinned by a test before.
  it('returns undefined for an exportName not in any page and does not refetch on miss', async () => {
    cfnSendMock.mockImplementationOnce(async () => ({
      Exports: [{ Name: 'Known', Value: 'known-value' }],
    }));
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    const resolver = await provider.buildCrossStackResolver('us-east-1');
    // Warm the cache with a hit so we know the walk completed.
    const hit = await resolver!.resolveImport('Known');
    expect(hit).toBe('known-value');
    const sentBefore = sentCalls.length;
    // Miss against a populated cache: undefined + no new send.
    const miss = await resolver!.resolveImport('NoSuchExport');
    expect(miss).toBeUndefined();
    expect(sentCalls.length).toBe(sentBefore);
  });

  // Issue #611 test gap (race): `cachedExports` is set only after the
  // `await fetchAllExports(...)` resolves, so two parallel callers may
  // BOTH find an empty cache and fire their own walks. Assert exactly
  // ONE ListExports send fires when two `resolveImport` calls are
  // awaited concurrently. This catches the race the existing serial
  // test cannot.
  it('fires ListExports exactly once when two resolveImport calls run in parallel', async () => {
    // Single-page response so the entire walk is one send. If the cache
    // races, the test sees 2 sends.
    cfnSendMock.mockImplementation(async () => ({
      Exports: [
        { Name: 'A', Value: 'a-value' },
        { Name: 'B', Value: 'b-value' },
      ],
    }));
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    const resolver = await provider.buildCrossStackResolver('us-east-1');
    const [a, b] = await Promise.all([
      resolver!.resolveImport('A'),
      resolver!.resolveImport('B'),
    ]);
    expect(a).toBe('a-value');
    expect(b).toBe('b-value');
    expect(sentCalls.filter((c) => c.name === 'ListExports')).toHaveLength(1);
  });
});

describe('CfnLocalStateProvider.dispose', () => {
  it('is safe to call before load (provider lazily constructs the client)', () => {
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    expect(() => provider.dispose()).not.toThrow();
    // Idempotent on repeat calls.
    expect(() => provider.dispose()).not.toThrow();
  });

  it('destroys the CFn client after load', async () => {
    cfnSendMock.mockImplementation(async (cmd) => {
      if (cmd._name === 'DescribeStackResources') return { StackResources: [] };
      if (cmd._name === 'DescribeStacks') return { Stacks: [{}] };
      throw new Error('unexpected');
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    await provider.load('X', undefined);
    provider.dispose();
    expect(cfnDestroyMock).toHaveBeenCalled();
  });

  // Issue #611 NIT 2: `dispose()` is terminal. The lazy `getClient()`
  // path would otherwise resurrect the client on a post-dispose `load`
  // call. Throw at every operational entry point so the bug surfaces
  // loudly.
  it('throws when load() is called after dispose() (terminal contract)', async () => {
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    provider.dispose();
    await expect(provider.load('X', undefined)).rejects.toThrow(
      /CfnLocalStateProvider used after dispose/
    );
  });

  it('throws when buildCrossStackResolver() is called after dispose() (terminal contract)', async () => {
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    provider.dispose();
    await expect(provider.buildCrossStackResolver('us-east-1')).rejects.toThrow(
      /CfnLocalStateProvider used after dispose/
    );
  });
});

describe('formatAwsErrorForWarn (Issue #611 NIT 4)', () => {
  it('includes the SDK error name and HTTP status when both are present', () => {
    const err = new Error('User: arn:... is not authorized to perform: cloudformation:ListExports');
    err.name = 'AccessDeniedException';
    (err as { $metadata?: { httpStatusCode?: number } }).$metadata = { httpStatusCode: 403 };
    const out = formatAwsErrorForWarn(err);
    expect(out).toContain('AccessDeniedException');
    expect(out).toContain('HTTP 403');
    expect(out).toContain('not authorized');
  });

  it('includes only the name when $metadata is absent', () => {
    const err = new Error('Rate exceeded');
    err.name = 'ThrottlingException';
    expect(formatAwsErrorForWarn(err)).toBe('ThrottlingException: Rate exceeded');
  });

  it('falls back to the bare message when name === "Error" and no $metadata', () => {
    const err = new Error('boom');
    expect(formatAwsErrorForWarn(err)).toBe('boom');
  });

  it('coerces non-Error throws to a string', () => {
    expect(formatAwsErrorForWarn('plain-string-throw')).toBe('plain-string-throw');
    expect(formatAwsErrorForWarn(42)).toBe('42');
  });
});

describe('CfnLocalStateProvider — SDK error code surfacing (Issue #611 NIT 4)', () => {
  it('includes the SDK error name in the DescribeStackResources warn (e.g. AccessDeniedException)', async () => {
    cfnSendMock.mockImplementationOnce(async () => {
      const err = new Error('User is not authorized to perform: cloudformation:DescribeStackResources');
      err.name = 'AccessDeniedException';
      (err as { $metadata?: { httpStatusCode?: number } }).$metadata = { httpStatusCode: 403 };
      throw err;
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'MyCfnStack',
      region: 'us-east-1',
    });
    const record = await provider.load('X', undefined);
    expect(record).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    const msg = String(warnSpy.mock.calls[0]![0]);
    expect(msg).toContain('DescribeStackResources');
    expect(msg).toContain('AccessDeniedException');
    expect(msg).toContain('HTTP 403');
  });

  it('includes the SDK error name in the ListExports warn (e.g. ThrottlingException)', async () => {
    cfnSendMock.mockImplementationOnce(async () => {
      const err = new Error('Rate exceeded');
      err.name = 'ThrottlingException';
      (err as { $metadata?: { httpStatusCode?: number } }).$metadata = { httpStatusCode: 400 };
      throw err;
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    const resolver = await provider.buildCrossStackResolver('us-east-1');
    const v = await resolver!.resolveImport('Anything');
    expect(v).toBeUndefined();
    const listExportsWarn = warnSpy.mock.calls.find((args) =>
      String(args[0]).includes('ListExports')
    );
    expect(listExportsWarn).toBeDefined();
    expect(String(listExportsWarn![0])).toContain('ThrottlingException');
    expect(String(listExportsWarn![0])).toContain('HTTP 400');
  });
});

describe('CfnLocalStateProvider — label', () => {
  it('exposes "--from-cfn-stack" as its label so warns are attributable', () => {
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'X',
      region: 'us-east-1',
    });
    expect(provider.label).toBe('--from-cfn-stack');
  });
});
