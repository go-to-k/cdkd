/**
 * go-to-k/cdkd#6609 slice E: the `Tags` drift baseline the deploy captures
 * right after its own tag call, for the reads that measured a lag (us-east-1,
 * 2026-11-20): DynamoDB `ListTagsOfResource` answered the previous tags for up
 * to ~2.5 s after a tag / untag (table and GlobalTable replica), and Secrets
 * Manager `DescribeSecret` missed a just-written tag on single reads.
 *
 * The tags are DIFF-applied, so the note holds exactly what the calls that
 * succeeded wrote. The capture re-reads until those keys show; a tag the
 * update never touched (one outside the template) is always kept as read, and
 * an answer that never settles is recorded with the written keys overlaid.
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
  ResourceNotFoundException,
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
    child: vi.fn((): unknown => childLogger),
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
    DynamoDBClient: vi.fn((cfg: { region?: string } | undefined) => ({
      send: cfg?.region === 'eu-west-1' ? regionalSend : ddbSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
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
  isDynamoDBTableArnIn,
  overlayTagWrite,
  recordTagWrite,
  TAGS_BASELINE_REREAD_DELAYS_MS,
  type TagWrite,
  tagsMatchDeclared,
  tagsShowWrite,
  takeTagWrite,
} from '../../../src/provisioning/tags-own-write-baseline.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

type Tag = { Key: string; Value: string };
const t = (Key: string, Value: string): Tag => ({ Key, Value });
const CDK = t('aws:cdk:path', 'S/T/Resource');
/** A tag outside the template (an auto-tagger's) that no update touches. */
const AUTO = t('auto', 'x');
const OLD = [t('env', 'old'), AUTO, CDK];
const NEW = [t('env', 'new'), AUTO, CDK];
/** The comparator sorts every `{Key}` list, and so do these checks. */
const sorted = (tags: unknown): unknown =>
  Array.isArray(tags) ? [...(tags as Tag[])].sort((a, b) => a.Key.localeCompare(b.Key)) : tags;
const READ_OLD = sorted([t('env', 'old'), AUTO]);
const READ_NEW = sorted([t('env', 'new'), AUTO]);
const SET_NEW: Array<[string, string]> = [['env', 'new']];
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
  /^(\S+) (\S+): the read right after the write never showed Tags as the write left it \(a declared value missing, or a removed one still present\), so its drift baseline may not match the live resource; run .*cdkd state refresh-observed.* on the stack to re-capture it$/;

function expectOneValueFreeWarning(resourceType: string, logicalId: string): void {
  const all = warnings();
  expect(all).toHaveLength(1);
  const m = UNSETTLED_WARNING.exec(all[0]!);
  expect(m?.slice(1, 3)).toEqual([resourceType, logicalId]);
  for (const value of ['old', 'new', 'env', 'auto']) expect(all[0]).not.toContain(value);
}

const writeOf = (set: Array<[string, string]>, removed: string[] = []): TagWrite => ({
  set: new Map(set),
  removed: new Set(removed),
});
const asPlain = (w: TagWrite | undefined) =>
  w === undefined ? undefined : { set: [...w.set], removed: [...w.removed] };

beforeEach(() => {
  vi.clearAllMocks();
  ddbSend.mockReset();
  regionalSend.mockReset();
  smSend.mockReset();
  for (const type of [
    'AWS::DynamoDB::Table',
    'AWS::DynamoDB::GlobalTable',
    'AWS::SecretsManager::Secret',
  ]) {
    clearTagWrites(type, () => true);
  }
});

describe('the shared write note and comparator', () => {
  it('the measured-lag schedule is five reads, 7.5 s at most', () => {
    expect(TAGS_BASELINE_REREAD_DELAYS_MS).toEqual([500, 1000, 2000, 4000]);
  });

  it('settles on the written keys alone: other keys, a tag outside the template included, are ignored', () => {
    const w = writeOf([['env', 'new']], ['gone']);
    expect(tagsShowWrite([t('env', 'new'), AUTO], w)).toBe(true);
    expect(tagsShowWrite([t('env', 'new')], w)).toBe(true);
    expect(tagsShowWrite([t('env', 'old'), AUTO], w)).toBe(false);
    expect(tagsShowWrite([t('env', 'new'), t('gone', 'x')], w)).toBe(false);
    expect(tagsShowWrite([AUTO], w)).toBe(false);
    expect(tagsShowWrite(RESOURCE_NOT_FOUND, w)).toBe(false);
  });

  it('overlays only the written keys, keeping every other tag as read', () => {
    const w = writeOf([['env', 'new'], ['added', '1']], ['gone']);
    expect(overlayTagWrite([t('env', 'old'), t('gone', 'x'), AUTO], w)).toEqual([
      t('env', 'new'),
      AUTO,
      t('added', '1'),
    ]);
  });

  it('accumulates one update’s calls per key; a note is consumed once', () => {
    recordTagWrite('AWS::SecretsManager::Secret', 'arn-a', [], ['k', 'gone']);
    recordTagWrite('AWS::SecretsManager::Secret', 'arn-a', [['k', 'v']], []);
    expect(asPlain(takeTagWrite('AWS::SecretsManager::Secret', 'arn-a'))).toEqual({
      set: [['k', 'v']],
      removed: ['gone'],
    });
    expect(takeTagWrite('AWS::SecretsManager::Secret', 'arn-a')).toBeUndefined();
  });

  it('a clear drops only the notes it owns', () => {
    recordTagWrite('AWS::SecretsManager::Secret', 'arn-a', SET_NEW, []);
    recordTagWrite('AWS::SecretsManager::Secret', 'arn-b', SET_NEW, []);
    recordTagWrite('AWS::DynamoDB::Table', 'arn-a', SET_NEW, []);
    clearTagWrites('AWS::SecretsManager::Secret', (id) => id === 'arn-a');
    expect(takeTagWrite('AWS::SecretsManager::Secret', 'arn-a')).toBeUndefined();
    expect(takeTagWrite('AWS::SecretsManager::Secret', 'arn-b')).toBeDefined();
    expect(takeTagWrite('AWS::DynamoDB::Table', 'arn-a')).toBeDefined();
  });

  it('owns a table ARN by name AND region', () => {
    const regions = new Set(['us-east-1']);
    expect(isDynamoDBTableArnIn('arn:aws:dynamodb:us-east-1:1:table/t', 't', regions)).toBe(true);
    expect(isDynamoDBTableArnIn('arn:aws:dynamodb:eu-west-1:1:table/t', 't', regions)).toBe(false);
    expect(isDynamoDBTableArnIn('arn:aws:dynamodb:us-east-1:1:table/t2', 't', regions)).toBe(false);
    expect(isDynamoDBTableArnIn('arn:aws:dynamodb:us-east-1:1:table/xt', 't', regions)).toBe(false);
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
    sorted(((await p) as Record<string, unknown>)['Tags']);
  const DECLARED = [t('env', 'new')];

  beforeEach(() => {
    provider = new DynamoDBTableProvider();
    (provider as unknown as { tagsBaselineRereadDelaysMs: number[] }).tagsBaselineRereadDelaysMs =
      ZERO;
  });

  it('notes exactly what the tag calls wrote, and nothing for a no-op diff', async () => {
    primeTable([[]]);
    await provider.applyTagDiff(TABLE_ARN, TABLE_TYPE, 'Tbl', DECLARED, DECLARED);
    expect(takeTagWrite(TABLE_TYPE, TABLE_ARN)).toBeUndefined();
    await provider.applyTagDiff(
      TABLE_ARN,
      TABLE_TYPE,
      'Tbl',
      [t('env', 'old'), t('gone', 'x')],
      DECLARED
    );
    expect(sentOf(ddbSend, TagResourceCommand)).toBe(1);
    expect(sentOf(ddbSend, UntagResourceCommand)).toBe(1);
    expect(asPlain(takeTagWrite(TABLE_TYPE, TABLE_ARN))).toEqual({
      set: [['env', 'new']],
      removed: ['gone'],
    });
  });

  it('written keys already showing: one read, a tag outside the template kept', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([NEW]);
    expect(await tagsOf(read(tableProps(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(tagReads()).toBe(1);
    expect(warnings()).toEqual([]);
  });

  it('a lagging tag (previous value) is re-read until the written one shows', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([OLD, OLD, NEW]);
    expect(await tagsOf(read(tableProps(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(tagReads()).toBe(3);
    expect(warnings()).toEqual([]);
  });

  it('a lagging untag (the removed tag still listed) is re-read until it is gone', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, [], ['gone']);
    primeTable([[t('env', 'old'), t('gone', 'x'), AUTO], [t('env', 'old'), AUTO]]);
    expect(await tagsOf(read(tableProps([t('env', 'old')]), AFTER))).toEqual(READ_OLD);
    expect(tagReads()).toBe(2);
  });

  it('a flapping answer settles on its first match', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([OLD, NEW, OLD]);
    expect(await tagsOf(read(tableProps(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(tagReads()).toBe(2);
  });

  it('a schedule spent overlays the written keys on the newest answer, keeping the untouched tag', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, ['gone']);
    primeTable([[t('env', 'old'), t('gone', 'x'), AUTO, CDK]]);
    expect(await tagsOf(read(tableProps(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(tagReads()).toBe(5);
    expectOneValueFreeWarning(TABLE_TYPE, 'Tbl');
  });

  it('no note (the update left the tags alone): one read, the answer as given', async () => {
    primeTable([OLD, NEW]);
    expect(await tagsOf(read(tableProps(DECLARED), AFTER))).toEqual(READ_OLD);
    expect(tagReads()).toBe(1);
    expect(warnings()).toEqual([]);
  });

  it('no capture context (drift, import, refresh): one read, and the note is left', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([OLD, NEW]);
    expect(await tagsOf(read(tableProps(DECLARED)))).toEqual(READ_OLD);
    expect(tagReads()).toBe(1);
    expect(takeTagWrite(TABLE_TYPE, TABLE_ARN)).toBeDefined();
  });

  it('a note with an empty desired bag: one read, the live tags', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([OLD, NEW]);
    expect(await tagsOf(read({}, AFTER))).toEqual(READ_OLD);
    expect(tagReads()).toBe(1);
  });

  it('the note is consumed by the capture: a second capture takes one read', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([NEW]);
    await read(tableProps(DECLARED), AFTER);
    ddbSend.mockClear();
    primeTable([OLD]);
    expect(await tagsOf(read(tableProps(DECLARED), AFTER))).toEqual(READ_OLD);
    expect(tagReads()).toBe(1);
  });

  it('a deterministic first failure throws as before', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([denied()]);
    await expect(read(tableProps(DECLARED), AFTER)).rejects.toThrow('not authorized');
    expect(tagReads()).toBe(1);
  });

  it('a transient first failure is re-read; with no answer at all it throws as before', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([throttle(), NEW]);
    expect(await tagsOf(read(tableProps(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(tagReads()).toBe(2);
    expect(warnings()).toEqual([]);

    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    ddbSend.mockClear();
    primeTable([throttle()]);
    await expect(read(tableProps(DECLARED), AFTER)).rejects.toThrow('Rate exceeded');
    expect(tagReads()).toBe(5);
  });

  it('a re-read that throws after an answer ends the schedule and overlays that answer', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([OLD, denied(), NEW]);
    expect(await tagsOf(read(tableProps(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(tagReads()).toBe(2);
    expectOneValueFreeWarning(TABLE_TYPE, 'Tbl');
  });

  it('a table gone under the first read, or under a re-read, is RESOURCE_NOT_FOUND', async () => {
    const gone = () => new ResourceNotFoundException({ message: 'gone', $metadata: {} });
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    primeTable([gone()]);
    expect(await read(tableProps(DECLARED), AFTER)).toBe(RESOURCE_NOT_FOUND);
    expect(tagReads()).toBe(1);

    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    ddbSend.mockClear();
    primeTable([OLD, gone()]);
    expect(await read(tableProps(DECLARED), AFTER)).toBe(RESOURCE_NOT_FOUND);
    expect(tagReads()).toBe(2);
  });

  it('an update drops this table’s stale note before any call, and only this region’s', async () => {
    recordTagWrite(TABLE_TYPE, TABLE_ARN, SET_NEW, []);
    const sameNameElsewhere = `arn:aws:dynamodb:eu-west-1:111111111111:table/${TABLE}`;
    const otherTable = 'arn:aws:dynamodb:us-east-1:111111111111:table/other';
    recordTagWrite(TABLE_TYPE, sameNameElsewhere, SET_NEW, []);
    recordTagWrite(TABLE_TYPE, otherTable, SET_NEW, []);
    ddbSend.mockRejectedValue(denied());
    await expect(
      provider.update('Tbl', TABLE, TABLE_TYPE, tableProps(DECLARED), tableProps(DECLARED))
    ).rejects.toThrow();
    expect(takeTagWrite(TABLE_TYPE, TABLE_ARN)).toBeUndefined();
    expect(takeTagWrite(TABLE_TYPE, sameNameElsewhere)).toBeDefined();
    expect(takeTagWrite(TABLE_TYPE, otherTable)).toBeDefined();
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
    sorted(((await p) as Record<string, unknown>)['Tags']);
  const DECLARED = [t('env', 'new')];

  beforeEach(() => {
    provider = new SecretsManagerSecretProvider();
    provider.tagsBaselineRereadDelaysMs = ZERO;
  });

  it('the update notes exactly what its tag calls wrote', async () => {
    primeSecret([[]]);
    await provider.update('Sec', SECRET_ARN, SECRET_TYPE, props(DECLARED), props(DECLARED));
    expect(takeTagWrite(SECRET_TYPE, SECRET_ARN)).toBeUndefined();
    await provider.update(
      'Sec',
      SECRET_ARN,
      SECRET_TYPE,
      props(DECLARED),
      props([t('env', 'old'), t('gone', 'x')])
    );
    expect(sentOf(smSend, SmTagResourceCommand)).toBe(1);
    expect(sentOf(smSend, SmUntagResourceCommand)).toBe(1);
    expect(asPlain(takeTagWrite(SECRET_TYPE, SECRET_ARN))).toEqual({
      set: [['env', 'new']],
      removed: ['gone'],
    });
  });

  it('an update that sends no tag call drops a stale note for this secret only', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    recordTagWrite(SECRET_TYPE, `${SECRET_ARN}-other`, SET_NEW, []);
    primeSecret([[]]);
    await provider.update('Sec', SECRET_ARN, SECRET_TYPE, props(DECLARED), props(DECLARED));
    expect(sentOf(smSend, UpdateSecretCommand)).toBe(1);
    expect(takeTagWrite(SECRET_TYPE, SECRET_ARN)).toBeUndefined();
    expect(takeTagWrite(SECRET_TYPE, `${SECRET_ARN}-other`)).toBeDefined();
  });

  it('written keys already showing: the one DescribeSecret, a tag outside the template kept', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    primeSecret([NEW]);
    expect(await tagsOf(read(props(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(reads()).toBe(1);
  });

  it('a single missed read (the measured blip) settles on the next match', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    primeSecret([[AUTO], NEW]);
    expect(await tagsOf(read(props(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(reads()).toBe(2);
  });

  it('a previous value is re-read in both directions (tag and untag)', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    primeSecret([OLD, OLD, NEW]);
    expect(await tagsOf(read(props(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(reads()).toBe(3);

    recordTagWrite(SECRET_TYPE, SECRET_ARN, [], ['env']);
    smSend.mockClear();
    primeSecret([NEW, [AUTO]]);
    expect(await tagsOf(read(props(undefined), AFTER))).toEqual([AUTO]);
    expect(reads()).toBe(2);
  });

  it('a flapping answer (new, none, new) settles on its first match', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    primeSecret([NEW, [], NEW]);
    expect(await tagsOf(read(props(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(reads()).toBe(1);
  });

  it('a schedule spent overlays the written keys, keeping the untouched tag, with a value-free warning', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    primeSecret([OLD]);
    expect(await tagsOf(read(props(DECLARED), AFTER))).toEqual(READ_NEW);
    expect(reads()).toBe(5);
    expectOneValueFreeWarning(SECRET_TYPE, 'Sec');
  });

  it('no note: one read, the answer as given', async () => {
    primeSecret([OLD, NEW]);
    expect(await tagsOf(read(props(DECLARED), AFTER))).toEqual(READ_OLD);
    expect(reads()).toBe(1);
  });

  it('no capture context: one read, and the note is left', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    primeSecret([OLD, NEW]);
    expect(await tagsOf(read(props(DECLARED)))).toEqual(READ_OLD);
    expect(reads()).toBe(1);
    expect(takeTagWrite(SECRET_TYPE, SECRET_ARN)).toBeDefined();
  });

  it('a note with an empty desired bag: one read, the live tags', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    primeSecret([OLD, NEW]);
    expect(await tagsOf(read({}, AFTER))).toEqual(READ_OLD);
    expect(reads()).toBe(1);
  });

  it('a first DescribeSecret that throws fails the read as before; a re-read failure overlays the answer', async () => {
    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    primeSecret([denied()]);
    await expect(read(props(DECLARED), AFTER)).rejects.toThrow('not authorized');
    expect(reads()).toBe(1);

    recordTagWrite(SECRET_TYPE, SECRET_ARN, SET_NEW, []);
    smSend.mockClear();
    primeSecret([OLD, throttle(), NEW]);
    expect(await tagsOf(read(props(DECLARED), AFTER))).toEqual(READ_NEW);
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

function primeGlobalTable(remote: Array<Tag[] | Error>, local: Array<Tag[] | Error> = [[]]): void {
  ddbSend.mockImplementation(
    regionDouble(LOCAL_ARN, queue(local), {
      Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }],
    })
  );
  regionalSend.mockImplementation(regionDouble(REMOTE_ARN, queue(remote), {}));
}

describe('AWS::DynamoDB::GlobalTable replica Tags baseline after its own tag call', () => {
  let provider: DynamoDBGlobalTableProvider;
  const remoteTagReads = (): number => sentOf(regionalSend, ListTagsOfResourceCommand);
  const localTagReads = (): number => sentOf(ddbSend, ListTagsOfResourceCommand);
  const props = (remoteDeclared = true): Record<string, unknown> => ({
    TableName: GT,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    Replicas: [
      { Region: 'us-east-1', Tags: [t('env', 'new')] },
      ...(remoteDeclared ? [{ Region: 'eu-west-1', Tags: [t('env', 'new')] }] : []),
    ],
  });
  const replicaTags = async (
    region: string,
    context?: { afterOwnWrite: true },
    p: Record<string, unknown> = props()
  ): Promise<unknown> => {
    const bag = (await provider.readCurrentState(GT, 'Gt', GT_TYPE, p, context)) as Record<
      string,
      unknown
    >;
    return sorted(
      (bag['Replicas'] as Array<Record<string, unknown>>).find((r) => r['Region'] === region)?.[
        'Tags'
      ]
    );
  };

  beforeEach(() => {
    provider = new DynamoDBGlobalTableProvider();
    provider.tagsBaselineRereadDelaysMs = ZERO;
  });

  it('the create path’s cross-region tag call notes what it wrote for that replica', async () => {
    regionalSend.mockResolvedValue({});
    // create-commit.ts passes `undefined` old tags: every tag is an add.
    await provider.applyCrossRegionReplicaTagsDiff(
      LOCAL_ARN,
      'eu-west-1',
      undefined,
      [t('env', 'new')],
      GT_TYPE,
      'Gt',
      GT
    );
    expect(sentOf(regionalSend, TagResourceCommand)).toBe(1);
    expect(asPlain(takeTagWrite(GT_TYPE, REMOTE_ARN))).toEqual({ set: [['env', 'new']], removed: [] });
    expect(takeTagWrite(GT_TYPE, LOCAL_ARN)).toBeUndefined();
  });

  it('a swallowed cross-region Tag failure notes only the Untag that succeeded', async () => {
    regionalSend.mockImplementation((cmd: unknown) =>
      cmd instanceof TagResourceCommand ? Promise.reject(denied()) : Promise.resolve({})
    );
    await provider.applyCrossRegionReplicaTagsDiff(
      LOCAL_ARN,
      'eu-west-1',
      [t('env', 'old'), t('gone', 'x')],
      [t('env', 'new')],
      GT_TYPE,
      'Gt',
      GT
    );
    expect(asPlain(takeTagWrite(GT_TYPE, REMOTE_ARN))).toEqual({ set: [], removed: ['gone'] });
  });

  it('settles a lagging remote replica on what was written', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN, SET_NEW, []);
    primeGlobalTable([OLD, NEW]);
    expect(await replicaTags('eu-west-1', AFTER)).toEqual(READ_NEW);
    expect(remoteTagReads()).toBe(2);
  });

  it('settles a lagging local replica on what was written', async () => {
    recordTagWrite(GT_TYPE, LOCAL_ARN, SET_NEW, []);
    primeGlobalTable([[]], [OLD, OLD, NEW]);
    expect(await replicaTags('us-east-1', AFTER)).toEqual(READ_NEW);
    expect(localTagReads()).toBe(3);
  });

  it('written keys already showing: one read', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN, SET_NEW, []);
    primeGlobalTable([NEW]);
    expect(await replicaTags('eu-west-1', AFTER)).toEqual(READ_NEW);
    expect(remoteTagReads()).toBe(1);
  });

  it('a schedule spent overlays the written keys, keeping the untouched tag, with a value-free warning', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN, SET_NEW, []);
    primeGlobalTable([OLD]);
    expect(await replicaTags('eu-west-1', AFTER)).toEqual(READ_NEW);
    expect(remoteTagReads()).toBe(5);
    expectOneValueFreeWarning(GT_TYPE, 'Gt');
  });

  it('no note: one read; no capture context: one read and the note is left', async () => {
    primeGlobalTable([OLD, NEW]);
    expect(await replicaTags('eu-west-1', AFTER)).toEqual(READ_OLD);
    expect(remoteTagReads()).toBe(1);

    recordTagWrite(GT_TYPE, REMOTE_ARN, SET_NEW, []);
    regionalSend.mockClear();
    primeGlobalTable([OLD, NEW]);
    expect(await replicaTags('eu-west-1')).toEqual(READ_OLD);
    expect(remoteTagReads()).toBe(1);
    expect(takeTagWrite(GT_TYPE, REMOTE_ARN)).toBeDefined();
  });

  it('a note on a replica the template does not declare: the first answer, one read', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN, SET_NEW, []);
    primeGlobalTable([OLD, NEW]);
    expect(await replicaTags('eu-west-1', AFTER, props(false))).toEqual(READ_OLD);
    expect(remoteTagReads()).toBe(1);
  });

  it('a transient first failure is re-read and warns once when it never settles; a deterministic one rejects the read', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN, SET_NEW, []);
    primeGlobalTable([throttle(), OLD]);
    expect(await replicaTags('eu-west-1', AFTER)).toEqual(READ_NEW);
    expect(remoteTagReads()).toBe(5);
    expectOneValueFreeWarning(GT_TYPE, 'Gt');

    recordTagWrite(GT_TYPE, REMOTE_ARN, SET_NEW, []);
    regionalSend.mockClear();
    childLogger.warn.mockClear();
    primeGlobalTable([denied()]);
    // go-to-k/cdkd#6759: a deterministic failure on a served replica rejects the read
    // (it used to warn and record `[]`, a false removal).
    await expect(replicaTags('eu-west-1', AFTER)).rejects.toThrow();
    expect(remoteTagReads()).toBe(1);
  });

  it('an update drops this table’s replica notes before any call, and only in its regions', async () => {
    recordTagWrite(GT_TYPE, REMOTE_ARN, SET_NEW, []);
    recordTagWrite(GT_TYPE, LOCAL_ARN, SET_NEW, []);
    const notAReplicaRegion = `arn:aws:dynamodb:ap-south-1:111111111111:table/${GT}`;
    const other = 'arn:aws:dynamodb:eu-west-1:111111111111:table/other';
    recordTagWrite(GT_TYPE, notAReplicaRegion, SET_NEW, []);
    recordTagWrite(GT_TYPE, other, SET_NEW, []);
    ddbSend.mockRejectedValue(denied());
    regionalSend.mockRejectedValue(denied());
    await expect(provider.update('Gt', GT, GT_TYPE, props(), props())).rejects.toThrow();
    expect(takeTagWrite(GT_TYPE, REMOTE_ARN)).toBeUndefined();
    expect(takeTagWrite(GT_TYPE, LOCAL_ARN)).toBeUndefined();
    expect(takeTagWrite(GT_TYPE, notAReplicaRegion)).toBeDefined();
    expect(takeTagWrite(GT_TYPE, other)).toBeDefined();
  });

  it('an update clears a note on a replica only the RECORDED side names (one this update removes)', async () => {
    const leaving = `arn:aws:dynamodb:ap-south-1:111111111111:table/${GT}`;
    recordTagWrite(GT_TYPE, leaving, SET_NEW, []);
    ddbSend.mockRejectedValue(denied());
    regionalSend.mockRejectedValue(denied());
    const previous = {
      ...props(),
      Replicas: [...(props()['Replicas'] as unknown[]), { Region: 'ap-south-1' }],
    };
    await expect(provider.update('Gt', GT, GT_TYPE, props(), previous)).rejects.toThrow();
    expect(takeTagWrite(GT_TYPE, leaving)).toBeUndefined();
  });
});

// ------------------------------------------------- the heal for a pre-fix baseline

describe('the drift heal of a Tags baseline captured before #6609', () => {
  const declared = [t('env', 'new'), { Key: 'n', Value: 7 }];
  const live = [t('env', 'new'), t('n', '7'), CDK];
  const stale = { Tags: [t('env', 'old'), t('n', '7')] };

  it('the comparator is exact on the non-aws: set, both polarities', () => {
    const want = declaredTagsReadback(declared)!;
    expect(want).toEqual([t('env', 'new'), t('n', '7')]);
    expect(tagsMatchDeclared(live, want)).toBe(true);
    expect(tagsMatchDeclared([...live, AUTO], want)).toBe(false);
    expect(tagsMatchDeclared([t('env', 'new')], want)).toBe(false);
    expect(tagsMatchDeclared([t('env', 'x'), t('n', '7')], want)).toBe(false);
    expect(tagsMatchDeclared([], declaredTagsReadback(undefined)!)).toBe(true);
    expect(declaredTagsReadback('nope')).toBeUndefined();
  });

  for (const [type, extra] of [
    [TABLE_TYPE, tableProps(undefined)],
    [SECRET_TYPE, { Name: 's-6609e' }],
  ] as const) {
    describe(type, () => {
      const bag = (tags: unknown) => ({ ...extra, ...(tags === undefined ? {} : { Tags: tags }) });

      it('skips Tags while the live set is exactly the declared one', () => {
        expect(preFixBaselineUncomparedDriftKeys(type, stale, bag(declared), { Tags: live })).toContain(
          'Tags'
        );
        // None declared and none live agree too.
        expect(preFixBaselineUncomparedDriftKeys(type, stale, bag(undefined), { Tags: [CDK] })).toContain(
          'Tags'
        );
      });

      it('keeps Tags compared for a tag outside the template, a missing or another value', () => {
        for (const liveTags of [[...live, AUTO], [t('env', 'new')], [t('env', 'old'), t('n', '7')]]) {
          expect(
            preFixBaselineUncomparedDriftKeys(type, stale, bag(declared), { Tags: liveTags })
          ).not.toContain('Tags');
        }
        expect(preFixBaselineUncomparedDriftKeys(type, stale, bag(declared), {})).not.toContain('Tags');
        expect(preFixBaselineUncomparedDriftKeys(type, stale, bag('nope'), { Tags: [] })).not.toContain(
          'Tags'
        );
      });
    });
  }

  it('a GlobalTable replica Tags baseline stays compared (the rule names top-level keys only)', () => {
    const replicas = [{ Region: 'us-east-1', Tags: [t('env', 'new')] }];
    expect(
      preFixBaselineUncomparedDriftKeys(
        GT_TYPE,
        { Replicas: [{ Region: 'us-east-1', Tags: [t('env', 'old')] }] },
        { Replicas: replicas },
        { Replicas: replicas }
      )
    ).toEqual([]);
  });
});
