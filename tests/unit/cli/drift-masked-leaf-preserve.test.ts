import { describe, it, expect } from 'vite-plus/test';
import {
  buildRevertNewProperties,
  collectUnresolvedIntrinsicObjectPaths,
  preserveLiveValuesAtMaskedLeaves,
  preserveLiveValuesAtUnresolvedTokens,
} from '../../../src/cli/commands/drift.js';
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

  it('reports the path UNPRESERVABLE when UNKEYED arrays differ in LENGTH', () => {
    // With no identity field, positional alignment is all that is left and it
    // bails on any length mismatch — a resized readback cannot be positioned
    // against, and guessing would put one element's live value at another's
    // index. The dotted path names the element so the refusal message can point
    // at it.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Args: ['--pw', SECRET_MASK] },
      { Args: ['--pw', LIVE, '--verbose'] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Args[1]']);
    expect((properties['Args'] as unknown[])[1]).toBe(SECRET_MASK);
    // Nothing was moved, so nothing is registered.
    expect(secrets.size).toBe(0);
  });

  it('pairs by IDENTITY when AWS ADDED an element, instead of refusing on LENGTH', () => {
    // The length test used to run AHEAD of `identityKeyFor`, so a list AWS
    // legitimately added an entry to was refused even though `Key` identifies
    // every element on both sides — the arm the redaction walk itself accepts.
    // This shape was pinned with the OPPOSITE expectation until the length test
    // moved into the unkeyed arm.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Tags: [{ Key: 'b', Value: SECRET_MASK }] },
      { Tags: [{ Key: 'a', Value: 'plain' }, { Key: 'b', Value: LIVE }] },
      secrets
    );

    expect(unpreservablePaths).toEqual([]);
    expect((properties['Tags'] as Array<Record<string, unknown>>)[0]!['Value']).toBe(LIVE);
    expect(secrets.get(LIVE)).toBe(SECRET_MASK);
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

  // ---------------------------------------------------------------- #2884 --
  //
  // Until issue #2852 the only mask in a persisted bag came from a `NoEcho`
  // custom resource's `Data`, which sits at a scalar leaf of a property the
  // template names — so index alignment was rarely asked a hard question. #2852
  // added a second source and it lands in exactly the population index
  // alignment is WRONG on: a leaf is masked BECAUSE the redaction walk could
  // not pair the two lists.

  it('refuses rather than copying by INDEX when AWS reordered and renamed the identity', () => {
    // The traced data-loss scenario, and the reason this arm exists. AWS echoes
    // `DB_PASS` back case-normalised AND reordered, so the redaction walk could
    // not pair the element and masked it. Index alignment would then copy
    // `live[1]` — the REGION entry — into the masked slot, shipping a
    // duplicated REGION and DELETING the password variable from the live task
    // definition. That is the issue #1498 / #1501 class, strictly worse than
    // the disclosure the mask exists to prevent.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      {
        Environment: [
          { Name: 'REGION', Value: 'us-east-1' },
          { Name: SECRET_MASK, Value: SECRET_MASK },
        ],
      },
      {
        Environment: [
          { Name: 'db_pass', Value: 'the-live-password' },
          { Name: 'REGION', Value: 'us-east-1' },
        ],
      },
      secrets
    );

    // The masked slot keeps its mask and is REPORTED, so the caller refuses the
    // whole resource rather than sending a guess.
    expect(unpreservablePaths).toEqual(['Environment[1].Name', 'Environment[1].Value']);
    const env = properties['Environment'] as Array<Record<string, unknown>>;
    expect(env[1]!['Value']).toBe(SECRET_MASK);
    // The decisive assertion: REGION's live value was NOT copied into the
    // masked slot. Asserting only the mask would pass on a walk that copied
    // nothing for an unrelated reason.
    expect(env[1]!['Value']).not.toBe('us-east-1');
    expect(secrets.size).toBe(0);
  });

  it('PAIRS BY IDENTITY across a reorder, which index alignment could not', () => {
    // The polarity that keeps the case above from being "an array with a mask
    // is always refused". `Name` is an identity field present and unique on
    // both sides, so AWS reordering the list is not an obstacle — this arm is
    // strictly BETTER than the index alignment it replaces, not just stricter.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      {
        Environment: [
          { Name: 'DB_PASS', Value: SECRET_MASK },
          { Name: 'REGION', Value: 'us-east-1' },
        ],
      },
      {
        Environment: [
          { Name: 'REGION', Value: 'us-east-1' },
          { Name: 'DB_PASS', Value: LIVE },
        ],
      },
      secrets
    );

    const env = properties['Environment'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(LIVE);
    expect(unpreservablePaths).toEqual([]);
    expect(secrets.get(LIVE)).toBe(SECRET_MASK);
  });

  it('keeps index alignment for an UNKEYED array whose other positions corroborate', () => {
    // No identity field, so the array's own literal FRAME has to vouch for the
    // order — the same corroboration `unkeyedArrayPairsByAnchors` requires on
    // the redaction side. Here every non-mask position is deep-equal, so the
    // order is evidence and the live value is preserved.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Command: ['--pw', SECRET_MASK, '--verbose'] },
      { Command: ['--pw', LIVE, '--verbose'] },
      secrets
    );

    expect((properties['Command'] as unknown[])[1]).toBe(LIVE);
    expect(unpreservablePaths).toEqual([]);
  });

  it('refuses an UNKEYED array whose sibling positions do NOT corroborate', () => {
    // ...and the other half: AWS normalised a sibling, so nothing vouches for
    // the alignment and there is no honest value to copy.
    const secrets: RecordedSecretValues = new Map();

    const { unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Command: ['--pw', SECRET_MASK, 'us-east-1'] },
      { Command: ['--pw', LIVE, 'US-EAST-1'] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Command[1]']);
    expect(secrets.size).toBe(0);
  });

  // The corroboration arm's own round. Its first cut exempted the whole
  // ELEMENT — `carriesSecretMask(item) || deepEqualUnordered(item, live[i])` —
  // and since `carriesSecretMask` is a DEEP, whole-subtree test, any element
  // holding a mask anywhere skipped the comparison. Three fixtures, each
  // measured against the shipped bundle, showed it corroborating nothing.

  it('refuses a mask-bearing element whose OWN literals contradict the live one', () => {
    // Fixture 1: exactly ONE masked slot, and the sibling element is
    // positionally equal — so the whole-element exemption accepted the
    // alignment on the strength of an element that was never in doubt, and
    // copied `ADMIN-PW` onto the entry whose surviving literal says `reader`.
    // The per-LEAF test reads `Role` INSIDE the masked element and refuses.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      {
        Creds: [
          { Pw: SECRET_MASK, Role: 'reader' },
          { Pw: 'shared', Role: 'shared' },
        ],
      },
      {
        Creds: [
          { Pw: 'ADMIN-PW', Role: 'admin' },
          { Pw: 'shared', Role: 'shared' },
        ],
      },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Creds[0].Pw']);
    const creds = properties['Creds'] as Array<Record<string, unknown>>;
    // The decisive assertion: the admin password was not written onto the
    // reader entry. Asserting only the mask would pass on a walk that copied
    // nothing for an unrelated reason.
    expect(creds[0]!['Pw']).not.toBe('ADMIN-PW');
    expect(creds[0]!['Pw']).toBe(SECRET_MASK);
    expect(secrets.size).toBe(0);
  });

  it('refuses a VACUOUS corroboration — an element with no non-mask leaf at all', () => {
    // Fixture 2: one element, every leaf masked. `every` was vacuously true, so
    // `live` came back for index pairing on ZERO evidence. Reachable from this
    // PR's own worked example: `refuseUncertifiedSubtree` masks the identity
    // field too when AWS normalised it, which is also what defeats
    // `identityKeyFor` — `***` is no longer unique.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Creds: [{ Pw: SECRET_MASK, Token: SECRET_MASK }] },
      { Creds: [{ Pw: 'live-pw', Token: 'live-token' }] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Creds[0].Pw', 'Creds[0].Token']);
    const creds = properties['Creds'] as Array<Record<string, unknown>>;
    expect(creds[0]!['Pw']).not.toBe('live-pw');
    expect(creds[0]!['Token']).not.toBe('live-token');
    expect(secrets.size).toBe(0);
  });

  it('refuses when TWO elements carry a mask, which the literal frame cannot place', () => {
    // Fixture 3: two secret environment variables in one container definition,
    // the ordinary shape. The surviving `REGION` frame proves the list is the
    // same list; it says nothing about WHICH masked slot each remaining live
    // entry belongs to, so index pairing copied `api_key`'s and `db_pass`'s
    // values into whichever slot happened to sit at their index.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      {
        Environment: [
          { Name: SECRET_MASK, Value: SECRET_MASK },
          { Name: 'REGION', Value: 'us-east-1' },
          { Name: SECRET_MASK, Value: SECRET_MASK },
        ],
      },
      {
        Environment: [
          { Name: 'api_key', Value: 'live-api-key' },
          { Name: 'REGION', Value: 'us-east-1' },
          { Name: 'db_pass', Value: 'live-db-pass' },
        ],
      },
      secrets
    );

    expect(unpreservablePaths).toEqual([
      'Environment[0].Name',
      'Environment[0].Value',
      'Environment[2].Name',
      'Environment[2].Value',
    ]);
    const env = properties['Environment'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).not.toBe('live-api-key');
    expect(env[2]!['Value']).not.toBe('live-db-pass');
    expect(secrets.size).toBe(0);
  });

  it('refuses the measured credential SWAP: two masks against a reordered live list', () => {
    // The shape traced through the shipped `pairedLiveItems`: with both
    // elements mask-bearing the old `every` was vacuously true, so the revert
    // sent `[{Pw:'ADMIN-PW',Role:'reader'},{Pw:'READER-PW',Role:'admin'}]` —
    // each password written onto the OTHER principal's entry, and
    // `provider.update` shipped it.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      {
        Creds: [
          { Pw: SECRET_MASK, Role: 'reader' },
          { Pw: SECRET_MASK, Role: 'admin' },
        ],
      },
      {
        Creds: [
          { Pw: 'ADMIN-PW', Role: 'admin' },
          { Pw: 'READER-PW', Role: 'reader' },
        ],
      },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Creds[0].Pw', 'Creds[1].Pw']);
    const creds = properties['Creds'] as Array<Record<string, unknown>>;
    expect(creds[0]!['Pw']).toBe(SECRET_MASK);
    expect(creds[1]!['Pw']).toBe(SECRET_MASK);
    expect(JSON.stringify(properties)).not.toContain('ADMIN-PW');
    expect(JSON.stringify(properties)).not.toContain('READER-PW');
    expect(secrets.size).toBe(0);
  });

  it('still preserves when the masked element carries its OWN corroborating literal', () => {
    // The over-refusal bound: refusing every array that holds a mask satisfies
    // all four cases above, and would be wrong. `Sel` is not an
    // `ARRAY_IDENTITY_KEYS` field so no keyed pairing is available, but it is a
    // literal INSIDE the masked element that the live side matches, and it is
    // the only masked slot — so the frame does place it and the live value is
    // preserved.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      {
        Creds: [
          { Sel: 'primary', Pw: SECRET_MASK },
          { Sel: 'replica', Pw: 'plain' },
        ],
      },
      {
        Creds: [
          { Sel: 'primary', Pw: LIVE },
          { Sel: 'replica', Pw: 'plain' },
        ],
      },
      secrets
    );

    expect(unpreservablePaths).toEqual([]);
    expect((properties['Creds'] as Array<Record<string, unknown>>)[0]!['Pw']).toBe(LIVE);
    expect(secrets.get(LIVE)).toBe(SECRET_MASK);
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

// ------------------------------------------------------- #2884, round 4 --
//
// `runRevert` runs `preserveLiveValuesAtUnresolvedTokens` FIRST, and that pass
// copies live values into whole-token leaves — BY INDEX when this block was
// written, by certified pairing since issue #2893. Either way a copied leaf is
// trivially deep-equal to `live` at its own position, so corroborating the
// post-token bag against the same `live` counts evidence the sibling pass
// manufactured, not the array's own frame. The fix: the caller passes the
// PRE-token bag as `corroborationSource`, so pairing evidence (identity lookup
// AND per-leaf corroboration) is read from values no pass copied from `live`.
// These cases run the two passes in `runRevert`'s exact order and wiring.

// Whole-token spellings the resolver resolves for nobody — the population that
// survives to `preserveLiveValuesAtUnresolvedTokens` since issue #2482.
const TOK_A = '{{resolve:notaservice:/cdkd/round4/a}}';
const TOK_B = '{{resolve:notaservice:/cdkd/round4/b}}';
const TOK_C = '{{resolve:notaservice:/cdkd/round4/c}}';

/** `runRevert`'s exact composition: the token pass first, then the mask pass
 * corroborated against the PRE-token bag. */
function runBothPasses(
  overlaid: Record<string, unknown>,
  aws: Record<string, unknown>,
  secrets: RecordedSecretValues
): { properties: Record<string, unknown>; unpreservablePaths: string[] } {
  const tokenPreserved = preserveLiveValuesAtUnresolvedTokens(overlaid, aws);
  return preserveLiveValuesAtMaskedLeaves(tokenPreserved, aws, secrets, overlaid);
}

describe('corroboration must be GENUINE, not manufactured by the token pass (#2884 round 4)', () => {
  it('refuses the token-only frame whose corroboration the token pass fabricated (reordered live)', () => {
    // The round-4 attack shape: the only non-mask leaves are unresolved
    // tokens. The token pass copies live[i] into every token leaf, so the
    // post-token bag deep-equals `live` at every non-mask position BY
    // CONSTRUCTION — `compared > 0` and `maskedSlots === 1` both hold on
    // fabricated evidence, and with `live` reordered the masked slot took the
    // OTHER element's secret. Corroborated against the PRE-token bag, a token
    // leaf contradicts the resolved live value and the array refuses.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = runBothPasses(
      { I: [{ Tok: TOK_A, Pw: SECRET_MASK }, { Tok: TOK_B, Pw: TOK_C }] },
      // Reordered: the baseline's element 0 (the TOK_A frame) truly
      // corresponds to live element 1.
      { I: [{ Tok: 'resolved-b', Pw: 'reader-pw' }, { Tok: 'resolved-a', Pw: 'admin-pw' }] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['I[0].Pw']);
    const items = properties['I'] as Array<Record<string, unknown>>;
    expect(items[0]!['Pw']).toBe(SECRET_MASK);
    // The decisive assertion: neither element's password was written into the
    // masked slot by index.
    expect(items[0]!['Pw']).not.toBe('reader-pw');
    expect(items[0]!['Pw']).not.toBe('admin-pw');
    expect(secrets.size).toBe(0);
  });

  it('refuses the same shape when live arrived in the SAME order — a stated cost', () => {
    // With zero leaves the token pass did not rewrite, the array carries no
    // genuine frame at all, and cdkd cannot tell this ordering from the
    // reordered one above. Refusing both is deliberate: a token leaf's live
    // counterpart is unknowable, so it can neither corroborate nor be
    // wildcarded (an abstention would make token leaves unbounded wildcards
    // beside the deliberately bounded one-mask rule).
    const secrets: RecordedSecretValues = new Map();

    const { unpreservablePaths } = runBothPasses(
      { I: [{ Tok: TOK_A, Pw: SECRET_MASK }, { Tok: TOK_B, Pw: TOK_C }] },
      { I: [{ Tok: 'resolved-a', Pw: 'admin-pw' }, { Tok: 'resolved-b', Pw: 'reader-pw' }] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['I[0].Pw']);
    expect(secrets.size).toBe(0);
  });

  it('refuses an unkeyed array whose frame mixes a genuine literal with a token — a stated cost', () => {
    // The genuine `A` leaves corroborate, but the token leaf in the sibling
    // element contradicts the resolved live value it sits beside. This is the
    // over-refusal the pre-token corroboration costs, and it is deliberate:
    // treating the token as an abstention would re-admit per-element evidence
    // the frame cannot bound (see the case above), for a population — an
    // unkeyed array carrying BOTH a #2852 mask AND a #2482-surviving token —
    // that is vanishingly rare, on the refusal residual (the resource is
    // dropped and reported; nothing wrong is written).
    const secrets: RecordedSecretValues = new Map();

    const { unpreservablePaths } = runBothPasses(
      { I: [{ A: 'x', Pw: SECRET_MASK }, { A: 'y', Pw: TOK_A }] },
      { I: [{ A: 'x', Pw: 'live-0' }, { A: 'y', Pw: 'resolved-a' }] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['I[0].Pw']);
    expect(secrets.size).toBe(0);
  });

  it('still preserves a mask whose array is token-free, with a token elsewhere in the bag', () => {
    // The bound on the refusals above: the corroboration change is confined to
    // arrays that themselves hold a token. A genuine literal frame in one key
    // still vouches for its own order while the token pass preserves an
    // unrelated key, exactly as before.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = runBothPasses(
      { Command: ['--pw', SECRET_MASK, '--verbose'], Url: TOK_A },
      { Command: ['--pw', LIVE, '--verbose'], Url: 'live-url' },
      secrets
    );

    expect(unpreservablePaths).toEqual([]);
    expect((properties['Command'] as unknown[])[1]).toBe(LIVE);
    expect(properties['Url']).toBe('live-url');
    expect(secrets.get(LIVE)).toBe(SECRET_MASK);
  });

  it('still pairs by a GENUINE identity field across a reorder, token leaves notwithstanding', () => {
    // Identity pairing reads the PRE-token `Name` values, so a reorder is
    // still paired correctly and the mask takes the element AWS reports under
    // the same identity — not the element at its index. (The token leaf's own
    // value after the by-index token pass is issue #2893's residual and is
    // deliberately not asserted here.)
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = runBothPasses(
      {
        Env: [
          { Name: 'DB', Value: SECRET_MASK },
          { Name: 'REGION', Value: TOK_A },
        ],
      },
      {
        Env: [
          { Name: 'REGION', Value: 'resolved-region' },
          { Name: 'DB', Value: LIVE },
        ],
      },
      secrets
    );

    expect(unpreservablePaths).toEqual([]);
    const env = properties['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(LIVE);
    expect(secrets.get(LIVE)).toBe(SECRET_MASK);
  });

  it('refuses identity pairing LAUNDERED through the token pass — an identity field that was itself a token', () => {
    // The fabrication's second door, which a corroboration-only fix would have
    // left open: with the identity field holding a token, the token pass
    // copies live[i].Name in BY INDEX, and the keyed lookup then "pairs" each
    // element straight back to its own index — index alignment wearing an
    // identity disguise. Read from the PRE-token bag, the identity is the
    // token, which matches no live element, so the mask has no live value and
    // the path refuses.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = runBothPasses(
      {
        Env: [
          { Name: TOK_A, Value: SECRET_MASK },
          { Name: TOK_B, Value: 'v' },
        ],
      },
      {
        Env: [
          { Name: 'nb', Value: 'vb' },
          { Name: 'na', Value: 'va' },
        ],
      },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Env[0].Value']);
    const env = properties['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(SECRET_MASK);
    expect(env[0]!['Value']).not.toBe('vb');
    expect(secrets.size).toBe(0);
  });
});

describe('nested arrays (#2884 coverage)', () => {
  // Deliberately run in the 3-arg SELF-corroboration mode: the 4-arg
  // corroboration-source threading is structural (each `corr` node rides
  // beside its `value` node), so the round-4 cases above exercising it at the
  // top level cover the mechanism, and a nested variant would re-test the
  // same threading. What these cases pin is `pairedLiveItems`' own recursion
  // and the per-LEVEL one-mask bound.
  it('preserves through a nested array whose every level corroborates', () => {
    // `pairedLiveItems` recurses uniformly: the outer pairing counts the inner
    // array's leaves through `corroboratedLeafCount`, and the inner array is
    // then paired again on its own descent.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { M: [['--pw', SECRET_MASK], ['c', 'd']] },
      { M: [['--pw', LIVE], ['c', 'd']] },
      secrets
    );

    expect(unpreservablePaths).toEqual([]);
    expect((properties['M'] as unknown[][])[0]![1]).toBe(LIVE);
    expect(secrets.get(LIVE)).toBe(SECRET_MASK);
  });

  it('refuses TWO mask-carrying elements at one level, even with the masks in different inner arrays', () => {
    // The one-mask bound counts mask-CARRYING elements per array level
    // (`carriesSecretMask` is deep), so two inner arrays each holding one mask
    // still leave the OUTER level unable to say which inner list is which.
    const secrets: RecordedSecretValues = new Map();

    const { unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { M: [['a', SECRET_MASK], ['b', SECRET_MASK]] },
      { M: [['a', 'live-0'], ['b', 'live-1']] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['M[0][1]', 'M[1][1]']);
    expect(secrets.size).toBe(0);
  });

  it('refuses the single-element scalar-mask array — the smallest zero-corroboration shape', () => {
    // `[SECRET_MASK]` against one live value LOOKS unambiguous, and is refused
    // deliberately: with zero corroborated leaves the only evidence that the
    // live list corresponds to this one at all is the length-1 match, which is
    // no evidence — the all-masked reading applied to its smallest shape. The
    // cost is a refusal (the safe residual), not a wrong write.
    const secrets: RecordedSecretValues = new Map();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { Args: [SECRET_MASK] },
      { Args: ['live-arg'] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Args[0]']);
    expect((properties['Args'] as unknown[])[0]).toBe(SECRET_MASK);
    expect(secrets.size).toBe(0);
  });
});

describe('a non-plain object corroborates NOTHING (#2869 corroboration twin)', () => {
  it('refuses when a Date anchor differs, instead of letting a sibling leaf vouch alone', () => {
    // `Object.keys(new Date())` is `[]`, so without the prototype guard two
    // DIFFERING Dates counted as "no contradiction" and the `R` leaf alone
    // corroborated the pairing — copying the live value in over an element
    // whose Date anchor actually disagrees. A non-plain object on either side
    // is a contradiction (cannot certify), the same answer
    // `deepEqualJsonValue` gives it on the redaction side.
    const secrets: RecordedSecretValues = new Map();

    const { unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { I: [{ D: new Date('2020-01-01T00:00:00Z'), R: 'r', Pw: SECRET_MASK }] },
      { I: [{ D: new Date('2024-06-30T00:00:00Z'), R: 'r', Pw: 'live-pw' }] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['I[0].Pw']);
    expect(secrets.size).toBe(0);
  });

  it('refuses a Map anchor the same way — no own keys, so no evidence either', () => {
    const secrets: RecordedSecretValues = new Map();

    const { unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { I: [{ M: new Map([['a', 1]]), R: 'r', Pw: SECRET_MASK }] },
      { I: [{ M: new Map([['b', 2]]), R: 'r', Pw: 'live-pw' }] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['I[0].Pw']);
    expect(secrets.size).toBe(0);
  });

  it('refuses when only the LIVE side is non-plain — an empty plain object vs a Date', () => {
    // The one-sided shape the two cases above cannot reach: `send` holds `{}`
    // (0 own keys) where live holds a `Date` (also 0 own keys), so without the
    // live-side clause the key counts match, nothing contradicts, and the `R`
    // leaf corroborates ALONE — copying `live-pw` into the mask on the
    // strength of an anchor that proves nothing.
    const secrets: RecordedSecretValues = new Map();

    const { unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { I: [{ E: {}, R: 'r', Pw: SECRET_MASK }] },
      { I: [{ E: new Date('2024-06-30T00:00:00Z'), R: 'r', Pw: 'live-pw' }] },
      secrets
    );

    expect(unpreservablePaths).toEqual(['I[0].Pw']);
    expect(secrets.size).toBe(0);
  });
});

describe('the WRITE path returns a non-plain object BY IDENTITY (issue #2897, write half)', () => {
  // The corroboration guard above is the READ half of the #2869 class; this is
  // the WRITE half: both preserve walks rebuild every object node they descend
  // with `Object.entries`, and over a `Date` / `Uint8Array` that fabricates
  // `{}` (or a plain index map) into the bag `provider.update` ships — the
  // #1498 / #1501 corruption class. Reachable because `awsProperties` is
  // `readCurrentState`'s RAW SDK return (no JSON round-trip) and
  // `buildRevertNewProperties` copies its non-drifted subtrees into the send
  // bag — the same fact the redaction side's `ArrayBuffer.isView` arm already
  // concedes for `Uint8Array`.

  it('mask walk: a Date beside a mask survives BY IDENTITY instead of becoming {}', () => {
    const secrets: RecordedSecretValues = new Map();
    const stamp = new Date('2020-01-01T00:00:00Z');

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { LastModified: stamp, Value: SECRET_MASK },
      { LastModified: new Date('2024-06-30T00:00:00Z'), Value: LIVE },
      secrets
    );

    // Identity, not equality: the walk must not rebuild the leaf at all.
    expect(properties['LastModified']).toBe(stamp);
    expect(properties['Value']).toBe(LIVE);
    expect(unpreservablePaths).toEqual([]);
  });

  it('mask walk: a Uint8Array beside a mask survives BY IDENTITY instead of becoming an index map', () => {
    const secrets: RecordedSecretValues = new Map();
    const bytes = new Uint8Array([1, 2, 3]);

    const { properties } = preserveLiveValuesAtMaskedLeaves(
      { SecretBinary: bytes, Value: SECRET_MASK },
      { SecretBinary: bytes, Value: LIVE },
      secrets
    );

    expect(properties['SecretBinary']).toBe(bytes);
  });

  it('token walk: a Date beside a preserved token survives BY IDENTITY instead of becoming {}', () => {
    const stamp = new Date('2020-01-01T00:00:00Z');

    const out = preserveLiveValuesAtUnresolvedTokens(
      { LastModified: stamp, Url: TOK_A },
      { LastModified: new Date('2024-06-30T00:00:00Z'), Url: 'live-url' }
    );

    expect(out['LastModified']).toBe(stamp);
    expect(out['Url']).toBe('live-url');
  });

  it('untemplated merge: a non-plain AWS value is a shape mismatch — the baseline wins, not an index map', () => {
    // The THIRD `Object.entries` rebuild on the same write path, found in
    // round 6: `mergeUntemplatedValue` runs BEFORE both preserve walks (the
    // no-observed-baseline overlay), so their guards cannot see it, and a
    // `Uint8Array` reported by AWS at a drifted key key-merged into
    // `{0:…,1:…,…}` plus the baseline's keys — strictly worse than the
    // flag-off wholesale overlay. Non-plain on either side now takes the
    // mismatch arm: the baseline wins.
    const result = buildRevertNewProperties(
      [{ path: 'Cfg' }] as never,
      { Cfg: { X: 1 } },
      { Cfg: new Uint8Array([1, 2, 3]) },
      { preserveUntemplated: true }
    );

    expect(result['Cfg']).toEqual({ X: 1 });
    expect(Object.keys(result['Cfg'] as Record<string, unknown>)).toEqual(['X']);
  });

  it('mask walk: a mask NESTED inside a non-plain container is REFUSED, not silently shipped', () => {
    // The gate (`carriesSecretMask`, which descends ANY object) and the walk
    // (which stops at a non-plain one) must not disagree fail-OPEN: if the
    // walk returns such a container by identity while a mask sits inside it,
    // the literal `***` ships to AWS unreported. No shape reaches this today;
    // the branch enforces the refusal rather than asserting unreachability.
    const secrets: RecordedSecretValues = new Map();
    const weird = new (class {
      V = SECRET_MASK;
    })();

    const { properties, unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      { W: weird, Value: SECRET_MASK },
      { W: { V: 'live-w' }, Value: LIVE },
      secrets
    );

    expect(unpreservablePaths).toEqual(['W']);
    expect(properties['W']).toBe(weird);
  });

  it('token walk rebuild: an own __proto__ key stays an OWN key there too', () => {
    // The rule is asserted at THREE rebuild sites and was fenced at one; a
    // later refactor could revert the other two fully green. This pins the
    // token walk's site with the same producible input.
    const send = JSON.parse(
      '{"__proto__": {"polluted": 1}, "Url": "{{resolve:notaservice:/cdkd/r7/a}}"}'
    ) as Record<string, unknown>;

    const out = preserveLiveValuesAtUnresolvedTokens(send, { Url: 'live-url' });

    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    expect(out['Url']).toBe('live-url');
  });

  it('untemplated merge rebuild: an own __proto__ key stays an OWN key there too', () => {
    // ...and the third site, reached through `buildRevertNewProperties` with
    // `preserveUntemplated: true` — the same call shape `runRevert` makes for
    // a record with no observed baseline.
    const aws = {
      Cfg: JSON.parse('{"__proto__": {"polluted": 1}, "A": "aws"}') as Record<string, unknown>,
    };

    const result = buildRevertNewProperties([{ path: 'Cfg' }] as never, { Cfg: { A: 'base' } }, aws, {
      preserveUntemplated: true,
    });

    const cfg = result['Cfg'] as Record<string, unknown>;
    expect(Object.hasOwn(cfg, '__proto__')).toBe(true);
    expect((cfg as { polluted?: unknown }).polluted).toBeUndefined();
    expect(cfg['A']).toBe('base');
  });

  it('object rebuild: an own __proto__ key stays an OWN key and never becomes the prototype', () => {
    // `JSON.parse` on state.json yields `__proto__` as an ordinary OWN key,
    // and assigning it onto a `{}` literal SETS the prototype and drops the
    // key. The walks rebuild onto a null-prototype target instead.
    const secrets: RecordedSecretValues = new Map();
    const send = JSON.parse(
      '{"__proto__": {"polluted": 1}, "Value": "***"}'
    ) as Record<string, unknown>;

    const { properties } = preserveLiveValuesAtMaskedLeaves(
      send,
      { Value: LIVE },
      secrets
    );

    expect(Object.hasOwn(properties, '__proto__')).toBe(true);
    expect((properties as { polluted?: unknown }).polluted).toBeUndefined();
    expect(properties['Value']).toBe(LIVE);
  });
});

// ------------------------------------------------------------- #2893 --
//
// `preserveLiveValuesAtUnresolvedTokens` paired array elements POSITIONALLY,
// guarded only by a length test, so a readback AWS REORDERED copied element
// i's live value into element i's token position and `provider.update`
// shipped a value belonging to a DIFFERENT element. The descent now goes
// through `pairedLiveItems` — identity field first, else the array's own
// literal frame corroborated per leaf, with whole tokens (and masks, owned by
// the later mask pass) wildcarded. The refusal residual is KEEPING the token,
// this pass's documented safe residual — never the mask walk's
// drop-the-resource refusal.
describe('preserveLiveValuesAtUnresolvedTokens pairs arrays by identity/corroboration (#2893)', () => {
  it('S1: a KEYED list AWS reordered takes the CORRECT element live value, not index i', () => {
    // The defect shape. Old positional descent: live[0] is the REGION
    // element, so the DB token took 'us-east-1' — another element's value,
    // shipped to the live resource.
    const out = preserveLiveValuesAtUnresolvedTokens(
      {
        Env: [
          { Name: 'DB', Value: TOK_A },
          { Name: 'REGION', Value: 'us-east-1' },
        ],
      },
      {
        Env: [
          { Name: 'REGION', Value: 'us-east-1' },
          { Name: 'DB', Value: 'db-live-value' },
        ],
      }
    );

    const env = out['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe('db-live-value');
    expect(env[0]!['Value']).not.toBe('us-east-1');
    expect(env[1]!['Value']).toBe('us-east-1');
  });

  it('S2: a KEYED list AWS ADDED an element to still pairs — no length gate on the identity arm', () => {
    // Old behaviour: length mismatch → no live items → token kept. Identity
    // needs no such partner count.
    const out = preserveLiveValuesAtUnresolvedTokens(
      { Env: [{ Name: 'DB', Value: TOK_A }] },
      {
        Env: [
          { Name: 'EXTRA', Value: 'added-by-aws' },
          { Name: 'DB', Value: 'db-live-value' },
        ],
      }
    );

    expect((out['Env'] as Array<Record<string, unknown>>)[0]!['Value']).toBe('db-live-value');
  });

  it('S3: a keyed element whose identity AWS NORMALISED gets no live value — the token is KEPT', () => {
    const out = preserveLiveValuesAtUnresolvedTokens(
      { Env: [{ Name: 'DB', Value: TOK_A }, { Name: 'REGION', Value: 'us-east-1' }] },
      { Env: [{ Name: 'db', Value: 'db-live-value' }, { Name: 'REGION', Value: 'us-east-1' }] }
    );

    // `Name` no longer keys BOTH sides uniquely-and-equally ('DB' matches no
    // live identity), so that element keeps its token — the documented safe
    // residual, instead of a positional guess.
    expect((out['Env'] as Array<Record<string, unknown>>)[0]!['Value']).toBe(TOK_A);
  });

  it('S4: an identity field that is ITSELF a token pairs nothing and keeps the token', () => {
    const out = preserveLiveValuesAtUnresolvedTokens(
      { Env: [{ Name: TOK_A, Value: TOK_B }, { Name: 'REGION', Value: 'us-east-1' }] },
      { Env: [{ Name: 'resolved-name', Value: 'v' }, { Name: 'REGION', Value: 'us-east-1' }] }
    );

    const env = out['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Name']).toBe(TOK_A);
    expect(env[0]!['Value']).toBe(TOK_B);
  });

  it('S5: an UNKEYED array whose literal frame corroborates the order still preserves', () => {
    // The legitimate preservation this function exists for must survive the
    // tightening: same order, every non-token leaf equal, one token slot.
    const out = preserveLiveValuesAtUnresolvedTokens(
      { Args: ['--pw', TOK_A] },
      { Args: ['--pw', 'live-secret-arg'] }
    );

    expect((out['Args'] as unknown[])[1]).toBe('live-secret-arg');
  });

  it('S6: an UNKEYED array AWS reordered contradicts the frame — the token is KEPT', () => {
    // Old behaviour copied live[0] ('--verbose') INTO the token position.
    const out = preserveLiveValuesAtUnresolvedTokens(
      { Args: [TOK_A, '--verbose'] },
      { Args: ['--verbose', 'resolved-elsewhere'] }
    );

    expect((out['Args'] as unknown[])[0]).toBe(TOK_A);
    expect((out['Args'] as unknown[])[0]).not.toBe('--verbose');
    expect((out['Args'] as unknown[])[1]).toBe('--verbose');
  });

  it('S7: TWO token-carrying elements in an unkeyed array refuse — both tokens kept', () => {
    // Two wildcard slots leave the surviving frame unable to say which goes
    // where, exactly the mask walk's one-slot bound.
    const out = preserveLiveValuesAtUnresolvedTokens(
      {
        I: [
          { U: TOK_A, A: 'x' },
          { U: TOK_B, A: 'y' },
        ],
      },
      {
        I: [
          { U: 'live-x', A: 'x' },
          { U: 'live-y', A: 'y' },
        ],
      }
    );

    const items = out['I'] as Array<Record<string, unknown>>;
    expect(items[0]!['U']).toBe(TOK_A);
    expect(items[1]!['U']).toBe(TOK_B);
  });

  it('S8: an ALL-TOKEN unkeyed array has zero corroborated leaves — the token is KEPT', () => {
    // Old behaviour: `[TOK_A]` against one live value copied it in on the
    // strength of a length-1 match, which is no evidence.
    const out = preserveLiveValuesAtUnresolvedTokens(
      { Args: [TOK_A] },
      { Args: ['live-value'] }
    );

    expect((out['Args'] as unknown[])[0]).toBe(TOK_A);
  });

  it('S9: an unkeyed LENGTH mismatch keeps the token, as before', () => {
    const out = preserveLiveValuesAtUnresolvedTokens(
      { Args: ['--pw', TOK_A] },
      { Args: ['--pw', 'live-secret-arg', '--verbose'] }
    );

    expect((out['Args'] as unknown[])[1]).toBe(TOK_A);
  });

  it('S10: a token NESTED in a keyed element is preserved from the PAIRED element under reorder', () => {
    const out = preserveLiveValuesAtUnresolvedTokens(
      {
        Defs: [
          { Name: 'app', Cfg: { Url: TOK_A } },
          { Name: 'sidecar', Cfg: { Url: 'https://fixed' } },
        ],
      },
      {
        Defs: [
          { Name: 'sidecar', Cfg: { Url: 'https://fixed' } },
          { Name: 'app', Cfg: { Url: 'https://live-app' } },
        ],
      }
    );

    const defs = out['Defs'] as Array<Record<string, unknown>>;
    expect((defs[0]!['Cfg'] as Record<string, unknown>)['Url']).toBe('https://live-app');
    expect((defs[1]!['Cfg'] as Record<string, unknown>)['Url']).toBe('https://fixed');
  });

  it('S11: a sibling element carrying a MASK abstains in corroboration but counts as a slot', () => {
    // The mask is the LATER mask pass's business: it must neither contradict
    // (it never equals live) nor corroborate. With a mask element AND a token
    // element that is two wildcard slots, so the pairing refuses and the
    // token pass changes nothing — mask untouched, token kept.
    const out = preserveLiveValuesAtUnresolvedTokens(
      {
        I: [
          { A: 'x', V: SECRET_MASK },
          { A: 'y', V: TOK_A },
        ],
      },
      {
        I: [
          { A: 'x', V: 'live-0' },
          { A: 'y', V: 'live-1' },
        ],
      }
    );

    const items = out['I'] as Array<Record<string, unknown>>;
    expect(items[0]!['V']).toBe(SECRET_MASK);
    expect(items[1]!['V']).toBe(TOK_A);
  });

  it('S12: a NON-PLAIN member (Date) in an unkeyed frame is a contradiction — the token is KEPT', () => {
    const out = preserveLiveValuesAtUnresolvedTokens(
      { I: [{ T: new Date('2020-01-01T00:00:00Z'), U: TOK_A }] },
      { I: [{ T: new Date('2020-01-01T00:00:00Z'), U: 'live' }] }
    );

    expect((out['I'] as Array<Record<string, unknown>>)[0]!['U']).toBe(TOK_A);
  });

  it('S13: an identity value that is ITSELF a token never pairs, even against a literal echo of it', () => {
    // PR 2912 security review (N1): the identity arm used to rely on the
    // wildcard identity MISSING the live map, but the miss is not structural —
    // AWS can literally hold the token text as an element's Name (an echo of a
    // shipped literal). Pairing on it is a guess, so it is refused explicitly.
    const out = preserveLiveValuesAtUnresolvedTokens(
      { Env: [{ Name: TOK_A, Value: TOK_B }] },
      { Env: [{ Name: TOK_A, Value: 'live-v' }] }
    );

    const env = out['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Name']).toBe(TOK_A);
    expect(env[0]!['Value']).toBe(TOK_B);
  });
});

describe('pairedLiveItems refuses a WILDCARD identity value in the mask walk too (PR 2912 N1)', () => {
  it('a masked identity does not pair against a live element literally named ***', () => {
    // Producible: a pre-#2274 binary shipped the literal mask as a value, or
    // a user wrote `***` as a Name. Equality pairing on a mask is a guess —
    // the send-side mask stands for an UNKNOWN name — so the element takes
    // the no-live-value arm and the resource is refused, never donated
    // another element's (or a guessed element's) live leaves.
    const secrets: RecordedSecretValues = new Map();

    const { unpreservablePaths } = preserveLiveValuesAtMaskedLeaves(
      {
        Tags: [
          { Name: SECRET_MASK, Value: SECRET_MASK },
          { Name: 'b', Value: 'y' },
        ],
      },
      {
        Tags: [
          { Name: SECRET_MASK, Value: 'live-secret-n1' },
          { Name: 'b', Value: 'y' },
        ],
      },
      secrets
    );

    expect(unpreservablePaths).toEqual(['Tags[0].Name', 'Tags[0].Value']);
    // Nothing was moved for the guessed element, so nothing is registered.
    expect(secrets.size).toBe(0);
  });
});

// ------------------------------------------------------------- #2855 --
//
// A record refused an `observedProperties` baseline (#2842's throw arm) falls
// back to raw `properties` holding intrinsic OBJECTS (`{Fn::Join: ...}`) from
// `cdkd import`'s warn path. `resolveStateSecretExpressions` re-resolves only
// `{{resolve:...}}` STRINGS, so the object survives into the send bag, and no
// provider route fails loudly on it (measured — see the helper's doc). The
// scan names such leaves so `runRevert` can refuse the resource.
describe('collectUnresolvedIntrinsicObjectPaths (#2855)', () => {
  const KEYS = (...k: string[]): ReadonlySet<string> => new Set(k);

  it('H1: names a single-key Fn::* object at a drifted top-level key', () => {
    expect(
      collectUnresolvedIntrinsicObjectPaths(
        { Value: { 'Fn::Join': ['', ['a', 'b']] }, Name: '/p' },
        KEYS('Value', 'Name')
      )
    ).toEqual(['Value']);
  });

  it('H2: names a nested Ref with its dotted path', () => {
    expect(
      collectUnresolvedIntrinsicObjectPaths(
        { Cfg: { Inner: { Ref: 'SomeResource' } } },
        KEYS('Cfg')
      )
    ).toEqual(['Cfg.Inner']);
  });

  it('H3: names an intrinsic inside an ARRAY element', () => {
    expect(
      collectUnresolvedIntrinsicObjectPaths(
        { List: ['plain', { 'Fn::GetAtt': ['R', 'Arn'] }] },
        KEYS('List')
      )
    ).toEqual(['List[1]']);
  });

  it('H4: a MULTI-key object with an Fn::-looking key is NOT an intrinsic', () => {
    // A CloudFormation intrinsic is always single-key; a sibling key means a
    // real property literally named like one — the resolver's own rule.
    expect(
      collectUnresolvedIntrinsicObjectPaths(
        { Cfg: { 'Fn::Join': ['', []], Other: 1 } },
        KEYS('Cfg')
      )
    ).toEqual([]);
  });

  it('H5: a single-key object with an ORDINARY key is not flagged, and IS descended', () => {
    expect(
      collectUnresolvedIntrinsicObjectPaths(
        { Cfg: { Only: { 'Fn::Sub': 'x-${Y}' } } },
        KEYS('Cfg')
      )
    ).toEqual(['Cfg.Only']);
  });

  it('H6: a NON-drifted top-level key is out of scope — AWS-sourced echoes cannot refuse', () => {
    expect(
      collectUnresolvedIntrinsicObjectPaths(
        { Value: { 'Fn::Join': ['', []] }, Drifted: 'x' },
        KEYS('Drifted')
      )
    ).toEqual([]);
  });

  it('H7: a non-plain object (Date, Uint8Array) is neither flagged nor descended', () => {
    expect(
      collectUnresolvedIntrinsicObjectPaths(
        { When: new Date('2020-01-01T00:00:00Z'), Blob: new Uint8Array([1]) },
        KEYS('When', 'Blob')
      )
    ).toEqual([]);
  });

  it('H8: multiple finds come back sorted, one per whole flagged leaf', () => {
    expect(
      collectUnresolvedIntrinsicObjectPaths(
        {
          B: { Ref: 'X' },
          A: { Deep: { 'Fn::Sub': ['t', { V: { Ref: 'Y' } }] } },
        },
        KEYS('A', 'B')
      )
    ).toEqual(['A.Deep', 'B']);
  });
});
