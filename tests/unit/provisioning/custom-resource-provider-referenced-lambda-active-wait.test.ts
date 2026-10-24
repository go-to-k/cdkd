import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// A Lambda function ARN in a custom resource's properties is a consumer that
// AWS rejects while the function is still `Pending` (the first instance seen:
// the CDK `BucketNotifications` handler passing a freshly created VPC function
// to `PutBucketNotificationConfiguration` as a destination, which answers
// "Unable to validate the following destination configurations"). Same class as
// go-to-k/cdkd#5002.
//
// BOTH polarities are pinned: the wait happens for a `Pending` reference, and
// it never happens (and never fails the resource) for an `Active` one, an
// unreadable one, or none at all.
const order: string[] = [];
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

// The readiness waiters are replaced so their calls can be ordered against the
// Invoke without 600s of polling; everything else in the SDK passes through.
const mockWaitActive = vi.fn();
const mockWaitUpdated = vi.fn();
vi.mock('@aws-sdk/client-lambda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-lambda')>();
  return {
    ...actual,
    waitUntilFunctionActiveV2: (...args: unknown[]) => mockWaitActive(...args),
    waitUntilFunctionUpdatedV2: (...args: unknown[]) => mockWaitUpdated(...args),
  };
});

import {
  CustomResourceProvider,
  collectReferencedLambdaFunctionArns,
  customResourceRetryDelays,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

const TYPE = 'Custom::S3BucketNotifications';
const SERVICE_TOKEN = 'arn:aws:lambda:eu-west-1:123456789012:function:Stack-NotificationsHandler';
const DEST_ARN = 'arn:aws:lambda:eu-west-1:123456789012:function:Stack-FullIndexerFn';
const OTHER_ARN = 'arn:aws:lambda:eu-west-1:123456789012:function:Stack-OtherFn';

function propsFor(...arns: string[]): Record<string, unknown> {
  return {
    ServiceToken: SERVICE_TOKEN,
    BucketName: 'bucket',
    NotificationConfiguration: {
      LambdaFunctionConfigurations: arns.map((arn) => ({
        Events: ['s3:ObjectCreated:*'],
        LambdaFunctionArn: arn,
      })),
    },
  };
}

/** `GetFunctionConfiguration` answers per ARN; anything unlisted is `Active`. */
function wire(states: Record<string, string | Error> = {}): void {
  mockS3Send.mockImplementation(() => Promise.resolve({}));
  mockLambdaSend.mockImplementation(
    (cmd: { constructor: { name: string }; input?: { FunctionName?: string } }) => {
      const name = cmd.constructor.name;
      const fn = cmd.input?.FunctionName ?? '';
      order.push(`${name}:${fn}`);
      if (name === 'InvokeCommand') {
        return Promise.resolve({
          Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'phys-1', Data: {} })),
        });
      }
      if (name === 'GetFunctionConfigurationCommand') {
        const state = states[fn] ?? 'Active';
        return state instanceof Error ? Promise.reject(state) : Promise.resolve({ State: state });
      }
      return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
    }
  );
}

function namesCalled(name: string): string[] {
  return order.filter((entry) => entry.startsWith(`${name}:`));
}

function activeWaitTargets(): string[] {
  return mockWaitActive.mock.calls.map((call) => (call[1] as { FunctionName: string }).FunctionName);
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({
    responseBucket: 'test-bucket',
    asyncResponseTimeoutMs: 10_000,
  });
}

describe('collectReferencedLambdaFunctionArns', () => {
  it('finds function ARNs in nested values, de-duplicated, in first-seen order', () => {
    expect(
      collectReferencedLambdaFunctionArns(
        { a: [{ b: OTHER_ARN }, DEST_ARN], c: { d: { e: DEST_ARN } } },
        SERVICE_TOKEN
      )
    ).toEqual([OTHER_ARN, DEST_ARN]);
  });

  it("excludes the resource's own backing function", () => {
    expect(collectReferencedLambdaFunctionArns(propsFor(SERVICE_TOKEN, DEST_ARN), SERVICE_TOKEN)).toEqual([
      DEST_ARN,
    ]);
  });

  it('keeps a qualified ARN verbatim and accepts other partitions', () => {
    const versioned = `${DEST_ARN}:7`;
    const latest = `${DEST_ARN}:$LATEST`;
    const china = 'arn:aws-cn:lambda:cn-north-1:123456789012:function:Fn';
    expect(collectReferencedLambdaFunctionArns([versioned, latest, china], SERVICE_TOKEN)).toEqual([
      versioned,
      latest,
      china,
    ]);
  });

  it('ignores layers, other services, partial ARNs, non-strings and object KEYS', () => {
    expect(
      collectReferencedLambdaFunctionArns(
        {
          layer: 'arn:aws:lambda:eu-west-1:123456789012:layer:Lib:3',
          esm: 'arn:aws:lambda:eu-west-1:123456789012:event-source-mapping:abc',
          sns: 'arn:aws:sns:eu-west-1:123456789012:topic',
          partial: 'arn:aws:lambda:eu-west-1:123456789012:function:',
          prose: `see ${DEST_ARN} for details`,
          n: 42,
          nul: null,
          [DEST_ARN]: 'x',
        },
        SERVICE_TOKEN
      )
    ).toEqual([]);
  });

  it('bounds the walk by depth, exactly at the boundary', () => {
    const nested = (wrappers: number): unknown => {
      let value: unknown = DEST_ARN;
      for (let i = 0; i < wrappers; i++) value = { next: value };
      return value;
    };
    // The string sits at depth == the number of wrappers: 8 is read, 9 is not.
    expect(collectReferencedLambdaFunctionArns(nested(8), SERVICE_TOKEN)).toEqual([DEST_ARN]);
    expect(collectReferencedLambdaFunctionArns(nested(9), SERVICE_TOKEN)).toEqual([]);
  });

  it('bounds the count, including across nested containers', () => {
    const arnAt = (i: number): string => `arn:aws:lambda:eu-west-1:123456789012:function:Fn${i}`;
    const flat = Array.from({ length: 40 }, (_, i) => arnAt(i));
    expect(collectReferencedLambdaFunctionArns(flat, SERVICE_TOKEN)).toHaveLength(16);

    const nested = { groups: flat.map((arn) => ({ items: [{ arn }] })) };
    expect(collectReferencedLambdaFunctionArns(nested, SERVICE_TOKEN)).toHaveLength(16);
  });
});

describe('CustomResourceProvider waits for a referenced Pending Lambda function', () => {
  beforeEach(() => {
    order.length = 0;
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    mockWaitActive.mockReset();
    mockWaitUpdated.mockReset();
    debugSpy.mockReset();
    mockWaitActive.mockImplementation((_config: unknown, input: { FunctionName: string }) => {
      order.push(`wait:${input.FunctionName}`);
      return Promise.resolve({});
    });
    mockWaitUpdated.mockImplementation(() => Promise.resolve({}));
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
  });

  afterEach(() => {
    disarmInterruptWatchForTests();
  });

  it('waits for the Pending destination before the handler is invoked', async () => {
    wire({ [DEST_ARN]: 'Pending' });
    await makeProvider().create('Notifications', TYPE, propsFor(DEST_ARN));

    expect(activeWaitTargets()).toContain(DEST_ARN);
    const waited = order.indexOf(`wait:${DEST_ARN}`);
    const invoked = order.findIndex((entry) => entry.startsWith('InvokeCommand:'));
    expect(waited).toBeGreaterThan(-1);
    expect(invoked).toBeGreaterThan(waited);
    // The poll that found it Pending came first.
    expect(order.indexOf(`GetFunctionConfigurationCommand:${DEST_ARN}`)).toBeLessThan(waited);
  });

  it('waits only for the Pending one when several are referenced', async () => {
    wire({ [DEST_ARN]: 'Pending', [OTHER_ARN]: 'Active' });
    await makeProvider().create('Notifications', TYPE, propsFor(OTHER_ARN, DEST_ARN));

    expect(activeWaitTargets()).toContain(DEST_ARN);
    expect(activeWaitTargets()).not.toContain(OTHER_ARN);
    expect(namesCalled('GetFunctionConfigurationCommand')).toHaveLength(2);
  });

  it('does not start a waiter for an Active reference', async () => {
    wire({ [DEST_ARN]: 'Active' });
    await makeProvider().create('Notifications', TYPE, propsFor(DEST_ARN));

    expect(activeWaitTargets()).not.toContain(DEST_ARN);
    expect(namesCalled('InvokeCommand')).toHaveLength(1);
  });

  it('makes no extra AWS call for a resource whose properties name no function', async () => {
    wire();
    await makeProvider().create('Notifications', TYPE, {
      ServiceToken: SERVICE_TOKEN,
      BucketName: 'bucket',
    });

    expect(namesCalled('GetFunctionConfigurationCommand')).toEqual([]);
    // Only the backing function's own readiness wait, as before.
    expect(activeWaitTargets()).toEqual([SERVICE_TOKEN]);
  });

  it('never waits for, nor fails on, a reference it cannot read', async () => {
    // Shaped like a real SDK rejection (`$fault` / `$metadata`), which is what
    // marks the message as AWS-authored and therefore reducible to its class.
    const denied = Object.assign(new Error('User: arn:aws:sts::1:assumed-role/R/s is not authorized'), {
      name: 'AccessDeniedException',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
    });
    wire({ [DEST_ARN]: denied });
    const result = await makeProvider().create('Notifications', TYPE, propsFor(DEST_ARN));

    expect(result.physicalId).toBe('phys-1');
    expect(activeWaitTargets()).not.toContain(DEST_ARN);
    expect(namesCalled('InvokeCommand')).toHaveLength(1);
    // The AWS sentence stays out of the log line: the class is named instead.
    const logged = debugSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('AccessDeniedException');
    expect(logged).not.toContain('is not authorized');
  });

  it('leaves the verdict to the handler when the waiter itself gives up', async () => {
    wire({ [DEST_ARN]: 'Pending' });
    mockWaitActive.mockImplementation((_config: unknown, input: { FunctionName: string }) =>
      input.FunctionName === DEST_ARN
        ? Promise.reject(new Error('Waiter has timed out'))
        : Promise.resolve({})
    );
    const result = await makeProvider().create('Notifications', TYPE, propsFor(DEST_ARN));

    expect(result.physicalId).toBe('phys-1');
    expect(namesCalled('InvokeCommand')).toHaveLength(1);
  });

  it('waits on the update path too', async () => {
    wire({ [DEST_ARN]: 'Pending' });
    await makeProvider().update(
      'Notifications',
      'phys-1',
      TYPE,
      propsFor(DEST_ARN),
      propsFor(OTHER_ARN)
    );

    expect(activeWaitTargets()).toContain(DEST_ARN);
    expect(order.indexOf(`wait:${DEST_ARN}`)).toBeLessThan(
      order.findIndex((entry) => entry.startsWith('InvokeCommand:'))
    );
  });

  it('passes a qualified ARN to the waiter unchanged', async () => {
    const versioned = `${DEST_ARN}:7`;
    wire({ [versioned]: 'Pending' });
    await makeProvider().create('Notifications', TYPE, propsFor(versioned));

    expect(activeWaitTargets()).toContain(versioned);
  });

  it('hands the waiter an abort signal and a budget within 1..600 seconds', async () => {
    wire({ [DEST_ARN]: 'Pending' });
    await makeProvider().create('Notifications', TYPE, propsFor(DEST_ARN));

    const call = mockWaitActive.mock.calls.find(
      (c) => (c[1] as { FunctionName: string }).FunctionName === DEST_ARN
    );
    const config = call?.[0] as { abortSignal?: AbortSignal; maxWaitTime: number };
    expect(config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(config.maxWaitTime).toBeGreaterThanOrEqual(1);
    expect(config.maxWaitTime).toBeLessThanOrEqual(600);
  });

  it('does not wait for a function in the Failed state', async () => {
    wire({ [DEST_ARN]: 'Failed' });
    await makeProvider().create('Notifications', TYPE, propsFor(DEST_ARN));

    expect(activeWaitTargets()).not.toContain(DEST_ARN);
    expect(namesCalled('InvokeCommand')).toHaveLength(1);
  });

  it('shares ONE budget across several Pending functions', async () => {
    const third = 'arn:aws:lambda:eu-west-1:123456789012:function:Stack-ThirdFn';
    wire({ [DEST_ARN]: 'Pending', [OTHER_ARN]: 'Pending', [third]: 'Pending' });
    let now = 1_000_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const budgets: Record<string, number> = {};
    mockWaitActive.mockImplementation(
      (config: { maxWaitTime: number }, input: { FunctionName: string }) => {
        budgets[input.FunctionName] = config.maxWaitTime;
        // The first wait spends 595 of the 600s; the second spends what is left.
        if (input.FunctionName === DEST_ARN) now += 595_000;
        if (input.FunctionName === OTHER_ARN) now += 10_000;
        return Promise.resolve({});
      }
    );
    try {
      await makeProvider().create('Notifications', TYPE, propsFor(DEST_ARN, OTHER_ARN, third));
    } finally {
      nowSpy.mockRestore();
    }

    expect(budgets[DEST_ARN]).toBe(600);
    expect(budgets[OTHER_ARN]).toBeLessThanOrEqual(5);
    // Spent: the third is read but never waited for, and the handler still runs.
    expect(budgets[third]).toBeUndefined();
    expect(namesCalled('GetFunctionConfigurationCommand')).toHaveLength(3);
    expect(namesCalled('InvokeCommand')).toHaveLength(1);
  });

  it('on update reads only an ARN that the previous properties did not name', async () => {
    wire({ [DEST_ARN]: 'Pending', [OTHER_ARN]: 'Pending' });
    await makeProvider().update(
      'Notifications',
      'phys-1',
      TYPE,
      propsFor(DEST_ARN, OTHER_ARN),
      propsFor(DEST_ARN)
    );

    expect(namesCalled('GetFunctionConfigurationCommand')).toEqual([
      `GetFunctionConfigurationCommand:${OTHER_ARN}`,
    ]);
    expect(activeWaitTargets()).toContain(OTHER_ARN);
    expect(activeWaitTargets()).not.toContain(DEST_ARN);
  });

  it('logs when more functions are referenced than are waited for', async () => {
    wire();
    const many = Array.from(
      { length: 20 },
      (_, i) => `arn:aws:lambda:eu-west-1:123456789012:function:Fn${i}`
    );
    await makeProvider().create('Notifications', TYPE, propsFor(...many));

    expect(namesCalled('GetFunctionConfigurationCommand')).toHaveLength(16);
    const logged = debugSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('only the first 16 are waited for');
  });

  it('never scans on delete', async () => {
    wire({ [DEST_ARN]: 'Pending' });
    await makeProvider().delete('Notifications', 'phys-1', TYPE, propsFor(DEST_ARN));

    expect(namesCalled('GetFunctionConfigurationCommand')).toEqual([]);
    expect(activeWaitTargets()).not.toContain(DEST_ARN);
  });

  it('scans once per call, not once per retried attempt', async () => {
    wire({ [DEST_ARN]: 'Pending' });
    const baseline = mockLambdaSend.getMockImplementation();
    let invokes = 0;
    mockLambdaSend.mockImplementation(
      (cmd: { constructor: { name: string }; input?: { FunctionName?: string } }) => {
        if (cmd.constructor.name === 'InvokeCommand' && (invokes += 1) === 1) {
          // A pre-delivery rejection the provider replays (IAM propagation).
          return Promise.reject(
            Object.assign(new Error('User: arn:aws:sts::1:assumed-role/R/s is not authorized to perform: lambda:InvokeFunction'), {
              name: 'AccessDeniedException',
              $fault: 'client',
              $metadata: { httpStatusCode: 403 },
            })
          );
        }
        return baseline?.(cmd);
      }
    );
    const realSleep = customResourceRetryDelays.sleep;
    customResourceRetryDelays.sleep = () => Promise.resolve();
    try {
      await makeProvider().create('Notifications', TYPE, propsFor(DEST_ARN));
    } finally {
      customResourceRetryDelays.sleep = realSleep;
    }

    expect(invokes).toBeGreaterThanOrEqual(2);
    expect(namesCalled('GetFunctionConfigurationCommand')).toHaveLength(1);
    expect(activeWaitTargets().filter((fn) => fn === DEST_ARN)).toHaveLength(1);
  });

  describe('interrupt during the wait', () => {
    afterEach(() => {
      vi.useRealTimers();
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    });

    it('aborts the waiter, throws the interrupt (not swallowed), never invokes, leaves no timer', async () => {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      vi.useFakeTimers();
      const baselineTimers = vi.getTimerCount();
      const baselineListeners = process.listeners('SIGINT');
      wire({ [DEST_ARN]: 'Pending' });
      // Observed inside the waiter but ASSERTED after the call: the provider
      // catches whatever the waiter throws, so an `expect` in here would be
      // swallowed and could never fail the test.
      let listenersArmed = 0;
      let abortedAfterPoll: boolean | undefined;
      mockWaitActive.mockImplementation(async (config: { abortSignal?: AbortSignal }) => {
        const ours = process.listeners('SIGINT').filter((l) => !baselineListeners.includes(l));
        listenersArmed = ours.length;
        for (const l of ours) (l as unknown as () => void)();
        // The 1s poll turns the interrupt into an abort of the waiter.
        await vi.advanceTimersByTimeAsync(1000);
        abortedAfterPoll = config.abortSignal?.aborted;
        throw new Error('aborted');
      });

      const err = await makeProvider()
        .create('Notifications', TYPE, propsFor(DEST_ARN))
        .catch((e: unknown) => e);

      expect(listenersArmed).toBeGreaterThan(0);
      expect(abortedAfterPoll).toBe(true);
      expect(isInterruptedWaitError(err)).toBe(true);
      expect(namesCalled('InvokeCommand')).toEqual([]);
      // This provider's own 1s poll is cleared. The watch's shared SIGINT latch
      // stays armed until the command ends, by design, so it is not asserted.
      expect(vi.getTimerCount()).toBe(baselineTimers);
    });
  });
});
