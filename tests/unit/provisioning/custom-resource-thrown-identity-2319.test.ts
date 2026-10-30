import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2319: a failed custom resource create / update must not write
 * the caller's account id, assumed-role ARN and session name into the thrown
 * message, which `extractDeploymentEventError` persists to
 * `deployments/{runId}.jsonl`. An AWS-authored failure (`Invoke`, `Publish`,
 * the response-placeholder `PutObject`) is reduced to its class plus the
 * `--verbose` pointer; AWS's text goes to `debug`, masked. A cdkd-authored
 * failure keeps its text. The same holds for the readiness waiter's Lambda
 * status REASON sentences, which AWS words with ARNs: the reason CODE stays.
 */

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
const warnSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: (...args: unknown[]) => debugSpy(...args),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: (...args: unknown[]) => debugSpy(...args),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: () => Promise.resolve('https://s3.example.com/presigned-url'),
}));

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
  customResourceRetryDelays,
  waitForLambdaFunctionActive,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { extractDeploymentEventError } from '../../../src/types/deployment-events.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { LambdaClient } from '@aws-sdk/client-lambda';

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/cdkd-session-8f21`;
const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:Stack-onEvent';
const SNS_SERVICE_TOKEN = 'arn:aws:sns:us-east-1:123456789012:Stack-CrTopic';

/** An access denial as Lambda / SNS / S3 word it, AWS-authored. */
function accessDenied(name: string, action: string): Error {
  return Object.assign(
    new Error(
      `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
        `arn:aws:lambda:us-east-1:${CALLER_ACCOUNT}:function:x`
    ),
    { name, $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );
}

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Every command succeeds unless `fail[name]` answers for it. */
function wire(fail: Record<string, () => Promise<unknown>> = {}): void {
  const route = (command: unknown): Promise<unknown> => {
    const override = fail[commandName(command)];
    if (override !== undefined) return override();
    if (commandName(command) === 'InvokeCommand') {
      return Promise.resolve({
        Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'phys-1', Data: {} })),
      });
    }
    if (commandName(command) === 'GetObjectCommand') {
      return Promise.resolve({
        Body: {
          transformToString: () =>
            Promise.resolve(JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'phys-1' })),
        },
      });
    }
    return Promise.resolve({});
  };
  mockLambdaSend.mockImplementation(route);
  mockSnsSend.mockImplementation(route);
  mockS3Send.mockImplementation(route);
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({
    responseBucket: 'test-bucket',
    asyncResponseTimeoutMs: 10_000,
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const debugged = (): string[] => debugSpy.mock.calls.map((c) => c.map(String).join(' '));

/** Masks the caller's role name, standing in for the deploy's secret masker. */
const mask = (text: string): string => text.split(CALLER_ROLE).join('***');

const realSleep = customResourceRetryDelays.sleep;

describe('custom resource thrown errors keep the caller identity out (go-to-k/cdkd#2319)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    mockWaitActive.mockReset();
    mockWaitUpdated.mockReset();
    debugSpy.mockReset();
    warnSpy.mockReset();
    mockWaitActive.mockImplementation(() => Promise.resolve({}));
    mockWaitUpdated.mockImplementation(() => Promise.resolve({}));
    // A denial reads as IAM propagation, so the pre-delivery arm spends its
    // whole schedule first: make every wait instantaneous.
    customResourceRetryDelays.sleep = () => Promise.resolve();
  });
  afterEach(() => {
    customResourceRetryDelays.sleep = realSleep;
  });

  /** Assertions every redacted wrap owes, whichever AWS call failed. */
  function expectRedacted(error: Error, operation: 'create' | 'update', cause: Error): void {
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.message).toBe(
      `Failed to ${operation} custom resource CrResource: ${cause.name}. ${VERBOSE_POINTER}`
    );
    const persisted = JSON.stringify(extractDeploymentEventError(error));
    expect(persisted).not.toContain(CALLER_ACCOUNT);
    expect(persisted).not.toContain(CALLER_ROLE);
    // The AWS error stays the cause and the stamp lets a chain-reading
    // classifier see its wording. (The IAM-propagation retry itself runs on
    // the raw error inside the invoke loop, before this wrap.)
    expect(error.cause).toBe(cause);
    expect(hasRedactedCause(error)).toBe(true);
    expect(retryClassificationText(error)).toContain('not authorized to perform');
    expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
    // AWS's text reaches debug, through the operation's masker.
    const lines = debugged().filter((l) => l.includes(`Failed to ${operation} custom resource`));
    expect(lines.some((l) => l.includes('is not authorized to perform'))).toBe(true);
    expect(lines.some((l) => l.includes(CALLER_ROLE))).toBe(false);
    expect(lines.some((l) => l.includes('assumed-role/***'))).toBe(true);
  }

  it('reduces a create whose Lambda Invoke is denied to the class', async () => {
    const denial = accessDenied('AccessDeniedException', 'lambda:InvokeFunction');
    wire({ InvokeCommand: () => Promise.reject(denial) });

    const error = await thrown(
      makeProvider().create(
        'CrResource',
        'Custom::CrResource',
        { ServiceToken: SERVICE_TOKEN },
        { maskSecrets: mask }
      )
    );

    expectRedacted(error, 'create', denial);
  });

  it('reduces an update whose Lambda Invoke is denied to the class', async () => {
    const denial = accessDenied('AccessDeniedException', 'lambda:InvokeFunction');
    wire({ InvokeCommand: () => Promise.reject(denial) });

    const error = await thrown(
      makeProvider().update(
        'CrResource',
        'phys-1',
        'Custom::CrResource',
        { ServiceToken: SERVICE_TOKEN, Key: 'new' },
        { ServiceToken: SERVICE_TOKEN, Key: 'old' },
        { maskSecrets: mask }
      )
    );

    expectRedacted(error, 'update', denial);
  });

  it('reduces a create whose SNS Publish is denied to the class', async () => {
    const denial = accessDenied('AuthorizationErrorException', 'SNS:Publish');
    wire({ PublishCommand: () => Promise.reject(denial) });

    const error = await thrown(
      makeProvider().create(
        'CrResource',
        'Custom::CrResource',
        { ServiceToken: SNS_SERVICE_TOKEN },
        { maskSecrets: mask }
      )
    );

    expectRedacted(error, 'create', denial);
  });

  it('reduces a create whose response placeholder PutObject is denied, keeping it non-retryable', async () => {
    const denial = accessDenied('AccessDenied', 's3:PutObject');
    wire({ PutObjectCommand: () => Promise.reject(denial) });

    const error = await thrown(
      makeProvider().create(
        'CrResource',
        'Custom::CrResource',
        { ServiceToken: SERVICE_TOKEN },
        { maskSecrets: mask }
      )
    );

    expect(error.message).toBe(
      `Failed to create custom resource CrResource: AccessDenied. ${VERBOSE_POINTER}`
    );
    expect(JSON.stringify(extractDeploymentEventError(error))).not.toContain(CALLER_ACCOUNT);
    expect(error.cause).toBe(denial);
    expect(hasRedactedCause(error)).toBe(true);
    // The placeholder's own withRetry spent the budget: the redacted wrap must
    // not make it retryable again.
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(mockLambdaSend.mock.calls.some((c) => commandName(c[0]) === 'InvokeCommand')).toBe(
      false
    );
  });

  it('withholds a non-Error PutObject rejection rather than persisting it', async () => {
    wire({ PutObjectCommand: () => Promise.reject(`denied for ${CALLER_ARN}`) });

    const error = await thrown(
      makeProvider().create(
        'CrResource',
        'Custom::CrResource',
        { ServiceToken: SERVICE_TOKEN },
        { maskSecrets: mask }
      )
    );

    expect(error.message).toBe(
      `Failed to create custom resource CrResource: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(error.message).not.toContain(CALLER_ACCOUNT);
    const details = debugged().filter((l) => l.includes('PutObject failure detail'));
    expect(details.some((l) => l.includes('assumed-role/***'))).toBe(true);
    expect(details.some((l) => l.includes(CALLER_ROLE))).toBe(false);
  });

  it('warns a failed delete by class, with the masked sentence only at debug', async () => {
    const denial = accessDenied('AccessDeniedException', 'lambda:InvokeFunction');
    // Every attempt is denied, so the pre-delivery retries end in the catch.
    wire({ InvokeCommand: () => Promise.reject(denial) });

    const result = await makeProvider().delete(
      'CrResource',
      'phys-1',
      'Custom::CrResource',
      { ServiceToken: SERVICE_TOKEN },
      { maskSecrets: mask }
    );

    expect(result).toMatchObject({ outcome: 'skipped' });
    const warns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('Failed to delete custom resource CrResource'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`but continuing: AccessDeniedException. ${VERBOSE_POINTER} The Delete`);
    expect(warns[0]).not.toContain(CALLER_ACCOUNT);
    const details = debugged().filter((l) => l.includes('delete failure detail'));
    expect(details.some((l) => l.includes('assumed-role/***'))).toBe(true);
    expect(details.some((l) => l.includes(CALLER_ROLE))).toBe(false);
  });

  it('warns the pre-delivery retry by class, with AWS\'s sentence only at debug', async () => {
    const denial = accessDenied('AccessDeniedException', 'lambda:InvokeFunction');
    let invokes = 0;
    wire({
      InvokeCommand: () => {
        invokes += 1;
        return invokes === 1
          ? Promise.reject(denial)
          : Promise.resolve({
              Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'phys-1', Data: {} })),
            });
      },
    });

    await makeProvider().create(
      'CrResource',
      'Custom::CrResource',
      { ServiceToken: SERVICE_TOKEN },
      { maskSecrets: mask }
    );

    const warns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('before the request was delivered'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`AccessDeniedException. ${VERBOSE_POINTER} Retrying in`);
    expect(warns[0]).not.toContain('..');
    expect(warns[0]).not.toContain(CALLER_ACCOUNT);
    const details = debugged().filter((l) => l.includes('pre-delivery failure detail'));
    expect(details.some((l) => l.includes('assumed-role/***'))).toBe(true);
    expect(details.some((l) => l.includes(CALLER_ROLE))).toBe(false);
  });

  it("keeps a cdkd-authored failure's text: the handler's FAILED reason", async () => {
    wire({
      InvokeCommand: () =>
        Promise.resolve({
          Payload: Buffer.from(JSON.stringify({ Status: 'FAILED', Reason: 'bucket is not empty' })),
        }),
    });

    const error = await thrown(
      makeProvider().create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    );

    expect(error.message).toBe(
      'Failed to create custom resource CrResource: Custom resource handler returned FAILED: bucket is not empty'
    );
    expect(hasRedactedCause(error)).toBe(false);
  });

  it('withholds a non-Error rejection rather than persisting it', async () => {
    wire({ InvokeCommand: () => Promise.reject(`denied for ${CALLER_ARN}`) });

    const error = await thrown(
      makeProvider().create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    );

    expect(error.message).toBe(
      `Failed to create custom resource CrResource: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(debugged().some((l) => l.includes(CALLER_ARN))).toBe(true);
  });

  it("withholds the waiter's Lambda status REASON sentences, keeping the codes", async () => {
    const kmsReason =
      `Lambda was unable to decrypt the environment variables because KMS access was denied. ` +
      `KMS Exception: AccessDeniedException KMS Message: User: ${CALLER_ARN} is not authorized ` +
      `to perform: kms:Decrypt`;
    mockWaitActive.mockImplementation(() =>
      Promise.reject(
        new Error(
          JSON.stringify({
            state: 'FAILURE',
            reason: {
              $metadata: { httpStatusCode: 200 },
              Configuration: {
                State: 'Failed',
                StateReasonCode: 'KMSAccessDeniedException',
                StateReason: kmsReason,
                LastUpdateStatus: 'Failed',
                LastUpdateStatusReasonCode: 'KMSAccessDeniedException',
                LastUpdateStatusReason: kmsReason,
              },
            },
          })
        )
      )
    );

    const error = await thrown(
      waitForLambdaFunctionActive(new LambdaClient({ region: 'us-east-1' }), SERVICE_TOKEN)
    );

    expect(error.message).toContain('State=Failed');
    expect(error.message).toContain('StateReasonCode=KMSAccessDeniedException');
    expect(error.message).toContain('StateReason withheld');
    expect(error.message).toContain('LastUpdateStatusReasonCode=KMSAccessDeniedException');
    expect(error.message).toContain('LastUpdateStatusReason withheld');
    expect(error.message).toContain(VERBOSE_POINTER);
    // Neither the thrown text nor the rewritten cause keeps the sentence.
    for (const text of [error.message, (error.cause as Error).message]) {
      expect(text).not.toContain(CALLER_ACCOUNT);
      expect(text).not.toContain('unable to decrypt');
    }
    expect(debugged().some((l) => l.includes(`StateReason=${kmsReason}`))).toBe(true);
    expect(debugged().some((l) => l.includes(`LastUpdateStatusReason=${kmsReason}`))).toBe(true);
  });

  it('sends the recycle waiter\'s status reason to debug, never into its summary line', async () => {
    const reason = `The function could not start: role ${CALLER_ARN} cannot be assumed`;
    let invokes = 0;
    wire({
      InvokeCommand: () => {
        invokes += 1;
        const payload =
          invokes === 1
            ? { Status: 'FAILED', Reason: 'User: x is not authorized to perform: lambda:GetFunction' }
            : { PhysicalResourceId: 'phys-1', Data: {} };
        return Promise.resolve({ Payload: Buffer.from(JSON.stringify(payload)) });
      },
    });
    // The readiness wait before each invoke succeeds; the wait after the
    // recycle's UpdateFunctionConfiguration is the one that fails.
    let updatedWaits = 0;
    mockWaitUpdated.mockImplementation(() => {
      updatedWaits += 1;
      if (updatedWaits !== 2) return Promise.resolve({});
      return Promise.reject(
        new Error(
          JSON.stringify({
            state: 'FAILURE',
            reason: {
              $metadata: { httpStatusCode: 200 },
              Configuration: {
                LastUpdateStatus: 'Failed',
                LastUpdateStatusReasonCode: 'InvalidRole',
                LastUpdateStatusReason: reason,
              },
            },
          })
        )
      );
    });

    await makeProvider().create(
      'CrResource',
      'Custom::CrResource',
      { ServiceToken: SERVICE_TOKEN },
      { maskSecrets: mask }
    );

    const recycle = debugged().filter((l) => l.includes('Could not recycle backing function'));
    expect(recycle).toHaveLength(1);
    expect(recycle[0]).toContain('LastUpdateStatusReasonCode=InvalidRole');
    expect(recycle[0]).toContain('LastUpdateStatusReason withheld');
    expect(recycle[0]).not.toContain(CALLER_ACCOUNT);
    // Through the operation's masker.
    expect(debugged().some((l) => l.includes(`LastUpdateStatusReason=${mask(reason)}`))).toBe(true);
    expect(debugged().some((l) => l.includes(CALLER_ROLE))).toBe(false);
  });

  it("masks the readiness waiter's status reason at debug", async () => {
    const reason = `role ${CALLER_ARN} cannot be assumed`;
    mockWaitActive.mockImplementation(() =>
      Promise.reject(
        new Error(
          JSON.stringify({
            state: 'FAILURE',
            reason: {
              $metadata: { httpStatusCode: 200 },
              Configuration: { State: 'Failed', StateReasonCode: 'InvalidRole', StateReason: reason },
            },
          })
        )
      )
    );
    wire();

    await thrown(
      makeProvider().create(
        'CrResource',
        'Custom::CrResource',
        { ServiceToken: SERVICE_TOKEN },
        { maskSecrets: mask }
      )
    );

    expect(debugged().some((l) => l.includes(`StateReason=${mask(reason)}`))).toBe(true);
    expect(debugged().some((l) => l.includes(CALLER_ROLE))).toBe(false);
  });

  it('adds no pointer when the waiter reports no reason sentence', async () => {
    mockWaitActive.mockImplementation(() =>
      Promise.reject(
        new Error(
          JSON.stringify({
            state: 'FAILURE',
            reason: { $metadata: { httpStatusCode: 200 }, Configuration: { State: 'Failed' } },
          })
        )
      )
    );

    const error = await thrown(
      waitForLambdaFunctionActive(new LambdaClient({ region: 'us-east-1' }), SERVICE_TOKEN)
    );

    expect(error.message).toContain('State=Failed');
    expect(error.message).not.toContain('withheld,');
    expect(error.message).not.toContain(VERBOSE_POINTER);
  });
});
