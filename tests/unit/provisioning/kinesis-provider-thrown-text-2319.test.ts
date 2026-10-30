import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, debug, warn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    KinesisClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';

// go-to-k/cdkd#2319: every create / update / delete wrap is persisted to
// `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its class
// plus the --verbose pointer; AWS's text (the caller's role ARN) goes to the
// masked debug line and stays on `cause` for the retry classifiers.
const TYPE = 'AWS::Kinesis::Stream';
const DENIED =
  'User: arn:aws:sts::111122223333:assumed-role/deployer/s3cr3t is not authorized to perform: kinesis:X';
const denied = (): Error =>
  Object.assign(new Error(DENIED), {
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const PROPS = { Name: 'orders', ShardCount: 1 };

const cases: Array<{ wrap: string; run: (p: KinesisStreamProvider) => Promise<unknown> }> = [
  {
    wrap: 'Failed to create Kinesis stream Stream',
    run: (p) => p.create('Stream', TYPE, PROPS, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update Kinesis stream Stream',
    run: (p) =>
      p.update('Stream', 'orders', TYPE, { ...PROPS, ShardCount: 2 }, PROPS, {
        maskSecrets: mask,
      }),
  },
  {
    wrap: 'Failed to delete Kinesis stream Stream',
    run: (p) => p.delete('Stream', 'orders', TYPE, undefined, { maskSecrets: mask }),
  },
];

describe('KinesisStreamProvider thrown wraps withhold AWS text (#2319)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new KinesisStreamProvider();
  });

  it.each(cases)('$wrap: an AWS-authored failure is named by its class', async (c) => {
    mockSend.mockRejectedValue(denied());

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('111122223333');
    expect(failure.message).not.toContain('not authorized');
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines()).toContain(`${c.wrap}: ${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(cases)('$wrap: a cdkd-authored failure keeps its text, masked', async (c) => {
    mockSend.mockRejectedValue(new Error('socket hang up near s3cr3t'));

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('s3cr3t');
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it('a cdkd-authored failure the mask leaves alone is not stamped', async () => {
    mockSend.mockRejectedValue(new Error('socket hang up'));

    const failure = await caught(cases[0]!.run(provider));

    expect(failure.message).toBe(`${cases[0]!.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('a non-Error throw is withheld, unstamped', async () => {
    mockSend.mockRejectedValue('raw s3cr3t value');

    const failure = await caught(provider.delete('Stream', 'orders', TYPE));

    expect(failure.message).toBe(
      `Failed to delete Kinesis stream Stream: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  // A transport error the SDK retried carries `$metadata` with only the retry
  // counters (no `$fault`, no `httpStatusCode`): cdkd-side text, kept and masked.
  it('a retried transport error keeps its text, masked', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('socket hang up near s3cr3t'), {
        name: 'TimeoutError',
        $metadata: { attempts: 3, totalRetryDelay: 120 },
      })
    );

    const failure = await caught(cases[0]!.run(provider));

    expect(failure.message).toBe(`${cases[0]!.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('TimeoutError');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    expect(failure.message).not.toContain('s3cr3t');
  });

  // CreateStream's collision is a `ResourceInUseException` whose text names the
  // account; the wrap restates the collision, so a create-first replacement
  // still recognises it.
  it('restates an "already exists" from CreateStream', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('Stream orders under account 111122223333 already exists.'), {
        name: 'ResourceInUseException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(provider.create('Stream', TYPE, PROPS));

    expect(failure.message).toBe(
      `Failed to create Kinesis stream Stream: ResourceInUseException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain('111122223333');
    expect(isNameCollisionErrorFrom(failure, 'Stream')).toBe(true);
  });

  // The #5161 leak shape: a failure AFTER CreateStream returned (a denied
  // status read while waiting for ACTIVE) must still reach the wrap, mark intact.
  it('a denied settle read after CreateStream is withheld, the created mark kept', async () => {
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'CreateStreamCommand') return {};
      throw denied();
    });

    const failure = await caught(provider.create('Stream', TYPE, PROPS, { maskSecrets: mask }));

    expect(failure.message).toBe(
      `Failed to create Kinesis stream Stream: AccessDenied. ${VERBOSE_POINTER}`
    );
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(createdBeforeFailure(failure, 'Stream', TYPE)).toBe('orders');
    const warns = warn.mock.calls.map((w) => String(w[0]));
    expect([...warns, ...debugLines()].join('\n')).not.toContain('s3cr3t');
  });

  it('reports the stream name to the sink before the ACTIVE wait (#5511)', async () => {
    const sink = new CreatedResourceSink('Stream', TYPE);
    let reportAtWait: unknown = 'not-called';
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'CreateStreamCommand') return {};
      if (reportAtWait === 'not-called') reportAtWait = sink.report;
      throw denied();
    });

    await caught(
      collectCreatedResources(sink, () => provider.create('Stream', TYPE, PROPS, { maskSecrets: mask }))
    );

    expect(reportAtWait).toEqual({ physicalId: 'orders' });
    expect(sink.report).toEqual({ physicalId: 'orders' });
  });

  it('reports nothing when CreateStream itself fails (#5511)', async () => {
    const sink = new CreatedResourceSink('Stream', TYPE);
    mockSend.mockRejectedValue(denied());

    await caught(
      collectCreatedResources(sink, () => provider.create('Stream', TYPE, PROPS, { maskSecrets: mask }))
    );

    expect(sink.report).toBeUndefined();
  });
});
