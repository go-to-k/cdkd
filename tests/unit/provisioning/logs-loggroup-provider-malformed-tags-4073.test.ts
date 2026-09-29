import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateLogGroupCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-cloudwatch-logs';

// go-to-k/cdkd#4073 (a #3994 follow-up): the log group update compared both
// Tags sides with JSON.stringify and, on any difference, untagged EVERY
// recorded key before re-tagging the raw desired value. A malformed desired
// Tags (a rollback / drift --revert desired bag) stripped every tag before the
// re-tag call failed, and a recorded bare string made `.map` throw.

const mockSend = vi.fn();
const mockStsSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::Logs::LogGroup';
const NAME = '/issue4073/lg';
const ARN = `arn:aws:logs:us-east-1:123456789012:log-group:${NAME}`;
const BASE = { LogGroupName: NAME };
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

/** A log group's CFn Tags is a LIST; a key -> value map (Glue's shape) is malformed here. */
const MAP_SHAPED: Array<[string, unknown]> = [['a key -> value map', { env: TAG_FIXTURE.NEEDLE }]];

function tagCalls(): Array<[string, unknown]> {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand)
    .map((c) => [
      c.constructor.name,
      (c as TagResourceCommand | UntagResourceCommand).input,
    ]);
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

describe('LogsLogGroupProvider Tags (go-to-k/cdkd#4073)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = new LogsLogGroupProvider();
  });

  it.each([...PROVIDER_MALFORMED_DESIRED, ...MAP_SHAPED])(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('L', NAME, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} L is not a list of tags`);
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockStsSend).not.toHaveBeenCalled();
    }
  );

  it.each([...PROVIDER_MALFORMED_DESIRED, ...MAP_SHAPED])(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('L', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} L is not a list of tags`);
      // The create wording, not the update one.
      expect(err.message).not.toContain('desired ');
      expect(err.message).toContain('the resource was not created');
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockStsSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('L', NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(tagCalls()).toEqual([
        ['TagResourceCommand', { resourceArn: ARN, tags: { keep: 'same', add: '' } }],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} L is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Untag / Tag calls instead of untagging every key', async () => {
    await provider.update('L', NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    expect(tagCalls()).toEqual([
      ['UntagResourceCommand', { resourceArn: ARN, tagKeys: ['drop'] }],
      ['TagResourceCommand', { resourceArn: ARN, tags: { add: '' } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends no tag call when only the entry order differs', async () => {
    await provider.update(
      'L',
      NAME,
      TYPE,
      { ...BASE, Tags: [...RECORDED].reverse() },
      { ...BASE, Tags: RECORDED }
    );
    expect(tagCalls()).toEqual([]);
  });

  it('untags every recorded key when the template drops Tags', async () => {
    await provider.update('L', NAME, TYPE, { ...BASE }, { ...BASE, Tags: RECORDED });
    expect(tagCalls()).toEqual([
      ['UntagResourceCommand', { resourceArn: ARN, tagKeys: ['keep', 'drop'] }],
    ]);
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'L',
      NAME,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    expect(tagCalls()).toEqual([
      ['UntagResourceCommand', { resourceArn: ARN, tagKeys: ['keep', 'drop'] }],
    ]);
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} L holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
  });

  it('routes the tag plan warning through the operation masker', async () => {
    await provider.update(
      'L',
      NAME,
      TYPE,
      { ...BASE, Tags: DESIRED },
      { ...BASE, Tags: TAG_FIXTURE.NEEDLE },
      { maskSecrets: (text: string) => text.replace('removed no tag', '<masked>') }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(expect.stringContaining('<masked>'));
    expect(warned.join('\n')).not.toContain('removed no tag');
  });

  it('masks an AWS error message the update wraps', async () => {
    mockSend.mockImplementation((cmd: object) =>
      cmd instanceof TagResourceCommand
        ? Promise.reject(new Error(`bad tag value ${TAG_FIXTURE.NEEDLE}`))
        : Promise.resolve({})
    );
    const err = await provider
      .update(
        'L',
        NAME,
        TYPE,
        { ...BASE, Tags: DESIRED },
        { ...BASE, Tags: RECORDED },
        { maskSecrets: (text: string) => text.replaceAll(TAG_FIXTURE.NEEDLE, '***') }
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain('Failed to update log group L: bad tag value ***');
    expect(err?.message).not.toContain(TAG_FIXTURE.NEEDLE);
  });

  it('masks an AWS error message the create wraps', async () => {
    mockSend.mockImplementation((cmd: object) =>
      cmd instanceof CreateLogGroupCommand
        ? Promise.reject(new Error(`bad tag value ${TAG_FIXTURE.NEEDLE}`))
        : Promise.resolve({})
    );
    const err = await provider
      .create(
        'L',
        TYPE,
        { ...BASE, Tags: DESIRED },
        { maskSecrets: (text: string) => text.replaceAll(TAG_FIXTURE.NEEDLE, '***') }
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain('Failed to create log group L: bad tag value ***');
    expect(err?.message).not.toContain(TAG_FIXTURE.NEEDLE);
  });

  it('creates with the desired tags, coercing a scalar value', async () => {
    await provider.create('L', TYPE, {
      ...BASE,
      Tags: [
        { Key: 'n', Value: 1 },
        { Key: 'b', Value: true },
        { Key: 's', Value: 'x' },
      ],
    });
    const create = mockSend.mock.calls
      .map((c) => c[0] as object)
      .find((c): c is CreateLogGroupCommand => c instanceof CreateLogGroupCommand);
    expect(create?.input.tags).toEqual({ n: '1', b: 'true', s: 'x' });
  });

  it('creates with no tags key when Tags is absent or empty', async () => {
    await provider.create('L', TYPE, { ...BASE, Tags: [] });
    await provider.create('L', TYPE, { ...BASE, Tags: null });
    const creates = mockSend.mock.calls
      .map((c) => c[0] as object)
      .filter((c): c is CreateLogGroupCommand => c instanceof CreateLogGroupCommand);
    expect(creates).toHaveLength(2);
    for (const c of creates) expect(c.input.tags).toBeUndefined();
  });
});
