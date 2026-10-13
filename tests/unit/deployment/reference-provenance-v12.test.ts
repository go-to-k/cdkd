/**
 * State schema v12 (go-to-k/cdkd#4847 / go-to-k/cdkd#4852): the pass-local
 * provenance side map, the validation every reader goes through, and the
 * persist writer's computation, as pure functions. The engine-level wiring is
 * pinned in `deploy-engine-reference-provenance-v12.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  MAX_REFERENCE_VERSIONS,
  hasPassProvenance,
  mergeReferenceProvenance,
  passProvenanceFor,
  recordReferenceProvenanceEntry,
  recordReferenceResolution,
  snapshotPassProvenance,
} from '../../../src/deployment/secret-redaction/reference-provenance.js';
import { mergeResolvedPairs } from '../../../src/deployment/secret-redaction.js';
import {
  KEEP_REFERENCE_PROVENANCE,
  outputProvenanceForPersist,
  outputReferenceProvenanceOf,
  provenanceForWrittenRecord,
  recordedProvenanceOf,
  referenceProvenanceOf,
  referenceTokensIn,
  validateReferenceProvenance,
  withReferenceProvenance,
} from '../../../src/deployment/reference-provenance-record.js';
import {
  bodyMayCarryReferences,
  isKnownTokenFreeState,
  markTokenFreeState,
} from '../../../src/state/token-free-state.js';
import type { ResourceState } from '../../../src/types/state.js';

const SM = '{{resolve:secretsmanager:app:SecretString:name::}}';
const SSM = '{{resolve:ssm:/app/name}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const V3 = 'c1b2c3d4-0000-1111-2222-333333333333';

const bag = (): Map<string, string> => new Map();

describe('the pass-local side map', () => {
  it('tags each version by route: readVersions holds only the read-route ones', () => {
    const secrets = bag();
    recordReferenceResolution(secrets, SM, { region: 'us-east-1', version: V1, route: 'literal' });
    recordReferenceResolution(secrets, SM, { region: 'us-east-1', version: V2, route: 'read' });
    expect(passProvenanceFor(secrets, SM)).toEqual({
      region: 'us-east-1',
      versions: [V1, V2],
      readVersions: [V2],
    });
  });

  it('a literal-only token records no readVersions', () => {
    const secrets = bag();
    recordReferenceResolution(secrets, SM, { region: 'us-east-1', version: V1, route: 'literal' });
    expect(passProvenanceFor(secrets, SM)).toEqual({ region: 'us-east-1', versions: [V1] });
  });

  it('two regions are a conflict and drop the region; versions are unioned', () => {
    const secrets = bag();
    recordReferenceResolution(secrets, SM, { region: 'us-east-1', version: V1, route: 'literal' });
    recordReferenceResolution(secrets, SM, { region: 'us-west-2', version: V2, route: 'literal' });
    expect(passProvenanceFor(secrets, SM)).toEqual({ versions: [V1, V2] });
  });

  it('one resolution with no version makes the version arm unknown, not partial', () => {
    const secrets = bag();
    recordReferenceResolution(secrets, SM, { region: 'us-east-1', version: V1, route: 'read' });
    recordReferenceResolution(secrets, SM, {
      region: 'us-east-1',
      version: undefined,
      route: 'literal',
    });
    expect(passProvenanceFor(secrets, SM)).toEqual({ region: 'us-east-1' });
  });

  it('an unknown region drops the region arm', () => {
    const secrets = bag();
    recordReferenceResolution(secrets, SM, { region: undefined, version: V1, route: 'literal' });
    recordReferenceResolution(secrets, SM, { region: 'us-east-1', version: V1, route: 'literal' });
    expect(passProvenanceFor(secrets, SM)).toEqual({ versions: [V1] });
  });

  it('is keyed by map instance: a copy holds nothing; mergeResolvedPairs carries it', () => {
    const from = bag();
    recordReferenceResolution(from, SM, { region: 'us-east-1', version: V1, route: 'literal' });
    expect(hasPassProvenance(from)).toBe(true);
    expect(hasPassProvenance(new Map(from))).toBe(false);
    const to = bag();
    mergeResolvedPairs(from, to);
    expect(passProvenanceFor(to, SM)).toEqual({ region: 'us-east-1', versions: [V1] });
    const other = bag();
    mergeReferenceProvenance(from, other);
    expect(passProvenanceFor(other, SM)).toEqual({ region: 'us-east-1', versions: [V1] });
  });

  it('a carried entry joins on its route, and a missing arm is unknown', () => {
    const secrets = bag();
    recordReferenceProvenanceEntry(secrets, SM, { region: 'us-west-2', versions: [V1] }, 'read');
    expect(passProvenanceFor(secrets, SM)).toEqual({
      region: 'us-west-2',
      versions: [V1],
      readVersions: [V1],
    });
    recordReferenceProvenanceEntry(secrets, SM, { region: 'us-west-2' }, 'read');
    expect(passProvenanceFor(secrets, SM)).toEqual({ region: 'us-west-2' });
  });

  it('a snapshot is frozen at the time it is taken', () => {
    const secrets = bag();
    expect(snapshotPassProvenance(secrets)).toBeUndefined();
    recordReferenceResolution(secrets, SM, { region: 'us-east-1', version: V1, route: 'literal' });
    const snapshot = snapshotPassProvenance(secrets);
    recordReferenceResolution(secrets, SM, { region: 'us-west-2', version: V2, route: 'literal' });
    expect(snapshot?.get(SM)).toEqual({ region: 'us-east-1', versions: [V1] });
  });

  it('more than the cap of versions drops the version arm', () => {
    const secrets = bag();
    for (let i = 0; i <= MAX_REFERENCE_VERSIONS; i++) {
      recordReferenceResolution(secrets, SSM, {
        region: 'us-east-1',
        version: String(i + 1),
        route: 'literal',
      });
    }
    expect(passProvenanceFor(secrets, SSM)).toEqual({ region: 'us-east-1' });
  });
});

describe('validation on read (malformed reads as absent)', () => {
  it('a well-formed entry reads back sorted and deduplicated', () => {
    expect(
      validateReferenceProvenance(SM, {
        region: 'us-east-1',
        versions: [V2, V1, V1],
        readVersions: [V2],
      })
    ).toEqual({ region: 'us-east-1', versions: [V1, V2], readVersions: [V2] });
  });

  it('readVersions not a subset of versions makes the WHOLE entry absent', () => {
    expect(
      validateReferenceProvenance(SM, { region: 'us-east-1', versions: [V1], readVersions: [V2] })
    ).toBeUndefined();
    expect(validateReferenceProvenance(SM, { region: 'us-east-1', readVersions: [V1] })).toBe(
      undefined
    );
  });

  it('a bad region shape drops the region only', () => {
    for (const region of ['US-EAST-1', 'us east 1', '', 'x'.repeat(40), 42]) {
      expect(validateReferenceProvenance(SM, { region, versions: [V1] })).toEqual({
        versions: [V1],
      });
    }
  });

  it('a bad version shape drops the version arm only and keeps the region', () => {
    expect(
      validateReferenceProvenance(SM, { region: 'us-east-1', versions: ['short'], readVersions: [] })
    ).toEqual({ region: 'us-east-1' });
    // An SSM version is a number; a Secrets Manager id is not one.
    expect(validateReferenceProvenance(SSM, { region: 'us-east-1', versions: [V1] })).toEqual({
      region: 'us-east-1',
    });
    expect(validateReferenceProvenance(SSM, { versions: ['3'] })).toEqual({ versions: ['3'] });
    expect(validateReferenceProvenance(SM, { versions: ['3'] })).toEqual({});
  });

  it('more than 8 versions drops the version arm', () => {
    const versions = Array.from({ length: 9 }, (_, i) => String(i + 1));
    expect(validateReferenceProvenance(SSM, { region: 'us-east-1', versions })).toEqual({
      region: 'us-east-1',
    });
  });

  it('a key that is not a whole token, or a non-object entry, reads as absent', () => {
    expect(validateReferenceProvenance('not-a-token', { region: 'us-east-1' })).toBeUndefined();
    expect(validateReferenceProvenance(SM, ['us-east-1'])).toBeUndefined();
    expect(validateReferenceProvenance(SM, null)).toBeUndefined();
  });

  it('reads through own keys only', () => {
    const record = JSON.parse(
      `{"referenceProvenance": {"__proto__": {"region": "us-east-1"}}}`
    ) as unknown;
    expect(recordedProvenanceOf(record, '__proto__')).toBeUndefined();
    expect(recordedProvenanceOf({}, 'constructor')).toBeUndefined();
    expect(referenceProvenanceOf({ referenceProvenance: [] })).toBeUndefined();
    expect(referenceProvenanceOf({ referenceProvenance: {} })).toEqual({});
    expect(outputReferenceProvenanceOf({ outputReferenceProvenance: { A: 1 } }, 'A')).toEqual(
      undefined
    );
  });
});

describe('the persist writer', () => {
  const record = (properties: Record<string, unknown>, attributes?: Record<string, unknown>) => ({
    properties,
    ...(attributes && { attributes }),
  });

  it('a written record keys exactly the tokens it holds, from this pass', () => {
    const secrets = bag();
    recordReferenceResolution(secrets, SM, { region: 'us-east-1', version: V2, route: 'literal' });
    // A token the pass resolved but the record no longer holds is not keyed.
    recordReferenceResolution(secrets, SSM, { region: 'us-east-1', version: '4', route: 'literal' });
    const field = provenanceForWrittenRecord({
      record: record({ QueueName: SM }, { Arn: `arn:aws:sqs:us-east-1:1:${SM}` }),
      secrets,
      previous: undefined,
      inPlace: undefined,
    });
    expect(field).toEqual({ [SM]: { region: 'us-east-1', versions: [V2] } });
  });

  it('a token the pass did not resolve is keyed with {}', () => {
    expect(
      provenanceForWrittenRecord({
        record: record({ A: SM }),
        secrets: (() => {
          const s = bag();
          recordReferenceResolution(s, SSM, { region: 'us-east-1', version: '1', route: 'literal' });
          return s;
        })(),
        previous: undefined,
        inPlace: undefined,
      })
    ).toEqual({ [SM]: {} });
  });

  it('with walkWithoutPassProvenance, a token held unattributed is keyed {} (known)', () => {
    const args = {
      record: record({ A: SM }),
      secrets: bag(),
      previous: undefined,
      inPlace: undefined,
    };
    expect(provenanceForWrittenRecord(args)).toBeUndefined();
    expect(provenanceForWrittenRecord({ ...args, walkWithoutPassProvenance: true })).toEqual({
      [SM]: {},
    });
    expect(
      provenanceForWrittenRecord({
        ...args,
        record: record({ A: 'plain' }),
        walkWithoutPassProvenance: true,
      })
    ).toBeUndefined();
  });

  it('a token-free record persists no field, and costs no walk without pass provenance', () => {
    expect(
      provenanceForWrittenRecord({
        record: record({ A: 'plain' }),
        secrets: bag(),
        previous: undefined,
        inPlace: undefined,
      })
    ).toBeUndefined();
    // A getter would throw if the writer walked the record.
    const untouchable = {
      get properties(): never {
        throw new Error('walked');
      },
    };
    expect(
      provenanceForWrittenRecord({
        record: untouchable,
        secrets: bag(),
        previous: undefined,
        inPlace: undefined,
      })
    ).toBeUndefined();
  });

  describe('in-place update with create-only paths (the mixed-token case)', () => {
    const previous = {
      physicalId: 'q',
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: SM, Tags: [{ Key: 'n', Value: SM }] },
      referenceProvenance: { [SM]: { region: 'us-east-1', versions: [V1] } },
    } as unknown as ResourceState;
    // Rotated (pass V2), and the tag edited: the queue is updated in place.
    const pass = (): Map<string, string> => {
      const s = bag();
      recordReferenceResolution(s, SM, { region: 'us-east-1', version: V2, route: 'literal' });
      return s;
    };
    const written = record({ QueueName: SM, Tags: [{ Key: 'n2', Value: SM }] });

    it('a token under a create-only path unions previous and pass versions; readVersions = pass', () => {
      const field = provenanceForWrittenRecord({
        record: written,
        secrets: pass(),
        previous,
        inPlace: { createOnly: [['QueueName']], attributesCarried: false },
      });
      expect(field).toEqual({ [SM]: { region: 'us-east-1', versions: [V1, V2] } });
    });

    it('with the create-only paths unknown, every token takes the union', () => {
      const field = provenanceForWrittenRecord({
        record: written,
        secrets: pass(),
        previous,
        inPlace: { createOnly: 'all', attributesCarried: false },
      });
      expect(field).toEqual({ [SM]: { region: 'us-east-1', versions: [V1, V2] } });
    });

    it('a token only at mutable paths takes this pass alone', () => {
      const field = provenanceForWrittenRecord({
        record: written,
        secrets: pass(),
        previous,
        inPlace: { createOnly: [['FifoQueue']], attributesCarried: false },
      });
      expect(field).toEqual({ [SM]: { region: 'us-east-1', versions: [V2] } });
    });

    it('a previous record with no field (v11) drops the version arm, keeps the region', () => {
      const field = provenanceForWrittenRecord({
        record: written,
        secrets: pass(),
        previous: { ...previous, referenceProvenance: undefined },
        inPlace: { createOnly: [['QueueName']], attributesCarried: false },
      });
      expect(field).toEqual({ [SM]: { region: 'us-east-1' } });
    });

    it('readVersions stay this pass only, so ⊆ still holds', () => {
      const s = bag();
      recordReferenceResolution(s, SM, { region: 'us-east-1', version: V2, route: 'read' });
      const field = provenanceForWrittenRecord({
        record: written,
        secrets: s,
        previous: {
          ...previous,
          referenceProvenance: { [SM]: { region: 'us-east-1', versions: [V1], readVersions: [V1] } },
        },
        inPlace: { createOnly: [['QueueName']], attributesCarried: false },
      });
      expect(field).toEqual({
        [SM]: { region: 'us-east-1', versions: [V1, V2], readVersions: [V2] },
      });
    });

    it('beyond the cap of 8 the version arm is dropped', () => {
      const many = Array.from({ length: 8 }, (_, i) => `${i}${V3.slice(1)}`);
      const field = provenanceForWrittenRecord({
        record: written,
        secrets: pass(),
        previous: {
          ...previous,
          referenceProvenance: { [SM]: { region: 'us-east-1', versions: many } },
        },
        inPlace: { createOnly: [['QueueName']], attributesCarried: false },
      });
      expect(field).toEqual({ [SM]: { region: 'us-east-1' } });
    });

    it('a token in attributes carried from the previous record takes the union', () => {
      const field = provenanceForWrittenRecord({
        record: record({ Tags: [] }, { Arn: `arn:${SM}` }),
        secrets: pass(),
        previous,
        inPlace: { createOnly: [], attributesCarried: true },
      });
      expect(field).toEqual({ [SM]: { region: 'us-east-1', versions: [V1, V2] } });
    });

    it('a token this pass did not resolve keeps its previous entry', () => {
      const field = provenanceForWrittenRecord({
        record: written,
        secrets: (() => {
          const s = bag();
          recordReferenceResolution(s, SSM, { region: 'us-east-1', version: '2', route: 'literal' });
          return s;
        })(),
        previous: {
          ...previous,
          referenceProvenance: { [SM]: { region: 'us-east-1', versions: [V1], readVersions: [V1] } },
        },
        inPlace: { createOnly: [['QueueName']], attributesCarried: false },
      });
      expect(field).toEqual({
        [SM]: { region: 'us-east-1', versions: [V1], readVersions: [V1] },
      });
    });

    it('two regions across the union drop the region', () => {
      const field = provenanceForWrittenRecord({
        record: written,
        secrets: pass(),
        previous: {
          ...previous,
          referenceProvenance: { [SM]: { region: 'us-west-2', versions: [V1] } },
        },
        inPlace: { createOnly: [['QueueName']], attributesCarried: false },
      });
      expect(field).toEqual({ [SM]: { versions: [V1, V2] } });
    });
  });

  it('withReferenceProvenance keeps, replaces or removes the field', () => {
    const r = { physicalId: 'p', resourceType: 'T', properties: {} } as ResourceState;
    const withField = { ...r, referenceProvenance: { [SM]: {} } };
    expect(withReferenceProvenance(withField, KEEP_REFERENCE_PROVENANCE)).toBe(withField);
    expect(withReferenceProvenance(r, undefined)).toBe(r);
    expect(Object.hasOwn(withReferenceProvenance(withField, undefined), 'referenceProvenance')).toBe(
      false
    );
    expect(withReferenceProvenance(r, { [SM]: { region: 'us-east-1' } }).referenceProvenance).toEqual({
      [SM]: { region: 'us-east-1' },
    });
  });
});

describe('outputs: keyed by output, then token', () => {
  it('two outputs holding one token at two generations do not collide', () => {
    const sinkA = bag();
    recordReferenceResolution(sinkA, SM, { region: 'us-east-1', version: V1, route: 'read' });
    const sinkB = bag();
    recordReferenceResolution(sinkB, SM, { region: 'us-east-1', version: V2, route: 'literal' });
    const sinks = new Map([
      ['OutA', sinkA],
      ['OutB', sinkB],
    ]);
    const field = outputProvenanceForPersist({
      outputs: { OutA: `arn:${SM}`, OutB: SM, Plain: 'x' },
      resolvedThisRun: true,
      carriedFrom: undefined,
      sinkOf: (key) => sinks.get(key),
    });
    expect(field).toEqual({
      OutA: { [SM]: { region: 'us-east-1', versions: [V1], readVersions: [V1] } },
      OutB: { [SM]: { region: 'us-east-1', versions: [V2] } },
    });
  });

  it('a carried bag carries its field verbatim; a merged one writes none', () => {
    const carried = { outputs: {}, outputReferenceProvenance: { OutA: { [SM]: {} } } };
    expect(
      outputProvenanceForPersist({
        outputs: { OutA: SM },
        resolvedThisRun: false,
        carriedFrom: carried,
        sinkOf: () => undefined,
      })
    ).toBe(carried.outputReferenceProvenance);
    expect(
      outputProvenanceForPersist({
        outputs: { OutA: SM },
        resolvedThisRun: false,
        carriedFrom: undefined,
        sinkOf: () => undefined,
      })
    ).toBeUndefined();
  });

  it('an output key spelling __proto__ is an own key', () => {
    const sink = bag();
    recordReferenceResolution(sink, SM, { region: 'us-east-1', version: V1, route: 'literal' });
    const field = outputProvenanceForPersist({
      outputs: JSON.parse(`{"__proto__": "${SM.replace(/"/g, '\\"')}"}`) as Record<string, unknown>,
      resolvedThisRun: true,
      carriedFrom: undefined,
      sinkOf: () => sink,
    });
    expect(field !== undefined && Object.hasOwn(field, '__proto__')).toBe(true);
  });

  it('a key whose sink recorded nothing is omitted, unwalked', () => {
    expect(
      outputProvenanceForPersist({
        outputs: { A: SM },
        resolvedThisRun: true,
        carriedFrom: undefined,
        sinkOf: () => undefined,
      })
    ).toBeUndefined();
  });
});

describe('the token-free fast path', () => {
  it('a body with no token and no field is token-free', () => {
    expect(bodyMayCarryReferences('{"resources":{"A":{"properties":{"N":"x"}}}}')).toBe(false);
    expect(bodyMayCarryReferences(`{"p":"${SM.replace(/"/g, '')}"}`)).toBe(true);
    expect(bodyMayCarryReferences('{"referenceProvenance":{}}')).toBe(true);
    expect(bodyMayCarryReferences('{"outputReferenceProvenance":{}}')).toBe(true);
  });

  it('only a marked state reads as token-free', () => {
    const marked = {};
    markTokenFreeState(marked);
    expect(isKnownTokenFreeState(marked)).toBe(true);
    expect(isKnownTokenFreeState({})).toBe(false);
    expect(isKnownTokenFreeState(undefined)).toBe(false);
  });

  it('referenceTokensIn finds every whole token in every string leaf', () => {
    expect([...referenceTokensIn({ a: [`x${SM}y${SSM}`], b: { c: 3 } })].sort()).toEqual(
      [SM, SSM].sort()
    );
  });
});
