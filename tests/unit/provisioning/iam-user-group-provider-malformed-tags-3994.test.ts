import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateUserCommand,
  GetUserCommand,
  TagUserCommand,
  UntagUserCommand,
} from '@aws-sdk/client-iam';

// go-to-k/cdkd#3994: the IAM User Tags diff read a malformed side as empty, so
// a malformed DESIRED Tags (a rollback / drift --revert desired bag) untagged
// every recorded key. AWS::IAM::Group has no Tags property.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
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
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::IAM::User';
const USER = 'alice';
const USER_ARN = 'arn:aws:iam::123456789012:user/alice';
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

function tagCalls(): Array<[string, unknown]> {
  return (
    commands().filter((c) => c instanceof TagUserCommand || c instanceof UntagUserCommand) as Array<
      TagUserCommand | UntagUserCommand
    >
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

describe('IAMUserGroupProvider User Tags (go-to-k/cdkd#3994)', () => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetUserCommand || cmd instanceof CreateUserCommand
        ? { User: { UserName: USER, Arn: USER_ARN } }
        : {}
    );
    provider = new IAMUserGroupProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('U', USER, TYPE, { Tags: tags }, { Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} U`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('U', TYPE, { Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} U`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('U', USER, TYPE, { Tags: DESIRED }, { Tags: recorded });
      expect(tagCalls()).toEqual([['TagUserCommand', { UserName: USER, Tags: DESIRED }]]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} U is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('U', USER, TYPE, { Tags: DESIRED }, { Tags: RECORDED });
    expect(tagCalls()).toEqual([
      ['UntagUserCommand', { UserName: USER, TagKeys: ['drop'] }],
      ['TagUserCommand', { UserName: USER, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'U',
      USER,
      TYPE,
      { Tags: [] },
      { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    expect(tagCalls()).toEqual([
      ['UntagUserCommand', { UserName: USER, TagKeys: ['keep', 'drop'] }],
    ]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'U',
      USER,
      TYPE,
      { Tags: [{ Key: 'keep', Value: 'same' }] },
      { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} U holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('U', TYPE, { UserName: USER, Tags: DESIRED });
    const create = commands().find((c) => c instanceof CreateUserCommand) as CreateUserCommand;
    expect(create.input.Tags).toEqual(DESIRED);
  });
});
