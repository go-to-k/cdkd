/**
 * go-to-k/cdkd#4852: the deploy engine's read-provenance SKIP TERM. A path is
 * moved when it holds a token at a read-derived leaf and this run's read-route
 * versions are not a subset of the record's `readVersions`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  confirmValueMoves,
  readProvenanceMovedPaths,
  sameValueAtVersions,
  withRefreshedReadVersions,
} from '../../../src/deployment/deploy-engine/read-provenance-moved.js';
import { recordReferenceResolution } from '../../../src/deployment/secret-redaction/reference-provenance.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction/pairs.js';
import { readProducerStateOnce } from '../../../src/deployment/intrinsic-resolver/cross-stack.js';
import type { ResourceState } from '../../../src/types/state.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;

/** A pass bag that resolved REF at `version` on `route`. */
function served(entries: Array<[string, 'read' | 'literal']>): RecordedSecretValues {
  const bag: RecordedSecretValues = new Map();
  for (const [version, route] of entries) {
    recordReferenceResolution(bag, REF, { region: 'us-east-1', version, route });
  }
  return bag;
}

const record = (readVersions: string[] | undefined): unknown => ({
  properties: { Value: ARN, Tags: { Name: REF } },
  ...(readVersions !== undefined && {
    referenceProvenance: {
      [REF]: { region: 'us-east-1', versions: readVersions.length > 0 ? readVersions : [V1], readVersions },
    },
  }),
});

const templateProperties = {
  Value: { 'Fn::GetAtt': ['Queue', 'Arn'] },
  Tags: { Name: REF },
};
const desiredRedacted = { Value: ARN, Tags: { Name: REF } };

describe('readProvenanceMovedPaths', () => {
  it('a read version the record does not hold moves the read-derived path only', () => {
    const moved = readProvenanceMovedPaths({
      record: record([V1]),
      templateProperties,
      desiredRedacted,
      secrets: served([[V2, 'read']]),
    });
    // `Tags` spells the token as often as it holds it: literal, exempt.
    expect([...moved.paths]).toEqual(['Value']);
    expect(moved.tokens.map((t) => t.token)).toEqual([REF]);
  });

  it('served ⊆ recorded: nothing moved (the skip stands)', () => {
    const moved = readProvenanceMovedPaths({
      record: record([V1]),
      templateProperties,
      desiredRedacted,
      secrets: served([
        [V1, 'read'],
        [V2, 'literal'],
      ]),
    });
    expect(moved.paths.size).toBe(0);
  });

  it('a literal-only resolution (a rotation alone) moves nothing', () => {
    const moved = readProvenanceMovedPaths({
      record: record([V1]),
      templateProperties,
      desiredRedacted,
      secrets: served([[V2, 'literal']]),
    });
    expect(moved.paths.size).toBe(0);
  });

  it('no field, or no recorded readVersions: no verdict (the #4851 rule alone)', () => {
    for (const r of [record(undefined), record([])]) {
      const moved = readProvenanceMovedPaths({
        record: r,
        templateProperties,
        desiredRedacted,
        secrets: served([[V2, 'read']]),
      });
      expect(moved.paths.size).toBe(0);
    }
  });

  it('a token served unresolved has no read version: no verdict', () => {
    const moved = readProvenanceMovedPaths({
      record: record([V1]),
      templateProperties,
      desiredRedacted,
      secrets: new Map(),
    });
    expect(moved.paths.size).toBe(0);
  });

  it('a path holding the token both spelled and read counts the read occurrence', () => {
    const moved = readProvenanceMovedPaths({
      record: record([V1]),
      templateProperties: {
        Value: { 'Fn::Join': ['|', [REF, { 'Fn::GetAtt': ['Queue', 'Arn'] }]] },
      },
      desiredRedacted: { Value: `${REF}|${ARN}` },
      secrets: served([[V2, 'read']]),
    });
    expect([...moved.paths]).toEqual(['Value']);
  });

  it('a read leaf nested in an object or an array is found', () => {
    for (const [template, redacted] of [
      [{ Variables: { Q: { 'Fn::GetAtt': ['Queue', 'Arn'] } } }, { Variables: { Q: ARN } }],
      [[{ 'Fn::GetAtt': ['Queue', 'Arn'] }], [ARN]],
    ] as const) {
      const moved = readProvenanceMovedPaths({
        record: record([V1]),
        templateProperties: { Env: template },
        desiredRedacted: { Env: redacted },
        secrets: served([[V2, 'read']]),
      });
      expect([...moved.paths]).toEqual(['Env']);
    }
  });
});

describe('confirmValueMoves', () => {
  const moved = () =>
    readProvenanceMovedPaths({
      record: record([V1]),
      templateProperties,
      desiredRedacted,
      secrets: served([[V2, 'read']]),
    });

  it('an equal value at both versions is no move, and is reported unchanged', async () => {
    const calls: string[][] = [];
    const out = await confirmValueMoves(moved(), async (_t, recorded, now) => {
      calls.push([recorded, now]);
      return true;
    });
    expect(calls).toEqual([[V1, V2]]);
    expect(out.moved.paths.size).toBe(0);
    expect(out.unchanged.map((u) => u.token)).toEqual([REF]);
  });

  it('a different value, or one that cannot be read, stays moved', async () => {
    for (const answer of [false, undefined]) {
      const out = await confirmValueMoves(moved(), async () => answer);
      expect([...out.moved.paths]).toEqual(['Value']);
      expect(out.unchanged).toEqual([]);
    }
  });

  it('two served versions are equal only when both match the recorded value', async () => {
    const twoServed = readProvenanceMovedPaths({
      record: record([V1]),
      templateProperties,
      desiredRedacted,
      secrets: served([
        ['c1b2c3d4-0000-1111-2222-333333333333', 'read'],
        [V2, 'read'],
      ]),
    });
    const seen: string[] = [];
    // The FIRST served version differs: a later equal one must not undo that.
    const out = await confirmValueMoves(twoServed, async (_t, _r, now) => {
      seen.push(now);
      return now === V2;
    });
    expect(seen).toEqual(['c1b2c3d4-0000-1111-2222-333333333333']);
    expect([...out.moved.paths]).toEqual(['Value']);
  });

  it('two recorded versions give no value verdict (no read)', async () => {
    const twoRecorded = readProvenanceMovedPaths({
      record: record([V1, 'c1b2c3d4-0000-1111-2222-333333333333']),
      templateProperties,
      desiredRedacted,
      secrets: served([[V2, 'read']]),
    });
    let calls = 0;
    const out = await confirmValueMoves(twoRecorded, async () => {
      calls++;
      return true;
    });
    expect(calls).toBe(0);
    expect([...out.moved.paths]).toEqual(['Value']);
  });

  it('sameValueAtVersions gives no verdict for a token with no recorded region, and reads nothing', async () => {
    // Every read would answer the same plaintext, so a read would say "equal".
    let reads = 0;
    const resolver = {
      resolveDynamicReferences: async () => {
        reads++;
        return 'same-plaintext';
      },
      resolverForRecordedRegion() {
        reads++;
        return this;
      },
    };
    const entry = { token: REF, paths: new Set(['Value']), recorded: [V1], served: new Set([V2]), region: undefined };
    expect(
      await sameValueAtVersions(resolver as never, entry, V1, V2, { template: { Resources: {} }, resources: {} })
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('withRefreshedReadVersions leaves a token whose versions would pass the cap of 8', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `${String(i)}1b2c3d4-0000-1111-2222-333333333333`);
    const rec = {
      physicalId: 'p',
      resourceType: 'AWS::SSM::Parameter',
      properties: {},
      referenceProvenance: { [REF]: { region: 'us-east-1', versions: eight, readVersions: [eight[0]!] } },
    } as ResourceState;
    const out = withRefreshedReadVersions(rec, [
      { token: REF, paths: new Set(['Value']), recorded: [eight[0]!], served: new Set([V2, 'e1b2c3d4-0000-1111-2222-333333333333']), region: 'us-east-1' },
    ]);
    expect(out.referenceProvenance?.[REF]?.readVersions).toEqual([eight[0]]);
  });

  it('readProducerStateOnce reports a failed cached read to every caller', async () => {
    const scope = {};
    const backend = { getState: async () => Promise.reject(new Error('denied')) };
    let failures = 0;
    await readProducerStateOnce(scope, backend as never, 'p', 'us-east-1', () => failures++);
    await readProducerStateOnce(scope, backend as never, 'p', 'us-east-1', () => failures++);
    expect(failures).toBe(2);
  });

  it('a refresh replaces the old read versions, so repeated other-key rotations never reach the cap', () => {
    const v = (i: number): string => `${String(i).padStart(2, '0')}b2c3d4-0000-1111-2222-333333333333`;
    const LITERAL = 'f1b2c3d4-0000-1111-2222-333333333333';
    let rec = {
      physicalId: 'p',
      resourceType: 'AWS::SSM::Parameter',
      properties: {},
      referenceProvenance: { [REF]: { region: 'us-east-1', versions: [LITERAL, v(0)], readVersions: [v(0)] } },
    } as ResourceState;
    for (let i = 1; i <= 12; i++) {
      rec = withRefreshedReadVersions(rec, [
        { token: REF, paths: new Set(['Value']), recorded: [v(i - 1)], served: new Set([v(i)]), region: 'us-east-1' },
      ]);
      // Refreshed every cycle: the reader is current and is not promoted again.
      expect(rec.referenceProvenance?.[REF]?.readVersions).toEqual([v(i)]);
    }
    // The literal-route version survives; the superseded read versions do not.
    expect(rec.referenceProvenance?.[REF]?.versions).toEqual([v(12), LITERAL].sort());
  });
});
