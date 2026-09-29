import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateDistributionCommand,
  CreateDistributionWithTagsCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-cloudfront';

// go-to-k/cdkd#3994: the CloudFront Tags diff read a malformed side as empty
// (`if (!Array.isArray(value)) return map;`), so a malformed DESIRED Tags (a
// rollback / drift --revert desired bag) untagged every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::CloudFront::Distribution';
const ID = 'EDFDVBD6EXAMPLE';
const ARN = `arn:aws:cloudfront::123456789012:distribution/${ID}`;
const BASE = { DistributionConfig: { Enabled: true } };
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

describe('CloudFrontDistributionProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: CloudFrontDistributionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['CDKD_FULL_WAIT'];
    delete process.env['CDKD_WAIT_FLAGS_AVAILABLE'];
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetDistributionConfigCommand
        ? { ETag: 'E1', DistributionConfig: { CallerReference: 'orig', Enabled: true } }
        : cmd instanceof GetDistributionCommand ||
            cmd instanceof CreateDistributionCommand ||
            cmd instanceof CreateDistributionWithTagsCommand
          ? { Distribution: { Id: ID, ARN, DomainName: 'd1.cloudfront.net' } }
          : {}
    );
    provider = new CloudFrontDistributionProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('D', ID, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} D`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('D', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} D`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('D', ID, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagResourceCommand) as TagResourceCommand[];
      expect(tag.map((c) => c.input)).toEqual([
        {
          Resource: ARN,
          Tags: {
            Items: [
              { Key: 'keep', Value: 'same' },
              { Key: 'add', Value: '' },
            ],
          },
        },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} D is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('D', ID, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    ) as Array<TagResourceCommand | UntagResourceCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { Resource: ARN, TagKeys: { Items: ['drop'] } }],
      ['TagResourceCommand', { Resource: ARN, Tags: { Items: [{ Key: 'add', Value: '' }] } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'D',
      ID,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter(
      (c) => c instanceof UntagResourceCommand
    ) as UntagResourceCommand[];
    expect(untag.map((c) => c.input.TagKeys)).toEqual([{ Items: ['keep', 'drop'] }]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'D',
      ID,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} D holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('D', TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find(
      (c) => c instanceof CreateDistributionWithTagsCommand
    ) as CreateDistributionWithTagsCommand;
    expect(create.input.DistributionConfigWithTags?.Tags).toEqual({ Items: DESIRED });
  });

  it('creates through the untagged command when the template has no Tags', async () => {
    await provider.create('D', TYPE, { ...BASE, Tags: [] });
    expect(commands().some((c) => c instanceof CreateDistributionCommand)).toBe(true);
    expect(commands().some((c) => c instanceof CreateDistributionWithTagsCommand)).toBe(false);
  });
});
