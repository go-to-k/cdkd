import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { AddTagsCommand, CreateTrailCommand, RemoveTagsCommand } from '@aws-sdk/client-cloudtrail';

// go-to-k/cdkd#3994: the CloudTrail Tags diff read a malformed side as empty,
// so a malformed DESIRED Tags (a rollback / drift --revert desired bag)
// untagged every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cloudtrail');
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
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

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::CloudTrail::Trail';
const ARN = 'arn:aws:cloudtrail:us-east-1:123456789012:trail/my-trail';
const BASE = { S3BucketName: 'my-bucket' };
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
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

describe('CloudTrailProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: CloudTrailProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof CreateTrailCommand ? { TrailARN: ARN, Name: 'my-trail' } : {}
    );
    provider = new CloudTrailProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('T', ARN, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} T`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('T', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} T`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('T', ARN, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof RemoveTagsCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof AddTagsCommand) as AddTagsCommand[];
      expect(tag.map((c) => c.input)).toEqual([
        {
          ResourceId: ARN,
          TagsList: [
            { Key: 'keep', Value: 'same' },
            { Key: 'add', Value: '' },
          ],
        },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} T is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact AddTags / RemoveTags calls', async () => {
    await provider.update('T', ARN, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof AddTagsCommand || c instanceof RemoveTagsCommand
    ) as Array<AddTagsCommand | RemoveTagsCommand>;
    // RemoveTags carries the full recorded {Key, Value} objects.
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['RemoveTagsCommand', { ResourceId: ARN, TagsList: [{ Key: 'drop', Value: 'x' }] }],
      ['AddTagsCommand', { ResourceId: ARN, TagsList: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'T',
      ARN,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter((c) => c instanceof RemoveTagsCommand) as RemoveTagsCommand[];
    expect(untag.map((c) => c.input.TagsList)).toEqual([RECORDED]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'T',
      ARN,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} T holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('T', TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find((c) => c instanceof CreateTrailCommand) as CreateTrailCommand;
    expect(create.input.TagsList).toEqual(DESIRED);
  });

  it('creates with no TagsList when the template has none', async () => {
    await provider.create('T', TYPE, { ...BASE });
    const create = commands().find((c) => c instanceof CreateTrailCommand) as CreateTrailCommand;
    expect(create.input.TagsList).toBeUndefined();
  });
});
