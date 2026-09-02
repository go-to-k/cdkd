import { describe, it, expect } from 'vite-plus/test';
import { preserveLiveValuesAtMaskedLeaves } from '../../../src/cli/commands/drift.js';
import {
  SECRET_MASK,
  redactSecretsForState,
  maskSecretsInText,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// Issue #2274 review round 2, blocker 2 — plus the descent arms the first cut
// shipped unfenced.
//
// `preserveLiveValuesAtMaskedLeaves` deliberately MOVES live plaintext into the
// bag `cdkd drift --revert` sends, because sending the mask would write `***`
// onto the live resource. Its sibling `preserveLiveValuesAtUnresolvedTokens`
// REGISTERS what it moves, and this one did not — so the moved plaintext
// reached `collectNarrowedTopLevelKeys`' `observedProperties` write, the
// `maskSecretsInText(err.message, secrets)` call and the masker handed to
// `provider.update` with no map entry to match. The masked POSITION is the
// proof the value is secret; there is nothing else it could be.
const LIVE = 'live-noecho-plaintext-blocker2';

describe('preserveLiveValuesAtMaskedLeaves (issue #2274)', () => {
  it('REGISTERS the live value it moves, as a mask-only needle', () => {
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Name: '/app/token', Value: SECRET_MASK },
      { Name: '/app/token', Value: LIVE },
      secrets
    );

    expect(properties['Value']).toBe(LIVE);
    expect(unpreservablePaths).toEqual([]);
    // THE assertion. Drop the registration and this is `undefined`.
    expect(secrets.get(LIVE)).toBe(SECRET_MASK);
  });

  it('makes the moved value maskable by the two readers that would have printed it', () => {
    // The registration is not an end in itself: these are the consumers the
    // omission actually exposed. Asserted on the real functions rather than on
    // the map, so the case survives a change in how the needle is spelled.
    const secrets: RecordedSecretValues = new Map();
    preserveLiveValuesAtMaskedLeaves(
      { Value: SECRET_MASK },
      { Value: LIVE },
      secrets
    );

    // 1. the narrowing write into `observedProperties`.
    expect(redactSecretsForState({ Value: LIVE }, secrets)).toEqual({ Value: SECRET_MASK });
    // 2. the AWS error text / retry log.
    expect(maskSecretsInText(`ValidationException: ${LIVE} is invalid`, secrets)).not.toContain(
      LIVE
    );
  });

  it('does NOT register a non-string live value, and still moves it', () => {
    // Stated residual, mirroring the sibling: the redaction walk matches by
    // string value, so there is nothing to key an object on — and sending the
    // mask instead would be the corruption this helper exists to prevent.
    const secrets: RecordedSecretValues = new Map();
    const live = { Nested: 'x' };

    const { properties } = preserveLiveValuesAtMaskedLeaves(
      { Value: SECRET_MASK },
      { Value: live },
      secrets
    );

    expect(properties['Value']).toBe(live);
    expect(secrets.size).toBe(0);
  });

  it('descends ARRAYS positionally and preserves the element AWS holds', () => {
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Tags: [{ Key: 'a', Value: 'plain' }, { Key: 'b', Value: SECRET_MASK }] },
      { Tags: [{ Key: 'a', Value: 'plain' }, { Key: 'b', Value: LIVE }] },
      secrets
    );

    expect((properties['Tags'] as Array<Record<string, unknown>>)[1]!['Value']).toBe(LIVE);
    expect(unpreservablePaths).toEqual([]);
    expect(secrets.get(LIVE)).toBe(SECRET_MASK);
  });

  it('reports the path UNPRESERVABLE when the arrays differ in LENGTH', () => {
    // Positional descent bails on any length mismatch — a reordered or
    // resized readback cannot be positioned against, and guessing would put
    // one element's live value at another's index. The dotted path names the
    // element so the refusal message can point at it.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Tags: [{ Key: 'b', Value: SECRET_MASK }] },
      { Tags: [{ Key: 'a', Value: 'plain' }, { Key: 'b', Value: LIVE }] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Tags[0].Value']);
    expect((properties['Tags'] as Array<Record<string, unknown>>)[0]!['Value']).toBe(SECRET_MASK);
    // Nothing was moved, so nothing is registered.
    expect(secrets.size).toBe(0);
  });

  it('descends NESTED OBJECTS and names the dotted path when AWS has nothing there', () => {
    const secrets: RecordedSecretValues = new Map();

    const { unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Environment: { Variables: { TOKEN: SECRET_MASK } } },
      { Environment: { Variables: {} } },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Environment.Variables.TOKEN']);
  });

  it('returns the input bag BY IDENTITY when it holds no mask', () => {
    // The ordinary revert must be byte-identical: this pass runs
    // unconditionally, unlike its token-gated sibling.
    const secrets: RecordedSecretValues = new Map();
    const send = { Name: '/app/token', Value: 'ordinary' };

    const result = preserveLiveValuesAtMaskedLeaves(send, { Value: 'changed' }, secrets);

    expect(result.properties).toBe(send);
    expect(secrets.size).toBe(0);
  });
});
