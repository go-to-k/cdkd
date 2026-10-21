/**
 * Issue #1160 (absent-field removal), AWS::Glue::Crawler slice.
 *
 * `UpdateCrawler` keeps a field it is not sent. A real CloudFormation A/B
 * showed CloudFormation keeps every removed optional Crawler property too: its
 * handler's `UpdateCrawler` carries only Name, Role and Targets. So cdkd sends
 * no reset. These tests pin that a removed field never reaches the update
 * input, that a present one still does, that the removal-warning declaration
 * covers every property, and that `update()` names the kept properties in its
 * own warning (the shared caller's line would claim a CloudFormation reset).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { TagResourceCommand, UpdateCrawlerCommand } from '@aws-sdk/client-glue';

const mockSend = vi.fn();
const { childWarn } = vi.hoisted(() => ({ childWarn: vi.fn() }));

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
    warn: childWarn,
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
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';
import type { UpdateContext } from '../../../src/types/resource.js';

const CRAWLER = 'AWS::Glue::Crawler';

const REQUIRED = {
  Name: 'crawler',
  Role: 'arn:aws:iam::123456789012:role/glue',
  Targets: { S3Targets: [{ Path: 's3://bucket/data/' }] },
};

/** Every optional property `update()` forwards, each set to a non-default. */
const OPTIONAL = {
  DatabaseName: 'db',
  Description: 'desc',
  Classifiers: ['csv'],
  TablePrefix: 'abp_',
  Schedule: { ScheduleExpression: 'cron(0 12 * * ? *)' },
  SchemaChangePolicy: { UpdateBehavior: 'LOG', DeleteBehavior: 'LOG' },
  RecrawlPolicy: { RecrawlBehavior: 'CRAWL_NEW_FOLDERS_ONLY' },
  LineageConfiguration: { CrawlerLineageSettings: 'ENABLE' },
  LakeFormationConfiguration: { UseLakeFormationCredentials: false, AccountId: '123456789012' },
  Configuration: '{"Version":1.0}',
  CrawlerSecurityConfiguration: 'sec',
};

const PREVIOUS = { ...REQUIRED, ...OPTIONAL };

/** What `UpdateCrawler` carries for {@link REQUIRED} alone. */
const REQUIRED_INPUT = {
  Name: 'crawler',
  Role: REQUIRED.Role,
  Targets: { S3Targets: [{ Path: 's3://bucket/data/' }] },
};

/** The single UpdateCrawler sent, by its input. */
function sentUpdate(): Record<string, unknown> {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateCrawlerCommand);
  expect(calls).toHaveLength(1);
  return (calls[0]![0] as { input: Record<string, unknown> }).input;
}

/** Runs the update the way the deploy engine does: removal prep, then update(). */
async function deployUpdate(
  provider: GlueCrawlerProvider,
  desired: Record<string, unknown>,
  previous: Record<string, unknown>,
  extra: Partial<UpdateContext> = {}
): Promise<readonly string[]> {
  const prep = prepareRemovalForUpdate(provider, CRAWLER, desired, previous);
  await provider.update('MyCrawler', 'crawler', CRAWLER, prep.properties, previous, {
    ...prep.context,
    ...extra,
  });
  return prep.unhandled;
}

describe('GlueCrawlerProvider removal (#1160)', () => {
  let provider: GlueCrawlerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new GlueCrawlerProvider();
  });

  it('declares no removalDefaults: CloudFormation keeps every removed property, so nothing is reset', () => {
    expect(provider).not.toHaveProperty('removalDefaults');
  });

  it('removalHandledInUpdate covers every handled property, so the shared caller warns about none', () => {
    expect([...provider.removalHandledInUpdate.get(CRAWLER)!].sort()).toEqual(
      [...provider.handledProperties.get(CRAWLER)!].sort()
    );
  });

  it('every removed optional property is OMITTED from UpdateCrawler and named in ONE warning', async () => {
    const unhandled = await deployUpdate(provider, { ...REQUIRED }, PREVIOUS);

    expect(unhandled).toEqual([]);
    // Exactly the required fields: no previous value carried over, no reset.
    expect(sentUpdate()).toEqual(REQUIRED_INPUT);
    expect(childWarn).toHaveBeenCalledTimes(1);
    // LineageConfiguration is not a CloudFormation property, so a line naming
    // it makes no claim about CloudFormation.
    expect(childWarn).toHaveBeenCalledWith(
      `MyCrawler (AWS::Glue::Crawler): properties ${Object.keys(OPTIONAL).join(', ')} were removed from the template and keep their current AWS value; UpdateCrawler keeps a setting it is not sent. Declare the intended value explicitly to change it.`
    );
  });

  it('a removal of only CloudFormation schema properties says CloudFormation keeps them too', async () => {
    const { LineageConfiguration: _l, ...previous } = PREVIOUS;
    const cfnNames = Object.keys(OPTIONAL).filter((k) => k !== 'LineageConfiguration');
    const unhandled = await deployUpdate(provider, { ...REQUIRED }, previous);

    expect(unhandled).toEqual([]);
    expect(sentUpdate()).toEqual(REQUIRED_INPUT);
    expect(cfnNames).toHaveLength(10);
    expect(childWarn).toHaveBeenCalledTimes(1);
    expect(childWarn).toHaveBeenCalledWith(
      `MyCrawler (AWS::Glue::Crawler): properties ${cfnNames.join(', ')} were removed from the template and keep their current AWS value, as CloudFormation leaves them; UpdateCrawler keeps a setting it is not sent. Declare the intended value explicitly to change it.`
    );
  });

  it('one removed property gets the singular line, and the rest are still sent', async () => {
    const { Schedule: _s, ...desired } = PREVIOUS;
    const unhandled = await deployUpdate(provider, desired, PREVIOUS);

    expect(unhandled).toEqual([]);
    const input = sentUpdate();
    expect(input).not.toHaveProperty('Schedule');
    expect(input).toMatchObject({ Description: 'desc', TablePrefix: 'abp_' });
    expect(childWarn).toHaveBeenCalledTimes(1);
    expect(childWarn).toHaveBeenCalledWith(
      'MyCrawler (AWS::Glue::Crawler): property Schedule was removed from the template and keeps its current AWS value, as CloudFormation leaves it; UpdateCrawler keeps a setting it is not sent. Declare the intended value explicitly to change it.'
    );
  });

  it('a present field is still sent and nothing is warned (the other polarity)', async () => {
    const desired = { ...PREVIOUS, Description: 'new desc', Schedule: { ScheduleExpression: 'cron(0 1 * * ? *)' } };
    const unhandled = await deployUpdate(provider, desired, PREVIOUS);

    expect(unhandled).toEqual([]);
    expect(sentUpdate()).toMatchObject({
      ...REQUIRED_INPUT,
      Description: 'new desc',
      Schedule: 'cron(0 1 * * ? *)',
      Classifiers: ['csv'],
    });
    expect(childWarn).not.toHaveBeenCalled();
  });

  it('a property the previous template never declared is not named', async () => {
    const unhandled = await deployUpdate(provider, { ...REQUIRED }, { ...REQUIRED });

    expect(unhandled).toEqual([]);
    expect(sentUpdate()).toEqual(REQUIRED_INPUT);
    expect(childWarn).not.toHaveBeenCalled();
  });

  it('a rollback revert says the failed deploy ADDED the property', async () => {
    const { Description: _d, ...desired } = PREVIOUS;
    await deployUpdate(provider, desired, PREVIOUS, { replayingState: true });

    expect(childWarn).toHaveBeenCalledTimes(1);
    expect(childWarn).toHaveBeenCalledWith(
      'MyCrawler (AWS::Glue::Crawler): property Description is absent from the state being restored; UpdateCrawler keeps a setting it is not sent, so the rollback leaves the value the failed deploy applied in place.'
    );
  });

  it('drift --revert (an AWS-readback previous side) warns about nothing', async () => {
    const { Description: _d, ...desired } = PREVIOUS;
    await deployUpdate(provider, desired, PREVIOUS, { desiredFromAwsReadback: true });

    expect(sentUpdate()).not.toHaveProperty('Description');
    expect(childWarn).not.toHaveBeenCalled();
  });

  it('a direct call without the caller context still names the removal (previous-template fallback)', async () => {
    const { TablePrefix: _t, ...desired } = PREVIOUS;
    await provider.update('MyCrawler', 'crawler', CRAWLER, desired, PREVIOUS);

    expect(sentUpdate()).not.toHaveProperty('TablePrefix');
    expect(childWarn).toHaveBeenCalledTimes(1);
    expect(childWarn.mock.calls[0]![0]).toContain('property TablePrefix was removed');
  });

  it('a failed update warns about nothing (the line follows success only)', async () => {
    mockSend.mockImplementation((cmd) =>
      cmd instanceof UpdateCrawlerCommand
        ? Promise.reject(new Error('AccessDenied'))
        : Promise.resolve({})
    );

    await expect(deployUpdate(provider, { ...REQUIRED }, PREVIOUS)).rejects.toThrow(
      'Failed to update Glue Crawler MyCrawler'
    );
    expect(childWarn).not.toHaveBeenCalled();
  });

  it('a failed tag update after UpdateCrawler warns about nothing either', async () => {
    mockSend.mockImplementation((cmd) =>
      cmd instanceof TagResourceCommand
        ? Promise.reject(new Error('AccessDenied'))
        : Promise.resolve({})
    );

    await expect(
      deployUpdate(provider, { ...REQUIRED, Tags: { team: 'b' } }, { ...PREVIOUS, Tags: { team: 'a' } })
    ).rejects.toThrow('Failed to update Glue Crawler MyCrawler');
    expect(childWarn).not.toHaveBeenCalled();
  });

  it('a removal outside the declaration is still reported (the declaration is live)', () => {
    const prep = prepareRemovalForUpdate(
      provider,
      CRAWLER,
      { ...REQUIRED },
      { ...REQUIRED, NotACrawlerProperty: 'x' }
    );
    expect(prep.unhandled).toEqual(['NotACrawlerProperty']);
  });
});
