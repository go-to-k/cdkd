import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Issue #2033: retry behaviour for an error THROWN by one of the Custom
// Resource provider's OWN AWS SDK calls, as opposed to the handler RETURNING
// `Status: 'FAILED'` (which the sibling
// `custom-resource-provider-authz-retry.test.ts` covers).
//
// Kept in its own file for the same reason that one is: command-name dispatch
// rather than ordered `*Once` queues, and the paths here span several
// invocation attempts. No `*Once` primers are used anywhere in this file, so
// nothing can leak into a later test.
//
// BOTH polarities are pinned per arm, deliberately: a test that only asserts
// the retry cannot tell the fix from a blanket wrapper that reintroduces the
// stranded-response-URL bug `disableOuterRetry` exists to prevent.
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
/**
 * Stand-in for the STS client `getAccountInfo()` resolves the deploy account
 * through (issue #1866). A FIXED, non-empty `Account` — an empty / absent one
 * is what `getAccountInfo` flags `fabricated`, which is a different case with
 * its own arm.
 */
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    // Issue #1866: the synthetic `StackId` is built from `getAccountInfo()`,
    // which resolves the account through THIS bag's STS client. Without a
    // stand-in it reaches for a real one, and — because `getAccountInfo`
    // swallows its own failure — the provider silently answers `fabricated`
    // and warns on every invocation. Answering here keeps the provider off
    // real AWS AND keeps the account a proven one, which is the state every
    // case in this file assumes.
    sts: { send: mockStsSend },
  }),
}));

const warnSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
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

const mockGetSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

// The two readiness waiters are replaced so their FAILURE shapes can be driven
// directly. Against the real waiter a permanent `lambda:GetFunction` denial
// takes 600s of polling to surface, which no unit test can pay — and the
// failure MESSAGE (`@smithy/util-waiter`'s serialized result) is the whole
// subject of two of the cases below. Everything else in `@aws-sdk/client-lambda`
// is passed through unchanged, because the mocks above dispatch on
// `cmd.constructor.name`.
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
  CR_DELETE_INVOKE_FAILED_SKIP_REASON,
  customResourceRetryDelays,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import { IAM_PROPAGATION_MAX_RETRIES } from '../../../src/deployment/retry.js';
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../src/provisioning/interrupt-watch.js';

const SERVICE_TOKEN =
  'arn:aws:lambda:us-east-1:123456789012:function:Stack-ProviderframeworkonEvent';
const SNS_SERVICE_TOKEN = 'arn:aws:sns:us-east-1:123456789012:Stack-CrTopic';

/**
 * The wording the deploying principal's own `lambda:InvokeFunction` denial
 * carries while a freshly-attached policy is still propagating — the failure
 * issue #2033 was filed for. Matches `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS`
 * (`not authorized to perform`), i.e. exactly the class every OTHER resource
 * type already gets 26 retries for.
 */
const PROPAGATION_MESSAGE =
  'User: arn:aws:sts::123456789012:assumed-role/DeployRole/session is not authorized to perform: ' +
  'lambda:InvokeFunction on resource: arn:aws:lambda:us-east-1:123456789012:function:Stack-ProviderframeworkonEvent';

function awsError(message: string, name: string): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * The `Error` `@smithy/util-waiter`'s `checkExceptions` raises on TIMEOUT:
 * `JSON.stringify({ ...result, reason: 'Waiter has timed out' })`, where
 * `observedResponses` keys are `createMessageFromResponse` status lines. Copied
 * from `node_modules/@smithy/util-waiter` rather than invented — the whole
 * point of the case is that this REAL message matches the authz classifier.
 */
function waiterTimeoutError(observed: string): Error {
  return Object.assign(
    new Error(
      JSON.stringify({
        state: 'TIMEOUT',
        observedResponses: { [observed]: 4 },
        reason: 'Waiter has timed out',
      })
    ),
    { name: 'TimeoutError' }
  );
}

/**
 * The `Error` the same helper raises for a non-TIMEOUT terminal state
 * (`State: 'Failed'`, i.e. an ENI / VPC failure): a bare
 * `JSON.stringify(result)` whose `reason` is the ENTIRE `GetFunction`
 * response — environment variables included.
 */
function waiterFailedStateError(secret: string): Error {
  return new Error(
    JSON.stringify({
      state: 'FAILURE',
      reason: {
        Configuration: {
          FunctionName: 'Stack-ProviderframeworkonEvent',
          State: 'Failed',
          StateReasonCode: 'SubnetOutOfIPAddresses',
          StateReason: 'The function could not create an ENI',
          Environment: { Variables: { DB_PASSWORD: secret } },
        },
      },
    })
  );
}

interface Counts {
  invokes: () => number;
  /** Invokes that RETURNED — i.e. requests the handler actually received. */
  delivered: () => number;
  publishes: () => number;
  puts: () => number;
  putKeys: () => string[];
  deleteKeys: () => string[];
  recycles: () => number;
}

/**
 * Wire every AWS command by name. `invokeBehaviour` decides what the Nth
 * `InvokeCommand` does (1-based); `putBehaviour` does the same for the response
 * placeholder `PutObjectCommand`. Returning `undefined` means "take the default
 * happy path".
 */
function wire(opts: {
  invoke?: (n: number) => unknown;
  put?: (n: number) => unknown;
  publish?: (n: number) => unknown;
  /** Body the SNS path's S3 poll hands back (default: a terminal SUCCESS). */
  snsResponse?: () => Record<string, unknown>;
}): Counts {
  let invokeCount = 0;
  let deliveredCount = 0;
  let publishCount = 0;
  let putCount = 0;
  let recycleCount = 0;
  const putKeys: string[] = [];
  const deleteKeys: string[] = [];

  const directSuccessPayload = {
    Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'phys-123', Data: { Out: 'ok' } })),
  };

  mockS3Send.mockImplementation((cmd: { constructor: { name: string }; input?: unknown }) => {
    const name = cmd.constructor.name;
    const key = (cmd.input as { Key?: string } | undefined)?.Key ?? '';
    if (name === 'PutObjectCommand') {
      putCount += 1;
      putKeys.push(key);
      const override = opts.put?.(putCount);
      if (override !== undefined) return override;
      return Promise.resolve({});
    }
    if (name === 'GetObjectCommand') {
      // Only reached on the SNS path (no direct Lambda payload to short-circuit
      // on) — hand back a terminal response so the poll returns immediately.
      const body = opts.snsResponse?.() ?? {
        Status: 'SUCCESS',
        PhysicalResourceId: 'phys-123',
        Data: {},
      };
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(body)) },
      });
    }
    if (name === 'DeleteObjectCommand') deleteKeys.push(key);
    return Promise.resolve({});
  });

  mockSnsSend.mockImplementation(() => {
    publishCount += 1;
    const override = opts.publish?.(publishCount);
    if (override !== undefined) return override;
    return Promise.resolve({});
  });

  mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'InvokeCommand') {
      invokeCount += 1;
      const override = opts.invoke?.(invokeCount);
      if (override !== undefined) return override;
      deliveredCount += 1;
      return Promise.resolve(directSuccessPayload);
    }
    if (name === 'UpdateFunctionConfigurationCommand') {
      recycleCount += 1;
      return Promise.resolve({});
    }
    // GetFunction / GetFunctionConfiguration for the delete-path pre-check.
    return Promise.resolve({
      Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
    });
  });

  return {
    invokes: () => invokeCount,
    delivered: () => deliveredCount,
    publishes: () => publishCount,
    puts: () => putCount,
    putKeys: () => [...putKeys],
    deleteKeys: () => [...deleteKeys],
    recycles: () => recycleCount,
  };
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({
    responseBucket: 'test-bucket',
    asyncResponseTimeoutMs: 10_000,
  });
}

function preDeliveryWarns(): string[] {
  return warnSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('before the request was delivered'));
}

const realSleep = customResourceRetryDelays.sleep;

describe('CustomResourceProvider retry on a THROWN transient error (issue #2033)', () => {
  /** Total backoff the code ASKED for, with every wait made instantaneous. */
  let virtualElapsedMs = 0;

  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    mockWaitActive.mockReset();
    mockWaitUpdated.mockReset();
    mockGetSignedUrl.mockReset();
    warnSpy.mockReset();
    mockWaitActive.mockImplementation(() => Promise.resolve({}));
    mockWaitUpdated.mockImplementation(() => Promise.resolve({}));
    mockGetSignedUrl.mockImplementation(() =>
      Promise.resolve('https://s3.example.com/presigned-url')
    );
    // The pre-delivery arm now spends the FULL dense IAM-propagation schedule
    // (47.75s over 26 retries), so a real sleep would make this file unrunnable.
    virtualElapsedMs = 0;
    customResourceRetryDelays.sleep = (ms: number) => {
      virtualElapsedMs += ms;
      return Promise.resolve();
    };
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '2';
  });
  afterEach(() => {
    customResourceRetryDelays.sleep = realSleep;
    delete process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
  });

  // --- COVERED: Lambda Invoke, pre-delivery ---------------------------------

  it('retries a propagation-worded throw from Invoke and succeeds on the next attempt', async () => {
    const counts = wire({
      invoke: (n) =>
        n === 1
          ? Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException'))
          : undefined,
    });
    const provider = makeProvider();

    const result = await provider.create('CrResource', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('phys-123');
    // Exactly one extra call reached AWS — no more, no fewer.
    expect(counts.invokes()).toBe(2);
    // A FRESH response URL per attempt: the placeholder PUT is re-issued, so
    // the retry can never reuse the abandoned attempt's key.
    expect(counts.puts()).toBe(2);
    // No exec-env recycle: the denial is on cdkd's principal, not the backing
    // function's role. (This also distinguishes the fix from "route it through
    // the existing FAILED-response arm".)
    expect(counts.recycles()).toBe(0);
    expect(preDeliveryWarns()).toHaveLength(1);
  });

  it('survives a propagation window of ~10s, and the handler is invoked ONCE (issue #2033)', async () => {
    // THE case the issue was filed for. This repo has MEASURED the
    // IAM-propagation window at 7-12s, and the fix as first written shared the
    // FAILED-response budget (2 retries => 250ms + 500ms = 0.75s of coverage),
    // so every attempt landed inside 1.5s and the reported scenario still
    // failed. The pre-delivery arm now carries its own budget on the same dense
    // schedule every other resource type gets.
    const counts = wire({
      invoke: () =>
        virtualElapsedMs < 10_000
          ? Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException'))
          : undefined,
    });
    const provider = makeProvider();

    const result = await provider.create('CrResource', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('phys-123');
    // 0.25 + 0.5 + 1 + 2 x 5 = 11.75s of backoff over 8 retries clears a 10s
    // window; the 9th attempt is the one that gets through.
    expect(counts.invokes()).toBe(9);
    expect(virtualElapsedMs).toBeGreaterThanOrEqual(10_000);
    // The whole reason the big budget is affordable: nothing was delivered, so
    // the user's handler ran exactly once no matter how many retries it took.
    expect(counts.delivered()).toBe(1);
    expect(counts.recycles()).toBe(0);
  });

  it('spends the full dense propagation budget before giving up, then surfaces the error', async () => {
    const counts = wire({
      invoke: () => Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException')),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/not authorized to perform/);

    expect(counts.invokes()).toBe(IAM_PROPAGATION_MAX_RETRIES + 1);
    expect(virtualElapsedMs).toBe(47_750);
    expect(counts.delivered()).toBe(0);
    expect(counts.recycles()).toBe(0);
  });

  it('keeps retrying the PRE-DELIVERY arm when CDKD_CR_AUTHZ_MAX_RETRIES=0', async () => {
    // `=0` bounds RE-INVOCATIONS OF THE HANDLER, and this arm performs none —
    // the same reason the placeholder PutObject's own `withRetry` is not
    // disabled by it either. Turning off re-invokes must not cost a user the
    // propagation coverage every other resource type gets for free.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    const counts = wire({
      invoke: (n) =>
        n <= 5
          ? Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException'))
          : undefined,
    });
    const provider = makeProvider();

    const result = await provider.create('CrResource', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('phys-123');
    expect(counts.invokes()).toBe(6);
    expect(counts.delivered()).toBe(1);
  });

  it('sweeps the abandoned response placeholder before each pre-delivery retry', async () => {
    // Each replayed attempt signs a FRESH key, so the previous attempt's empty
    // object is unreachable and nothing else collects it (`cdkd gc` scans the
    // ASSET bucket, not this prefix).
    const counts = wire({
      invoke: (n) =>
        n <= 2
          ? Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException'))
          : undefined,
    });
    const provider = makeProvider();

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    expect(counts.puts()).toBe(3);
    // Every key is swept, IN ORDER: the two abandoned ones by the new catch,
    // the third by the ordinary direct-payload cleanup. Without the sweep only
    // the third is deleted and the first two are orphaned in the state bucket.
    expect(counts.deleteKeys()).toEqual(counts.putKeys());
  });

  it('routes update() and delete() through the same thrown-error arm', async () => {
    const counts = wire({
      invoke: (n) =>
        n === 1
          ? Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException'))
          : undefined,
    });
    const provider = makeProvider();

    const updated = await provider.update(
      'CrResource',
      'phys-old',
      'Custom::CrResource',
      { ServiceToken: SERVICE_TOKEN, Foo: 'new' },
      { ServiceToken: SERVICE_TOKEN, Foo: 'old' }
    );
    expect(updated.physicalId).toBe('phys-123');
    expect(counts.invokes()).toBe(2);

    // delete() takes the same helper (its own catch is lenient, so the retry
    // has to happen INSIDE the helper for the Delete request to reach AWS at
    // all — a bare throw would be swallowed as "continuing").
    const deleteCounts = wire({
      invoke: (n) =>
        n === 1
          ? Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException'))
          : undefined,
    });
    const deleteResult = await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });
    expect(deleteCounts.invokes()).toBe(2);
    // The retry worked, so this really is a delete — not a skip.
    expect(deleteResult).toBeUndefined();
  });

  it('aborts the pre-delivery backoff on Ctrl-C, and leaves no SIGINT listener behind', async () => {
    // `docs/provider-development.md` requires a new wait site to be
    // interruptible; a bare `setTimeout` leaves Ctrl-C dead for the whole
    // 47.75s schedule. Only the listeners THIS invocation added are fired, so
    // the harness's own SIGINT handling is untouched.
    // The watch this provider now shares (issue #2104) arms only inside a
    // command that owns interrupt handling, so a command without a shutdown
    // path keeps Node's default terminate. A suite runs no command, so stand in
    // for the scope production has opened by this point.
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    const baseline = process.listeners('SIGINT');
    const counts = wire({
      invoke: () => Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException')),
    });
    let ours: (() => void)[] = [];
    customResourceRetryDelays.sleep = (ms: number) => {
      virtualElapsedMs += ms;
      for (const listener of ours) listener();
      return Promise.resolve();
    };
    const provider = makeProvider();

    const pending = provider.create('CrResource', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });
    ours = process
      .listeners('SIGINT')
      .filter((l) => !baseline.includes(l)) as unknown as (() => void)[];
    expect(ours).toHaveLength(1);

    await expect(pending).rejects.toThrow(/interrupted by user/);

    // One backoff entered, then the abort — not 26.
    expect(counts.invokes()).toBe(1);
    // At most ONE listener beyond the baseline, ever. It is deliberately not
    // removed on dispose: a listener torn down between two sequential waits
    // cannot record a signal landing in the gap (issue #1952 blocker).
    expect(process.listeners('SIGINT').length).toBeLessThanOrEqual(baseline.length + 1);
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  // --- COVERED: a WRAPPED propagation error ---------------------------------

  it('retries when the propagation wording is only on the .cause (issue #2040 class)', async () => {
    // `isThrottlingError` / `isMarkedNonRetryable` both walk the cause chain;
    // this classifier did not, so a wrapped denial was single-shot again.
    const counts = wire({
      invoke: (n) =>
        n === 1
          ? Promise.reject(
              new Error('Custom resource invoke failed', {
                cause: awsError(PROPAGATION_MESSAGE, 'AccessDeniedException'),
              })
            )
          : undefined,
    });
    const provider = makeProvider();

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    expect(counts.invokes()).toBe(2);
  });

  // --- COVERED: the response-placeholder PutObject --------------------------

  it('retries the response-placeholder PutObject on its OWN budget, not the invoke budget', async () => {
    // The discriminator is NOT the call count: with the `withRetry` wrap
    // deleted, the loop's pre-delivery arm rescues the same throws and issues
    // the same three PUTs. What separates them is that the loop arm WARNS and
    // abandons a placeholder per attempt, while the placeholder's own retry
    // re-PUTs the SAME key and says nothing. Measured both ways.
    const counts = wire({
      put: (n) =>
        n <= 2
          ? Promise.reject(
              awsError(
                'User: arn:aws:sts::123456789012:assumed-role/DeployRole/session is not authorized to perform: s3:PutObject',
                'AccessDenied'
              )
            )
          : undefined,
    });
    const provider = makeProvider();

    const result = await provider.create('CrResource', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('phys-123');
    expect(counts.puts()).toBe(3);
    // ONE key, re-PUT: the placeholder's own retry never re-mints the response
    // URL. The loop arm would have signed three and swept two.
    expect(new Set(counts.putKeys()).size).toBe(1);
    expect(counts.deleteKeys()).toEqual([counts.putKeys()[0]]);
    expect(preDeliveryWarns()).toHaveLength(0);
    // The placeholder never reached the handler, so the Invoke is issued ONCE
    // and the response URL cdkd polls is the one it just signed.
    expect(counts.invokes()).toBe(1);
  });

  it('does NOT give the placeholder PutObject a SECOND budget from the invoke loop', async () => {
    // An exhausted `withRetry` throw re-entered the loop's pre-delivery arm,
    // which replayed the whole attempt — so one `s3:PutObject` denial cost
    // 27 x 27 PUTs while the JSDoc claimed the call had "its OWN budget".
    const counts = wire({
      put: () =>
        Promise.reject(
          awsError(
            'User: arn:aws:sts::123456789012:assumed-role/DeployRole/session is not authorized to perform: s3:PutObject',
            'AccessDenied'
          )
        ),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/s3:PutObject/);

    expect(counts.puts()).toBe(IAM_PROPAGATION_MAX_RETRIES + 1);
    expect(preDeliveryWarns()).toHaveLength(0);
    expect(counts.invokes()).toBe(0);
  });

  it('aborts the placeholder PutObject retry on Ctrl-C too (withRetry interrupt threading)', async () => {
    // The other half of the same convention: `withRetry` polls `isInterrupted`
    // once per second while sleeping, so omitting the two options leaves Ctrl-C
    // dead for the placeholder's own 47.75s schedule even when the loop's
    // backoff is interruptible.
    // The watch this provider now shares (issue #2104) arms only inside a
    // command that owns interrupt handling, so a command without a shutdown
    // path keeps Node's default terminate. A suite runs no command, so stand in
    // for the scope production has opened by this point.
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    const baseline = process.listeners('SIGINT');
    const counts = wire({
      put: () =>
        Promise.reject(
          awsError(
            'User: arn:aws:sts::123456789012:assumed-role/DeployRole/session is not authorized to perform: s3:PutObject',
            'AccessDenied'
          )
        ),
    });
    let ours: (() => void)[] = [];
    customResourceRetryDelays.sleep = (ms: number) => {
      virtualElapsedMs += ms;
      for (const listener of ours) listener();
      return Promise.resolve();
    };
    const provider = makeProvider();

    const pending = provider.create('CrResource', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });
    ours = process
      .listeners('SIGINT')
      .filter((l) => !baseline.includes(l)) as unknown as (() => void)[];

    await expect(pending).rejects.toThrow(/interrupted by user/);

    // The interrupt lands on the check that opens the SECOND backoff, so the
    // schedule stops two PUTs in rather than after 27.
    expect(counts.puts()).toBe(2);
    // At most ONE listener beyond the baseline, ever. It is deliberately not
    // removed on dispose: a listener torn down between two sequential waits
    // cannot record a signal landing in the gap (issue #1952 blocker).
    expect(process.listeners('SIGINT').length).toBeLessThanOrEqual(baseline.length + 1);
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('retries a propagation-worded throw from getSignedUrl, which sits OUTSIDE the PutObject retry', async () => {
    // `prepareInvocation` has to be INSIDE the loop's `try`: the presign is not
    // wrapped by any inner retry, so a throw here is rescued only by the loop.
    // Hoisting those two lines back out passes every other test in the tree.
    //
    // The wording is deliberately one of `CR_THROWN_AUTHZ_EXTRA_SIGNALS`, i.e.
    // a phrase `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS` does NOT carry, so the
    // case also pins that the extras list is consulted at all.
    let signCount = 0;
    const counts = wire({});
    mockGetSignedUrl.mockImplementation(() => {
      signCount += 1;
      return signCount === 1
        ? Promise.reject(
            awsError(
              'no identity-based policy allows the s3:PutObject action',
              'AccessDeniedException'
            )
          )
        : Promise.resolve('https://s3.example.com/presigned-url');
    });
    const provider = makeProvider();

    const result = await provider.create('CrResource', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('phys-123');
    expect(signCount).toBe(2);
    expect(counts.invokes()).toBe(1);
    expect(preDeliveryWarns()).toHaveLength(1);
  });

  // --- COVERED: SNS Publish, pre-delivery -----------------------------------

  it('retries a propagation-worded throw from the SNS Publish delivery', async () => {
    const counts = wire({
      publish: (n) =>
        n === 1
          ? Promise.reject(awsError(PROPAGATION_MESSAGE, 'AuthorizationErrorException'))
          : undefined,
    });
    const provider = makeProvider();

    const result = await provider.create('CrResource', 'Custom::CrResource', {
      ServiceToken: SNS_SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('phys-123');
    expect(counts.publishes()).toBe(2);
    expect(counts.puts()).toBe(2);
  });

  // --- UNCOVERED (deliberately): a NON-transient throw ----------------------

  it('does NOT retry a non-transient throw from Invoke — single-shot', async () => {
    const counts = wire({
      invoke: () => Promise.reject(new TypeError('Cannot read properties of undefined')),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/Cannot read properties of undefined/);

    expect(counts.invokes()).toBe(1);
    expect(counts.puts()).toBe(1);
  });

  it('does NOT retry a THROTTLE throw from Invoke — it may have been delivered', async () => {
    // `isRetryableTransientError` WOULD retry this; `isTransientAuthzThrow`
    // deliberately does not, because a throttle can arrive after the request
    // was accepted. This pins the classifier's narrowness, not just its width.
    const counts = wire({
      invoke: () => Promise.reject(awsError('Rate exceeded', 'TooManyRequestsException')),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/Rate exceeded/);

    expect(counts.invokes()).toBe(1);
  });

  it('does NOT retry a permanent explicit-deny that matches only the BARE "is unable to assume"', async () => {
    // `CR_TRANSIENT_AUTHZ_SIGNALS` carries that phrase un-anchored, which is
    // right for a handler-authored FAILED reason and wrong for AWS text about a
    // call cdkd made — `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS` anchors it
    // (`is unable to assume the role` / `... provided role` /
    // `Firehose is unable to assume role`) precisely so a permanent deny cannot
    // burn 47.75s. Re-uniting the whole CR list into the thrown classifier
    // would re-introduce it, so this pins the difference.
    const counts = wire({
      invoke: () =>
        Promise.reject(
          awsError(
            'User: arn:aws:iam::123456789012:user/dev is unable to assume role DeployRole because of an explicit deny',
            'AccessDenied'
          )
        ),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/explicit deny/);

    expect(counts.invokes()).toBe(1);
  });

  it('does NOT retry a cdkd-authored refusal that happens to carry authz wording', async () => {
    // `markNonRetryable` is cdkd declaring that THIS raising cannot succeed on
    // a replay. The classifier must honour it ahead of any message test, or a
    // refusal whose text quotes an AWS denial is replayed for 47.75s.
    const counts = wire({
      invoke: () =>
        Promise.reject(
          markNonRetryable(awsError(PROPAGATION_MESSAGE, 'CustomResourceRefusalError'))
        ),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/not authorized to perform/);

    expect(counts.invokes()).toBe(1);
  });

  // --- UNCOVERED (deliberately): the readiness WAITER -----------------------

  it('does NOT replay a waiter TIMEOUT whose observedResponses read as a 403 denial', async () => {
    // `@smithy/util-waiter` serializes `observedResponses` into the timeout
    // message, and its keys are `403: <the AWS denial>` — so the message
    // matches every pattern this classifier has. The waiter has ALREADY polled
    // for its full 600s, so replaying it turned a permanent
    // `lambda:GetFunction` denial into 3 x 600s and blew any
    // `--resource-timeout AWS::CloudFormation::CustomResource=15m`.
    const counts = wire({});
    mockWaitActive.mockImplementation(() =>
      Promise.reject(
        waiterTimeoutError(
          `403: User: arn:aws:sts::123456789012:assumed-role/DeployRole/session is not authorized ` +
            `to perform: lambda:GetFunction on resource: ${SERVICE_TOKEN}`
        )
      )
    );
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/did not reach a ready state for Invoke/);

    expect(mockWaitActive).toHaveBeenCalledTimes(1);
    expect(counts.puts()).toBe(1);
    expect(counts.invokes()).toBe(0);
    expect(preDeliveryWarns()).toHaveLength(0);
  });

  it('does not put the waiter payload — and so a backing function env var — into the thrown message', async () => {
    // The non-TIMEOUT arm serializes the WHOLE `GetFunction` response, so this
    // message reached `ProvisioningError.message` and
    // `extractDeploymentEventError` persisted it to `deployments/{runId}.jsonl`
    // — a durable store contractually free of resource properties.
    wire({});
    mockWaitActive.mockImplementation(() =>
      Promise.reject(waiterFailedStateError('hunter2-super-secret'))
    );
    const provider = makeProvider();

    const error = await provider
      .create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(error).toBeDefined();
    expect(error?.message).not.toContain('hunter2-super-secret');
    expect(error?.message).not.toContain('DB_PASSWORD');
    // The AWS-authored status fields ARE kept — withholding the payload must
    // not cost the diagnosis.
    expect(error?.message).toContain('State=Failed');
    expect(error?.message).toContain('StateReasonCode=SubnetOutOfIPAddresses');
    expect(error?.message).toContain('StateReason=The function could not create an ENI');
  });

  // --- UNCOVERED (deliberately): a POST-delivery throw ----------------------

  it('does NOT retry a propagation-worded throw raised AFTER the invoke was delivered', async () => {
    // The Invoke RETURNS (so the handler ran); the crash payload happens to
    // carry the very wording the classifier matches. Retrying would re-run a
    // handler that already executed and strand this attempt's response URL,
    // which is exactly what `disableOuterRetry` exists to prevent — so the
    // `delivered` fence must win over the classifier.
    const counts = wire({
      invoke: () =>
        Promise.resolve({
          FunctionError: 'Unhandled',
          Payload: Buffer.from(JSON.stringify({ errorMessage: PROPAGATION_MESSAGE })),
        }),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/Lambda function error \(Unhandled\)/);

    expect(counts.invokes()).toBe(1);
    expect(counts.puts()).toBe(1);
  });

  it('does NOT re-PUBLISH an SNS custom resource whose handler answered FAILED (SNS twin)', async () => {
    // The Lambda twin above is the `FunctionError` case. On the SNS path the
    // handler answers through S3, so the post-delivery failure arrives as a
    // FAILED response — and with the re-invoke budget disabled it must be
    // terminal. What this pins is the budget SPLIT: the FAILED-response arm
    // reads `transientAuthzMaxRetries`, never the pre-delivery arm's 26.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    const counts = wire({
      snsResponse: () => ({ Status: 'FAILED', Reason: PROPAGATION_MESSAGE }),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SNS_SERVICE_TOKEN })
    ).rejects.toThrow(/not authorized to perform/);

    expect(counts.publishes()).toBe(1);
    expect(counts.puts()).toBe(1);
  });

  it('re-publishes an SNS transient-authz FAILED on the SMALL budget, not the pre-delivery one', async () => {
    const counts = wire({
      snsResponse: () => ({ Status: 'FAILED', Reason: PROPAGATION_MESSAGE }),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SNS_SERVICE_TOKEN })
    ).rejects.toThrow(/not authorized to perform/);

    // 1 + CDKD_CR_AUTHZ_MAX_RETRIES(2), NOT 1 + 26.
    expect(counts.publishes()).toBe(3);
  });

  // --- delete(): a failed Delete is a SKIP, never a silent orphan -----------

  it('reports delete() as SKIPPED when the Delete request never completed', async () => {
    // The catch used to swallow and return undefined, which `deleteSkipReason`
    // reads as DELETED — so `cdkd destroy` printed `deleted`, dropped the state
    // record and exited 0 over a handler that never received a Delete.
    const counts = wire({
      invoke: () => Promise.reject(awsError('User: … is not authorized', 'AccessDeniedException')),
    });
    const provider = makeProvider();

    const result = await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result).toEqual({ outcome: 'skipped', reason: CR_DELETE_INVOKE_FAILED_SKIP_REASON });
    expect(counts.invokes()).toBe(1);
  });

  it('keeps the skip reason clear of every already-deleted phrase the callers match on', () => {
    // A reason is rendered into the `Error` the deploy-side replacement sites
    // throw, and their catch classifies "already gone" by SUBSTRING — so a
    // reason carrying one of these would drop the state record again, one
    // layer further out. (This is also why the AWS message is logged rather
    // than interpolated into the reason.)
    for (const phrase of [
      'does not exist',
      'was not found',
      'not found',
      'No policy found',
      'NoSuchEntity',
      'NotFoundException',
      'ResourceNotFoundException',
    ]) {
      expect(CR_DELETE_INVOKE_FAILED_SKIP_REASON.toLowerCase()).not.toContain(
        phrase.toLowerCase()
      );
    }
  });

  it('still reports delete() as DELETED when the backing Lambda is gone', async () => {
    // The polarity of the case above: there the handler CAN never run again, so
    // the record is dead weight rather than a live resource, and turning that
    // into a skip would make every re-run of a destroy exit 2.
    wire({});
    mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetFunctionCommand') {
        return Promise.reject(awsError('Function not found', 'ResourceNotFoundException'));
      }
      return Promise.resolve({});
    });
    const provider = makeProvider();

    const result = await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result).toBeUndefined();
  });

  // --- CDKD_CR_AUTHZ_MAX_RETRIES is clamped --------------------------------

  it('clamps an out-of-range CDKD_CR_AUTHZ_MAX_RETRIES instead of re-invoking to the deadline', async () => {
    // `1e9` is finite and >= 0, so it passed the old gate and re-invoked the
    // user's handler until the deploy engine's 1h per-resource deadline.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '1e9';
    const counts = wire({
      invoke: () =>
        Promise.resolve({
          Payload: Buffer.from(JSON.stringify({ Status: 'FAILED', Reason: PROPAGATION_MESSAGE })),
        }),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/not authorized to perform/);

    // 1 + the ceiling (10), and the ceiling only.
    expect(counts.invokes()).toBe(11);
    expect(counts.recycles()).toBe(10);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'CDKD_CR_AUTHZ_MAX_RETRIES=1e9 is out of range'
    );
  });
});
