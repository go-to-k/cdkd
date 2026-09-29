import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4042: the rename-retry probe adopted ANY repository holding the
// desired RepositoryName once the old name was gone, then overwrote its
// description / key / tags / triggers and recorded it as this resource (which
// a later destroy deletes). It now adopts only a repository whose id is the
// recorded RepositoryId (go-to-k/cdkd#4051) or the one this provider instance
// read just before starting that rename.

const mockSend = vi.hoisted(() => vi.fn());

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
    warn: vi.fn(),
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
const OLD = 'issue4042-old';
const NEW = 'issue4042-new';
const ARN = 'arn:aws:codecommit:us-east-1:123456789012:issue4042';
const DESIRED = {
  RepositoryName: NEW,
  RepositoryDescription: 'desc',
  Tags: [{ Key: 'env', Value: 'prod' }],
};
const RECORDED = { RepositoryName: OLD, RepositoryDescription: 'old' };

/** The writes a refusal must never send to the repository holding the new name. */
const WRITES = [
  'UpdateRepositoryNameCommand',
  'UpdateRepositoryDescriptionCommand',
  'UpdateRepositoryEncryptionKeyCommand',
  'TagResourceCommand',
  'UntagResourceCommand',
  'PutRepositoryTriggersCommand',
];

function sentNames(): string[] {
  return mockSend.mock.calls.map((c) => c[0].constructor.name as string);
}

const gone = () =>
  Promise.reject(new RepositoryDoesNotExistException({ message: 'does not exist', $metadata: {} }));

/**
 * One account: our repository (`ours`, id `id-ours`) starts under OLD and
 * moves to NEW when a rename lands; `holderId` is the id of a repository that
 * already holds NEW when ours is not there (a foreign one). `failDescription`
 * fails the first description write, so attempt 1 stops after the rename.
 */
function primeAccount(opts: { oursUnder: string | undefined; holderId?: string }): {
  failNextDescription: () => void;
} {
  let oursUnder = opts.oursUnder;
  let failDescription = false;
  mockSend.mockImplementation(
    (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      switch (cmd.constructor.name) {
        case 'GetRepositoryCommand': {
          const name = cmd.input['repositoryName'];
          if (name === oursUnder) {
            return Promise.resolve({ repositoryMetadata: { repositoryId: 'id-ours', Arn: ARN } });
          }
          if (name === NEW && opts.holderId !== undefined) {
            return Promise.resolve({ repositoryMetadata: { repositoryId: opts.holderId, Arn: ARN } });
          }
          return gone();
        }
        case 'UpdateRepositoryNameCommand':
          if (cmd.input['oldName'] !== oursUnder) return gone();
          oursUnder = cmd.input['newName'] as string;
          return Promise.resolve({});
        case 'UpdateRepositoryDescriptionCommand':
          if (failDescription) {
            failDescription = false;
            return Promise.reject(new Error('throttled'));
          }
          return Promise.resolve({});
        default:
          return Promise.resolve({});
      }
    }
  );
  return {
    failNextDescription: () => {
      failDescription = true;
    },
  };
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

beforeEach(() => {
  mockSend.mockReset();
  provider = new CodeCommitRepositoryProvider();
});

describe('CodeCommit rename-retry probe verifies the repository id (#4042)', () => {
  it('matching id: a retry after this run renamed the repository adopts it', async () => {
    const account = primeAccount({ oursUnder: OLD });
    account.failNextDescription();
    await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));
    mockSend.mockClear();

    const result = await provider.update('Repo', OLD, TYPE, DESIRED, RECORDED);

    expect(result.physicalId).toBe(NEW);
    expect(sentNames()).toEqual([
      'GetRepositoryCommand', // old name: gone, the rename landed
      'GetRepositoryCommand', // the probe: the new name holds id-ours
      'UpdateRepositoryDescriptionCommand',
      'GetRepositoryCommand', // tag ARN
      'TagResourceCommand',
      'GetRepositoryCommand', // final read
    ]);
    expect(mockSend.mock.calls[2][0].input.repositoryName).toBe(NEW);
  });

  it('different id: the repository holding the new name is refused, with zero writes', async () => {
    // Attempt 1 read id-ours and started the rename, which did not land; the
    // old repository was then deleted out of band and a foreign one holds NEW.
    primeAccount({ oursUnder: OLD });
    mockSend.mockImplementationOnce(() =>
      Promise.resolve({ repositoryMetadata: { repositoryId: 'id-ours', Arn: ARN } })
    );
    mockSend.mockImplementationOnce(() => Promise.reject(new Error('throttled'))); // the rename
    await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));
    primeAccount({ oursUnder: undefined, holderId: 'id-foreign' });
    mockSend.mockClear();

    const err = await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));

    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err.message).toContain('its repository id is not the one cdkd holds for this resource');
    expect(err.message).toContain('nothing was sent to that repository');
    // A holder KNOWN not to be this resource is never offered for re-adoption.
    expect(err.message).not.toContain('cdkd import');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(sentNames().filter((n) => WRITES.includes(n))).toEqual([]);
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'GetRepositoryCommand']);
  });

  it('no evidence (a record from an earlier run, or a legacy one): refused, with zero writes', async () => {
    primeAccount({ oursUnder: undefined, holderId: 'id-ours' });

    const err = await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));

    expect(err.message).toMatch(/^CodeCommit Repository Repo no longer exists under the name cdkd recorded/);
    expect(err.message).toContain('this run started no rename of this resource');
    expect(err.message).toContain('its record holds no RepositoryId');
    // The recovery command, unwrapped, on its own line, last; the recorded
    // (old) name never appears.
    expect(err.message.endsWith(
      `\nRe-adopt with:\ncdkd import '<stack>' --resource 'Repo=${NEW}' --force`
    )).toBe(true);
    expect(err.message).not.toContain(OLD);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'GetRepositoryCommand']);
  });

  it('a desired RepositoryName the pasteable gate refuses prints as a hole in the command', async () => {
    const odd = 'issue4042\u0007new';
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
      cmd.constructor.name === 'GetRepositoryCommand' && cmd.input['repositoryName'] === odd
        ? Promise.resolve({ repositoryMetadata: { repositoryId: 'id-x', Arn: ARN } })
        : gone()
    );

    const err = await rejection(
      provider.update('Repo', OLD, TYPE, { ...DESIRED, RepositoryName: odd }, RECORDED)
    );

    expect(err.message.endsWith(
      `\ncdkd import '<stack>' --resource '<logicalId=repositoryName>' --force`
    )).toBe(true);
    expect(err.message).not.toContain('\u0007');
  });

  it('a rename call that finds the old name gone (after the id read) is verified the same way', async () => {
    // The id was read, then the old repository vanished before the rename.
    primeAccount({ oursUnder: OLD, holderId: 'id-foreign' });
    mockSend.mockImplementationOnce(() =>
      Promise.resolve({ repositoryMetadata: { repositoryId: 'id-ours', Arn: ARN } })
    );
    mockSend.mockImplementationOnce(() => gone());

    const err = await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));

    expect(err.message).toContain('its repository id is not the one cdkd holds for this resource');
    expect(sentNames()).toEqual([
      'GetRepositoryCommand',
      'UpdateRepositoryNameCommand',
      'GetRepositoryCommand',
    ]);
  });

  it('no evidence and a holder whose metadata carries no id: still refused, with zero writes', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
      cmd.constructor.name === 'GetRepositoryCommand' && cmd.input['repositoryName'] === NEW
        ? Promise.resolve({ repositoryMetadata: { Arn: ARN } })
        : gone()
    );

    const err = await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));

    expect(err.message).toContain('this run started no rename of this resource');
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'GetRepositoryCommand']);
  });

  it('a rename that fails other than not-found propagates, with no probe of the new name', async () => {
    primeAccount({ oursUnder: OLD });
    mockSend.mockImplementationOnce(() =>
      Promise.resolve({ repositoryMetadata: { repositoryId: 'id-ours', Arn: ARN } })
    );
    mockSend.mockImplementationOnce(() => Promise.reject(new Error('throttled')));

    const err = await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));

    expect(err.message).toContain('throttled');
    expect(isMarkedNonRetryable(err)).toBe(false);
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'UpdateRepositoryNameCommand']);
  });

  it('a rename call that finds the old name gone is adopted when the new-name holder is ours', async () => {
    // The id was read, then a concurrent rename of ours landed before our call.
    primeAccount({ oursUnder: NEW });
    mockSend.mockImplementationOnce(() =>
      Promise.resolve({ repositoryMetadata: { repositoryId: 'id-ours', Arn: ARN } })
    );

    const result = await provider.update('Repo', OLD, TYPE, DESIRED, RECORDED);

    expect(result.physicalId).toBe(NEW);
    expect(sentNames().slice(0, 4)).toEqual([
      'GetRepositoryCommand',
      'UpdateRepositoryNameCommand',
      'GetRepositoryCommand',
      'UpdateRepositoryDescriptionCommand',
    ]);
  });

  it('an id read with no id clears the evidence an earlier attempt left', async () => {
    // Attempt 1 recorded id-ours and failed before the rename landed.
    primeAccount({ oursUnder: OLD });
    mockSend.mockImplementationOnce(() =>
      Promise.resolve({ repositoryMetadata: { repositoryId: 'id-ours', Arn: ARN } })
    );
    mockSend.mockImplementationOnce(() => Promise.reject(new Error('throttled')));
    await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));
    // Attempt 2 reads the old name without an id, then the rename finds it gone
    // and ours (id-ours) holds the new name: no fresh evidence, so refused.
    primeAccount({ oursUnder: NEW });
    mockSend.mockImplementationOnce(() => Promise.resolve({ repositoryMetadata: { Arn: ARN } }));
    mockSend.mockClear();

    const err = await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));

    expect(err.message).toContain('this run started no rename of this resource');
  });

  it('a failed id read other than not-found propagates before any rename', async () => {
    mockSend.mockImplementationOnce(() => Promise.reject(new Error('AccessDenied')));

    const err = await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));

    expect(err.message).toContain('AccessDenied');
    expect(isMarkedNonRetryable(err)).toBe(false);
    expect(sentNames()).toEqual(['GetRepositoryCommand']);
  });

  it('the evidence is per old name: a success forgets it', async () => {
    primeAccount({ oursUnder: OLD });
    await provider.update('Repo', OLD, TYPE, DESIRED, RECORDED);
    // Same instance, same old name, but no rename is in flight any more.
    primeAccount({ oursUnder: undefined, holderId: 'id-ours' });
    mockSend.mockClear();

    const err = await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED));

    expect(err.message).toContain('this run started no rename of this resource');
  });
});

describe('CodeCommit rename-retry probe verifies against the RECORDED RepositoryId (#4051)', () => {
  const recorded = (repositoryId?: string) => ({
    recordedAttributes: repositoryId === undefined ? {} : { RepositoryId: repositoryId },
  });

  it('a fresh run adopts the repository under the new name when its id is the recorded one', async () => {
    // An earlier deploy's rename landed and it stopped before recording the
    // new name: this run holds no evidence of its own, the record does.
    primeAccount({ oursUnder: NEW });

    const result = await provider.update('Repo', OLD, TYPE, DESIRED, RECORDED, recorded('id-ours'));

    expect(result.physicalId).toBe(NEW);
    expect(sentNames()).toEqual([
      'GetRepositoryCommand', // old name: gone
      'GetRepositoryCommand', // the probe: id-ours, the recorded id
      'UpdateRepositoryDescriptionCommand',
      'GetRepositoryCommand',
      'TagResourceCommand',
      'GetRepositoryCommand',
    ]);
    expect(mockSend.mock.calls[2][0].input.repositoryName).toBe(NEW);
  });

  it('a holder whose id is not the recorded one is refused, zero writes, no re-adoption offered', async () => {
    primeAccount({ oursUnder: undefined, holderId: 'id-foreign' });

    const err = await rejection(
      provider.update('Repo', OLD, TYPE, DESIRED, RECORDED, recorded('id-ours'))
    );

    expect(err.message).toContain('its repository id is not the one cdkd holds for this resource');
    expect(err.message).not.toContain('cdkd import');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'GetRepositoryCommand']);
  });

  it.each([
    ['no RepositoryId key', { recordedAttributes: {} }],
    ['an empty RepositoryId', { recordedAttributes: { RepositoryId: '' } }],
    ['a non-string RepositoryId', { recordedAttributes: { RepositoryId: 42 } }],
    ['no recordedAttributes at all', {}],
  ])('a record with %s cannot verify the holder: refused with the re-adoption command', async (_l, ctx) => {
    primeAccount({ oursUnder: undefined, holderId: 'id-ours' });

    const err = await rejection(provider.update('Repo', OLD, TYPE, DESIRED, RECORDED, ctx));

    expect(err.message).toContain('its record holds no RepositoryId');
    expect(err.message).toContain('cdkd import');
    expect(sentNames().filter((n) => WRITES.includes(n))).toEqual([]);
  });

  it('the trigger read on a retry is verified against the recorded id too', async () => {
    primeAccount({ oursUnder: NEW });
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
      cmd.constructor.name === 'GetRepositoryTriggersCommand'
        ? cmd.input['repositoryName'] === OLD
          ? gone()
          : Promise.resolve({ triggers: [] })
        : base(cmd)
    );

    await provider.update(
      'Repo',
      OLD,
      TYPE,
      { ...DESIRED, Triggers: [] },
      { ...RECORDED, Triggers: {} },
      recorded('id-ours')
    );

    expect(
      mockSend.mock.calls
        .filter((c) => c[0].constructor.name === 'GetRepositoryTriggersCommand')
        .map((c) => c[0].input.repositoryName)
    ).toEqual([OLD, NEW]);
  });

  it('refuses before any call when the client region is not the recorded one', async () => {
    primeAccount({ oursUnder: OLD });

    // A malformed recorded Triggers, so the live trigger read would run first
    // if the region check came after it.
    const err = await rejection(
      provider.update('Repo', OLD, TYPE, DESIRED, { ...RECORDED, Triggers: {} }, {
        expectedRegion: 'eu-west-1',
        ...recorded('id-ours'),
      })
    );

    expect(err.message).toContain('eu-west-1');
    // The CLIENT's region was read and compared: an unknown-region refusal
    // would name only the recorded one.
    expect(err.message).toContain('us-east-1');
    expect(sentNames()).toEqual([]);
  });

  it('a recorded region matching the client proceeds with the update', async () => {
    primeAccount({ oursUnder: OLD });

    const result = await provider.update('Repo', OLD, TYPE, DESIRED, RECORDED, {
      expectedRegion: 'us-east-1',
      ...recorded('id-ours'),
    });

    expect(result.physicalId).toBe(NEW);
  });

  it('a repository under the RECORDED name whose id is not the recorded one is refused before the rename', async () => {
    // The recorded repository was deleted out of band and a foreign one took
    // its name: nothing may be renamed or written.
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
      cmd.constructor.name === 'GetRepositoryCommand' && cmd.input['repositoryName'] === OLD
        ? Promise.resolve({ repositoryMetadata: { repositoryId: 'id-foreign', Arn: ARN } })
        : gone()
    );

    const err = await rejection(
      provider.update('Repo', OLD, TYPE, DESIRED, RECORDED, recorded('id-ours'))
    );

    expect(err.message).toContain('no longer holds its recorded name');
    // The desired-name remedy would loop here: the recorded name is the one
    // every later update is addressed to.
    expect(err.message).toContain('Changing RepositoryName does not clear this');
    expect(err.message).not.toContain('Choose a RepositoryName');
    expect(err.message.endsWith(`\ncdkd orphan '<constructPath>'`)).toBe(true);
    expect(err.message).not.toContain('cdkd import');
    expect(err.message).not.toContain(OLD);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(sentNames()).toEqual(['GetRepositoryCommand']);
  });

  it('a repository under the recorded name with the recorded id is renamed as usual', async () => {
    primeAccount({ oursUnder: OLD });

    const result = await provider.update('Repo', OLD, TYPE, DESIRED, RECORDED, recorded('id-ours'));

    expect(result.physicalId).toBe(NEW);
    expect(sentNames().slice(0, 2)).toEqual(['GetRepositoryCommand', 'UpdateRepositoryNameCommand']);
  });
});
