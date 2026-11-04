import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Issue #5738: the IAM-propagation recycle writes a marker Description onto the
// backing Lambda to force a cold start. CDK's own handlers declare a
// Description, so a marker left behind is a permanent `cdkd drift`. The recycle
// must put the function's ORIGINAL Description back once the marker settles.
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
  }),
}));

const debugSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: (...args: unknown[]) => debugSpy(...args),
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

const SERVICE_TOKEN =
  'arn:aws:lambda:us-east-1:123456789012:function:Stack-BucketNotificationsHandler';
const CDK_DESCRIPTION =
  'AWS CloudFormation handler for "Custom::S3BucketNotifications" resources (@aws-cdk/aws-s3)';
const AUTHZ_REASON =
  'AccessDenied: User: arn:aws:sts::123456789012:assumed-role/Stack-HandlerRole/x is not authorized to perform: s3:PutBucketNotification';
const MARKER_HEAD = 'cdkd: recycled for IAM-propagation retry (';

interface RecycleProbe {
  recycleChains: Map<string, Promise<void>>;
  recycleBackingFunctionExecEnv(
    serviceToken: string,
    logicalId: string,
    mask: ((t: string) => string) | undefined
  ): Promise<void>;
}

/**
 * A simulated backing function: `GetFunctionConfiguration` returns its live
 * Description, `UpdateFunctionConfiguration` rewrites it. `events` records the
 * reads and writes in the order AWS would see them.
 */
function wireFunction(opts: {
  description: string | undefined;
  failedInvokes?: number;
  /** Return an error name to reject that update with (falsy: it succeeds). */
  failUpdate?: (description: string, nth: number) => string | false;
  failRead?: boolean;
  noFunctionName?: boolean;
  readError?: Error;
  settleFailsFor?: string;
  /** Every waiter poll answers InProgress, so each waiter runs to its timeout. */
  neverSettles?: boolean;
}): { events: string[]; live: () => string | undefined; invokes: () => number } {
  let live = opts.description;
  let invokeCount = 0;
  let updateCount = 0;
  const events: string[] = [];
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));
  mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetObjectCommand') {
      const body =
        invokeCount > (opts.failedInvokes ?? 1)
          ? { Status: 'SUCCESS', PhysicalResourceId: 'phys-123', Data: {} }
          : { Status: 'FAILED', Reason: AUTHZ_REASON };
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(body)) },
      });
    }
    return Promise.resolve({});
  });
  mockLambdaSend.mockImplementation(
    async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      if (name === 'InvokeCommand') {
        invokeCount += 1;
        return { Payload: Buffer.from('null') };
      }
      if (name === 'GetFunctionConfigurationCommand') {
        events.push('read');
        await tick();
        if (opts.readError) throw opts.readError;
        if (opts.failRead) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        if (opts.noFunctionName) return {};
        return live === undefined
          ? { FunctionName: 'Stack-BucketNotificationsHandler' }
          : { FunctionName: 'Stack-BucketNotificationsHandler', Description: live };
      }
      if (name === 'UpdateFunctionConfigurationCommand') {
        const description = String(cmd.input['Description']);
        updateCount += 1;
        events.push(`write:${description}`);
        await tick();
        const failName = opts.failUpdate?.(description, updateCount);
        if (failName) {
          throw Object.assign(new Error('update refused'), { name: failName });
        }
        live = description;
        return {};
      }
      // GetFunction for the updated / active waiters.
      if (opts.neverSettles) {
        return { Configuration: { State: 'Active', LastUpdateStatus: 'InProgress' } };
      }
      if (opts.settleFailsFor !== undefined && live === opts.settleFailsFor) {
        return { Configuration: { State: 'Active', LastUpdateStatus: 'Failed' } };
      }
      return { Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } };
    }
  );
  return { events, live: () => live, invokes: () => invokeCount };
}

const isMarker = (e: string): boolean => e.startsWith(`write:${MARKER_HEAD}`);

describe('custom-resource recycle restores the backing function Description (#5738)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockS3Send.mockReset();
    debugSpy.mockReset();
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '2';
  });
  afterEach(() => {
    delete process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
  });

  it('a create that took the retry leaves the CDK-declared Description in place', async () => {
    const fn = wireFunction({ description: CDK_DESCRIPTION });
    const provider = new CustomResourceProvider({ responseBucket: 'b', asyncResponseTimeoutMs: 10_000 });

    const result = await provider.create('BNotifications', 'Custom::S3BucketNotifications', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('phys-123');
    expect(fn.invokes()).toBe(2);
    expect(fn.events).toEqual([
      'read',
      `write:${MARKER_HEAD}BNotifications)`,
      `write:${CDK_DESCRIPTION}`,
    ]);
    expect(fn.live()).toBe(CDK_DESCRIPTION);
  });

  it('two recycles in one invocation restore the ORIGINAL, even after a failed restore', async () => {
    // The first restore fails, so the second recycle reads the marker back.
    const fn = wireFunction({
      description: CDK_DESCRIPTION,
      failedInvokes: 2,
      // Not a conflict: a conflict is retried (and would then succeed).
      failUpdate: (d, nth) => d === CDK_DESCRIPTION && nth === 2 && 'AccessDeniedException',
    });
    const provider = new CustomResourceProvider({ responseBucket: 'b', asyncResponseTimeoutMs: 10_000 });

    await provider.create('BNotifications', 'Custom::S3BucketNotifications', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(fn.invokes()).toBe(3);
    expect(fn.live()).toBe(CDK_DESCRIPTION);
    expect(fn.events.filter((e) => !isMarker(e) && e !== 'read')).toEqual([
      `write:${CDK_DESCRIPTION}`,
      `write:${CDK_DESCRIPTION}`,
    ]);
    // The failed restore is logged, at debug, and did not fail the resource.
    expect(debugSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      "Could not restore the backing function's Description"
    );
  });

  it('concurrent recycles on ONE backing function run one after the other', async () => {
    const fn = wireFunction({ description: CDK_DESCRIPTION });
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await Promise.all([
      provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'ResA', undefined),
      provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'ResB', undefined),
    ]);

    // Unserialised, B reads while A's marker is live and the two updates
    // collide (`ResourceConflictException` on real AWS).
    expect(fn.events).toEqual([
      'read',
      `write:${MARKER_HEAD}ResA)`,
      `write:${CDK_DESCRIPTION}`,
      'read',
      `write:${MARKER_HEAD}ResB)`,
      `write:${CDK_DESCRIPTION}`,
    ]);
    expect(fn.live()).toBe(CDK_DESCRIPTION);
    // The chain is dropped once idle, not kept per function forever.
    expect(provider.recycleChains.size).toBe(0);
  });

  it.each([
    ['an empty string', ''],
    ['an absent member on a real configuration', undefined],
  ])('an EMPTY prior Description (%s) is restored as empty', async (_label, description) => {
    const fn = wireFunction({ description });
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'Res', undefined);

    expect(fn.events).toEqual(['read', `write:${MARKER_HEAD}Res)`, 'write:']);
    expect(fn.live()).toBe('');
  });

  it.each([
    ['the read fails', { description: CDK_DESCRIPTION, failRead: true }],
    ['the read names no function', { description: CDK_DESCRIPTION, noFunctionName: true }],
  ])('still recycles, and writes nothing unread, when %s', async (_label, opts) => {
    const fn = wireFunction(opts);
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'Res', undefined);

    expect(fn.events).toEqual(['read', `write:${MARKER_HEAD}Res)`]);
  });

  it('a marker write that fails is not followed by a restore', async () => {
    const fn = wireFunction({ description: CDK_DESCRIPTION, failUpdate: (d) => d.startsWith(MARKER_HEAD) && 'ResourceConflictException',
    });
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'Res', undefined);

    expect(fn.events).toEqual(['read', `write:${MARKER_HEAD}Res)`]);
    expect(fn.live()).toBe(CDK_DESCRIPTION);
  });

  it('a read that fails to deserialize logs no part of the response body', async () => {
    // GetFunctionConfiguration's body carries `Environment.Variables`.
    const body = '{"Environment":{"Variables":{"DB_PASSWORD":"hunter2-plaintext"}}';
    const readError = Object.assign(new SyntaxError(`Unexpected end of JSON input: ${body}`), {
      $responseBodyText: body,
    });
    const fn = wireFunction({ description: CDK_DESCRIPTION, readError });
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'Res', undefined);

    const logged = debugSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('(response body withheld)');
    expect(logged).not.toContain('hunter2-plaintext');
    expect(fn.events).toEqual(['read', `write:${MARKER_HEAD}Res)`]);
  });

  it('a restore that was written but did not settle is not reported as unrestored', async () => {
    const fn = wireFunction({ description: CDK_DESCRIPTION, settleFailsFor: CDK_DESCRIPTION });
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'Res', undefined);

    expect(fn.live()).toBe(CDK_DESCRIPTION);
    const logged = debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('but the update did not settle');
    expect(logged).not.toContain("Could not restore the backing function's Description");
  });

  it('a restore refused with ResourceConflictException waits and re-sends', async () => {
    // The marker's update still InProgress: Lambda refuses the next update.
    const fn = wireFunction({
      description: CDK_DESCRIPTION,
      failUpdate: (d, nth) => d === CDK_DESCRIPTION && nth === 2 && 'ResourceConflictException',
    });
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'Res', undefined);

    expect(fn.events).toEqual([
      'read',
      `write:${MARKER_HEAD}Res)`,
      `write:${CDK_DESCRIPTION}`,
      `write:${CDK_DESCRIPTION}`,
    ]);
    expect(fn.live()).toBe(CDK_DESCRIPTION);
  });

  it('a conflict that never clears gives up after a bounded number of re-sends', async () => {
    const fn = wireFunction({
      description: CDK_DESCRIPTION,
      failUpdate: (d) => d === CDK_DESCRIPTION && 'ResourceConflictException',
    });
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'Res', undefined);

    // One send plus two re-sends, then the failure is logged, never thrown.
    expect(fn.events.filter((e) => e === `write:${CDK_DESCRIPTION}`)).toHaveLength(3);
    expect(debugSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      "Could not restore the backing function's Description"
    );
  });

  it('a qualified and an unqualified ServiceToken for ONE function share the chain', async () => {
    const fn = wireFunction({ description: CDK_DESCRIPTION });
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await Promise.all([
      provider.recycleBackingFunctionExecEnv(`${SERVICE_TOKEN}:$LATEST`, 'ResA', undefined),
      provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'ResB', undefined),
    ]);

    expect(fn.events).toEqual([
      'read',
      `write:${MARKER_HEAD}ResA)`,
      `write:${CDK_DESCRIPTION}`,
      'read',
      `write:${MARKER_HEAD}ResB)`,
      `write:${CDK_DESCRIPTION}`,
    ]);
  });

  it('the same function name in another region is a different function', async () => {
    const fn = wireFunction({ description: CDK_DESCRIPTION });
    const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;

    await Promise.all([
      provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'ResA', undefined),
      provider.recycleBackingFunctionExecEnv(
        SERVICE_TOKEN.replace(':us-east-1:', ':eu-west-1:'),
        'ResB',
        undefined
      ),
    ]);

    // Not serialised against each other: both read before either writes.
    expect(fn.events.slice(0, 2)).toEqual(['read', 'read']);
  });

  it('one recycle never spends more than its 240s budget, conflicts and stuck waiters included', async () => {
    // Worst case without a shared budget: marker waiter 120s + two conflict
    // waits of 60s + restore waiter 120s = 360s. With CDKD_CR_AUTHZ_MAX_RETRIES
    // at its ceiling of 10 that alone is the 1h per-resource deadline.
    vi.useFakeTimers();
    try {
      const fn = wireFunction({
        description: CDK_DESCRIPTION,
        neverSettles: true,
        failUpdate: (d, nth) => d === CDK_DESCRIPTION && nth < 4 && 'ResourceConflictException',
      });
      const provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as RecycleProbe;
      const start = Date.now();

      const done = provider.recycleBackingFunctionExecEnv(SERVICE_TOKEN, 'Res', undefined);
      await vi.runAllTimersAsync();
      await done;

      const elapsedSeconds = (Date.now() - start) / 1000;
      expect(elapsedSeconds).toBeLessThanOrEqual(240 + 1);
      // The restore still landed inside the budget.
      expect(fn.live()).toBe(CDK_DESCRIPTION);
    } finally {
      vi.useRealTimers();
    }
  });
});
