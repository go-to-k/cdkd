/**
 * go-to-k/cdkd#4428: the EFS file-system `CreationToken` is scoped to the
 * stack, and a `FileSystemAlreadyExists` refusal is adopted only when it is a
 * replay of this process's own create.
 *
 * The CreateFileSystem API reference says a repeated creation token is refused
 * with `FileSystemAlreadyExists` naming the existing file system, so before
 * this change a lost-response retry FAILED rather than finding the file system
 * its first attempt made.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vite-plus/test';
import {
  CreateFileSystemCommand,
  DeleteFileSystemCommand,
  DescribeFileSystemsCommand,
  FileSystemAlreadyExists,
  FileSystemNotFound,
} from '@aws-sdk/client-efs';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-efs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-efs')>();
  return {
    ...actual,
    EFSClient: vi.fn().mockImplementation(() => ({
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

import { EFSProvider } from '../../../../src/provisioning/providers/efs-provider.js';
import { withStackName } from '../../../../src/provisioning/resource-name.js';
import { recordServerClockForTests } from '../../../../src/provisioning/providers/server-clock.js';
import {
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isRecreateRetryableError,
} from '../../../../src/deployment/retryable-errors.js';
import { allowUnscopedCreateTokensForTests } from '../../../../src/provisioning/providers/idempotency-token.js';

// These cases drive create() directly, outside a withStackName scope, so the
// stack-scoped create token (go-to-k/cdkd#4428) is opted out of its guard.
beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

const TYPE = 'AWS::EFS::FileSystem';
const HELD_ID = 'fs-held0000';
const HELD_ARN = `arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/${HELD_ID}`;

const alreadyExists = (attempts = 1): FileSystemAlreadyExists =>
  new FileSystemAlreadyExists({
    message: `File system '${HELD_ID}' already exists with creation token 'cdkd-x'`,
    $metadata: { httpStatusCode: 409, attempts },
    ErrorCode: 'FileSystemAlreadyExists',
    FileSystemId: HELD_ID,
  });

/** A 500: the request may have completed server-side with the response lost. */
const serverError = (): Error =>
  Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'InternalServerError',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/** A declared 400: the service says nothing was created. */
const badRequest = (): Error =>
  Object.assign(new Error('Bad request'), {
    name: 'BadRequest',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

const commandsSent = (cls: abstract new (...args: never[]) => object): number =>
  mockSend.mock.calls.filter(([cmd]) => cmd instanceof cls).length;

const creationTokens = (): string[] =>
  mockSend.mock.calls
    .filter(([cmd]) => cmd instanceof CreateFileSystemCommand)
    .map(([cmd]) => (cmd as CreateFileSystemCommand).input.CreationToken as string);

describe('EFS file-system CreationToken (go-to-k/cdkd#4428)', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new EFSProvider();
  });

  const answerCreate = (id: string): void => {
    mockSend
      .mockResolvedValueOnce({
        FileSystemId: id,
        CreationTime: new Date(),
        FileSystemArn: `arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/${id}`,
      })
      .mockResolvedValueOnce({ FileSystems: [{ LifeCycleState: 'available' }] });
  };

  it('differs between two stacks declaring the same logical id with the same inputs, and is stable within one', async () => {
    const props = { Encrypted: true, PerformanceMode: 'generalPurpose' };
    answerCreate('fs-dev');
    await withStackName('DevStack', () => provider.create('SharedFs', TYPE, props));
    answerCreate('fs-staging');
    await withStackName('StagingStack', () => provider.create('SharedFs', TYPE, props));
    answerCreate('fs-dev-again');
    await withStackName('DevStack', () => provider.create('SharedFs', TYPE, props));

    const [dev, staging, devAgain] = creationTokens();
    expect(dev).not.toBe(staging);
    expect(dev).toBe(devAgain);
  });

  it("keeps a long logical id's CreationToken within EFS's 64-character limit", async () => {
    answerCreate('fs-long');
    await provider.create(`Fs${'X'.repeat(120)}`, TYPE, {});
    expect(creationTokens()[0]).toHaveLength(64);
  });

  /** The holder read-back `sendCreateFileSystem` makes on a refusal. */
  const holder = (state: string, createdAt: Date) => ({
    FileSystems: [
      { FileSystemId: HELD_ID, LifeCycleState: state, CreationTime: createdAt, FileSystemArn: HELD_ARN },
    ],
  });
  const LONG_AGO = new Date(Date.now() - 86_400_000);

  it('adopts the file system a refused replay names when an EARLIER attempt of this create ended ambiguous', async () => {
    mockSend.mockRejectedValueOnce(serverError());
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow();

    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce(holder('creating', new Date()))
      .mockResolvedValueOnce({
        FileSystems: [{ LifeCycleState: 'available', FileSystemArn: `${HELD_ARN}-from-wait` }],
      });
    const result = await provider.create('MyFs', TYPE, {});

    expect(result.physicalId).toBe(HELD_ID);
    // No CreateFileSystem response carried an ARN; it is the holder read-back's.
    expect(result.attributes).toEqual({ Arn: HELD_ARN, FileSystemId: HELD_ID });
    const [first, second] = creationTokens();
    expect(second).toBe(first);
    expect(commandsSent(DeleteFileSystemCommand)).toBe(0);
  });

  it("adopts the file system when the refusal follows the SDK's own replay of this send", async () => {
    mockSend
      .mockRejectedValueOnce(alreadyExists(2))
      .mockResolvedValueOnce(holder('available', new Date()))
      .mockResolvedValueOnce({
        FileSystems: [{ LifeCycleState: 'available', FileSystemArn: HELD_ARN }],
      });
    const result = await provider.create('MyFs', TYPE, {});
    expect(result.physicalId).toBe(HELD_ID);
  });

  it('refuses a replay whose holder PREDATES the first send: a file system an earlier destroy retained', async () => {
    mockSend.mockRejectedValueOnce(serverError());
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow();

    mockSend
      .mockRejectedValueOnce(alreadyExists(2))
      .mockResolvedValueOnce(holder('available', LONG_AGO));
    const error = await provider.create('MyFs', TYPE, {}).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((error as Error).message).toContain('RemovalPolicy defaults to RETAIN');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(commandsSent(DeleteFileSystemCommand)).toBe(0);
  });

  it('refuses, non-retryably and without a name-collision reading, a token held by a file system this process did not make', async () => {
    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce(holder('available', LONG_AGO));

    const error = await provider.create('MyFs', TYPE, {}).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(HELD_ID);
    expect(message).toContain('NOT recorded in cdkd state');
    expect(message).toContain(`--creation-token ${creationTokens()[0]}`);
    expect(isMarkedNonRetryable(error)).toBe(true);
    // A `--replace` delete-first would delete the LIVE old file system and
    // then collide again: the holder is not it.
    expect(isNameCollisionErrorFrom(error, 'MyFs')).toBe(false);
    expect(commandsSent(DeleteFileSystemCommand)).toBe(0);
  });

  it('refuses, naming the read failure, when the holder cannot be read back', async () => {
    mockSend.mockRejectedValueOnce(serverError());
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow();

    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockRejectedValueOnce(
        Object.assign(new Error('User is not authorized'), {
          name: 'AccessDeniedException',
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        })
      );
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow(/could not read it back/);
    expect(commandsSent(DeleteFileSystemCommand)).toBe(0);
  });

  it.each(['deleting', 'deleted'])('rethrows EFS\'s own refusal, retryable at a delete-first re-create, while the holder is %s', async (state) => {
    // `--recreate-via-*`, the `--replace` delete-first fallback and a rollback
    // re-create delete the old file system, which keeps the SAME token while
    // it is deleting; those sites retry on the "already exists" wording.
    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce(holder(state, LONG_AGO));

    const error = await provider.create('MyFs', TYPE, {}).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(isRecreateRetryableError((error as Error).message)).toBe(true);
    // Ownership is not established, so no delete-first site may act on it.
    expect(isNameCollisionErrorFrom(error, 'MyFs')).toBe(false);
    expect(commandsSent(DeleteFileSystemCommand)).toBe(0);
  });

  it.each([
    [
      'the holder finished deleting (FileSystemNotFound)',
      () =>
        new FileSystemNotFound({
          message: `File system '${HELD_ID}' does not exist.`,
          $metadata: { httpStatusCode: 404 },
          ErrorCode: 'FileSystemNotFound',
        }),
    ],
    ['the read hit a 5xx', serverError],
    [
      'the read was throttled',
      () =>
        Object.assign(new Error('Rate exceeded'), {
          name: 'ThrottlingException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        }),
    ],
    [
      'the read failed with a bare FileSystemNotFound shape',
      () => ({ name: 'FileSystemNotFound', message: 'gone' }),
    ],
  ])('rethrows EFS\'s own refusal when %s, so the caller\'s retry decides', async (_label, describeFailure) => {
    mockSend.mockRejectedValueOnce(alreadyExists()).mockRejectedValueOnce(describeFailure());

    const error = await provider.create('MyFs', TYPE, {}).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(isRecreateRetryableError((error as Error).message)).toBe(true);
    // Ownership is not established, so no delete-first site may act on it.
    expect(isNameCollisionErrorFrom(error, 'MyFs')).toBe(false);
    expect(commandsSent(DeleteFileSystemCommand)).toBe(0);
  });

  it('refuses after an earlier attempt that FAILED DECLAREDLY (it made nothing)', async () => {
    mockSend.mockRejectedValueOnce(badRequest());
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow();

    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce(holder('available', new Date()));
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow(/NOT recorded in cdkd state/);
  });

  it('refuses once a create of the same token has SUCCEEDED (a later create is new, not a replay)', async () => {
    mockSend.mockRejectedValueOnce(serverError());
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow();
    answerCreate('fs-made');
    await provider.create('MyFs', TYPE, {});

    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce(holder('available', new Date()));
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow(/NOT recorded in cdkd state/);
  });

  it('refuses once the partial-create cleanup has deleted the file system the token named, even if EFS reports it live', async () => {
    const props = { LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }] };
    answerCreate('fs-rolled-back');
    mockSend
      .mockRejectedValueOnce(badRequest()) // PutLifecycleConfiguration
      .mockResolvedValueOnce({}); // DeleteFileSystem (the cleanup)
    await expect(provider.create('MyFs', TYPE, props)).rejects.toThrow();
    expect(commandsSent(DeleteFileSystemCommand)).toBe(1);

    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce(holder('available', new Date()));
    await expect(provider.create('MyFs', TYPE, props)).rejects.toThrow(
      /NOT recorded in cdkd state/
    );
  });

  it('does not let an ambiguous attempt in ANOTHER stack make this stack adopt', async () => {
    mockSend.mockRejectedValueOnce(serverError());
    await expect(
      withStackName('DevStack', () => provider.create('MyFs', TYPE, {}))
    ).rejects.toThrow();

    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce(holder('available', new Date()));
    await expect(
      withStackName('StagingStack', () => provider.create('MyFs', TYPE, {}))
    ).rejects.toThrow(/NOT recorded in cdkd state/);
  });
  describe('the creation-time gate, under a faked clock', () => {
    const T0 = new Date('2026-10-02T00:00:00Z').getTime();
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** What `withServerClock` records off the wire: AWS's `Date` for the answered attempt. */
    const awsDate = (cmd: object, serverDateMs: number): void =>
      recordServerClockForTests(cmd, {
        sentAtMs: Date.now(),
        receivedAtMs: Date.now(),
        serverDateMs,
      });

    /**
     * Attempt 1 ends ambiguous at the current local time; attempt 2 runs at
     * local `retryAt` and is refused with AWS's `Date: serverDateAtRetry`
     * (default: AWS agrees with this host).
     */
    const replayAt = async (
      retryAt: number,
      holderCreatedAt: number,
      serverDateAtRetry: number = retryAt
    ): Promise<unknown> => {
      mockSend.mockRejectedValueOnce(serverError());
      await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow();
      vi.setSystemTime(retryAt);
      mockSend
        .mockImplementationOnce(async (cmd: object) => {
          awsDate(cmd, serverDateAtRetry);
          throw alreadyExists();
        })
        .mockResolvedValueOnce(holder('available', new Date(holderCreatedAt)))
        .mockResolvedValueOnce({ FileSystems: [{ LifeCycleState: 'available' }] });
      return provider.create('MyFs', TYPE, {}).then(
        (r) => r.physicalId,
        (e: unknown) => e
      );
    };

    it('adopts a holder created between the first send and a retry a minute later', async () => {
      // Only the FIRST send's time admits it: the retry's own is 59s too late.
      expect(await replayAt(T0 + 60_000, T0 + 1_000)).toBe(HELD_ID);
    });

    it('adopts a holder created 4s before the first send (inside the skew margin)', async () => {
      expect(await replayAt(T0 + 60_000, T0 - 4_000)).toBe(HELD_ID);
    });

    it('refuses a holder created 6s before the first send (outside the skew margin)', async () => {
      const result = await replayAt(T0 + 60_000, T0 - 6_000);
      expect((result as Error).message).toMatch(/NOT recorded in cdkd state/);
    });

    it('adopts its own holder when the local clock runs 29s ahead of AWS', async () => {
      // First send at local T0+30s = AWS T0+1s; AWS made the file system at
      // T0+2s. On the local clock it would read as 28s older than the send.
      vi.setSystemTime(T0 + 30_000);
      expect(await replayAt(T0 + 90_000, T0 + 2_000, T0 + 61_000)).toBe(HELD_ID);
    });

    /** A create answered SUCCESS with a file system created at `createdAt`. */
    const succeedWith = async (createdAt: number, serverDateMs?: number): Promise<unknown> => {
      mockSend
        .mockImplementationOnce(async (cmd: object) => {
          if (serverDateMs !== undefined) awsDate(cmd, serverDateMs);
          return { FileSystemId: HELD_ID, FileSystemArn: HELD_ARN, CreationTime: new Date(createdAt) };
        })
        .mockResolvedValueOnce({ FileSystems: [{ LifeCycleState: 'available' }] });
      return provider.create('MyFs', TYPE, {}).then(
        (r) => r.physicalId,
        (e: unknown) => e
      );
    };

    it('takes an ordinary create when the local clock runs 30s ahead of AWS', async () => {
      vi.setSystemTime(T0 + 30_000);
      expect(await succeedWith(T0, T0 + 1_000)).toBe(HELD_ID);
    });

    it('takes a success created 4s before the send on AWS\'s clock', async () => {
      expect(await succeedWith(T0 - 4_000, T0)).toBe(HELD_ID);
    });

    it('refuses a success created 6s before the send on AWS\'s clock', async () => {
      expect(((await succeedWith(T0 - 6_000, T0)) as Error).message).toMatch(
        /NOT recorded in cdkd state/
      );
    });

    it('still refuses a success that hands back a file system kept hours ago, local clock ahead', async () => {
      vi.setSystemTime(T0 + 30_000);
      expect(((await succeedWith(T0 - 3 * 3_600_000, T0 + 1_000)) as Error).message).toMatch(
        /predates this create/
      );
    });

    it('with no Date header, falls back to the 5-minute bound: a minute old is taken, six minutes refused', async () => {
      expect(await succeedWith(T0 - 60_000)).toBe(HELD_ID);
      expect(((await succeedWith(T0 - 6 * 60_000)) as Error).message).toMatch(
        /predates this create/
      );
    });
  });

  it('refuses a replay whose holder carries no CreationTime', async () => {
    mockSend.mockRejectedValueOnce(serverError());
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow();

    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce({ FileSystems: [{ FileSystemId: HELD_ID, LifeCycleState: 'available' }] });
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow(/NOT recorded in cdkd state/);
  });

  it('keeps the token after an AMBIGUOUS attempt even when a later attempt fails declaredly', async () => {
    mockSend.mockRejectedValueOnce(serverError());
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow();
    mockSend.mockRejectedValueOnce(badRequest());
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow();

    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce(holder('available', new Date()))
      .mockResolvedValueOnce({ FileSystems: [{ LifeCycleState: 'available' }] });
    expect((await provider.create('MyFs', TYPE, {})).physicalId).toBe(HELD_ID);
  });

  it('adopts on a retry when the cleanup of an answered create could NOT delete the file system', async () => {
    const props = { LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }] };
    mockSend
      .mockResolvedValueOnce({ FileSystemId: HELD_ID, CreationTime: new Date(), FileSystemArn: HELD_ARN })
      .mockResolvedValueOnce({ FileSystems: [{ LifeCycleState: 'available' }] })
      .mockRejectedValueOnce(badRequest()) // PutLifecycleConfiguration
      .mockRejectedValueOnce(serverError()); // DeleteFileSystem (the cleanup) fails
    await expect(provider.create('MyFs', TYPE, props)).rejects.toThrow();

    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockResolvedValueOnce(holder('available', new Date()))
      .mockResolvedValueOnce({ FileSystems: [{ LifeCycleState: 'available' }] })
      .mockResolvedValueOnce({}); // PutLifecycleConfiguration
    expect((await provider.create('MyFs', TYPE, props)).physicalId).toBe(HELD_ID);
  });

  it('refuses, without reading anything back, a refusal that names no file system', async () => {
    mockSend.mockRejectedValueOnce(
      new FileSystemAlreadyExists({
        message: 'already exists',
        $metadata: { httpStatusCode: 409, attempts: 2 },
        ErrorCode: 'FileSystemAlreadyExists',
        FileSystemId: undefined,
      })
    );
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow(/\(not named by EFS\)/);
    expect(commandsSent(DescribeFileSystemsCommand)).toBe(0);
  });

  it('recognises the refusal by its NAME when the error is not the SDK class', async () => {
    mockSend
      .mockRejectedValueOnce({
        name: 'FileSystemAlreadyExists',
        message: 'already exists',
        FileSystemId: HELD_ID,
        $metadata: { httpStatusCode: 409, attempts: 2 },
      })
      .mockResolvedValueOnce(holder('available', new Date()))
      .mockResolvedValueOnce({ FileSystems: [{ LifeCycleState: 'available' }] });
    expect((await provider.create('MyFs', TYPE, {})).physicalId).toBe(HELD_ID);
  });

  it('refuses a create answered with no FileSystemId', async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(provider.create('MyFs', TYPE, {})).rejects.toThrow(/returned no FileSystemId/);
  });
  it.each([
    ['created long before the send', { CreationTime: LONG_AGO }, 'predates this create'],
    ['carrying no creation time', {}, 'no creation time'],
  ])(
    'refuses a SUCCESS response that hands back a file system %s (the User Guide reads a quick reuse as returning the original)',
    async (_label, extra, needle) => {
      mockSend.mockResolvedValueOnce({ FileSystemId: HELD_ID, FileSystemArn: HELD_ARN, ...extra });

      const error = await provider.create('MyFs', TYPE, {}).then(
        () => undefined,
        (e: unknown) => e
      );
      expect((error as Error).message).toContain('NOT recorded in cdkd state');
      expect((error as Error).message).toContain(needle);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(isNameCollisionErrorFrom(error, 'MyFs')).toBe(false);
      // Nothing waited on, configured or deleted: the create never took it.
      expect(mockSend).toHaveBeenCalledTimes(1);
    }
  );
});
