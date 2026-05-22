import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Mock every AWS SDK client we touch in the dispatcher. The hoisted
// `send` mocks let each test queue per-subtype canned responses.
const sqsSend = vi.fn();
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sqsSend, destroy: vi.fn() })),
  SendMessageCommand: vi.fn().mockImplementation((input) => ({ _name: 'SendMessage', input })),
  ReceiveMessageCommand: vi.fn().mockImplementation((input) => ({ _name: 'ReceiveMessage', input })),
  DeleteMessageCommand: vi.fn().mockImplementation((input) => ({ _name: 'DeleteMessage', input })),
  PurgeQueueCommand: vi.fn().mockImplementation((input) => ({ _name: 'PurgeQueue', input })),
}));

const snsSend = vi.fn();
vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: vi.fn().mockImplementation(() => ({ send: snsSend, destroy: vi.fn() })),
}));

const ebSend = vi.fn();
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend, destroy: vi.fn() })),
  PutEventsCommand: vi.fn().mockImplementation((input) => ({ _name: 'PutEvents', input })),
}));

const kinesisSend = vi.fn();
vi.mock('@aws-sdk/client-kinesis', () => ({
  KinesisClient: vi.fn().mockImplementation(() => ({ send: kinesisSend, destroy: vi.fn() })),
  PutRecordCommand: vi.fn().mockImplementation((input) => ({ _name: 'PutRecord', input })),
}));

const sfnSend = vi.fn();
vi.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: vi.fn().mockImplementation(() => ({ send: sfnSend, destroy: vi.fn() })),
  StartExecutionCommand: vi.fn().mockImplementation((input) => ({ _name: 'StartExecution', input })),
  StartSyncExecutionCommand: vi
    .fn()
    .mockImplementation((input) => ({ _name: 'StartSyncExecution', input })),
  StopExecutionCommand: vi.fn().mockImplementation((input) => ({ _name: 'StopExecution', input })),
}));

const ssmSend = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend, destroy: vi.fn() })),
}));

import {
  _resetClientCacheForTest,
  applyResponseParameters,
  dispatchServiceIntegration,
  isSupportedSubtype,
  SUPPORTED_SUBTYPES,
} from '../../../src/local/httpv2-service-integration.js';

beforeEach(() => {
  sqsSend.mockReset();
  snsSend.mockReset();
  ebSend.mockReset();
  kinesisSend.mockReset();
  sfnSend.mockReset();
  ssmSend.mockReset();
  _resetClientCacheForTest();
});

describe('isSupportedSubtype', () => {
  it('matches every AWS-documented subtype', () => {
    for (const subtype of SUPPORTED_SUBTYPES) {
      expect(isSupportedSubtype(subtype)).toBe(true);
    }
  });

  it('rejects unrecognized subtype values', () => {
    expect(isSupportedSubtype('DynamoDB-PutItem')).toBe(false);
    expect(isSupportedSubtype('SQS-NotARealAction')).toBe(false);
    expect(isSupportedSubtype('')).toBe(false);
    expect(isSupportedSubtype(undefined)).toBe(false);
    expect(isSupportedSubtype({ Ref: 'X' })).toBe(false);
  });

  it('covers exactly the 10 AWS-published subtypes', () => {
    expect(SUPPORTED_SUBTYPES.length).toBe(10);
  });
});

describe('dispatchServiceIntegration — region resolution', () => {
  it('rejects when no region is available (default + per-request both empty)', async () => {
    const result = await dispatchServiceIntegration('SQS-SendMessage', { QueueUrl: 'q', MessageBody: 'b' }, '');
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).message).toContain('region');
  });

  it('per-request Region overrides defaultRegion', async () => {
    sqsSend.mockResolvedValueOnce({ MessageId: 'm1', $metadata: { httpStatusCode: 200 } });
    const result = await dispatchServiceIntegration(
      'SQS-SendMessage',
      { QueueUrl: 'https://sqs/q', MessageBody: 'hi', Region: 'eu-west-1' },
      'us-east-1'
    );
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ MessageId: 'm1' });
  });
});

describe('dispatchServiceIntegration — SQS-SendMessage', () => {
  it('builds SendMessageCommand input from required parameters', async () => {
    sqsSend.mockResolvedValueOnce({ MessageId: 'msg-1', $metadata: {} });
    await dispatchServiceIntegration(
      'SQS-SendMessage',
      { QueueUrl: 'https://sqs.example/q', MessageBody: 'hello', DelaySeconds: '5' },
      'us-east-1'
    );
    expect(sqsSend).toHaveBeenCalledTimes(1);
    const command = (sqsSend.mock.calls[0]?.[0] ?? {}) as { _name: string; input: Record<string, unknown> };
    expect(command._name).toBe('SendMessage');
    expect(command.input).toMatchObject({
      QueueUrl: 'https://sqs.example/q',
      MessageBody: 'hello',
      DelaySeconds: 5,
    });
  });

  it('rejects when QueueUrl is missing', async () => {
    const result = await dispatchServiceIntegration('SQS-SendMessage', { MessageBody: 'hi' }, 'us-east-1');
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).message).toContain('QueueUrl');
  });

  it('translates SDK errors to HTTP responses', async () => {
    const sdkErr: Error & { name?: string; $metadata?: { httpStatusCode: number } } = new Error(
      'queue does not exist'
    );
    sdkErr.name = 'QueueDoesNotExist';
    sdkErr.$metadata = { httpStatusCode: 400 };
    sqsSend.mockRejectedValueOnce(sdkErr);
    const result = await dispatchServiceIntegration(
      'SQS-SendMessage',
      { QueueUrl: 'q', MessageBody: 'x' },
      'us-east-1'
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ message: 'queue does not exist', code: 'QueueDoesNotExist' });
  });
});

describe('dispatchServiceIntegration — EventBridge-PutEvents', () => {
  it('packages required fields into Entries[0]', async () => {
    ebSend.mockResolvedValueOnce({ Entries: [{ EventId: 'evt-1' }], FailedEntryCount: 0, $metadata: {} });
    await dispatchServiceIntegration(
      'EventBridge-PutEvents',
      { Detail: '{"k":"v"}', DetailType: 'order.created', Source: 'app.shop', EventBusName: 'default' },
      'us-east-1'
    );
    const command = (ebSend.mock.calls[0]?.[0] ?? {}) as { input: { Entries: Array<Record<string, unknown>> } };
    expect(command.input.Entries[0]).toMatchObject({
      Detail: '{"k":"v"}',
      DetailType: 'order.created',
      Source: 'app.shop',
      EventBusName: 'default',
    });
  });

  it('splits Resources CSV string into an array', async () => {
    ebSend.mockResolvedValueOnce({ Entries: [], $metadata: {} });
    await dispatchServiceIntegration(
      'EventBridge-PutEvents',
      { Detail: '{}', DetailType: 't', Source: 's', Resources: 'arn:1, arn:2' },
      'us-east-1'
    );
    const command = (ebSend.mock.calls[0]?.[0] ?? {}) as { input: { Entries: Array<Record<string, unknown>> } };
    expect(command.input.Entries[0]?.['Resources']).toEqual(['arn:1', 'arn:2']);
  });
});

describe('dispatchServiceIntegration — StepFunctions', () => {
  it('StartExecution maps PascalCase RequestParameters to camelCase SDK input', async () => {
    sfnSend.mockResolvedValueOnce({ executionArn: 'arn:...:execA', $metadata: {} });
    await dispatchServiceIntegration(
      'StepFunctions-StartExecution',
      { StateMachineArn: 'arn:sm', Name: 'exec-1', Input: '{}' },
      'us-east-1'
    );
    const command = (sfnSend.mock.calls[0]?.[0] ?? {}) as { input: Record<string, unknown> };
    expect(command.input).toEqual({
      stateMachineArn: 'arn:sm',
      name: 'exec-1',
      input: '{}',
    });
  });

  it('StopExecution carries optional Cause/Error', async () => {
    sfnSend.mockResolvedValueOnce({ stopDate: new Date(0), $metadata: {} });
    await dispatchServiceIntegration(
      'StepFunctions-StopExecution',
      { ExecutionArn: 'arn:exec', Cause: 'user-cancel', Error: 'CANCELLED' },
      'us-east-1'
    );
    const command = (sfnSend.mock.calls[0]?.[0] ?? {}) as { input: Record<string, unknown> };
    expect(command.input).toEqual({
      executionArn: 'arn:exec',
      cause: 'user-cancel',
      error: 'CANCELLED',
    });
  });
});

describe('dispatchServiceIntegration — Kinesis-PutRecord', () => {
  it('decodes base64-shaped Data into a Uint8Array', async () => {
    kinesisSend.mockResolvedValueOnce({ ShardId: 's-1', $metadata: {} });
    const b64 = Buffer.from('hello').toString('base64');
    await dispatchServiceIntegration(
      'Kinesis-PutRecord',
      { StreamName: 's', Data: b64, PartitionKey: 'pk' },
      'us-east-1'
    );
    const command = (kinesisSend.mock.calls[0]?.[0] ?? {}) as { input: { Data: Uint8Array } };
    expect(Buffer.from(command.input.Data).toString('utf8')).toBe('hello');
  });

  it('falls back to UTF-8 bytes when Data is not base64-shaped', async () => {
    kinesisSend.mockResolvedValueOnce({ ShardId: 's-1', $metadata: {} });
    await dispatchServiceIntegration(
      'Kinesis-PutRecord',
      { StreamName: 's', Data: 'plain text!', PartitionKey: 'pk' },
      'us-east-1'
    );
    const command = (kinesisSend.mock.calls[0]?.[0] ?? {}) as { input: { Data: Uint8Array } };
    expect(Buffer.from(command.input.Data).toString('utf8')).toBe('plain text!');
  });
});

describe('dispatchServiceIntegration — AppConfig-GetConfiguration', () => {
  it('returns 501 — package not bundled (documented limitation)', async () => {
    const result = await dispatchServiceIntegration(
      'AppConfig-GetConfiguration',
      { Application: 'a', Environment: 'e', Configuration: 'c', ClientId: 'cid' },
      'us-east-1'
    );
    expect(result.statusCode).toBe(501);
    expect(JSON.parse(result.body).message).toContain('@aws-sdk/client-appconfig');
  });
});

describe('applyResponseParameters', () => {
  const ctx = { context: { requestId: 'r-1' }, stageVariables: { env: 'prod' } };

  it('overrides statuscode and adds a header', () => {
    const base = { statusCode: 200, body: '{}', headers: { 'content-type': 'application/json' } };
    const out = applyResponseParameters(
      base,
      {
        '200': {
          'overwrite:statuscode': '201',
          'overwrite:header.x-custom': '$context.requestId',
        },
      },
      ctx
    );
    expect(out.statusCode).toBe(201);
    expect(out.headers['x-custom']).toBe('r-1');
  });

  it('append:header concatenates with existing value', () => {
    const base = { statusCode: 200, body: '{}', headers: { 'x-tag': 'a' } };
    const out = applyResponseParameters(base, { '200': { 'append:header.x-tag': 'b' } }, ctx);
    expect(out.headers['x-tag']).toBe('a,b');
  });

  it('remove:header drops the named header', () => {
    const base = { statusCode: 200, body: '{}', headers: { 'x-tag': 'a' } };
    const out = applyResponseParameters(base, { '200': { 'remove:header.x-tag': '' } }, ctx);
    expect(out.headers['x-tag']).toBeUndefined();
  });

  it("'default' overlay applies when the exact statusCode is not listed", () => {
    const base = { statusCode: 404, body: '{}', headers: {} as Record<string, string> };
    const out = applyResponseParameters(
      base,
      { default: { 'overwrite:header.x-default': 'yes' } },
      ctx
    );
    expect(out.headers['x-default']).toBe('yes');
  });

  it('skips reserved headers (e.g. content-length)', () => {
    const base = { statusCode: 200, body: '{}', headers: {} as Record<string, string> };
    const out = applyResponseParameters(
      base,
      { '200': { 'overwrite:header.Content-Length': '999' } },
      ctx
    );
    expect(out.headers['content-length']).toBeUndefined();
  });

  it('${...} interpolation in response values', () => {
    const base = { statusCode: 200, body: '{}', headers: {} as Record<string, string> };
    const out = applyResponseParameters(
      base,
      { '200': { 'overwrite:header.x-trace': 'req-${context.requestId}-${stageVariables.env}' } },
      ctx
    );
    expect(out.headers['x-trace']).toBe('req-r-1-prod');
  });

  it('no overlay → base passes through unchanged', () => {
    const base = { statusCode: 418, body: 'tea', headers: { 'content-type': 'text/plain' } };
    expect(applyResponseParameters(base, undefined, ctx)).toEqual(base);
  });
});
