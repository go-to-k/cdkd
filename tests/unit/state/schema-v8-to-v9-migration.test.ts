import { describe, it, expect } from 'vite-plus/test';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  exportNamesCarriedFrom,
  importableOutputKeys,
  importableOutputs,
  type StackState,
} from '../../../src/types/state.js';

/**
 * Schema v9 — `StackState.exportNames`, the keys of `outputs` that are
 * `Export.Name` aliases (issue
 * [#2193](https://github.com/go-to-k/cdkd/issues/2193)).
 *
 * The integ test `tests/integration/schema-v8-to-v9-migration/` proves the
 * transparent auto-migration round-trip against real AWS — and reproduces
 * the shadowing bug under the v8 binary first (markgate's
 * `integ-schema-migration` gate enforces it on merge). This unit test pins
 * the in-memory contract:
 *
 *   - the version literal type includes 9
 *   - the readable-version set accepts every prior version + 9
 *   - reading a v8 state with no `exportNames` is allowed and reads as the
 *     legacy "every output key is importable" rule
 *   - a KNOWN set narrows the importable keys to the exports, `[]` included
 *   - `[]` SERIALIZES (unlike `imports` / `outputReads`, where absent and
 *     empty are the same record) — absent means "not known"
 *   - the carry helper preserves absent-as-absent and known-as-known
 */
describe('State schema v9 — exportNames for Fn::ImportValue scoping (#2193)', () => {
  it('current schema version is at least 9 (subsequent bumps may carry this forward)', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBeGreaterThanOrEqual(9);
  });

  it('readers accept every prior version + v9', () => {
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
    }
  });

  it('a v8 state blob (no exportNames) deserializes cleanly and reads as "every key importable"', () => {
    // Real-world shape: an existing user has a v8 state file on disk. The v9
    // binary reads it, sees `exportNames === undefined`, and every consumer of
    // that producer keeps resolving exactly as it did — the next deploy of
    // the producer writes the set.
    const v8Blob = JSON.stringify({
      version: 8,
      stackName: 'LegacyV8Producer',
      region: 'us-east-1',
      resources: {},
      outputs: { VpcId: 'vpc-legacy', 'legacy:VpcId': 'vpc-legacy' },
      lastModified: 1717024800000,
    });
    const parsed = JSON.parse(v8Blob) as StackState;
    expect(parsed.version).toBe(8);
    expect(parsed.exportNames).toBeUndefined();
    expect(importableOutputKeys(parsed)).toEqual(['VpcId', 'legacy:VpcId']);
    expect(importableOutputs(parsed)).toEqual(parsed.outputs);
  });

  it('a KNOWN set narrows the importable keys to the exports', () => {
    const state: StackState = {
      version: 9,
      stackName: 'Producer',
      region: 'us-east-1',
      resources: {},
      outputs: { VpcId: 'vpc-1', 'prod:VpcId': 'vpc-1', BucketName: 'b' },
      exportNames: ['prod:VpcId'],
      lastModified: 0,
    };
    expect(importableOutputKeys(state)).toEqual(['prod:VpcId']);
    expect(importableOutputs(state)).toEqual({ 'prod:VpcId': 'vpc-1' });
  });

  it('an EMPTY set means the stack exports nothing — its plain outputs are not importable', () => {
    const state: StackState = {
      version: 9,
      stackName: 'Decoy',
      region: 'us-east-1',
      resources: {},
      outputs: { VpcId: 'vpc-decoy' },
      exportNames: [],
      lastModified: 0,
    };
    expect(importableOutputKeys(state)).toEqual([]);
    expect(importableOutputs(state)).toEqual({});
  });

  it('a name in the set that the bag does not hold is not served (intersection, not trust)', () => {
    // An alias whose value failed to resolve publishes nothing, so the bag
    // lacks it even though the template declares the export.
    const state: StackState = {
      version: 9,
      stackName: 'Producer',
      region: 'us-east-1',
      resources: {},
      outputs: { Other: 'o' },
      exportNames: ['Unresolved', 'Other'],
      lastModified: 0,
    };
    expect(importableOutputKeys(state)).toEqual(['Other']);
  });

  it('importableOutputs rebuilds through a prototype-free bag, so a __proto__ export name survives (#2193 review)', () => {
    // A JSON-parsed state.outputs can carry an OWN `__proto__` key; if its
    // export set names it, `importableOutputs` must keep it (not lose it to a
    // plain-object prototype setter) and must not pollute the returned bag.
    const outputs = JSON.parse('{"__proto__": {"polluted": true}, "Real": "r"}') as Record<
      string,
      unknown
    >;
    const state: StackState = {
      version: 9,
      stackName: 'P',
      region: 'us-east-1',
      resources: {},
      outputs,
      exportNames: ['__proto__', 'Real'],
      lastModified: 0,
    };
    const picked = importableOutputs(state);
    expect(Object.hasOwn(picked, '__proto__')).toBe(true);
    expect(Object.hasOwn(picked, 'Real')).toBe(true);
    // No prototype pollution: a plain object's prototype is untouched.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does not treat inherited object properties as importable keys', () => {
    // `name in outputs` (the pre-fix scan) is true for `toString`; the
    // predicate must not be.
    const state: StackState = {
      version: 9,
      stackName: 'P',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      exportNames: ['toString', 'constructor'],
      lastModified: 0,
    };
    expect(importableOutputKeys(state)).toEqual([]);
  });

  it('tolerates a record with no outputs bag at all (every consumer treats it as optional)', () => {
    const noBag = { outputs: undefined as unknown as Record<string, unknown>, exportNames: undefined };
    expect(importableOutputKeys(noBag)).toEqual([]);
    expect(importableOutputs(noBag)).toEqual({});
  });

  it('an EMPTY set SERIALIZES — `[]` and absent are different records on the wire', () => {
    // Unlike `imports` / `outputReads`, where the engine omits an empty
    // array, an empty export set is load-bearing: it is what stops a
    // plain-outputs-only stack being served as an exporter.
    const state: StackState = {
      version: 9,
      stackName: 'Decoy',
      region: 'us-east-1',
      resources: {},
      outputs: { VpcId: 'vpc-decoy' },
      exportNames: [],
      lastModified: 0,
    };
    const serialized = JSON.stringify(state);
    expect(serialized).toContain('"exportNames":[]');
    const round = JSON.parse(serialized) as StackState;
    expect(round.exportNames).toEqual([]);
    expect(importableOutputKeys(round)).toEqual([]);
  });

  it('the carry helper keeps absent absent and known known', () => {
    expect(exportNamesCarriedFrom({ exportNames: undefined })).toEqual({});
    expect('exportNames' in exportNamesCarriedFrom({ exportNames: undefined })).toBe(false);
    expect(exportNamesCarriedFrom({ exportNames: [] })).toEqual({ exportNames: [] });
    expect(exportNamesCarriedFrom({ exportNames: ['A'] })).toEqual({ exportNames: ['A'] });
  });
});
