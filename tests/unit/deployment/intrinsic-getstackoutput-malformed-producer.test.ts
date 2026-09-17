/**
 * Issue go-to-k/cdkd#3207: `Fn::GetStackOutput` is the ONE reader of a
 * producer's `state.outputs` bag that RE-APPLIES rather than displays.
 *
 * `Object.hasOwn('abcdef', '0')` is `true`, so before this guard an
 * `OutputName: '0'` against a six-character bag resolved the single character
 * `'a'` — a value the deploy then SENDS to AWS as a live resource's property —
 * and the not-found refusal beside it echoed `Object.keys(outputs)` back to the
 * operator as the producer's available outputs. The `Fn::ImportValue` sibling
 * was already safe because it tests membership through `importableOutputKeys`,
 * which fails closed.
 *
 * The negative half matters as much: an ABSENT bag is an ordinary record (the
 * deploy's failure-path saves write `outputs: currentState.outputs`, which
 * `JSON.stringify` drops when undefined), so it must keep taking the ordinary
 * not-found path rather than this refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

// A cdkd-state MISS falls back to CloudFormation `DescribeStacks` (issue
// #1697), which would otherwise build a REAL client from a unit test. Default:
// the stack does not exist.
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

import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StackState } from '../../../src/types/state.js';
import {
  IntrinsicResolutionRefusalError,
  MalformedProducerRecordRefusalError,
} from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const REGION = 'us-east-1';

function backendWith(outputs: unknown, opts: { omitOutputs?: boolean } = {}): S3StateBackend {
  const state: StackState = {
    version: 9,
    stackName: 'Producer',
    region: REGION,
    resources: {},
    outputs: outputs as StackState['outputs'],
    lastModified: 0,
  };
  if (opts.omitOutputs) delete (state as Partial<StackState>).outputs;
  return {
    getState: vi.fn(async (stackName: string, region: string) =>
      stackName === 'Producer' && region === REGION ? { state, etag: 'e' } : null
    ),
  } as unknown as S3StateBackend;
}

function context(backend: S3StateBackend): ResolverContext {
  const template: CloudFormationTemplate = { Resources: {} };
  return { template, resources: {}, stackName: 'Consumer', stateBackend: backend };
}

const read = async (backend: S3StateBackend, outputName: string): Promise<unknown> =>
  new IntrinsicFunctionResolver(REGION).resolve(
    { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: outputName } },
    context(backend)
  );

describe('Fn::GetStackOutput refuses a malformed producer record (go-to-k/cdkd#3207)', () => {
  beforeEach(() => vi.clearAllMocks());

  const MALFORMED: Array<[string, unknown]> = [
    ['a string bag', 'abcdef'],
    ['a list bag', ['first', 'second']],
    ['a null bag', null],
    ['a number bag', 5],
    ['a boolean bag', true],
  ];

  for (const [label, bag] of MALFORMED) {
    it(`refuses ${label} rather than answering from it`, async () => {
      // `'0'` is the DISCRIMINATOR, not an arbitrary name: it is an INDEX of
      // the string and the list, so it is exactly the input the pre-fix code
      // answered — with `'a'` and `'first'` respectively. A name the bag cannot
      // index would have hit the ordinary not-found refusal either way and the
      // case would prove nothing.
      await expect(read(backendWith(bag), '0')).rejects.toBeInstanceOf(
        MalformedProducerRecordRefusalError
      );
    });
  }

  it('does not resolve the fabricated CHARACTER — the value a deploy would apply', async () => {
    // The confluence-point guard: "it threw" is satisfied by any failure. This
    // pins that the value the pre-fix code RETURNED is not produced.
    const result = await read(backendWith('abcdef'), '0').then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.e as Error).message).not.toContain("'a'");
    }
  });

  it('does not echo the fabricated KEYS back to the operator', async () => {
    // `describeAvailableOutputs(Object.keys(outputs))` renders `0, 1, 2, 3, 4,
    // 5` for a six-character bag. The refusal sits above it, so the text must
    // carry neither that list nor the "Available outputs" heading.
    const err = (await read(backendWith('abcdef'), '0').catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('Available outputs');
    expect(err.message).toContain("no readable 'outputs' map");
  });

  it('is an IntrinsicResolutionRefusalError, so an Fn::Sub cannot launder it', async () => {
    // The base class is what `resolveSub`'s catch re-raises on (issue #1740).
    // Without it the refusal degrades to a literal `${...}` shipped to AWS.
    const err = (await read(backendWith('abcdef'), '0').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(IntrinsicResolutionRefusalError);
  });

  it('is NOT retryable — the input is a persisted record no retry can change', async () => {
    const err = (await read(backendWith('abcdef'), '0').catch((e: unknown) => e)) as Error;
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('carries its OWN code, so a consumer keying on it cannot capture its siblings', async () => {
    const err = (await read(backendWith('abcdef'), '0').catch((e: unknown) => e)) as {
      code?: string;
    };
    expect(err.code).toBe('INTRINSIC_RESOLUTION_REFUSAL_MALFORMED_PRODUCER_RECORD');
  });

  // THE OTHER DIRECTION.
  it('resolves a healthy bag unchanged', async () => {
    await expect(read(backendWith({ BucketArn: 'arn:aws:s3:::p' }), 'BucketArn')).resolves.toBe(
      'arn:aws:s3:::p'
    );
  });

  it('leaves an EMPTY bag on the ordinary not-found path', async () => {
    const err = (await read(backendWith({}), 'BucketArn').catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(MalformedProducerRecordRefusalError);
    expect(err.message).toContain('not found in stack');
  });

  it('leaves an ABSENT bag on the ordinary not-found path — that record is ordinary', async () => {
    const err = (await read(backendWith(undefined, { omitOutputs: true }), 'BucketArn').catch(
      (e: unknown) => e
    )) as Error;
    expect(
      err,
      'an absent outputs field is a record cdkd writes on purpose and must not be refused'
    ).not.toBeInstanceOf(MalformedProducerRecordRefusalError);
    expect(err.message).toContain('not found in stack');
  });

  it('leaves a MISSING key on a healthy bag alone', async () => {
    const err = (await read(backendWith({ Real: 'v' }), 'Other').catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(MalformedProducerRecordRefusalError);
    expect(err.message).toContain('Available outputs');
  });
});
