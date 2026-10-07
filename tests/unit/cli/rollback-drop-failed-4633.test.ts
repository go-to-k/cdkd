/**
 * `cdkd rollback <stack> --drop-failed <logicalId>` (go-to-k/cdkd#4633): drops
 * ONE journaled failed-CREATE orphan entry, under the stack lock, after a
 * confirmation, keeping every other entry and acting on nothing in AWS.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  dropFailedJournalEntry,
  dropTargetLines,
  refuseDropFailedConflicts,
  selectDropTarget,
} from '../../../src/cli/commands/rollback-drop-failed.js';
import {
  deleteJournaledOrphans,
  dropFailedHint,
  settleJournaledOrphansOnSuccess,
  type JournaledOrphans,
} from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { RollbackJournal, RollbackJournalSegment } from '../../../src/types/rollback-journal.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

const REGION = 'us-east-1';
const STACK_SHOWN = 'stack S (us-east-1)';

const orphan = (logicalId: string, extra: Record<string, unknown> = {}) => ({
  logicalId,
  changeType: 'CREATE',
  resourceType: 'AWS::SQS::QueuePolicy',
  physicalId: `https://sqs.us-east-1.amazonaws.com/123456789012/${logicalId.toLowerCase()}`,
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  attemptedProperties: {
    Queues: [`https://sqs.us-east-1.amazonaws.com/123456789012/${logicalId.toLowerCase()}`],
  },
  ...extra,
});

const seg = (
  failedOperations: unknown[],
  extra: Partial<RollbackJournalSegment> & Record<string, unknown> = {}
): RollbackJournalSegment =>
  ({
    timestamp: 1,
    runId: 'run-1',
    reason: 'no-rollback-failure',
    initialDeploy: false,
    operations: [],
    failedOperations,
    ...extra,
  }) as RollbackJournalSegment;

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

describe('selectDropTarget (go-to-k/cdkd#4633)', () => {
  it('picks the one proven orphan of the logical id, numbered as the plan numbers segments', () => {
    const target = selectDropTarget(
      [seg([orphan('Other')], { timestamp: 1 }), seg([orphan('Policy'), orphan('Kept')], { timestamp: 2 })],
      'Policy',
      STACK_SHOWN
    );
    expect(target.op.logicalId).toBe('Policy');
    expect(target.segmentNumber).toBe(2);
    expect(target.companions).toEqual([]);
  });

  it("takes the failed replacement UPDATE whose orphan it is along (go-to-k/cdkd#4604), and no other", () => {
    const newOne = orphan('Stream', {
      resourceType: 'AWS::Kinesis::Stream',
      physicalId: 'stream-b',
      replacedPhysicalId: 'stream-a',
      replacedResourceType: 'AWS::Kinesis::Stream',
    });
    const companion = { logicalId: 'Stream', changeType: 'UPDATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'stream-a' };
    const unrelated = { logicalId: 'Other', changeType: 'UPDATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'stream-a' };
    // Same logical id, but not the resource the orphan's replacement replaced.
    const sameIdOtherResource = { logicalId: 'Stream', changeType: 'UPDATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'stream-z' };
    const target = selectDropTarget([seg([companion, newOne, unrelated, sameIdOtherResource])], 'Stream', STACK_SHOWN);
    expect(target.op).toBe(newOne);
    expect(target.companions).toEqual([companion]);
  });

  it('a proven orphan beside a non-droppable entry of the same id is still the one', () => {
    const target = selectDropTarget(
      [seg([orphan('Policy', { physicalIdRecoveredFromError: false })], { timestamp: 1 }), seg([orphan('Policy')], { timestamp: 2 })],
      'Policy',
      STACK_SHOWN
    );
    expect(target.segmentNumber).toBe(2);
  });

  it.each([
    ['two proven entries of the id', [seg([orphan('Policy')], { timestamp: 1 }), seg([orphan('Policy')], { timestamp: 2 })], 'ROLLBACK_DROP_FAILED_AMBIGUOUS'],
    ['a failed UPDATE', [seg([{ logicalId: 'Policy', changeType: 'UPDATE', resourceType: 'AWS::SQS::QueuePolicy', physicalId: 'q' }])], 'ROLLBACK_DROP_FAILED_NOT_ORPHAN'],
    ['a failed CREATE with no proven id', [seg([orphan('Policy', { physicalIdRecoveredFromError: undefined })])], 'ROLLBACK_DROP_FAILED_NOT_ORPHAN'],
    ['a demoted orphan', [seg([orphan('Policy', { physicalIdRecoveredFromError: false })])], 'ROLLBACK_DROP_FAILED_NOT_ORPHAN'],
    [
      'an orphan of an id cdkd import adopted',
      [seg([orphan('Policy')], { importedResources: [{ logicalId: 'Policy', physicalId: 'x', resourceType: 'AWS::SQS::QueuePolicy' }] })],
      'ROLLBACK_DROP_FAILED_NOT_ORPHAN',
    ],
    ["an orphan in a nested child's pending segment", [seg([orphan('Policy')], { reason: 'nested-pending-parent' })], 'ROLLBACK_DROP_FAILED_NOT_ORPHAN'],
    [
      'a completed operation',
      [seg([orphan('Other')], { operations: [{ logicalId: 'Policy', changeType: 'CREATE', resourceType: 'AWS::SQS::QueuePolicy', physicalId: 'q' }] as never })],
      'ROLLBACK_DROP_FAILED_COMPLETED',
    ],
    ['an unknown id', [seg([orphan('Other')])], 'ROLLBACK_DROP_FAILED_UNKNOWN'],
    [
      'a failed UPDATE beside a completed op of the id (the failed one decides)',
      [
        seg([{ logicalId: 'Policy', changeType: 'UPDATE', resourceType: 'AWS::SQS::QueuePolicy', physicalId: 'q' }], {
          operations: [{ logicalId: 'Policy', changeType: 'CREATE', resourceType: 'AWS::SQS::QueuePolicy', physicalId: 'q' }] as never,
        }),
      ],
      'ROLLBACK_DROP_FAILED_NOT_ORPHAN',
    ],
  ])('refuses %s', (_label, segments, code) => {
    expect(codeOf(() => selectDropTarget(segments, 'Policy', STACK_SHOWN))).toBe(code);
  });

  it('an unknown id names the entries it could drop', () => {
    expect(() => selectDropTarget([seg([orphan('Other'), orphan('More')])], 'Policy', STACK_SHOWN)).toThrow(
      'Entries --drop-failed can drop: Other, More.'
    );
    expect(() => selectDropTarget([seg([])], 'Policy', STACK_SHOWN)).toThrow(
      'It holds no entry --drop-failed can drop.'
    );
  });

  it('describes a logical id that is not a plain identifier rather than printing it', () => {
    expect(() => selectDropTarget([seg([])], 'x\u001b[2Jy', STACK_SHOWN)).toThrow(
      'has no entry for a logical id that is not a plain identifier'
    );
  });
});

describe('refuseDropFailedConflicts (go-to-k/cdkd#4633)', () => {
  it.each([
    [{ orphan: ['A'] }, '--orphan'],
    [{ revertFailed: true }, '--revert-failed'],
    [{ skipFinalSnapshot: true }, '--skip-final-snapshot'],
  ])('refuses %o', (options, flag) => {
    expect(() => refuseDropFailedConflicts(options)).toThrow(`--drop-failed cannot be combined with ${flag}`);
  });

  it('lets the defaults through', () => {
    expect(() => refuseDropFailedConflicts({ orphan: [], revertFailed: false, skipFinalSnapshot: false })).not.toThrow();
  });
});

describe('dropFailedHint (go-to-k/cdkd#4633)', () => {
  it('names one pasteable command per logical id', () => {
    const hint = dropFailedHint('S', REGION, ['Policy', 'Policy', 'Topic']);
    expect(hint).toContain('\nDrop with: cdkd rollback S --stack-region us-east-1 --drop-failed Policy');
    expect(hint).toContain('\nDrop with: cdkd rollback S --stack-region us-east-1 --drop-failed Topic');
    expect(hint.match(/Drop with:/g)).toHaveLength(2);
  });

  it('withholds a logical id that is not a plain identifier, and says so', () => {
    const hint = dropFailedHint('S', REGION, ['--all']);
    expect(hint).toContain("--drop-failed '<logical-id>'");
    expect(hint).not.toContain('--all');
    expect(hint).toContain('A logical id that is not a plain identifier is not named');
  });

  it('withholds a stack name that is not a plain identifier, and says so', () => {
    const hint = dropFailedHint('bad name', REGION, ['Policy']);
    expect(hint).toContain("cdkd rollback '<stack>' --stack-region us-east-1 --drop-failed Policy");
    expect(hint).not.toContain('bad name');
    expect(hint).toContain("This stack's name");
  });

  it('withholds a region that is not a plain identifier, and says so', () => {
    const hint = dropFailedHint('S', 'us east', ['Policy']);
    expect(hint).toContain("cdkd rollback S --stack-region '<region>' --drop-failed Policy");
    expect(hint).not.toContain('us east');
    expect(hint).toContain("This stack's region");
  });

  it('is empty for no ids', () => {
    expect(dropFailedHint('S', REGION, [])).toBe('');
  });
});

/** A backend running the REAL single-entry removal over an in-memory journal. */
function backendOver(journal: RollbackJournal | null, stateResources: Record<string, unknown> = {}) {
  const store = { journal: structuredClone(journal), writes: 0 };
  const backend = Object.create(S3StateBackend.prototype) as S3StateBackend & Record<string, unknown>;
  backend['loadRollbackJournal'] = vi.fn(async () => structuredClone(store.journal));
  backend['getRollbackJournalKey'] = () => 'k';
  backend['putRawObject'] = vi.fn(async (_key: string, body: string) => {
    store.journal = JSON.parse(body) as RollbackJournal;
    store.writes++;
  });
  backend['getState'] = vi.fn(async () => ({ state: { resources: stateResources }, etag: 'e' })) as never;
  return { backend, store };
}

const journalOf = (...segments: RollbackJournalSegment[]): RollbackJournal => ({
  journalVersion: 1,
  stackName: 'S',
  region: REGION,
  segments,
});

describe('dropFailedJournalEntry (go-to-k/cdkd#4633)', () => {
  const lines: string[] = [];
  const order: string[] = [];
  const masked = (line: string): void => void lines.push(currentLogLineMasker()?.(line) ?? line);
  const logger = { debug: vi.fn(), info: vi.fn(masked), warn: vi.fn(masked), error: vi.fn() };
  let lockManager: { acquireLockWithRetry: ReturnType<typeof vi.fn>; releaseLock: ReturnType<typeof vi.fn> };
  const listeners = (): [number, number] => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  beforeEach(() => {
    lines.length = 0;
    order.length = 0;
    lockManager = {
      acquireLockWithRetry: vi.fn(async () => void order.push('lock')),
      releaseLock: vi.fn(async () => void order.push('release')),
    };
  });

  const run = (backend: S3StateBackend, logicalId: string, extra: Record<string, unknown> = {}) =>
    dropFailedJournalEntry({
      stateBackend: backend,
      lockManager: lockManager as never,
      stackName: 'S',
      region: REGION,
      logicalId,
      skipConfirmation: true,
      logger: logger as never,
      ...extra,
    });

  it('drops exactly the named entry and keeps every other, completed ops included', async () => {
    const completed = { logicalId: 'Marker', changeType: 'CREATE', resourceType: 'AWS::SSM::Parameter', physicalId: 'm' };
    const { backend, store } = backendOver(
      journalOf(
        // The same id, not proven: kept, as is everything else.
        seg([orphan('Policy', { physicalId: 'other-run', physicalIdRecoveredFromError: false })], {
          timestamp: 1,
          runId: 'run-0',
        }),
        seg([orphan('Kept')], { timestamp: 2, operations: [completed] as never }),
        seg([orphan('Policy'), orphan('AlsoKept')], { timestamp: 3, runId: 'run-2' })
      )
    );
    const before = structuredClone(store.journal!);

    const listenersBefore = listeners();
    await run(backend, 'Policy');

    // Both the SIGINT handler and the SIGTERM forwarder are removed.
    expect(listeners()).toEqual(listenersBefore);
    expect(store.writes).toBe(1);
    const after = store.journal!;
    // The whole written journal is the one read, minus exactly that entry.
    const expected = structuredClone(before);
    expected.segments[2]!.failedOperations = [before.segments[2]!.failedOperations![1]!];
    expect(after).toEqual(expected);
    expect(order).toEqual(['lock', 'release']);
    expect(lines.join('\n')).toContain("Dropped Policy's entry from the rollback journal of stack S (us-east-1)");
  });

  it("an older entry of the id naming the same resource is demoted by the newer one, so the newer one is dropped", async () => {
    const { backend, store } = backendOver(
      journalOf(seg([orphan('Policy')], { timestamp: 1, runId: 'run-0' }), seg([orphan('Policy')], { timestamp: 2 }))
    );
    await run(backend, 'Policy');
    expect(store.journal!.segments[0]!.failedOperations).toHaveLength(1);
    expect(store.journal!.segments[1]!.failedOperations).toBeUndefined();
  });

  it('removes the companion UPDATE with its orphan (go-to-k/cdkd#4604)', async () => {
    const newOne = orphan('Stream', {
      resourceType: 'AWS::Kinesis::Stream',
      physicalId: 'stream-b',
      replacedPhysicalId: 'stream-a',
      replacedResourceType: 'AWS::Kinesis::Stream',
      attemptedProperties: {},
    });
    const companion = { logicalId: 'Stream', changeType: 'UPDATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'stream-a' };
    const { backend, store } = backendOver(journalOf(seg([companion, newOne, orphan('Kept')])));
    await run(backend, 'Stream');
    expect(store.journal!.segments[0]!.failedOperations!.map((o) => o.logicalId)).toEqual(['Kept']);
  });

  it('a segment left with no failed op loses the field and stays', async () => {
    const { backend, store } = backendOver(journalOf(seg([orphan('Policy')])));
    await run(backend, 'Policy');
    expect(store.journal!.segments).toHaveLength(1);
    expect(store.journal!.segments[0]!.failedOperations).toBeUndefined();
  });

  it.each([
    ['no journal', null, 'ROLLBACK_DROP_FAILED_NO_JOURNAL'],
    ['an unknown id', journalOf(seg([orphan('Other')])), 'ROLLBACK_DROP_FAILED_UNKNOWN'],
    ['a not-proven entry', journalOf(seg([orphan('Policy', { physicalIdRecoveredFromError: false })])), 'ROLLBACK_DROP_FAILED_NOT_ORPHAN'],
    ['two proven entries of the id in one segment', journalOf(seg([orphan('Policy'), orphan('Policy', { physicalId: 'twin' })])), 'ROLLBACK_DROP_FAILED_AMBIGUOUS'],
    [
      "an identical twin in a nested child's pending segment of the same run",
      journalOf(seg([orphan('Policy')], { reason: 'nested-pending-parent' }), seg([orphan('Policy')])),
      'ROLLBACK_DROP_FAILED_AMBIGUOUS',
    ],
  ])('refuses %s without writing, and releases the lock', async (_label, journal, code) => {
    const { backend, store } = backendOver(journal as RollbackJournal | null);
    const listenersBefore = listeners();
    await expect(run(backend, 'Policy')).rejects.toMatchObject({ code });
    expect(listeners()).toEqual(listenersBefore);
    expect(store.writes).toBe(0);
    expect(order).toEqual(['lock', 'release']);
  });

  it('refuses an entry the supersede pass demotes (a newer completed CREATE of its type), as destroy does', async () => {
    const { backend, store } = backendOver(
      journalOf(
        seg([orphan('Policy')], { timestamp: 1 }),
        seg([], {
          timestamp: 2,
          operations: [{ logicalId: 'Other', changeType: 'CREATE', resourceType: 'AWS::SQS::QueuePolicy', physicalId: 'x' }] as never,
        })
      )
    );
    await expect(run(backend, 'Policy')).rejects.toMatchObject({ code: 'ROLLBACK_DROP_FAILED_NOT_ORPHAN' });
    expect(store.writes).toBe(0);
    // The judged copy, not the stored journal, carries the demotion.
    expect(store.journal!.segments[0]!.failedOperations![0]!.physicalIdRecoveredFromError).toBe(true);
  });

  describe('fails closed when the state record cannot be read (it masks the entry)', () => {
    const SECRET_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/team-secret-queue';
    const journal = () =>
      journalOf(seg([orphan('Policy', { physicalId: SECRET_URL, attemptedProperties: { Queues: [SECRET_URL] } })]));

    it('a read that throws: refused, nothing printed or written', async () => {
      const { backend, store } = backendOver(journal());
      (backend.getState as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ThrottlingException'));
      await expect(run(backend, 'Policy')).rejects.toMatchObject({ code: 'ROLLBACK_DROP_FAILED_STATE_UNREADABLE' });
      expect(store.writes).toBe(0);
      expect(lines.join('\n')).not.toContain('team-secret-queue');
      expect(order).toEqual(['lock', 'release']);
    });

    it.each([['resources that are not a bag', { resources: 'x' }]])('%s: refused, nothing written', async (_l, state) => {
      const { backend, store } = backendOver(journal());
      (backend.getState as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state, etag: 'e' });
      await expect(run(backend, 'Policy')).rejects.toMatchObject({ code: 'ROLLBACK_DROP_FAILED_STATE_UNREADABLE' });
      expect(store.writes).toBe(0);
    });

    it('no state record at all is read as empty, and the drop proceeds', async () => {
      const { backend, store } = backendOver(journal());
      (backend.getState as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      await run(backend, 'Policy');
      expect(store.writes).toBe(1);
    });
  });

  it.each([
    ['the other entry journaled the name as its reference', '{{resolve:secretsmanager:team:SecretString:queue::}}', false],
    ['negative control, a literal name', 'team-secret-queue', true],
  ])('masks a name another journal entry holds (one printing bag over every failed entry): %s', async (_l, queueName, shown) => {
    const SECRET_QUEUE = 'team-secret-queue';
    const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${SECRET_QUEUE}`;
    const { backend } = backendOver(
      journalOf(
        seg([
          orphan('Queue', { resourceType: 'AWS::SQS::Queue', physicalId: URL, attemptedProperties: { QueueName: queueName } }),
          orphan('Policy', { physicalId: URL, attemptedProperties: { Queues: [URL] } }),
        ])
      )
    );
    await run(backend, 'Policy');
    const printed = lines.filter((l) => l.startsWith('  - Policy') || l.startsWith('      - '));
    expect(printed).toHaveLength(2);
    for (const line of printed) expect(line.includes(SECRET_QUEUE)).toBe(shown);
  });

  it('reports a write that removed another count than expected', async () => {
    const { backend } = backendOver(journalOf(seg([orphan('Policy')])));
    (backend as unknown as Record<string, unknown>)['dropRollbackJournalFailedOperations'] = vi.fn(async () => 2);
    await expect(run(backend, 'Policy')).rejects.toMatchObject({ code: 'ROLLBACK_DROP_FAILED_CHANGED' });
    expect(order).toEqual(['lock', 'release']);
  });

  it('warns, naming only the error class, when the lock cannot be released', async () => {
    const { backend, store } = backendOver(journalOf(seg([orphan('Policy')])));
    lockManager.releaseLock.mockRejectedValueOnce(Object.assign(new Error('secret detail'), { name: 'AccessDenied' }));
    await run(backend, 'Policy');
    expect(store.writes).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('Failed to release the lock of stack S (us-east-1): AccessDenied');
    expect(text).not.toContain('secret detail');
  });

  it('reads nothing when the lock cannot be taken', async () => {
    const { backend, store } = backendOver(journalOf(seg([orphan('Policy')])));
    lockManager.acquireLockWithRetry.mockRejectedValueOnce(new Error('locked by another process'));
    const listenersBefore = listeners();
    await expect(run(backend, 'Policy')).rejects.toThrow('locked by another process');
    expect(listeners()).toEqual(listenersBefore);
    expect(backend.loadRollbackJournal).not.toHaveBeenCalled();
    expect(store.writes).toBe(0);
    expect(lockManager.releaseLock).not.toHaveBeenCalled();
  });

  it('asks before it writes, and a "no" writes nothing', async () => {
    const { backend, store } = backendOver(journalOf(seg([orphan('Policy')])));
    const confirm = vi.fn(async () => false);
    await run(backend, 'Policy', { skipConfirmation: false, confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(store.writes).toBe(0);
    expect(lines.join('\n')).toContain('Drop cancelled');
  });

  it('a "yes" writes', async () => {
    const { backend, store } = backendOver(journalOf(seg([orphan('Policy')])));
    await run(backend, 'Policy', { skipConfirmation: false, confirm: vi.fn(async () => true) });
    expect(store.writes).toBe(1);
  });

  it('a signal before the write stops it: nothing written, lock released', async () => {
    const { backend, store } = backendOver(journalOf(seg([orphan('Policy')])));
    const confirm = vi.fn(async () => {
      // This run's own SIGINT listener, registered last; never a real signal.
      const own = process.listeners('SIGINT').at(-1) as (signal: string) => void;
      own('SIGINT');
      return true;
    });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(run(backend, 'Policy', { skipConfirmation: false, confirm })).rejects.toMatchObject({
        code: 'ROLLBACK_DROP_FAILED_INTERRUPTED',
      });
    } finally {
      write.mockRestore();
    }
    expect(store.writes).toBe(0);
    expect(order).toEqual(['lock', 'release']);
  });

  it('a signal during the reads stops it before the prompt', async () => {
    const { backend, store } = backendOver(journalOf(seg([orphan('Policy')])));
    const outside = new Set(process.listeners('SIGINT'));
    lockManager.acquireLockWithRetry.mockImplementationOnce(async () => {
      order.push('lock');
      // Fire only this run's own listeners; never a real signal.
      for (const l of process.listeners('SIGINT')) if (!outside.has(l)) (l as (s: string) => void)('SIGINT');
    });
    const confirm = vi.fn(async () => true);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(run(backend, 'Policy', { skipConfirmation: false, confirm })).rejects.toMatchObject({
        code: 'ROLLBACK_DROP_FAILED_INTERRUPTED',
      });
    } finally {
      write.mockRestore();
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(store.writes).toBe(0);
    expect(order).toEqual(['lock', 'release']);
  });

  it('refuses the prompt without a terminal and writes nothing', async () => {
    const { backend, store } = backendOver(journalOf(seg([orphan('Policy')])));
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await expect(run(backend, 'Policy', { skipConfirmation: false })).rejects.toMatchObject({
        code: 'NON_INTERACTIVE_CONFIRM',
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
    expect(store.writes).toBe(0);
    expect(order).toEqual(['lock', 'release']);
  });

  it('prints the entry and the targets it was attached to, and says nothing is deleted in AWS', async () => {
    const { backend } = backendOver(journalOf(seg([orphan('Policy')])));
    await run(backend, 'Policy');
    const text = lines.join('\n');
    expect(text).toContain(
      '  - Policy (AWS::SQS::QueuePolicy)  https://sqs.us-east-1.amazonaws.com/123456789012/policy  [failed CREATE, segment 1/1]'
    );
    expect(text).toContain('    Queues it was attached to:\n      - https://sqs.us-east-1.amazonaws.com/123456789012/policy');
    expect(text).toContain('Nothing is deleted in AWS');
  });

  describe('masks a secret-derived name in what it prints (go-to-k/cdkd#3869)', () => {
    const SECRET_QUEUE = 'team-secret-queue';
    const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${SECRET_QUEUE}`;

    it.each([
      ['a name the entry journaled as its reference', '{{resolve:secretsmanager:team:SecretString:queue::}}', false],
      ['negative control, a literal name', SECRET_QUEUE, true],
    ])("on the entry's own physical id: %s", async (_l, queueName, shown) => {
      const { backend } = backendOver(
        journalOf(
          seg([
            orphan('Queue', {
              resourceType: 'AWS::SQS::Queue',
              physicalId: URL,
              attemptedProperties: { QueueName: queueName },
            }),
          ])
        )
      );
      await run(backend, 'Queue');
      const listing = lines.find((l) => l.startsWith('  - Queue (AWS::SQS::Queue)'));
      expect(listing).toBeDefined();
      expect(listing!.includes(SECRET_QUEUE)).toBe(shown);
    });

    it.each([
      ['a queue whose state record names it by reference', '{{resolve:secretsmanager:team:SecretString:queue::}}', false],
      ['negative control, a literal name', SECRET_QUEUE, true],
    ])('on a policy target read from a state record: %s', async (_l, queueName, shown) => {
      const { backend } = backendOver(
        journalOf(
          seg([
            orphan('Policy', {
              physicalId: URL,
              attemptedProperties: { Queues: [URL], PolicyDocument: { Statement: [] } },
            }),
          ])
        ),
        {
          Queue: {
            physicalId: URL,
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: queueName },
            attributes: { QueueName: SECRET_QUEUE, QueueUrl: URL },
            dependencies: [],
          },
        }
      );
      await run(backend, 'Policy');
      const printed = lines.filter((l) => l.startsWith('  - Policy') || l.startsWith('      - '));
      expect(printed).toHaveLength(2);
      for (const line of printed) expect(line.includes(SECRET_QUEUE)).toBe(shown);
    });
  });
});

describe('dropTargetLines (go-to-k/cdkd#4633)', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  it.each(['constructor', 'toString', '__proto__'])('reads no target property for a journal type named %s', (type) => {
    // An inherited lookup would yield a function or `Object.prototype`, whose
    // string form is the key below: own keys only, so nothing is listed.
    const op = orphan('Policy', {
      resourceType: type,
      attemptedProperties: { Queues: ['x'], '[object Object]': ['x'], [String(Object.prototype.toString)]: ['x'], [String(Object)]: ['x'] },
    });
    expect(
      dropTargetLines({ segment: seg([op]), segmentNumber: 1, op: op as never, companions: [] }, 1, logger as never)
    ).toHaveLength(1);
  });

  it('describes a target that is not a string, and lists no targets for another type', () => {
    const policy = orphan('Policy', { attemptedProperties: { Queues: [{ Ref: 'Q' }] } });
    expect(
      dropTargetLines({ segment: seg([policy]), segmentNumber: 1, op: policy as never, companions: [] }, 1, logger as never)
    ).toContain('      - a value that is not a string');
    const stream = orphan('Stream', { resourceType: 'AWS::Kinesis::Stream', attemptedProperties: { Queues: ['x'] } });
    expect(
      dropTargetLines({ segment: seg([stream]), segmentNumber: 1, op: stream as never, companions: [] }, 1, logger as never)
    ).toHaveLength(1);
  });
});

describe('the retry warnings name --drop-failed (go-to-k/cdkd#4633)', () => {
  const IDENTITY = 'arn:aws:kinesis:us-east-1:123456789012:stream/x|1700000000';
  const stream = (logicalId: string, extra: Record<string, unknown> = {}) =>
    orphan(logicalId, {
      resourceType: 'AWS::Kinesis::Stream',
      physicalId: `${logicalId}-stream`,
      attemptedProperties: {},
      createdResourceIdentity: IDENTITY,
      ...extra,
    });

  function ctxWith(deleteImpl: (logicalId: string) => Promise<unknown>) {
    // go-to-k/cdkd#4655: a name-keyed orphan's live identity, read before a
    // successful deploy's delete; `IDENTITY` matches the one journaled below.
    const provider = {
      delete: vi.fn((logicalId: string) => deleteImpl(logicalId)),
      resourceIdentity: vi.fn(async () => IDENTITY),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
    const ctx = {
      providerRegistry: {
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getProvider: vi.fn().mockReturnValue(provider),
      },
      region: REGION,
      logger,
    } as unknown as RollbackExecutorContext;
    return { ctx, logger, provider };
  }
  const warned = (logger: { warn: ReturnType<typeof vi.fn> }): string =>
    logger.warn.mock.calls.map((c) => String(c[0])).join('\n');

  it("cdkd destroy's delete of the journaled orphans names the one whose delete failed, and only it", async () => {
    const { ctx, logger } = ctxWith(async (id) => {
      if (id === 'Stuck') throw new Error('AccessDeniedException');
    });
    const orphans: JournaledOrphans = { segments: [{ segment: seg([]), ops: [stream('Stuck'), stream('Gone')] as never }], count: 2 };
    const outcome = await deleteJournaledOrphans(orphans, {}, 'S', ctx);
    expect(outcome.failures).toBe(1);
    const text = warned(logger);
    expect(text).toContain('Drop with: cdkd rollback S --stack-region us-east-1 --drop-failed Stuck');
    expect(text).not.toContain('--drop-failed Gone');
  });

  it('says nothing when every delete succeeded, or when the caller prints its own warning', async () => {
    const ok = ctxWith(async () => undefined);
    await deleteJournaledOrphans({ segments: [{ segment: seg([]), ops: [stream('Gone')] as never }], count: 1 }, {}, 'S', ok.ctx);
    expect(warned(ok.logger)).not.toContain('--drop-failed');
    const failing = ctxWith(async () => {
      throw new Error('AccessDeniedException');
    });
    await deleteJournaledOrphans(
      { segments: [{ segment: seg([]), ops: [stream('Stuck')] as never }], count: 1 },
      {},
      'S',
      failing.ctx,
      { pointAtDrop: false }
    );
    expect(warned(failing.logger)).not.toContain('--drop-failed');
  });

  it('an interrupted run names nothing: what it did not reach did not fail', async () => {
    const { ctx, logger, provider } = ctxWith(async () => undefined);
    await deleteJournaledOrphans(
      { segments: [{ segment: seg([]), ops: [stream('Unreached')] as never }], count: 1 },
      {},
      'S',
      ctx,
      { isInterrupted: () => true }
    );
    expect(provider.delete).not.toHaveBeenCalled();
    expect(warned(logger)).not.toContain('--drop-failed');
  });

  it.each([
    ['its state cannot be read', { stateResources: undefined }],
    ['it is interrupted before the delete', { stateResources: {}, isInterrupted: () => true }],
  ])("a successful deploy names nothing when %s: the entry is retried, not dropped", async (_l, extra) => {
    const { ctx, logger, provider } = ctxWith(async () => {
      throw new Error('AccessDeniedException');
    });
    const journal = journalOf(seg([stream('Kept')]));
    const stateBackend = {
      loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
      reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    };
    const left = await settleJournaledOrphansOnSuccess({
      stateBackend: stateBackend as never,
      stackName: 'S',
      region: REGION,
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: async () => undefined,
      ctx,
      logger: logger as never,
      ...extra,
    } as never);
    expect(left.keepJournal).toBe(true);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(warned(logger)).not.toContain('--drop-failed');
  });

  it("a successful deploy's kept-entry warning names it once, for the entry it kept", async () => {
    const { ctx, logger } = ctxWith(async () => {
      throw new Error('AccessDeniedException');
    });
    const journal = journalOf(seg([stream('Stuck')]));
    const stateBackend = {
      loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
      reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    };
    const left = await settleJournaledOrphansOnSuccess({
      stateBackend: stateBackend as never,
      stackName: 'S',
      region: REGION,
      stateResources: {},
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: async () => undefined,
      ctx,
      logger: logger as never,
    });
    expect(left.keepJournal).toBe(true);
    const text = warned(logger);
    expect(text.match(/--drop-failed Stuck/g)).toHaveLength(1);
    expect(text).toContain('the next successful deploy retries.');
  });

  it.each([
    ['no identity was journaled', { createdResourceIdentity: undefined }],
    ['the live identity differs', { createdResourceIdentity: 'another-identity' }],
  ])(
    'a successful deploy names nothing for an entry go-to-k/cdkd#4655 settles without a delete: %s',
    async (_l, extra) => {
      // Demoted and cleared with the journal (warned, exit 2): it blocks no
      // later deploy or destroy, so there is nothing to drop.
      const { ctx, logger, provider } = ctxWith(async () => undefined);
      const journal = journalOf(seg([stream('Unproven', extra)]));
      const stateBackend = {
        loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      };
      const left = await settleJournaledOrphansOnSuccess({
        stateBackend: stateBackend as never,
        stackName: 'S',
        region: REGION,
        stateResources: {},
        rollbackOrphans: undefined,
        newerOperations: [],
        foreignHolder: async () => undefined,
        ctx,
        logger: logger as never,
      });
      // Premise: identity read, no delete, the entry not kept.
      expect(provider.resourceIdentity).toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      expect(left.keepJournal).toBe(false);
      expect(left.unaddressed).toBe(1);
      expect(warned(logger)).not.toContain('--drop-failed');
    }
  );
});
