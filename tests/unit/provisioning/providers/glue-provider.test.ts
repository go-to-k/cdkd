import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockGlueSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockGlueSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
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
  UpdateDatabaseCommand,
  CreateJobCommand,
  UpdateJobCommand,
  CreateWorkflowCommand,
  StopCrawlerCommand,
  CrawlerRunningException,
} from '@aws-sdk/client-glue';
import {
  GlueProvider,
  GlueJobProvider,
  GlueWorkflowProvider,
  GlueCrawlerProvider,
  GlueTriggerProvider,
} from '../../../../src/provisioning/providers/glue-provider.js';

describe('GlueProvider import', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = new GlueProvider();
  });

  function makeDatabaseInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyDB',
      resourceType: 'AWS::Glue::Database',
      cdkPath: 'MyStack/MyDB',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('Database explicit override (knownPhysicalId): GetDatabase verifies', async () => {
    mockGlueSend.mockResolvedValueOnce({ Database: { Name: 'adopted_db' } });

    const result = await provider.import(makeDatabaseInput({ knownPhysicalId: 'adopted_db' }));

    expect(result).toEqual({ physicalId: 'adopted_db', attributes: {} });
    const call = mockGlueSend.mock.calls[0][0];
    expect(call.constructor.name).toBe('GetDatabaseCommand');
    expect(call.input).toEqual({ Name: 'adopted_db' });
  });

  it('Database tag-based lookup: matches aws:cdk:path via GetTags map', async () => {
    // GetDatabases
    mockGlueSend.mockResolvedValueOnce({
      DatabaseList: [{ Name: 'other_db' }, { Name: 'target_db' }],
    });
    // GetTags(other_db)
    mockGlueSend.mockResolvedValueOnce({
      Tags: { 'aws:cdk:path': 'OtherStack/Other' },
    });
    // GetTags(target_db)
    mockGlueSend.mockResolvedValueOnce({
      Tags: { 'aws:cdk:path': 'MyStack/MyDB' },
    });

    const result = await provider.import(makeDatabaseInput());
    expect(result).toEqual({ physicalId: 'target_db', attributes: {} });
  });

  it('Database returns null when nothing matches', async () => {
    mockGlueSend.mockResolvedValueOnce({ DatabaseList: [{ Name: 'only_db' }] });
    mockGlueSend.mockResolvedValueOnce({ Tags: { 'aws:cdk:path': 'OtherStack/Other' } });

    const result = await provider.import(makeDatabaseInput());
    expect(result).toBeNull();
  });

  it('Table tag-based lookup: matches via GetTables + GetTags', async () => {
    // GetTables
    mockGlueSend.mockResolvedValueOnce({
      TableList: [{ Name: 'target_table' }],
    });
    // GetTags
    mockGlueSend.mockResolvedValueOnce({
      Tags: { 'aws:cdk:path': 'MyStack/MyTable' },
    });

    const result = await provider.import({
      logicalId: 'MyTable',
      resourceType: 'AWS::Glue::Table',
      cdkPath: 'MyStack/MyTable',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { DatabaseName: 'mydb' },
    });

    expect(result).toEqual({ physicalId: 'mydb|target_table', attributes: {} });
  });
});

describe('GlueProvider update', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueProvider();
  });

  it('updates Database via UpdateDatabaseCommand with full DatabaseInput', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    const properties = {
      DatabaseInput: {
        Name: 'mydb',
        Description: 'updated',
        Parameters: { foo: 'bar' },
      },
    };

    await provider.update('MyDb', 'mydb', 'AWS::Glue::Database', properties, properties);

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect(call).toBeDefined();
    const input = call![0].input as { Name: string; DatabaseInput: { Description?: string } };
    expect(input.Name).toBe('mydb');
    expect(input.DatabaseInput.Description).toBe('updated');
  });
});

// Bug 1: Glue Job stringly-typed numeric coercion.
describe('GlueJobProvider numeric coercion', () => {
  let provider: GlueJobProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueJobProvider();
  });

  it('create: coerces string numerics to numbers at the SDK boundary', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    // CFn delivers these as STRINGS (CDK synths e.g. "10").
    const properties = {
      Name: 'myjob',
      Role: 'arn:aws:iam::123456789012:role/glue',
      Command: { Name: 'glueetl', ScriptLocation: 's3://bucket/script.py' },
      MaxRetries: '2',
      AllocatedCapacity: '5',
      Timeout: '60',
      MaxCapacity: '10',
      NumberOfWorkers: '4',
      ExecutionProperty: { MaxConcurrentRuns: '3' },
      NotificationProperty: { NotifyDelayAfter: '7' },
    };

    await provider.create('MyJob', 'AWS::Glue::Job', properties);

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateJobCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input['MaxRetries']).toBe(2);
    expect(input['AllocatedCapacity']).toBe(5);
    expect(input['Timeout']).toBe(60);
    expect(input['MaxCapacity']).toBe(10);
    expect(input['NumberOfWorkers']).toBe(4);
    expect((input['ExecutionProperty'] as { MaxConcurrentRuns: number }).MaxConcurrentRuns).toBe(3);
    expect((input['NotificationProperty'] as { NotifyDelayAfter: number }).NotifyDelayAfter).toBe(7);
    // Every coerced value must be a real number, not a string.
    for (const key of ['MaxRetries', 'AllocatedCapacity', 'Timeout', 'MaxCapacity', 'NumberOfWorkers']) {
      expect(typeof input[key]).toBe('number');
    }
  });

  it('update: coerces string numerics inside JobUpdate', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    const properties = {
      Name: 'myjob',
      Role: 'arn:aws:iam::123456789012:role/glue',
      Command: { Name: 'glueetl', ScriptLocation: 's3://bucket/script.py' },
      Timeout: '120',
      NumberOfWorkers: '8',
    };

    await provider.update('MyJob', 'myjob', 'AWS::Glue::Job', properties, properties);

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateJobCommand);
    expect(call).toBeDefined();
    const jobUpdate = (call![0].input as { JobUpdate: Record<string, unknown> }).JobUpdate;
    expect(jobUpdate['Timeout']).toBe(120);
    expect(jobUpdate['NumberOfWorkers']).toBe(8);
    expect(typeof jobUpdate['Timeout']).toBe('number');
  });

  it('create: leaves already-numeric values untouched', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.create('MyJob', 'AWS::Glue::Job', {
      Name: 'myjob',
      Role: 'arn:aws:iam::123456789012:role/glue',
      Command: { Name: 'glueetl' },
      Timeout: 30,
    });

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateJobCommand);
    expect((call![0].input as Record<string, unknown>)['Timeout']).toBe(30);
  });
});

// Bug 4: Glue Workflow Tags map shape + MaxConcurrentRuns coercion.
describe('GlueWorkflowProvider tags + numeric', () => {
  let provider: GlueWorkflowProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueWorkflowProvider();
  });

  it('create: tags from a MAP shape reach the SDK (not silently dropped)', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.create('MyWf', 'AWS::Glue::Workflow', {
      Name: 'mywf',
      Tags: { env: 'prod', team: 'data' },
      MaxConcurrentRuns: '5',
    });

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateWorkflowCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input['Tags']).toEqual({ env: 'prod', team: 'data' });
    expect(input['MaxConcurrentRuns']).toBe(5);
    expect(typeof input['MaxConcurrentRuns']).toBe('number');
  });

  it('create: tags from a {Key,Value}[] list shape also reach the SDK', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.create('MyWf', 'AWS::Glue::Workflow', {
      Name: 'mywf',
      Tags: [{ Key: 'env', Value: 'prod' }],
    });

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateWorkflowCommand);
    expect((call![0].input as Record<string, unknown>)['Tags']).toEqual({ env: 'prod' });
  });

  it('create: no Tags key when there are no tags', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.create('MyWf', 'AWS::Glue::Workflow', { Name: 'mywf' });

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateWorkflowCommand);
    expect((call![0].input as Record<string, unknown>)['Tags']).toBeUndefined();
  });
});

// Bug 2: Glue Crawler CrawlerRunningException handling.
describe('GlueCrawlerProvider running-state handling', () => {
  let provider: GlueCrawlerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueCrawlerProvider();
  });

  function runningError(): CrawlerRunningException {
    return new CrawlerRunningException({
      $metadata: {},
      message: 'Crawler is running',
    });
  }

  it('delete: stops a running crawler and retries DeleteCrawler', async () => {
    // 1st DeleteCrawler -> CrawlerRunningException
    mockGlueSend.mockRejectedValueOnce(runningError());
    // StopCrawler
    mockGlueSend.mockResolvedValueOnce({});
    // GetCrawler poll -> READY (loop exits without sleeping)
    mockGlueSend.mockResolvedValueOnce({ Crawler: { State: 'READY' } });
    // 2nd DeleteCrawler -> success
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyCrawler', 'mycrawler', 'AWS::Glue::Crawler', {}, undefined);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    expect(types).toContain('StopCrawlerCommand');
    expect(types.filter((t) => t === 'DeleteCrawlerCommand')).toHaveLength(2);
    const stopCall = mockGlueSend.mock.calls.find((c) => c[0] instanceof StopCrawlerCommand);
    expect((stopCall![0].input as { Name: string }).Name).toBe('mycrawler');
  });

  it('update: stops a running crawler and retries UpdateCrawler', async () => {
    // 1st UpdateCrawler -> CrawlerRunningException
    mockGlueSend.mockRejectedValueOnce(runningError());
    // StopCrawler
    mockGlueSend.mockResolvedValueOnce({});
    // GetCrawler poll -> READY
    mockGlueSend.mockResolvedValueOnce({ Crawler: { State: 'READY' } });
    // 2nd UpdateCrawler -> success
    mockGlueSend.mockResolvedValueOnce({});
    // applyTagDiff GetTags (no-op when tags empty) — provider only calls when diff non-empty
    const props = { Role: 'arn:aws:iam::123456789012:role/glue', Targets: { S3Targets: [] } };

    await provider.update('MyCrawler', 'mycrawler', 'AWS::Glue::Crawler', props, props);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    expect(types).toContain('StopCrawlerCommand');
    expect(types.filter((t) => t === 'UpdateCrawlerCommand')).toHaveLength(2);
  });
});

// Bug 3: Glue Trigger update state-machine (wait + restore-on-failure + stop-before-delete).
describe('GlueTriggerProvider state-machine', () => {
  let provider: GlueTriggerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueTriggerProvider();
  });

  it('update: restores ACTIVATED via StartTrigger even when UpdateTrigger throws', async () => {
    // GetTrigger pre-check -> ACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'ACTIVATED' } });
    // StopTrigger
    mockGlueSend.mockResolvedValueOnce({});
    // waitForTriggerDeactivated: GetTrigger -> DEACTIVATED (exits without sleep)
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // UpdateTrigger -> throws
    mockGlueSend.mockRejectedValueOnce(new Error('update boom'));
    // StartTrigger (in finally) -> success
    mockGlueSend.mockResolvedValueOnce({});

    const props = { Schedule: 'cron(0 12 * * ? *)' };
    await expect(
      provider.update('MyTrig', 'mytrig', 'AWS::Glue::Trigger', props, props)
    ).rejects.toThrow(/Failed to update Glue Trigger/);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    // The finally block must have run StartTrigger to re-activate the trigger.
    expect(types).toContain('StartTriggerCommand');
    expect(types.filter((t) => t === 'UpdateTriggerCommand')).toHaveLength(1);
  });

  it('update: waits for DEACTIVATED between StopTrigger and UpdateTrigger', async () => {
    // GetTrigger pre-check -> ACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'ACTIVATED' } });
    // StopTrigger
    mockGlueSend.mockResolvedValueOnce({});
    // waitForTriggerDeactivated: GetTrigger -> DEACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // UpdateTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});
    // StartTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});

    const props = { Schedule: 'cron(0 1 * * ? *)' };
    await provider.update('MyTrig', 'mytrig', 'AWS::Glue::Trigger', props, props);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    const stopIdx = types.indexOf('StopTriggerCommand');
    const updateIdx = types.indexOf('UpdateTriggerCommand');
    const getBetween = types
      .slice(stopIdx + 1, updateIdx)
      .filter((t) => t === 'GetTriggerCommand');
    // At least one GetTrigger poll happened between Stop and Update.
    expect(getBetween.length).toBeGreaterThanOrEqual(1);
    expect(types).toContain('StartTriggerCommand');
  });

  it('update: does not stop/restart a trigger that is already DEACTIVATED', async () => {
    // GetTrigger pre-check -> DEACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // UpdateTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});

    const props = { Schedule: 'cron(0 2 * * ? *)' };
    await provider.update('MyTrig', 'mytrig', 'AWS::Glue::Trigger', props, props);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    expect(types).not.toContain('StopTriggerCommand');
    expect(types).not.toContain('StartTriggerCommand');
  });

  it('delete: stops an ACTIVATED trigger before DeleteTrigger', async () => {
    // GetTrigger pre-delete check -> ACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'ACTIVATED' } });
    // StopTrigger
    mockGlueSend.mockResolvedValueOnce({});
    // waitForTriggerDeactivated: GetTrigger -> DEACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // DeleteTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTrig', 'mytrig', 'AWS::Glue::Trigger', {}, undefined);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    const stopIdx = types.indexOf('StopTriggerCommand');
    const deleteIdx = types.indexOf('DeleteTriggerCommand');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(stopIdx);
  });

  it('delete: does not stop a trigger that is not ACTIVATED', async () => {
    // GetTrigger pre-delete check -> DEACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // DeleteTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTrig', 'mytrig', 'AWS::Glue::Trigger', {}, undefined);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    expect(types).not.toContain('StopTriggerCommand');
    expect(types).toContain('DeleteTriggerCommand');
  });
});
