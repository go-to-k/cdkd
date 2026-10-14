/**
 * go-to-k/cdkd#4852: the deploy engine's read-provenance SKIP TERM. A path is
 * moved when it holds a token at a read-derived leaf and this run's read-route
 * versions are not a subset of the record's `readVersions`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  confirmValueMoves,
  readProvenanceMovedPaths,
} from '../../../src/deployment/deploy-engine/read-provenance-moved.js';
import { recordReferenceResolution } from '../../../src/deployment/secret-redaction/reference-provenance.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction/pairs.js';

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
});
