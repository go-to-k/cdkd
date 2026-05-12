import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateJobCommand,
  UpdateJobCommand,
  DeleteJobCommand,
  GetJobCommand,
  GetTagsCommand,
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

import { GlueJobProvider } from '../../../src/provisioning/providers/glue-provider.js';

describe('GlueJobProvider', () => {
  let provider: GlueJobProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueJobProvider();
    mockSend.mockResolvedValue({});
  });

  it('create() builds CreateJob with required Role / Command and templated Tags', async () => {
    const result = await provider.create('L', 'AWS::Glue::Job', {
      Name: 'my-job',
      Role: 'arn:aws:iam::123456789012:role/GlueJobRole',
      Command: {
        Name: 'glueetl',
        ScriptLocation: 's3://my-bucket/scripts/job.py',
        PythonVersion: '3',
      },
      Description: 'My Glue job',
      MaxCapacity: 2.0,
      MaxRetries: 3,
      Timeout: 2880,
      GlueVersion: '4.0',
      DefaultArguments: { '--job-bookmark-option': 'job-bookmark-enable' },
      Tags: [{ Key: 'env', Value: 'prod' }],
    });

    expect(result).toEqual({ physicalId: 'my-job', attributes: {} });
    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateJobCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-job',
      Role: 'arn:aws:iam::123456789012:role/GlueJobRole',
      Command: {
        Name: 'glueetl',
        ScriptLocation: 's3://my-bucket/scripts/job.py',
        PythonVersion: '3',
      },
      Description: 'My Glue job',
      MaxCapacity: 2.0,
      MaxRetries: 3,
      Timeout: 2880,
      GlueVersion: '4.0',
      DefaultArguments: { '--job-bookmark-option': 'job-bookmark-enable' },
      Tags: { env: 'prod' },
    });
  });

  it('create() omits optional fields when not provided', async () => {
    await provider.create('L', 'AWS::Glue::Job', {
      Name: 'my-job',
      Role: 'arn:aws:iam::123456789012:role/GlueJobRole',
      Command: { Name: 'glueetl' },
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateJobCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-job',
      Role: 'arn:aws:iam::123456789012:role/GlueJobRole',
      Command: { Name: 'glueetl' },
    });
  });

  it('create() fails when Role is missing', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Job', {
        Name: 'my-job',
        Command: { Name: 'glueetl' },
      })
    ).rejects.toThrow(/Role is required/);
  });

  it('create() fails when Command is missing', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Job', {
        Name: 'my-job',
        Role: 'arn:aws:iam::123456789012:role/GlueJobRole',
      })
    ).rejects.toThrow(/Command is required/);
  });

  it('update() forwards JobUpdate with Command + Role + common fields', async () => {
    await provider.update(
      'L',
      'my-job',
      'AWS::Glue::Job',
      {
        Name: 'my-job',
        Role: 'arn:aws:iam::123456789012:role/GlueJobRole-v2',
        Command: { Name: 'glueetl', ScriptLocation: 's3://my-bucket/scripts/job-v2.py' },
        Description: 'updated',
        MaxRetries: 5,
        Timeout: 1440,
      },
      {}
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateJobCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      JobName: 'my-job',
      JobUpdate: {
        Command: { Name: 'glueetl', ScriptLocation: 's3://my-bucket/scripts/job-v2.py' },
        Description: 'updated',
        MaxRetries: 5,
        Timeout: 1440,
        Role: 'arn:aws:iam::123456789012:role/GlueJobRole-v2',
      },
    });
  });

  it('update() round-trips empty placeholders (Description: "" / DefaultArguments: {}) so drift --revert can clear console-side ADDs', async () => {
    // Per feedback_update_optional_field_undefined_check.md: empty
    // string / empty map MUST reach AWS so console-side ADDs revert.
    await provider.update(
      'L',
      'my-job',
      'AWS::Glue::Job',
      {
        Name: 'my-job',
        Description: '',
        DefaultArguments: {},
      },
      { Description: 'old description', DefaultArguments: { '--foo': 'bar' } }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateJobCommand);
    expect(call).toBeDefined();
    const input = call![0].input as { JobUpdate: Record<string, unknown> };
    expect(input.JobUpdate.Description).toBe('');
    expect(input.JobUpdate.DefaultArguments).toEqual({});
  });

  it('update() reconciles Tag diff via TagResource + UntagResource when tags change', async () => {
    await provider.update(
      'L',
      'my-job',
      'AWS::Glue::Job',
      {
        Name: 'my-job',
        Tags: [
          { Key: 'env', Value: 'prod' },
          { Key: 'team', Value: 'data' },
        ],
      },
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
      ResourceArn: 'arn:aws:glue:us-east-1:123456789012:job/my-job',
      TagsToAdd: { env: 'prod', team: 'data' },
    });
    expect(tagRemove![0].input).toEqual({
      ResourceArn: 'arn:aws:glue:us-east-1:123456789012:job/my-job',
      TagsToRemove: ['old'],
    });
  });

  it('update() does not call TagResource / UntagResource when tags are unchanged', async () => {
    const tags = [{ Key: 'env', Value: 'prod' }];
    await provider.update(
      'L',
      'my-job',
      'AWS::Glue::Job',
      { Name: 'my-job', Tags: tags },
      { Tags: tags }
    );

    expect(mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand)).toBeUndefined();
    expect(mockSend.mock.calls.find((c) => c[0] instanceof UntagResourceCommand)).toBeUndefined();
  });

  it('delete() calls DeleteJob', async () => {
    await provider.delete('L', 'my-job', 'AWS::Glue::Job', undefined, {
      expectedRegion: 'us-east-1',
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteJobCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({ JobName: 'my-job' });
  });

  it('delete() treats EntityNotFoundException as idempotent when region matches', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    await expect(
      provider.delete('L', 'my-job', 'AWS::Glue::Job', undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('getAttribute() returns physicalId for Id / Ref / Name', async () => {
    expect(await provider.getAttribute('my-job', 'AWS::Glue::Job', 'Id')).toBe('my-job');
    expect(await provider.getAttribute('my-job', 'AWS::Glue::Job', 'Ref')).toBe('my-job');
    expect(await provider.getAttribute('my-job', 'AWS::Glue::Job', 'Name')).toBe('my-job');
    expect(await provider.getAttribute('my-job', 'AWS::Glue::Job', 'Unknown')).toBeUndefined();
  });

  it('readCurrentState() emits PR #145 always-emit placeholders for every user-controllable field on a default Job', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetJobCommand) {
        return Promise.resolve({ Job: { Name: 'my-job' } });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({ Tags: {} });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-job', 'L', 'AWS::Glue::Job');
    expect(result).toEqual({
      Name: 'my-job',
      Role: '',
      Command: {},
      Description: '',
      LogUri: '',
      DefaultArguments: {},
      NonOverridableArguments: {},
      Connections: { Connections: [] },
      MaxRetries: 0,
      Timeout: 0,
      ExecutionProperty: { MaxConcurrentRuns: 1 },
      NotificationProperty: { NotifyDelayAfter: 0 },
      GlueVersion: '',
      NumberOfWorkers: 0,
      WorkerType: '',
      MaxCapacity: 0,
      AllocatedCapacity: 0,
      SecurityConfiguration: '',
      ExecutionClass: '',
      JobMode: '',
      JobRunQueuingEnabled: false,
      MaintenanceWindow: '',
      SourceControlDetails: {},
      Tags: [],
    });
  });

  it('readCurrentState() surfaces AWS values when Job is fully configured', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetJobCommand) {
        return Promise.resolve({
          Job: {
            Name: 'my-job',
            Role: 'arn:aws:iam::123456789012:role/GlueJobRole',
            Command: {
              Name: 'glueetl',
              ScriptLocation: 's3://my-bucket/scripts/job.py',
              PythonVersion: '3',
            },
            Description: 'desc',
            MaxRetries: 3,
            Timeout: 2880,
            GlueVersion: '4.0',
            DefaultArguments: { '--foo': 'bar' },
            ExecutionProperty: { MaxConcurrentRuns: 5 },
            NumberOfWorkers: 2,
            WorkerType: 'G.1X',
          },
        });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({
          Tags: { env: 'prod', 'aws:cdk:path': 'MyStack/MyJob' },
        });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-job', 'L', 'AWS::Glue::Job');
    expect(result).toMatchObject({
      Name: 'my-job',
      Role: 'arn:aws:iam::123456789012:role/GlueJobRole',
      Command: {
        Name: 'glueetl',
        ScriptLocation: 's3://my-bucket/scripts/job.py',
        PythonVersion: '3',
      },
      Description: 'desc',
      MaxRetries: 3,
      Timeout: 2880,
      GlueVersion: '4.0',
      DefaultArguments: { '--foo': 'bar' },
      ExecutionProperty: { MaxConcurrentRuns: 5 },
      NumberOfWorkers: 2,
      WorkerType: 'G.1X',
      // aws:cdk:path filtered out by normalizeAwsTagsToCfn
      Tags: [{ Key: 'env', Value: 'prod' }],
    });
  });

  it('readCurrentState() returns undefined when job does not exist', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('missing', 'L', 'AWS::Glue::Job');
    expect(result).toBeUndefined();
  });

  it('readCurrentState() falls back to empty Tags array when GetTags fails', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetJobCommand) {
        return Promise.resolve({ Job: { Name: 'my-job' } });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.reject(new Error('AccessDenied'));
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-job', 'L', 'AWS::Glue::Job');
    expect(result?.Tags).toEqual([]);
  });

  it('handledProperties declares the full mutable surface', () => {
    const set = provider.handledProperties.get('AWS::Glue::Job');
    expect(set).toBeDefined();
    expect(set?.has('Name')).toBe(true);
    expect(set?.has('Role')).toBe(true);
    expect(set?.has('Command')).toBe(true);
    expect(set?.has('Tags')).toBe(true);
    expect(set?.has('GlueVersion')).toBe(true);
    expect(set?.has('NumberOfWorkers')).toBe(true);
  });
});
