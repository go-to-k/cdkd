import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateCrawlerCommand,
  UpdateCrawlerCommand,
  DeleteCrawlerCommand,
  GetCrawlerCommand,
  GetTagsCommand,
  StartCrawlerScheduleCommand,
  StopCrawlerScheduleCommand,
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

import { GlueCrawlerProvider } from '../../../src/provisioning/providers/glue-provider.js';

describe('GlueCrawlerProvider', () => {
  let provider: GlueCrawlerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueCrawlerProvider();
    mockSend.mockResolvedValue({});
  });

  it('create() builds CreateCrawler with required Role / Targets and full optional surface', async () => {
    const result = await provider.create('L', 'AWS::Glue::Crawler', {
      Name: 'my-crawler',
      Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole',
      Targets: {
        S3Targets: [{ Path: 's3://my-bucket/data' }],
      },
      DatabaseName: 'my-db',
      Description: 'My crawler',
      Schedule: { ScheduleExpression: 'cron(0 12 * * ? *)' },
      Classifiers: ['my-classifier'],
      TablePrefix: 'tbl_',
      Configuration: '{"Version":1.0}',
      CrawlerSecurityConfiguration: 'my-sec-config',
      Tags: [{ Key: 'env', Value: 'prod' }],
    });

    expect(result).toEqual({ physicalId: 'my-crawler', attributes: {} });
    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateCrawlerCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-crawler',
      Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole',
      Targets: { S3Targets: [{ Path: 's3://my-bucket/data' }] },
      DatabaseName: 'my-db',
      Description: 'My crawler',
      // CFn structured Schedule unwrapped to bare cron string for the SDK
      Schedule: 'cron(0 12 * * ? *)',
      Classifiers: ['my-classifier'],
      TablePrefix: 'tbl_',
      Configuration: '{"Version":1.0}',
      CrawlerSecurityConfiguration: 'my-sec-config',
      Tags: { env: 'prod' },
    });
  });

  it('create() accepts a bare-string Schedule for forward-compat', async () => {
    await provider.create('L', 'AWS::Glue::Crawler', {
      Name: 'my-crawler',
      Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole',
      Targets: { S3Targets: [{ Path: 's3://my-bucket/' }] },
      Schedule: 'cron(0 0 * * ? *)',
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateCrawlerCommand);
    expect(call![0].input).toMatchObject({ Schedule: 'cron(0 0 * * ? *)' });
  });

  it('create() lower-cases DynamoDBTargets ScanAll / ScanRate for the SDK (#1391)', async () => {
    // The SDK's DynamoDBTarget is a lowercase island: `Path` is PascalCase but
    // the scan-tuning members are `scanAll` / `scanRate`. Forwarding the CFn
    // spelling silently dropped both (the target itself survived via `Path`).
    await provider.create('L', 'AWS::Glue::Crawler', {
      Name: 'my-crawler',
      Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole',
      Targets: {
        DynamoDBTargets: [
          { Path: 'my-table', ScanAll: true, ScanRate: 0.5 },
          { Path: 'other-table' },
        ],
        // Sibling sub-types spell every member exactly as CFn does — including
        // MongoDBTarget's own PascalCase `ScanAll` — so they pass through.
        S3Targets: [{ Path: 's3://my-bucket/data' }],
        MongoDBTargets: [{ ConnectionName: 'mongo', Path: 'db/coll', ScanAll: true }],
      },
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateCrawlerCommand);
    expect(call![0].input.Targets).toEqual({
      DynamoDBTargets: [{ Path: 'my-table', scanAll: true, scanRate: 0.5 }, { Path: 'other-table' }],
      S3Targets: [{ Path: 's3://my-bucket/data' }],
      MongoDBTargets: [{ ConnectionName: 'mongo', Path: 'db/coll', ScanAll: true }],
    });
  });

  it('create() coerces a stringly-typed ScanRate to a number (#1391)', async () => {
    // CFn is stringly typed, so a template can carry `ScanRate: "0.9"`. The SDK
    // models it as a double and the serializer forwards a string verbatim, so
    // the conversion — now the wire boundary for Targets — has to coerce.
    await provider.create('L', 'AWS::Glue::Crawler', {
      Name: 'my-crawler',
      Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole',
      Targets: {
        DynamoDBTargets: [
          { Path: 'my-table', ScanRate: '0.9', ScanAll: 'false' },
          // Non-numeric input passes through so AWS surfaces the real
          // validation error instead of cdkd mangling it.
          { Path: 'other-table', ScanRate: 'not-a-number', ScanAll: 'true' },
        ],
      },
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateCrawlerCommand);
    expect(call![0].input.Targets).toEqual({
      DynamoDBTargets: [
        // `ScanAll: 'false'` MUST become the boolean false — the raw string is
        // truthy, so forwarding it would silently invert the setting.
        { Path: 'my-table', scanRate: 0.9, scanAll: false },
        { Path: 'other-table', scanRate: 'not-a-number', scanAll: true },
      ],
    });
  });

  it('create() fails when Role is missing', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Crawler', {
        Name: 'my-crawler',
        Targets: { S3Targets: [] },
      })
    ).rejects.toThrow(/Role is required/);
  });

  it('create() fails when Targets is missing', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Crawler', {
        Name: 'my-crawler',
        Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole',
      })
    ).rejects.toThrow(/Targets is required/);
  });

  it('update() forwards UpdateCrawler with name + new Role / Targets / common fields', async () => {
    await provider.update(
      'L',
      'my-crawler',
      'AWS::Glue::Crawler',
      {
        Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole-v2',
        Targets: { S3Targets: [{ Path: 's3://my-bucket-v2/' }] },
        DatabaseName: 'my-db-v2',
        Description: 'updated',
        Schedule: { ScheduleExpression: 'cron(0 6 * * ? *)' },
      },
      {}
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateCrawlerCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-crawler',
      Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole-v2',
      Targets: { S3Targets: [{ Path: 's3://my-bucket-v2/' }] },
      DatabaseName: 'my-db-v2',
      Description: 'updated',
      Schedule: 'cron(0 6 * * ? *)',
    });
  });

  it('update() lower-cases DynamoDBTargets ScanAll / ScanRate for the SDK (#1391)', async () => {
    await provider.update(
      'L',
      'my-crawler',
      'AWS::Glue::Crawler',
      {
        Targets: { DynamoDBTargets: [{ Path: 'my-table', ScanAll: false, ScanRate: 1.5 }] },
      },
      {}
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateCrawlerCommand);
    expect(call![0].input.Targets).toEqual({
      DynamoDBTargets: [{ Path: 'my-table', scanAll: false, scanRate: 1.5 }],
    });
  });

  it('update() reconciles Tag diff via TagResource + UntagResource when tags change', async () => {
    await provider.update(
      'L',
      'my-crawler',
      'AWS::Glue::Crawler',
      {
        Tags: [{ Key: 'env', Value: 'prod' }],
      },
      {
        Tags: [{ Key: 'env', Value: 'dev' }, { Key: 'old', Value: 'remove-me' }],
      }
    );

    const tagAdd = mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand);
    const tagRemove = mockSend.mock.calls.find((c) => c[0] instanceof UntagResourceCommand);
    expect(tagAdd).toBeDefined();
    expect(tagRemove).toBeDefined();
    expect(tagAdd![0].input).toEqual({
      ResourceArn: 'arn:aws:glue:us-east-1:123456789012:crawler/my-crawler',
      TagsToAdd: { env: 'prod' },
    });
    expect(tagRemove![0].input).toEqual({
      ResourceArn: 'arn:aws:glue:us-east-1:123456789012:crawler/my-crawler',
      TagsToRemove: ['old'],
    });
  });

  it('update() does not call TagResource / UntagResource when tags are unchanged', async () => {
    const tags = [{ Key: 'env', Value: 'prod' }];
    await provider.update(
      'L',
      'my-crawler',
      'AWS::Glue::Crawler',
      { Tags: tags },
      { Tags: tags }
    );

    expect(mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand)).toBeUndefined();
    expect(mockSend.mock.calls.find((c) => c[0] instanceof UntagResourceCommand)).toBeUndefined();
  });

  it('delete() calls DeleteCrawler', async () => {
    await provider.delete('L', 'my-crawler', 'AWS::Glue::Crawler', undefined, {
      expectedRegion: 'us-east-1',
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteCrawlerCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({ Name: 'my-crawler' });
  });

  it('delete() treats EntityNotFoundException as idempotent when region matches', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    await expect(
      provider.delete('L', 'my-crawler', 'AWS::Glue::Crawler', undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('getAttribute() returns physicalId for Id / Ref / Name', async () => {
    expect(await provider.getAttribute('my-crawler', 'AWS::Glue::Crawler', 'Id')).toBe('my-crawler');
    expect(await provider.getAttribute('my-crawler', 'AWS::Glue::Crawler', 'Ref')).toBe(
      'my-crawler'
    );
    expect(await provider.getAttribute('my-crawler', 'AWS::Glue::Crawler', 'Name')).toBe(
      'my-crawler'
    );
    expect(
      await provider.getAttribute('my-crawler', 'AWS::Glue::Crawler', 'Unknown')
    ).toBeUndefined();
  });

  it('readCurrentState() emits PR #145 always-emit placeholders for every user-controllable field on a default Crawler', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetCrawlerCommand) {
        return Promise.resolve({ Crawler: { Name: 'my-crawler' } });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({ Tags: {} });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-crawler', 'L', 'AWS::Glue::Crawler');
    expect(result).toEqual({
      Name: 'my-crawler',
      Role: '',
      Targets: {},
      DatabaseName: '',
      Description: '',
      Schedule: {},
      Classifiers: [],
      TablePrefix: '',
      SchemaChangePolicy: {},
      RecrawlPolicy: {},
      LineageConfiguration: {},
      LakeFormationConfiguration: {},
      Configuration: '',
      CrawlerSecurityConfiguration: '',
      Tags: [],
    });
  });

  it('readCurrentState() reverse-maps SDK Schedule.ScheduleExpression into CFn structured shape', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetCrawlerCommand) {
        return Promise.resolve({
          Crawler: {
            Name: 'my-crawler',
            Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole',
            Targets: { S3Targets: [{ Path: 's3://my-bucket/data' }] },
            DatabaseName: 'my-db',
            Description: 'desc',
            Schedule: { ScheduleExpression: 'cron(0 12 * * ? *)', State: 'SCHEDULED' },
            Classifiers: ['my-classifier'],
          },
        });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({
          Tags: { env: 'prod', 'aws:cdk:path': 'MyStack/MyCrawler' },
        });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-crawler', 'L', 'AWS::Glue::Crawler');
    expect(result).toMatchObject({
      Name: 'my-crawler',
      Role: 'arn:aws:iam::123456789012:role/GlueCrawlerRole',
      Targets: { S3Targets: [{ Path: 's3://my-bucket/data' }] },
      DatabaseName: 'my-db',
      Description: 'desc',
      // SDK Schedule.{ScheduleExpression,State} -> CFn structured wrapper
      Schedule: { ScheduleExpression: 'cron(0 12 * * ? *)' },
      Classifiers: ['my-classifier'],
      Tags: [{ Key: 'env', Value: 'prod' }],
    });
  });

  it('readCurrentState() reverse-maps SDK DynamoDBTargets scanAll / scanRate to the CFn spelling (#1391)', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetCrawlerCommand) {
        return Promise.resolve({
          Crawler: {
            Name: 'my-crawler',
            Targets: {
              DynamoDBTargets: [{ Path: 'my-table', scanAll: true, scanRate: 0.5 }],
              S3Targets: [{ Path: 's3://my-bucket/data' }],
            },
          },
        });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({ Tags: {} });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-crawler', 'L', 'AWS::Glue::Crawler');
    // Without the reverse map the state-recorded PascalCase keys would read as
    // removed and the SDK's lowercase keys as added — phantom drift on every run.
    expect(result).toMatchObject({
      Targets: {
        DynamoDBTargets: [{ Path: 'my-table', ScanAll: true, ScanRate: 0.5 }],
        S3Targets: [{ Path: 's3://my-bucket/data' }],
      },
    });
  });

  it('readCurrentState() returns undefined when crawler does not exist', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('missing', 'L', 'AWS::Glue::Crawler');
    expect(result).toBeUndefined();
  });

  it('startSchedule() and stopSchedule() call StartCrawlerSchedule / StopCrawlerSchedule', async () => {
    await provider.startSchedule('my-crawler');
    await provider.stopSchedule('my-crawler');

    const startCall = mockSend.mock.calls.find((c) => c[0] instanceof StartCrawlerScheduleCommand);
    const stopCall = mockSend.mock.calls.find((c) => c[0] instanceof StopCrawlerScheduleCommand);
    expect(startCall).toBeDefined();
    expect(stopCall).toBeDefined();
    expect(startCall![0].input).toEqual({ CrawlerName: 'my-crawler' });
    expect(stopCall![0].input).toEqual({ CrawlerName: 'my-crawler' });
  });

  it('handledProperties declares the full mutable surface', () => {
    const set = provider.handledProperties.get('AWS::Glue::Crawler');
    expect(set).toBeDefined();
    expect(set?.has('Name')).toBe(true);
    expect(set?.has('Role')).toBe(true);
    expect(set?.has('Targets')).toBe(true);
    expect(set?.has('Schedule')).toBe(true);
    expect(set?.has('Configuration')).toBe(true);
    expect(set?.has('Tags')).toBe(true);
  });
});
