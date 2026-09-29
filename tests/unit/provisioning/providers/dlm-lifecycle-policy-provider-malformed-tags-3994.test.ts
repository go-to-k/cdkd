import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3994: the DLM LifecyclePolicy Tags diff read a malformed side
// as empty, so a malformed DESIRED Tags (a rollback / drift --revert desired
// bag) untagged every recorded key.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dlm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dlm')>();
  return {
    ...actual,
    DLMClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { DLMLifecyclePolicyProvider } from '../../../../src/provisioning/providers/dlm-lifecycle-policy-provider.js';
import {
  CreateLifecyclePolicyCommand,
  GetLifecyclePolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-dlm';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from '../tag-list-fixtures.js';

const TYPE = 'AWS::DLM::LifecyclePolicy';
const POLICY_ID = 'policy-0123456789abcdef0';
const POLICY_ARN = `arn:aws:dlm:us-east-1:123456789012:policy/${POLICY_ID}`;
const BASE = {
  Description: 'daily',
  State: 'ENABLED',
  ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
};
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

describe('DLMLifecyclePolicyProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: DLMLifecyclePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateLifecyclePolicyCommand) return { PolicyId: POLICY_ID };
      if (cmd instanceof GetLifecyclePolicyCommand) return { Policy: { PolicyArn: POLICY_ARN } };
      return {};
    });
    provider = new DLMLifecyclePolicyProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update(
          'P',
          POLICY_ID,
          TYPE,
          { ...BASE, Description: 'new', Tags: tags },
          { ...BASE, Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} P`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('P', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} P`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update(
        'P',
        POLICY_ID,
        TYPE,
        { ...BASE, Tags: DESIRED },
        { ...BASE, Tags: recorded }
      );
      expect(commands().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagResourceCommand) as TagResourceCommand[];
      expect(tag.map((c) => c.input)).toEqual([
        { ResourceArn: POLICY_ARN, Tags: { keep: 'same', add: '' } },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} P is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update(
      'P',
      POLICY_ID,
      TYPE,
      { ...BASE, Tags: DESIRED },
      { ...BASE, Tags: RECORDED }
    );
    const tagCalls = commands().filter(
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    ) as Array<TagResourceCommand | UntagResourceCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { ResourceArn: POLICY_ARN, TagKeys: ['drop'] }],
      ['TagResourceCommand', { ResourceArn: POLICY_ARN, Tags: { add: '' } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'P',
      POLICY_ID,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter(
      (c) => c instanceof UntagResourceCommand
    ) as UntagResourceCommand[];
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'P',
      POLICY_ID,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} P holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags as a map', async () => {
    await provider.create('P', TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find(
      (c) => c instanceof CreateLifecyclePolicyCommand
    ) as CreateLifecyclePolicyCommand;
    expect(create.input.Tags).toEqual({ keep: 'same', add: '' });
  });

  it('creates with no Tags field when Tags is absent', async () => {
    await provider.create('P', TYPE, { ...BASE });
    const create = commands().find(
      (c) => c instanceof CreateLifecyclePolicyCommand
    ) as CreateLifecyclePolicyCommand;
    expect(create.input.Tags).toBeUndefined();
  });
});
