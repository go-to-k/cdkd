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

/**
 * Issue [#3064](https://github.com/go-to-k/cdkd/issues/3064): every value this
 * parser interpolates is attacker-writable. `rollback-journal.json` is a
 * sibling of `state.json` in the same bucket, so anyone with `s3:PutObject`
 * writes it, and the STACK NAME arrives as an S3 key segment.
 *
 * Two dimensions per site, and the second is the one a control-character
 * fixture cannot see. The HOLE is the guard being dropped; the CLASS is
 * `asciiOnly` being swapped for the denylist, which still removes a newline
 * but leaves the invisible formatters (`U+200B`-`U+200D`, `U+FEFF`) and the
 * bidi marks -- `display-safe.ts` names them as the denylist's residual. A
 * zero-width space is what discriminates them; a control byte is in BOTH
 * classes and tells them apart in neither direction.
 *
 * `formatError` prints a non-`CdkdError`'s `message` RAW -- only `cause` is
 * sanitized there (issue #3003) -- so nothing downstream catches these.
 */
describe('parseRollbackJournal refuses to forge a line (issue #3064)', () => {
  const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const INVISIBLE = /[\u200b-\u200f\ufeff]/;

  const messageOf = (body: string, stackName: string): string => {
    try {
      parseRollbackJournal(body, stackName);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('expected parseRollbackJournal to throw');
  };

  it('flattens the BODY BYTES V8 quotes back in its invalid-JSON message', () => {
    // An ARRAY opener, deliberately: V8 quotes the offending input only in the
    // `Unexpected token 'X', "..."` form, and an object-shaped truncation takes
    // the position-only `SyntaxError` instead, which quotes nothing and makes
    // the case vacuous. The invisible sits EARLY because that quote is
    // truncated at ~18 units.
    const message = messageOf('[1,2,\n  Phys\u200bicalID: arn:forged]', 'S');

    expect(message).not.toMatch(CTRL);
    expect(message).not.toMatch(INVISIBLE);
    // Removed, not censored -- the surrounding text still reads.
    expect(message).toContain('Phys ical');
  });

  it('flattens the STACK NAME, which is an S3 key segment', () => {
    const message = messageOf('{not json', 'Gho\u200bst\n  PhysicalID: arn:forged');

    expect(message).not.toMatch(CTRL);
    expect(message).not.toMatch(INVISIBLE);
    // Three spaces: the zero-width, the newline, and the journal's own two
    // literal ones all flatten to one space each.
    expect(message).toContain('Gho st   PhysicalID: arn:forged');
  });

  it('flattens the journalVersion VALUE it echoes back', () => {
    const body = JSON.stringify({
      journalVersion: '0\n  Forged\u200bRow: yes',
      stackName: 'S',
      segments: [],
    });
    const message = messageOf(body, 'S');

    expect(message).not.toMatch(CTRL);
    expect(message).not.toMatch(INVISIBLE);
    expect(message).toContain('Forged Row: yes');
  });

  it('reports a null journalVersion as `null`, not as absent', () => {
    // `String(v)` runs BEFORE the sanitiser: `displaySafe` maps `null` to the
    // empty string, so sanitising first would print `(...)` and read as a
    // missing field rather than a present, wrong one.
    const body = JSON.stringify({ journalVersion: null, stackName: 'S', segments: [] });

    expect(messageOf(body, 'S')).toContain("'journalVersion' (null)");
  });

  it('still says something when the quoted input sanitises away entirely', () => {
    // Why there is no empty-detail fallback: V8's own wording is ASCII prose
    // and survives the allowlist even when every byte it quoted does not, so
    // the detail is never empty and a placeholder branch would be dead.
    const message = messageOf('\u0000\u0001', 'S');

    expect(message).not.toMatch(CTRL);
    expect(message).toMatch(/is not valid JSON: \S/);
  });

  it('flattens the stack name in the newer-version refusal too, and keeps the PROPERTY raw', () => {
    // The fifth throw arm, missed by the first round: it goes through the
    // error CLASS rather than a template literal in the parser. The message
    // is what a terminal renders and is sanitized; the `stackName` property
    // is a value a caller may key on and stays exactly what was passed.
    const hostile = 'Gho\u200bst\n  PhysicalID: arn:forged';
    const body = JSON.stringify({
      journalVersion: ROLLBACK_JOURNAL_VERSION + 1,
      stackName: 'X',
      segments: [],
    });
    let caught: unknown;
    try {
      parseRollbackJournal(body, hostile);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(UnknownRollbackJournalVersionError);
    const err = caught as UnknownRollbackJournalVersionError;
    expect(err.message).not.toMatch(CTRL);
    expect(err.message).not.toMatch(INVISIBLE);
    expect(err.message).toContain("'Gho st   PhysicalID: arn:forged'");
    expect(err.stackName).toBe(hostile);
  });

  it('renders a journalVersion that sanitizes to NOTHING as the placeholder', () => {
    // All invisibles: `String(v)` keeps it, the allowlist removes every
    // character, and without the fallback the message would read
    // `('journalVersion' ()` -- a present, wrong field shown as absent.
    const body = JSON.stringify({ journalVersion: '\u200b\u200c', stackName: 'S', segments: [] });

    expect(messageOf(body, 'S')).toContain("'journalVersion' (<unrenderable>)");
  });

  it('flattens the stack name in the two SHAPE refusals as well', () => {
    const hostile = 'Gho\u200bst\n  PhysicalID: arn:forged';

    for (const body of [JSON.stringify(7), JSON.stringify({ journalVersion: 1, stackName: 'X' })]) {
      const message = messageOf(body, hostile);
      expect(message).not.toMatch(CTRL);
      expect(message).not.toMatch(INVISIBLE);
    }
  });
});
