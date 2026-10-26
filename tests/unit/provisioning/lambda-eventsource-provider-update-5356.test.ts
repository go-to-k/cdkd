import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateEventSourceMappingCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';

// Issue #5356: a Queues / Topics change was silently dropped on update (the
// Update API takes neither, and the schema does not make them create-only, so
// nothing replaced the mapping), and a declared MaximumBatchingWindowInSeconds
// of 0 was dropped on create.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Issue #2080: the create call goes through a dedicated `LambdaClient`; route
// it to the same mock.
vi.mock('@aws-sdk/client-lambda', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-lambda')>()),
  LambdaClient: vi.fn().mockImplementation(() => ({
    send: (command: unknown) => mockSend(command),
    config: {},
  })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::Lambda::EventSourceMapping';
const UUID = 'abcdef12-3456-7890-abcd-ef1234567890';
const ARN = `arn:aws:lambda:us-east-1:123456789012:event-source-mapping:${UUID}`;
const KAFKA = {
  FunctionName: 'fn',
  SelfManagedEventSource: { Endpoints: { KafkaBootstrapServers: ['b.example:9092'] } },
  StartingPosition: 'TRIM_HORIZON',
};
const MQ = {
  FunctionName: 'fn',
  EventSourceArn: 'arn:aws:mq:us-east-1:123456789012:broker:b:b-1234',
};

function inputOf<T>(ctor: new (...args: never[]) => T): Record<string, unknown> | undefined {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof ctor);
  return (call?.[0] as { input: Record<string, unknown> } | undefined)?.input;
}

describe('LambdaEventSourceMappingProvider (issue #5356)', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof UpdateEventSourceMappingCommand || cmd instanceof CreateEventSourceMappingCommand
        ? { UUID, EventSourceMappingArn: ARN }
        : {}
    );
    provider = new LambdaEventSourceMappingProvider();
  });

  it('sends a declared MaximumBatchingWindowInSeconds of 0 on create', async () => {
    await provider.create('Esm', TYPE, { ...KAFKA, Topics: ['t'], MaximumBatchingWindowInSeconds: 0 });
    expect(inputOf(CreateEventSourceMappingCommand)).toHaveProperty(
      'MaximumBatchingWindowInSeconds',
      0
    );
  });

  it('omits MaximumBatchingWindowInSeconds on create when the template has none', async () => {
    await provider.create('Esm', TYPE, { ...KAFKA, Topics: ['t'] });
    expect(inputOf(CreateEventSourceMappingCommand)).not.toHaveProperty(
      'MaximumBatchingWindowInSeconds'
    );
  });

  it.each([
    ['Topics changed', KAFKA, 'Topics', ['old-topic-5356x'], ['new-topic-5356y']],
    ['Topics added', KAFKA, 'Topics', undefined, ['new-topic-5356y']],
    ['Topics removed', KAFKA, 'Topics', ['old-topic-5356x'], undefined],
    ['Queues changed', MQ, 'Queues', ['old-queue-5356x'], ['new-queue-5356y']],
    ['Queues added', MQ, 'Queues', undefined, ['new-queue-5356y']],
    ['Queues removed', MQ, 'Queues', ['old-queue-5356x'], undefined],
  ] as const)(
    'refuses a %s on update before any AWS call',
    async (_label, base, key, before, after) => {
      const err = await provider
        .update(
          'Esm',
          UUID,
          TYPE,
          { ...base, BatchSize: 20, ...(after !== undefined && { [key]: after }) },
          { ...base, ...(before !== undefined && { [key]: before }) }
        )
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((err as Error).message).toContain(`${TYPE} (Esm) cannot be updated in place`);
      expect((err as Error).message).toContain(`${key} cannot be changed`);
      expect((err as Error).message).toContain('--replace');
      // The topic / queue names are not echoed.
      expect((err as Error).message).not.toMatch(/5356x|5356y/);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('updates in place when Topics is unchanged, sending no Topics member', async () => {
    await provider.update(
      'Esm',
      UUID,
      TYPE,
      { ...KAFKA, Topics: ['a'], BatchSize: 20 },
      { ...KAFKA, Topics: ['a'], BatchSize: 10 }
    );
    const input = inputOf(UpdateEventSourceMappingCommand);
    expect(input).toMatchObject({ UUID, BatchSize: 20 });
    expect(input).not.toHaveProperty('Topics');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a state replay', { replayingState: true }],
    ['a drift revert', { desiredFromAwsReadback: true }],
  ] as const)('warns and proceeds on %s', async (_label, context) => {
    await provider.update(
      'Esm',
      UUID,
      TYPE,
      { ...KAFKA, Topics: ['b'], BatchSize: 20 },
      { ...KAFKA, Topics: ['a'], BatchSize: 10 },
      context
    );
    const input = inputOf(UpdateEventSourceMappingCommand);
    expect(input).toMatchObject({ UUID, BatchSize: 20 });
    expect(input).not.toHaveProperty('Topics');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Esm: Topics cannot be changed on an existing event source mapping')
    );
    // A deploy flag is no advice on a path the template does not drive.
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('--replace');
  });
});
