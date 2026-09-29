import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3989: `PutRepositoryTriggers` replaces the whole trigger set and
// the tag diff untags every recorded key the desired map lacks, and both lists
// used to read a present-but-malformed value (or a malformed entry) as empty.
// On a rollback (desired side = a recorded bag) `Triggers: {}` sent
// `triggers: []`, clearing every trigger. A malformed DESIRED list is now
// refused before any call; a malformed RECORDED list is applied ADD-only.

const mockSend = vi.hoisted(() => vi.fn());
const warned = vi.hoisted(() => [] as string[]);

vi.mock('@aws-sdk/client-codecommit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-codecommit')>();
  return {
    ...actual,
    CodeCommitClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warned.push(message);
    }),
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

import { RepositoryDoesNotExistException } from '@aws-sdk/client-codecommit';
import { CodeCommitRepositoryProvider } from '../../../../src/provisioning/providers/codecommit-repository-provider.js';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';

const TYPE = 'AWS::CodeCommit::Repository';
const REPO_ARN = 'arn:aws:codecommit:us-east-1:123456789012:issue3989-repo';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:issue3989';
const SECRET_REF = '{{resolve:secretsmanager:issue3989/topic:SecretString:arn::}}';
/** A distinctive needle per malformed value, so a message echoing it is caught. */
const NEEDLE = 'issue3989-needle';

const trigger = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  Name: name,
  DestinationArn: TOPIC,
  Events: ['all'],
  ...extra,
});

const sdkTrigger = (name: string): Record<string, unknown> => ({
  name,
  destinationArn: TOPIC,
  events: ['all'],
  branches: [],
});

const TRIGGERS_MALFORMED: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an object', { Name: NEEDLE }],
  ['a false', false],
  ['a null entry', [null]],
  ['an entry with no DestinationArn', [{ Name: NEEDLE, Events: ['all'] }]],
  ['an entry with an unresolved-intrinsic DestinationArn', [trigger('t', { DestinationArn: { Ref: NEEDLE } })]],
  ['an entry with no Name', [{ DestinationArn: TOPIC, Events: [NEEDLE] }]],
  ['an entry whose Branches is an object', [trigger('t', { Branches: { NEEDLE } })]],
  ['an entry whose Events is a string', [trigger('t', { Events: NEEDLE })]],
  ['an entry whose Events holds an object', [trigger('t', { Events: [{}] })]],
  ['an entry whose Branches holds an object', [trigger('t', { Branches: [{}] })]],
  ['a valid entry beside a malformed one', [trigger('t'), 7]],
];

const TAGS_MALFORMED: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an object', { Key: NEEDLE }],
  ['an entry with no Key', [{ Value: NEEDLE }]],
  ['an entry with an empty Key', [{ Key: '', Value: NEEDLE }]],
  ['a valid entry beside a malformed one', [{ Key: 'env', Value: 'dev' }, { Value: NEEDLE }]],
];

function sent(name: string): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0].constructor.name === name)
    .map((c) => c[0].input as Record<string, unknown>);
}

function sentNames(): string[] {
  return mockSend.mock.calls.map((c) => c[0].constructor.name as string);
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

let provider: CodeCommitRepositoryProvider;
let liveTriggers: unknown[] | Error;

beforeEach(() => {
  mockSend.mockReset();
  warned.length = 0;
  liveTriggers = [];
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'CreateRepositoryCommand':
      case 'GetRepositoryCommand':
        return Promise.resolve({
          repositoryMetadata: { repositoryName: 'issue3989-repo', repositoryId: 'id', Arn: REPO_ARN },
        });
      case 'GetRepositoryTriggersCommand':
        return liveTriggers instanceof Error
          ? Promise.reject(liveTriggers)
          : Promise.resolve({ triggers: liveTriggers });
      default:
        return Promise.resolve({});
    }
  });
  provider = new CodeCommitRepositoryProvider();
});

describe('Repository update — a malformed DESIRED list is refused before any call (#3989)', () => {
  it.each(TRIGGERS_MALFORMED)('Triggers: %s sends nothing, the rename included', async (_l, value) => {
    const err = await rejection(
      provider.update(
        'Repo',
        'issue3989-repo',
        TYPE,
        { RepositoryName: 'issue3989-renamed', Triggers: value },
        { RepositoryName: 'issue3989-repo', Triggers: [trigger('t')] }
      )
    );
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err.message).toMatch(/^desired Triggers of CodeCommit Repository Repo is not a list of triggers/);
    expect(err.message).toContain('the repository was not updated');
    expect(err.message).not.toContain(NEEDLE);
    expect(err.message).not.toContain('dynamic reference');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(TAGS_MALFORMED)('Tags: %s sends nothing', async (_l, value) => {
    const err = await rejection(
      provider.update(
        'Repo',
        'issue3989-repo',
        TYPE,
        { RepositoryName: 'issue3989-repo', Tags: value },
        { RepositoryName: 'issue3989-repo', Tags: [{ Key: 'team', Value: 'a' }] }
      )
    );
    expect(err.message).toMatch(/^desired Tags of CodeCommit Repository Repo is not a list of tags/);
    expect(err.message).not.toContain(NEEDLE);
    expect(err.message).not.toContain('dynamic reference');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses on a rollback replay too (the provider reads no context)', async () => {
    // The engine passes an UpdateContext the provider does not declare.
    const update = provider.update.bind(provider) as (...args: unknown[]) => Promise<unknown>;
    const err = await rejection(
      update(
        'Repo',
        'issue3989-repo',
        TYPE,
        { Triggers: {} },
        { Triggers: [trigger('t')] },
        { replayingState: true }
      )
    );
    expect(err.message).toMatch(/^desired Triggers/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a dynamic reference', SECRET_REF],
    ['its mask', '***'],
  ])('refuses a desired DestinationArn holding %s, naming the cause', async (_l, arn) => {
    const err = await rejection(
      provider.update(
        'Repo',
        'issue3989-repo',
        TYPE,
        { Triggers: [trigger('t', { DestinationArn: arn })] },
        {}
      )
    );
    expect(err.message).toContain('Triggers holds a dynamic reference or its mask');
    expect(err.message).not.toContain('secretsmanager');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('Repository update — more desired-side refusals (#3989 review)', () => {
  it('refuses a desired trigger Name holding a dynamic reference', async () => {
    const err = await rejection(
      provider.update('Repo', 'issue3989-repo', TYPE, { Triggers: [trigger(SECRET_REF)] }, {})
    );
    expect(err.message).toContain('Triggers holds a dynamic reference or its mask');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a desired tag Key holding a mask', async () => {
    const err = await rejection(
      provider.update('Repo', 'issue3989-repo', TYPE, { Tags: [{ Key: '***', Value: 'v' }] }, {})
    );
    expect(err.message).toContain('Tags holds a dynamic reference or its mask');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('names both lists when both are malformed', async () => {
    const err = await rejection(
      provider.update('Repo', 'issue3989-repo', TYPE, { Triggers: {}, Tags: {} }, {})
    );
    expect(err.message).toMatch(/^desired Triggers \/ Tags of CodeCommit Repository Repo/);
  });
});

describe('Repository update — valid lists (#3989 positive polarity)', () => {
  it('puts the desired trigger set and diffs tags, with no trigger read', async () => {
    await provider.update(
      'Repo',
      'issue3989-repo',
      TYPE,
      { Triggers: [trigger('b')], Tags: [{ Key: 'env', Value: 'prod' }] },
      {
        Triggers: [trigger('a')],
        Tags: [
          { Key: 'env', Value: 'dev' },
          { Key: 'team', Value: 'a' },
        ],
      }
    );
    expect(sentNames()).toEqual([
      'GetRepositoryCommand',
      'UntagResourceCommand',
      'TagResourceCommand',
      'PutRepositoryTriggersCommand',
      'GetRepositoryCommand',
    ]);
    expect(sent('PutRepositoryTriggersCommand')[0]).toEqual({
      repositoryName: 'issue3989-repo',
      triggers: [sdkTrigger('b')],
    });
    expect(sent('UntagResourceCommand')[0]).toEqual({ resourceArn: REPO_ARN, tagKeys: ['team'] });
  });

  it('a null desired Triggers still clears the recorded set (absent semantics)', async () => {
    await provider.update('Repo', 'issue3989-repo', TYPE, { Triggers: null }, { Triggers: [trigger('a')] });
    expect(sent('PutRepositoryTriggersCommand')).toEqual([
      { repositoryName: 'issue3989-repo', triggers: [] },
    ]);
  });

  it('keeps a recorded secret-derived tag Key out of the untag set', async () => {
    await provider.update(
      'Repo',
      'issue3989-repo',
      TYPE,
      { Tags: [] },
      {
        Tags: [
          { Key: SECRET_REF, Value: 'v' },
          { Key: 'team', Value: 'a' },
        ],
      }
    );
    expect(sent('UntagResourceCommand')).toEqual([{ resourceArn: REPO_ARN, tagKeys: ['team'] }]);
  });

  it('reads a legitimate a***b tag key as a plain key: it is untagged when dropped', async () => {
    await provider.update('Repo', 'issue3989-repo', TYPE, { Tags: [] }, { Tags: [{ Key: 'a***b', Value: 'v' }] });
    expect(sent('UntagResourceCommand')).toEqual([{ resourceArn: REPO_ARN, tagKeys: ['a***b'] }]);
  });

  it.each([
    ['Name', { Name: SECRET_REF }],
    ['DestinationArn', { DestinationArn: '***' }],
  ])('reads a recorded trigger whose %s is secret-derived as well-formed: no live read, the desired set put', async (_l, extra) => {
    await provider.update(
      'Repo',
      'issue3989-repo',
      TYPE,
      { Triggers: [trigger('a')] },
      { Triggers: [trigger('a', extra)] }
    );
    expect(sent('GetRepositoryTriggersCommand')).toHaveLength(0);
    expect(sent('PutRepositoryTriggersCommand')).toEqual([
      { repositoryName: 'issue3989-repo', triggers: [sdkTrigger('a')] },
    ]);
    expect(warned).toHaveLength(0);
  });
});

describe('Repository update — a malformed RECORDED list is applied ADD-only (#3989)', () => {
  it('Triggers: reads the live set before the rename and keeps the triggers the desired side omits', async () => {
    liveTriggers = [sdkTrigger('a'), sdkTrigger('manual')];
    await provider.update(
      'Repo',
      'issue3989-repo',
      TYPE,
      { RepositoryName: 'issue3989-renamed', Triggers: [trigger('a'), trigger('b')] },
      { RepositoryName: 'issue3989-repo', Triggers: [{ Name: 'a', DestinationArn: { Ref: 'Topic' } }] }
    );
    expect(sentNames()).toEqual([
      'GetRepositoryTriggersCommand',
      'UpdateRepositoryNameCommand',
      'PutRepositoryTriggersCommand',
      'GetRepositoryCommand',
    ]);
    expect(sent('GetRepositoryTriggersCommand')[0]).toEqual({ repositoryName: 'issue3989-repo' });
    expect(sent('PutRepositoryTriggersCommand')[0]).toEqual({
      repositoryName: 'issue3989-renamed',
      triggers: [sdkTrigger('a'), sdkTrigger('b'), sdkTrigger('manual')],
    });
    const warning = warned.find((w) => w.includes('recorded Triggers of CodeCommit Repository Repo'));
    expect(warning).toContain('holds 1 trigger(s) the desired Triggers does not name');
    expect(warning).not.toContain('manual');
  });

  it('Triggers: an absent desired list keeps every live trigger', async () => {
    liveTriggers = [sdkTrigger('manual')];
    await provider.update('Repo', 'issue3989-repo', TYPE, {}, { Triggers: 'unreadable' });
    // The put equals the live set, so nothing is sent.
    expect(sent('GetRepositoryTriggersCommand')).toHaveLength(1);
    expect(sent('PutRepositoryTriggersCommand')).toHaveLength(0);
    expect(warned.some((w) => w.includes('stay only until the next change to Triggers'))).toBe(true);
  });

  it('Triggers: a retry after the rename landed reads the live set under the new name', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      switch (cmd.constructor.name) {
        case 'GetRepositoryTriggersCommand':
          return cmd.input['repositoryName'] === 'issue3989-repo'
            ? Promise.reject(
                new RepositoryDoesNotExistException({ message: 'does not exist', $metadata: {} })
              )
            : Promise.resolve({ triggers: [sdkTrigger('manual')] });
        case 'UpdateRepositoryNameCommand':
          return Promise.reject(
            new RepositoryDoesNotExistException({ message: 'does not exist', $metadata: {} })
          );
        case 'GetRepositoryCommand':
          return Promise.resolve({
            repositoryMetadata: { repositoryName: 'issue3989-renamed', repositoryId: 'id', Arn: REPO_ARN },
          });
        default:
          return Promise.resolve({});
      }
    });
    await provider.update(
      'Repo',
      'issue3989-repo',
      TYPE,
      { RepositoryName: 'issue3989-renamed', Triggers: [trigger('a')] },
      { RepositoryName: 'issue3989-repo', Triggers: {} }
    );
    expect(sent('GetRepositoryTriggersCommand')).toEqual([
      { repositoryName: 'issue3989-repo' },
      { repositoryName: 'issue3989-renamed' },
    ]);
    expect(sent('PutRepositoryTriggersCommand')).toEqual([
      { repositoryName: 'issue3989-renamed', triggers: [sdkTrigger('a'), sdkTrigger('manual')] },
    ]);
  });

  it('Triggers: a rename whose new name is missing too refuses with no write', async () => {
    liveTriggers = new RepositoryDoesNotExistException({ message: 'does not exist', $metadata: {} });
    const err = await rejection(
      provider.update(
        'Repo',
        'issue3989-repo',
        TYPE,
        { RepositoryName: 'issue3989-renamed', Triggers: [trigger('a')] },
        { RepositoryName: 'issue3989-repo', Triggers: {} }
      )
    );
    expect(err.message).toContain('could not be read from CodeCommit');
    expect(sent('GetRepositoryTriggersCommand')).toEqual([
      { repositoryName: 'issue3989-repo' },
      { repositoryName: 'issue3989-renamed' },
    ]);
    expect(sentNames()).toEqual(['GetRepositoryTriggersCommand', 'GetRepositoryTriggersCommand']);
  });

  it('Triggers: a RepositoryName equal to the physical id is no rename: one read, no fallback', async () => {
    liveTriggers = new RepositoryDoesNotExistException({ message: 'does not exist', $metadata: {} });
    const err = await rejection(
      provider.update(
        'Repo',
        'issue3989-repo',
        TYPE,
        { RepositoryName: 'issue3989-repo', Triggers: [trigger('a')] },
        { Triggers: {} }
      )
    );
    expect(err.message).toContain('could not be read from CodeCommit');
    expect(sentNames()).toEqual(['GetRepositoryTriggersCommand']);
  });

  it('Triggers: without a rename, a missing repository is not retried under another name', async () => {
    liveTriggers = new RepositoryDoesNotExistException({ message: 'does not exist', $metadata: {} });
    const err = await rejection(
      provider.update('Repo', 'issue3989-repo', TYPE, { Triggers: [trigger('a')] }, { Triggers: {} })
    );
    expect(err.message).toContain('could not be read from CodeCommit');
    expect(sentNames()).toEqual(['GetRepositoryTriggersCommand']);
  });

  it('Triggers: a failed put names the kept live triggers (e.g. the 10-trigger limit)', async () => {
    liveTriggers = [sdkTrigger('m1'), sdkTrigger('m2')];
    const quota = new Error('MaximumRepositoryTriggersExceededException');
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'PutRepositoryTriggersCommand' ? Promise.reject(quota) : base(cmd)
    );
    const err = await rejection(
      provider.update('Repo', 'issue3989-repo', TYPE, { Triggers: [trigger('a')] }, { Triggers: {} })
    );
    expect(err.message).toContain('with 2 live trigger(s) the desired Triggers does not name kept');
    expect(err.message).toContain('at most 10 triggers');
    expect(err.message).toContain('MaximumRepositoryTriggersExceededException');
    // The retry classifies through the cause chain, which must reach the AWS error.
    expect(((err as ProvisioningError).cause as Error).cause).toBe(quota);
  });

  it('Triggers: a failed put with nothing kept propagates unchanged', async () => {
    liveTriggers = [];
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'PutRepositoryTriggersCommand'
        ? Promise.reject(new Error('InvalidDestination'))
        : base(cmd)
    );
    const err = await rejection(
      provider.update('Repo', 'issue3989-repo', TYPE, { Triggers: [trigger('a')] }, { Triggers: {} })
    );
    expect(err.message).toContain('InvalidDestination');
    expect(err.message).not.toContain('live trigger(s)');
  });

  it('Triggers: refuses, sending no write, when the live read fails — retryable', async () => {
    liveTriggers = new Error('Rate exceeded');
    const err = await rejection(
      provider.update(
        'Repo',
        'issue3989-repo',
        TYPE,
        { RepositoryName: 'issue3989-renamed', Triggers: [trigger('a')] },
        { RepositoryName: 'issue3989-repo', Triggers: {} }
      )
    );
    expect(err.message).toContain('could not be read from CodeCommit');
    expect(isMarkedNonRetryable(err)).toBe(false);
    // The retry classifies through `cause`, so the AWS error must ride there.
    expect(((err as ProvisioningError).cause as Error).message).toBe('Rate exceeded');
    expect(sentNames()).toEqual(['GetRepositoryTriggersCommand']);
  });

  it('Tags: tags the desired map and untags nothing', async () => {
    await provider.update(
      'Repo',
      'issue3989-repo',
      TYPE,
      { Tags: [{ Key: 'env', Value: 'prod' }] },
      { Tags: [{ Key: { Ref: 'Unresolved' }, Value: 'x' }] }
    );
    expect(sent('UntagResourceCommand')).toHaveLength(0);
    expect(sent('TagResourceCommand')).toEqual([{ resourceArn: REPO_ARN, tags: { env: 'prod' } }]);
    expect(warned.some((w) => w.includes('recorded Tags of CodeCommit Repository Repo'))).toBe(true);
  });

  it('Tags: sends no tag call when the desired map is empty', async () => {
    await provider.update('Repo', 'issue3989-repo', TYPE, {}, { Tags: {} });
    expect(sent('TagResourceCommand')).toHaveLength(0);
    expect(sent('UntagResourceCommand')).toHaveLength(0);
    expect(warned.some((w) => w.includes('recorded Tags of CodeCommit Repository Repo'))).toBe(true);
  });
});

describe('Repository create — a malformed list is refused before any call (#3989)', () => {
  it.each([
    ...TRIGGERS_MALFORMED.map(([l, v]) => [`Triggers: ${l}`, { Triggers: v }] as const),
    ...TAGS_MALFORMED.map(([l, v]) => [`Tags: ${l}`, { Tags: v }] as const),
  ])('%s', async (_l, props) => {
    const err = await rejection(
      provider.create('Repo', TYPE, { RepositoryName: 'issue3989-repo', ...props })
    );
    expect(err.message).toMatch(/of CodeCommit Repository Repo is not a list of/);
    expect(err.message).toContain('the repository was not created');
    expect(err.message).not.toContain(NEEDLE);
    expect(err.message).not.toContain('dynamic reference');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a trigger DestinationArn', { Triggers: [trigger('a', { DestinationArn: SECRET_REF })] }, 'Triggers'],
    ['a tag Key', { Tags: [{ Key: SECRET_REF, Value: 'v' }] }, 'Tags'],
  ])('names the dynamic-reference cause when %s holds one', async (_l, props, kind) => {
    const err = await rejection(
      provider.create('Repo', TYPE, { RepositoryName: 'issue3989-repo', ...props })
    );
    expect(err.message).toContain(`${kind} holds a dynamic reference or its mask`);
    expect(err.message).toContain('the repository was not created');
    expect(err.message).not.toContain('secretsmanager');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('puts valid triggers after CreateRepository', async () => {
    await provider.create('Repo', TYPE, {
      RepositoryName: 'issue3989-repo',
      Triggers: [trigger('a', { Branches: ['main'] })],
      Tags: [{ Key: 'env', Value: 'dev' }],
    });
    expect(sentNames()).toEqual(['CreateRepositoryCommand', 'PutRepositoryTriggersCommand']);
    expect(sent('CreateRepositoryCommand')[0]!['tags']).toEqual({ env: 'dev' });
    expect(sent('PutRepositoryTriggersCommand')[0]!['triggers']).toEqual([
      { ...sdkTrigger('a'), branches: ['main'] },
    ]);
  });
});
