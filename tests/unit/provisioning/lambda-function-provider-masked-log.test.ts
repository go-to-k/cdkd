/**
 * Issue #2177 — the Lambda family's masked log sinks.
 *
 * `LambdaFunctionProvider.create()` / `update()` build ONE masked sink set per
 * operation from the context's masker and route every log line, every refusal
 * and the AWS error text a failure message wraps through it. A function name is
 * used verbatim, so the only name the base masker cannot know is one RECORDED
 * from a previous secret (state keeps its `{{resolve:` reference, or `***`).
 *
 * Cases assert over the WHOLE transcript (every debug, warn and error line) or
 * the thrown message. The secrets are sized for the arm each case isolates:
 *
 *  - `LONG`, which the message-level mask catches: it fences the AWS-echo sites,
 *    where only routing the text through the masker removes it;
 *  - `TINY_*`, two characters, below the masker's substring floor
 *    (`MIN_NEEDLE_LENGTH`) and in no fixed wording, so on a cdkd line only the
 *    RAW value mask `log.value(...)` can remove them.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockLambdaSend, debugSpy, warnSpy, errorSpy, waitUpdated, waitActive } = vi.hoisted(
  () => ({
    mockLambdaSend: vi.fn(),
    debugSpy: vi.fn(),
    warnSpy: vi.fn(),
    errorSpy: vi.fn(),
    waitUpdated: vi.fn(),
    waitActive: vi.fn(),
  })
);

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
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: errorSpy,
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: errorSpy,
    }),
  };
});

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import {
  createSecretMasker,
  maskSecretsInError,
  SECRET_MASK,
} from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import { ProvisioningError, formatError } from '../../../src/utils/error-handler.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::Lambda::Function';

/** Long enough for the message-level substring arm. */
const LONG = 'lambda-secret-role-value';
/** Two-character secrets in no fixed wording: only a RAW value mask removes them. */
const TINY_NAME = 'qf';
const TINY_LOOP = 'qx';
const TINY_ARN = 'jv';
const TINY_CONC = 'zk';
/** Three characters: below the base substring floor, at the sinks' needle floor. */
const TINY3 = 'kpz';
/** A 2-character secret that occurs in cdkd's own wording (`Up-da-ting`). */
const IN_PROSE = 'da';
/** A JSON-shaped secret: `JSON.stringify` escapes its quotes out of literal reach. */
const JSON_SECRET = '{"user":"svc","pw":"hunter22-json"}';
const ESCAPED_JSON_SECRET = JSON.stringify(JSON_SECRET).slice(1, -1);
const PRESIGNED = 'https://awslambda-us-east-1-tasks.s3.amazonaws.com/snapshots/presigned-code';

/**
 * What a FAILED `@smithy/util-waiter` throws: `JSON.stringify(result)`, whose
 * `reason` is the whole GetFunction response.
 */
function waiterFailure(state: 'Failed' | 'Active'): Error {
  const configuration =
    state === 'Failed'
      ? {
          LastUpdateStatus: 'Failed',
          LastUpdateStatusReason: 'The function could not be updated',
          LastUpdateStatusReasonCode: 'InternalError',
        }
      : { State: 'Failed', StateReason: 'Function creation failed', StateReasonCode: 'InternalError' };
  return new Error(
    JSON.stringify({
      state: 'FAILURE',
      reason: {
        Configuration: {
          FunctionName: 'plain-fn',
          Environment: { Variables: { DB_CREDENTIALS: JSON_SECRET } },
          ...configuration,
        },
        Code: { Location: PRESIGNED },
      },
      observedResponses: { '200: OK': 3 },
    })
  );
}

/** Every rendering of `error` a cdkd printer reaches: the engine wrap included. */
/**
 * Every rendering of `error` a cdkd printer reaches, as the engine produces it:
 * its per-resource wrap (whose one printed cause level is the provider's
 * message), and `maskSecretsInError` over the chain with the deploy's bag,
 * which is what any printer receives.
 */
function printed(error: Error, bag: RecordedSecretValues = BAG): string {
  const engineWrap = new ProvisioningError('Failed to update resource Fn', TYPE, 'Fn', 'plain-fn', error);
  return [
    formatError(engineWrap),
    formatError(maskSecretsInError(engineWrap, bag)),
    formatError(maskSecretsInError(error, bag)),
    error.message,
  ].join('\n');
}

/** A secret that spells the retry table's `...following state: Pending` wording. */
const RETRY_WORD = 'Pending';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const BAG = bagOf(LONG, TINY_NAME, TINY_LOOP, TINY_ARN, TINY_CONC, TINY3, IN_PROSE, JSON_SECRET);
const maskSecrets = createSecretMasker(BAG);

/** A previous `FunctionName` as state persists a secret: its reference. */
const RECORDED_REF = '{{resolve:secretsmanager:old-fn-name}}';

/** An AWS-authored failure (the marker fields `describeAwsFailure` keys on). */
const awsAuthored = (name: string, message: string): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 400, requestId: 'req-0123456789' },
  });

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Every debug, warn and error line the provider wrote, joined. */
const transcript = (): string =>
  [...debugSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
    .map((args) => String(args[0]))
    .join('\n');

const allLines = (): string[] =>
  [...debugSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map((args) =>
    String(args[0])
  );

type Handler = (input: Record<string, unknown>) => unknown;

/**
 * A fake Lambda answering by command name. A handler may throw; an absent one
 * answers `{}`. `GetFunction` defaults to the named function with an ARN that
 * embeds its name, which is what the tag lines used to print.
 */
function fakeLambda(functionName: string, handlers: Record<string, Handler> = {}): void {
  mockLambdaSend.mockImplementation(async (command: { input: Record<string, unknown> }) => {
    const name = commandName(command);
    const handler = handlers[name];
    if (handler) return handler(command.input);
    if (name === 'CreateFunctionCommand') {
      return {
        FunctionName: functionName,
        FunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`,
      };
    }
    if (name === 'GetFunctionCommand') {
      return {
        Configuration: {
          FunctionName: functionName,
          FunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`,
        },
      };
    }
    return {};
  });
}

const reject = (error: Error): Handler => () => {
  throw error;
};

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

function createProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Code: { ZipFile: 'exports.handler = async () => {};' },
    Role: 'arn:aws:iam::123456789012:role/exec',
    Handler: 'index.handler',
    Runtime: 'nodejs20.x',
    ...extra,
  };
}

/** Both sides of an update that changes every field the update path logs. */
function updatePair(
  desiredName: unknown,
  previousName: unknown,
  extra: Record<string, unknown> = {}
): [Record<string, unknown>, Record<string, unknown>] {
  const previous = {
    FunctionName: previousName,
    Code: { ZipFile: 'old' },
    Role: 'arn:aws:iam::123456789012:role/exec',
    Handler: 'index.handler',
    Runtime: 'nodejs20.x',
    Timeout: 3,
    CodeSigningConfigArn: 'arn:aws:lambda:us-east-1:123456789012:code-signing-config:csc-old',
    ReservedConcurrentExecutions: 5,
    Tags: [{ Key: 'old', Value: 'v' }],
  };
  const desired = {
    FunctionName: desiredName,
    Code: { ZipFile: 'new' },
    Role: 'arn:aws:iam::123456789012:role/exec',
    Handler: 'index.handler',
    Runtime: 'nodejs20.x',
    Timeout: 10,
    RecursiveLoop: 'Terminate',
    CodeSigningConfigArn: 'arn:aws:lambda:us-east-1:123456789012:code-signing-config:csc-new',
    ReservedConcurrentExecutions: 7,
    RuntimeManagementConfig: { UpdateRuntimeOn: 'FunctionUpdate' },
    Tags: [{ Key: 'new', Value: 'v' }],
    ...extra,
  };
  return [desired, previous];
}

describe('LambdaFunctionProvider masked log sinks (issue #2177)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLambdaSend.mockReset();
    waitUpdated.mockReset();
    waitActive.mockReset();
    waitUpdated.mockResolvedValue({});
    waitActive.mockResolvedValue({});
    provider = new LambdaFunctionProvider();
  });

  describe('create()', () => {
    it('masks a short secret FunctionName on the success line', async () => {
      fakeLambda(TINY_NAME);
      await provider.create('Fn', TYPE, createProps({ FunctionName: TINY_NAME }), {
        maskSecrets,
      });
      const log = transcript();
      expect(log).toContain(`Successfully created Lambda function Fn: ${SECRET_MASK}`);
      expect(log).not.toMatch(/\bqf\b/);
    });

    it('masks AWS text quoting a secret in the create failure, keeping the rest', async () => {
      const error = awsAuthored(
        'InvalidParameterValueException',
        `The role defined for the function cannot be assumed by Lambda: ${LONG}`
      );
      fakeLambda('plain-fn', { CreateFunctionCommand: reject(error) });
      const failure = await thrown(
        provider.create('Fn', TYPE, createProps({ FunctionName: 'plain-fn' }), { maskSecrets })
      );
      expect(failure.message).toBe(
        `Failed to create Lambda function Fn: The role defined for the function cannot be assumed by Lambda: ${SECRET_MASK}`
      );
      // The cause stays unmasked: the retry classifiers read it.
      expect((failure as Error & { cause?: unknown }).cause).toBe(error);
    });

    it('masks the post-create warn, cleanup error and thrown message', async () => {
      fakeLambda('plain-fn', {
        PutFunctionConcurrencyCommand: reject(
          awsAuthored('InvalidParameterValueException', `Bad concurrency for ${LONG}`)
        ),
        DeleteFunctionCommand: reject(
          awsAuthored('AccessDeniedException', `Not authorized to delete ${LONG}`)
        ),
      });
      const failure = await thrown(
        provider.create(
          'Fn',
          TYPE,
          createProps({ FunctionName: 'plain-fn', ReservedConcurrentExecutions: 3 }),
          { maskSecrets }
        )
      );
      expect(failure.message).toContain(
        `Failed to set ReservedConcurrentExecutions on Lambda function Fn (function was deleted to maintain atomicity): Bad concurrency for ${SECRET_MASK}`
      );
      expect(warnSpy.mock.calls.map((c) => String(c[0]))).toContainEqual(
        `PutFunctionConcurrency failed for Fn: Bad concurrency for ${SECRET_MASK} — deleting partially-created function to maintain atomicity`
      );
      expect(errorSpy.mock.calls.map((c) => String(c[0]))).toContainEqual(
        `Cleanup DeleteFunction failed for Fn after PutFunctionConcurrency failure — function may be orphaned: Not authorized to delete ${SECRET_MASK}`
      );
      expect(transcript()).not.toContain(LONG);
      expect(failure.message).not.toContain(LONG);
      // The inner cdkd-authored refusal is masked where it is built, not only
      // by create()'s outer wrap: it travels on as the outer error's cause.
      const inner = (failure as Error & { cause?: unknown }).cause as Error;
      expect(inner.message).toContain(`Bad concurrency for ${SECRET_MASK}`);
      expect(inner.message).not.toContain(LONG);
    });

    it('routes the post-create failure lines through the masker (a marking masker)', async () => {
      fakeLambda('plain-fn', {
        PutFunctionRecursionConfigCommand: reject(
          awsAuthored('InvalidParameterValueException', 'Bad recursion config')
        ),
        DeleteFunctionCommand: reject(awsAuthored('AccessDeniedException', 'Not authorized')),
      });
      const marking = (t: string): string => `<m>${t}`;
      await thrown(
        provider.create('Fn', TYPE, createProps({ RecursiveLoop: 'Terminate' }), {
          maskSecrets: marking,
        })
      );
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      for (const line of allLines()) expect(line.startsWith('<m>')).toBe(true);
    });

    it('routes every create line through the masker (a marking masker)', async () => {
      fakeLambda('plain-fn');
      const marking = (t: string): string => `<m>${t}`;
      await provider.create(
        'Fn',
        TYPE,
        createProps({
          RecursiveLoop: 'Terminate',
          ReservedConcurrentExecutions: 3,
          RuntimeManagementConfig: { UpdateRuntimeOn: 'Auto' },
        }),
        { maskSecrets: marking }
      );
      const lines = allLines();
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) expect(line.startsWith('<m>')).toBe(true);
    });

    it('masks a 3-character secret name AWS quotes back in the create failure', async () => {
      // Below the base masker's substring floor (4) but at the sinks' needle
      // floor (3): only the create name pair makes it a needle.
      fakeLambda(TINY3, {
        CreateFunctionCommand: reject(
          awsAuthored('ResourceConflictException', `Function already exist: ${TINY3}`)
        ),
      });
      const failure = await thrown(
        provider.create('Fn', TYPE, createProps({ FunctionName: TINY3 }), { maskSecrets })
      );
      expect(failure.message).toBe(
        `Failed to create Lambda function Fn: Function already exist: ${SECRET_MASK}`
      );
    });
  });

  describe('update()', () => {
    it('masks short secret values on every update line', async () => {
      fakeLambda(TINY_NAME);
      const [desired, previous] = updatePair(TINY_NAME, TINY_NAME, {
        RecursiveLoop: TINY_LOOP,
        CodeSigningConfigArn: TINY_ARN,
        ReservedConcurrentExecutions: TINY_CONC,
      });
      await provider.update('Fn', TINY_NAME, TYPE, desired, previous, { maskSecrets });
      const log = transcript();
      // Non-vacuity: each line fired, with the mask where the value was.
      expect(log).toContain(`Updating Lambda function Fn: ${SECRET_MASK}`);
      expect(log).toContain(`Updated configuration for Lambda function ${SECRET_MASK}`);
      expect(log).toContain(`Updated code for Lambda function ${SECRET_MASK}`);
      expect(log).toContain(
        `Updated RecursiveLoop for Lambda function ${SECRET_MASK} to '${SECRET_MASK}'`
      );
      expect(log).toContain(
        `Updated ReservedConcurrentExecutions for Lambda function ${SECRET_MASK} to ${SECRET_MASK}`
      );
      expect(log).toContain(
        `Updated CodeSigningConfigArn for Lambda function ${SECRET_MASK} to ${SECRET_MASK}`
      );
      expect(log).toContain(`Updated RuntimeManagementConfig for Lambda function ${SECRET_MASK}`);
      // The tag lines name the function, not its ARN: a 2-character name is
      // below every substring floor, so inside the ARN it would print.
      expect(log).toContain(`Removed 1 tag(s) from Lambda function ${SECRET_MASK}`);
      expect(log).toContain(`Added/updated 1 tag(s) on Lambda function ${SECRET_MASK}`);
      for (const tiny of [TINY_NAME, TINY_LOOP, TINY_ARN, TINY_CONC]) {
        expect(log).not.toMatch(new RegExp(`\\b${tiny}\\b`));
      }
      expect(log).not.toContain('function:');
    });

    it('keeps a 2-character secret that occurs in cdkd wording out of the substring needles', async () => {
      // `da` is inside `Updating` / `Updated`: a needle floor below 3 would
      // print `Up***ting Lambda function Fn: ***`.
      fakeLambda(IN_PROSE);
      const [desired, previous] = updatePair(IN_PROSE, IN_PROSE);
      await provider.update('Fn', IN_PROSE, TYPE, desired, previous, { maskSecrets });
      const lines = allLines();
      expect(lines).toContain(`Updating Lambda function Fn: ${SECRET_MASK}`);
      expect(lines).toContain(`Updated configuration for Lambda function ${SECRET_MASK}`);
    });

    it('masks a 3-character secret inside the RuntimeManagementConfig echo (the pre-stringify walk)', async () => {
      // Below the substring floor and free of JSON escapes: only the
      // `maskDeep` walk's whole-value arm reaches it.
      fakeLambda('plain-fn');
      const [desired, previous] = updatePair('plain-fn', 'plain-fn', {
        RuntimeManagementConfig: { UpdateRuntimeOn: 'Manual', RuntimeVersionArn: TINY3 },
      });
      await provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets });
      expect(transcript()).toContain(
        `Updated RuntimeManagementConfig for Lambda function plain-fn to {"UpdateRuntimeOn":"Manual","RuntimeVersionArn":"${SECRET_MASK}"}`
      );
    });

    it('masks the detach and clear lines when the template removes the property', async () => {
      fakeLambda(TINY_NAME);
      const [desired, previous] = updatePair(TINY_NAME, TINY_NAME);
      delete desired['CodeSigningConfigArn'];
      delete desired['ReservedConcurrentExecutions'];
      await provider.update('Fn', TINY_NAME, TYPE, desired, previous, { maskSecrets });
      const log = transcript();
      expect(log).toContain(
        `Detached CodeSigningConfigArn from Lambda function ${SECRET_MASK} (template removed the property)`
      );
      expect(log).toContain(
        `Cleared ReservedConcurrentExecutions for Lambda function ${SECRET_MASK} (template removed the property)`
      );
      expect(log).not.toMatch(/\bqf\b/);
    });

    it('masks a ROTATED recorded name whose old plaintext is in no bag (reference)', async () => {
      // `wv` is in no bag: only the previous `{{resolve:` value marks it.
      fakeLambda('wv');
      const [desired, previous] = updatePair('plain-new', RECORDED_REF);
      await provider.update('Fn', 'wv', TYPE, desired, previous, { maskSecrets });
      const log = transcript();
      expect(log).toContain(`Updating Lambda function Fn: ${SECRET_MASK}`);
      expect(log).not.toMatch(/\bwv\b/);
    });

    it('masks a ROTATED recorded name whose previous value was the redaction mask', async () => {
      fakeLambda('wv');
      const [desired, previous] = updatePair('plain-new', SECRET_MASK);
      await provider.update('Fn', 'wv', TYPE, desired, previous, { maskSecrets });
      const log = transcript();
      expect(log).toContain(`Updating Lambda function Fn: ${SECRET_MASK}`);
      expect(log).not.toMatch(/\bwv\b/);
    });

    it('masks a rotated 3+ character name AWS quotes back in the failure', async () => {
      const oldName = 'old-secret-fn';
      fakeLambda(oldName, {
        UpdateFunctionConfigurationCommand: reject(
          awsAuthored('ResourceConflictException', `Function ${oldName} is not in a valid state`)
        ),
      });
      const [desired, previous] = updatePair('plain-new', RECORDED_REF);
      const failure = await thrown(
        provider.update('Fn', oldName, TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toBe(
        `Failed to update Lambda function Fn: Function ${SECRET_MASK} is not in a valid state`
      );
    });

    it('masks a 3-character recorded name AWS quotes back in the update failure', async () => {
      // No previous FunctionName (an imported record): only the physical-id
      // pair makes the bag-held name a needle.
      fakeLambda(TINY3, {
        UpdateFunctionConfigurationCommand: reject(
          awsAuthored('ResourceConflictException', `Function ${TINY3} is busy`)
        ),
      });
      const [desired, previous] = updatePair(TINY3, undefined);
      delete previous['FunctionName'];
      const failure = await thrown(
        provider.update('Fn', TINY3, TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toBe(`Failed to update Lambda function Fn: Function ${SECRET_MASK} is busy`);
    });

    it('masks a ROTATED 3-character name AWS quotes back in the update failure', async () => {
      fakeLambda('wvx', {
        UpdateFunctionConfigurationCommand: reject(
          awsAuthored('ResourceConflictException', 'Function wvx is busy')
        ),
      });
      const [desired, previous] = updatePair('plain-new', RECORDED_REF);
      const failure = await thrown(
        provider.update('Fn', 'wvx', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toBe(`Failed to update Lambda function Fn: Function ${SECRET_MASK} is busy`);
    });

    it('masks AWS text quoting a secret in the update failure', async () => {
      fakeLambda('plain-fn', {
        UpdateFunctionConfigurationCommand: reject(
          awsAuthored('InvalidParameterValueException', `Role ${LONG} cannot be assumed`)
        ),
      });
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toBe(
        `Failed to update Lambda function Fn: Role ${SECRET_MASK} cannot be assumed`
      );
    });

    it('masks the waiter failure text', async () => {
      fakeLambda('plain-fn');
      waitUpdated.mockRejectedValue(new Error(`LastUpdateStatusReason: role ${LONG} is invalid`));
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toBe(
        `Lambda function Fn update did not complete: LastUpdateStatusReason: role ${SECRET_MASK} is invalid`
      );
    });

    it('routes every update line, the tag warning included, through the masker', async () => {
      fakeLambda('plain-fn');
      // Identity on the physical id so it is not itself secret-derived: every
      // other string gets the marker, so a raw `this.logger` line shows none.
      const marking = (t: string): string => (t === 'plain-fn' ? t : `<m>${t}`);
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      previous['Tags'] = 'not-a-list';
      await provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets: marking });
      const lines = allLines();
      expect(lines.some((l) => l.includes('recorded Tags'))).toBe(true);
      expect(lines.length).toBeGreaterThanOrEqual(8);
      for (const line of lines) expect(line.startsWith('<m>')).toBe(true);
    });
  });

  describe('a masked failure still classifies as retryable (markRedactedCause)', () => {
    const PENDING_TEXT =
      'The operation cannot be performed at this time. The function is currently in the following state: Pending';
    const retryMasker = createSecretMasker(bagOf(RETRY_WORD));
    const retryable = (error: Error): boolean =>
      isRetryableTransientError(error, retryClassificationText(error));

    async function expectRetryableMasked(failure: Error): Promise<void> {
      expect(failure.message).not.toContain(RETRY_WORD);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryable(failure)).toBe(true);
    }

    it('create failure', async () => {
      fakeLambda('plain-fn', {
        CreateFunctionCommand: reject(awsAuthored('ResourceConflictException', PENDING_TEXT)),
      });
      await expectRetryableMasked(
        await thrown(provider.create('Fn', TYPE, createProps(), { maskSecrets: retryMasker }))
      );
    });

    it('post-create refusal', async () => {
      fakeLambda('plain-fn', {
        PutFunctionConcurrencyCommand: reject(
          awsAuthored('ResourceConflictException', PENDING_TEXT)
        ),
      });
      const failure = await thrown(
        provider.create('Fn', TYPE, createProps({ ReservedConcurrentExecutions: 3 }), {
          maskSecrets: retryMasker,
        })
      );
      await expectRetryableMasked(failure);
      // The inner refusal carries its own stamp.
      expect(hasRedactedCause((failure as Error & { cause?: unknown }).cause)).toBe(true);
    });

    it('update failure', async () => {
      fakeLambda('plain-fn', {
        UpdateFunctionConfigurationCommand: reject(
          awsAuthored('ResourceConflictException', PENDING_TEXT)
        ),
      });
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      await expectRetryableMasked(
        await thrown(
          provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets: retryMasker })
        )
      );
    });

    it('update-wait failure', async () => {
      fakeLambda('plain-fn');
      waitUpdated.mockRejectedValue(new Error(PENDING_TEXT));
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      await expectRetryableMasked(
        await thrown(
          provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets: retryMasker })
        )
      );
    });

    it('does not stamp a post-create refusal the mask left unchanged', async () => {
      fakeLambda('plain-fn', {
        PutFunctionConcurrencyCommand: reject(
          awsAuthored('InvalidParameterValueException', 'Bad concurrency')
        ),
      });
      const failure = await thrown(
        provider.create('Fn', TYPE, createProps({ ReservedConcurrentExecutions: 3 }), {
          maskSecrets: retryMasker,
        })
      );
      expect(failure.message).toContain('Bad concurrency');
      expect(hasRedactedCause(failure)).toBe(false);
    });

    it('does not stamp a failure the mask left unchanged', async () => {
      fakeLambda('plain-fn', {
        CreateFunctionCommand: reject(awsAuthored('InvalidParameterValueException', 'Bad role')),
      });
      const failure = await thrown(
        provider.create('Fn', TYPE, createProps(), { maskSecrets: retryMasker })
      );
      expect(hasRedactedCause(failure)).toBe(false);
    });
  });

  describe('a JSON-escaped secret is never relayed (the waiter payload is withheld)', () => {
    /** A rotated secret's OLD plaintext: the live function holds it, no bag does. */
    const ROTATED_OLD = 'rotated-old-plaintext-value';

    /** Route the mocked waiter to the REAL `@smithy/util-waiter` one, capped short. */
    async function realWaiter(
      name: 'waitUntilFunctionUpdatedV2' | 'waitUntilFunctionActiveV2'
    ): Promise<(params: Record<string, unknown>, input: unknown) => Promise<unknown>> {
      const actual = await vi.importActual<typeof import('@aws-sdk/client-lambda')>(
        '@aws-sdk/client-lambda'
      );
      const waiter = actual[name] as unknown as (
        params: Record<string, unknown>,
        input: unknown
      ) => Promise<unknown>;
      return (params, input) => waiter({ ...params, minDelay: 1, maxDelay: 1, maxWaitTime: 2 }, input);
    }

    /**
     * A GetFunction answer that never settles, env secret and presigned URL
     * included. `metadata` is what the SDK sets (`httpStatusCode`, so smithy
     * keys the poll `200: OK`) unless a case passes `{}` to model a response
     * with no status, which smithy keys by the whole serialized body.
     */
    function neverSettles(
      configuration: Record<string, unknown>,
      metadata: Record<string, unknown> = { httpStatusCode: 200, requestId: 'req-0123456789' }
    ): Handler {
      return () => ({
        $metadata: metadata,
        Configuration: {
          FunctionName: 'plain-fn',
          Environment: { Variables: { DB_CREDENTIALS: JSON_SECRET, OLD: ROTATED_OLD } },
          ...configuration,
        },
        Code: { Location: PRESIGNED },
      });
    }

    const assertNothingLeaks = (texts: string[]): void => {
      for (const text of texts) {
        assertAbsent(text);
        expect(text).not.toContain(ROTATED_OLD);
      }
    };

    it('a TIMED-OUT update-wait (the real smithy waiter) keeps the status lines it observed', async () => {
      fakeLambda('plain-fn', { GetFunctionCommand: neverSettles({ LastUpdateStatus: 'InProgress' }) });
      waitUpdated.mockImplementation(await realWaiter('waitUntilFunctionUpdatedV2'));
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      const cause = (failure as Error & { cause?: Error }).cause;
      assertNothingLeaks([printed(failure), transcript(), String(cause?.stack)]);
      expect(failure.message).toMatch(
        /update did not complete: waiter TIMEOUT: Waiter has timed out \(200: OK \(x\d+\)\)\./
      );
      // The name the classifiers key on survives the rewrite.
      expect(cause?.name).toBe('TimeoutError');
    }, 15_000);

    it('a TIMED-OUT wait on an ERROR poll keeps AWS\'s wording, so it still classifies', async () => {
      const denied = 'User: arn:aws:iam::123456789012:user/x is not authorized to perform: lambda:GetFunction';
      fakeLambda('plain-fn', {
        GetFunctionCommand: reject(
          Object.assign(new Error(denied), {
            name: 'AccessDeniedException',
            $fault: 'client',
            $metadata: { httpStatusCode: 403, requestId: 'req-0123456789' },
          })
        ),
      });
      waitUpdated.mockImplementation(await realWaiter('waitUntilFunctionUpdatedV2'));
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toContain(`403: ${denied} (x`);
      expect(retryClassificationText(failure)).toContain('not authorized to perform');
    }, 15_000);

    it('withholds an observed response keyed by its whole body (a response with no status)', async () => {
      fakeLambda('plain-fn', {
        GetFunctionCommand: neverSettles({ LastUpdateStatus: 'InProgress' }, {}),
      });
      waitUpdated.mockImplementation(await realWaiter('waitUntilFunctionUpdatedV2'));
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      const cause = (failure as Error & { cause?: Error }).cause;
      assertNothingLeaks([printed(failure), transcript(), String(cause?.stack)]);
      expect(failure.message).toContain(
        'waiter TIMEOUT: Waiter has timed out (1 observed response(s) withheld).'
      );
    }, 15_000);

    it('withholds an observed deserialization failure, which quotes the body', async () => {
      fakeLambda('plain-fn');
      waitUpdated.mockRejectedValue(
        Object.assign(
          new Error(
            JSON.stringify({
              state: 'TIMEOUT',
              observedResponses: {
                [`200: Deserialization error for body: {"Environment":${JSON.stringify(JSON_SECRET)}}`]: 1,
                // No status: smithy drops the `<status>: ` prefix.
                [`Deserialization error for body: ${PRESIGNED}`]: 1,
                // A body key that is an array: defensive, withheld the same way.
                [`[${JSON.stringify(JSON_SECRET)}]`]: 1,
                '200: OK': 2,
              },
              reason: 'Waiter has timed out',
            })
          ),
          { name: 'TimeoutError' }
        )
      );
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      assertNothingLeaks([printed(failure), transcript()]);
      expect(failure.message).toContain(
        'waiter TIMEOUT: Waiter has timed out (200: OK (x2), 3 observed response(s) withheld).'
      );
    });

    it('keeps the LAST five distinct observed status lines', async () => {
      fakeLambda('plain-fn');
      const observedResponses = Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`500: transient failure ${i}`, 1])
      );
      waitUpdated.mockRejectedValue(
        Object.assign(
          new Error(
            JSON.stringify({ state: 'TIMEOUT', observedResponses, reason: 'Waiter has timed out' })
          ),
          { name: 'TimeoutError' }
        )
      );
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toContain(
        '(3 more observed status line(s) omitted, 500: transient failure 3 (x1), 500: transient failure 4 (x1), 500: transient failure 5 (x1), 500: transient failure 6 (x1), 500: transient failure 7 (x1))'
      );
      expect(failure.message).not.toContain('transient failure 2 ');
    });

    it('a TIMED-OUT post-create Active wait on a status-less poll (the real smithy waiter) leaks nothing', async () => {
      // Status-less, so smithy keys the poll by its whole body: the ONLY
      // timeout shape that carries the payload, and so the one where the
      // absence assertion (not the format one) is what a relay revert breaks.
      fakeLambda('plain-fn', { GetFunctionCommand: neverSettles({ State: 'Pending' }, {}) });
      waitActive.mockImplementation(await realWaiter('waitUntilFunctionActiveV2'));
      const failure = await thrown(
        provider.create(
          'Fn',
          TYPE,
          createProps({ RuntimeManagementConfig: { UpdateRuntimeOn: 'Auto' } }),
          { maskSecrets }
        )
      );
      assertNothingLeaks([printed(failure), transcript()]);
      expect(failure.message).toContain(
        'waiter TIMEOUT: Waiter has timed out (1 observed response(s) withheld)'
      );
    }, 15_000);

    it('a TIMED-OUT 403 whose retry wording a needle cuts still classifies, and prints masked', async () => {
      // `auth` is a recorded secret: it cuts `not authorized to perform` in
      // every masked text, so only the UNMASKED waiter link keeps the wording.
      const authBag = bagOf('auth');
      const authMasker = createSecretMasker(authBag);
      const denied = 'User: arn:aws:iam::123456789012:user/x is not authorized to perform: lambda:GetFunction';
      fakeLambda('plain-fn', {
        GetFunctionCommand: reject(
          Object.assign(new Error(denied), {
            name: 'AccessDeniedException',
            $fault: 'client',
            $metadata: { httpStatusCode: 403, requestId: 'req-0123456789' },
          })
        ),
      });
      waitUpdated.mockImplementation(await realWaiter('waitUntilFunctionUpdatedV2'));
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets: authMasker })
      );
      expect(printed(failure, authBag)).not.toContain('auth');
      expect(failure.message).toContain(`not ${SECRET_MASK}orized to perform`);
      expect(retryClassificationText(failure)).toContain('not authorized to perform');
      expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    }, 15_000);

    it('keeps an early retry-wording status line past later plain ones', async () => {
      fakeLambda('plain-fn');
      const denied = '403: User: x is not authorized to perform: lambda:GetFunction';
      const observedResponses = {
        [denied]: 1,
        ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`200: variant ${i}`, 1])),
      };
      waitUpdated.mockRejectedValue(
        Object.assign(
          new Error(JSON.stringify({ state: 'TIMEOUT', observedResponses, reason: 'Waiter has timed out' })),
          { name: 'TimeoutError' }
        )
      );
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toContain(
        `(2 more observed status line(s) omitted, ${denied} (x1), 200: variant 2 (x1)`
      );
      expect(retryClassificationText(failure)).toContain('not authorized to perform');
    });

    it.each([
      [
        'an IAM-propagation line',
        '400: The role defined for the function cannot be assumed by Lambda',
      ],
      [
        'a transient-only line (no IAM pattern)',
        '409: The operation cannot be performed at this time. The function is currently in the following state: Pending',
      ],
    ])('keeps %s in the retry-wording budget, in first-seen order', async (_label, retryLine) => {
      // The retry-wording line comes AFTER seven plain ones: it must survive
      // the plain budget's cap AND print in first-seen order (after the plain
      // lines kept, not hoisted to the front).
      fakeLambda('plain-fn');
      const observedResponses = {
        ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`200: variant ${i}`, 1])),
        [retryLine]: 1,
      };
      waitUpdated.mockRejectedValue(
        Object.assign(
          new Error(JSON.stringify({ state: 'TIMEOUT', observedResponses, reason: 'Waiter has timed out' })),
          { name: 'TimeoutError' }
        )
      );
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toContain(
        `(2 more observed status line(s) omitted, 200: variant 2 (x1), 200: variant 3 (x1), 200: variant 4 (x1), 200: variant 5 (x1), 200: variant 6 (x1), ${retryLine} (x1))`
      );
    });

    it('names the SDK exception an error-matching acceptor fails on', async () => {
      fakeLambda('plain-fn');
      waitUpdated.mockRejectedValue(
        new Error(
          JSON.stringify({
            state: 'FAILURE',
            reason: { name: 'ResourceNotFoundException', Message: `Function not found: ${LONG}` },
          })
        )
      );
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toContain(
        `waiter FAILURE (error=ResourceNotFoundException: Function not found: ${SECRET_MASK})`
      );
    });

    it('leaves a JSON error message with no waiter `state` alone', async () => {
      fakeLambda('plain-fn', {
        UpdateFunctionConfigurationCommand: reject(new Error('{"foo":1}')),
      });
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toBe('Failed to update Lambda function Fn: {"foo":1}');
      expect((failure as Error & { cause?: Error }).cause?.message).toBe('{"foo":1}');
    });

    it('rewrites the whole stack when its first line does not match the header', async () => {
      fakeLambda('plain-fn');
      const waiterError = waiterFailure('Failed');
      // Read the stack first: V8 formats it lazily, so this pins its header to
      // `Error: ...` before the rename makes the provider's header differ.
      expect(String(waiterError.stack).startsWith('Error: {')).toBe(true);
      waiterError.name = 'RenamedError';
      waitUpdated.mockRejectedValue(waiterError);
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      await thrown(provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets }));
      assertAbsent(String(waiterError.stack));
      expect(String(waiterError.stack).startsWith('RenamedError: waiter FAILURE')).toBe(true);
    });

    it('masks the twice-escaped spelling (JSON inside a JSON string)', async () => {
      fakeLambda('plain-fn', {
        UpdateFunctionConfigurationCommand: reject(
          awsAuthored(
            'InvalidParameterValueException',
            `String measured: ${JSON.stringify(JSON.stringify({ DB_CREDENTIALS: JSON_SECRET }))}`
          )
        ),
      });
      const [desired, previous] = updatePair('plain-fn', 'plain-fn', {
        Environment: { Variables: { DB_CREDENTIALS: JSON_SECRET } },
      });
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toBe(
        `Failed to update Lambda function Fn: String measured: ${JSON.stringify(JSON.stringify({ DB_CREDENTIALS: SECRET_MASK }))}`
      );
    });

    it('masks the JSON-escaped secret a CREATE failure quotes back', async () => {
      fakeLambda('plain-fn', {
        CreateFunctionCommand: reject(
          awsAuthored(
            'InvalidParameterValueException',
            `String measured: ${JSON.stringify({ DB_CREDENTIALS: JSON_SECRET })}`
          )
        ),
      });
      const failure = await thrown(
        provider.create(
          'Fn',
          TYPE,
          createProps({ Environment: { Variables: { DB_CREDENTIALS: JSON_SECRET } } }),
          { maskSecrets }
        )
      );
      expect(failure.message).toBe(
        `Failed to create Lambda function Fn: String measured: {"DB_CREDENTIALS":"${SECRET_MASK}"}`
      );
    });

    it.each([
      ['post-create refusal', 'create'],
      ['update failure', 'update'],
      ['update-wait failure', 'wait'],
    ] as const)('wraps a non-Error throw in the %s so the stamp has a chain', async (_label, arm) => {
      const thrownValue = `raw ${LONG} string`;
      if (arm === 'create') {
        fakeLambda('plain-fn', {
          PutFunctionConcurrencyCommand: () => {
            throw thrownValue;
          },
        });
      } else if (arm === 'update') {
        fakeLambda('plain-fn', {
          UpdateFunctionConfigurationCommand: () => {
            throw thrownValue;
          },
        });
      } else {
        fakeLambda('plain-fn');
        waitUpdated.mockRejectedValue(thrownValue);
      }
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        arm === 'create'
          ? provider.create('Fn', TYPE, createProps({ ReservedConcurrentExecutions: 3 }), {
              maskSecrets,
            })
          : provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      const cause =
        arm === 'create'
          ? ((failure as Error & { cause?: Error }).cause as Error & { cause?: unknown }).cause
          : (failure as Error & { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(failure.message).not.toContain(LONG);
    });

    const assertAbsent = (text: string): void => {
      expect(text).not.toContain(JSON_SECRET);
      expect(text).not.toContain(ESCAPED_JSON_SECRET);
      expect(text).not.toContain('hunter22-json');
      expect(text).not.toContain(PRESIGNED);
    };

    it('a failed update-wait prints the status fields, never the GetFunction payload', async () => {
      fakeLambda('plain-fn');
      const waiterError = waiterFailure('Failed');
      waitUpdated.mockRejectedValue(waiterError);
      const [desired, previous] = updatePair('plain-fn', 'plain-fn', {
        Environment: { Variables: { DB_CREDENTIALS: JSON_SECRET } },
      });
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      // The disclosure assertions FIRST, so relaying the payload fails here.
      assertAbsent(printed(failure));
      assertAbsent(transcript());
      expect(failure.message).toContain(
        'Lambda function Fn update did not complete: waiter FAILURE (LastUpdateStatus=Failed, LastUpdateStatusReasonCode=InternalError, LastUpdateStatusReason=The function could not be updated, 200: OK (x3)).'
      );
      // The caught error stays the direct cause (the classifiers read its
      // fields), withheld in place: its message AND stack carry no payload.
      const cause = (failure as Error & { cause?: Error }).cause;
      expect(cause).toBe(waiterError);
      assertAbsent(String(cause?.stack));
      assertAbsent(retryClassificationText(failure));
    });

    it('masks a secret in the status reason the withheld text keeps', async () => {
      fakeLambda('plain-fn');
      waitUpdated.mockRejectedValue(
        new Error(
          JSON.stringify({
            state: 'FAILURE',
            reason: {
              Configuration: {
                LastUpdateStatus: 'Failed',
                LastUpdateStatusReason: `Role ${LONG} cannot be assumed`,
              },
            },
          })
        )
      );
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(printed(failure)).not.toContain(LONG);
      expect(failure.message).toContain(`LastUpdateStatusReason=Role ${SECRET_MASK} cannot be assumed`);
    });

    it('a failed Active wait in the post-create step withholds the payload too', async () => {
      fakeLambda('plain-fn');
      waitActive.mockRejectedValue(waiterFailure('Active'));
      const failure = await thrown(
        provider.create(
          'Fn',
          TYPE,
          createProps({
            Environment: { Variables: { DB_CREDENTIALS: JSON_SECRET } },
            RuntimeManagementConfig: { UpdateRuntimeOn: 'Auto' },
          }),
          { maskSecrets }
        )
      );
      assertAbsent(printed(failure));
      assertAbsent(printed((failure as Error & { cause: Error }).cause));
      assertAbsent(String((failure as Error & { cause: Error }).cause.stack));
      assertAbsent(transcript());
      expect(failure.message).toContain('State=Failed');
    });

    it('masks the JSON-escaped secret an SDK error quotes back (the 4 KB environment refusal)', async () => {
      fakeLambda('plain-fn', {
        UpdateFunctionConfigurationCommand: reject(
          awsAuthored(
            'InvalidParameterValueException',
            `Lambda was unable to configure your environment variables because the environment variables you have provided exceeded the 4KB limit. String measured: ${JSON.stringify({ DB_CREDENTIALS: JSON_SECRET })}`
          )
        ),
      });
      const [desired, previous] = updatePair('plain-fn', 'plain-fn', {
        Environment: { Variables: { DB_CREDENTIALS: JSON_SECRET } },
      });
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(failure.message).toBe(
        `Failed to update Lambda function Fn: Lambda was unable to configure your environment variables because the environment variables you have provided exceeded the 4KB limit. String measured: {"DB_CREDENTIALS":"${SECRET_MASK}"}`
      );
    });

    it('wraps a non-Error throw so the stamp has a chain to read', async () => {
      fakeLambda('plain-fn', {
        CreateFunctionCommand: () => {
          throw `raw ${LONG} string`;
        },
      });
      const failure = await thrown(provider.create('Fn', TYPE, createProps(), { maskSecrets }));
      const cause = (failure as Error & { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryClassificationText(failure)).toContain(LONG);
      expect(failure.message).not.toContain(LONG);
    });
  });

  describe('secrets only the operation masker knows stay out of the printed cause', () => {
    const waiterFailed = (reason: unknown): Error =>
      new Error(JSON.stringify({ state: 'FAILURE', reason }));

    it('a 3-character name in an error acceptor\'s Message', async () => {
      fakeLambda(TINY3);
      waitUpdated.mockRejectedValue(
        waiterFailed({ name: 'ResourceNotFoundException', Message: `Function not found: ${TINY3}` })
      );
      const [desired, previous] = updatePair(TINY3, TINY3);
      const failure = await thrown(
        provider.update('Fn', TINY3, TYPE, desired, previous, { maskSecrets })
      );
      expect(printed(failure)).not.toMatch(/\bkpz\b/);
      expect(failure.message).toContain(`Function not found: ${SECRET_MASK}`);
    });

    it('a rotated recorded name in a status reason', async () => {
      fakeLambda('old-secret-fn');
      waitUpdated.mockRejectedValue(
        waiterFailed({
          Configuration: { LastUpdateStatus: 'Failed', LastUpdateStatusReason: 'Function old-secret-fn failed' },
        })
      );
      const [desired, previous] = updatePair('plain-new', RECORDED_REF);
      const failure = await thrown(
        provider.update('Fn', 'old-secret-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(printed(failure)).not.toContain('old-secret-fn');
    });

    it('a JSON-escaped secret in a status reason', async () => {
      fakeLambda('plain-fn');
      waitUpdated.mockRejectedValue(
        waiterFailed({
          Configuration: {
            LastUpdateStatus: 'Failed',
            LastUpdateStatusReason: `bad env ${JSON.stringify({ DB: JSON_SECRET })}`,
          },
        })
      );
      const [desired, previous] = updatePair('plain-fn', 'plain-fn', {
        Environment: { Variables: { DB: JSON_SECRET } },
      });
      const failure = await thrown(
        provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets })
      );
      expect(printed(failure)).not.toContain('hunter22-json');
    });
  });

  describe('controls', () => {
    it('renders ordinary values unchanged when a masker IS supplied', async () => {
      fakeLambda('plain-fn');
      const [desired, previous] = updatePair('plain-fn', 'plain-fn');
      await provider.update('Fn', 'plain-fn', TYPE, desired, previous, { maskSecrets });
      const log = transcript();
      expect(log).toContain('Updating Lambda function Fn: plain-fn');
      expect(log).toContain("Updated RecursiveLoop for Lambda function plain-fn to 'Terminate'");
      expect(log).toContain('Added/updated 1 tag(s) on Lambda function plain-fn');
      expect(log).not.toContain(SECRET_MASK);
    });

    it('leaves everything unmasked when no context is supplied', async () => {
      fakeLambda(TINY_NAME);
      await provider.create('Fn', TYPE, createProps({ FunctionName: TINY_NAME }));
      const [desired, previous] = updatePair(TINY_NAME, TINY_NAME);
      await provider.update('Fn', TINY_NAME, TYPE, desired, previous);
      const log = transcript();
      expect(log).toContain(`Successfully created Lambda function Fn: ${TINY_NAME}`);
      expect(log).toContain(`Updating Lambda function Fn: ${TINY_NAME}`);
      expect(log).not.toContain(SECRET_MASK);
    });
  });
});
