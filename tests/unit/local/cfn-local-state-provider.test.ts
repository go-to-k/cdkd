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
const clientCtorOpts = vi.hoisted(() => [] as Array<{ region?: string }>);
const cfnSendMock = vi.hoisted(() =>
  vi.fn(async (_cmd: { _name: string; input: Record<string, unknown> }) => undefined)
);
const cfnDestroyMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: vi.fn((opts: { region?: string }) => {
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
