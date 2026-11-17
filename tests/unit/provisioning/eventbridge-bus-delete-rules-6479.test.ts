import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteEventBusCommand,
  DeleteRuleCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';

// go-to-k/cdkd#6479: an EventBus delete leaves every rule on the bus alone.
// AWS (and CloudFormation) refuse DeleteEventBus while a rule remains, so a
// rule the stack does not own keeps the bus and the delete refuses, naming
// it. Only rules an AWS service manages are waited out.

const mockEventBridgeSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: {
      send: mockEventBridgeSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

const { EventBridgeBusProvider } = await import(
  '../../../src/provisioning/providers/eventbridge-bus-provider.js'
);
const { ProvisioningError } = await import('../../../src/utils/error-handler.js');
const { isMarkedNonRetryable } = await import('../../../src/deployment/retryable-errors.js');
const { isMarkedNotGone } = await import('../../../src/provisioning/not-gone.js');

function hasRules(): Error {
  const err = new Error("EventBus can't be deleted since it has rules.");
  err.name = 'ValidationException';
  return err;
}

function sentTypes(): unknown[] {
  return mockEventBridgeSend.mock.calls.map((c) => (c[0] as object).constructor);
}

const STRIP_CALLS = [ListTargetsByRuleCommand, RemoveTargetsCommand, DeleteRuleCommand];

function provider(): {
  bus: InstanceType<typeof EventBridgeBusProvider>;
  sleeps: number[];
} {
  const bus = new EventBridgeBusProvider();
  const sleeps: number[] = [];
  bus.managedRuleWait = {
    pollIntervalMs: 5,
    timeoutMs: 50,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  return { bus, sleeps };
}

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the delete to throw');
}

beforeEach(() => {
  mockEventBridgeSend.mockReset();
});

describe('EventBridgeBusProvider.delete leaves rules on the bus alone (#6479)', () => {
  it('deletes a bus with no rules in one call, listing nothing', async () => {
    mockEventBridgeSend.mockResolvedValue({});
    const { bus, sleeps } = provider();
    await bus.delete('Bus', 'my-bus', 'AWS::Events::EventBus');
    expect(sentTypes()).toEqual([DeleteEventBusCommand]);
    expect(sleeps).toEqual([]);
  });

  it('refuses, naming them, when rules the stack does not own remain, and deletes none', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteEventBusCommand) throw hasRules();
      if (cmd instanceof ListRulesCommand) {
        return { Rules: [{ Name: 'other-stack-rule' }, { Name: 'archive', ManagedBy: 'events.amazonaws.com' }] };
      }
      return {};
    });
    const { bus, sleeps } = provider();
    const err = await caught(bus.delete('Bus', 'my-bus', 'AWS::Events::EventBus'));
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err.message).toContain('other-stack-rule');
    expect(err.message).toContain('1 rule(s) this stack does not delete');
    expect(err.message).not.toContain('archive');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(sentTypes().some((t) => STRIP_CALLS.includes(t as never))).toBe(false);
    expect(sentTypes().filter((t) => t === DeleteEventBusCommand)).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("marks the refusal not-gone, so a rule name spelling a not-found is never read as 'deleted'", async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteEventBusCommand) throw hasRules();
      if (cmd instanceof ListRulesCommand) return { Rules: [{ Name: 'ResourceNotFound-alarm' }] };
      return {};
    });
    const err = await caught(provider().bus.delete('Bus', 'my-bus', 'AWS::Events::EventBus'));
    expect(err.message).toContain('ResourceNotFound-alarm');
    expect(isMarkedNotGone(err)).toBe(true);
  });

  it('waits out rules an AWS service manages, then deletes the bus', async () => {
    let deletes = 0;
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteEventBusCommand) {
        deletes++;
        if (deletes < 3) throw hasRules();
        return {};
      }
      if (cmd instanceof ListRulesCommand) {
        return { Rules: [{ Name: 'Events-Archive-a', ManagedBy: 'events.amazonaws.com' }] };
      }
      return {};
    });
    const { bus, sleeps } = provider();
    await bus.delete('Bus', 'my-bus', 'AWS::Events::EventBus');
    expect(deletes).toBe(3);
    expect(sleeps).toEqual([5, 5]);
    expect(sentTypes().some((t) => STRIP_CALLS.includes(t as never))).toBe(false);
  });

  it('refuses once managed rules outlast the wait, naming each rule and its manager', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteEventBusCommand) throw hasRules();
      if (cmd instanceof ListRulesCommand) {
        return { Rules: [{ Name: 'Schemas-x', ManagedBy: 'schemas.amazonaws.com' }] };
      }
      return {};
    });
    const { bus } = provider();
    bus.managedRuleWait.timeoutMs = 0;
    const err = await caught(bus.delete('Bus', 'my-bus', 'AWS::Events::EventBus'));
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err.message).toContain('Schemas-x (schemas.amazonaws.com)');
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('retries at once when the last rule went between the refusal and the listing', async () => {
    let deletes = 0;
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteEventBusCommand) {
        deletes++;
        if (deletes === 1) throw hasRules();
        return {};
      }
      if (cmd instanceof ListRulesCommand) return { Rules: [] };
      return {};
    });
    const { bus, sleeps } = provider();
    await bus.delete('Bus', 'my-bus', 'AWS::Events::EventBus');
    expect(deletes).toBe(2);
    expect(sleeps).toEqual([]);
  });

  it('reads every page of rules before deciding', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteEventBusCommand) throw hasRules();
      if (cmd instanceof ListRulesCommand) {
        const input = (cmd as InstanceType<typeof ListRulesCommand>).input;
        return input.NextToken === 'p2'
          ? { Rules: [{ Name: 'on-page-two' }] }
          : { Rules: [{ Name: 'managed', ManagedBy: 'events.amazonaws.com' }], NextToken: 'p2' };
      }
      return {};
    });
    const err = await caught(provider().bus.delete('Bus', 'my-bus', 'AWS::Events::EventBus'));
    expect(err.message).toContain('on-page-two');
  });

  it('leaves another DeleteEventBus failure to the plain wrap, listing nothing', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteEventBusCommand) {
        const err = new Error('User is not authorized');
        err.name = 'AccessDeniedException';
        throw err;
      }
      return {};
    });
    const err = await caught(provider().bus.delete('Bus', 'my-bus', 'AWS::Events::EventBus'));
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err.message).toContain('Failed to delete EventBus Bus');
    expect(sentTypes()).toEqual([DeleteEventBusCommand]);
  });
});
