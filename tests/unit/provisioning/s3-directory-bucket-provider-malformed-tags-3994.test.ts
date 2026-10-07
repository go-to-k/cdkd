import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { TagResourceCommand, UntagResourceCommand } from '@aws-sdk/client-s3-control';

// go-to-k/cdkd#3994: the S3 Express DirectoryBucket Tags diff read a malformed
// side as empty (an entry with no Key dropped out of the desired key set), so
// a malformed DESIRED Tags (a rollback / drift --revert desired bag) untagged
// every recorded key.

const mockS3Send = vi.fn();
const mockStsSend = vi.fn();
const mockEc2Send = vi.hoisted(() => vi.fn());
const mockControlSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ec2')>();
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({ send: mockEc2Send })),
  };
});

vi.mock('@aws-sdk/client-s3-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3-control')>();
  return {
    ...actual,
    S3ControlClient: vi.fn().mockImplementation(() => ({ send: mockControlSend })),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockS3Send, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend },
  }),
}));

// The create goes through its own S3Client (issue #4639); answer it with the
// same send double as the shared one.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: mockS3Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
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

import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::S3Express::DirectoryBucket';
const BUCKET = 'my-bucket--use1-az4--x-s3';
const ACCOUNT = '123456789012';
const ARN = `arn:aws:s3express:us-east-1:${ACCOUNT}:bucket/${BUCKET}`;
const BASE = {
  BucketName: BUCKET,
  DataRedundancy: 'SingleAvailabilityZone',
  LocationName: 'us-east-1c--x-s3',
};
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function tagCalls(): Array<TagResourceCommand | UntagResourceCommand> {
  return mockControlSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter(
      (c): c is TagResourceCommand | UntagResourceCommand =>
        c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    );
}

function sdkCallCount(): number {
  return (
    mockS3Send.mock.calls.length +
    mockStsSend.mock.calls.length +
    mockEc2Send.mock.calls.length +
    mockControlSend.mock.calls.length
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

describe('S3DirectoryBucketProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: S3DirectoryBucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send.mockResolvedValue({});
    mockStsSend.mockResolvedValue({ Account: ACCOUNT });
    mockEc2Send.mockResolvedValue({
      AvailabilityZones: [{ ZoneId: 'use1-az4', ZoneName: 'us-east-1c' }],
    });
    mockControlSend.mockResolvedValue({});
    provider = new S3DirectoryBucketProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('B', BUCKET, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} B`);
      expect(sdkCallCount()).toBe(0);
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('B', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} B`);
      expect(sdkCallCount()).toBe(0);
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('B', BUCKET, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(tagCalls().map((c) => [c.constructor.name, c.input])).toEqual([
        [
          'TagResourceCommand',
          {
            AccountId: ACCOUNT,
            ResourceArn: ARN,
            Tags: [
              { Key: 'keep', Value: 'same' },
              { Key: 'add', Value: '' },
            ],
          },
        ],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} B is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('B', BUCKET, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    expect(tagCalls().map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { AccountId: ACCOUNT, ResourceArn: ARN, TagKeys: ['drop'] }],
      [
        'TagResourceCommand',
        { AccountId: ACCOUNT, ResourceArn: ARN, Tags: [{ Key: 'add', Value: '' }] },
      ],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'B',
      BUCKET,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = tagCalls().filter((c) => c instanceof UntagResourceCommand);
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'B',
      BUCKET,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} B holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockControlSend, mockStsSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('B', TYPE, { ...BASE, Tags: DESIRED });
    const create = mockS3Send.mock.calls
      .map((c) => c[0] as unknown)
      .find((c): c is CreateBucketCommand => c instanceof CreateBucketCommand);
    expect(create?.input.CreateBucketConfiguration?.Tags).toEqual(DESIRED);
  });
});
