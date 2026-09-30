import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4157: a non-rename update and delete() addressed the repository
// by NAME alone. With the recorded repository deleted out of band and another
// created under the same name, cdkd overwrote the foreign repository and
// `cdkd destroy` deleted it. Both now compare the holder's id with the
// recorded RepositoryId first, and refuse a mismatch with nothing sent to it.

const mockSend = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

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
    warn: warnSpy,
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
import {
  CodeCommitRepositoryProvider,
  RECORDED_IDENTITY_DELETE_GUARD,
} from '../../../../src/provisioning/providers/codecommit-repository-provider.js';
import {
  isMarkedNonRetryable,
  retryClassificationText,
} from '../../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';
import { awsSdkError } from '../../_aws-sdk-error.js';

const TYPE = 'AWS::CodeCommit::Repository';
const NAME = 'issue4157-repo';
const RECORDED_ID = 'id-recorded';
const FOREIGN_ID = 'id-foreign';
const FOREIGN_ARN = 'arn:aws:codecommit:us-east-1:123456789012:issue4157-foreign';
const CONTENT = 'foreign description';

/** Every call that changes a repository. */
const WRITES = [
  'UpdateRepositoryNameCommand',
  'UpdateRepositoryDescriptionCommand',
  'UpdateRepositoryEncryptionKeyCommand',
  'TagResourceCommand',
  'UntagResourceCommand',
  'PutRepositoryTriggersCommand',
  'DeleteRepositoryCommand',
];

/** The already-deleted classifiers' needles: a refusal must carry none. */
const GONE_NEEDLES = [
  'does not exist',
  'was not found',
  'not found',
  'No policy found',
  'NoSuchEntity',
  'NotFoundException',
  'ResourceNotFoundException',
];

function sentNames(): string[] {
  return mockSend.mock.calls.map((c) => c[0].constructor.name as string);
}

function writesSent(): string[] {
  return sentNames().filter((n) => WRITES.includes(n));
}

const gone = () =>
  Promise.reject(new RepositoryDoesNotExistException({ message: 'does not exist', $metadata: {} }));

/**
 * The repository under NAME has id `holderId` (`undefined`: the name is held
 * by nothing). `getFails` makes GetRepository reject with it instead.
 */
function primeAccount(opts: {
  holderId: string | undefined;
  getFails?: unknown;
  holderWithoutId?: boolean;
  deleteReturnsNullId?: boolean;
  /** DeleteRepository reports deleting this id instead (a swap after the read). */
  deleteReturnsId?: string;
  /** DeleteRepository rejects with RepositoryDoesNotExistException. */
  deleteGone?: boolean;
}): void {
  mockSend.mockImplementation(
    (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      switch (cmd.constructor.name) {
        case 'GetRepositoryCommand':
          if (opts.getFails !== undefined) return Promise.reject(opts.getFails);
          if (opts.holderWithoutId) {
            return Promise.resolve({ repositoryMetadata: { repositoryName: NAME } });
          }
          if (opts.holderId === undefined) return gone();
          return Promise.resolve({
            repositoryMetadata: {
              repositoryId: opts.holderId,
              repositoryName: NAME,
              Arn: FOREIGN_ARN,
              repositoryDescription: CONTENT,
            },
          });
        case 'GetRepositoryTriggersCommand':
          return Promise.resolve({ triggers: [] });
        case 'DeleteRepositoryCommand':
          if (opts.deleteGone) return gone();
          if (opts.deleteReturnsId !== undefined) {
            return Promise.resolve({ repositoryId: opts.deleteReturnsId });
          }
          return Promise.resolve(
            opts.deleteReturnsNullId || opts.holderId === undefined
              ? {}
              : { repositoryId: opts.holderId }
          );
        default:
          return Promise.resolve({});
      }
    }
  );
}

async function caught(run: Promise<unknown>): Promise<Error> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** A refusal's shape: named, non-retryable, no content, a working remedy. */
function expectRefusal(error: Error): void {
  expect(error).toBeInstanceOf(ProvisioningError);
  expect(isMarkedNonRetryable(error)).toBe(true);
  expect(error.message).toContain('is not this resource');
  expect(error.message).toContain('cdkd orphan');
  // Names no content of the foreign repository.
  for (const content of [FOREIGN_ID, FOREIGN_ARN, CONTENT, RECORDED_ID]) {
    expect(error.message).not.toContain(content);
  }
  // A refusal read as "already gone" would drop the record.
  for (const needle of GONE_NEEDLES) expect(error.message).not.toContain(needle);
}

const RECORDED = { RepositoryName: NAME, RepositoryDescription: 'old' };
const DESIRED = { RepositoryName: NAME, RepositoryDescription: 'new', Tags: [{ Key: 'k', Value: 'v' }] };

describe('CodeCommitRepositoryProvider — recorded RepositoryId on a non-rename update (#4157)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses when the recorded name is held by another repository — no write, no read of its triggers', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    // A malformed recorded Triggers would otherwise read the holder's triggers.
    const error = await caught(
      provider.update('Repo', NAME, TYPE, DESIRED, { ...RECORDED, Triggers: {} }, {
        recordedAttributes: { RepositoryId: RECORDED_ID },
      })
    );
    expectRefusal(error);
    expect(writesSent()).toEqual([]);
    expect(sentNames()).toEqual(['GetRepositoryCommand']);
  });

  it('refuses even when nothing changed, so the holder is never recorded as this resource', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(
      provider.update('Repo', NAME, TYPE, RECORDED, RECORDED, {
        recordedAttributes: { RepositoryId: RECORDED_ID },
      })
    );
    expectRefusal(error);
    expect(sentNames()).toEqual(['GetRepositoryCommand']);
  });

  it('updates the recorded repository when its id matches', async () => {
    primeAccount({ holderId: RECORDED_ID });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.update('Repo', NAME, TYPE, DESIRED, RECORDED, {
      recordedAttributes: { RepositoryId: RECORDED_ID },
    });
    expect(result.attributes?.['RepositoryId']).toBe(RECORDED_ID);
    // The check comes first, then the writes.
    expect(sentNames()[0]).toBe('GetRepositoryCommand');
    expect(writesSent()).toEqual(['UpdateRepositoryDescriptionCommand', 'TagResourceCommand']);
  });

  it('a legacy record with no RepositoryId keeps the by-name update: the first call is the write', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    for (const context of [undefined, {}, { recordedAttributes: {} }, { recordedAttributes: { RepositoryId: '' } }, { recordedAttributes: { RepositoryId: 42 } }]) {
      mockSend.mockClear();
      await provider.update('Repo', NAME, TYPE, DESIRED, RECORDED, context);
      expect(sentNames()[0]).toBe('UpdateRepositoryDescriptionCommand');
    }
  });

  it('a failed read fails the update, retryably, before any write', async () => {
    primeAccount({ holderId: RECORDED_ID, getFails: awsSdkError('Rate exceeded', 'ThrottlingException') });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(
      provider.update('Repo', NAME, TYPE, DESIRED, RECORDED, {
        recordedAttributes: { RepositoryId: RECORDED_ID },
      })
    );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(error.message).toContain('Failed to update CodeCommit Repository Repo');
    expect(writesSent()).toEqual([]);
  });

  it('the rename path keeps its own check (#4051): a foreign holder of the recorded name is refused once', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(
      provider.update('Repo', NAME, TYPE, { ...DESIRED, RepositoryName: 'issue4157-new' }, RECORDED, {
        recordedAttributes: { RepositoryId: RECORDED_ID },
      })
    );
    expectRefusal(error);
    // The remedy names a free RepositoryName: orphaning alone collides again.
    expect(error.message).toContain('a name no repository holds');
    expect(sentNames()).toEqual(['GetRepositoryCommand']);
  });
});

describe('CodeCommitRepositoryProvider — recorded RepositoryId on update: other read answers (#4157)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const context = { recordedAttributes: { RepositoryId: RECORDED_ID } };

  it('a holder whose read carries no id is not refused (nothing identifies it as foreign)', async () => {
    primeAccount({ holderId: RECORDED_ID, holderWithoutId: true });
    const provider = new CodeCommitRepositoryProvider();
    await provider.update('Repo', NAME, TYPE, DESIRED, RECORDED, context);
    expect(writesSent()).toContain('UpdateRepositoryDescriptionCommand');
  });

  it('a recorded name held by nothing fails the update, retryably, before any write', async () => {
    primeAccount({ holderId: undefined });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(provider.update('Repo', NAME, TYPE, DESIRED, RECORDED, context));
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(error.message).toContain('Failed to update CodeCommit Repository Repo');
    expect(writesSent()).toEqual([]);
  });

  it("a denied read names the error class, never AWS's text", async () => {
    primeAccount({
      holderId: RECORDED_ID,
      getFails: awsSdkError(
        'User: arn:aws:sts::123456789012:assumed-role/role/session is not authorized',
        'AccessDeniedException'
      ),
    });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(provider.update('Repo', NAME, TYPE, DESIRED, RECORDED, context));
    expect(error.message).toContain('AccessDeniedException');
    expect(error.message).not.toContain('assumed-role');
    // The retry classifier still reads AWS's text (an IAM grant propagating).
    expect(retryClassificationText(error)).toContain('is not authorized');
    expect(writesSent()).toEqual([]);
  });

  it('a MASKED recorded id is no id: the by-name update is kept, not a refusal of its own repository', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    await provider.update('Repo', NAME, TYPE, DESIRED, RECORDED, {
      recordedAttributes: { RepositoryId: '***' },
    });
    expect(sentNames()[0]).toBe('UpdateRepositoryDescriptionCommand');
  });
});

describe('CodeCommitRepositoryProvider — recorded RepositoryId before DeleteRepository (#4157)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a holder with another id: nothing deleted, non-retryable, no content', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(
      provider.delete('Repo', NAME, TYPE, RECORDED, {
        expectedRegion: 'us-east-1',
        recordedAttributes: { RepositoryId: RECORDED_ID },
      })
    );
    expectRefusal(error);
    expect(sentNames()).toEqual(['GetRepositoryCommand']);
  });

  it('deletes the recorded repository when its id matches', async () => {
    primeAccount({ holderId: RECORDED_ID });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, {
      recordedAttributes: { RepositoryId: RECORDED_ID },
    });
    expect(result).toBeUndefined();
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'DeleteRepositoryCommand']);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'was not the one cdkd recorded'
    );
  });

  it('a legacy record with no RepositoryId keeps the by-name delete: no read first', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    for (const context of [undefined, {}, { recordedAttributes: {} }, { recordedAttributes: { RepositoryId: '' } }, { recordedAttributes: { RepositoryId: 42 } }]) {
      mockSend.mockClear();
      await provider.delete('Repo', NAME, TYPE, RECORDED, context);
      expect(sentNames()).toEqual(['DeleteRepositoryCommand']);
    }
    // No recorded id: nothing to compare the deleted id with.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'was not the one cdkd recorded'
    );
  });

  it('an already-gone repository is still a delete success', async () => {
    primeAccount({ holderId: undefined });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, {
      expectedRegion: 'us-east-1',
      recordedAttributes: { RepositoryId: RECORDED_ID },
    });
    expect(result).toBeUndefined();
    expect(writesSent()).toEqual([]);
  });

  it('an already-gone repository still runs the region check', async () => {
    primeAccount({ holderId: undefined });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(
      provider.delete('Repo', NAME, TYPE, RECORDED, {
        expectedRegion: 'eu-west-1',
        recordedAttributes: { RepositoryId: RECORDED_ID },
      })
    );
    expect(error.message).toMatch(/region/i);
  });

  it('a repository deleted between the read and the delete (a null id) is a delete success', async () => {
    primeAccount({ holderId: RECORDED_ID, deleteReturnsNullId: true });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, {
      expectedRegion: 'us-east-1',
      recordedAttributes: { RepositoryId: RECORDED_ID },
    });
    expect(result).toBeUndefined();
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'DeleteRepositoryCommand']);
  });

  it('a throttled read is retried by the caller: the delete is not sent', async () => {
    primeAccount({ holderId: FOREIGN_ID, getFails: awsSdkError('Rate exceeded', 'ThrottlingException') });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(
      provider.delete('Repo', NAME, TYPE, RECORDED, {
        recordedAttributes: { RepositoryId: RECORDED_ID },
      })
    );
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(error.message).toContain('Failed to delete CodeCommit Repository Repo');
    expect(writesSent()).toEqual([]);
  });

  it('a denied read proceeds and reports the guard, without AWS text in the reason', async () => {
    const denial =
      'User: arn:aws:sts::123456789012:assumed-role/role/session is not authorized to perform: codecommit:GetRepository';
    primeAccount({ holderId: RECORDED_ID, getFails: awsSdkError(denial, 'AccessDeniedException') });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, {
      recordedAttributes: { RepositoryId: RECORDED_ID },
    });
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'DeleteRepositoryCommand']);
    expect(result?.indeterminateGuards).toHaveLength(1);
    const guard = result!.indeterminateGuards![0]!;
    expect(guard.guard).toBe(RECORDED_IDENTITY_DELETE_GUARD);
    expect(guard.reason).not.toContain('assumed-role');
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('Proceeding with the delete');
    expect(warned).not.toContain('assumed-role');
  });

  it('a read returning no id proceeds and reports the guard', async () => {
    primeAccount({ holderId: RECORDED_ID, holderWithoutId: true });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, {
      recordedAttributes: { RepositoryId: RECORDED_ID },
    });
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'DeleteRepositoryCommand']);
    expect(result?.indeterminateGuards?.[0]?.guard).toBe(RECORDED_IDENTITY_DELETE_GUARD);
  });
});

describe('CodeCommitRepositoryProvider — delete: region, transient reads, guard propagation (#4157)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const context = { recordedAttributes: { RepositoryId: RECORDED_ID } };

  it('a client in another region is refused before the identity read, not reported as a foreign repository', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(
      provider.delete('Repo', NAME, TYPE, RECORDED, { ...context, expectedRegion: 'eu-west-1' })
    );
    expect(error.message).toMatch(/region/i);
    expect(error.message).not.toContain('cdkd orphan');
    expect(sentNames()).toEqual([]);
  });

  const transient: Array<[string, () => unknown]> = [
    [
      'a 5xx',
      () =>
        Object.assign(awsSdkError('Internal error', 'InternalServerException'), {
          $metadata: { httpStatusCode: 500 },
        }),
    ],
    ['a lost connection', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['a client timeout', () => Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
  ];
  for (const [label, make] of transient) {
    it(`${label} on the identity read is rethrown: the delete is not sent`, async () => {
      primeAccount({ holderId: FOREIGN_ID, getFails: make() });
      const provider = new CodeCommitRepositoryProvider();
      const error = await caught(provider.delete('Repo', NAME, TYPE, RECORDED, context));
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(writesSent()).toEqual([]);
    });
  }

  it('the guard reason names what could not be answered', async () => {
    primeAccount({
      holderId: RECORDED_ID,
      getFails: awsSdkError('denied', 'AccessDeniedException'),
    });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, context);
    const reason = result?.indeterminateGuards?.[0]?.reason ?? '';
    expect(reason).toContain('could not be read to compare its id');
    expect(reason).toContain('AccessDeniedException');
  });

  it('the no-id guard reason says so', async () => {
    primeAccount({ holderId: RECORDED_ID, holderWithoutId: true });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, context);
    expect(result?.indeterminateGuards?.[0]?.reason).toContain('no repository id');
  });

  it('the guard survives a delete that found the repository already gone (a null id)', async () => {
    primeAccount({
      holderId: RECORDED_ID,
      getFails: awsSdkError('denied', 'AccessDeniedException'),
      deleteReturnsNullId: true,
    });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, context);
    expect(result?.indeterminateGuards?.[0]?.guard).toBe(RECORDED_IDENTITY_DELETE_GUARD);
  });

  it('the guard survives a delete that found the repository already gone (an exception)', async () => {
    primeAccount({
      holderId: RECORDED_ID,
      getFails: awsSdkError('denied', 'AccessDeniedException'),
      deleteGone: true,
    });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, context);
    expect(sentNames()).toEqual(['GetRepositoryCommand', 'DeleteRepositoryCommand']);
    expect(result?.indeterminateGuards?.[0]?.guard).toBe(RECORDED_IDENTITY_DELETE_GUARD);
  });

  it('a MASKED recorded id still gets the region check: another region sends nothing', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    const error = await caught(
      provider.delete('Repo', NAME, TYPE, RECORDED, {
        recordedAttributes: { RepositoryId: '***' },
        expectedRegion: 'eu-west-1',
      })
    );
    expect(error.message).toMatch(/region/i);
    expect(sentNames()).toEqual([]);
  });

  it('a MASKED recorded id proceeds with the delete and reports the guard', async () => {
    primeAccount({ holderId: FOREIGN_ID });
    const provider = new CodeCommitRepositoryProvider();
    const result = await provider.delete('Repo', NAME, TYPE, RECORDED, {
      recordedAttributes: { RepositoryId: '***' },
    });
    expect(sentNames()).toEqual(['DeleteRepositoryCommand']);
    expect(result?.indeterminateGuards?.[0]?.reason).toContain('masked');
  });

  it('a delete that removed another id than the one checked is reported', async () => {
    primeAccount({ holderId: RECORDED_ID, deleteReturnsId: 'id-swapped' });
    const provider = new CodeCommitRepositoryProvider();
    await provider.delete('Repo', NAME, TYPE, RECORDED, context);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('was not the one cdkd recorded');
  });
});
