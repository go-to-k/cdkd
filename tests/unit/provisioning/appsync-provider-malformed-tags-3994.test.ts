import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3994: the AppSync GraphQLApi Tags diff read a malformed side as
// empty, so a malformed DESIRED Tags (a rollback / drift --revert desired bag)
// untagged every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-appsync', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-appsync')>(
    '@aws-sdk/client-appsync'
  );
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

import {
  CreateGraphqlApiCommand,
  GetGraphqlApiCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-appsync';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::AppSync::GraphQLApi';
const API_ID = 'abcdefghijklmnopqrstuvwxyz';
const ARN = `arn:aws:appsync:us-east-1:123456789012:apis/${API_ID}`;
const BASE = { Name: 'my-api', AuthenticationType: 'API_KEY' };
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

describe('AppSyncProvider GraphQLApi Tags (go-to-k/cdkd#3994)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateGraphqlApiCommand || cmd instanceof GetGraphqlApiCommand) {
        return { graphqlApi: { apiId: API_ID, arn: ARN, uris: { GRAPHQL: 'https://x/graphql' } } };
      }
      return {};
    });
    provider = new AppSyncProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update(
          'A',
          API_ID,
          TYPE,
          { ...BASE, AuthenticationType: 'AWS_IAM', Tags: tags },
          { ...BASE, Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} A`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('A', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} A`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('A', API_ID, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagResourceCommand) as TagResourceCommand[];
      expect(tag.map((c) => c.input)).toEqual([
        { resourceArn: ARN, tags: { keep: 'same', add: '' } },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} A is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('A', API_ID, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    ) as Array<TagResourceCommand | UntagResourceCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { resourceArn: ARN, tagKeys: ['drop'] }],
      ['TagResourceCommand', { resourceArn: ARN, tags: { add: '' } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'A',
      API_ID,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter(
      (c) => c instanceof UntagResourceCommand
    ) as UntagResourceCommand[];
    expect(untag.map((c) => c.input.tagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'A',
      API_ID,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} A holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('makes no tag call when the tag sets are equal', async () => {
    await provider.update('A', API_ID, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: DESIRED });
    expect(commands()).toEqual([]);
  });

  it('creates with the desired tags as a map', async () => {
    await provider.create('A', TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find(
      (c) => c instanceof CreateGraphqlApiCommand
    ) as CreateGraphqlApiCommand;
    expect(create.input.tags).toEqual({ keep: 'same', add: '' });
  });

  it('creates with no tags field when Tags is absent', async () => {
    await provider.create('A', TYPE, { ...BASE });
    const create = commands().find(
      (c) => c instanceof CreateGraphqlApiCommand
    ) as CreateGraphqlApiCommand;
    expect(create.input.tags).toBeUndefined();
  });
});
