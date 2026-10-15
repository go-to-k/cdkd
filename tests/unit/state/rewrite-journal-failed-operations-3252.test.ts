/**
 * `S3StateBackend.rewriteRollbackJournalFailedOperations` (go-to-k/cdkd#3252):
 * the write a settled abandoned Cloud Control CREATE goes through.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { RollbackJournal } from '../../../src/types/rollback-journal.js';
import type { FailedOperation } from '../../../src/deployment/rollback-executor.js';

const a: FailedOperation = { logicalId: 'A', changeType: 'CREATE', resourceType: 'AWS::SNS::Topic' };
const b: FailedOperation = { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::SNS::Topic' };

function backendWith(journal: RollbackJournal | null) {
  const backend = new S3StateBackend({ send: vi.fn() } as unknown as S3Client, {
    bucket: 'b',
    prefix: 'cdkd',
  });
  vi.spyOn(backend, 'loadRollbackJournal').mockResolvedValue(
    journal === null ? null : structuredClone(journal)
  );
  const put = vi.spyOn(backend, 'putRawObject').mockResolvedValue(undefined);
  return { backend, put };
}

const journal: RollbackJournal = {
  journalVersion: 1,
  stackName: 'S',
  region: 'us-east-1',
  segments: [
    { timestamp: 1, reason: 'interrupted', initialDeploy: false, operations: [], failedOperations: [a] },
    { timestamp: 2, reason: 'interrupted', initialDeploy: false, operations: [], failedOperations: [b] },
  ],
};

describe('rewriteRollbackJournalFailedOperations (#3252)', () => {
  it('replaces and removes ops across segments and writes the journal once', async () => {
    const { backend, put } = backendWith(journal);
    const changed = await backend.rewriteRollbackJournalFailedOperations('S', 'us-east-1', (op) =>
      op.logicalId === 'A' ? { ...op, physicalId: 'arn' } : null
    );
    expect(changed).toBe(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe('cdkd/S/us-east-1/rollback-journal.json');
    const written = JSON.parse(put.mock.calls[0]![1]) as RollbackJournal;
    expect(written.segments[0]!.failedOperations).toEqual([{ ...a, physicalId: 'arn' }]);
    // A segment left with no failed op loses the field; the segment stays.
    expect(written.segments).toHaveLength(2);
    expect(written.segments[1]!.failedOperations).toBeUndefined();
  });

  it('writes nothing when every op is returned unchanged, or there is no journal', async () => {
    const { backend, put } = backendWith(journal);
    expect(await backend.rewriteRollbackJournalFailedOperations('S', 'us-east-1', (op) => op)).toBe(0);
    expect(put).not.toHaveBeenCalled();
    const empty = backendWith(null);
    expect(
      await empty.backend.rewriteRollbackJournalFailedOperations('S', 'us-east-1', () => null)
    ).toBe(0);
    expect(empty.put).not.toHaveBeenCalled();
  });
});
