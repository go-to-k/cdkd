import { describe, it, expect } from 'vite-plus/test';
import {
  ROLLBACK_JOURNAL_VERSION,
  parseRollbackJournal,
  UnknownRollbackJournalVersionError,
  type RollbackJournal,
} from '../../../src/types/rollback-journal.js';

describe('parseRollbackJournal', () => {
  const valid: RollbackJournal = {
    journalVersion: ROLLBACK_JOURNAL_VERSION,
    stackName: 'MyStack',
    region: 'us-east-1',
    segments: [
      {
        runId: '20260101T000000000Z-abc',
        timestamp: 1234567890,
        reason: 'no-rollback-failure',
        initialDeploy: true,
        cdkdVersion: '0.262.2',
        operations: [
          { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'p' },
        ],
      },
    ],
  };

  it('round-trips a valid journal', () => {
    const parsed = parseRollbackJournal(JSON.stringify(valid), 'MyStack');
    expect(parsed).toEqual(valid);
  });

  it('throws UnknownRollbackJournalVersionError on a newer version', () => {
    const body = JSON.stringify({ ...valid, journalVersion: ROLLBACK_JOURNAL_VERSION + 1 });
    expect(() => parseRollbackJournal(body, 'MyStack')).toThrow(UnknownRollbackJournalVersionError);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseRollbackJournal('{not json', 'MyStack')).toThrow(/not valid JSON/);
  });

  it('throws when segments is missing', () => {
    const body = JSON.stringify({ journalVersion: 1, stackName: 'X' });
    expect(() => parseRollbackJournal(body, 'X')).toThrow(/segments/);
  });

  it('throws when journalVersion is missing', () => {
    const body = JSON.stringify({ stackName: 'X', segments: [] });
    expect(() => parseRollbackJournal(body, 'X')).toThrow(/journalVersion/);
  });
});
