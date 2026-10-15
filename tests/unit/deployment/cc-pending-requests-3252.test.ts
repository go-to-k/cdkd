/**
 * `resolvePendingCloudControlRequests` (go-to-k/cdkd#3252): the next deploy,
 * destroy or rollback settles each journaled abandoned Cloud Control CREATE.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

const ccSchema = vi.hoisted(() => ({
  fields: undefined as readonly string[] | undefined,
  readOnly: undefined as ReadonlySet<string> | undefined,
}));
vi.mock('../../../src/provisioning/cc-import-identifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/cc-import-identifier.js')>()),
  getPrimaryIdentifierFields: () => Promise.resolve(ccSchema.fields),
}));
vi.mock('../../../src/provisioning/read-only-properties.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/read-only-properties.js')>()),
  getTopLevelReadOnlyProperties: () => Promise.resolve(ccSchema.readOnly),
}));
import {
  ccIdentifierIsUnique,
  resolvePendingCloudControlRequests,
  type AbandonedRequestReader,
  type PendingRequestJournal,
} from '../../../src/deployment/cc-pending-requests.js';
import type { FailedOperation } from '../../../src/deployment/rollback-executor.js';
import type {
  RollbackJournal,
  RollbackJournalSegment,
} from '../../../src/types/rollback-journal.js';
import type { AbandonedRequestOutcome } from '../../../src/provisioning/cloud-control-provider.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import type { Logger } from '../../../src/types/config.js';

function pendingOp(logicalId: string, token: string): FailedOperation {
  return {
    logicalId,
    changeType: 'CREATE',
    resourceType: 'AWS::Logs::LogGroup',
    provisionedBy: 'cc-api',
    deletionPolicy: 'Delete',
    attemptedProperties: { RetentionInDays: 1 },
    pendingCloudControlRequest: { requestToken: token, abandonedAt: 1 },
  };
}

function journalOf(...failedOperations: FailedOperation[]): RollbackJournal {
  return {
    journalVersion: 1,
    stackName: 'S',
    region: 'us-east-1',
    segments: [
      {
        timestamp: 1,
        reason: 'auto-rollback-clean',
        initialDeploy: false,
        operations: [],
        failedOperations,
      },
    ],
  };
}

/** An in-memory journal with the backend's rewrite semantics. */
function memoryJournal(initial: RollbackJournal | null): PendingRequestJournal & {
  current: () => RollbackJournal | null;
  writes: number;
} {
  let journal = initial === null ? null : structuredClone(initial);
  const store = {
    writes: 0,
    current: () => journal,
    loadRollbackJournal: vi.fn(() => Promise.resolve(journal === null ? null : structuredClone(journal))),
    rewriteRollbackJournalFailedOperations: vi.fn(
      (
        _s: string,
        _r: string,
        rewrite: (op: FailedOperation, seg: RollbackJournalSegment) => FailedOperation | null
      ) => {
        if (journal === null) return Promise.resolve(0);
        let changed = 0;
        for (const seg of journal.segments) {
          const next: FailedOperation[] = [];
          for (const op of seg.failedOperations ?? []) {
            const out = rewrite(op, seg);
            if (out !== op) changed++;
            if (out !== null) next.push(out);
          }
          if (next.length === 0) delete seg.failedOperations;
          else seg.failedOperations = next;
        }
        if (changed > 0) store.writes++;
        return Promise.resolve(changed);
      }
    ),
  };
  return store;
}

function readerOf(outcomes: Record<string, AbandonedRequestOutcome>): AbandonedRequestReader & {
  resumeAbandonedRequest: ReturnType<typeof vi.fn>;
} {
  return {
    resumeAbandonedRequest: vi.fn((token: string) => Promise.resolve(outcomes[token]!)),
    buildResumeCommand: (token: string) =>
      Promise.resolve(`aws cloudcontrol get-resource-request-status --request-token ${token}`),
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

const base = {
  stackName: 'S',
  region: 'us-east-1',
  command: 'deploy',
  // A unique (AWS-minted) identifier unless a case says otherwise; the
  // classifier itself is tested below.
  identifierUnique: () => Promise.resolve(true),
};

describe('resolvePendingCloudControlRequests (#3252)', () => {
  it('turns a create that made its resource into a proven orphan and drops the token', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    const log = logger();
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () => readerOf({ t1: { status: 'succeeded', identifier: 'my-group' } }),
      logger: log,
    });
    const [op] = journal.current()!.segments[0]!.failedOperations!;
    expect(op).toEqual({
      logicalId: 'Logs',
      changeType: 'CREATE',
      resourceType: 'AWS::Logs::LogGroup',
      provisionedBy: 'cc-api',
      deletionPolicy: 'Delete',
      attemptedProperties: { RetentionInDays: 1 },
      physicalId: 'my-group',
      physicalIdRecoveredFromError: true,
      createdIdentifierUnique: true,
    });
    expect(log.warn.mock.calls.join('\n')).toContain('my-group');
  });

  it('a FAILED create that left a remnant is a proven orphan too', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () => readerOf({ t1: { status: 'failed', remnant: 'half-made' } }),
      logger: logger(),
    });
    const [op] = journal.current()!.segments[0]!.failedOperations!;
    expect(op!.physicalId).toBe('half-made');
    expect(op!.physicalIdRecoveredFromError).toBe(true);
    expect(op!.pendingCloudControlRequest).toBeUndefined();
  });

  it.each([
    ['failed without a remnant', { status: 'failed' } as AbandonedRequestOutcome],
    ['cancelled', { status: 'cancelled' } as AbandonedRequestOutcome],
    ['no longer retained', { status: 'not-found' } as AbandonedRequestOutcome],
  ])('a create that %s keeps the op as a plain failed op, with no token', async (_n, outcome) => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () => readerOf({ t1: outcome }),
      logger: logger(),
    });
    const [op] = journal.current()!.segments[0]!.failedOperations!;
    expect(op!.pendingCloudControlRequest).toBeUndefined();
    expect(op!.physicalId).toBeUndefined();
    expect(op!.physicalIdRecoveredFromError).toBeUndefined();
    expect(op!.logicalId).toBe('Logs');
  });

  it('warns that an expired request may have left a resource to import or delete by hand', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    const log = logger();
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () => readerOf({ t1: { status: 'not-found' } }),
      logger: log,
    });
    const warned = log.warn.mock.calls.join('\n');
    expect(warned).toContain('seven days');
    expect(warned).toContain('cdkd import');
  });

  it('refuses while a request is still unknown, after persisting the ones that settled', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Done', 't1'), pendingOp('Running', 't2')));
    let thrown: unknown;
    try {
      await resolvePendingCloudControlRequests({
        ...base,
        journal,
        loaded: structuredClone(journal.current()),
        reader: () =>
          readerOf({
            t1: { status: 'succeeded', identifier: 'done-id' },
            t2: { status: 'unresolved', error: new Error('still IN_PROGRESS') },
          }),
        logger: logger(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe('CC_PENDING_REQUEST_UNRESOLVED');
    const message = (thrown as Error).message;
    expect(message).toContain('cdkd deploy of');
    expect(message).toContain('--request-token t2');
    expect(message).toContain('--drop-failed Running');
    expect(message).not.toContain('--drop-failed Done');
    const ops = journal.current()!.segments[0]!.failedOperations!;
    expect(ops.find((o) => o.logicalId === 'Done')!.physicalId).toBe('done-id');
    expect(ops.find((o) => o.logicalId === 'Running')!.pendingCloudControlRequest).toEqual({
      requestToken: 't2',
      abandonedAt: 1,
    });
  });

  it('a journal with no pending request reads nothing from AWS, writes nothing and takes no lock', async () => {
    const plain: FailedOperation = {
      logicalId: 'Other',
      changeType: 'UPDATE',
      resourceType: 'AWS::SNS::Topic',
    };
    const journal = memoryJournal(journalOf(plain));
    const reader = readerOf({});
    const underLock = vi.fn((settle: () => Promise<boolean>) => settle());
    const factory = vi.fn(() => reader);
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: factory,
      logger: logger(),
      underLock,
    });
    // Nothing constructed, nothing read: the caller's own read was the peek.
    expect(factory).not.toHaveBeenCalled();
    expect(journal.loadRollbackJournal).not.toHaveBeenCalled();
    expect(reader.resumeAbandonedRequest).not.toHaveBeenCalled();
    expect(underLock).not.toHaveBeenCalled();
    expect(journal.writes).toBe(0);
    await resolvePendingCloudControlRequests({
      ...base,
      journal: memoryJournal(null),
      loaded: null,
      reader: () => reader,
      logger: logger(),
    });
    expect(reader.resumeAbandonedRequest).not.toHaveBeenCalled();
  });

  it('a journal that cannot be re-read under the lock REFUSES rather than let the caller sweep it', async () => {
    const reader = readerOf({});
    const rewrite = vi.fn();
    const error = await resolvePendingCloudControlRequests({
      ...base,
      command: 'destroy',
      journal: {
        loadRollbackJournal: () => Promise.reject(new Error('corrupt')),
        rewriteRollbackJournalFailedOperations: rewrite,
      },
      loaded: journalOf(pendingOp('Logs', 't1')),
      reader: () => reader,
      logger: logger(),
      underLock: (settle) => settle(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CdkdError);
    expect((error as CdkdError).code).toBe('CC_PENDING_REQUEST_UNREADABLE');
    expect((error as Error).message).toContain('cdkd destroy of');
    expect(reader.resumeAbandonedRequest).not.toHaveBeenCalled();
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('under the lock the caller is told to re-read even when nothing was left to settle', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    const loaded = structuredClone(journal.current());
    // Another process settled it before the lock.
    await journal.rewriteRollbackJournalFailedOperations('S', 'us-east-1', (op) => {
      const { pendingCloudControlRequest: _p, ...rest } = op;
      return rest;
    });
    await expect(
      resolvePendingCloudControlRequests({
        ...base,
        journal,
        loaded,
        reader: () => readerOf({}),
        logger: logger(),
        underLock: (settle) => settle(),
      })
    ).resolves.toBe(true);
  });

  it('a request whose resource state already records is dropped, never orphaned', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      stateResources: { Logs: { physicalId: 'my-group' } },
      reader: () => readerOf({ t1: { status: 'succeeded', identifier: 'my-group' } }),
      logger: logger(),
    });
    const [op] = journal.current()!.segments[0]!.failedOperations!;
    expect(op!.pendingCloudControlRequest).toBeUndefined();
    expect(op!.physicalId).toBeUndefined();
    expect(op!.physicalIdRecoveredFromError).toBeUndefined();
  });

  it('a completed create the deploy resumes keeps its token; one it declines becomes an orphan', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Taken', 't1'), pendingOp('Declined', 't2')));
    const resume = vi.fn((op: FailedOperation) => op.logicalId === 'Taken');
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      stateResources: {},
      resume,
      reader: () =>
        readerOf({
          t1: { status: 'succeeded', identifier: 'taken-id' },
          t2: { status: 'succeeded', identifier: 'declined-id' },
        }),
      logger: logger(),
    });
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ logicalId: 'Taken' }), 'taken-id');
    const ops = journal.current()!.segments[0]!.failedOperations!;
    expect(ops.find((o) => o.logicalId === 'Taken')!.pendingCloudControlRequest).toEqual({
      requestToken: 't1',
      abandonedAt: 1,
    });
    expect(ops.find((o) => o.logicalId === 'Declined')!.physicalId).toBe('declined-id');
  });

  it('a FAILED create that left a remnant is never offered for resuming', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    const resume = vi.fn(() => true);
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      stateResources: {},
      resume,
      reader: () => readerOf({ t1: { status: 'failed', remnant: 'half' } }),
      logger: logger(),
    });
    expect(resume).not.toHaveBeenCalled();
    expect(journal.current()!.segments[0]!.failedOperations![0]!.physicalId).toBe('half');
  });

  it('a drop command that withholds a logical id says where to read it', async () => {
    const journal = memoryJournal(journalOf(pendingOp('not a plain id!', 't1')));
    const error = await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () => readerOf({ t1: { status: 'unresolved', error: new Error('x') } }),
      logger: logger(),
    }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('is shown as a <hole>');
    expect((error as Error).message).not.toContain('not a plain id!');
  });

  it('every request still unknown: nothing is written, the refusal names each with its region', async () => {
    const journal = memoryJournal(journalOf(pendingOp('A', 't1'), pendingOp('B', 't2')));
    const error = await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () =>
        readerOf({
          t1: { status: 'unresolved', error: new Error('') },
          t2: { status: 'unresolved', error: new Error('IN_PROGRESS') },
        }),
      logger: logger(),
    }).catch((e: unknown) => e);
    expect(journal.writes).toBe(0);
    const message = (error as Error).message;
    expect(message).toContain('--stack-region us-east-1 --drop-failed A');
    expect(message).toContain('--drop-failed B');
    // An empty reason prints no empty parentheses.
    expect(message).toContain('  - A (AWS::Logs::LogGroup)\n');
  });

  it('settling forces the cc-api route onto the orphan, whatever the op recorded', async () => {
    const journal = memoryJournal(
      journalOf({ ...pendingOp('Logs', 't1'), provisionedBy: undefined })
    );
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () => readerOf({ t1: { status: 'succeeded', identifier: 'id' } }),
      logger: logger(),
    });
    expect(journal.current()!.segments[0]!.failedOperations![0]!.provisionedBy).toBe('cc-api');
  });

  it('a caller already holding the lock settles from its own read, with no second read', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    await expect(
      resolvePendingCloudControlRequests({
        ...base,
        journal,
        loaded: structuredClone(journal.current()),
        reader: () => readerOf({ t1: { status: 'cancelled' } }),
        logger: logger(),
      })
    ).resolves.toBe(true);
    expect(journal.loadRollbackJournal).not.toHaveBeenCalled();
    expect(journal.writes).toBe(1);
  });

  it('settles under the lock and after the gate, re-reading the journal there', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    const order: string[] = [];
    const reader = readerOf({ t1: { status: 'succeeded', identifier: 'id' } });
    reader.resumeAbandonedRequest.mockImplementation(() => {
      order.push('poll');
      return Promise.resolve({ status: 'succeeded', identifier: 'id' });
    });
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () => reader,
      logger: logger(),
      beforeSettle: () => {
        order.push('gate');
        return Promise.resolve();
      },
      underLock: async (settle) => {
        order.push('lock');
        const settled = await settle();
        order.push('unlock');
        return settled;
      },
    });
    expect(order).toEqual(['lock', 'gate', 'poll', 'unlock']);
    // The caller's read is the peek; the one read here is under the lock.
    expect(journal.loadRollbackJournal).toHaveBeenCalledTimes(1);
  });

  it('a request settled by another process before the lock is not polled again', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    const reader = readerOf({});
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () => reader,
      logger: logger(),
      underLock: async (settle) => {
        // Another process settles it between the peek and the lock.
        await journal.rewriteRollbackJournalFailedOperations('S', 'us-east-1', (op) => {
          const { pendingCloudControlRequest: _p, ...rest } = op;
          return rest;
        });
        return settle();
      },
    });
    expect(reader.resumeAbandonedRequest).not.toHaveBeenCalled();
  });
});

describe('ccIdentifierIsUnique: may a delete or takeover trust the identifier? (#3252)', () => {
  const ask = (
    fields: readonly string[] | undefined,
    readOnly: readonly string[] | undefined,
    identifier: string,
    attemptedProperties: Record<string, unknown> | undefined = {},
    resourceType = 'AWS::Test::Thing'
  ) => {
    ccSchema.fields = fields;
    ccSchema.readOnly = readOnly && new Set(readOnly);
    return ccIdentifierIsUnique({
      resourceType,
      identifier,
      attemptedProperties,
      logicalId: 'Thing',
      stackName: 'MyStack',
    });
  };

  it.each([
    ['an id AWS mints (PrefixListId)', ['PrefixListId'], ['PrefixListId', 'Arn'], 'pl-0abc', { PrefixListName: 'n' }],
    ['a minted child under a sent parent (ResourceId|RestApiId)', ['ResourceId', 'RestApiId'], ['ResourceId'], 'r1a2b3|api123', { RestApiId: 'api123', PathPart: 'x' }],
    ['an ARN of minted parts', ['Arn'], ['Arn'], 'arn:aws:ec2:us-east-1:123456789012:prefix-list/pl-0abc', {}],
    ['a minted ARN beside a sent role ARN of the same account', ['Arn'], ['Arn'], 'arn:aws:acm:us-east-1:123456789012:certificate/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab', { RoleArn: 'arn:aws:iam::123456789012:role/Deployer', DomainName: 'example.com' }],
  ])('UNIQUE: %s', async (_n, fields, readOnly, id, bag) => {
    expect(await ask(fields, readOnly, id, bag)).toBe(true);
  });

  it.each([
    ['a name the CREATE sent (LogGroupName, writable)', ['LogGroupName'], ['Arn'], 'my-group', { LogGroupName: 'my-group' }],
    ['a read-only ARN that embeds the sent name (SNS TopicArn)', ['TopicArn'], ['TopicArn'], 'arn:aws:sns:us-east-1:1:my-topic', { TopicName: 'my-topic' }],
    ['a TopicArn beside a sent ARN of the same account', ['TopicArn'], ['TopicArn'], 'arn:aws:sns:us-east-1:1:my-topic', { TopicName: 'my-topic', KmsMasterKeyId: 'arn:aws:kms:us-east-1:1:key/k1' }],
    ['a read-only URL that embeds the sent name (SQS QueueUrl)', ['QueueUrl'], ['QueueUrl', 'Arn'], 'https://sqs.us-east-1.amazonaws.com/1/my-queue', { QueueName: 'my-queue' }],
    ['a name that differs only in case (RDS lowercases ids)', ['DBInstanceIdentifier'], ['DBInstanceIdentifier'], 'mydb', { DBInstanceIdentifier: 'MyDB' }],
    ['a name nested in the bag', ['Id'], ['Id'], 'inner-name', { Config: { Name: 'inner-name' } }],
    ['the name cdkd generates', ['Id'], ['Id'], 'MyStack-Thing', {}],
    ['a read-only ARN embedding a sent name that holds a slash', ['Arn'], ['Arn'], 'arn:aws:x:us-east-1:1:thing/team/svc', { Name: 'team/svc' }],
    ['a composite of names (MetricFilter LogGroupName|FilterName)', ['LogGroupName', 'FilterName'], [], 'g|f', { LogGroupName: 'g', FilterName: 'f' }],
    ['an identifier of another arity', ['Id'], ['Id'], 'a|b', {}],
  ])('NOT unique: %s', async (_n, fields, readOnly, id, bag) => {
    expect(await ask(fields, readOnly, id, bag)).toBe(false);
  });

  it('fails CLOSED when the schema cannot be read, or the bag carries a secret', async () => {
    expect(await ask(undefined, ['Id'], 'x-123')).toBe(false);
    expect(await ask(['Id'], undefined, 'x-123')).toBe(false);
    expect(await ask(['Id'], ['Id'], 'x-123', { Name: '{{resolve:secretsmanager:s}}' })).toBe(false);
    expect(await ask(['Id'], ['Id'], 'x-123', { Name: '***' })).toBe(false);
    // No bag at all: nothing to tell a name by.
    ccSchema.fields = ['Id'];
    ccSchema.readOnly = new Set(['Id']);
    expect(
      await ccIdentifierIsUnique({
        resourceType: 'AWS::Test::Thing',
        identifier: 'x-123',
        attemptedProperties: undefined,
        logicalId: 'Thing',
        stackName: 'MyStack',
      })
    ).toBe(false);
  });
});

describe('resolvePendingCloudControlRequests: what it prints and settles (#3252)', () => {
  it('never prints a value a {{resolve:}} reference put into the identifier', async () => {
    const op = {
      ...pendingOp('Filter', 't1'),
      resourceType: 'AWS::Logs::MetricFilter',
      attemptedProperties: { LogGroupName: '{{resolve:secretsmanager:grp}}', FilterName: 'f' },
    };
    for (const outcome of [
      { status: 'succeeded', identifier: 'TopSecretGroup|f' },
      { status: 'unresolved', error: new Error('CREATE of Filter ... named the resource TopSecretGroup|f') },
    ] as AbandonedRequestOutcome[]) {
      const journal = memoryJournal(journalOf(op));
      const log = logger();
      await resolvePendingCloudControlRequests({
        ...base,
        identifierUnique: () => Promise.resolve(false),
        journal,
        loaded: structuredClone(journal.current()),
        reader: () => readerOf({ t1: outcome }),
        logger: log,
      }).catch((e: unknown) => log.warn(String((e as Error).message)));
      const printed = [...log.info.mock.calls, ...log.warn.mock.calls].map(String).join('\n');
      expect(printed).not.toContain('TopSecretGroup');
    }
  });

  it('a cancelled CREATE that left its resource becomes an orphan, named', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    const log = logger();
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      reader: () => readerOf({ t1: { status: 'cancelled', remnant: 'half' } }),
      logger: log,
    });
    expect(journal.current()!.segments[0]!.failedOperations![0]!.physicalId).toBe('half');
    expect(log.warn.mock.calls.join('\n')).toContain('was cancelled');
  });

  it('state holding the logical id under ANOTHER physical id: the made resource is an orphan', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    const resume = vi.fn(() => true);
    await resolvePendingCloudControlRequests({
      ...base,
      journal,
      loaded: structuredClone(journal.current()),
      stateResources: { Logs: { physicalId: 'imported-other' } },
      resume,
      reader: () => readerOf({ t1: { status: 'succeeded', identifier: 'made' } }),
      logger: logger(),
    });
    expect(resume).not.toHaveBeenCalled();
    expect(journal.current()!.segments[0]!.failedOperations![0]!.physicalId).toBe('made');
  });

  it('a non-unique completed CREATE is never offered to a deploy, and says what to do', async () => {
    const journal = memoryJournal(journalOf(pendingOp('Logs', 't1')));
    const resume = vi.fn(() => true);
    const log = logger();
    await resolvePendingCloudControlRequests({
      ...base,
      identifierUnique: () => Promise.resolve(false),
      journal,
      loaded: structuredClone(journal.current()),
      stateResources: {},
      resume,
      reader: () => readerOf({ t1: { status: 'succeeded', identifier: 'my-group' } }),
      logger: log,
    });
    expect(resume).not.toHaveBeenCalled();
    expect(log.warn.mock.calls.join('\n')).toContain('Adopt it with cdkd import');
    const [op] = journal.current()!.segments[0]!.failedOperations!;
    expect(op!.physicalId).toBe('my-group');
    expect(op!.createdIdentifierUnique).toBeUndefined();
  });
});
