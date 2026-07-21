/**
 * Integration tests for {@link Synthesizer.expandMacrosForStacks} —
 * the private pass that routes each synthesized stack's template
 * through the macro-expander when {@link containsMacro} flags it.
 *
 * Covers the region-resolution waterfall, state-bucket fallback chain,
 * in-place mutation contract, no-op short-circuit, and multi-stack
 * dispatch. Closes Test gap 1 of the (#519) review.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockExecute = vi.hoisted(() => vi.fn());
const mockReadManifest = vi.hoisted(() => vi.fn());
const mockGetAllStacks = vi.hoisted(() => vi.fn());
const mockContextStoreLoad = vi.hoisted(() => vi.fn());
const mockContextStoreSave = vi.hoisted(() => vi.fn());
const mockExpandMacros = vi.hoisted(() => vi.fn());

vi.mock('../../../src/synthesis/app-executor.js', () => ({
  AppExecutor: vi.fn().mockImplementation(() => ({ execute: mockExecute })),
}));

vi.mock('../../../src/synthesis/assembly-reader.js', () => ({
  AssemblyReader: vi.fn().mockImplementation(() => ({
    readManifest: mockReadManifest,
    getAllStacks: mockGetAllStacks,
  })),
}));

vi.mock('../../../src/synthesis/context-store.js', () => ({
  ContextStore: vi.fn().mockImplementation(() => ({
    load: mockContextStoreLoad,
    save: mockContextStoreSave,
  })),
}));

vi.mock('../../../src/synthesis/context-providers/index.js', () => ({
  ContextProviderRegistry: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/synthesis/macro-expander.js', () => ({
  expandMacros: mockExpandMacros,
}));

const mockLoadCdkJson = vi.hoisted(() => vi.fn());
const mockLoadUserCdkJson = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: () => mockLoadCdkJson(),
  loadUserCdkJson: () => mockLoadUserCdkJson(),
}));

const mockStsSend = vi.hoisted(() => vi.fn());
// The SDK default region chain (issue #1149) is consulted via a
// throwaway STS client's `config.region()` provider — mock it so tests
// can simulate a profile-configured region (default: rejects, i.e. no
// region configured anywhere).
const mockStsConfigRegion = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: vi.fn(),
    config: { region: mockStsConfigRegion },
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

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
    setLevel: vi.fn(),
  }),
}));

import { Synthesizer } from '../../../src/synthesis/synthesizer.js';
import { SynthesisError } from '../../../src/utils/error-handler.js';

const SAM_TEMPLATE = {
  Transform: ['AWS::Serverless-2016-10-31'],
  Resources: { F: { Type: 'AWS::Serverless::Function', Properties: {} } },
};
const PLAIN_TEMPLATE = {
  Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } },
};
const EXPANDED_TEMPLATE = {
  Resources: { F: { Type: 'AWS::Lambda::Function', Properties: {} } },
};

beforeEach(() => {
  mockExecute.mockReset();
  mockReadManifest.mockReset();
  mockGetAllStacks.mockReset();
  mockContextStoreLoad.mockReset();
  mockContextStoreSave.mockReset();
  mockExpandMacros.mockReset();
  mockExistsSync.mockReset();
  mockStatSync.mockReset();
  mockLoadCdkJson.mockReset();
  mockLoadUserCdkJson.mockReset();
  mockStsSend.mockReset();
  // Defaults: full synth flow (no pre-synthesized dir), no missing
  // context, STS resolves account, ContextStore returns empty.
  mockExistsSync.mockReturnValue(false);
  mockReadManifest.mockReturnValue({ missing: [] });
  mockContextStoreLoad.mockReturnValue({});
  mockLoadCdkJson.mockReturnValue(null);
  mockLoadUserCdkJson.mockReturnValue(null);
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
  mockStsConfigRegion.mockReset();
  mockStsConfigRegion.mockRejectedValue(new Error('no region configured'));
  mockExpandMacros.mockResolvedValue(EXPANDED_TEMPLATE);
  // Clean env between tests.
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
});

describe('Synthesizer — macro expansion integration', () => {
  it('no-op when no stack contains a macro (expandMacros never called)', async () => {
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: PLAIN_TEMPLATE, region: 'us-east-1' },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js', region: 'us-east-1' });
    expect(mockExpandMacros).not.toHaveBeenCalled();
  });

  it('routes a macro-containing stack through expandMacros and mutates template in place', async () => {
    const stack = { stackName: 'A', template: SAM_TEMPLATE, region: 'us-east-1' };
    mockGetAllStacks.mockReturnValue([stack]);
    const s = new Synthesizer();
    const result = await s.synthesize({ app: 'node app.js', region: 'us-east-1' });
    expect(mockExpandMacros).toHaveBeenCalledTimes(1);
    // In-place mutation: the returned stacks[].template is the expanded shape.
    expect(result.stacks[0]?.template).toBe(EXPANDED_TEMPLATE);
    // And the original stack object also carries the expanded shape
    // (same identity — the expander mutates in place).
    expect(stack.template).toBe(EXPANDED_TEMPLATE);
  });

  it('dispatches each macro stack independently in a multi-stack assembly', async () => {
    const stackA = { stackName: 'A', template: SAM_TEMPLATE, region: 'us-east-1' };
    const stackB = { stackName: 'B', template: PLAIN_TEMPLATE, region: 'us-east-1' };
    const stackC = { stackName: 'C', template: SAM_TEMPLATE, region: 'us-east-1' };
    mockGetAllStacks.mockReturnValue([stackA, stackB, stackC]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js', region: 'us-east-1' });
    // expandMacros called once per macro-bearing stack — NOT for the plain one.
    expect(mockExpandMacros).toHaveBeenCalledTimes(2);
  });

  it('threads options.stateBucket through to expandMacros (BLOCKER 1 fix)', async () => {
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: 'us-east-1' },
    ]);
    const s = new Synthesizer();
    await s.synthesize({
      app: 'node app.js',
      region: 'us-east-1',
      stateBucket: 'my-real-bucket-from-caller',
    });
    expect(mockExpandMacros).toHaveBeenCalledTimes(1);
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { stateBucket: string };
    expect(opts.stateBucket).toBe('my-real-bucket-from-caller');
  });

  it('falls back to cdkd-state-{accountId} when options.stateBucket is missing AND template is sub-51KB', async () => {
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: 'us-east-1' },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js', region: 'us-east-1' });
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { stateBucket: string };
    expect(opts.stateBucket).toBe('cdkd-state-123456789012');
  });

  it('the literal "cdkd-state-unresolved" sentinel is GONE (BLOCKER 1 / Minor 5)', async () => {
    // STS fails AND options.stateBucket unset → fallback chain must
    // either (a) hard-error on oversize templates OR (b) emit an
    // obviously-synthetic name. The pre-PR literal
    // 'cdkd-state-unresolved' would silently flow into the wire.
    mockStsSend.mockRejectedValue(new Error('STS unavailable'));
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: 'us-east-1' },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js', region: 'us-east-1' });
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { stateBucket: string };
    // Strictly NOT the pre-PR sentinel.
    expect(opts.stateBucket).not.toBe('cdkd-state-unresolved');
  });

  it('hard-errors when STS fails AND template is over 51KB AND options.stateBucket is absent', async () => {
    mockStsSend.mockRejectedValue(new Error('STS unavailable'));
    const bigTemplate = {
      Transform: ['AWS::Serverless-2016-10-31'],
      Resources: {
        F: {
          Type: 'AWS::Serverless::Function',
          Properties: { InlineCode: 'x'.repeat(60_000) },
        },
      },
    };
    mockGetAllStacks.mockReturnValue([
      { stackName: 'BigStack', template: bigTemplate, region: 'us-east-1' },
    ]);
    const s = new Synthesizer();
    await expect(s.synthesize({ app: 'node app.js', region: 'us-east-1' })).rejects.toThrow(
      SynthesisError
    );
    await expect(s.synthesize({ app: 'node app.js', region: 'us-east-1' })).rejects.toThrow(
      /--state-bucket/
    );
  });

  it('resolves region from AWS_REGION env when options.region is absent', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: undefined },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js' });
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { region: string };
    expect(opts.region).toBe('eu-west-1');
  });

  it('resolves region from the synthesized stack env when nothing else is set', async () => {
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: 'ap-northeast-1' },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js' });
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { region: string };
    expect(opts.region).toBe('ap-northeast-1');
  });

  it('hard-errors with SynthesisError when no region can be resolved', async () => {
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: undefined },
    ]);
    const s = new Synthesizer();
    await expect(s.synthesize({ app: 'node app.js' })).rejects.toThrow(SynthesisError);
    await expect(s.synthesize({ app: 'node app.js' })).rejects.toThrow(
      /could not resolve an AWS region/
    );
  });

  it('threads macroExpandS3ClientOpts through to expandMacros', async () => {
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: 'us-east-1' },
    ]);
    const s = new Synthesizer();
    await s.synthesize({
      app: 'node app.js',
      region: 'us-east-1',
      stateBucket: 'b',
      macroExpandS3ClientOpts: { profile: 'my-profile' },
    });
    const opts = mockExpandMacros.mock.calls[0]?.[1] as {
      s3ClientOpts?: { profile?: string };
    };
    expect(opts.s3ClientOpts?.profile).toBe('my-profile');
  });

  it('pre-synth (-a cdk.out) branch also runs macro expansion + STS resolution', async () => {
    // Simulate `cdkd deploy -a cdk.out` (pre-synthesized assembly).
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: 'us-east-1' },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: '/path/to/cdk.out', region: 'us-east-1' });
    // expandMacros runs in pre-synth branch too (Minor 5 fix).
    expect(mockExpandMacros).toHaveBeenCalledTimes(1);
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { stateBucket: string };
    // STS still ran and the default bucket flowed through.
    expect(opts.stateBucket).toBe('cdkd-state-123456789012');
  });
});

describe('Synthesizer — deferred / selection-aware macro expansion (issues #1149 / #1150)', () => {
  const preSynth = (): void => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  };

  it('falls back to the SDK default region chain (profile region) for macro expansion (#1149)', async () => {
    // No options.region, no env, no stack env region — only the shared
    // config file (profile) region, surfaced via the SDK chain.
    mockStsConfigRegion.mockResolvedValue('eu-central-1');
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: undefined },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js' });
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { region: string };
    expect(opts.region).toBe('eu-central-1');
    // The same fallback region reaches the CDK app subprocess as
    // CDK_DEFAULT_REGION (via the app executor), matching the CDK CLI.
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ region: 'eu-central-1' }));
  });

  it('the synthesized stack env region wins over the SDK default chain', async () => {
    mockStsConfigRegion.mockResolvedValue('eu-central-1');
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: 'ap-northeast-1' },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js' });
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { region: string };
    expect(opts.region).toBe('ap-northeast-1');
  });

  it('threads options.profile into the SDK default-region client', async () => {
    const { STSClient } = await import('@aws-sdk/client-sts');
    (STSClient as unknown as ReturnType<typeof vi.fn>).mockClear();
    mockStsConfigRegion.mockResolvedValue('eu-west-2');
    mockGetAllStacks.mockReturnValue([
      { stackName: 'A', template: SAM_TEMPLATE, region: undefined },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js', profile: 'my-profile' });
    const ctorCalls = (STSClient as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(ctorCalls.some((c) => (c[0] as { profile?: string })?.profile === 'my-profile')).toBe(
      true
    );
  });

  it('public expandMacrosForStacks with an explicit stateBucket pays no STS call', async () => {
    preSynth();
    const macroStack = { stackName: 'Macro', template: SAM_TEMPLATE, region: 'us-east-1' };
    mockGetAllStacks.mockReturnValue([macroStack]);
    const s = new Synthesizer();
    const options = {
      app: '/path/to/cdk.out',
      deferMacroExpansion: true,
      stateBucket: 'explicit-bucket',
    };
    const result = await s.synthesize(options);
    await s.expandMacrosForStacks(result.stacks, options);
    expect(mockExpandMacros).toHaveBeenCalledTimes(1);
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { stateBucket: string };
    expect(opts.stateBucket).toBe('explicit-bucket');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('deferMacroExpansion skips expansion inside synthesize()', async () => {
    mockGetAllStacks.mockReturnValue([
      { stackName: 'Macro', template: SAM_TEMPLATE, region: 'us-east-1' },
    ]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node app.js', region: 'us-east-1', deferMacroExpansion: true });
    expect(mockExpandMacros).not.toHaveBeenCalled();
  });

  it('a macro sibling OUTSIDE the selection never expands and pays no STS call (#1150)', async () => {
    preSynth();
    const macroStack = { stackName: 'Macro', template: SAM_TEMPLATE, region: 'us-east-1' };
    const plainStack = { stackName: 'Plain', template: PLAIN_TEMPLATE, region: 'us-east-1' };
    mockGetAllStacks.mockReturnValue([macroStack, plainStack]);
    const s = new Synthesizer();
    const options = { app: '/path/to/cdk.out', deferMacroExpansion: true };
    const result = await s.synthesize(options);
    // Post-selection expansion for the macro-FREE stack only: the
    // macro-carrying sibling must not trigger a CFn round-trip, an STS
    // hop, or a region requirement.
    await s.expandMacrosForStacks([result.stacks[1]!], options);
    expect(mockExpandMacros).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('expandMacrosForStacks (public, post-selection) expands only the selected macro stack and resolves the default bucket itself', async () => {
    preSynth();
    const macroStack = { stackName: 'Macro', template: SAM_TEMPLATE, region: 'us-east-1' };
    const plainStack = { stackName: 'Plain', template: PLAIN_TEMPLATE, region: 'us-east-1' };
    mockGetAllStacks.mockReturnValue([macroStack, plainStack]);
    const s = new Synthesizer();
    const options = { app: '/path/to/cdk.out', deferMacroExpansion: true };
    const result = await s.synthesize(options);
    expect(mockExpandMacros).not.toHaveBeenCalled();
    await s.expandMacrosForStacks(result.stacks, options);
    // Only the macro-carrying stack expanded; STS resolved the default
    // state bucket inside the public method.
    expect(mockExpandMacros).toHaveBeenCalledTimes(1);
    const opts = mockExpandMacros.mock.calls[0]?.[1] as { region: string; stateBucket: string };
    expect(opts.region).toBe('us-east-1');
    expect(opts.stateBucket).toBe('cdkd-state-123456789012');
    expect(result.stacks[0]?.template).toBe(EXPANDED_TEMPLATE);
    expect(result.stacks[1]?.template).toBe(PLAIN_TEMPLATE);
  });

  it('listStacks never expands macros and needs no region (#1150 — cdkd list)', async () => {
    mockGetAllStacks.mockReturnValue([
      { stackName: 'Macro', template: SAM_TEMPLATE, region: undefined },
    ]);
    const s = new Synthesizer();
    // No region anywhere (mockStsConfigRegion rejects by default) —
    // pre-fix this threw the "could not resolve an AWS region" error.
    const names = await s.listStacks({ app: 'node app.js' });
    expect(names).toEqual(['Macro']);
    expect(mockExpandMacros).not.toHaveBeenCalled();
  });
});
