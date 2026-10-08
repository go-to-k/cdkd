import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteBucketTaggingCommand,
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
  NoSuchBucket,
  PutBucketTaggingCommand,
} from '@aws-sdk/client-s3';

// go-to-k/cdkd#3994: the S3 Tags diff read a malformed side as empty, so a
// malformed DESIRED Tags (a rollback / drift --revert desired bag) cleared the
// bucket's whole tag set. `PutBucketTagging` is a full replace, so a recorded
// side cdkd cannot name every key of is met by merging the live tag set.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

// CreateBucket goes through its own S3Client (issue #4639); forward it to the
// shared double below.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
  ...(await import('./s3-create-client-forward.js')).forwardedS3Client(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::S3::Bucket';
const BUCKET = 'my-bucket';
const BASE = { BucketName: BUCKET };
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];
// The live tag set: what RECORDED put there, a console-added key, and the
// aws:-prefixed key S3 refuses to write back.
const LIVE = [...RECORDED, { Key: 'console', Value: 'c' }, { Key: 'aws:cdk:path', Value: 'p' }];

let liveTags: Array<{ Key: string; Value: string }>;

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

function tagWrites(): Array<[string, unknown]> {
  return (
    commands().filter(
      (c) => c instanceof PutBucketTaggingCommand || c instanceof DeleteBucketTaggingCommand
    ) as Array<PutBucketTaggingCommand | DeleteBucketTaggingCommand>
  ).map((c) => [c.constructor.name, c.input]);
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

describe('S3BucketProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    liveTags = LIVE;
    mockSend.mockImplementation(async (cmd: unknown) => {
      // go-to-k/cdkd#4684: the us-east-1 create pre-flight finds no bucket, or
      // the explicit BucketName reads as already held and is refused.
      if (cmd instanceof GetBucketLocationCommand) {
        throw new NoSuchBucket({ message: 'no such bucket', $metadata: { httpStatusCode: 404 } });
      }
      return cmd instanceof GetBucketTaggingCommand ? { TagSet: liveTags } : {};
    });
    provider = new S3BucketProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('B', BUCKET, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} B`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('B', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} B`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: sets every desired tag and keeps every other live key',
    async (_label, recorded) => {
      await provider.update('B', BUCKET, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof GetBucketTaggingCommand)).toBe(true);
      expect(tagWrites()).toEqual([
        [
          'PutBucketTaggingCommand',
          {
            Bucket: BUCKET,
            Tagging: {
              TagSet: [...DESIRED, { Key: 'console', Value: 'c' }, { Key: 'drop', Value: 'x' }],
            },
          },
        ],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} B is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('an unreadable record with an empty desired side writes nothing', async () => {
    await provider.update('B', BUCKET, TYPE, { ...BASE, Tags: [] }, { ...BASE, Tags: 'x' });
    expect(tagWrites()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
    // Names the LOGICAL id, never an ARN / URL / physical name.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} B is not`));
  });

  it('replaces the tag set with the desired side on a valid pair, without reading live tags', async () => {
    await provider.update('B', BUCKET, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    expect(commands().some((c) => c instanceof GetBucketTaggingCommand)).toBe(false);
    expect(tagWrites()).toEqual([
      ['PutBucketTaggingCommand', { Bucket: BUCKET, Tagging: { TagSet: DESIRED } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('clears the tag set when a valid pair drops every tag', async () => {
    await provider.update('B', BUCKET, TYPE, { ...BASE, Tags: [] }, { ...BASE, Tags: RECORDED });
    expect(tagWrites()).toEqual([['DeleteBucketTaggingCommand', { Bucket: BUCKET }]]);
  });

  it('writes nothing when a valid pair names the same tags', async () => {
    await provider.update('B', BUCKET, TYPE, { ...BASE, Tags: RECORDED }, { ...BASE, Tags: RECORDED });
    expect(tagWrites()).toEqual([]);
  });

  it('never removes the live key behind a recorded secret-derived key', async () => {
    liveTags = [{ Key: 'resolved-secret-key', Value: 'v' }, ...RECORDED];
    await provider.update(
      'B',
      BUCKET,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    expect(tagWrites()).toEqual([
      [
        'PutBucketTaggingCommand',
        { Bucket: BUCKET, Tagging: { TagSet: [{ Key: 'resolved-secret-key', Value: 'v' }] } },
      ],
    ]);
    // The live key survives, and the hidden recorded key is announced (it cannot be named).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      `${TYPE} B holds 1 key(s) derived from a dynamic reference`
    );
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('issue3994/tags');
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    liveTags = [{ Key: 'resolved-secret-key', Value: 'v' }, { Key: 'keep', Value: 'same' }];
    await provider.update(
      'B',
      BUCKET,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      {
        ...BASE,
        Tags: [
          { Key: TAG_FIXTURE.SECRET_REF, Value: 'v' },
          { Key: 'keep', Value: 'same' },
        ],
      }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} B holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    // No write may drop a live key: either nothing is written, or the live key survives.
    for (const [name, input] of tagWrites()) {
      expect(name).not.toBe('DeleteBucketTaggingCommand');
      expect(JSON.stringify(input)).toContain('resolved-secret-key');
    }
  });

  it('creates with the desired tags', async () => {
    await provider.create('B', TYPE, { ...BASE, Tags: DESIRED });
    expect(tagWrites()).toEqual([
      ['PutBucketTaggingCommand', { Bucket: BUCKET, Tagging: { TagSet: DESIRED } }],
    ]);
  });
});
