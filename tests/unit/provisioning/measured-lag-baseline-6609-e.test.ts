/**
 * go-to-k/cdkd#6609 slice E: the `Tags` drift baseline the deploy captures
 * right after an UPDATE's own tag call, for the reads that measured a lag
 * (us-east-1, 2026-11-20): DynamoDB `ListTagsOfResource` answered the
 * previous tags for up to ~2.5 s after a tag / untag (table and GlobalTable
 * replica), and Secrets Manager `DescribeSecret` missed a just-written tag on
 * single reads. The capture re-reads until the declared tags show, and keeps
 * the declared tags otherwise; every other read takes the first answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  PolicyNotFoundException,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DescribeSecretCommand,
  TagResourceCommand as SmTagResourceCommand,
  UntagResourceCommand as SmUntagResourceCommand,
  UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';

const { ddbSend, regionalSend, smSend, childLogger } = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  regionalSend: vi.fn(),
  smSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: ddbSend, config: { region: () => Promise.resolve('us-east-1') } },
    secretsManager: { send: smSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// A GlobalTable's cross-region replica is read through its own regional client.
vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: cfg?.region === 'eu-west-1' ? regionalSend : ddbSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';
import {
  clearTagWrites,
  declaredTagsReadback,
  recordTagWrite,
  TAGS_BASELINE_REREAD_DELAYS_MS,
  takeTagWrite,
  tagsMatchDeclared,
} from '../../../src/provisioning/tags-own-write-baseline.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

type Tag = { Key: string; Value: string };
const t = (Key: string, Value: string): Tag => ({ Key, Value });
const OLD = [t('env', 'old'), t('aws:cdk:path', 'S/T/Resource')];
const NEW = [t('env', 'new'), t('aws:cdk:path', 'S/T/Resource')];
const DECLARED_NEW = [t('env', 'new')];
const AFTER = { afterOwnWrite: true } as const;
const ZERO = [0, 0, 0, 0];

const throttle = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 400 },
  });
const denied = (): Error =>
  Object.assign(new Error('not authorized'), {
    name: 'AccessDeniedException',
    $metadata: { httpStatusCode: 400 },
  });

/** Successive answers (an Error is thrown); the last one repeats. */
function queue(answers: Array<Tag[] | Error>): () => Promise<Tag[]> {
  let i = 0;
  return () => {
    const answer = answers[Math.min(i, answers.length - 1)]!;
    i += 1;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
}

const sentOf = (fn: ReturnType<typeof vi.fn>, ctor: { name: string }): number =>
  fn.mock.calls.filter(([cmd]) => (cmd as object).constructor.name === ctor.name).length;

const warnings = (): string[] => childLogger.warn.mock.calls.map(([m]) => String(m));

const UNSETTLED_WARNING =
  /^(\S+) (\S+): the read right after the write never showed the declared Tags, so its drift baseline may not match the live resource; run .*cdkd state refresh-observed.* on the stack to re-capture it$/;

function expectOneValueFreeWarning(resourceType: string, logicalId: string): void {
  const all = warnings();
  expect(all).toHaveLength(1);
  const m = UNSETTLED_WARNING.exec(all[0]!);
  expect(m?.slice(1, 3)).toEqual([resourceType, logicalId]);
  for (const value of ['old', 'new', 'env']) expect(all[0]).not.toContain(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTagWrites('AWS::DynamoDB::Table', () => true);
  clearTagWrites('AWS::DynamoDB::GlobalTable', () => true);
  clearTagWrites('AWS::SecretsManager::Secret', () => true);
});

describe('the shared comparator and declared shape', () => {
  it('the measured-lag schedule is five reads, 7.5 s at most', () => {
    expect(TAGS_BASELINE_REREAD_DELAYS_MS).toEqual([500, 1000, 2000, 4000]);
  });

  it('matches an exact key/value set in any order, aws: keys ignored on both sides', () => {
    const declared = [t('a', '1'), t('b', '2')];
    expect(tagsMatchDeclared([t('b', '2'), t('aws:x', 'y'), t('a', '1')], declared)).toBe(true);
    expect(tagsMatchDeclared([t('a', '1')], declared)).toBe(false);
    expect(tagsMatchDeclared([t('a', '1'), t('b', '2'), t('c', '3')], declared)).toBe(false);
    expect(tagsMatchDeclared([t('a', '1'), t('b', 'x')], declared)).toBe(false);
    expect(tagsMatchDeclared([], [])).toBe(true);
    expect(tagsMatchDeclared([t('aws:x', 'y')], [])).toBe(true);
    expect(tagsMatchDeclared(undefined, [])).toBe(false);
    expect(tagsMatchDeclared(RESOURCE_NOT_FOUND, [])).toBe(false);
  });

  it('builds the declared tags in the read shape: last key wins, values as strings, no aws: keys', () => {
    expect(
      declaredTagsReadback([
        { Key: 'n', Value: 3 },
        { Key: 'k', Value: 'a' },
        { Key: 'aws:cdk:path', Value: 'p' },
        { Key: 'k', Value: 'b' },
      ])
    ).toEqual([t('n', '3'), t('k', 'b')]);
    expect(declaredTagsReadback(undefined)).toEqual([]);
    expect(declaredTagsReadback('nope')).toBeUndefined();
    expect(declaredTagsReadback([{ Key: '', Value: 'x' }])).toBeUndefined();
  });

  it('a note is consumed once, and a clear drops only the notes it owns', () => {
    recordTagWrite('AWS::SecretsManager::Secret', 'arn-a');
    recordTagWrite('AWS::SecretsManager::Secret', 'arn-b');
    recordTagWrite('AWS::DynamoDB::Table', 'arn-a');
    clearTagWrites('AWS::SecretsManager::Secret', (id) => id === 'arn-a');
    expect(takeTagWrite('AWS::SecretsManager::Secret', 'arn-a')).toBe(false);
    expect(takeTagWrite('AWS::SecretsManager::Secret', 'arn-b')).toBe(true);
    expect(takeTagWrite('AWS::SecretsManager::Secret', 'arn-b')).toBe(false);
    expect(takeTagWrite('AWS::DynamoDB::Table', 'arn-a')).toBe(true);
  });
});

// ---------------------------------------------------------------- DynamoDB Table

const TABLE = 'tbl-6609e';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:111111111111:table/${TABLE}`;
const TABLE_TYPE = 'AWS::DynamoDB::Table';

function tableProps(tags: unknown): Record<string, unknown> {
  return {
    TableName: TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    ...(tags === undefined ? {} : { Tags: tags }),
  };
}

function primeTable(answers: Array<Tag[] | Error>): void {
  const next = queue(answers);
  ddbSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: {
          TableName: TABLE,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        },
      });
    }
    if (cmd instanceof ListTagsOfResourceCommand) return next().then((Tags) => ({ Tags }));
    return Promise.resolve({});
  });
}

describe('AWS::DynamoDB::Table Tags baseline after its own tag call', () => {
  let provider: DynamoDBTableProvider;
  const tagReads = (): number => sentOf(ddbSend, ListTagsOfResourceCommand);
  const read = (props: Record<string, unknown>, context?: { afterOwnWrite: true }) =>
    provider.readCurrentState(TABLE, 'Tbl', TABLE_TYPE, props, context);
  const tagsOf = async (p: ReturnType<typeof read>): Promise<unknown> =>
    ((await p) as Record<string, unknown>)['Tags'];

  beforeEach(() => {
    provider = new DynamoDBTableProvider();
    (provider as unknown as { tagsBaselineRereadDelaysMs: number[] }).tagsBaselineRereadDelaysMs =
      ZERO;
  });

  it('records a note only when the update sent a tag call', async () => {
    primeTable([[]]);
    await provider.applyTagDiff(TABLE_ARN, TABLE_TYPE, 'Tbl', DECLARED_NEW, DECLARED_NEW);
    expect(takeTagWrite(TABLE_TYPE, TABLE_ARN)).toBe(false);
    await provider.applyTagDiff(TABLE_ARN, TABLE_TYPE, 'Tbl', [t('env', 'old')], DECLARED_NEW);
    expect(sentOf(ddbSend, TagResourceCommand)).toBe(1);
    expect(takeTagWrite(TABLE_TYPE, TABLE_ARN)).toBe(true);
    await provider.applyTagDiff(TABLE_ARN, TABLE_TYPE, 'Tbl', [t('env', 'old')], []);
    expect(sentOf(ddbSend, UntagResourceCommand)).toBe(1);
    expect(takeTagWrite(TABLE_TYPE, TABLE_ARN)).toBe(true);
  });

  it('a first answer that is the declared set settles with one read', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([NEW]);
    expect(await tagsOf(read(tableProps(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(tagReads()).toBe(1);
    expect(warnings()).toEqual([]);
  });

  it('a lagging tag (previous value) is re-read until the new one shows', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([OLD, OLD, NEW]);
    expect(await tagsOf(read(tableProps(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(tagReads()).toBe(3);
    expect(warnings()).toEqual([]);
  });

  it('a lagging untag (the removed tag still listed) is re-read until it is gone', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([[t('env', 'old'), t('gone', 'x')], [t('env', 'old')]]);
    expect(await tagsOf(read(tableProps([t('env', 'old')]), AFTER))).toEqual([t('env', 'old')]);
    expect(tagReads()).toBe(2);
  });

  it('every tag removed: settles on none once the old tags stop showing', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([OLD, [t('aws:cdk:path', 'S/T/Resource')]]);
    expect(await tagsOf(read(tableProps(undefined), AFTER))).toEqual([]);
    expect(tagReads()).toBe(2);
  });

  it('a flapping answer settles on its first match', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([OLD, NEW, OLD]);
    expect(await tagsOf(read(tableProps(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(tagReads()).toBe(2);
  });

  it('a schedule spent keeps the declared tags in the read shape, with a value-free warning', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([OLD]);
    const declared = [{ Key: 'env', Value: 'new' }, { Key: 'n', Value: 7 }, t('aws:x', 'y')];
    expect(await tagsOf(read(tableProps(declared), AFTER))).toEqual([
      t('env', 'new'),
      t('n', '7'),
    ]);
    expect(tagReads()).toBe(5);
    expectOneValueFreeWarning(TABLE_TYPE, 'Tbl');
  });

  it('no note (the update left the tags alone): one read, the answer as given', async () => {
    primeTable([OLD, NEW]);
    expect(await tagsOf(read(tableProps(DECLARED_NEW), AFTER))).toEqual([t('env', 'old')]);
    expect(tagReads()).toBe(1);
    expect(warnings()).toEqual([]);
  });

  it('no capture context (drift, import, refresh): one read, and the note is not consumed', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([OLD, NEW]);
    expect(await tagsOf(read(tableProps(DECLARED_NEW)))).toEqual([t('env', 'old')]);
    expect(tagReads()).toBe(1);
  });

  it('the note is consumed by the capture: a second capture takes one read', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([NEW]);
    await read(tableProps(DECLARED_NEW), AFTER);
    primeTable([OLD]);
    ddbSend.mockClear();
    expect(await tagsOf(read(tableProps(DECLARED_NEW), AFTER))).toEqual([t('env', 'old')]);
    expect(tagReads()).toBe(1);
  });

  it('a deterministic first failure throws as before; a transient one keeps the declared tags', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([denied()]);
    await expect(read(tableProps(DECLARED_NEW), AFTER)).rejects.toThrow('not authorized');
    expect(tagReads()).toBe(1);

    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    ddbSend.mockClear();
    primeTable([throttle()]);
    expect(await tagsOf(read(tableProps(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(tagReads()).toBe(1);
    expectOneValueFreeWarning(TABLE_TYPE, 'Tbl');
  });

  it('a re-read that throws ends the schedule and keeps the declared tags', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    primeTable([OLD, denied(), NEW]);
    expect(await tagsOf(read(tableProps(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(tagReads()).toBe(2);
    expectOneValueFreeWarning(TABLE_TYPE, 'Tbl');
  });

  it('a table gone under the first read is still RESOURCE_NOT_FOUND', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    const { ResourceNotFoundException } = await import('@aws-sdk/client-dynamodb');
    primeTable([new ResourceNotFoundException({ message: 'gone', $metadata: {} })]);
    expect(await read(tableProps(DECLARED_NEW), AFTER)).toBe(RESOURCE_NOT_FOUND);
    expect(tagReads()).toBe(1);
  });

  it("an update drops a note an earlier failed update left, before any call", async () => {
    // A note no capture consumed (the update that made it threw).
    recordTagWrite(TABLE_TYPE, TABLE_ARN);
    const otherTable = 'arn:aws:dynamodb:us-east-1:111111111111:table/other';
    recordTagWrite(TABLE_TYPE, otherTable);
    ddbSend.mockRejectedValue(denied());
    await expect(
      provider.update('Tbl', TABLE, TABLE_TYPE, tableProps(DECLARED_NEW), tableProps(DECLARED_NEW))
    ).rejects.toThrow();
    expect(takeTagWrite(TABLE_TYPE, TABLE_ARN)).toBe(false);
    expect(takeTagWrite(TABLE_TYPE, otherTable)).toBe(true);
  });
});

// ------------------------------------------------------------ Secrets Manager

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:s-6609e-AbCdEf';
const SECRET_TYPE = 'AWS::SecretsManager::Secret';

function primeSecret(answers: Array<Tag[] | Error>): void {
  const next = queue(answers);
  smSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeSecretCommand) {
      return next().then((Tags) => ({ ARN: SECRET_ARN, Name: 's-6609e', Tags }));
    }
    return Promise.resolve({});
  });
}

describe('AWS::SecretsManager::Secret Tags baseline after its own tag call', () => {
  let provider: SecretsManagerSecretProvider;
  const reads = (): number => sentOf(smSend, DescribeSecretCommand);
  const props = (tags: unknown): Record<string, unknown> => ({
    Name: 's-6609e',
    ...(tags === undefined ? {} : { Tags: tags }),
  });
  const read = (p: Record<string, unknown>, context?: { afterOwnWrite: true }) =>
    provider.readCurrentState(SECRET_ARN, 'Sec', SECRET_TYPE, p, context);
  const tagsOf = async (p: ReturnType<typeof read>): Promise<unknown> =>
    ((await p) as Record<string, unknown>)['Tags'];

  beforeEach(() => {
    provider = new SecretsManagerSecretProvider();
    provider.tagsBaselineRereadDelaysMs = ZERO;
  });

  it('the update records a note only when it sent a tag call', async () => {
    primeSecret([[]]);
    await provider.update('Sec', SECRET_ARN, SECRET_TYPE, props(DECLARED_NEW), props(DECLARED_NEW));
    expect(takeTagWrite(SECRET_TYPE, SECRET_ARN)).toBe(false);
    await provider.update('Sec', SECRET_ARN, SECRET_TYPE, props(DECLARED_NEW), props(undefined));
    expect(sentOf(smSend, SmTagResourceCommand)).toBe(1);
    expect(takeTagWrite(SECRET_TYPE, SECRET_ARN)).toBe(true);
    await provider.update('Sec', SECRET_ARN, SECRET_TYPE, props(undefined), props(DECLARED_NEW));
    expect(sentOf(smSend, SmUntagResourceCommand)).toBe(1);
    expect(takeTagWrite(SECRET_TYPE, SECRET_ARN)).toBe(true);
  });

  it('an update that sends no tag call drops a note an earlier failed update left', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    recordTagWrite(SECRET_TYPE, `${SECRET_ARN}-other`);
    primeSecret([[]]);
    await provider.update('Sec', SECRET_ARN, SECRET_TYPE, props(DECLARED_NEW), props(DECLARED_NEW));
    expect(sentOf(smSend, UpdateSecretCommand)).toBe(1);
    expect(takeTagWrite(SECRET_TYPE, SECRET_ARN)).toBe(false);
    expect(takeTagWrite(SECRET_TYPE, `${SECRET_ARN}-other`)).toBe(true);
  });

  it('a first answer that is the declared set settles with the one DescribeSecret', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    primeSecret([NEW]);
    expect(await tagsOf(read(props(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(reads()).toBe(1);
  });

  it('a single missed read (the measured blip) settles on the next match', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    primeSecret([[], NEW]);
    expect(await tagsOf(read(props(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(reads()).toBe(2);
  });

  it('a previous value is re-read in both directions (tag and untag)', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    primeSecret([OLD, OLD, NEW]);
    expect(await tagsOf(read(props(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(reads()).toBe(3);

    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    smSend.mockClear();
    primeSecret([NEW, []]);
    expect(await tagsOf(read(props(undefined), AFTER))).toEqual([]);
    expect(reads()).toBe(2);
  });

  it('a flapping answer (new, none, new) settles on its first match', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    primeSecret([NEW, [], NEW]);
    expect(await tagsOf(read(props(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(reads()).toBe(1);
  });

  it('a schedule spent keeps the declared tags, with a value-free warning', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    primeSecret([OLD]);
    expect(await tagsOf(read(props(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(reads()).toBe(5);
    expectOneValueFreeWarning(SECRET_TYPE, 'Sec');
  });

  it('no note: one read, the answer as given', async () => {
    primeSecret([OLD, NEW]);
    expect(await tagsOf(read(props(DECLARED_NEW), AFTER))).toEqual([t('env', 'old')]);
    expect(reads()).toBe(1);
  });

  it('no capture context: one read', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    primeSecret([OLD, NEW]);
    expect(await tagsOf(read(props(DECLARED_NEW)))).toEqual([t('env', 'old')]);
    expect(reads()).toBe(1);
  });

  it('a deterministic first failure throws as before; a re-read failure keeps the declared tags', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    primeSecret([denied()]);
    await expect(read(props(DECLARED_NEW), AFTER)).rejects.toThrow('not authorized');
    expect(reads()).toBe(1);

    recordTagWrite(SECRET_TYPE, SECRET_ARN);
    smSend.mockClear();
    primeSecret([OLD, throttle(), NEW]);
    expect(await tagsOf(read(props(DECLARED_NEW), AFTER))).toEqual(DECLARED_NEW);
    expect(reads()).toBe(2);
    expectOneValueFreeWarning(SECRET_TYPE, 'Sec');
  });
});

// ---------------------------------------------------- DynamoDB GlobalTable replica

const GT = 'gt-6609e';
const GT_TYPE = 'AWS::DynamoDB::GlobalTable';
const LOCAL_ARN = `arn:aws:dynamodb:us-east-1:111111111111:table/${GT}`;
const REMOTE_ARN = `arn:aws:dynamodb:eu-west-1:111111111111:table/${GT}`;

const regionDouble =
  (arn: string, tags: () => Promise<Tag[]>, table: Record<string, unknown>) =>
  (cmd: unknown): Promise<unknown> => {
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: { TableName: GT, TableArn: arn, TableStatus: 'ACTIVE', ...table },
      });
    }
    if (cmd instanceof ListTagsOfResourceCommand) return tags().then((Tags) => ({ Tags }));
    if (cmd instanceof DescribeContinuousBackupsCommand) {
      return Promise.resolve({
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
        },
      });
    }
    if (cmd instanceof DescribeContributorInsightsCommand) {
      return Promise.resolve({ ContributorInsightsStatus: 'DISABLED' });
    }
    if (cmd instanceof DescribeKinesisStreamingDestinationCommand) {
      return Promise.resolve({ KinesisDataStreamDestinations: [] });
    }
    if (cmd instanceof DescribeTimeToLiveCommand) {
      return Promise.resolve({ TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } });
    }
    if (cmd instanceof GetResourcePolicyCommand) {
      return Promise.reject(new PolicyNotFoundException({ message: 'none', $metadata: {} }));
    }
    return Promise.resolve({});
  };

function primeGlobalTable(remote: Array<Tag[] | Error>): void {
  ddbSend.mockImplementation(
    regionDouble(LOCAL_ARN, () => Promise.resolve([]), {
      Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }],
    })
  );
  regionalSend.mockImplementation(regionDouble(REMOTE_ARN, queue(remote), {}));
}

describe('AWS::DynamoDB::GlobalTable replica Tags baseline after its own tag call', () => {
  let provider: DynamoDBGlobalTableProvider;
  const remoteTagReads = (): number => sentOf(regionalSend, ListTagsOfResourceCommand);
  const props = (tags: unknown): Record<string, unknown> => ({
    TableName: GT,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1', ...(tags ? { Tags: tags } : {}) }],
  });
  const remoteTags = async (context?: { afterOwnWrite: true }): Promise<unknown> => {
    const bag = (await provider.readCurrentState(GT, 'Gt', GT_TYPE, props(DECLARED_NEW), context)) as
      | Record<string, unknown>;
    return (bag['Replicas'] as Array<Record<string, unknown>>).find(
      (r) => r['Region'] === 'eu-west-1'
    )?.['Tags'];
  };

  beforeEach(() => {
    provider = new DynamoDBGlobalTableProvider();
    provider.tagsBaselineRereadDelaysMs = ZERO;
  });

  it('the cross-region tag call records a note for that replica', async () => {
    regionalSend.mockResolvedValue({});
    await provider.applyCrossRegionReplicaTagsDiff(
      LOCAL_ARN,
      'eu-west-1',
      [t('env', 'old')],
      DECLARED_NEW,
      GT_TYPE,
      'Gt',
      GT
    );
    expect(sentOf(regionalSend, TagResourceCommand)).toBe(1);
    expect(takeTagWrite(GT_TYPE, REMOTE_ARN)).toBe(true);
    expect(takeTagWrite(GT_TYPE, LOCAL_ARN)).toBe(false);
  });

  it('an update drops every replica note an earlier failed update left, before any call', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN);
    recordTagWrite(GT_TYPE, LOCAL_ARN);
    const other = 'arn:aws:dynamodb:eu-west-1:111111111111:table/other';
    recordTagWrite(GT_TYPE, other);
    ddbSend.mockRejectedValue(denied());
    regionalSend.mockRejectedValue(denied());
    await expect(
      provider.update('Gt', GT, GT_TYPE, props(DECLARED_NEW), props(DECLARED_NEW))
    ).rejects.toThrow();
    expect(takeTagWrite(GT_TYPE, REMOTE_ARN)).toBe(false);
    expect(takeTagWrite(GT_TYPE, LOCAL_ARN)).toBe(false);
    expect(takeTagWrite(GT_TYPE, other)).toBe(true);
  });

  it('settles a lagging replica on its declared tags', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN);
    primeGlobalTable([OLD, NEW]);
    expect(await remoteTags(AFTER)).toEqual(DECLARED_NEW);
    expect(remoteTagReads()).toBe(2);
  });

  it('a first match settles with one read', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN);
    primeGlobalTable([NEW]);
    expect(await remoteTags(AFTER)).toEqual(DECLARED_NEW);
    expect(remoteTagReads()).toBe(1);
  });

  it('a schedule spent keeps the declared tags, with a value-free warning', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN);
    primeGlobalTable([OLD]);
    expect(await remoteTags(AFTER)).toEqual(DECLARED_NEW);
    expect(remoteTagReads()).toBe(5);
    expectOneValueFreeWarning(GT_TYPE, 'Gt');
  });

  it('no note, or no capture context: one read, the answer as given', async () => {
    primeGlobalTable([OLD, NEW]);
    expect(await remoteTags(AFTER)).toEqual([t('env', 'old')]);
    expect(remoteTagReads()).toBe(1);

    recordTagWrite(GT_TYPE, REMOTE_ARN);
    regionalSend.mockClear();
    primeGlobalTable([OLD, NEW]);
    expect(await remoteTags()).toEqual([t('env', 'old')]);
    expect(remoteTagReads()).toBe(1);
  });

  it('a transient first failure keeps the declared tags; a deterministic one reads as before', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN);
    primeGlobalTable([throttle()]);
    expect(await remoteTags(AFTER)).toEqual(DECLARED_NEW);
    expect(remoteTagReads()).toBe(1);

    recordTagWrite(GT_TYPE, REMOTE_ARN);
    regionalSend.mockClear();
    childLogger.warn.mockClear();
    primeGlobalTable([denied()]);
    // The pre-#6609 handling of a failed replica tag read: warn, record none.
    expect(await remoteTags(AFTER)).toEqual([]);
    expect(remoteTagReads()).toBe(1);
  });
});
