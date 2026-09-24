/**
 * Issue go-to-k/cdkd#3643 — `orphans` rows sharing a STRING `logicalId`.
 *
 * Each such row passes the per-record predicates (`isReadableOrphanRecord`,
 * `isPreviewableOrphanRecord`), because a shared id is a property of the LIST.
 * Every reader then collapses them: `orphansAfterRollback` keeps the last row
 * per id, and the adoption pass writes `adopted[logicalId]` per row. So the
 * list-level check lives in the module's ENUMERATING helpers, which every
 * refusal, the read-only repair and `cdkd diff`'s preview filter take.
 *
 * The per-command cases (deploy, destroy, rollback, import, orphan, scrub, diff)
 * sit beside each command's #3500 table; this file pins the module's verdict and
 * that every text listing the causes names the new one.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  isPreviewableOrphanRecord,
  isReadableOrphanRecord,
  malformedOrphanRecordsForDestroyRefusalMessage,
  malformedOrphanRecordsRefusalMessage,
  malformedOrphanRecordsWarning,
  malformedOrphansForOrphanRefusalMessage,
  previewableOrphanRecords,
  repairMalformedOrphanRecordsForReadOnly,
  unpreviewableOrphanRecords,
  unreadableOrphanRecords,
} from '../../../src/state/malformed-resources-bag.js';
import type { StackState } from '../../../src/types/state.js';

const row = (logicalId: unknown, physicalId: string, properties: unknown = {}) => ({
  logicalId,
  orphanedAt: 1,
  state: { physicalId, resourceType: 'AWS::SQS::Queue', properties },
});

const withRows = (rows: unknown[]) => ({ orphans: rows }) as unknown as Pick<StackState, 'orphans'>;

describe('orphan rows sharing a logicalId (go-to-k/cdkd#3643)', () => {
  it('THE PREMISE: each row passes the per-record predicates, so only the list can see it', () => {
    const a = row('Twin', 'p-1');
    const b = row('Twin', 'p-2');
    expect(isReadableOrphanRecord(a) && isReadableOrphanRecord(b)).toBe(true);
    expect(isPreviewableOrphanRecord(a) && isPreviewableOrphanRecord(b)).toBe(true);
  });

  it('names EVERY row of a shared id, and no distinct one', () => {
    const state = withRows([row('Keep', 'k'), row('Twin', 'p-1'), row('Twin', 'p-2'), row('Twin', 'p-3')]);
    expect(unreadableOrphanRecords(state)).toEqual(['Twin', 'Twin', 'Twin']);
    expect(unpreviewableOrphanRecords(state)).toEqual(['Twin', 'Twin', 'Twin']);
    expect(previewableOrphanRecords(state)).toEqual([row('Keep', 'k')]);
  });

  it("counts the EMPTY string as an id, and names it as the `''` stand-in", () => {
    const state = withRows([row('', 'p-1'), row('', 'p-2')]);
    expect(unreadableOrphanRecords(state)).toEqual(['', '']);
    expect(previewableOrphanRecords(state)).toEqual([]);
  });

  it('counts an id spelled like an Object.prototype member, not the prototype', () => {
    // A plain-object counter would read `seen['constructor']` as a function and
    // `seen['__proto__']` as the prototype, so the first row would already look
    // "seen" — or never — depending on the arithmetic. A `Map` has no such keys.
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(unreadableOrphanRecords(withRows([row(id, 'p-1')])), `${id} alone`).toEqual([]);
      expect(
        unreadableOrphanRecords(withRows([row(id, 'p-1'), row(id, 'p-2')])),
        `${id} twice`
      ).toEqual([id, id]);
    }
  });

  it('a torn row sharing an id with a healthy one takes the healthy one down too', () => {
    // Both are named once each: the torn row for its map AND the shared id, the
    // healthy one for the shared id alone. A read-only command must not preview
    // the healthy twin as the stack's only row of that id.
    const torn = row('Twin', 'p-1', 'abcdef');
    const healthy = row('Twin', 'p-2');
    expect(unreadableOrphanRecords(withRows([torn, healthy]))).toEqual(['Twin', 'Twin']);
    expect(previewableOrphanRecords(withRows([torn, healthy]))).toEqual([]);
  });

  it('non-string ids are the per-row predicate business, and do not share with a string', () => {
    // `5` and `'5'` are different keys in the merge map, and a non-string id is
    // already refused per row — so the numeric row is named once, for its own
    // defect, and the string row stays usable.
    const state = withRows([row(5, 'p-1'), row('5', 'p-2')]);
    expect(unreadableOrphanRecords(state)).toEqual(['']);
    expect(previewableOrphanRecords(state)).toEqual([row('5', 'p-2')]);
  });

  it('CONTROL: distinct ids are all usable', () => {
    const state = withRows([row('A', 'p-1'), row('B', 'p-2'), row('C', 'p-3')]);
    expect(unreadableOrphanRecords(state)).toEqual([]);
    expect(unpreviewableOrphanRecords(state)).toEqual([]);
    expect(previewableOrphanRecords(state)).toHaveLength(3);
  });

  it('previewableOrphanRecords is [] for a container that is not a list', () => {
    for (const orphans of [undefined, null, 'abc', 5, {}]) {
      expect(previewableOrphanRecords({ orphans } as unknown as Pick<StackState, 'orphans'>)).toEqual([]);
    }
  });

  it('the read-only repair DROPS every row of a shared id, and returns their names', () => {
    const keep = row('Keep', 'k');
    const state = withRows([row('Twin', 'p-1'), keep, row('Twin', 'p-2')]);
    expect(repairMalformedOrphanRecordsForReadOnly(state)).toEqual(['Twin', 'Twin']);
    // What it dropped is exactly what it named — so a `--dry-run` drops the rows
    // the real run refuses over, no more and no fewer.
    expect(state.orphans).toEqual([keep]);
  });

  it('CONTROL: the read-only repair leaves a list of distinct ids untouched', () => {
    const rows = [row('A', 'p-1'), row('B', 'p-2')];
    const state = withRows(rows);
    expect(repairMalformedOrphanRecordsForReadOnly(state)).toEqual([]);
    expect(state.orphans).toBe(rows);
  });

  describe('every text that lists why a row is refused names the shared id', () => {
    const ids = ['Twin', 'Twin'];
    const TEXTS: Array<[string, string]> = [
      ['the writer refusal', malformedOrphanRecordsRefusalMessage('S', 'us-east-1', ids)],
      ['the destroy refusal', malformedOrphanRecordsForDestroyRefusalMessage('S', 'us-east-1', ids)],
      ["`cdkd orphan`'s refusal", malformedOrphansForOrphanRefusalMessage('S', 'us-east-1', ids)],
    ];
    for (const [label, text] of TEXTS) {
      it(label, () => {
        expect(text).toContain("no string 'logicalId' or shares it with another row");
        expect(text).toContain('Twin, Twin');
      });
    }

    for (const alsoRejectsTornMaps of [true, false]) {
      it(`the drop warning (alsoRejectsTornMaps: ${alsoRejectsTornMaps})`, () => {
        const text = malformedOrphanRecordsWarning('S', 'us-east-1', ids, alsoRejectsTornMaps);
        expect(text).toContain("no string 'logicalId' or share it with another row");
      });
    }

    it('the writer text states the collapse for a SHARED id, not only a missing one', () => {
      expect(malformedOrphanRecordsRefusalMessage('S', 'us-east-1', ids)).toContain(
        'rows MISSING one, or SHARING one, key the same entry'
      );
    });

    it('the destroy text says why it refuses rows its listing could print', () => {
      expect(malformedOrphanRecordsForDestroyRefusalMessage('S', 'us-east-1', ids)).toContain(
        "rows sharing one 'logicalId'"
      );
    });
  });
});
