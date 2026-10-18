/**
 * Issue #1160 (absent-field removal), AWS::Glue::Workflow and
 * AWS::Glue::Trigger slice.
 *
 * `UpdateWorkflow` and `UpdateTrigger` are FULL REPLACE calls: a field left out
 * of the input is cleared on AWS, not kept. A real CloudFormation A/B showed
 * CloudFormation clears a removed Workflow `Description` /
 * `DefaultRunProperties` / `MaxConcurrentRuns` and a removed Trigger
 * `Description` / `EventBatchingCondition` too. So the reset IS the omission:
 * these tests pin that a removed field never reaches the update input (from
 * the previous template or a declared default), that a present one still does,
 * and that the removal-warning declaration covers every property.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetTriggerCommand,
  UpdateTriggerCommand,
  UpdateWorkflowCommand,
} from '@aws-sdk/client-glue';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-glue', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-glue')>('@aws-sdk/client-glue');
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '123456789012' }),
  })),
  GetCallerIdentityCommand: vi.fn(),
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
  GlueTriggerProvider,
  GlueWorkflowProvider,
} from '../../../src/provisioning/providers/glue-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

const WORKFLOW = 'AWS::Glue::Workflow';
const TRIGGER = 'AWS::Glue::Trigger';

const WF_PREVIOUS = {
  Name: 'wf',
  Description: 'wf desc',
  DefaultRunProperties: { k1: 'v1' },
  MaxConcurrentRuns: 3,
};

const TRIGGER_PREVIOUS = {
  Name: 'trig',
  Type: 'EVENT',
  WorkflowName: 'wf',
  Description: 'trig desc',
  Actions: [{ JobName: 'job' }],
  EventBatchingCondition: { BatchSize: 5, BatchWindow: 300 },
};

/** The single command of `type` sent, by its input. */
function sentInput<T>(type: abstract new (...args: never[]) => T): Record<string, unknown> {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof type);
  expect(calls).toHaveLength(1);
  return (calls[0]![0] as { input: Record<string, unknown> }).input;
}

/** Runs the update the way the deploy engine does: removal prep, then update(). */
async function deployUpdate(
  provider: GlueWorkflowProvider | GlueTriggerProvider,
  type: string,
  desired: Record<string, unknown>,
  previous: Record<string, unknown>
): Promise<readonly string[]> {
  const prep = prepareRemovalForUpdate(provider, type, desired, previous);
  await provider.update('L', previous['Name'] as string, type, prep.properties, previous, {
    ...prep.context,
  });
  return prep.unhandled;
}

describe('GlueWorkflowProvider removal (#1160)', () => {
  let provider: GlueWorkflowProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new GlueWorkflowProvider();
  });

  it('declares no removalDefaults: the full-replace UpdateWorkflow omission is the reset', () => {
    expect(provider).not.toHaveProperty('removalDefaults');
  });

  it('removalHandledInUpdate covers every handled property, so no removal is warned about', () => {
    expect([...provider.removalHandledInUpdate.get(WORKFLOW)!].sort()).toEqual(
      [...provider.handledProperties.get(WORKFLOW)!].sort()
    );
  });

  it('a removed Description / DefaultRunProperties / MaxConcurrentRuns is OMITTED from UpdateWorkflow', async () => {
    const unhandled = await deployUpdate(provider, WORKFLOW, { Name: 'wf' }, WF_PREVIOUS);

    expect(unhandled).toEqual([]);
    // Exactly `{ Name }`: no previous value is carried over, no default injected.
    expect(sentInput(UpdateWorkflowCommand)).toEqual({ Name: 'wf' });
  });

  it('a present field is still sent (the other polarity)', async () => {
    const unhandled = await deployUpdate(
      provider,
      WORKFLOW,
      { Name: 'wf', Description: 'new desc', DefaultRunProperties: { k2: 'v2' } },
      WF_PREVIOUS
    );

    expect(unhandled).toEqual([]);
    expect(sentInput(UpdateWorkflowCommand)).toEqual({
      Name: 'wf',
      Description: 'new desc',
      DefaultRunProperties: { k2: 'v2' },
    });
  });

  it('a removal outside the declaration is still reported (the declaration is live)', () => {
    const prep = prepareRemovalForUpdate(
      provider,
      WORKFLOW,
      { Name: 'wf' },
      { ...WF_PREVIOUS, NotAWorkflowProperty: 'x' }
    );
    expect(prep.unhandled).toEqual(['NotAWorkflowProperty']);
  });
});

describe('GlueTriggerProvider removal (#1160)', () => {
  let provider: GlueTriggerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetTriggerCommand) {
        return Promise.resolve({ Trigger: { Name: 'trig', State: 'CREATED' } });
      }
      return Promise.resolve({});
    });
    provider = new GlueTriggerProvider();
  });

  it('declares no removalDefaults: the full-replace UpdateTrigger omission is the reset', () => {
    expect(provider).not.toHaveProperty('removalDefaults');
  });

  it('removalHandledInUpdate covers every handled property, so no removal is warned about', () => {
    expect([...provider.removalHandledInUpdate.get(TRIGGER)!].sort()).toEqual(
      [...provider.handledProperties.get(TRIGGER)!].sort()
    );
  });

  it('a removed Description / EventBatchingCondition is OMITTED from TriggerUpdate', async () => {
    const { Description: _d, EventBatchingCondition: _e, ...desired } = TRIGGER_PREVIOUS;
    const unhandled = await deployUpdate(provider, TRIGGER, desired, TRIGGER_PREVIOUS);

    expect(unhandled).toEqual([]);
    expect(sentInput(UpdateTriggerCommand)).toEqual({
      Name: 'trig',
      TriggerUpdate: { Actions: [{ JobName: 'job' }] },
    });
  });

  it('a present Description / EventBatchingCondition is still sent (the other polarity)', async () => {
    const desired = {
      ...TRIGGER_PREVIOUS,
      Description: 'new desc',
      EventBatchingCondition: { BatchSize: 2 },
    };
    const unhandled = await deployUpdate(provider, TRIGGER, desired, TRIGGER_PREVIOUS);

    expect(unhandled).toEqual([]);
    expect(sentInput(UpdateTriggerCommand)).toEqual({
      Name: 'trig',
      TriggerUpdate: {
        Description: 'new desc',
        Actions: [{ JobName: 'job' }],
        EventBatchingCondition: { BatchSize: 2 },
      },
    });
  });

  it('a removal outside the declaration is still reported (the declaration is live)', () => {
    const prep = prepareRemovalForUpdate(
      provider,
      TRIGGER,
      { ...TRIGGER_PREVIOUS },
      { ...TRIGGER_PREVIOUS, NotATriggerProperty: 'x' }
    );
    expect(prep.unhandled).toEqual(['NotATriggerProperty']);
  });
});
