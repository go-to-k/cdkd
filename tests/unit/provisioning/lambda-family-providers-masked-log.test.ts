/**
 * Issue #2177 — the Lambda family's masked log sinks: the Url, LayerVersion,
 * Permission, EventInvokeConfig and EventSourceMapping providers.
 *
 * Each `create()` / `update()` builds ONE masked sink set per operation from
 * the context's masker (extended by derived-name needles) and routes every log
 * line, and the AWS error text a failure message wraps, through it. A failure
 * whose text the mask changed is stamped `markRedactedCause` with the raw AWS
 * error kept as `cause`.
 *
 * The secrets are sized for the arm each case must isolate:
 *
 *  - `LONG`, which the message-level substring arm catches: it fences the
 *    AWS-echo sites, where only routing through the masker removes it;
 *  - `TINY`, two characters, below the masker's substring floor
 *    (`MIN_NEEDLE_LENGTH`) and in no fixed wording, so inside a longer line
 *    only a derived-name needle removes it;
 *  - `ROTATED`, a name present only in the recorded physical id, whose
 *    previous template value state kept as its `{{resolve:` reference: no bag
 *    of this deploy holds it, so only the previous-side pair removes it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { LambdaUrlProvider } from '../../../src/provisioning/providers/lambda-url-provider.js';
import { LambdaLayerVersionProvider } from '../../../src/provisioning/providers/lambda-layer-provider.js';
import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';
import { LambdaEventInvokeConfigProvider } from '../../../src/provisioning/providers/lambda-event-invoke-config-provider.js';
import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import { hasRedactedCause, isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

/** Long enough for the masker's substring arm. */
const LONG = 'lambda-secret-function-name';
/** Two characters, in no fixed wording: only a derived-name needle removes it. */
const TINY = 'qx';
/** A recorded name whose plaintext no bag of this deploy holds. */
const ROTATED = 'rotated-old-secret-name';
const ROTATED_REF = '{{resolve:secretsmanager:old-secret}}';
/** A template value that is not a secret. */
const PUBLIC = 'public-function';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const maskSecrets = createSecretMasker(bagOf(LONG, TINY));

const fnArn = (name: string, account = '123456789012'): string =>
  `arn:aws:lambda:us-east-1:${account}:function:${name}`;

/** An AWS-authored failure (the marker fields `describeAwsFailure` keys on). */
const awsAuthored = (name: string, message: string): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 400, requestId: 'req-0123456789' },
  });

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Every debug and warn line the provider wrote, joined. */
const transcript = (): string =>
  [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((args) => String(args[0])).join('\n');

type Handler = (input: Record<string, unknown>) => unknown;

/** A fake Lambda answering by command name; an absent handler answers `{}`. */
function fakeLambda(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(async (command: { input: Record<string, unknown> }) => {
    const handler = handlers[commandName(command)];
    return handler ? handler(command.input) : {};
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, got ${String(error)}`);
  }
  throw new Error('expected the operation to throw');
}

/** The stamp and the raw cause a masked failure must carry. */
function expectMaskedFailure(error: Error, raw: Error, secret: string): void {
  expect(error.message).not.toContain(secret);
  expect(error.message).toContain('***');
  expect(hasRedactedCause(error)).toBe(true);
  expect((error as { cause?: unknown }).cause).toBe(raw);
}

/** A pass-through masker that records every text it is handed. */
function spyMasker(): { mask: (text: string) => string; seen: () => string[] } {
  const calls: string[] = [];
  return {
    mask: (text: string) => {
      calls.push(text);
      return text;
    },
    seen: () => calls,
  };
}

/** Did the provider route a line starting with `prefix` through the masker? */
const routed = (seen: string[], prefix: string): boolean => seen.some((t) => t.startsWith(prefix));

beforeEach(() => {
  mockSend.mockReset();
  debugSpy.mockReset();
  warnSpy.mockReset();
});

describe('LambdaUrlProvider masked log sinks (issue #2177)', () => {
  const type = 'AWS::Lambda::Url';

  it('masks a short secret function name AWS quotes back on a create failure', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${fnArn(TINY)}`);
    fakeLambda({
      CreateFunctionUrlConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaUrlProvider().create('Url', type, { TargetFunctionArn: TINY }, { maskSecrets })
    );
    expect(error.message).not.toContain(`function:${TINY}`);
    expect(hasRedactedCause(error)).toBe(true);
    expect((error as { cause?: unknown }).cause).toBe(raw);
  });

  it('masks a rotated recorded function name on the update path, lines and failure alike', async () => {
    const physicalId = fnArn(ROTATED);
    const raw = awsAuthored('ResourceConflictException', `Conflict on ${physicalId}`);
    fakeLambda({
      UpdateFunctionUrlConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaUrlProvider().update(
        'Url',
        physicalId,
        type,
        // A desired value that is NOT a secret: only the previous side's
        // reference marks the recorded ARN.
        { TargetFunctionArn: fnArn(PUBLIC), AuthType: 'AWS_IAM' },
        { TargetFunctionArn: ROTATED_REF, AuthType: 'NONE' },
        { maskSecrets }
      )
    );
    expect(transcript()).toContain('Updating Lambda URL Url');
    expect(transcript()).not.toContain(ROTATED);
    expectMaskedFailure(error, raw, ROTATED);
  });

  it('masks a short secret desired function name AWS quotes back on an update failure', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${fnArn(TINY)}`);
    fakeLambda({
      UpdateFunctionUrlConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaUrlProvider().update(
        'Url',
        fnArn(PUBLIC),
        type,
        { TargetFunctionArn: TINY, AuthType: 'AWS_IAM' },
        { TargetFunctionArn: fnArn(PUBLIC), AuthType: 'NONE' },
        { maskSecrets }
      )
    );
    expect(error.message).not.toContain(`function:${TINY}`);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('masks a rotated recorded function AWS quotes back by bare name', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${ROTATED}`);
    fakeLambda({
      UpdateFunctionUrlConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaUrlProvider().update(
        'Url',
        fnArn(ROTATED),
        type,
        { TargetFunctionArn: fnArn(PUBLIC), AuthType: 'AWS_IAM' },
        { TargetFunctionArn: ROTATED_REF, AuthType: 'NONE' },
        { maskSecrets }
      )
    );
    expectMaskedFailure(error, raw, ROTATED);
  });

  it('routes the create path lines and warnings through the masker', async () => {
    const spy = spyMasker();
    fakeLambda({
      CreateFunctionUrlConfigCommand: () => ({ FunctionUrl: 'https://x', FunctionArn: 'arn:f' }),
    });
    await new LambdaUrlProvider().create(
      'Url',
      type,
      { TargetFunctionArn: fnArn(PUBLIC) },
      { maskSecrets: spy.mask, replayingState: true }
    );
    expect(routed(spy.seen(), 'Creating Lambda URL Url')).toBe(true);
    expect(routed(spy.seen(), 'Lambda URL Url is being restored')).toBe(true);
    expect(routed(spy.seen(), 'Successfully created Lambda URL Url')).toBe(true);
  });

  it('leaves an unthreaded call unmasked and unstamped (absent means identity)', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${fnArn(LONG)}`);
    fakeLambda({
      CreateFunctionUrlConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaUrlProvider().create('Url', type, { TargetFunctionArn: fnArn(LONG) })
    );
    expect(error.message).toContain(LONG);
    expect(hasRedactedCause(error)).toBe(false);
  });
});

describe('LambdaLayerVersionProvider masked log sinks (issue #2177)', () => {
  const type = 'AWS::Lambda::LayerVersion';
  const content = { S3Bucket: 'bucket', S3Key: 'key.zip' };

  it('masks a short secret LayerName inside the published version ARN', async () => {
    fakeLambda({
      PublishLayerVersionCommand: (input) => ({
        LayerVersionArn: `arn:aws:lambda:us-east-1:123456789012:layer:${String(input['LayerName'])}:1`,
      }),
    });
    await new LambdaLayerVersionProvider().create(
      'Layer',
      type,
      { LayerName: TINY, Content: content },
      { maskSecrets }
    );
    expect(transcript()).toContain('Successfully created Lambda layer version Layer');
    expect(transcript()).not.toContain(`layer:${TINY}:`);
  });

  it('routes the create path lines through the masker', async () => {
    const spy = spyMasker();
    fakeLambda({ PublishLayerVersionCommand: () => ({ LayerVersionArn: 'arn:layer:1' }) });
    await new LambdaLayerVersionProvider().create(
      'Layer',
      type,
      { LayerName: PUBLIC, Content: content },
      { maskSecrets: spy.mask }
    );
    expect(routed(spy.seen(), 'Creating Lambda layer version Layer')).toBe(true);
    expect(routed(spy.seen(), 'Successfully created Lambda layer version Layer')).toBe(true);
  });

  it('masks a secret AWS quotes back on a create failure', async () => {
    const raw = awsAuthored('InvalidParameterValueException', `Bad layer name ${LONG}`);
    fakeLambda({
      PublishLayerVersionCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaLayerVersionProvider().create(
        'Layer',
        type,
        { LayerName: LONG, Content: content },
        { maskSecrets }
      )
    );
    expectMaskedFailure(error, raw, LONG);
  });
});

describe('LambdaPermissionProvider masked log sinks (issue #2177)', () => {
  const type = 'AWS::Lambda::Permission';
  const props = (functionName: string): Record<string, unknown> => ({
    FunctionName: functionName,
    Action: 'lambda:InvokeFunction',
    Principal: 's3.amazonaws.com',
  });

  it('masks a short secret FunctionName AWS quotes back on a create failure', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${fnArn(TINY)}`);
    fakeLambda({
      AddPermissionCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaPermissionProvider().create('Perm', type, props(TINY), { maskSecrets })
    );
    expect(error.message).not.toContain(`function:${TINY}`);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('masks a rotated recorded function on update and forwards the masker to the re-add', async () => {
    const physicalId = `${fnArn(ROTATED)}|PermStatement`;
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${fnArn(LONG)}`);
    fakeLambda({
      AddPermissionCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaPermissionProvider().update(
        'Perm',
        physicalId,
        type,
        props(LONG),
        props(ROTATED_REF),
        { maskSecrets }
      )
    );
    expect(transcript()).toContain('Updating Lambda permission Perm');
    expect(transcript()).not.toContain(ROTATED);
    // The re-adding create() masks with the forwarded masker.
    expectMaskedFailure(error, raw, LONG);
  });

  it('masks a short secret desired FunctionName the remove falls back to when none was recorded', async () => {
    const raw = awsAuthored('AccessDeniedException', `Not authorized on ${fnArn(TINY)}`);
    fakeLambda({
      RemovePermissionCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaPermissionProvider().update('Perm', 'PermStatement', type, props(TINY), {}, {
        maskSecrets,
      })
    );
    expect(error.message).not.toContain(`function:${TINY}`);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('masks a rotated recorded function AWS quotes back by bare name', async () => {
    const raw = awsAuthored('AccessDeniedException', `Not authorized on function ${ROTATED}`);
    fakeLambda({
      RemovePermissionCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaPermissionProvider().update(
        'Perm',
        `${fnArn(ROTATED)}|PermStatement`,
        type,
        props(PUBLIC),
        props(ROTATED_REF),
        { maskSecrets }
      )
    );
    expectMaskedFailure(error, raw, ROTATED);
  });

  it('routes the create and update path lines through the masker', async () => {
    const spy = spyMasker();
    fakeLambda({
      RemovePermissionCommand: () => {
        // The SDK's exception check matches by name.
        throw awsAuthored('ResourceNotFoundException', 'gone');
      },
    });
    await new LambdaPermissionProvider().update(
      'Perm',
      'PermStatement',
      type,
      props(PUBLIC),
      props(PUBLIC),
      { maskSecrets: spy.mask }
    );
    expect(routed(spy.seen(), 'Updating Lambda permission Perm')).toBe(true);
    expect(routed(spy.seen(), 'Old permission PermStatement not found')).toBe(true);
    expect(routed(spy.seen(), 'Creating Lambda permission Perm')).toBe(true);
    expect(routed(spy.seen(), 'Successfully created Lambda permission Perm')).toBe(true);
  });

  it('masks a rotated recorded function AWS quotes back when the remove fails', async () => {
    const physicalId = `${fnArn(ROTATED)}|PermStatement`;
    const raw = awsAuthored('AccessDeniedException', `Not authorized on ${fnArn(ROTATED)}`);
    fakeLambda({
      RemovePermissionCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaPermissionProvider().update(
        'Perm',
        physicalId,
        type,
        // Not a secret: only the previous side's reference marks the record.
        props(PUBLIC),
        props(ROTATED_REF),
        { maskSecrets }
      )
    );
    expectMaskedFailure(error, raw, ROTATED);
  });
});

describe('LambdaEventInvokeConfigProvider masked log sinks (issue #2177)', () => {
  const type = 'AWS::Lambda::EventInvokeConfig';

  it('masks a short secret FunctionName inside the physical id on the create success line', async () => {
    fakeLambda({});
    await new LambdaEventInvokeConfigProvider().create(
      'Eic',
      type,
      { FunctionName: TINY, Qualifier: '$LATEST', MaximumRetryAttempts: 1 },
      { maskSecrets }
    );
    expect(transcript()).toContain('Successfully created Lambda EventInvokeConfig Eic');
    expect(transcript()).not.toContain(`${TINY}|`);
  });

  it('masks a secret AWS quotes back on a create failure', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${fnArn(LONG)}`);
    fakeLambda({
      PutFunctionEventInvokeConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaEventInvokeConfigProvider().create(
        'Eic',
        type,
        { FunctionName: LONG, Qualifier: '$LATEST' },
        { maskSecrets }
      )
    );
    expectMaskedFailure(error, raw, LONG);
  });

  it('masks the function ARNs the re-spelling refusal quotes, and keeps it non-retryable', async () => {
    fakeLambda({
      GetFunctionCommand: (input) => ({
        Configuration: {
          FunctionArn:
            input['FunctionName'] === TINY ? fnArn(TINY, '222222222222') : fnArn(TINY),
        },
      }),
    });
    const error = await thrown(
      new LambdaEventInvokeConfigProvider().update(
        'Eic',
        `${fnArn(TINY)}|$LATEST`,
        type,
        { FunctionName: TINY, Qualifier: '$LATEST', MaximumRetryAttempts: 2 },
        { FunctionName: fnArn(TINY), Qualifier: '$LATEST', MaximumRetryAttempts: 1 },
        { maskSecrets }
      )
    );
    expect(error.message).toContain('Refusing to update Lambda EventInvokeConfig Eic in place');
    expect(error.message).not.toContain(`function:${TINY}`);
    expect(isMarkedNonRetryable(error)).toBe(true);
    // cdkd's own refusal: masked, never stamped retryable.
    expect(hasRedactedCause(error)).toBe(false);
    expect(transcript()).not.toContain(`function:${TINY}`);
  });

  it('masks a secret AWS quotes back when the re-spelling probe fails', async () => {
    const raw = awsAuthored('AccessDeniedException', `Not authorized on ${fnArn(TINY)}`);
    fakeLambda({
      GetFunctionCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaEventInvokeConfigProvider().update(
        'Eic',
        `${fnArn(TINY)}|$LATEST`,
        type,
        { FunctionName: TINY, Qualifier: '$LATEST', MaximumRetryAttempts: 2 },
        { FunctionName: fnArn(TINY), Qualifier: '$LATEST', MaximumRetryAttempts: 1 },
        { maskSecrets }
      )
    );
    expect(error.message).toContain('could not resolve its FunctionName');
    expect(error.message).not.toContain(`function:${TINY}`);
    expect(hasRedactedCause(error)).toBe(true);
    expect((error as { cause?: unknown }).cause).toBe(raw);
  });

  it('masks a rotated recorded qualifier on the update line', async () => {
    fakeLambda({});
    await new LambdaEventInvokeConfigProvider().update(
      'Eic',
      `${PUBLIC}|${ROTATED}`,
      type,
      { FunctionName: PUBLIC, Qualifier: 'live', MaximumRetryAttempts: 2 },
      { FunctionName: PUBLIC, Qualifier: ROTATED_REF, MaximumRetryAttempts: 1 },
      { maskSecrets }
    );
    expect(transcript()).toContain('Updating Lambda EventInvokeConfig Eic');
    expect(transcript()).not.toContain(ROTATED);
  });

  it('masks a short secret desired FunctionName AWS quotes back on an update failure', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${fnArn(TINY)}`);
    fakeLambda({
      PutFunctionEventInvokeConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaEventInvokeConfigProvider().update(
        'Eic',
        `${TINY}|$LATEST`,
        type,
        { FunctionName: TINY, Qualifier: '$LATEST', MaximumRetryAttempts: 2 },
        { FunctionName: TINY, Qualifier: '$LATEST', MaximumRetryAttempts: 1 },
        { maskSecrets }
      )
    );
    expect(error.message).not.toContain(`function:${TINY}`);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('masks a short secret desired Qualifier inside the physical id on the create success line', async () => {
    fakeLambda({});
    await new LambdaEventInvokeConfigProvider().create(
      'Eic',
      type,
      { FunctionName: PUBLIC, Qualifier: TINY, MaximumRetryAttempts: 1 },
      { maskSecrets }
    );
    expect(transcript()).toContain('Successfully created Lambda EventInvokeConfig Eic');
    expect(transcript()).not.toContain(`|${TINY}`);
  });

  it('masks a short secret desired Qualifier AWS quotes back on an update failure', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `No such qualifier :${TINY}`);
    fakeLambda({
      PutFunctionEventInvokeConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaEventInvokeConfigProvider().update(
        'Eic',
        `${PUBLIC}|${TINY}`,
        type,
        { FunctionName: PUBLIC, Qualifier: TINY, MaximumRetryAttempts: 2 },
        { FunctionName: PUBLIC, Qualifier: TINY, MaximumRetryAttempts: 1 },
        { maskSecrets }
      )
    );
    expect(error.message).not.toContain(`:${TINY}`);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('masks a rotated recorded function AWS quotes back by bare name', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${ROTATED}`);
    fakeLambda({
      PutFunctionEventInvokeConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaEventInvokeConfigProvider().update(
        'Eic',
        `${fnArn(ROTATED)}|$LATEST`,
        type,
        { FunctionName: fnArn(ROTATED), Qualifier: '$LATEST', MaximumRetryAttempts: 2 },
        { FunctionName: ROTATED_REF, Qualifier: '$LATEST', MaximumRetryAttempts: 1 },
        { maskSecrets }
      )
    );
    expectMaskedFailure(error, raw, ROTATED);
  });

  it('routes the create path lines and warnings through the masker', async () => {
    const spy = spyMasker();
    fakeLambda({});
    await new LambdaEventInvokeConfigProvider().create(
      'Eic',
      type,
      { FunctionName: PUBLIC, Qualifier: {} },
      { maskSecrets: spy.mask, replayingState: true }
    );
    expect(routed(spy.seen(), 'Creating Lambda EventInvokeConfig Eic')).toBe(true);
    // Two warnings: create()'s own read (replayWarn) and the Put input's (onUnusable).
    expect(
      spy.seen().filter((t) => t.includes('AWS::Lambda::EventInvokeConfig Qualifier'))
    ).toHaveLength(2);
    expect(routed(spy.seen(), 'Successfully created Lambda EventInvokeConfig Eic')).toBe(true);
  });

  it('refuses a separator in the new FunctionName as cdkd, not as an AWS failure, masked', async () => {
    fakeLambda({});
    const error = await thrown(
      new LambdaEventInvokeConfigProvider().update(
        'Eic',
        `${PUBLIC}|$LATEST`,
        type,
        { FunctionName: `${LONG}|x`, Qualifier: '$LATEST', MaximumRetryAttempts: 2 },
        { FunctionName: PUBLIC, Qualifier: '$LATEST', MaximumRetryAttempts: 1 },
        { maskSecrets }
      )
    );
    expect(error.message).not.toContain('Failed to update Lambda EventInvokeConfig');
    expect(error.message).not.toContain(LONG);
    expect(hasRedactedCause(error)).toBe(false);
  });

  it('masks a rotated recorded function on the update line and failure', async () => {
    const physicalId = `${ROTATED}|$LATEST`;
    const raw = awsAuthored('ResourceConflictException', `Conflict on ${ROTATED}`);
    fakeLambda({
      PutFunctionEventInvokeConfigCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaEventInvokeConfigProvider().update(
        'Eic',
        physicalId,
        type,
        { FunctionName: ROTATED, Qualifier: '$LATEST', MaximumRetryAttempts: 2 },
        { FunctionName: ROTATED_REF, Qualifier: '$LATEST', MaximumRetryAttempts: 1 },
        { maskSecrets }
      )
    );
    expect(transcript()).toContain('Updating Lambda EventInvokeConfig Eic');
    expect(transcript()).not.toContain(ROTATED);
    expectMaskedFailure(error, raw, ROTATED);
  });
});

describe('LambdaEventSourceMappingProvider masked log sinks (issue #2177)', () => {
  const type = 'AWS::Lambda::EventSourceMapping';
  const queueArn = 'arn:aws:sqs:us-east-1:123456789012:queue';

  it('masks a short secret FunctionName AWS quotes back on a create failure', async () => {
    const raw = awsAuthored('ResourceNotFoundException', `Function not found: ${fnArn(TINY)}`);
    fakeLambda({
      CreateEventSourceMappingCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaEventSourceMappingProvider().create(
        'Esm',
        type,
        { FunctionName: TINY, EventSourceArn: queueArn },
        { maskSecrets }
      )
    );
    expect(error.message).not.toContain(`function:${TINY}`);
    expect(hasRedactedCause(error)).toBe(true);
    expect((error as { cause?: unknown }).cause).toBe(raw);
  });

  it('masks a short secret FunctionName AWS quotes back on an update failure', async () => {
    const raw = awsAuthored('ResourceConflictException', `Conflict on ${fnArn(TINY)}`);
    fakeLambda({
      UpdateEventSourceMappingCommand: () => {
        throw raw;
      },
    });
    const error = await thrown(
      new LambdaEventSourceMappingProvider().update(
        'Esm',
        '11111111-2222-3333-4444-555555555555',
        type,
        { FunctionName: TINY, EventSourceArn: queueArn, BatchSize: 5 },
        { FunctionName: TINY, EventSourceArn: queueArn, BatchSize: 10 },
        { maskSecrets }
      )
    );
    expect(error.message).not.toContain(`function:${TINY}`);
    expect(hasRedactedCause(error)).toBe(true);
    expect((error as { cause?: unknown }).cause).toBe(raw);
  });

  it('routes the create path lines and the replay warning through the masker', async () => {
    const spy = spyMasker();
    fakeLambda({ CreateEventSourceMappingCommand: () => ({ UUID: 'uuid-1' }) });
    await new LambdaEventSourceMappingProvider().create(
      'Esm',
      type,
      {
        FunctionName: 'fn',
        EventSourceArn: queueArn,
        SelfManagedKafkaEventSourceConfig: { ConsumptionMode: 'Queue' },
      },
      { maskSecrets: spy.mask, replayingState: true }
    );
    expect(routed(spy.seen(), 'Creating event source mapping Esm')).toBe(true);
    expect(spy.seen().some((t) => t.includes('Proceeding without it'))).toBe(true);
    expect(routed(spy.seen(), 'Successfully created event source mapping Esm')).toBe(true);
  });

  it('routes the update path lines through the masker', async () => {
    const sink = vi.fn((text: string) => text);
    fakeLambda({
      UpdateEventSourceMappingCommand: () => ({ EventSourceMappingArn: 'arn:esm' }),
    });
    await new LambdaEventSourceMappingProvider().update(
      'Esm',
      '11111111-2222-3333-4444-555555555555',
      type,
      { FunctionName: 'fn', EventSourceArn: queueArn, BatchSize: 5 },
      { FunctionName: 'fn', EventSourceArn: queueArn, BatchSize: 10 },
      { maskSecrets: sink }
    );
    const masked = sink.mock.calls.map((args) => args[0]);
    expect(masked.some((text) => text.startsWith('Updating event source mapping Esm'))).toBe(true);
    expect(masked.some((text) => text.startsWith('Successfully updated event source mapping'))).toBe(
      true
    );
  });
});
