import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTopicCommand } from '@aws-sdk/client-sns';

// go-to-k/cdkd#6100 (the SNS sibling of the SQS fix): an un-named FIFO topic
// (an L1 `CfnTopic` with `FifoTopic: true`; CDK names an L2 FIFO topic) was
// sent a generated name without the `.fifo` suffix SNS requires.

const mockSend = vi.fn();
const { ownershipSend } = vi.hoisted(() => ({ ownershipSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: {
      send: (command: { constructor: { name: string } }) =>
        command.constructor.name === 'GetTopicAttributesCommand'
          ? ownershipSend(command)
          : mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    },
    sts: { send: ownershipSend },
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

import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import {
  applyDefaultNameForFallback,
  withStackScope,
} from '../../../src/provisioning/resource-name.js';

const TYPE = 'AWS::SNS::Topic';
const STACK = 'MyStack';
const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const LONG = `Topic${'X'.repeat(400)}`;
const IDS = ['T', LONG];

const v13 = <T>(fn: () => T): T =>
  withStackScope(
    { stackName: STACK, stackInstanceId: ID, nameGenerations: new Map(IDS.map((id) => [id, 0])) },
    fn
  );

describe('SNSTopicProvider names an un-named FIFO topic `.fifo` (go-to-k/cdkd#6100)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.resetAllMocks();
    ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCallerIdentityCommand') {
        return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/u' };
      }
      throw Object.assign(new Error('Topic does not exist'), { name: 'NotFoundException' });
    });
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof CreateTopicCommand
        ? Promise.resolve({ TopicArn: `arn:aws:sns:us-east-1:123456789012:${cmd.input.Name}` })
        : Promise.resolve({})
    );
    provider = new SNSTopicProvider();
  });

  for (const fifo of [true, 'true', 'TRUE']) {
    for (const logicalId of IDS) {
      it(`FifoTopic ${JSON.stringify(fifo)}, logical id length ${logicalId.length}`, () => {
        const props = { FifoTopic: fifo };
        const name = v13(() => provider.generatedCreateName(TYPE, logicalId, props))!;
        expect(name.endsWith('.fifo')).toBe(true);
        expect(name.length).toBeLessThanOrEqual(256);
        // The Cloud Control fill and the replacement-name holder read the same rule.
        const filled = v13(() => applyDefaultNameForFallback(logicalId, TYPE, props, 'omit'));
        expect(filled['TopicName']).toBe(name);
        const standard = v13(() => provider.generatedCreateName(TYPE, logicalId, {}))!;
        if (logicalId === 'T') expect(name).toBe(`${standard}.fifo`);
      });
    }
  }

  it('the long logical id truncates to exactly 256 characters, suffix kept', () => {
    const name = v13(() => provider.generatedCreateName(TYPE, LONG, { FifoTopic: true }))!;
    expect(name).toHaveLength(256);
    expect(name.endsWith('.fifo')).toBe(true);
  });

  for (const notFifo of [false, 'false', undefined]) {
    it(`FifoTopic ${JSON.stringify(notFifo)} gets no suffix`, () => {
      const props = notFifo === undefined ? {} : { FifoTopic: notFifo };
      expect(v13(() => provider.generatedCreateName(TYPE, 'T', props))!.endsWith('.fifo')).toBe(false);
    });
  }

  it('an unreadable FifoTopic defers the name lookup to the create; a readable one does not', () => {
    for (const fifo of [{ Ref: 'IsFifo' }, { 'Fn::If': ['c', true, false] }, 'yes']) {
      expect(provider.lookupNeedsResolvedProperties(TYPE, { FifoTopic: fifo })).toBe(true);
    }
    for (const props of [{}, { FifoTopic: null }, { FifoTopic: true }, { FifoTopic: 'false' }]) {
      expect(provider.lookupNeedsResolvedProperties(TYPE, props)).toBe(false);
    }
  });

  it('create() sends the `.fifo` name, and FifoTopic `TRUE` as `true`', async () => {
    const props = { FifoTopic: 'TRUE' };
    const expected = v13(() => provider.generatedCreateName(TYPE, 'T', props))!;
    await v13(() => provider.create('T', TYPE, props));
    const create = mockSend.mock.calls
      .map((c) => c[0])
      .find((c): c is CreateTopicCommand => c instanceof CreateTopicCommand)!;
    expect(create.input.Name).toBe(expected);
    expect(create.input.Name!.endsWith('.fifo')).toBe(true);
    expect(create.input.Attributes?.['FifoTopic']).toBe('true');
  });
});
