import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  ListPolicyVersionsCommand,
  TagPolicyCommand,
  UntagPolicyCommand,
} from '@aws-sdk/client-iam';

// go-to-k/cdkd#3994: the IAM ManagedPolicy Tags diff read a malformed side as
// empty or short, so a malformed DESIRED Tags (a rollback / drift --revert
// desired bag) untagged recorded keys.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::IAM::ManagedPolicy';
const LOGICAL = 'MyManagedPolicy';
const ARN = `arn:aws:iam::123456789012:policy/${LOGICAL}`;
const POLICY_DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};
const BASE = { PolicyDocument: POLICY_DOC };
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

describe('IAMManagedPolicyProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: IAMManagedPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreatePolicyCommand) return { Policy: { Arn: ARN } };
      if (cmd instanceof ListPolicyVersionsCommand) {
        return { Versions: [{ VersionId: 'v1', IsDefaultVersion: true }], IsTruncated: false };
      }
      if (cmd instanceof CreatePolicyVersionCommand) return { PolicyVersion: { VersionId: 'v2' } };
      return {};
    });
    provider = new IAMManagedPolicyProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const newDoc = { ...POLICY_DOC, Statement: [...POLICY_DOC.Statement, { Sid: 'new' }] };
      const err = await refusal(() =>
        provider.update(
          LOGICAL,
          ARN,
          TYPE,
          { PolicyDocument: newDoc, Tags: tags },
          { ...BASE, Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} ${LOGICAL}`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create(LOGICAL, TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} ${LOGICAL}`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update(LOGICAL, ARN, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof UntagPolicyCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagPolicyCommand) as TagPolicyCommand[];
      expect(tag.map((c) => c.input)).toEqual([{ PolicyArn: ARN, Tags: DESIRED }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} ${LOGICAL} is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update(LOGICAL, ARN, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof TagPolicyCommand || c instanceof UntagPolicyCommand
    ) as Array<TagPolicyCommand | UntagPolicyCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagPolicyCommand', { PolicyArn: ARN, TagKeys: ['drop'] }],
      ['TagPolicyCommand', { PolicyArn: ARN, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      LOGICAL,
      ARN,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter((c) => c instanceof UntagPolicyCommand) as UntagPolicyCommand[];
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      LOGICAL,
      ARN,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} ${LOGICAL} holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create(LOGICAL, TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find((c) => c instanceof CreatePolicyCommand) as CreatePolicyCommand;
    expect(create.input.Tags).toEqual(DESIRED);
  });

  it('creates with no Tags field when Tags is absent', async () => {
    await provider.create(LOGICAL, TYPE, { ...BASE });
    const create = commands().find((c) => c instanceof CreatePolicyCommand) as CreatePolicyCommand;
    expect(create.input.Tags).toBeUndefined();
  });
});
