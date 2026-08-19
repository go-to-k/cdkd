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

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

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

interface Counts {
  invokes: () => number;
  publishes: () => number;
  puts: () => number;
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
}): Counts {
  let invokeCount = 0;
  let publishCount = 0;
  let putCount = 0;
  let recycleCount = 0;

  const directSuccessPayload = {
    Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'phys-123', Data: { Out: 'ok' } })),
  };

  mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'PutObjectCommand') {
      putCount += 1;
      const override = opts.put?.(putCount);
      if (override !== undefined) return override;
      return Promise.resolve({});
    }
    if (name === 'GetObjectCommand') {
      // Only reached on the SNS path (no direct Lambda payload to short-circuit
      // on) — hand back a terminal SUCCESS so the poll returns immediately.
      return Promise.resolve({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'phys-123', Data: {} })
            ),
        },
      });
    }
    return Promise.resolve({}); // DeleteObject
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
      return Promise.resolve(directSuccessPayload);
    }
    if (name === 'UpdateFunctionConfigurationCommand') {
      recycleCount += 1;
      return Promise.resolve({});
    }
    // GetFunction / GetFunctionConfiguration for the readiness waiters.
    return Promise.resolve({
      Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
    });
  });

  return {
    invokes: () => invokeCount,
    publishes: () => publishCount,
    puts: () => putCount,
    recycles: () => recycleCount,
  };
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({
    responseBucket: 'test-bucket',
    asyncResponseTimeoutMs: 10_000,
  });
}

describe('CustomResourceProvider retry on a THROWN transient error (issue #2033)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    warnSpy.mockReset();
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '2';
  });
  afterEach(() => {
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
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('before the request was delivered');
  });

  it('gives up after CDKD_CR_AUTHZ_MAX_RETRIES thrown attempts and surfaces the error', async () => {
    const counts = wire({
      invoke: () => Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException')),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/not authorized to perform/);

    expect(counts.invokes()).toBe(3); // 1 initial + 2 retries
    expect(counts.recycles()).toBe(0);
  });

  it('does not retry a thrown error at all when CDKD_CR_AUTHZ_MAX_RETRIES=0', async () => {
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    const counts = wire({
      invoke: () => Promise.reject(awsError(PROPAGATION_MESSAGE, 'AccessDeniedException')),
    });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/not authorized to perform/);
    expect(counts.invokes()).toBe(1);
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
    await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });
    expect(deleteCounts.invokes()).toBe(2);
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

  // --- COVERED: the response-placeholder PutObject --------------------------

  it('retries the response-placeholder PutObject on its OWN budget, not the invoke budget', async () => {
    // `CDKD_CR_AUTHZ_MAX_RETRIES=0` disables the re-INVOKE arm entirely, so the
    // loop-level catch cannot rescue this — and two consecutive failures exceed
    // that arm's budget even when it is enabled. Only the placeholder's own
    // `withRetry` (the full dense propagation schedule) gets past put #2.
    //
    // Written this way DELIBERATELY: the obvious single-failure version passes
    // with the wrap deleted, because the loop-level arm catches the same throw
    // pre-delivery and re-runs the whole attempt — measured, not assumed.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
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
    // The placeholder never reached the handler, so the Invoke is issued ONCE
    // and the response URL cdkd polls is the one it just signed.
    expect(counts.invokes()).toBe(1);
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
});
