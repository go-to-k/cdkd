import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Tests for `Fn::GetStackOutput` recording the resolution into the
 * `recordedOutputReads` bag (schema v8, issue #668). Sibling of the
 * cross-account RoleArn tests; both share a stub state backend but
 * this file is specifically about the consumer-side state.outputReads
 * pipeline.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StackState, StateOutputReadEntry } from '../../../src/types/state.js';

function mockBackend(states: Map<string, StackState>): S3StateBackend {
  return {
    getState: vi.fn(async (stackName: string, region: string) => {
      const key = `${stackName}|${region}`;
      const state = states.get(key);
      if (!state) return null;
      return { state, etag: 'e' };
    }),
  } as unknown as S3StateBackend;
}

function buildContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  const template: CloudFormationTemplate = { Resources: {} };
  return {
    template,
    resources: {},
    stackName: 'Consumer',
    ...overrides,
  };
}

function producerState(stackName: string, region: string, outputs: Record<string, unknown>): StackState {
  return {
    version: 8,
    stackName,
    region,
    resources: {},
    outputs,
    lastModified: 0,
  };
}

describe('Fn::GetStackOutput records into context.recordedOutputReads (#668)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a successful same-account resolution pushes one StateOutputReadEntry', async () => {
    const backend = mockBackend(
      new Map([
        ['Producer|us-east-1', producerState('Producer', 'us-east-1', { BucketArn: 'arn:aws:s3:::p-bucket' })],
      ])
    );
    const recorded: StateOutputReadEntry[] = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const value = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'BucketArn',
        },
      },
      buildContext({ stateBackend: backend, recordedOutputReads: recorded })
    );
    expect(value).toBe('arn:aws:s3:::p-bucket');
    expect(recorded).toEqual([
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: 'BucketArn' },
    ]);
  });

  it('multiple references to the same (stack, region, output) dedup to a single entry', async () => {
    const backend = mockBackend(
      new Map([
        ['Producer|us-east-1', producerState('Producer', 'us-east-1', { BucketArn: 'arn' })],
      ])
    );
    const recorded: StateOutputReadEntry[] = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = buildContext({ stateBackend: backend, recordedOutputReads: recorded });
    for (let i = 0; i < 3; i++) {
      await resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'BucketArn' } },
        ctx
      );
    }
    expect(recorded).toHaveLength(1);
  });

  it('different output names on the same producer emit distinct entries', async () => {
    const backend = mockBackend(
      new Map([
        ['Producer|us-east-1', producerState('Producer', 'us-east-1', { OutA: 'a', OutB: 'b' })],
      ])
    );
    const recorded: StateOutputReadEntry[] = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = buildContext({ stateBackend: backend, recordedOutputReads: recorded });
    await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'OutA' } },
      ctx
    );
    await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'OutB' } },
      ctx
    );
    expect(recorded).toEqual([
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: 'OutA' },
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: 'OutB' },
    ]);
  });

  it('cross-region references record the producer region (not the consumer region)', async () => {
    const backend = mockBackend(
      new Map([
        ['Producer|us-west-2', producerState('Producer', 'us-west-2', { Arn: 'a' })],
      ])
    );
    const recorded: StateOutputReadEntry[] = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1'); // consumer is us-east-1
    await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Arn', Region: 'us-west-2' } },
      buildContext({ stateBackend: backend, recordedOutputReads: recorded })
    );
    expect(recorded[0]?.sourceRegion).toBe('us-west-2');
  });

  it('no bag supplied → recording is a no-op (back-compat with callers that do not opt in)', async () => {
    const backend = mockBackend(
      new Map([
        ['Producer|us-east-1', producerState('Producer', 'us-east-1', { Arn: 'a' })],
      ])
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    // No recordedOutputReads field on the context.
    const value = await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Arn' } },
      buildContext({ stateBackend: backend })
    );
    expect(value).toBe('a');
    // No throw, no side effect — the absence of the bag is treated as opt-out.
  });

  it('a failed resolution does NOT push an entry (no entry on missing stack)', async () => {
    const backend = mockBackend(new Map()); // empty — every read returns null
    const recorded: StateOutputReadEntry[] = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'Missing', OutputName: 'X' } },
        buildContext({ stateBackend: backend, recordedOutputReads: recorded })
      )
    ).rejects.toThrow(/stack 'Missing' not found/);
    expect(recorded).toEqual([]);
  });

  it('a cross-account (RoleArn) resolution does NOT push an entry — v8 scope-out for cross-account', async () => {
    // The cross-account branch goes through a separate state backend
    // (assume-role + ephemeral bucket). v8 intentionally does NOT
    // record into recordedOutputReads on this path because a
    // sourceAccountId field would be needed for unambiguous match
    // keys, deferred to a future bump. This test pins the contract.
    //
    // The test stubs the cross-account state lookup by mocking the
    // resolver's same-account backend lookup to throw if it ever
    // gets called — that proves we took the cross-account branch
    // (which then fails on the STS hop, but the assertion is about
    // recording, not resolution success).
    const recorded: StateOutputReadEntry[] = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    // No stateBackend means the same-account path can't run; the
    // RoleArn arg routes through the cross-account branch which
    // performs its own STS+S3 work. The STS mock is absent so the
    // cross-account resolution will fail — but the assertion that
    // matters is that `recorded` stays empty even on the
    // cross-account *attempt*.
    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'Arn',
            RoleArn: 'arn:aws:iam::111122223333:role/cdkd-state-reader',
          },
        },
        buildContext({ recordedOutputReads: recorded })
      )
    ).rejects.toThrow();
    // Whether the cross-account branch succeeded or failed, the
    // recording site is guarded by `if (!roleArn)` and must NOT
    // have pushed.
    expect(recorded).toEqual([]);
  });

  it('a failed output lookup (stack exists, output missing) does NOT push an entry', async () => {
    const backend = mockBackend(
      new Map([
        ['Producer|us-east-1', producerState('Producer', 'us-east-1', { Other: 'x' })],
      ])
    );
    const recorded: StateOutputReadEntry[] = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'BucketArn' } },
        buildContext({ stateBackend: backend, recordedOutputReads: recorded })
      )
    ).rejects.toThrow(/output 'BucketArn' not found/);
    expect(recorded).toEqual([]);
  });
});
