/**
 * Issue #2177 — the EFS family's masked log sinks.
 *
 * `EFSProvider.create()` / `update()` now build ONE masked sink set per
 * operation from the context's masker and route every log line, and the AWS
 * error text a failure message wraps, through it. EFS has no user-chosen
 * physical name, so the bag values that reach a message are the
 * `BackupPolicy.Status` / `FileSystemProtection.ReplicationOverwriteProtection`
 * values (masked RAW) and AWS text quoting a request value back.
 *
 * Cases assert over the WHOLE transcript (every debug and warn line), not one
 * known line. The secrets are sized for the arm each case must isolate:
 *
 *  - `LONG`, which the message-level mask catches: it fences the AWS-echo sites
 *    (a thrown failure, the retry loops' per-attempt lines, the rollback and
 *    read-back lines), where only routing through the masker removes it;
 *  - `TINY_A` / `TINY_B`, two characters, below the masker's substring floor
 *    (`MIN_NEEDLE_LENGTH`) and in no fixed wording, so on a cdkd line only the
 *    RAW value mask `log.value(...)` can remove them.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

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

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

// These cases drive create() directly, outside a withStackName scope, so the
// stack-scoped create token (go-to-k/cdkd#4428) is opted out of its guard.
beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

/** Long enough for the message-level substring arm. */
const LONG = 'efs-secret-subnet-value';
/** Two-character secrets in no fixed wording: only a RAW value mask removes them. */
const TINY_A = 'qx';
const TINY_B = 'jv';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const maskSecrets = createSecretMasker(bagOf(LONG, TINY_A, TINY_B));

/** An AWS-authored failure (the marker fields `describeAwsFailure` keys on). */
const awsAuthored = (name: string, message: string, statusCode = 400): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: statusCode >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: statusCode, requestId: 'req-0123456789' },
  });

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Every debug and warn line the provider wrote, joined. */
const transcript = (): string =>
  [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((args) => String(args[0])).join('\n');

type Handler = (input: Record<string, unknown>) => unknown;

/**
 * A fake EFS answering by command name. A handler may throw; an absent one
 * answers `{}`. `DescribeFileSystems` defaults to an `available` file system
 * so the create/update waits return at once.
 */
function fakeEfs(handlers: Record<string, Handler | Handler[]>): void {
  const queues = new Map<string, Handler[]>();
  for (const [name, h] of Object.entries(handlers)) {
    queues.set(name, Array.isArray(h) ? [...h] : [h]);
  }
  mockSend.mockImplementation(async (command: { input: Record<string, unknown> }) => {
    const name = commandName(command);
    const queue = queues.get(name);
    if (queue && queue.length > 0) {
      const handler = queue.length > 1 ? queue.shift()! : queue[0]!;
      return handler(command.input);
    }
    if (name === 'CreateFileSystemCommand') {
      return { FileSystemId: 'fs-0123456789abcdef0', CreationTime: new Date(), FileSystemArn: 'arn:fs' };
    }
    if (name === 'DescribeFileSystemsCommand') {
      return { FileSystems: [{ LifeCycleState: 'available' }] };
    }
    return {};
  });
}

/** Run `promise` to completion, draining the provider's real-time backoffs. */
async function drain<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if (!result.ok) throw result.error;
  return result.value;
}

async function thrownMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await drain(promise);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the operation to throw');
}

describe('EFSProvider masked log sinks (issue #2177)', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    resetIdempotencyTokensForTests();
    mockSend.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
    provider = new EFSProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('bag values interpolated into cdkd lines are masked RAW', () => {
    it('create(): BackupPolicy Status and ReplicationOverwriteProtection', async () => {
      fakeEfs({});
      await drain(
        provider.create(
          'Fs',
          'AWS::EFS::FileSystem',
          {
            BackupPolicy: { Status: TINY_A },
            FileSystemProtection: { ReplicationOverwriteProtection: TINY_B },
          },
          { maskSecrets }
        )
      );
      const lines = transcript();
      expect(lines).toContain(`Set BackupPolicy Status=${SECRET_MASK} on EFS FileSystem`);
      expect(lines).toContain(
        `Set ReplicationOverwriteProtection=${SECRET_MASK} on EFS FileSystem`
      );
      expect(lines).not.toContain(TINY_A);
      expect(lines).not.toContain(TINY_B);
    });

    it('update(): BackupPolicy Status and ReplicationOverwriteProtection', async () => {
      fakeEfs({});
      await drain(
        provider.update(
          'Fs',
          'fs-0123456789abcdef0',
          'AWS::EFS::FileSystem',
          {
            BackupPolicy: { Status: TINY_A },
            FileSystemProtection: { ReplicationOverwriteProtection: TINY_B },
          },
          {},
          { maskSecrets }
        )
      );
      const lines = transcript();
      expect(lines).toContain(`Set BackupPolicy Status=${SECRET_MASK} on EFS FileSystem`);
      expect(lines).toContain(
        `Set ReplicationOverwriteProtection=${SECRET_MASK} on EFS FileSystem`
      );
      expect(lines).not.toContain(TINY_A);
      expect(lines).not.toContain(TINY_B);
    });

    it('an ordinary value renders unchanged (negative control)', async () => {
      fakeEfs({});
      await drain(
        provider.create(
          'Fs',
          'AWS::EFS::FileSystem',
          {
            BackupPolicy: { Status: 'ENABLED' },
            FileSystemProtection: { ReplicationOverwriteProtection: 'DISABLED' },
          },
          { maskSecrets }
        )
      );
      const lines = transcript();
      expect(lines).toContain('Set BackupPolicy Status=ENABLED on EFS FileSystem');
      expect(lines).toContain('Set ReplicationOverwriteProtection=DISABLED on EFS FileSystem');
    });

    it('no context: lines print unmasked (back-compat, absent means identity)', async () => {
      fakeEfs({});
      await drain(
        provider.create('Fs', 'AWS::EFS::FileSystem', { BackupPolicy: { Status: TINY_A } })
      );
      expect(transcript()).toContain(`Set BackupPolicy Status=${TINY_A} on EFS FileSystem`);
    });
  });

  describe('AWS text quoting a request value back', () => {
    const echo = (name = 'ValidationException', status = 400): Error =>
      awsAuthored(name, `Value '${LONG}' at 'subnetId' failed to satisfy constraint`, status);
    // The same text with only the secret masked: the diagnosis must survive the mask.
    const MASKED_ECHO = `Value '${SECRET_MASK}' at 'subnetId' failed to satisfy constraint`;

    it('create() FileSystem failure message', async () => {
      fakeEfs({
        CreateFileSystemCommand: () => {
          throw echo();
        },
      });
      const message = await thrownMessage(
        provider.create('Fs', 'AWS::EFS::FileSystem', {}, { maskSecrets })
      );
      expect(message).toContain('Failed to create EFS FileSystem Fs:');
      expect(message).not.toContain(LONG);
      expect(message).toContain(MASKED_ECHO);
      expect(message).toContain(SECRET_MASK);
    });

    it('create() FileSystem: the transient-retry line and the rollback warn', async () => {
      fakeEfs({
        PutFileSystemPolicyCommand: [
          () => {
            throw awsAuthored('ConflictException', `Policy on ${LONG} is being updated`);
          },
          () => {
            throw awsAuthored('ValidationException', 'bad policy');
          },
        ],
        DeleteFileSystemCommand: () => {
          throw echo('AccessDeniedException');
        },
      });
      const message = await thrownMessage(
        provider.create(
          'Fs',
          'AWS::EFS::FileSystem',
          { FileSystemPolicy: { Statement: [] } },
          { maskSecrets }
        )
      );
      expect(message).toContain('Failed to create EFS FileSystem Fs:');
      const lines = transcript();
      expect(lines).toContain('Transient error on "set FileSystemPolicy on fs-0123456789abcdef0"');
      expect(lines).toContain('Failed to roll back partially-created EFS FileSystem');
      expect(lines).not.toContain(LONG);
      // Each line keeps AWS's diagnosis with only the secret masked.
      expect(lines).toContain(`: Policy on ${SECRET_MASK} is being updated — retrying`);
      expect(lines).toContain(MASKED_ECHO);
    });

    it('update() FileSystem failure message', async () => {
      fakeEfs({
        UpdateFileSystemCommand: () => {
          throw echo();
        },
      });
      const message = await thrownMessage(
        provider.update(
          'Fs',
          'fs-0123456789abcdef0',
          'AWS::EFS::FileSystem',
          { ThroughputMode: 'elastic' },
          { ThroughputMode: 'bursting' },
          { maskSecrets }
        )
      );
      expect(message).toContain('Failed to update EFS FileSystem Fs:');
      expect(message).not.toContain(LONG);
      expect(message).toContain(MASKED_ECHO);
    });

    it('update() FileSystem: the transient-retry line', async () => {
      fakeEfs({
        PutBackupPolicyCommand: [
          () => {
            throw awsAuthored('ConflictException', `Backup for ${LONG} in progress`);
          },
          () => ({}),
        ],
      });
      await drain(
        provider.update(
          'Fs',
          'fs-0123456789abcdef0',
          'AWS::EFS::FileSystem',
          { BackupPolicy: { Status: 'ENABLED' } },
          {},
          { maskSecrets }
        )
      );
      const lines = transcript();
      expect(lines).toContain('Transient error on "set BackupPolicy on fs-0123456789abcdef0"');
      expect(lines).not.toContain(LONG);
      expect(lines).toContain(`: Backup for ${SECRET_MASK} in progress — retrying`);
    });

    it('create() MountTarget failure message', async () => {
      fakeEfs({
        CreateMountTargetCommand: () => {
          throw echo();
        },
      });
      const message = await thrownMessage(
        provider.create(
          'Mt',
          'AWS::EFS::MountTarget',
          { FileSystemId: 'fs-0123456789abcdef0', SubnetId: LONG },
          { maskSecrets }
        )
      );
      expect(message).toContain('Failed to create EFS MountTarget Mt:');
      expect(message).not.toContain(LONG);
      expect(message).toContain(MASKED_ECHO);
    });

    it('update() MountTarget failure message', async () => {
      fakeEfs({
        ModifyMountTargetSecurityGroupsCommand: () => {
          throw echo();
        },
      });
      const message = await thrownMessage(
        provider.update(
          'Mt',
          'fsmt-0123456789abcdef0',
          'AWS::EFS::MountTarget',
          { SecurityGroups: [LONG] },
          {},
          { maskSecrets }
        )
      );
      expect(message).toContain('Failed to update EFS MountTarget Mt:');
      expect(message).not.toContain(LONG);
      expect(message).toContain(MASKED_ECHO);
    });

    it('create() AccessPoint failure message', async () => {
      fakeEfs({
        CreateAccessPointCommand: () => {
          throw echo();
        },
      });
      const message = await thrownMessage(
        provider.create(
          'Ap',
          'AWS::EFS::AccessPoint',
          { FileSystemId: LONG },
          { maskSecrets }
        )
      );
      expect(message).toContain('Failed to create EFS AccessPoint Ap:');
      expect(message).not.toContain(LONG);
      expect(message).toContain(MASKED_ECHO);
    });

    it('create() AccessPoint: the adoption read-back failure line', async () => {
      fakeEfs({
        CreateAccessPointCommand: () => {
          throw Object.assign(awsAuthored('AccessPointAlreadyExists', 'exists', 409), {
            AccessPointId: 'fsap-0123456789abcdef0',
          });
        },
        DescribeAccessPointsCommand: () => {
          throw awsAuthored('AccessDeniedException', `not allowed on ${LONG}`, 403);
        },
      });
      await thrownMessage(
        provider.create(
          'Ap',
          'AWS::EFS::AccessPoint',
          { FileSystemId: 'fs-0123456789abcdef0' },
          { maskSecrets }
        )
      );
      const lines = transcript();
      expect(lines).toContain('Read-back of access point fsap-0123456789abcdef0 failed with:');
      expect(lines).not.toContain(LONG);
      expect(lines).toContain(`not allowed on ${SECRET_MASK}`);
    });

    it('create() AccessPoint: the decline warning carries a non-AWS read-back error masked', async () => {
      // A plain `Error` (a transport failure, say) is not AWS-authored, so
      // `describeAwsFailure(...).summary` is its message VERBATIM and reaches the
      // decline reason. An AWS-authored one is already redacted there.
      fakeEfs({
        CreateAccessPointCommand: () => {
          throw Object.assign(awsAuthored('AccessPointAlreadyExists', 'exists', 409), {
            AccessPointId: 'fsap-0123456789abcdef0',
          });
        },
        DescribeAccessPointsCommand: () => {
          throw new Error(`socket closed while reading ${LONG}`);
        },
      });
      await thrownMessage(
        provider.create(
          'Ap',
          'AWS::EFS::AccessPoint',
          { FileSystemId: 'fs-0123456789abcdef0' },
          { maskSecrets }
        )
      );
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain(
        `cdkd declined to adopt it: reading access point fsap-0123456789abcdef0 back failed: socket closed while reading ${SECRET_MASK}.`
      );
      expect(warned).not.toContain(LONG);
    });

    it('create() AccessPoint: the read-back retry lines go through the masked sink', async () => {
      const described = {
        AccessPoints: [
          {
            AccessPointId: 'fsap-0123456789abcdef0',
            AccessPointArn: 'arn:ap',
            FileSystemId: 'fs-0123456789abcdef0',
            ClientToken: '',
            RootDirectory: { Path: '/' },
            LifeCycleState: 'available',
          },
        ],
      };
      let sentToken = '';
      fakeEfs({
        CreateAccessPointCommand: (input) => {
          sentToken = String(input['ClientToken']);
          throw Object.assign(awsAuthored('AccessPointAlreadyExists', 'exists', 409), {
            AccessPointId: 'fsap-0123456789abcdef0',
          });
        },
        DescribeAccessPointsCommand: [
          () => {
            throw awsAuthored('InternalServerError', `internal error reading ${LONG}`, 500);
          },
          () => {
            described.AccessPoints[0]!.ClientToken = sentToken;
            return described;
          },
        ],
      });
      const result = await drain(
        provider.create(
          'Ap',
          'AWS::EFS::AccessPoint',
          { FileSystemId: 'fs-0123456789abcdef0' },
          { maskSecrets }
        )
      );
      expect(result.physicalId).toBe('fsap-0123456789abcdef0');
      const lines = transcript();
      expect(lines).toContain('Retrying');
      expect(lines).not.toContain(LONG);
      expect(lines).toContain(`internal error reading ${SECRET_MASK}`);
    });
  });

  describe('a masked failure still classifies as retryable (issue #4244)', () => {
    /** A secret that spells part of the retry table's `does not exist` wording. */
    const RETRY_WORD = 'exist';
    const retryMasker = createSecretMasker(bagOf(RETRY_WORD));
    const TRANSIENT = `Subnet subnet-0123456789abcdef0 does not exist`;
    const retryable = (error: Error): boolean =>
      isRetryableTransientError(error, retryClassificationText(error));

    async function thrown(promise: Promise<unknown>): Promise<Error> {
      try {
        await drain(promise);
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected the operation to throw');
    }

    const SITES = [
      {
        site: 'create() FileSystem',
        command: 'CreateFileSystemCommand',
        run: (masker: typeof retryMasker) =>
          provider.create('Fs', 'AWS::EFS::FileSystem', {}, { maskSecrets: masker }),
      },
      {
        site: 'update() FileSystem',
        command: 'UpdateFileSystemCommand',
        run: (masker: typeof retryMasker) =>
          provider.update(
            'Fs',
            'fs-0123456789abcdef0',
            'AWS::EFS::FileSystem',
            { ThroughputMode: 'elastic' },
            { ThroughputMode: 'bursting' },
            { maskSecrets: masker }
          ),
      },
      {
        site: 'create() MountTarget',
        command: 'CreateMountTargetCommand',
        run: (masker: typeof retryMasker) =>
          provider.create(
            'Mt',
            'AWS::EFS::MountTarget',
            { FileSystemId: 'fs-0123456789abcdef0', SubnetId: 'subnet-0123456789abcdef0' },
            { maskSecrets: masker }
          ),
      },
      {
        site: 'update() MountTarget',
        command: 'ModifyMountTargetSecurityGroupsCommand',
        run: (masker: typeof retryMasker) =>
          provider.update(
            'Mt',
            'fsmt-0123456789abcdef0',
            'AWS::EFS::MountTarget',
            { SecurityGroups: ['sg-1'] },
            {},
            { maskSecrets: masker }
          ),
      },
      {
        site: 'create() AccessPoint',
        command: 'CreateAccessPointCommand',
        run: (masker: typeof retryMasker) =>
          provider.create(
            'Ap',
            'AWS::EFS::AccessPoint',
            { FileSystemId: 'fs-0123456789abcdef0' },
            { maskSecrets: masker }
          ),
      },
    ] as const;

    it.each(SITES)('$site: the stamp keeps it retryable', async ({ command, run }) => {
      fakeEfs({
        [command]: () => {
          throw awsAuthored('BadRequest', TRANSIENT);
        },
      });
      const failure = await thrown(run(retryMasker));
      // Premise: the mask cut the retry wording out of the message itself.
      expect(failure.message).not.toContain('does not exist');
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryable(failure)).toBe(true);
    });

    it.each(SITES)('$site: a failure the mask left unchanged is not stamped', async ({ command, run }) => {
      fakeEfs({
        [command]: () => {
          throw awsAuthored('BadRequest', 'Bad request parameter');
        },
      });
      const failure = await thrown(run(retryMasker));
      expect(failure.message).toContain('Bad request parameter');
      expect(hasRedactedCause(failure)).toBe(false);
      expect(retryable(failure)).toBe(false);
    });
  });
});
