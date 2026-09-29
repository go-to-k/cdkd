import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3994: the S3 Vectors VectorBucket Tags diff read a malformed
// side as empty (`!Array.isArray(tags)` -> {}, entries missing Key or Value
// skipped), so a malformed DESIRED Tags (a rollback / drift --revert desired
// bag) untagged every recorded key.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3vectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3vectors')>();
  return {
    ...actual,
    S3VectorsClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
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

import {
  CreateVectorBucketCommand,
  GetVectorBucketCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-s3vectors';
import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::S3Vectors::VectorBucket';
const BUCKET = 'my-vector-bucket';
const ARN = `arn:aws:s3vectors:us-east-1:123456789012:bucket/${BUCKET}`;
const BASE = { VectorBucketName: BUCKET };
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

describe('S3VectorsProvider VectorBucket Tags (go-to-k/cdkd#3994)', () => {
  let provider: S3VectorsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateVectorBucketCommand) return { vectorBucketArn: ARN };
      if (cmd instanceof GetVectorBucketCommand) return { vectorBucket: { vectorBucketArn: ARN } };
      return {};
    });
    provider = new S3VectorsProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('V', BUCKET, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} V`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('V', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} V`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('V', BUCKET, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(tagCalls().map((c) => [c.constructor.name, c.input])).toEqual([
        ['TagResourceCommand', { resourceArn: ARN, tags: { keep: 'same', add: '' } }],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} V is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('V', BUCKET, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    expect(tagCalls().map((c) => [c.constructor.name, c.input])).toEqual([
      ['TagResourceCommand', { resourceArn: ARN, tags: { add: '' } }],
      ['UntagResourceCommand', { resourceArn: ARN, tagKeys: ['drop'] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'V',
      BUCKET,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = tagCalls().filter((c) => c instanceof UntagResourceCommand);
    expect(untag.map((c) => c.input.tagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'V',
      BUCKET,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} V holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('V', TYPE, { ...BASE, Tags: DESIRED });
    const create = mockSend.mock.calls
      .map((c) => c[0] as unknown)
      .find((c): c is CreateVectorBucketCommand => c instanceof CreateVectorBucketCommand);
    expect(create?.input.tags).toEqual({ keep: 'same', add: '' });
  });
});
