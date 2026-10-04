import { describe, it, expect } from 'vite-plus/test';
import { acceptedCreateOnlyDropsField } from '../../../src/deployment/deploy-engine/record-shape.js';
import {
  getPropertyCoverage,
  unwrittenCreateOnlyReplacement,
} from '../../../src/provisioning/property-coverage.js';
import { acceptedCreateOnlyDropsOf } from '../../../src/types/state.js';
import { childStoredInParentTypes } from '../../../src/deployment/child-of-recreated-parent.js';

/**
 * go-to-k/cdkd#2790 — `ResourceState.acceptedCreateOnlyDrops`, the evidence
 * that a create-only key in a record never reached AWS: its writer, its
 * reader, and the shared refusal predicate that reads it.
 */
const TYPE = 'AWS::EC2::Subnet';
const CREATE_ONLY = 'AvailabilityZoneId';
const PLAIN = 'EnableDns64';
const WRITTEN = { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/24' };
const RECORD = { ...WRITTEN, [CREATE_ONLY]: 'use1-az1' };

it('PREMISE: AvailabilityZoneId is a create-only drop, EnableDns64 a plain one', () => {
  const cov = getPropertyCoverage(TYPE);
  if (!cov) throw new Error(`${TYPE} lost its property-coverage record`);
  expect(cov.createOnlyDrops.has(CREATE_ONLY)).toBe(true);
  expect(cov.createOnlyDrops.has(PLAIN)).toBe(false);
  expect(cov.silentDrop.has(PLAIN)).toBe(true);
});

describe('acceptedCreateOnlyDropsField (the writer)', () => {
  it('an SDK-route CREATE or REPLACEMENT names every create-only drop it kept', () => {
    expect(
      acceptedCreateOnlyDropsField({ ...RECORD, [PLAIN]: true }, TYPE, 'sdk', 'new-resource')
    ).toEqual({ acceptedCreateOnlyDrops: [CREATE_ONLY] });
  });

  it('a new resource REBUILDS the evidence, ignoring the previous record', () => {
    expect(
      acceptedCreateOnlyDropsField(WRITTEN, TYPE, 'sdk', 'new-resource', {
        acceptedCreateOnlyDrops: [CREATE_ONLY],
      })
    ).toEqual({ acceptedCreateOnlyDrops: undefined });
  });

  it('a Cloud Control write clears it: Cloud Control sends the full bag', () => {
    expect(acceptedCreateOnlyDropsField(RECORD, TYPE, 'cc-api', 'new-resource')).toEqual({
      acceptedCreateOnlyDrops: undefined,
    });
    expect(
      acceptedCreateOnlyDropsField(RECORD, TYPE, 'cc-api', 'in-place', {
        acceptedCreateOnlyDrops: [CREATE_ONLY],
      })
    ).toEqual({ acceptedCreateOnlyDrops: undefined });
  });

  it('an in-place update CARRIES the previous evidence for a key still recorded', () => {
    expect(
      acceptedCreateOnlyDropsField(RECORD, TYPE, 'sdk', 'in-place', {
        acceptedCreateOnlyDrops: [CREATE_ONLY],
      })
    ).toEqual({ acceptedCreateOnlyDrops: [CREATE_ONLY] });
  });

  it('an in-place update never ASSERTS new evidence (an imported record holds the key)', () => {
    expect(acceptedCreateOnlyDropsField(RECORD, TYPE, 'sdk', 'in-place', {})).toEqual({
      acceptedCreateOnlyDrops: undefined,
    });
    expect(acceptedCreateOnlyDropsField(RECORD, TYPE, 'sdk', 'in-place')).toEqual({
      acceptedCreateOnlyDrops: undefined,
    });
  });

  it('an in-place update drops evidence for a key no longer recorded', () => {
    expect(
      acceptedCreateOnlyDropsField(WRITTEN, TYPE, 'sdk', 'in-place', {
        acceptedCreateOnlyDrops: [CREATE_ONLY],
      })
    ).toEqual({ acceptedCreateOnlyDrops: undefined });
  });

  it('always returns the key, so a rebuilt record spread over an old one clears it', () => {
    expect(Object.hasOwn(acceptedCreateOnlyDropsField(WRITTEN, TYPE, 'sdk', 'new-resource'), 'acceptedCreateOnlyDrops')).toBe(true);
    expect(JSON.parse(JSON.stringify(acceptedCreateOnlyDropsField(WRITTEN, TYPE, 'sdk', 'new-resource')))).toEqual({});
  });
});

describe('acceptedCreateOnlyDropsOf (the reader)', () => {
  it('reads a well-formed field', () => {
    expect([...acceptedCreateOnlyDropsOf({ acceptedCreateOnlyDrops: [CREATE_ONLY] })]).toEqual([
      CREATE_ONLY,
    ]);
  });

  it.each([
    ['absent', {}],
    ['a string', { acceptedCreateOnlyDrops: CREATE_ONLY }],
    ['an object', { acceptedCreateOnlyDrops: { [CREATE_ONLY]: true } }],
    ['null', { acceptedCreateOnlyDrops: null }],
    ['a null record', null],
  ])('%s is NO evidence', (_label, record) => {
    expect(acceptedCreateOnlyDropsOf(record).size).toBe(0);
  });

  it('drops a non-string entry rather than the whole field', () => {
    expect([...acceptedCreateOnlyDropsOf({ acceptedCreateOnlyDrops: [1, CREATE_ONLY] })]).toEqual([
      CREATE_ONLY,
    ]);
  });
});

describe('unwrittenCreateOnlyReplacement (the shared refusal predicate)', () => {
  const NONE = new Set<string>();
  const EVIDENCE = new Set([CREATE_ONLY]);

  it('fires when every replacing path is a named, unaccepted, unchanged key', () => {
    expect(
      unwrittenCreateOnlyReplacement(TYPE, RECORD, RECORD, NONE, EVIDENCE, [CREATE_ONLY])
    ).toEqual([CREATE_ONLY]);
  });

  it('does not fire without evidence', () => {
    expect(
      unwrittenCreateOnlyReplacement(TYPE, RECORD, RECORD, NONE, NONE, [CREATE_ONLY])
    ).toEqual([]);
  });

  it('does not fire when another path also requires the replacement', () => {
    expect(
      unwrittenCreateOnlyReplacement(TYPE, RECORD, RECORD, NONE, EVIDENCE, [
        CREATE_ONLY,
        'CidrBlock',
      ])
    ).toEqual([]);
  });

  it('does not fire with nothing replacing', () => {
    expect(unwrittenCreateOnlyReplacement(TYPE, RECORD, RECORD, NONE, EVIDENCE, [])).toEqual([]);
  });
});

/**
 * `cdkd diff`'s label (`findUnwrittenCreateOnlyRefusals`) omits the engine's
 * `lostWithParent` exclusion because the two populations are disjoint: a
 * child the engine re-creates with its parent is one of these types, and none
 * of them has a create-only silent drop, so none can carry evidence. A type
 * gaining one here must add the exclusion to the diff label.
 */
it('no child-of-a-recreated-parent type has a create-only silent drop', () => {
  const types = childStoredInParentTypes();
  expect(types.length).toBeGreaterThan(5);
  expect(
    types.filter((type) => (getPropertyCoverage(type)?.createOnlyDrops.size ?? 0) > 0)
  ).toEqual([]);
});
