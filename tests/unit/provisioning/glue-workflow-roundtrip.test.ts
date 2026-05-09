import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CreateWorkflowCommand,
  UpdateWorkflowCommand,
  DeleteWorkflowCommand,
  GetWorkflowCommand,
  GetTagsCommand,
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

import { GlueWorkflowProvider } from '../../../src/provisioning/providers/glue-provider.js';

describe('GlueWorkflowProvider', () => {
  let provider: GlueWorkflowProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueWorkflowProvider();
  });

  it('create() builds CreateWorkflow with every templated field', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await provider.create('L', 'AWS::Glue::Workflow', {
      Name: 'my-wf',
      Description: 'desc',
      DefaultRunProperties: { foo: 'bar' },
      MaxConcurrentRuns: 3,
      Tags: [{ Key: 'env', Value: 'prod' }],
    });

    expect(result).toEqual({ physicalId: 'my-wf', attributes: {} });
    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateWorkflowCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-wf',
      Description: 'desc',
      DefaultRunProperties: { foo: 'bar' },
      MaxConcurrentRuns: 3,
      Tags: { env: 'prod' },
    });
  });

  it('create() omits optional fields when not provided', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.create('L', 'AWS::Glue::Workflow', { Name: 'my-wf' });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateWorkflowCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({ Name: 'my-wf' });
  });

  it('create() requires Name', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Workflow', { Description: 'desc' })
    ).rejects.toThrow(/Name is required/);
  });

  it('update() forwards full UpdateWorkflow input including empty placeholders (truthy-gate guard)', async () => {
    // `cdkd drift --revert` round-trip: empty-string Description and
    // empty DefaultRunProperties placeholder must reach AWS to clear
    // console-side ADDs (per feedback_update_optional_field_undefined_check.md).
    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'L',
      'my-wf',
      'AWS::Glue::Workflow',
      { Name: 'my-wf', Description: '', DefaultRunProperties: {}, MaxConcurrentRuns: 5 },
      {}
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateWorkflowCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-wf',
      Description: '',
      DefaultRunProperties: {},
      MaxConcurrentRuns: 5,
    });
  });

  it('delete() calls DeleteWorkflow', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.delete('L', 'my-wf', 'AWS::Glue::Workflow', undefined, {
      expectedRegion: 'us-east-1',
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteWorkflowCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({ Name: 'my-wf' });
  });

  it('delete() treats EntityNotFoundException as idempotent when region matches', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    await expect(
      provider.delete('L', 'my-wf', 'AWS::Glue::Workflow', undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('getAttribute() returns physicalId for Name / Id / Ref', async () => {
    expect(await provider.getAttribute('my-wf', 'AWS::Glue::Workflow', 'Name')).toBe('my-wf');
    expect(await provider.getAttribute('my-wf', 'AWS::Glue::Workflow', 'Id')).toBe('my-wf');
    expect(await provider.getAttribute('my-wf', 'AWS::Glue::Workflow', 'Ref')).toBe('my-wf');
    expect(
      await provider.getAttribute('my-wf', 'AWS::Glue::Workflow', 'Unknown')
    ).toBeUndefined();
  });

  it('readCurrentState() emits PR #145 always-emit placeholders for Description / DefaultRunProperties / Tags', async () => {
    // GetWorkflow returns minimal data (no Description / DefaultRunProperties /
    // MaxConcurrentRuns / tags) — placeholders must surface so the v3
    // observedProperties baseline catches console-side ADDs on a previously
    // default workflow.
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetWorkflowCommand) {
        return Promise.resolve({ Workflow: { Name: 'my-wf' } });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({ Tags: {} });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-wf', 'L', 'AWS::Glue::Workflow');
    expect(result).toEqual({
      Name: 'my-wf',
      Description: '',
      DefaultRunProperties: {},
      Tags: [],
    });
    // MaxConcurrentRuns intentionally absent — no AWS-side default.
    expect(result).not.toHaveProperty('MaxConcurrentRuns');
  });

  it('readCurrentState() surfaces AWS values when set', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetWorkflowCommand) {
        return Promise.resolve({
          Workflow: {
            Name: 'my-wf',
            Description: 'desc',
            DefaultRunProperties: { foo: 'bar' },
            MaxConcurrentRuns: 3,
          },
        });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({
          Tags: { env: 'prod', 'aws:cdk:path': 'MyStack/MyWf' },
        });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-wf', 'L', 'AWS::Glue::Workflow');
    expect(result).toEqual({
      Name: 'my-wf',
      Description: 'desc',
      DefaultRunProperties: { foo: 'bar' },
      MaxConcurrentRuns: 3,
      // aws:cdk:path filtered out by normalizeAwsTagsToCfn
      Tags: [{ Key: 'env', Value: 'prod' }],
    });
  });

  it('readCurrentState() returns undefined when workflow does not exist', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('missing', 'L', 'AWS::Glue::Workflow');
    expect(result).toBeUndefined();
  });

  it('readCurrentState() falls back to empty Tags array if GetTags fails', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetWorkflowCommand) {
        return Promise.resolve({ Workflow: { Name: 'my-wf' } });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.reject(new Error('AccessDenied'));
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-wf', 'L', 'AWS::Glue::Workflow');
    expect(result).toEqual({
      Name: 'my-wf',
      Description: '',
      DefaultRunProperties: {},
      Tags: [],
    });
  });

  it('handledProperties declares the full mutable surface', () => {
    const set = provider.handledProperties.get('AWS::Glue::Workflow');
    expect(set).toBeDefined();
    expect([...(set ?? new Set())].sort()).toEqual([
      'DefaultRunProperties',
      'Description',
      'MaxConcurrentRuns',
      'Name',
      'Tags',
    ]);
  });
});
