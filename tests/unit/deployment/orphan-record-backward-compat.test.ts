/**
 * `StackState.orphans` ships with NO schema version bump (issue #2934), which
 * is only defensible if the field is invisible to everyone who does not use it.
 *
 * That claim has three directions, and all three have to hold:
 *
 *   - a NEW binary reading OLD state — absent means today's behaviour;
 *   - an OLD binary reading NEW state — it ignores the field;
 *   - an OLD binary REWRITING that state — it drops the field, which must
 *     degrade to today's behaviour rather than corrupt anything.
 *
 * The first is the one this file can test directly, and it is the one that
 * decides whether existing users see any change at all: a stack that has never
 * orphaned anything must produce a `state.json` with NO `orphans` KEY. Not an
 * empty array — an ABSENT key, so the serialized document is byte-identical to
 * what the previous release wrote.
 *
 * `orphans: []` would be a breaking change dressed as a no-op: every existing
 * stack's next deploy would rewrite its state with a field no prior binary
 * emits, which is exactly the kind of silent churn a no-bump field is promising
 * not to cause.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  orphansCarriedFrom,
  orphansAfterRollback,
  type StackOrphanRecord,
  type ResourceState,
} from '../../../src/types/state.js';

function record(logicalId: string): StackOrphanRecord {
  const state: ResourceState = {
    physicalId: `phys-${logicalId}`,
    resourceType: 'AWS::IAM::Role',
    properties: {},
  };
  return { logicalId, orphanedAt: 1, state };
}

describe('orphans is invisible to a stack that never orphaned (#2934)', () => {
  it('carrying from a record without the field adds NO key', () => {
    const carried = orphansCarriedFrom({});
    // `toEqual({})` alone would pass for `{ orphans: undefined }`, which
    // serializes away but is a different object — and a later `...spread` of it
    // into a literal that then gets `JSON.stringify`d is the only place the
    // difference shows. Assert the KEY SET.
    expect(Object.keys(carried)).toEqual([]);
    expect('orphans' in carried).toBe(false);
  });

  it('a rollback that orphaned nothing adds NO key', () => {
    const merged = orphansAfterRollback({}, []);
    expect(Object.keys(merged)).toEqual([]);
    expect('orphans' in merged).toBe(false);
  });

  it('serializes byte-identically to a pre-feature record', () => {
    // The property as a USER would observe it: two documents, one built by a
    // binary that knows the field and one by a binary that does not.
    const before = { version: 9, stackName: 'S', resources: {}, lastModified: 1 };
    const after = {
      version: 9,
      stackName: 'S',
      resources: {},
      ...orphansCarriedFrom({}),
      ...orphansAfterRollback({}, []),
      lastModified: 1,
    };
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('a record that HAS orphans keeps them — the guard above is not just "always empty"', () => {
    // Without this, every case above would pass against a helper hard-wired to
    // return `{}`, and the fence would be vacuous in the direction that matters.
    const kept = orphansCarriedFrom({ orphans: [record('A')] });
    expect(kept.orphans?.map((o) => o.logicalId)).toEqual(['A']);
    const merged = orphansAfterRollback({}, [record('B')]);
    expect(merged.orphans?.map((o) => o.logicalId)).toEqual(['B']);
  });

  it('an EMPTY carried array stays empty rather than vanishing', () => {
    // `[]` and absent are different records: absent means "this binary does not
    // know", `[]` means "known to hold nothing". A writer that already decided
    // the set must not have that decision silently converted back to unknown.
    const carried = orphansCarriedFrom({ orphans: [] });
    expect(carried.orphans).toEqual([]);
    expect('orphans' in carried).toBe(true);
  });
});
