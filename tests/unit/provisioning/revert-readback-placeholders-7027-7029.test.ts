import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { appsyncSend, glueSend } = vi.hoisted(() => ({ appsyncSend: vi.fn(), glueSend: vi.fn() }));

vi.mock('@aws-sdk/client-appsync', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-appsync')>('@aws-sdk/client-appsync');
  return {
    ...actual,
    AppSyncClient: vi.fn(() => ({
      send: appsyncSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-glue', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-glue')>('@aws-sdk/client-glue');
  return {
    ...actual,
    GlueClient: vi.fn(() => ({
      send: glueSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({ send: vi.fn(async () => ({ Account: '123456789012' })) })),
  GetCallerIdentityCommand: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

import { UpdateGraphqlApiCommand } from '@aws-sdk/client-appsync';
import {
  GetJobCommand,
  GetTriggerCommand,
  UpdateJobCommand,
  UpdateTriggerCommand,
} from '@aws-sdk/client-glue';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import {
  GlueJobProvider,
  GlueTriggerProvider,
} from '../../../src/provisioning/providers/glue-provider.js';
import { JOB_READBACK_PLACEHOLDERS } from '../../../src/provisioning/providers/glue/job.js';
import { TRIGGER_READBACK_PLACEHOLDERS } from '../../../src/provisioning/providers/glue/trigger.js';

const REVERT = { desiredFromAwsReadback: true } as const;

function sentInput(send: ReturnType<typeof vi.fn>, cls: new (...a: never[]) => unknown) {
  const calls = send.mock.calls.map((c) => c[0]).filter((c) => c instanceof cls);
  expect(calls).toHaveLength(1);
  return (calls[0] as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  appsyncSend.mockImplementation(async () => ({}));
  glueSend.mockImplementation(async () => ({}));
});

describe('AppSync GraphQLApi: the read-back empty LogConfig (#7027)', () => {
  const API = 'AWS::AppSync::GraphQLApi';
  const live = { Name: 'api-x', AuthenticationType: 'API_KEY', XrayEnabled: false, LogConfig: {} };

  it('a revert of another member sends no logConfig for an API without logging', async () => {
    await new AppSyncProvider().update(
      'Api',
      'api-1',
      API,
      { ...live, Name: 'api' },
      live,
      REVERT
    );
    const input = sentInput(appsyncSend, UpdateGraphqlApiCommand);
    expect(input['name']).toBe('api');
    expect(input).not.toHaveProperty('logConfig');
  });

  it('a revert to "no logging" disables the logging the live API has', async () => {
    const logged = {
      ...live,
      LogConfig: { CloudWatchLogsRoleArn: 'arn:aws:iam::123456789012:role/r', FieldLogLevel: 'ALL' },
    };
    await new AppSyncProvider().update('Api', 'api-1', API, live, logged, REVERT);
    expect(sentInput(appsyncSend, UpdateGraphqlApiCommand)['logConfig']).toEqual({
      cloudWatchLogsRoleArn: 'arn:aws:iam::123456789012:role/r',
      fieldLogLevel: 'NONE',
    });
  });

  it('a declared LogConfig is still sent', async () => {
    const log = { CloudWatchLogsRoleArn: 'arn:aws:iam::123456789012:role/r', FieldLogLevel: 'ERROR' };
    await new AppSyncProvider().update('Api', 'api-1', API, { ...live, LogConfig: log }, live);
    expect(sentInput(appsyncSend, UpdateGraphqlApiCommand)['logConfig']).toEqual({
      cloudWatchLogsRoleArn: 'arn:aws:iam::123456789012:role/r',
      fieldLogLevel: 'ERROR',
      excludeVerboseContent: undefined,
    });
  });
});

describe('Glue Job: the read-back placeholders and capacity echoes (#7028)', () => {
  const JOB = 'AWS::Glue::Job';

  async function readBack(): Promise<Record<string, unknown>> {
    glueSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetJobCommand) {
        return {
          Job: {
            Name: 'job',
            Role: 'arn:aws:iam::123456789012:role/glue',
            Command: { Name: 'glueetl', ScriptLocation: 's3://b/x.py', PythonVersion: '3' },
            Description: 'changed',
            GlueVersion: '4.0',
            WorkerType: 'G.1X',
            NumberOfWorkers: 2,
            MaxCapacity: 2,
            AllocatedCapacity: 2,
            Timeout: 2880,
            MaxRetries: 0,
            ExecutionProperty: { MaxConcurrentRuns: 1 },
          },
        };
      }
      return { Tags: {} };
    });
    const bag = (await new GlueJobProvider().readCurrentState('job', 'Job', JOB)) as Record<
      string,
      unknown
    >;
    glueSend.mockClear();
    glueSend.mockImplementation(async () => ({}));
    return bag;
  }

  it('a revert sends neither the placeholders nor the computed capacity', async () => {
    const live = await readBack();
    await new GlueJobProvider().update(
      'Job',
      'job',
      JOB,
      { ...live, Description: 'hunt job' },
      live,
      REVERT
    );
    const update = sentInput(glueSend, UpdateJobCommand)['JobUpdate'] as Record<string, unknown>;
    expect(update['Description']).toBe('hunt job');
    expect(update['WorkerType']).toBe('G.1X');
    expect(update['NumberOfWorkers']).toBe(2);
    for (const key of [
      'ExecutionClass',
      'MaintenanceWindow',
      'SecurityConfiguration',
      'NotificationProperty',
      'LogUri',
      'MaxCapacity',
      'AllocatedCapacity',
    ]) {
      expect(update).not.toHaveProperty(key);
    }
    // A real zero the job holds is still sent.
    expect(update['MaxRetries']).toBe(0);
  });

  it('a template update is sent as declared', async () => {
    const declared = {
      Role: 'arn:aws:iam::123456789012:role/glue',
      Command: { Name: 'glueetl', ScriptLocation: 's3://b/x.py' },
      MaxCapacity: 2,
      Description: '',
    };
    await new GlueJobProvider().update('Job', 'job', JOB, declared, { ...declared, Description: 'x' });
    const update = sentInput(glueSend, UpdateJobCommand)['JobUpdate'] as Record<string, unknown>;
    expect(update['Description']).toBe('');
    expect(update['MaxCapacity']).toBe(2);
  });

  it('every placeholder the read-back emits for a bare job is in the table', async () => {
    glueSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetJobCommand ? { Job: { Name: 'job' } } : { Tags: {} }
    );
    const bag = (await new GlueJobProvider().readCurrentState('job', 'Job', JOB)) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(JOB_READBACK_PLACEHOLDERS)) {
      expect(bag[key], key).toEqual(value);
    }
  });
});

describe('Glue Trigger: the read-back placeholders (#7029)', () => {
  const TRIGGER = 'AWS::Glue::Trigger';

  it('a revert sends no empty EventBatchingCondition / Predicate / Schedule', async () => {
    glueSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetTriggerCommand ? { Trigger: { Name: 'trig', State: 'CREATED' } } : {}
    );
    const live = {
      Name: 'trig',
      Type: 'ON_DEMAND',
      Schedule: '',
      Description: 'changed',
      Actions: [{ JobName: 'job' }],
      Predicate: {},
      EventBatchingCondition: {},
    };
    await new GlueTriggerProvider().update(
      'Trig',
      'trig',
      TRIGGER,
      { ...live, Description: 'hunt trigger' },
      live,
      REVERT
    );
    const update = sentInput(glueSend, UpdateTriggerCommand)['TriggerUpdate'] as Record<
      string,
      unknown
    >;
    expect(update).toEqual({ Description: 'hunt trigger', Actions: [{ JobName: 'job' }] });
  });

  it('every placeholder the read-back emits for a bare trigger is in the table', async () => {
    glueSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetTriggerCommand ? { Trigger: { Name: 'trig' } } : { Tags: {} }
    );
    const bag = (await new GlueTriggerProvider().readCurrentState(
      'trig',
      'Trig',
      TRIGGER
    )) as Record<string, unknown>;
    for (const [key, value] of Object.entries(TRIGGER_READBACK_PLACEHOLDERS)) {
      expect(bag[key], key).toEqual(value);
    }
  });
});

describe('AppSync GraphQLApi: logging switched off reads as no logging (#7027)', () => {
  const API = 'AWS::AppSync::GraphQLApi';
  const provider = new AppSyncProvider();
  const role = 'arn:aws:iam::123456789012:role/r';

  it('folds FieldLogLevel NONE with only its role to {}', () => {
    for (const LogConfig of [
      { CloudWatchLogsRoleArn: role, FieldLogLevel: 'NONE' },
      { CloudWatchLogsRoleArn: role, FieldLogLevel: 'NONE', ExcludeVerboseContent: false },
    ]) {
      expect(provider.canonicalizeDriftProperties(API, { LogConfig })['LogConfig']).toEqual({});
    }
  });

  it('keeps any other logging block, and other types, as they are', () => {
    for (const LogConfig of [
      { CloudWatchLogsRoleArn: role, FieldLogLevel: 'ERROR' },
      { CloudWatchLogsRoleArn: role, FieldLogLevel: 'NONE', ExcludeVerboseContent: true },
    ]) {
      const bag = { LogConfig };
      expect(provider.canonicalizeDriftProperties(API, bag)).toBe(bag);
    }
    const other = { LogConfig: { FieldLogLevel: 'NONE' } };
    expect(provider.canonicalizeDriftProperties('AWS::AppSync::Resolver', other)).toBe(other);
  });
});

describe('Glue Job: a revert of the capacity spelling itself (#7028)', () => {
  it('keeps MaxCapacity and drops the live workers when only MaxCapacity changed', async () => {
    const live = {
      Role: 'arn:aws:iam::123456789012:role/glue',
      Command: { Name: 'glueetl', ScriptLocation: 's3://b/x.py' },
      WorkerType: 'G.1X',
      NumberOfWorkers: 2,
      MaxCapacity: 2,
      AllocatedCapacity: 2,
    };
    await new GlueJobProvider().update(
      'Job',
      'job',
      'AWS::Glue::Job',
      { ...live, MaxCapacity: 10 },
      live,
      REVERT
    );
    const update = sentInput(glueSend, UpdateJobCommand)['JobUpdate'] as Record<string, unknown>;
    expect(update['MaxCapacity']).toBe(10);
    expect(update).not.toHaveProperty('WorkerType');
    expect(update).not.toHaveProperty('NumberOfWorkers');
    expect(update).not.toHaveProperty('AllocatedCapacity');
  });
});
