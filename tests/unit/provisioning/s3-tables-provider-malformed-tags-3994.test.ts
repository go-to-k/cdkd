import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableBucketCommand,
  CreateTableCommand,
  GetTableCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-s3tables';

// go-to-k/cdkd#3994: the S3 Tables Table / TableBucket Tags diff read a
// malformed side as empty (`!Array.isArray(x)` -> no tags, bad entries
// skipped), so a malformed DESIRED Tags (a rollback / drift --revert desired
// bag) untagged every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3tables', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-s3tables')>('@aws-sdk/client-s3tables');
  class MockS3TablesClient {
    config = { region: () => Promise.resolve('us-east-1') };
    send = mockSend;
  }
  return { ...actual, S3TablesClient: MockS3TablesClient };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
const TABLE_ARN = `${BUCKET_ARN}/table/OPAQUE-AWS-ID`;
const TABLE_ID = `${BUCKET_ARN}|my_ns|my_table`;

interface Case {
  type: string;
  physicalId: string;
  tagArn: string;
  base: Record<string, unknown>;
  createCommand: typeof CreateTableBucketCommand | typeof CreateTableCommand;
}

const CASES: Array<[string, Case]> = [
  [
    'TableBucket',
    {
      type: 'AWS::S3Tables::TableBucket',
      physicalId: BUCKET_ARN,
      tagArn: BUCKET_ARN,
      base: { TableBucketName: 'my-bucket' },
      createCommand: CreateTableBucketCommand,
    },
  ],
  [
    'Table',
    {
      type: 'AWS::S3Tables::Table',
      physicalId: TABLE_ID,
      tagArn: TABLE_ARN,
      base: {
        TableBucketARN: BUCKET_ARN,
        Namespace: 'my_ns',
        TableName: 'my_table',
        OpenTableFormat: 'ICEBERG',
      },
      createCommand: CreateTableCommand,
    },
  ],
];

const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function tagCalls(): Array<TagResourceCommand | UntagResourceCommand> {
  return mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter(
      (c): c is TagResourceCommand | UntagResourceCommand =>
        c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    );
}

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(isMarkedNonRetryable(err)).toBe(true);
  const msg = (err as Error).message;
  expect(msg).not.toContain(TAG_FIXTURE.NEEDLE);
  expect(msg).not.toContain('issue3994/tags');
  return err as Error;
}

describe.each(CASES)('S3TablesProvider %s Tags (go-to-k/cdkd#3994)', (_name, c) => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateTableBucketCommand) return { arn: BUCKET_ARN };
      if (cmd instanceof CreateTableCommand) return { tableARN: TABLE_ARN };
      if (cmd instanceof GetTableCommand) return { tableARN: TABLE_ARN };
      return {};
    });
    provider = new S3TablesProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('L', c.physicalId, c.type, { ...c.base, Tags: tags }, {
          ...c.base,
          Tags: RECORDED,
        })
      );
      expect(err.message).toContain(`desired Tags of ${c.type} L`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('L', c.type, { ...c.base, Tags: tags }));
      expect(err.message).toContain(`Tags of ${c.type} L`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('L', c.physicalId, c.type, { ...c.base, Tags: DESIRED }, {
        ...c.base,
        Tags: recorded,
      });
      expect(tagCalls().map((x) => [x.constructor.name, x.input])).toEqual([
        ['TagResourceCommand', { resourceArn: c.tagArn, tags: { keep: 'same', add: '' } }],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${c.type} L is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('L', c.physicalId, c.type, { ...c.base, Tags: DESIRED }, {
      ...c.base,
      Tags: RECORDED,
    });
    expect(tagCalls().map((x) => [x.constructor.name, x.input])).toEqual([
      ['UntagResourceCommand', { resourceArn: c.tagArn, tagKeys: ['drop'] }],
      ['TagResourceCommand', { resourceArn: c.tagArn, tags: { add: '' } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update('L', c.physicalId, c.type, { ...c.base, Tags: [] }, {
      ...c.base,
      Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED],
    });
    const untag = tagCalls().filter((x) => x instanceof UntagResourceCommand);
    expect(untag.map((x) => x.input.tagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update('L', c.physicalId, c.type, { ...c.base, Tags: [{ Key: 'keep', Value: 'same' }] }, {
      ...c.base,
      Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }],
    });
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${c.type} L holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('L', c.type, { ...c.base, Tags: DESIRED });
    const create = mockSend.mock.calls
      .map((x) => x[0] as unknown)
      .find((x) => x instanceof c.createCommand) as
      | CreateTableBucketCommand
      | CreateTableCommand
      | undefined;
    expect(create?.input.tags).toEqual({ keep: 'same', add: '' });
  });
});
