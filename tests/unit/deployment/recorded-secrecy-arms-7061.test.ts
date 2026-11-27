import { describe, expect, it } from 'vite-plus/test';
import { maskUnmovedRedactionMasks } from '../../../src/analyzer/diff-calculator/redaction-masks.js';
import {
  recordHoldsEmbeddedReference,
  recordPreviousNoEchoLeaves,
} from '../../../src/deployment/deploy-engine/update/helpers.js';
import { maskedPropertyFingerprint } from '../../../src/deployment/masked-property-fingerprints.js';
import { logOnlyValuesOf } from '../../../src/deployment/secret-redaction/log-only.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

/**
 * go-to-k/cdkd#7061: the marker arms the recorded-secrecy migration moved and
 * no behavioural test reached, each pinned in BOTH directions (a mutant that
 * reads the predicate as always-true or always-false fails here).
 */

describe('maskUnmovedRedactionMasks: a desired side already carrying a mask (#7050 review arm)', () => {
  const raw = { Tags: { Ref: 'X' } };
  const TEXT = maskedPropertyFingerprint(raw.Tags);
  const PROVEN = `inputs-sha256:aa+${TEXT}`;
  const record = {
    properties: {},
    maskedPropertyFingerprints: { Tags: TEXT },
    maskedPropertyInputFingerprints: { Tags: PROVEN },
  } as never;
  // Every input proven unmoved: a key that reaches the fingerprints is masked.
  const fingerprinter = Object.assign(async () => PROVEN, { concrete: async () => true });
  const run = (current: unknown, desired: unknown) =>
    maskUnmovedRedactionMasks(record, raw, { Tags: current }, { Tags: desired }, fingerprinter);

  it('a record masking a LEAF leaves a desired side holding a mask to the NoEcho comparison', async () => {
    // Without the arm this reaches the fingerprints and masks position 1.
    const out = await run(['x', '***'], ['***', 'y']);
    expect(out['Tags']).toEqual(['***', 'y']);
  });

  it('a record masking a LEAF masks an unmasked desired side at that leaf', async () => {
    // The arm reads the desired side too: one holding no mask is not skipped.
    const out = await run(['x', '***'], ['x', 'y']);
    expect(out['Tags']).toEqual(['x', '***']);
  });

  it('a record masking the key WHOLE still masks a desired side holding a mask', async () => {
    // A nested child's read of a masked parameter: the arm must not skip it.
    const out = await run('***', ['***']);
    expect(out['Tags']).toBe('***');
  });
});

describe('recordPreviousNoEchoLeaves: the mask is never a needle', () => {
  const needles = (registry: RecordedSecretValues): string[] => [...(logOnlyValuesOf.get(registry) ?? [])].sort();

  it('records a stored leaf, not the mask beside it', () => {
    const registry: RecordedSecretValues = new Map();
    recordPreviousNoEchoLeaves(registry, ['***', 'old-pw'], new Set(), new Map(), false);
    expect(needles(registry)).toEqual(['old-pw']);
  });

  it('records the partly masked spelling, never a spelling masked whole', () => {
    const resolution: RecordedSecretValues = new Map([['inner-secret', '{{resolve:ssm-secure:/a}}']]);
    const embedded: RecordedSecretValues = new Map();
    recordPreviousNoEchoLeaves(embedded, 'pre-inner-secret', new Set(), resolution, false);
    expect(needles(embedded)).toEqual(['pre-***', 'pre-inner-secret']);

    const whole: RecordedSecretValues = new Map();
    recordPreviousNoEchoLeaves(whole, 'inner-secret', new Set(), resolution, false);
    expect(needles(whole)).toEqual(['inner-secret']);
  });
});

describe('recordHoldsEmbeddedReference', () => {
  it.each<[string, unknown, boolean]>([
    ['a plain value', { A: 'plain' }, false],
    ['a whole reference token', { A: '{{resolve:ssm:/p}}' }, false],
    ['an embedded reference', { A: 's3://b/{{resolve:ssm:/p}}' }, true],
    ['a nested embedded reference', { A: [{ B: 'x-{{resolve:secretsmanager:s}}' }] }, true],
  ])('%s', (_what, properties, expected) => {
    expect(recordHoldsEmbeddedReference({ properties })).toBe(expected);
    expect(recordHoldsEmbeddedReference({ properties: {}, attributes: properties })).toBe(expected);
  });
});
