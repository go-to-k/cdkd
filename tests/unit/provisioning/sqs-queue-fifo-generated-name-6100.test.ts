import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateQueueCommand } from '@aws-sdk/client-sqs';

// go-to-k/cdkd#6100: an un-named FIFO queue was sent a generated name without
// the `.fifo` suffix SQS requires, so `new sqs.Queue(this, 'Q', { fifo: true })`
// never deployed. CloudFormation names it `<stack>-<logicalId>-<random>.fifo`,
// the suffix inside the 80 characters.

const mockSend = vi.fn();
const mockStsSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';
import {
  applyDefaultNameForFallback,
  withStackScope,
} from '../../../src/provisioning/resource-name.js';

const TYPE = 'AWS::SQS::Queue';
const STACK = 'MyStack';
const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const LONG = `Queue${'X'.repeat(200)}`;
const IDS = ['Q', LONG];

const legacy = <T>(fn: () => T): T =>
  withStackScope({ stackName: STACK, stackInstanceId: undefined, nameGenerations: undefined }, fn);
const v13 = <T>(fn: () => T): T =>
  withStackScope(
    { stackName: STACK, stackInstanceId: ID, nameGenerations: new Map(IDS.map((id) => [id, 0])) },
    fn
  );

describe('SQSQueueProvider names an un-named FIFO queue `.fifo` (go-to-k/cdkd#6100)', () => {
  let provider: SQSQueueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof CreateQueueCommand
        ? {
            QueueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${(cmd as CreateQueueCommand).input.QueueName}`,
          }
        : {}
    );
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = new SQSQueueProvider();
  });

  for (const [scopeName, scope] of [
    ['a stack with an instance id', v13],
    ['a legacy stack', legacy],
  ] as const) {
    for (const fifo of [true, 'true', 'TRUE']) {
      for (const logicalId of IDS) {
        it(`${scopeName}, FifoQueue ${JSON.stringify(fifo)}, logical id length ${logicalId.length}`, () => {
          const props = { FifoQueue: fifo };
          const name = scope(() => provider.generatedCreateName(TYPE, logicalId, props))!;
          expect(name.endsWith('.fifo')).toBe(true);
          expect(name.length).toBeLessThanOrEqual(80);
          expect(name).toMatch(/^[A-Za-z0-9_-]+\.fifo$/);
          // The Cloud Control fill and the replacement-name holder read the same rule.
          const filled = scope(() => applyDefaultNameForFallback(logicalId, TYPE, props, 'omit'));
          expect(filled['QueueName']).toBe(name);
          // The standard queue's name is the FIFO one without the suffix's room
          // taken: the same base when short.
          const standard = scope(() => provider.generatedCreateName(TYPE, logicalId, {}))!;
          expect(standard.endsWith('.fifo')).toBe(false);
          if (logicalId === 'Q') expect(name).toBe(`${standard}.fifo`);
        });
      }
    }
  }

  it('the long logical id truncates to exactly 80 characters, suffix kept', () => {
    const name = v13(() => provider.generatedCreateName(TYPE, LONG, { FifoQueue: true }))!;
    expect(name).toHaveLength(80);
    expect(name.endsWith('.fifo')).toBe(true);
  });

  for (const notFifo of [false, 'false', undefined, 'yes', { 'Fn::If': ['c', true, false] }]) {
    it(`FifoQueue ${JSON.stringify(notFifo)} gets no suffix`, () => {
      const props = notFifo === undefined ? {} : { FifoQueue: notFifo };
      const name = v13(() => provider.generatedCreateName(TYPE, 'Q', props))!;
      expect(name.endsWith('.fifo')).toBe(false);
    });
  }

  it('an unreadable FifoQueue defers the name lookup to the create; a readable one does not', () => {
    for (const fifo of [{ Ref: 'IsFifo' }, { 'Fn::If': ['c', true, false] }, 'yes']) {
      expect(provider.lookupNeedsResolvedProperties(TYPE, { FifoQueue: fifo })).toBe(true);
    }
    for (const props of [{}, { FifoQueue: null }, { FifoQueue: true }, { FifoQueue: 'false' }]) {
      expect(provider.lookupNeedsResolvedProperties(TYPE, props)).toBe(false);
    }
  });

  it('create() sends FifoQueue `TRUE` as `true`, as the name reads it', async () => {
    await v13(() => provider.create('Q', TYPE, { FifoQueue: 'TRUE' }));
    const create = mockSend.mock.calls
      .map((c) => c[0])
      .find((c): c is CreateQueueCommand => c instanceof CreateQueueCommand)!;
    expect(create.input.Attributes?.['FifoQueue']).toBe('true');
    expect(create.input.QueueName!.endsWith('.fifo')).toBe(true);
  });

  it('a declared QueueName is the template’s, not generated', () => {
    expect(
      v13(() => provider.generatedCreateName(TYPE, 'Q', { FifoQueue: true, QueueName: 'mine.fifo' }))
    ).toBeUndefined();
  });

  it('create() sends the `.fifo` name and records it', async () => {
    const props = { FifoQueue: true };
    const expected = v13(() => provider.generatedCreateName(TYPE, 'Q', props))!;
    const result = await v13(() => provider.create('Q', TYPE, props));
    const create = mockSend.mock.calls
      .map((c) => c[0])
      .find((c): c is CreateQueueCommand => c instanceof CreateQueueCommand)!;
    expect(create.input.QueueName).toBe(expected);
    expect(create.input.QueueName!.endsWith('.fifo')).toBe(true);
    expect(create.input.Attributes?.['FifoQueue']).toBe('true');
    expect(result.attributes?.['QueueName']).toBe(expected);
    expect(String(result.attributes?.['Arn'])).toMatch(/:MyStack-Q-[0-9a-f]{12}\.fifo$/);
  });
});
