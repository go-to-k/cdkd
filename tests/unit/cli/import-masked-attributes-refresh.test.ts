import { describe, expect, it } from 'vite-plus/test';
import { carriesSecretMask } from '../../../src/deployment/secret-redaction.js';

/**
 * A re-import must be able to CLEAR a masked attributes bag (issue
 * go-to-k/cdkd#2927).
 *
 * `CloudControlProvider.import` masks the model keys it cannot certify
 * (go-to-k/cdkd#2847), and `DeployEngine.refuseRedactedAttributeReads` tells the
 * user to re-import the resource to rewrite them. When the second `GetResource`
 * also yields no usable model, `import()` returns `attributes: {}`, which
 * `buildStackState` normalises to `undefined` and then replaces with the STORED
 * bag — the masked one — because the physical id is unchanged across a
 * re-import. The next deploy raises the identical refusal, naming a remedy the
 * user has just followed.
 *
 * This pins the DISCRIMINATOR the fix keys on rather than re-deriving
 * `buildStackState` here: the carry-over is guarded by `carriesSecretMask` on
 * the stored bag, so a masked bag is dropped and every other bag is still
 * carried (go-to-k/cdkd#1098 — a provider reporting no attributes must not wipe
 * a good map).
 */
const MASK = '***';

describe('import: a masked attributes bag must not be carried across a re-import', () => {
  it('recognises a masked bag at the top level and nested', () => {
    expect(carriesSecretMask({ Token: MASK })).toBe(true);
    expect(carriesSecretMask({ Nested: { Deep: MASK } })).toBe(true);
  });

  it('does NOT recognise an ordinary bag, so go-to-k/cdkd#1098 carry-over survives', () => {
    // The fix must not turn into "always drop the stored map": that is the
    // wipe go-to-k/cdkd#1098 added the fallback to prevent.
    expect(carriesSecretMask({ Arn: 'arn:aws:s3:::b' })).toBe(false);
    expect(carriesSecretMask({})).toBe(false);
    expect(carriesSecretMask(undefined)).toBe(false);
    // A value that merely CONTAINS the mask characters is not a masked leaf —
    // the recogniser is whole-leaf, so an ordinary name embedding them stays
    // carryable.
    expect(carriesSecretMask({ Name: `a${MASK}b` })).toBe(false);
  });

  it('the guard is the stored bag, not the incoming one', () => {
    // Stated as a test because the inverse reading is the easy mistake: the
    // provider's fresh `{}` is what TRIGGERS the fallback, so guarding on it
    // would never fire. The decision is about `prior.attributes`.
    const prior = { Token: MASK };
    const fresh: Record<string, unknown> = {};
    const freshIsEmpty = Object.keys(fresh).length === 0;
    expect(freshIsEmpty).toBe(true);
    expect(carriesSecretMask(prior)).toBe(true);
  });
});
