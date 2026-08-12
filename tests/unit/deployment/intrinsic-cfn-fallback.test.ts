/**
 * Issue #1697 — CloudFormation fallback for cross-stack references.
 *
 * When an `Fn::ImportValue` / `Fn::GetStackOutput` reference is not found
 * in cdkd state, the resolver falls back to CloudFormation (`ListExports` /
 * `DescribeStacks` outputs) so a cdkd-deployed consumer can reference a
 * producer stack still managed by CloudFormation (`cdk deploy` / raw CFn).
 *
 * Covered here:
 * - cdkd-first precedence (fallback fires ONLY on a cdkd-state miss)
 * - ListExports pagination
 * - weak-reference contract: CFn-sourced resolutions are NOT recorded into
 *   `recordedImports` / `recordedOutputReads`
 * - `--no-cfn-fallback` opt-out (no CFn call, original error message)
 * - graceful degradation on lookup failure (warn + original not-found error)
 * - `Fn::GetStackOutput` region pinning + per-region client caching
 *
 * The RoleArn (cross-account) path never takes the CFn fallback — asserted
 * in intrinsic-getstackoutput-cross-account.test.ts alongside the rest of
 * the cross-account machinery mocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StateImportEntry, StateOutputReadEntry } from '../../../src/types/state.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const cfnMockSend = vi.hoisted(() => vi.fn());
const cfnClientConfigs = vi.hoisted(() => [] as Array<{ region?: string }>);
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation((config: { region?: string }) => {
      cfnClientConfigs.push(config);
      return { send: cfnMockSend };
    }),
  };
});

/** Route the shared send mock by command class name. */
function primeCfn(handlers: {
  listExports?: (input: { NextToken?: string }) => Promise<unknown>;
  describeStacks?: (input: { StackName?: string }) => Promise<unknown>;
}): void {
  cfnMockSend.mockImplementation(async (cmd: { constructor: { name: string }; input: never }) => {
    if (cmd.constructor.name === 'ListExportsCommand') {
      if (!handlers.listExports) throw new Error('unexpected ListExports call');
      return handlers.listExports(cmd.input);
    }
    if (cmd.constructor.name === 'DescribeStacksCommand') {
      if (!handlers.describeStacks) throw new Error('unexpected DescribeStacks call');
      return handlers.describeStacks(cmd.input);
    }
    throw new Error(`unexpected CloudFormation command: ${cmd.constructor.name}`);
  });
}

/** cdkd state backend double for the ImportValue scan + GetStackOutput read. */
function makeBackend(
  stacks: Array<{ stackName: string; region: string; outputs: Record<string, unknown> }>
): S3StateBackend {
  return {
    listStacks: vi.fn(async () => stacks.map((s) => ({ stackName: s.stackName, region: s.region }))),
    getState: vi.fn(async (stackName: string, region: string) => {
      const found = stacks.find((s) => s.stackName === stackName && s.region === region);
      if (!found) return null;
      return {
        state: {
          version: 8,
          stackName: found.stackName,
          region: found.region,
          resources: {},
          outputs: found.outputs,
          lastModified: 1,
        },
        etag: 'e',
      };
    }),
  } as unknown as S3StateBackend;
}

function buildContext(overrides: Partial<ResolverContext>): ResolverContext {
  const template: CloudFormationTemplate = { Resources: {} };
  return {
    template,
    resources: {},
    stackName: 'Consumer',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cfnMockSend.mockReset();
  cfnClientConfigs.length = 0;
});

describe('Fn::ImportValue - CloudFormation ListExports fallback (#1697)', () => {
  it('resolves from CloudFormation exports on a cdkd-state miss, without recording an import', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({
      listExports: async () => ({
        Exports: [
          { Name: 'Other', Value: 'other-value' },
          {
            Name: 'SharedBucketArn',
            Value: 'arn:aws:s3:::cfn-shared-bucket',
            ExportingStackId:
              'arn:aws:cloudformation:us-east-1:123456789012:stack/CfnProducer/abc',
          },
        ],
      }),
    });
    const recorded: StateImportEntry[] = [];

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'SharedBucketArn' },
      buildContext({ stateBackend: makeBackend([]), recordedImports: recorded })
    );

    expect(result).toBe('arn:aws:s3:::cfn-shared-bucket');
    // Weak reference: a CFn-managed producer is never recorded into
    // state.imports (cdkd cannot protect it at destroy time).
    expect(recorded).toHaveLength(0);
  });

  it('paginates ListExports until the export is found', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({
      listExports: async (input) => {
        if (!input.NextToken) {
          return { Exports: [{ Name: 'A', Value: 'a' }], NextToken: 'page-2' };
        }
        expect(input.NextToken).toBe('page-2');
        return { Exports: [{ Name: 'OnPageTwo', Value: 'page-two-value' }] };
      },
    });

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'OnPageTwo' },
      buildContext({ stateBackend: makeBackend([]) })
    );

    expect(result).toBe('page-two-value');
    expect(cfnMockSend).toHaveBeenCalledTimes(2);
  });

  it('prefers a cdkd-state export over CloudFormation (cdkd-first precedence, no CFn call)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const recorded: StateImportEntry[] = [];

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'SharedBucketArn' },
      buildContext({
        stateBackend: makeBackend([
          { stackName: 'CdkdProducer', region: 'us-east-1', outputs: { SharedBucketArn: 'arn:cdkd' } },
        ]),
        recordedImports: recorded,
      })
    );

    expect(result).toBe('arn:cdkd');
    expect(cfnMockSend).not.toHaveBeenCalled();
    // The cdkd-sourced resolution keeps its strong-reference recording.
    expect(recorded).toEqual([
      { exportName: 'SharedBucketArn', sourceStack: 'CdkdProducer', sourceRegion: 'us-east-1' },
    ]);
  });

  it('cfnFallback: false disables the fallback (no CFn call, cdkd-only error message)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    await expect(
      resolver.resolve(
        { 'Fn::ImportValue': 'Missing' },
        buildContext({ stateBackend: makeBackend([]) })
      )
    ).rejects.toThrow(
      "Fn::ImportValue: export 'Missing' not found in any stack. Searched 0 cdkd state record(s). "
    );
    expect(cfnMockSend).not.toHaveBeenCalled();
  });

  it('mentions both searched sources when the export is nowhere', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({ listExports: async () => ({ Exports: [{ Name: 'Other', Value: 'x' }] }) });

    await expect(
      resolver.resolve(
        { 'Fn::ImportValue': 'Missing' },
        buildContext({ stateBackend: makeBackend([]) })
      )
    ).rejects.toThrow(
      "Fn::ImportValue: export 'Missing' not found in any stack. " +
        'Searched 0 cdkd state record(s) and CloudFormation exports.'
    );
  });

  it('degrades gracefully when ListExports fails (warn + original not-found error)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({
      listExports: async () => {
        throw new Error('User is not authorized to perform: cloudformation:ListExports');
      },
    });

    await expect(
      resolver.resolve(
        { 'Fn::ImportValue': 'Missing' },
        buildContext({ stateBackend: makeBackend([]) })
      )
    ).rejects.toThrow("Fn::ImportValue: export 'Missing' not found in any stack");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CloudFormation ListExports fallback failed')
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('--no-cfn-fallback'));
  });
});

describe('Fn::GetStackOutput - CloudFormation DescribeStacks fallback (#1697)', () => {
  it('resolves from CloudFormation stack outputs on a cdkd-state miss, without recording an output read', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({
      describeStacks: async (input) => {
        expect(input.StackName).toBe('CfnProducer');
        return {
          Stacks: [
            {
              Outputs: [
                { OutputKey: 'ApiUrl', OutputValue: 'https://api.example.com' },
                { OutputKey: 'Other', OutputValue: 'x' },
              ],
            },
          ],
        };
      },
    });
    const outputReads: StateOutputReadEntry[] = [];

    const result = await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: 'CfnProducer', OutputName: 'ApiUrl' } },
      buildContext({ stateBackend: makeBackend([]), recordedOutputReads: outputReads })
    );

    expect(result).toBe('https://api.example.com');
    // Weak reference: outputReads names cdkd-managed producers for recreate
    // warnings; a CFn-managed producer is never recreated by cdkd.
    expect(outputReads).toHaveLength(0);
  });

  it('prefers cdkd state over CloudFormation (no CFn call on a state hit)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const outputReads: StateOutputReadEntry[] = [];

    const result = await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'ApiUrl' } },
      buildContext({
        stateBackend: makeBackend([
          { stackName: 'Producer', region: 'us-east-1', outputs: { ApiUrl: 'https://cdkd' } },
        ]),
        recordedOutputReads: outputReads,
      })
    );

    expect(result).toBe('https://cdkd');
    expect(cfnMockSend).not.toHaveBeenCalled();
    // The cdkd-sourced resolution keeps its outputReads recording.
    expect(outputReads).toEqual([
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: 'ApiUrl' },
    ]);
  });

  it('names the available outputs when the CFn stack exists but lacks the output', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({
      describeStacks: async () => ({
        Stacks: [{ Outputs: [{ OutputKey: 'Other', OutputValue: 'x' }] }],
      }),
    });

    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'CfnProducer', OutputName: 'Missing' } },
        buildContext({ stateBackend: makeBackend([]) })
      )
    ).rejects.toThrow(
      "Fn::GetStackOutput: output 'Missing' not found in CloudFormation stack " +
        "'CfnProducer' (us-east-1). Available outputs: Other"
    );
  });

  it('cfnFallback: false disables the fallback (no CFn call, cdkd-only error message)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'ApiUrl' } },
        buildContext({ stateBackend: makeBackend([]) })
      )
    ).rejects.toThrow(
      "Fn::GetStackOutput: stack 'Producer' not found in region 'us-east-1'. " +
        'Make sure the producer stack has been deployed via cdkd.'
    );
    expect(cfnMockSend).not.toHaveBeenCalled();
  });

  it('treats a does-not-exist ValidationError as a miss and names both searched sources', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({
      describeStacks: async () => {
        throw new Error('Stack with id Producer does not exist');
      },
    });

    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'ApiUrl' } },
        buildContext({ stateBackend: makeBackend([]) })
      )
    ).rejects.toThrow(
      "Fn::GetStackOutput: stack 'Producer' not found in region 'us-east-1'. " +
        'Searched cdkd state and CloudFormation stacks.'
    );
    // The expected miss is not a lookup failure — no warning.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('DescribeStacks fallback failed')
    );
  });

  it('degrades gracefully when DescribeStacks fails (warn + not-found error)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({
      describeStacks: async () => {
        throw new Error('User is not authorized to perform: cloudformation:DescribeStacks');
      },
    });

    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'ApiUrl' } },
        buildContext({ stateBackend: makeBackend([]) })
      )
    ).rejects.toThrow("Fn::GetStackOutput: stack 'Producer' not found in region 'us-east-1'");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CloudFormation DescribeStacks fallback failed')
    );
  });

  it('pins the fallback client to the target Region (cross-region reference)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({
      describeStacks: async () => ({
        Stacks: [{ Outputs: [{ OutputKey: 'ApiUrl', OutputValue: 'https://eu' }] }],
      }),
    });

    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'CfnProducer',
          OutputName: 'ApiUrl',
          Region: 'eu-west-1',
        },
      },
      buildContext({ stateBackend: makeBackend([]) })
    );

    expect(result).toBe('https://eu');
    expect(cfnClientConfigs).toEqual([{ region: 'eu-west-1' }]);
  });

  it('caches the CloudFormation client per region within one resolver', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    primeCfn({
      describeStacks: async () => ({
        Stacks: [{ Outputs: [{ OutputKey: 'ApiUrl', OutputValue: 'v' }] }],
      }),
    });
    const context = buildContext({ stateBackend: makeBackend([]) });

    await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: 'CfnProducerA', OutputName: 'ApiUrl' } },
      context
    );
    await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: 'CfnProducerB', OutputName: 'ApiUrl' } },
      context
    );

    expect(cfnMockSend).toHaveBeenCalledTimes(2);
    expect(cfnClientConfigs).toEqual([{ region: 'us-east-1' }]);
  });
});
