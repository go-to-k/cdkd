import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AddTagsToResourceCommand,
  PutParameterCommand,
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-ssm';

// go-to-k/cdkd#3994: AWS::SSM::Parameter.Tags is a key -> value MAP. Its diff
// read any non-object value (a string, a number) as no tags and then removed
// EVERY recorded key, so a malformed DESIRED Tags (a rollback / drift --revert
// desired bag) untagged the parameter.

const mockSend = vi.fn();
const mockStsSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend },
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

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::SSM::Parameter';
const NAME = '/issue3994/p';
const BASE = { Name: NAME, Type: 'String', Value: 'v' };
const RECORDED = { keep: 'same', drop: 'x' };
const DESIRED = { keep: 'same', add: '' };

/** Map-shape malformed values, on top of the list ones the shared fixtures carry. */
const MAP_MALFORMED: Array<[string, unknown]> = [
  ['a map with an object value', { env: { nested: TAG_FIXTURE.NEEDLE } }],
  ['a map with a null value', { env: null }],
  ['a number', 7],
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

function tagCalls(): Array<[string, unknown]> {
  return (
    commands().filter(
      (c) => c instanceof AddTagsToResourceCommand || c instanceof RemoveTagsFromResourceCommand
    ) as Array<AddTagsToResourceCommand | RemoveTagsFromResourceCommand>
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

describe('SSMParameterProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: SSMParameterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = new SSMParameterProvider();
  });

  it.each([...PROVIDER_MALFORMED_DESIRED, ...MAP_MALFORMED])(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('P', NAME, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} P is not a map of tag keys`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('refuses a desired map whose key is secret-derived', async () => {
    const err = await refusal(() =>
      provider.update(
        'P',
        NAME,
        TYPE,
        { ...BASE, Tags: { [TAG_FIXTURE.SECRET_REF]: 'v' } },
        { ...BASE, Tags: RECORDED }
      )
    );
    expect(err.message).toContain('holds a dynamic reference or its mask');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([...PROVIDER_MALFORMED_DESIRED, ...MAP_MALFORMED])(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      await refusal(() => provider.create('P', TYPE, { ...BASE, Tags: tags }));
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockStsSend).not.toHaveBeenCalled();
    }
  );

  it.each([...PROVIDER_MALFORMED_RECORDED, ...MAP_MALFORMED])(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('P', NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(tagCalls()).toEqual([
        [
          'AddTagsToResourceCommand',
          {
            ResourceType: 'Parameter',
            ResourceId: NAME,
            Tags: [
              { Key: 'keep', Value: 'same' },
              { Key: 'add', Value: '' },
            ],
          },
        ],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} P is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('P', NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    expect(tagCalls()).toEqual([
      [
        'RemoveTagsFromResourceCommand',
        { ResourceType: 'Parameter', ResourceId: NAME, TagKeys: ['drop'] },
      ],
      [
        'AddTagsToResourceCommand',
        { ResourceType: 'Parameter', ResourceId: NAME, Tags: [{ Key: 'add', Value: '' }] },
      ],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'P',
      NAME,
      TYPE,
      { ...BASE, Tags: {} },
      { ...BASE, Tags: { [TAG_FIXTURE.SECRET_REF]: 'v', ...RECORDED } }
    );
    expect(tagCalls()).toEqual([
      [
        'RemoveTagsFromResourceCommand',
        { ResourceType: 'Parameter', ResourceId: NAME, TagKeys: ['keep', 'drop'] },
      ],
    ]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'P',
      NAME,
      TYPE,
      { ...BASE, Tags: { keep: 'same' } },
      { ...BASE, Tags: { [TAG_FIXTURE.SECRET_REF]: 'v', keep: 'same' } }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} P holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend, mockStsSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('never untags or tags a reserved aws: key', async () => {
    await provider.update(
      'P',
      NAME,
      TYPE,
      { ...BASE, Tags: { keep: 'same', 'aws:new': 'v' } },
      { ...BASE, Tags: { keep: 'same', 'aws:cdk:path': 'Stack/P' } }
    );
    expect(tagCalls()).toEqual([]);
  });

  it('creates with the desired tags, coercing a scalar value', async () => {
    await provider.create('P', TYPE, { ...BASE, Tags: { n: 1, b: true, s: 'x' } });
    expect(commands().some((c) => c instanceof PutParameterCommand)).toBe(true);
    expect(tagCalls()).toEqual([
      [
        'AddTagsToResourceCommand',
        {
          ResourceType: 'Parameter',
          ResourceId: NAME,
          Tags: [
            { Key: 'n', Value: '1' },
            { Key: 'b', Value: 'true' },
            { Key: 's', Value: 'x' },
          ],
        },
      ],
    ]);
  });
});
