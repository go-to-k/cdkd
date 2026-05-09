import { describe, it, expect, vi, beforeEach } from 'vitest';
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
