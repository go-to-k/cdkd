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

// Mock CloudFormation client (issue #1697 cross-stack fallback): a
// cdkd-state MISS now falls back to DescribeStacks, so the failed-resolution
// tests below would otherwise construct a REAL CloudFormationClient and
// attempt a live network call from a unit test. Default: the stack does not
// exist (the typed ValidationError miss), preserving each test's pre-#1697
// outcome hermetically.
const cfnMockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({ send: cfnMockSend })),
  };
});
cfnMockSend.mockImplementation(async () => {
  throw Object.assign(new Error('Stack does not exist'), { name: 'ValidationError' });
});

// Mock STS (issue #2081): the cross-account (RoleArn) test below routes through
// `assumeCrossAccountRole` in `src/utils/role-arn.ts`, which builds its OWN
// `new STSClient({})` — a client no `src/utils/aws-clients.js` mock can reach.
// Without this the test issued a REAL `sts:AssumeRole` against whatever account
// the runner is authenticated to.
//
// The call is mocked to FAIL, and that is what the test is written around: its
// own comment says "the STS mock is absent so the cross-account resolution will
// fail", and what it pins is that `recordedOutputReads` stays empty even on the
// cross-account ATTEMPT. Making AssumeRole succeed would need a whole fake
// ephemeral-bucket state backend behind it and would turn this into a different
// test — the recording site is guarded by `if (!roleArn)`, so the failing attempt
// exercises exactly the branch under test.
//
// The rejection carries the shape the SDK produces for a trust-policy denial
// (`name` + `$metadata.httpStatusCode`), which is what `assumeCrossAccountRole`
// re-wraps into its trust-policy hint and what any downstream error classifier
// inspects.
const stsMockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: stsMockSend, destroy: vi.fn() })),
  };
});
stsMockSend.mockImplementation(async () => {
  throw Object.assign(
    new Error(
      'User: arn:aws:iam::999988887777:user/test is not authorized to perform: ' +
        'sts:AssumeRole on resource: arn:aws:iam::111122223333:role/cdkd-state-reader'
    ),
    { name: 'AccessDenied', $metadata: { httpStatusCode: 403, requestId: 'test-request-id' } }
  );
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
    ).rejects.toThrow(/AssumeRole into arn:aws:iam::111122223333:role\/cdkd-state-reader failed/);
    // A BARE `rejects.toThrow()` here was satisfied by anything at all — including
    // the fence's own refusal back when this file issued a real `sts:AssumeRole`,
    // and including a `TypeError` from a future refactor. The STS mock above is
    // what makes the matcher pinnable: with the call isolated, the rejection is
    // deterministically `assumeCrossAccountRole`'s trust-policy wrapper from
    // `src/utils/role-arn.ts`, so pin it. That is the same defect this whole
    // change is about (issue #2081).
    //
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
