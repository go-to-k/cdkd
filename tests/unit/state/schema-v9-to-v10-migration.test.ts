import { describe, it, expect } from 'vite-plus/test';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type ResourceState,
  type StackState,
} from '../../../src/types/state.js';

/**
 * Schema v10 — `ResourceState.observedBaselineRefused`, the PROVENANCE of
 * `cdkd import`'s observed-baseline refusal (issue
 * [#2944](https://github.com/go-to-k/cdkd/issues/2944)).
 *
 * The integ test `tests/integration/schema-v9-to-v10-migration/` proves the
 * transparent auto-migration round-trip against real AWS AND reproduces the
 * refill under the v9 binary first (markgate's `integ-schema-migration` gate
 * enforces it on merge). This unit test pins the in-memory contract:
 *
 *   - the version literal type includes 10 and the readable set accepts it
 *   - a v9 state blob deserializes cleanly and every record reads as NOT
 *     refused — which is exactly the pre-v10 behaviour of both writers
 *   - the field is PRESENCE-tested, never `=== false`, because only `true` is
 *     ever written
 *   - it survives a JSON round trip, and an ABSENT field does not materialize
 *
 * The behaviour of the writers that set, clear and honour the field is pinned
 * where those writers live, not here:
 * `tests/unit/cli/import-observed-baseline-refusal-matrix.test.ts` (set, clear,
 * and the preserved-record gate), `tests/unit/deployment/deploy-engine-auto-refresh.test.ts`
 * (the deploy-start refresh, and the clear a real UPDATE performs),
 * `tests/unit/cli/state-refresh-observed.test.ts` (the real loop and the
 * `--dry-run` plan) and `tests/unit/cli/drift.test.ts` (`--accept` / `--revert`).
 */
describe('State schema v10 — observedBaselineRefused (#2944)', () => {
  it('current schema version is at least 10 (subsequent bumps may carry this forward)', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBeGreaterThanOrEqual(10);
  });

  it('readers accept every prior version + v10', () => {
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
    }
  });

  it('a v9 state blob (no observedBaselineRefused) deserializes cleanly and reads as NOT refused', () => {
    // Real-world shape: an existing user has a v9 state file in S3. The v10
    // binary reads it, sees the field absent on every record, and both later
    // writers behave exactly as they did before the field existed — which is
    // the transparent auto-migration contract (CLAUDE.md: a user must do
    // nothing on upgrade).
    const v9Blob = JSON.stringify({
      version: 9,
      stackName: 'LegacyV9Stack',
      region: 'us-east-1',
      resources: {
        Bucket: {
          physicalId: 'legacy-v9-bucket',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'legacy-v9-bucket' },
        },
      },
      outputs: {},
      exportNames: [],
      lastModified: 1717024800000,
    });
    const parsed = JSON.parse(v9Blob) as StackState;
    expect(parsed.version).toBe(9);
    expect(parsed.resources['Bucket']!.observedBaselineRefused).toBeUndefined();
    // The exact test both writers apply. Stated here so a writer switching to
    // a truthiness test (which would agree) or to `!== false` (which would
    // NOT, and would skip every pre-v10 record) is a visible change.
    expect(parsed.resources['Bucket']!.observedBaselineRefused === true).toBe(false);
  });

  it('a v9 record and a v10 record with the field absent are indistinguishable to a reader', () => {
    // The migration's whole claim. If any reader could tell them apart, the
    // upgrade would not be transparent -- so the ONLY discriminator is the
    // field, never `version`.
    const record = (): ResourceState => ({
      physicalId: 'p',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
    });
    const v9: StackState = {
      version: 9,
      stackName: 'S',
      region: 'us-east-1',
      resources: { R: record() },
      outputs: {},
      lastModified: 0,
    };
    const v10: StackState = { ...v9, version: 10, resources: { R: record() } };

    expect(v9.resources['R']!.observedBaselineRefused === true).toBe(
      v10.resources['R']!.observedBaselineRefused === true
    );
  });

  it('a REFUSED record survives the JSON round trip as `true`', () => {
    const state: StackState = {
      version: 10,
      stackName: 'Imported',
      region: 'us-east-1',
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          // The wrong-branch literal the refusal distrusted: a plain string
          // that pairs with a live readback as an ordinary drifted literal,
          // which is why no in-walk remedy exists and the refusal has to be
          // carried on the record instead.
          properties: { MasterUserPassword: 'dev-placeholder' },
          observedBaselineRefused: true,
        },
      },
      outputs: {},
      lastModified: 0,
    };
    const round = JSON.parse(JSON.stringify(state)) as StackState;
    expect(round.resources['Db']!.observedBaselineRefused).toBe(true);
    expect(round.resources['Db']!.observedProperties).toBeUndefined();
  });

  it('an ABSENT field does not materialize on the wire (a `delete` clears it for real)', () => {
    // The clearing writers use `delete`, not `= undefined`, because a reader
    // tests PRESENCE. `JSON.stringify` drops an `undefined` value too, so this
    // case exists to state the contract rather than to catch that one spelling
    // -- what it would catch is a writer switching to `= false`, which
    // serializes and then reads as "present but not refused" in any reader
    // that tested presence rather than `=== true`.
    const cleared: ResourceState = {
      physicalId: 'p',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      observedBaselineRefused: true,
    };
    delete cleared.observedBaselineRefused;
    const serialized = JSON.stringify(cleared);
    expect(serialized).not.toContain('observedBaselineRefused');
    const round = JSON.parse(serialized) as ResourceState;
    expect(Object.hasOwn(round, 'observedBaselineRefused')).toBe(false);
  });
});
