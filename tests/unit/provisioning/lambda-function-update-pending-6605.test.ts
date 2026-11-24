/**
 * go-to-k/cdkd#6605: a Lambda function create returns while the function is
 * still `Pending` (minutes for a VPC function). An update landing in that
 * window is refused with a `ResourceConflictException` whose text QUOTES the
 * state, which the retry table's bare spelling never matched. `update()` now
 * waits for `Active` once on that refusal and resends the refused call once;
 * an ordinary update makes no extra call.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockLambdaSend, waitUpdated, waitActive, debugSpy, deadline } = vi.hoisted(() => ({
  mockLambdaSend: vi.fn(),
  waitUpdated: vi.fn(),
  waitActive: vi.fn(),
  debugSpy: vi.fn(),
  deadline: { remainingMs: Number.POSITIVE_INFINITY, expired: false },
}));

vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/resource-deadline.js')>()),
  enclosingDeadlineRemainingMs: () => deadline.remainingMs,
  enclosingDeadlineExpired: () => deadline.expired,
}));

vi.mock('@aws-sdk/client-lambda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-lambda')>();
  return {
    ...actual,
    waitUntilFunctionUpdatedV2: waitUpdated,
    waitUntilFunctionActiveV2: waitActive,
  };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: vi.fn() },
  }),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: debugSpy, info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn((): unknown => child) };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::Lambda::Function';
const ARN = 'arn:aws:lambda:us-east-1:123456789012:function:f';
const BASE = {
  Role: 'arn:aws:iam::123456789012:role/r',
  Handler: 'index.handler',
  Runtime: 'nodejs20.x',
};

/** AWS's text, verbatim from CloudTrail (us-east-1, go-to-k/cdkd#6605). */
const QUOTED_PENDING =
  "The operation cannot be performed at this time. The resource arn:aws:lambda:us-east-1:123456789012:function:f is currently in the following state: 'Pending'. StateReasonCode: 'Creating'";
const BARE_PENDING =
  'The operation cannot be performed at this time. The function is currently in the following state: Pending';

const awsAuthored = (name: string, message: string): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 409, requestId: 'req-0123456789' },
  });
const pendingRefusal = (message = QUOTED_PENDING): Error =>
  awsAuthored('ResourceConflictException', message);

/** Every call by its command's class name, in order, waits included. */
const timeline: string[] = [];

/** `refusals[name]` is consumed one per call to that command; the rest succeed. */
function serve(refusals: Record<string, Error[]> = {}, live: Record<string, unknown> = {}): void {
  mockLambdaSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    timeline.push(name);
    const next = refusals[name]?.shift();
    if (next !== undefined) throw next;
    if (name === 'GetFunctionCommand') {
      return {
        Configuration: { FunctionName: 'f', FunctionArn: ARN, ...BASE, State: 'Active', ...live },
      };
    }
    return {};
  });
}

const sent = (name: string): number => timeline.filter((n) => n === name).length;

describe('Lambda function update while Pending (go-to-k/cdkd#6605)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLambdaSend.mockReset();
    waitUpdated.mockReset();
    waitActive.mockReset();
    timeline.length = 0;
    deadline.remainingMs = Number.POSITIVE_INFINITY;
    deadline.expired = false;
    waitUpdated.mockResolvedValue({});
    waitActive.mockImplementation(async () => {
      timeline.push('waitActive');
      return {};
    });
    provider = new LambdaFunctionProvider();
  });

  it('waits for Active and resends UpdateFunctionConfiguration once on the quoted refusal', async () => {
    serve({ UpdateFunctionConfigurationCommand: [pendingRefusal()] });
    await provider.update('F', 'f', TYPE, { ...BASE, Timeout: 10 }, { ...BASE, Timeout: 3 });
    expect(timeline.slice(0, 3)).toEqual([
      'UpdateFunctionConfigurationCommand',
      'waitActive',
      'UpdateFunctionConfigurationCommand',
    ]);
    expect(waitActive).toHaveBeenCalledTimes(1);
    expect(waitActive.mock.calls[0]?.[0]).toMatchObject({
      maxWaitTime: provider.functionUpdateMaxWaitSeconds,
    });
    expect(waitActive.mock.calls[0]?.[1]).toEqual({ FunctionName: 'f' });
    // The lambda-vpc-update-while-pending fixture greps this line.
    expect(debugSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'Lambda function f is still Pending; waiting for it to be Active'
    );
  });

  it('caps the wait by the enclosing resource deadline, less the margin', async () => {
    deadline.remainingMs = 120_000;
    serve({ UpdateFunctionConfigurationCommand: [pendingRefusal()] });
    await provider.update('F', 'f', TYPE, { ...BASE, Timeout: 10 }, { ...BASE, Timeout: 3 });
    expect(waitActive.mock.calls[0]?.[0]).toMatchObject({
      maxWaitTime: Math.floor((120_000 - provider.latestPublishedDeadlineMarginMs) / 1000),
    });
  });

  it('does not wait when the resource deadline leaves no budget', async () => {
    deadline.remainingMs = provider.latestPublishedDeadlineMarginMs + 500;
    serve({ UpdateFunctionConfigurationCommand: [pendingRefusal()] });
    await expect(
      provider.update('F', 'f', TYPE, { ...BASE, Timeout: 10 }, { ...BASE, Timeout: 3 })
    ).rejects.toThrow(ProvisioningError);
    expect(waitActive).not.toHaveBeenCalled();
    expect(sent('UpdateFunctionConfigurationCommand')).toBe(1);
  });

  it('does not resend once the resource deadline expired during the wait', async () => {
    serve({ UpdateFunctionConfigurationCommand: [pendingRefusal()] });
    waitActive.mockImplementation(async () => {
      deadline.expired = true;
      return {};
    });
    await expect(
      provider.update('F', 'f', TYPE, { ...BASE, Timeout: 10 }, { ...BASE, Timeout: 3 })
    ).rejects.toThrow(ProvisioningError);
    expect(waitActive).toHaveBeenCalledTimes(1);
    expect(sent('UpdateFunctionConfigurationCommand')).toBe(1);
  });

  it('waits and resends the tag calls on a tags-only update', async () => {
    serve({ TagResourceCommand: [pendingRefusal()] });
    await provider.update(
      'F',
      'f',
      TYPE,
      { ...BASE, Tags: [{ Key: 'a', Value: '1' }] },
      { ...BASE }
    );
    expect(timeline).toEqual([
      'GetFunctionCommand',
      'TagResourceCommand',
      'waitActive',
      'TagResourceCommand',
    ]);
  });

  it('waits and resends UntagResource on a tag-removal-only update', async () => {
    serve({ UntagResourceCommand: [pendingRefusal()] });
    await provider.update(
      'F',
      'f',
      TYPE,
      { ...BASE },
      { ...BASE, Tags: [{ Key: 'gone', Value: 'x' }] }
    );
    expect(timeline).toEqual([
      'GetFunctionCommand',
      'UntagResourceCommand',
      'waitActive',
      'UntagResourceCommand',
    ]);
  });

  it('resends only the refused tag call, not an Untag that already succeeded', async () => {
    serve({ TagResourceCommand: [pendingRefusal()] });
    await provider.update(
      'F',
      'f',
      TYPE,
      { ...BASE, Tags: [{ Key: 'a', Value: '1' }] },
      { ...BASE, Tags: [{ Key: 'gone', Value: 'x' }] }
    );
    expect(timeline).toEqual([
      'GetFunctionCommand',
      'UntagResourceCommand',
      'TagResourceCommand',
      'waitActive',
      'TagResourceCommand',
    ]);
  });

  it('also reads the bare spelling', async () => {
    serve({ UpdateFunctionConfigurationCommand: [pendingRefusal(BARE_PENDING)] });
    await provider.update('F', 'f', TYPE, { ...BASE, Timeout: 10 }, { ...BASE, Timeout: 3 });
    expect(waitActive).toHaveBeenCalledTimes(1);
    expect(sent('UpdateFunctionConfigurationCommand')).toBe(2);
  });

  it('waits and resends when UpdateFunctionCode is the first call (a code-only update)', async () => {
    serve({ UpdateFunctionCodeCommand: [pendingRefusal()] });
    await provider.update(
      'F',
      'f',
      TYPE,
      { ...BASE, Code: { S3Bucket: 'b', S3Key: 'new.zip' } },
      { ...BASE, Code: { S3Bucket: 'b', S3Key: 'old.zip' } }
    );
    expect(sent('UpdateFunctionConfigurationCommand')).toBe(0);
    expect(timeline.slice(0, 3)).toEqual([
      'UpdateFunctionCodeCommand',
      'waitActive',
      'UpdateFunctionCodeCommand',
    ]);
  });

  it('waits and resends when PutRuntimeManagementConfig is the first call', async () => {
    serve({ PutRuntimeManagementConfigCommand: [pendingRefusal()] });
    await provider.update(
      'F',
      'f',
      TYPE,
      { ...BASE, RuntimeManagementConfig: { UpdateRuntimeOn: 'FunctionUpdate' } },
      { ...BASE }
    );
    expect(timeline.slice(0, 3)).toEqual([
      'PutRuntimeManagementConfigCommand',
      'waitActive',
      'PutRuntimeManagementConfigCommand',
    ]);
  });

  it.each([
    ['PutFunctionRecursionConfigCommand', { RecursiveLoop: 'Allow' }, {}],
    ['PutFunctionConcurrencyCommand', { ReservedConcurrentExecutions: 5 }, {}],
    ['DeleteFunctionConcurrencyCommand', {}, { ReservedConcurrentExecutions: 5 }],
    ['PutFunctionCodeSigningConfigCommand', { CodeSigningConfigArn: 'arn:csc' }, {}],
    ['DeleteFunctionCodeSigningConfigCommand', {}, { CodeSigningConfigArn: 'arn:csc' }],
  ])('waits and resends when %s is the first call', async (command, desired, previous) => {
    serve({ [command]: [pendingRefusal()] });
    await provider.update('F', 'f', TYPE, { ...BASE, ...desired }, { ...BASE, ...previous });
    expect(timeline.slice(0, 3)).toEqual([command, 'waitActive', command]);
  });

  it('makes no extra call on an ordinary update', async () => {
    serve();
    await provider.update('F', 'f', TYPE, { ...BASE, Timeout: 10 }, { ...BASE, Timeout: 3 });
    expect(waitActive).not.toHaveBeenCalled();
    expect(timeline).toEqual(['UpdateFunctionConfigurationCommand', 'GetFunctionCommand']);
  });

  it('does not wait on a refusal for another reason', async () => {
    serve({
      UpdateFunctionConfigurationCommand: [
        awsAuthored(
          'ResourceConflictException',
          `The operation cannot be performed at this time. An update is in progress for resource: ${ARN}`
        ),
      ],
    });
    await expect(
      provider.update('F', 'f', TYPE, { ...BASE, Timeout: 10 }, { ...BASE, Timeout: 3 })
    ).rejects.toThrow(ProvisioningError);
    expect(waitActive).not.toHaveBeenCalled();
    expect(sent('UpdateFunctionConfigurationCommand')).toBe(1);
  });

  it('waits once per update: a later call refused for Pending fails without a second wait', async () => {
    serve({
      UpdateFunctionConfigurationCommand: [pendingRefusal()],
      UpdateFunctionCodeCommand: [pendingRefusal()],
    });
    await expect(
      provider.update(
        'F',
        'f',
        TYPE,
        { ...BASE, Timeout: 10, Code: { S3Bucket: 'b', S3Key: 'new.zip' } },
        { ...BASE, Timeout: 3, Code: { S3Bucket: 'b', S3Key: 'old.zip' } }
      )
    ).rejects.toThrow(ProvisioningError);
    expect(waitActive).toHaveBeenCalledTimes(1);
    expect(sent('UpdateFunctionCodeCommand')).toBe(1);
  });

  it('resends once: the resend refused again fails, still retryable', async () => {
    serve({
      UpdateFunctionConfigurationCommand: [pendingRefusal(), pendingRefusal()],
    });
    const failure = await provider
      .update('F', 'f', TYPE, { ...BASE, Timeout: 10 }, { ...BASE, Timeout: 3 })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(failure).toBeInstanceOf(ProvisioningError);
    expect(waitActive).toHaveBeenCalledTimes(1);
    expect(sent('UpdateFunctionConfigurationCommand')).toBe(2);
    expect(isRetryableTransientError(failure!, retryClassificationText(failure!))).toBe(true);
  });

  it('fails without resending when the function never becomes Active', async () => {
    serve({ UpdateFunctionConfigurationCommand: [pendingRefusal()] });
    waitActive.mockRejectedValue(new Error('Waiter has timed out'));
    await expect(
      provider.update('F', 'f', TYPE, { ...BASE, Timeout: 10 }, { ...BASE, Timeout: 3 })
    ).rejects.toThrow(/Lambda function F did not become Active/);
    expect(sent('UpdateFunctionConfigurationCommand')).toBe(1);
  });

  it('does not wait on a Managed Instances function, whose $LATEST never reads Active', async () => {
    const capacity = {
      LambdaManagedInstancesCapacityProviderConfig: {
        CapacityProviderArn: 'arn:aws:lambda:us-east-1:123456789012:capacity-provider:cp',
      },
    };
    serve(
      { UpdateFunctionConfigurationCommand: [pendingRefusal()] },
      { CapacityProviderConfig: capacity }
    );
    await expect(
      provider.update(
        'F',
        'f',
        TYPE,
        { ...BASE, Timeout: 10, CapacityProviderConfig: capacity },
        { ...BASE, Timeout: 3, CapacityProviderConfig: capacity }
      )
    ).rejects.toThrow(ProvisioningError);
    expect(waitActive).not.toHaveBeenCalled();
    expect(sent('UpdateFunctionConfigurationCommand')).toBe(1);
  });

  it('keeps markUnsettled before the first call, once per key', async () => {
    serve({ UpdateFunctionConfigurationCommand: [pendingRefusal()] });
    const marks: string[] = [];
    await provider.update(
      'F',
      'f',
      TYPE,
      { ...BASE, Timeout: 10 },
      { ...BASE, Timeout: 3 },
      { markUnsettled: (k: string) => marks.push(k) }
    );
    expect(marks).toEqual(['Timeout']);
  });
});

describe('retry table reads the quoted Pending state (go-to-k/cdkd#6605)', () => {
  it.each([
    ['quoted', QUOTED_PENDING],
    ['bare', BARE_PENDING],
  ])('classifies the %s spelling as retryable', (_label, message) => {
    const error = pendingRefusal(message);
    expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
  });
});
