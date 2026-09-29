import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3994: the ECR Repository Tags diff read a malformed side as
// empty, so a malformed DESIRED Tags (a rollback / drift --revert desired bag)
// untagged every recorded key.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return {
    ...actual,
    ECRClient: vi.fn().mockImplementation(() => ({
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

import { ECRProvider } from '../../../../src/provisioning/providers/ecr-provider.js';
import {
  CreateRepositoryCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-ecr';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from '../tag-list-fixtures.js';

const TYPE = 'AWS::ECR::Repository';
const NAME = 'my-repo';
const REPO_ARN = `arn:aws:ecr:us-east-1:123456789012:repository/${NAME}`;
const REPO = {
  repositoryName: NAME,
  repositoryArn: REPO_ARN,
  repositoryUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/${NAME}`,
};
const BASE = { RepositoryName: NAME };
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

describe('ECRProvider Repository Tags (go-to-k/cdkd#3994)', () => {
  let provider: ECRProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ repository: REPO, repositories: [REPO] });
    provider = new ECRProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update(
          'R',
          NAME,
          TYPE,
          { ...BASE, ImageScanningConfiguration: { ScanOnPush: true }, Tags: tags },
          { ...BASE, Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} R`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('R', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} R`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('R', NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagResourceCommand) as TagResourceCommand[];
      expect(tag.map((c) => c.input)).toEqual([{ resourceArn: REPO_ARN, tags: DESIRED }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} R is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('R', NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    ) as Array<TagResourceCommand | UntagResourceCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { resourceArn: REPO_ARN, tagKeys: ['drop'] }],
      ['TagResourceCommand', { resourceArn: REPO_ARN, tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'R',
      NAME,
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
      'R',
      NAME,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} R holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('R', TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find(
      (c) => c instanceof CreateRepositoryCommand
    ) as CreateRepositoryCommand;
    expect(create.input.tags).toEqual(DESIRED);
  });

  it('creates with no tags field when Tags is absent', async () => {
    await provider.create('R', TYPE, { ...BASE });
    const create = commands().find(
      (c) => c instanceof CreateRepositoryCommand
    ) as CreateRepositoryCommand;
    expect(create.input.tags).toBeUndefined();
  });
});
