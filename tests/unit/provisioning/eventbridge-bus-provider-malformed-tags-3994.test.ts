import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateEventBusCommand,
  DescribeEventBusCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-eventbridge';

// go-to-k/cdkd#3994: the EventBus Tags update untagged EVERY recorded key and
// then tagged the desired value as-is, so a malformed DESIRED Tags (a rollback
// / drift --revert desired bag) stripped the bus of its tags.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::Events::EventBus';
const NAME = 'my-bus';
const ARN = `arn:aws:events:us-east-1:123456789012:event-bus/${NAME}`;
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

describe('EventBridgeBusProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: EventBridgeBusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateEventBusCommand) return { EventBusArn: ARN };
      if (cmd instanceof DescribeEventBusCommand) return { Name: NAME, Arn: ARN };
      return {};
    });
    provider = new EventBridgeBusProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update(
          'B',
          NAME,
          TYPE,
          { Name: NAME, Description: 'new', Tags: tags },
          { Name: NAME, Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} B`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('B', TYPE, { Name: NAME, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} B`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('B', NAME, TYPE, { Name: NAME, Tags: DESIRED }, { Name: NAME, Tags: recorded });
      expect(commands().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagResourceCommand) as TagResourceCommand[];
      expect(tag.map((c) => c.input)).toEqual([{ ResourceARN: ARN, Tags: DESIRED }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} B is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'warns about a recorded %s even when the desired side is empty, untagging nothing',
    async (_label, recorded) => {
      await provider.update('B', NAME, TYPE, { Name: NAME, Tags: [] }, { Name: NAME, Tags: recorded });
      expect(
        commands().some((c) => c instanceof UntagResourceCommand || c instanceof TagResourceCommand)
      ).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} B is not`));
      // Nothing to write, so no ARN lookup either.
      expect(commands().some((c) => c instanceof DescribeEventBusCommand)).toBe(false);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('B', NAME, TYPE, { Name: NAME, Tags: DESIRED }, { Name: NAME, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    ) as Array<TagResourceCommand | UntagResourceCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { ResourceARN: ARN, TagKeys: ['drop'] }],
      ['TagResourceCommand', { ResourceARN: ARN, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'B',
      NAME,
      TYPE,
      { Name: NAME, Tags: [] },
      { Name: NAME, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter(
      (c) => c instanceof UntagResourceCommand
    ) as UntagResourceCommand[];
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'B',
      NAME,
      TYPE,
      { Name: NAME, Tags: [{ Key: 'keep', Value: 'same' }] },
      { Name: NAME, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} B holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
    expect(sent).not.toContain('DescribeEventBusCommand');
  });

  it('makes no tag call when the tag set is unchanged', async () => {
    await provider.update('B', NAME, TYPE, { Name: NAME, Tags: RECORDED }, { Name: NAME, Tags: RECORDED });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('creates with the desired tags', async () => {
    await provider.create('B', TYPE, { Name: NAME, Tags: DESIRED });
    const create = commands().find(
      (c) => c instanceof CreateEventBusCommand
    ) as CreateEventBusCommand;
    expect(create.input.Tags).toEqual(DESIRED);
  });

  it('creates with no Tags field when Tags is absent', async () => {
    await provider.create('B', TYPE, { Name: NAME });
    const create = commands().find(
      (c) => c instanceof CreateEventBusCommand
    ) as CreateEventBusCommand;
    expect(create.input.Tags).toBeUndefined();
  });
});
