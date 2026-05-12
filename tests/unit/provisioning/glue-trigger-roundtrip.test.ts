import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTriggerCommand,
  UpdateTriggerCommand,
  DeleteTriggerCommand,
  GetTriggerCommand,
  GetTagsCommand,
  StartTriggerCommand,
  StopTriggerCommand,
  TagResourceCommand,
  UntagResourceCommand,
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

vi.mock('@aws-sdk/client-sts', () => {
  return {
    STSClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({ Account: '123456789012' }),
    })),
    GetCallerIdentityCommand: vi.fn(),
  };
});

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

import { GlueTriggerProvider } from '../../../src/provisioning/providers/glue-provider.js';

describe('GlueTriggerProvider', () => {
  let provider: GlueTriggerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueTriggerProvider();
    mockSend.mockResolvedValue({});
  });

  it('create() builds CreateTrigger with full SCHEDULED-trigger surface', async () => {
    const result = await provider.create('L', 'AWS::Glue::Trigger', {
      Name: 'my-trigger',
      Type: 'SCHEDULED',
      Schedule: 'cron(0 12 * * ? *)',
      Actions: [{ JobName: 'my-job', Arguments: { '--foo': 'bar' } }],
      Description: 'My trigger',
      StartOnCreation: true,
      WorkflowName: 'my-workflow',
      Tags: [{ Key: 'env', Value: 'prod' }],
    });

    expect(result).toEqual({ physicalId: 'my-trigger', attributes: {} });
    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateTriggerCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-trigger',
      Type: 'SCHEDULED',
      Schedule: 'cron(0 12 * * ? *)',
      Actions: [{ JobName: 'my-job', Arguments: { '--foo': 'bar' } }],
      Description: 'My trigger',
      StartOnCreation: true,
      WorkflowName: 'my-workflow',
      Tags: { env: 'prod' },
    });
  });

  it('create() builds CreateTrigger with CONDITIONAL Predicate and EventBatchingCondition', async () => {
    await provider.create('L', 'AWS::Glue::Trigger', {
      Name: 'my-cond-trigger',
      Type: 'CONDITIONAL',
      Actions: [{ JobName: 'downstream' }],
      Predicate: {
        Logical: 'ANY',
        Conditions: [
          {
            LogicalOperator: 'EQUALS',
            JobName: 'upstream',
            State: 'SUCCEEDED',
          },
        ],
      },
      EventBatchingCondition: { BatchSize: 5, BatchWindow: 30 },
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateTriggerCommand);
    expect(call![0].input).toMatchObject({
      Name: 'my-cond-trigger',
      Type: 'CONDITIONAL',
      Predicate: {
        Logical: 'ANY',
        Conditions: [
          { LogicalOperator: 'EQUALS', JobName: 'upstream', State: 'SUCCEEDED' },
        ],
      },
      EventBatchingCondition: { BatchSize: 5, BatchWindow: 30 },
    });
  });

  it('create() fails when Type is missing', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Trigger', {
        Name: 'my-trigger',
        Actions: [{ JobName: 'j' }],
      })
    ).rejects.toThrow(/Type is required/);
  });

  it('create() fails when Actions is missing', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Trigger', { Name: 'my-trigger', Type: 'ON_DEMAND' })
    ).rejects.toThrow(/Actions is required/);
  });

  it('update() with ACTIVATED trigger executes Stop -> Update -> Start (state preserved across update)', async () => {
    // GetTrigger returns ACTIVATED — provider must Stop, Update, then Start.
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetTriggerCommand) {
        return Promise.resolve({ Trigger: { Name: 'my-trigger', State: 'ACTIVATED' } });
      }
      return Promise.resolve({});
    });

    await provider.update(
      'L',
      'my-trigger',
      'AWS::Glue::Trigger',
      {
        Description: 'updated',
        Actions: [{ JobName: 'my-job-v2' }],
      },
      {}
    );

    // Order matters: GetTrigger -> StopTrigger -> UpdateTrigger -> StartTrigger
    const callTypes = mockSend.mock.calls.map((c) => c[0].constructor.name);
    const stopIdx = callTypes.indexOf(StopTriggerCommand.name);
    const updateIdx = callTypes.indexOf(UpdateTriggerCommand.name);
    const startIdx = callTypes.indexOf(StartTriggerCommand.name);

    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(stopIdx);
    expect(startIdx).toBeGreaterThan(updateIdx);
  });

  it('update() with DEACTIVATED trigger calls Update only — no Stop / Start', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetTriggerCommand) {
        return Promise.resolve({ Trigger: { Name: 'my-trigger', State: 'DEACTIVATED' } });
      }
      return Promise.resolve({});
    });

    await provider.update(
      'L',
      'my-trigger',
      'AWS::Glue::Trigger',
      { Description: 'updated' },
      {}
    );

    const stop = mockSend.mock.calls.find((c) => c[0] instanceof StopTriggerCommand);
    const update = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTriggerCommand);
    const start = mockSend.mock.calls.find((c) => c[0] instanceof StartTriggerCommand);
    expect(stop).toBeUndefined();
    expect(update).toBeDefined();
    expect(start).toBeUndefined();
  });

  it('update() forwards UpdateTrigger.TriggerUpdate with all mutable fields when provided', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetTriggerCommand) {
        return Promise.resolve({ Trigger: { Name: 'my-trigger', State: 'DEACTIVATED' } });
      }
      return Promise.resolve({});
    });

    await provider.update(
      'L',
      'my-trigger',
      'AWS::Glue::Trigger',
      {
        Description: 'updated',
        Schedule: 'cron(0 6 * * ? *)',
        Actions: [{ JobName: 'my-job-v2' }],
        Predicate: {
          Logical: 'ANY',
          Conditions: [{ JobName: 'upstream', State: 'SUCCEEDED' }],
        },
        EventBatchingCondition: { BatchSize: 10, BatchWindow: 60 },
      },
      {}
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTriggerCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-trigger',
      TriggerUpdate: {
        Description: 'updated',
        Schedule: 'cron(0 6 * * ? *)',
        Actions: [{ JobName: 'my-job-v2' }],
        Predicate: {
          Logical: 'ANY',
          Conditions: [{ JobName: 'upstream', State: 'SUCCEEDED' }],
        },
        EventBatchingCondition: { BatchSize: 10, BatchWindow: 60 },
      },
    });
  });

  it('update() reconciles Tag diff via TagResource + UntagResource when tags change', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetTriggerCommand) {
        return Promise.resolve({ Trigger: { Name: 'my-trigger', State: 'DEACTIVATED' } });
      }
      return Promise.resolve({});
    });

    await provider.update(
      'L',
      'my-trigger',
      'AWS::Glue::Trigger',
      { Tags: [{ Key: 'env', Value: 'prod' }] },
      {
        Tags: [
          { Key: 'env', Value: 'dev' },
          { Key: 'old', Value: 'remove-me' },
        ],
      }
    );

    const tagAdd = mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand);
    const tagRemove = mockSend.mock.calls.find((c) => c[0] instanceof UntagResourceCommand);
    expect(tagAdd).toBeDefined();
    expect(tagRemove).toBeDefined();
    expect(tagAdd![0].input).toEqual({
      ResourceArn: 'arn:aws:glue:us-east-1:123456789012:trigger/my-trigger',
      TagsToAdd: { env: 'prod' },
    });
    expect(tagRemove![0].input).toEqual({
      ResourceArn: 'arn:aws:glue:us-east-1:123456789012:trigger/my-trigger',
      TagsToRemove: ['old'],
    });
  });

  it('delete() calls DeleteTrigger', async () => {
    await provider.delete('L', 'my-trigger', 'AWS::Glue::Trigger', undefined, {
      expectedRegion: 'us-east-1',
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteTriggerCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({ Name: 'my-trigger' });
  });

  it('delete() treats EntityNotFoundException as idempotent when region matches', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    await expect(
      provider.delete('L', 'my-trigger', 'AWS::Glue::Trigger', undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('getAttribute() returns physicalId for Id / Ref / Name', async () => {
    expect(await provider.getAttribute('my-trigger', 'AWS::Glue::Trigger', 'Id')).toBe(
      'my-trigger'
    );
    expect(await provider.getAttribute('my-trigger', 'AWS::Glue::Trigger', 'Ref')).toBe(
      'my-trigger'
    );
    expect(await provider.getAttribute('my-trigger', 'AWS::Glue::Trigger', 'Name')).toBe(
      'my-trigger'
    );
    expect(
      await provider.getAttribute('my-trigger', 'AWS::Glue::Trigger', 'Unknown')
    ).toBeUndefined();
  });

  it('readCurrentState() emits PR #145 always-emit placeholders for every user-controllable field on a default Trigger', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetTriggerCommand) {
        return Promise.resolve({ Trigger: { Name: 'my-trigger' } });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({ Tags: {} });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-trigger', 'L', 'AWS::Glue::Trigger');
    expect(result).toEqual({
      Name: 'my-trigger',
      Type: '',
      Schedule: '',
      Description: '',
      WorkflowName: '',
      Actions: [],
      Predicate: {},
      EventBatchingCondition: {},
      Tags: [],
    });
  });

  it('readCurrentState() surfaces AWS values when Trigger is fully configured', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetTriggerCommand) {
        return Promise.resolve({
          Trigger: {
            Name: 'my-trigger',
            Type: 'CONDITIONAL',
            Schedule: '',
            Description: 'desc',
            WorkflowName: 'my-wf',
            Actions: [{ JobName: 'downstream', Arguments: { '--x': 'y' } }],
            Predicate: {
              Logical: 'ANY',
              Conditions: [
                {
                  LogicalOperator: 'EQUALS',
                  JobName: 'upstream',
                  State: 'SUCCEEDED',
                },
              ],
            },
            EventBatchingCondition: { BatchSize: 5, BatchWindow: 30 },
          },
        });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({
          Tags: { env: 'prod', 'aws:cdk:path': 'MyStack/MyTrigger' },
        });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-trigger', 'L', 'AWS::Glue::Trigger');
    expect(result).toMatchObject({
      Name: 'my-trigger',
      Type: 'CONDITIONAL',
      Description: 'desc',
      WorkflowName: 'my-wf',
      Actions: [{ JobName: 'downstream', Arguments: { '--x': 'y' } }],
      Predicate: {
        Logical: 'ANY',
        Conditions: [{ LogicalOperator: 'EQUALS', JobName: 'upstream', State: 'SUCCEEDED' }],
      },
      EventBatchingCondition: { BatchSize: 5, BatchWindow: 30 },
      Tags: [{ Key: 'env', Value: 'prod' }],
    });
  });

  it('readCurrentState() returns undefined when trigger does not exist', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('missing', 'L', 'AWS::Glue::Trigger');
    expect(result).toBeUndefined();
  });

  it('handledProperties declares the full mutable surface', () => {
    const set = provider.handledProperties.get('AWS::Glue::Trigger');
    expect(set).toBeDefined();
    expect([...(set ?? new Set())].sort()).toEqual([
      'Actions',
      'Description',
      'EventBatchingCondition',
      'Name',
      'Predicate',
      'Schedule',
      'StartOnCreation',
      'Tags',
      'Type',
      'WorkflowName',
    ]);
  });
});
