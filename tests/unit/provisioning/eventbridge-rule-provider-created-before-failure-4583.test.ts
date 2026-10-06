import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: {
      send: (command: unknown) => mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    },
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

import {
  DeleteRuleCommand,
  DescribeRuleCommand,
  PutRuleCommand,
  PutTargetsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-eventbridge';
import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

// go-to-k/cdkd#4583: create() self-cleans a PutTargets failure; only a rule
// the name was free for and that cleanup failed to delete is named (by ARN,
// delete()'s physical id) for the failed-CREATE journal.
const TYPE = 'AWS::Events::Rule';
const ARN = 'arn:aws:events:us-east-1:123456789012:rule/MyRule';
const PROPS = {
  Name: 'MyRule',
  EventPattern: { source: ['aws.s3'] },
  Targets: [{ Id: 'T1', Arn: 'arn:aws:sqs:us-east-1:123456789012:q' }],
};

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected create() to throw');
}

function fakeAws(opts: { held: boolean; deleteFails: boolean }): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof DescribeRuleCommand) {
      if (opts.held) return { Name: 'MyRule', Arn: ARN };
      throw new ResourceNotFoundException({ $metadata: {}, message: 'not found' });
    }
    if (cmd instanceof PutRuleCommand) return { RuleArn: ARN };
    if (cmd instanceof PutTargetsCommand) throw new Error('PutTargets boom');
    if (cmd instanceof DeleteRuleCommand && opts.deleteFails) throw new Error('AccessDenied');
    return { Targets: [] };
  });
}

describe('EventBridgeRuleProvider.create created-before-failure mark (#4583)', () => {
  let provider: EventBridgeRuleProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new EventBridgeRuleProvider();
  });

  it('marks the rule ARN when the wiring cleanup failed to delete it', async () => {
    fakeAws({ held: false, deleteFails: true });
    const err = await caught(provider.create('Rule', TYPE, PROPS));
    expect(createdBeforeFailure(err, 'Rule', TYPE)).toBe(ARN);
  });

  it('does not mark when the wiring cleanup deleted the rule', async () => {
    fakeAws({ held: false, deleteFails: false });
    const err = await caught(provider.create('Rule', TYPE, PROPS));
    expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteRuleCommand)).toBe(true);
    expect(createdBeforeFailure(err, 'Rule', TYPE)).toBeUndefined();
  });

  it('does not mark a rule that held the name before PutRule (cleanup skipped)', async () => {
    fakeAws({ held: true, deleteFails: false });
    const err = await caught(provider.create('Rule', TYPE, PROPS));
    expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteRuleCommand)).toBe(false);
    expect(createdBeforeFailure(err, 'Rule', TYPE)).toBeUndefined();
  });

  it('does not mark when PutRule itself fails', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DescribeRuleCommand) {
        throw new ResourceNotFoundException({ $metadata: {}, message: 'not found' });
      }
      throw new Error('LimitExceeded');
    });
    const err = await caught(provider.create('Rule', TYPE, PROPS));
    expect(createdBeforeFailure(err, 'Rule', TYPE)).toBeUndefined();
  });

  it('does not mark the pre-flight refusal of malformed Tags', async () => {
    const err = await caught(provider.create('Rule', TYPE, { ...PROPS, Tags: 'x' }));
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(err, 'Rule', TYPE)).toBeUndefined();
  });
});
