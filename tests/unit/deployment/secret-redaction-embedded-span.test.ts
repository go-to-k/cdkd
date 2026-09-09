import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import {
  clearRecordedSecretExpressions,
  markSameGenerationBag,
  mergeResolvedPairs,
  recordResolvedPair,
  redactSecretsForState,
  SECRET_MASK,
  TEMPLATE_DERIVED_RULES,
  TEMPLATE_SOURCED_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/**
 * Issue #2485: a literal leaf that EMBEDS one `{{resolve:...}}` token beside a
 * whole-value sibling resolving to the SAME plaintext used to persist the
 * sibling's expression, because the value-keyed map keeps one expression per
 * plaintext and the embedded leaf was redacted by the value scan. It is now
 * positioned by the span its source states, gated on PASS-LOCAL evidence that
 * the source token resolved to the framed middle (`recordResolvedPair`).
 *
 * ONE resource on purpose: `perResourceSecrets` is keyed by logical id, so two
 * resources get two maps and would pass with or without the arm.
 */
// `secretsmanager` spellings on purpose: they are secret BY SPELLING for the
// whole-token arm of `redactByPath`, so the whole-value sibling is positioned
// by that arm and only the EMBEDDED leaf depends on the arm under test. (With a
// spelling the whole-token arm cannot vouch for, the sibling too would take
// the span arm through an empty frame, and "drop the arm" would red the wrong
// leaf.) Two spellings of one JSON key — plain and version-staged — resolve to
// one plaintext, which is the collision itself.
const NAME = '{{resolve:secretsmanager:prod/db:SecretString:pw}}';
const NAME_V1 = '{{resolve:secretsmanager:prod/db:SecretString:pw:AWSCURRENT}}';
const PW = 'cdkd-2485-shared-plaintext';
const PREFIX = 'postgres://app-svc:';
const SUFFIX = '@db.internal:5432/app';
const EMBEDDED_SOURCE = `${PREFIX}${NAME}${SUFFIX}`;

function collapsedOnto(winner: string): RecordedSecretValues {
  // The map as the resolver leaves it after BOTH references resolved: one
  // entry, keyed by the shared plaintext, holding whichever recorded LAST.
  return new Map([[PW, winner]]);
}

describe('a literal leaf embedding one token is positioned by its own span (issue #2485)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  for (const [label, winner] of [
    ['the versioned sibling won the map slot', NAME_V1],
    ['the embedded token itself won the map slot', NAME],
  ] as const) {
    it(`persists each leaf's OWN expression when ${label}`, () => {
      const secrets = collapsedOnto(winner);
      recordResolvedPair(secrets, NAME, PW);
      recordResolvedPair(secrets, NAME_V1, PW);
      const source = { Whole: NAME_V1, Dsn: EMBEDDED_SOURCE };
      const bag = { Whole: PW, Dsn: `${PREFIX}${PW}${SUFFIX}` };

      const persisted = redactSecretsForState(bag, secrets, source);

      expect(persisted).toEqual({ Whole: NAME_V1, Dsn: EMBEDDED_SOURCE });
    });
  }

  for (const [label, rules] of [
    ['the template-DERIVED rules (the deploy persist walk)', TEMPLATE_DERIVED_RULES],
    ['the template-SOURCED rules (a scrub / observed walk)', TEMPLATE_SOURCED_RULES],
  ] as const) {
    it(`leaves an embedded 1-3 character secret to the value scan on a bag NOBODY marked, under ${label}`, () => {
      // The scan's substring arm ignores needles shorter than four characters,
      // and below that floor a rewrite would be a NEW claim on a bag this pass
      // did not necessarily produce (a previous generation's record, an old
      // readback, a scrub walk), so without the engine's same-generation mark
      // the arm keeps the scan's floor (issue #2516). The plaintext stays —
      // pinned as equality with the scan's own answer, so "fell through" is
      // what is asserted rather than "did something else". The rules
      // constant is NOT what decides: neither one claims the bag's generation.
      const secrets: RecordedSecretValues = new Map([['ab', NAME_V1]]);
      recordResolvedPair(secrets, NAME, 'ab');
      recordResolvedPair(secrets, NAME_V1, 'ab');
      const leaf = `${PREFIX}ab${SUFFIX}`;

      const persisted = redactSecretsForState(
        { Dsn: leaf },
        secrets,
        { Dsn: EMBEDDED_SOURCE },
        rules
      );

      expect(persisted).toEqual({ Dsn: redactSecretsForState(leaf, secrets) });
      expect(persisted).toEqual({ Dsn: leaf });
    });
  }

  describe('writes an embedded 1-3 character secret as its token on a bag the engine marked same-generation (issue #2516)', () => {
    // The mark is the second half of the evidence: the pair says THIS pass
    // resolved the token to the middle, the mark says THIS pass produced the
    // bag. Below the scan's needle floor the scan makes no claim, so only the
    // two together license `prefix + token + suffix`.
    for (const middle of ['a', 'ab', 'abc'] as const) {
      it(`for a ${middle.length}-character middle, alone`, () => {
        const secrets: RecordedSecretValues = new Map([[middle, NAME]]);
        recordResolvedPair(secrets, NAME, middle);
        const leaf = `${PREFIX}${middle}${SUFFIX}`;
        const bag = markSameGenerationBag({ Dsn: leaf });

        // Premise: the scan itself leaves the leaf alone below its floor.
        expect(redactSecretsForState(leaf, secrets)).toBe(leaf);
        expect(redactSecretsForState(bag, secrets, { Dsn: EMBEDDED_SOURCE })).toEqual({
          Dsn: EMBEDDED_SOURCE,
        });
      });

      for (const [label, winner] of [
        ['the versioned sibling won the map slot', NAME_V1],
        ['the embedded token itself won the map slot', NAME],
      ] as const) {
        it(`for a ${middle.length}-character middle beside a whole-value sibling sharing the plaintext, when ${label}`, () => {
          // The sibling decides only which expression survives the value-keyed
          // map; the embedded leaf is written from its OWN token, never the
          // survivor — a mutant writing `prefix + survivor + suffix` fails the
          // first order.
          const secrets: RecordedSecretValues = new Map([[middle, winner]]);
          recordResolvedPair(secrets, NAME, middle);
          recordResolvedPair(secrets, NAME_V1, middle);
          const source = { Whole: NAME_V1, Dsn: EMBEDDED_SOURCE };
          const bag = markSameGenerationBag({ Whole: middle, Dsn: `${PREFIX}${middle}${SUFFIX}` });

          expect(redactSecretsForState(bag, secrets, source)).toEqual({
            Whole: NAME_V1,
            Dsn: EMBEDDED_SOURCE,
          });
        });
      }
    }

    it('is read for the object handed in and threaded down the walk — a sub-bag walked on its own is not marked', () => {
      const secrets: RecordedSecretValues = new Map([['ab', NAME]]);
      recordResolvedPair(secrets, NAME, 'ab');
      const leaf = `${PREFIX}ab${SUFFIX}`;
      const bag = markSameGenerationBag({ Env: { Vars: { Dsn: leaf } } });
      const source = { Env: { Vars: { Dsn: EMBEDDED_SOURCE } } };

      // Threaded: the leaf three levels down takes the arm.
      expect(redactSecretsForState(bag, secrets, source)).toEqual({
        Env: { Vars: { Dsn: EMBEDDED_SOURCE } },
      });
      // Not inherited: the same object's sub-bag, walked as the top level, is
      // a different object and keeps the scan's answer.
      expect(redactSecretsForState(bag.Env, secrets, source.Env)).toEqual({
        Vars: { Dsn: leaf },
      });
    });

    it('is threaded through BOTH array descents — keyed by an identity field, and positional', () => {
      // The object walk is one of four recursion sites in `redactByPath`; the
      // two array arms are the others a resource bag reaches (ECS
      // `Environment[]` keyed by `Name`, a plain string list positionally).
      const secrets: RecordedSecretValues = new Map([['ab', NAME]]);
      recordResolvedPair(secrets, NAME, 'ab');
      const leaf = `${PREFIX}ab${SUFFIX}`;
      const keyed = markSameGenerationBag({ Env: [{ Name: 'DSN', Value: leaf }] });
      const positional = markSameGenerationBag({ List: [leaf] });

      expect(
        redactSecretsForState(keyed, secrets, { Env: [{ Name: 'DSN', Value: EMBEDDED_SOURCE }] })
      ).toEqual({ Env: [{ Name: 'DSN', Value: EMBEDDED_SOURCE }] });
      expect(redactSecretsForState(positional, secrets, { List: [EMBEDDED_SOURCE] })).toEqual({
        List: [EMBEDDED_SOURCE],
      });
      // ...and the keyed arm's UNPAIRED-element positional fallback: the bag
      // element's identity is not in the source, the lengths agree and every
      // pairing sits at its own index, so it takes `source[i]` — through the
      // same threaded flag.
      const fallback = markSameGenerationBag({
        Env: [
          { Name: 'HOST', Value: 'db.internal' },
          { Name: 'RENAMED', Value: leaf },
        ],
      });
      expect(
        redactSecretsForState(fallback, secrets, {
          Env: [
            { Name: 'HOST', Value: 'db.internal' },
            { Name: 'DSN', Value: EMBEDDED_SOURCE },
          ],
        })
      ).toEqual({
        Env: [
          { Name: 'HOST', Value: 'db.internal' },
          { Name: 'RENAMED', Value: EMBEDDED_SOURCE },
        ],
      });
    });

    it('does NOT survive a copy of the bag — the mark is on the object, not on its contents', () => {
      const secrets: RecordedSecretValues = new Map([['ab', NAME]]);
      recordResolvedPair(secrets, NAME, 'ab');
      const leaf = `${PREFIX}ab${SUFFIX}`;
      const bag = markSameGenerationBag({ Dsn: leaf });
      const copy = { ...bag };

      expect(redactSecretsForState(copy, secrets, { Dsn: EMBEDDED_SOURCE })).toEqual({ Dsn: leaf });
      // ...and a copy of the MAP still refuses too: the pair is per map
      // instance, the mark per bag object, and both are needed.
      expect(redactSecretsForState(bag, new Map(secrets), { Dsn: EMBEDDED_SOURCE })).toEqual({
        Dsn: leaf,
      });
    });

    it('still needs the pair: a marked bag whose source token this pass did not resolve keeps the scan\'s answer', () => {
      // A mark alone says the bag is this pass's; it says nothing about what
      // the token resolved to. Without a pair the middle is unverified.
      const secrets: RecordedSecretValues = new Map([['ab', NAME_V1]]);
      recordResolvedPair(secrets, NAME_V1, 'ab');
      const leaf = `${PREFIX}ab${SUFFIX}`;
      const bag = markSameGenerationBag({ Dsn: leaf });

      expect(redactSecretsForState(bag, secrets, { Dsn: EMBEDDED_SOURCE })).toEqual({ Dsn: leaf });
    });

    for (const [label, first, second] of [
      ['the matching value was recorded FIRST', 'ab', 'xy'],
      ['the matching value was recorded LAST', 'xy', 'ab'],
    ] as const) {
      it(`for an expression this pass saw resolve to TWO values, even on a marked bag (${label})`, () => {
        // Both orders, as for the unmarked twin: with the matching value LAST a
        // last-write-wins mutant of the conflict recording would still vouch
        // for the middle, and only this order catches it.
        const secrets: RecordedSecretValues = new Map([['ab', NAME]]);
        recordResolvedPair(secrets, NAME, first);
        recordResolvedPair(secrets, NAME, second);
        const leaf = `${PREFIX}ab${SUFFIX}`;
        const bag = markSameGenerationBag({ Dsn: leaf });

        expect(redactSecretsForState(bag, secrets, { Dsn: EMBEDDED_SOURCE })).toEqual({
          Dsn: leaf,
        });
      });
    }

    it('for an EMPTY middle on a marked bag — the frame refusal is load-bearing here', () => {
      // With the scan-equivalence bound relaxed for a marked bag, `scanned
      // === bag` holds for `prefix + suffix`. The evidence is hand-built in
      // BOTH halves — a pair saying the token resolved to '' AND a map entry
      // for '' (the resolver seam produces neither; without the entry the `<`
      // mutant of the frame refusal, which runs FIRST, is still caught by the
      // `survivor` guard downstream, so the frame refusal would be unpinned).
      // Under that evidence `singleSpanFrame`'s `<=` is what keeps an empty
      // middle from being written as the token; the `<` mutant admits it.
      const secrets = collapsedOnto(NAME_V1);
      secrets.set('', NAME);
      recordResolvedPair(secrets, NAME, '');
      const leaf = `${PREFIX}${SUFFIX}`;
      const bag = markSameGenerationBag({ Dsn: leaf });

      expect(redactSecretsForState(bag, secrets, { Dsn: EMBEDDED_SOURCE })).toEqual({ Dsn: leaf });
    });

    describe('keeps refusing the three interference cases with the mark present', () => {
      // Each makes the scan rewrite SOMETHING, so `scanned === bag` is false
      // and the relaxed arm does not fire; the answer is the scan's, as it is
      // on an unmarked bag. A mutant testing the middle's LENGTH instead of
      // the scan's silence fails all three.
      function marked(leaf: string) {
        return markSameGenerationBag({ Dsn: leaf });
      }

      it('a WHOLE leaf that is itself another recorded plaintext', () => {
        const secrets: RecordedSecretValues = new Map([['ab', NAME]]);
        recordResolvedPair(secrets, NAME, 'ab');
        const leaf = `${PREFIX}ab${SUFFIX}`;
        const OTHER = '{{resolve:secretsmanager:whole/leaf:SecretString:dsn}}';
        secrets.set(leaf, OTHER);
        recordResolvedPair(secrets, OTHER, leaf);

        const persisted = redactSecretsForState(marked(leaf), secrets, { Dsn: EMBEDDED_SOURCE });

        expect(persisted).toEqual({ Dsn: redactSecretsForState(leaf, secrets) });
        expect(persisted).toEqual({ Dsn: OTHER });
      });

      it('a literal frame that ITSELF equals a recorded plaintext', () => {
        const secrets: RecordedSecretValues = new Map([['ab', NAME]]);
        recordResolvedPair(secrets, NAME, 'ab');
        const OTHER = '{{resolve:secretsmanager:frame/leaf:SecretString:host}}';
        secrets.set(SUFFIX, OTHER);
        recordResolvedPair(secrets, OTHER, SUFFIX);
        const leaf = `${PREFIX}ab${SUFFIX}`;

        const persisted = redactSecretsForState(marked(leaf), secrets, { Dsn: EMBEDDED_SOURCE });

        expect(persisted).toEqual({ Dsn: redactSecretsForState(leaf, secrets) });
        expect(persisted).toEqual({ Dsn: `${PREFIX}ab${OTHER}` });
      });

      it('a needle that starts in the prefix and overlaps the middle', () => {
        const secrets: RecordedSecretValues = new Map([['ab', NAME]]);
        recordResolvedPair(secrets, NAME, 'ab');
        const overlapping = 'app-svc:a';
        const OTHER = '{{resolve:secretsmanager:overlap/leaf:SecretString:v}}';
        secrets.set(overlapping, OTHER);
        recordResolvedPair(secrets, OTHER, overlapping);
        const leaf = `${PREFIX}ab${SUFFIX}`;

        const persisted = redactSecretsForState(marked(leaf), secrets, { Dsn: EMBEDDED_SOURCE });

        expect(persisted).toEqual({ Dsn: redactSecretsForState(leaf, secrets) });
        expect(persisted).toEqual({ Dsn: `postgres://${OTHER}b${SUFFIX}` });
      });
    });
  });

  it('carries the evidence into the outputs bag through mergeResolvedPairs, and nowhere else', () => {
    // The deploy engine accumulates each output pass's map into `outputSecrets`
    // entry by entry; the entries alone would keep the collapse for a literal
    // Output embedding a reference.
    const passMap = collapsedOnto(NAME_V1);
    recordResolvedPair(passMap, NAME, PW);
    recordResolvedPair(passMap, NAME_V1, PW);
    const outputsBag: RecordedSecretValues = new Map();
    for (const [value, expr] of passMap) outputsBag.set(value, expr);
    const leaf = `${PREFIX}${PW}${SUFFIX}`;

    // Entries alone: the sibling's expression (the pre-#2485 answer).
    expect(redactSecretsForState({ Dsn: leaf }, outputsBag, { Dsn: EMBEDDED_SOURCE })).toEqual({
      Dsn: `${PREFIX}${NAME_V1}${SUFFIX}`,
    });
    mergeResolvedPairs(passMap, outputsBag);
    expect(redactSecretsForState({ Dsn: leaf }, outputsBag, { Dsn: EMBEDDED_SOURCE })).toEqual({
      Dsn: EMBEDDED_SOURCE,
    });
    // A conflict on either side stays a conflict after the merge: a
    // disagreeing string from the other map...
    const other = collapsedOnto(NAME_V1);
    recordResolvedPair(other, NAME, 'a-different-region-value');
    mergeResolvedPairs(other, outputsBag);
    expect(redactSecretsForState({ Dsn: leaf }, outputsBag, { Dsn: EMBEDDED_SOURCE })).toEqual({
      Dsn: `${PREFIX}${NAME_V1}${SUFFIX}`,
    });
    // ...and a conflict ALREADY marked in the source map, merged into a map
    // that was still vouching.
    const vouching = collapsedOnto(NAME_V1);
    recordResolvedPair(vouching, NAME, PW);
    expect(redactSecretsForState({ Dsn: leaf }, vouching, { Dsn: EMBEDDED_SOURCE })).toEqual({
      Dsn: EMBEDDED_SOURCE,
    });
    const conflicted = collapsedOnto(NAME_V1);
    recordResolvedPair(conflicted, NAME, PW);
    recordResolvedPair(conflicted, NAME, 'a-different-region-value');
    mergeResolvedPairs(conflicted, vouching);
    expect(redactSecretsForState({ Dsn: leaf }, vouching, { Dsn: EMBEDDED_SOURCE })).toEqual({
      Dsn: `${PREFIX}${NAME_V1}${SUFFIX}`,
    });
  });

  it('writes the source token over a previous-generation middle that EQUALS this pass\'s plaintext — the class of answer the value scan already gave', () => {
    // A scrub walking an old record against today's template: the old leaf
    // framed the same plaintext today's token resolves to. The value scan
    // rewrote that plaintext onto one of THIS pass's expressions regardless of
    // generation (the map holds no other), so the arm changes the choice
    // within that class, not the class — the source's own token instead of
    // the survivor. The generation hazard proper (an already-persisted
    // expression as the middle) is the token refusal, pinned below.
    const secrets = collapsedOnto(NAME_V1);
    recordResolvedPair(secrets, NAME, PW);
    recordResolvedPair(secrets, NAME_V1, PW);
    const leaf = `${PREFIX}${PW}${SUFFIX}`;

    expect(redactSecretsForState(leaf, secrets)).toBe(`${PREFIX}${NAME_V1}${SUFFIX}`);
    expect(redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE })).toEqual({
      Dsn: EMBEDDED_SOURCE,
    });
  });

  describe('keeps the pre-#2485 fall-through', () => {
    // Every negative arm asserts EQUALITY with the value scan's own answer for
    // the leaf, so "fell through" is pinned rather than "did something else".
    function fallThrough(leaf: string, secrets: RecordedSecretValues): string {
      return redactSecretsForState(leaf, secrets);
    }

    it('for a source with TWO spans (which span produced which value is ambiguous)', () => {
      const secrets = collapsedOnto(NAME_V1);
      recordResolvedPair(secrets, NAME, PW);
      recordResolvedPair(secrets, NAME_V1, PW);
      const source = `${PREFIX}${NAME}:${NAME_V1}${SUFFIX}`;
      const leaf = `${PREFIX}${PW}:${PW}${SUFFIX}`;

      expect(redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: source })).toEqual({
        Dsn: fallThrough(leaf, secrets),
      });
      expect(fallThrough(leaf, secrets)).toBe(`${PREFIX}${NAME_V1}:${NAME_V1}${SUFFIX}`);
    });

    it('for a frame mismatch (the bag does not have the source shape)', () => {
      const secrets = collapsedOnto(NAME_V1);
      recordResolvedPair(secrets, NAME, PW);
      const leaf = `mysql://app-svc:${PW}${SUFFIX}`;

      expect(redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE })).toEqual({
        Dsn: fallThrough(leaf, secrets),
      });
      expect(fallThrough(leaf, secrets)).toBe(`mysql://app-svc:${NAME_V1}${SUFFIX}`);
    });

    it('for a cross-generation bag whose framed middle no pass-local entry vouches for', () => {
      // An earlier generation's plaintext, framed exactly like today's
      // template: writing today's token over it would record an expression
      // that was never deployed at that position.
      const secrets = collapsedOnto(NAME_V1);
      recordResolvedPair(secrets, NAME, PW);
      const leaf = `${PREFIX}an-earlier-generations-value${SUFFIX}`;

      const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE });

      expect(persisted).toEqual({ Dsn: fallThrough(leaf, secrets) });
      expect(persisted).toEqual({ Dsn: leaf });
    });

    it('for a previous-generation middle that EQUALS a sibling secret while the source token resolved to another value', () => {
      const secrets: RecordedSecretValues = new Map([['old-shared-pw', NAME_V1]]);
      recordResolvedPair(secrets, NAME_V1, 'old-shared-pw');
      recordResolvedPair(secrets, NAME, 'new-value-for-the-source');
      const leaf = `${PREFIX}old-shared-pw${SUFFIX}`;

      const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE });

      // Not the source token: the evidence says it resolved to something else.
      // The scan writes the map's survivor for the old plaintext, as before.
      expect(persisted).toEqual({ Dsn: fallThrough(leaf, secrets) });
      expect(persisted).toEqual({ Dsn: `${PREFIX}${NAME_V1}${SUFFIX}` });
    });

    it('for a middle that is a mask-only NoEcho value (never recorded as a resolved pair)', () => {
      // The mask-only channel writes `value -> SECRET_MASK` straight into the
      // map; it never passes through the resolver's pair-recording seam, so
      // there is no evidence for the source token to match.
      const secrets: RecordedSecretValues = new Map([['noecho-handler-output', SECRET_MASK]]);
      const leaf = `${PREFIX}noecho-handler-output${SUFFIX}`;

      const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE });

      // A mask-only entry is a LOG needle, not a persist needle: the scan
      // leaves the leaf as it was, and so does this arm.
      expect(persisted).toEqual({ Dsn: fallThrough(leaf, secrets) });
      expect(persisted).toEqual({ Dsn: leaf });
    });

    it('for a WHOLE leaf that is itself another recorded plaintext (the scan\'s whole-value precedence)', () => {
      const secrets = collapsedOnto(NAME_V1);
      recordResolvedPair(secrets, NAME, PW);
      const leaf = `${PREFIX}${PW}${SUFFIX}`;
      const OTHER = '{{resolve:secretsmanager:whole/leaf:SecretString:dsn}}';
      secrets.set(leaf, OTHER);
      recordResolvedPair(secrets, OTHER, leaf);

      const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE });

      expect(persisted).toEqual({ Dsn: fallThrough(leaf, secrets) });
      expect(persisted).toEqual({ Dsn: OTHER });
    });

    it('for a literal frame that ITSELF equals a recorded plaintext (the scan rewrites the frame)', () => {
      // The frame is copied from the source, never scanned — so a leaf whose
      // frame the scan would rewrite must not take this arm, or the arm would
      // hand back LESS redaction than the scan.
      const secrets = collapsedOnto(NAME_V1);
      recordResolvedPair(secrets, NAME, PW);
      const OTHER = '{{resolve:secretsmanager:frame/leaf:SecretString:host}}';
      secrets.set(SUFFIX, OTHER);
      recordResolvedPair(secrets, OTHER, SUFFIX);
      const leaf = `${PREFIX}${PW}${SUFFIX}`;

      const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE });

      expect(persisted).toEqual({ Dsn: fallThrough(leaf, secrets) });
      // The scan rewrote the frame (and the middle onto the survivor).
      expect(persisted).toEqual({ Dsn: `${PREFIX}${NAME_V1}${OTHER}` });
    });

    it('for a needle that starts in the prefix and overlaps the middle (the scan\'s leftmost precedence)', () => {
      const secrets = collapsedOnto(NAME_V1);
      recordResolvedPair(secrets, NAME, PW);
      // `app-svc:` + the first half of PW, recorded as another secret.
      const overlapping = `app-svc:${PW.slice(0, 8)}`;
      const OTHER = '{{resolve:secretsmanager:overlap/leaf:SecretString:v}}';
      secrets.set(overlapping, OTHER);
      recordResolvedPair(secrets, OTHER, overlapping);
      const leaf = `${PREFIX}${PW}${SUFFIX}`;

      const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE });

      expect(persisted).toEqual({ Dsn: fallThrough(leaf, secrets) });
      // Leftmost wins in the scan: the overlapping needle consumed the start
      // of the middle, and the remainder is no longer a needle.
      expect(persisted).toEqual({ Dsn: `postgres://${OTHER}${PW.slice(8)}${SUFFIX}` });
    });

    it('for a middle that is itself a complete token (an already-redacted record)', () => {
      // A SHAPE pin: an already-persisted record framing the token, with real
      // evidence for the token. The refusal itself lives in the shared
      // `singleSpanFrame` and is fenced against a mutant by
      // `secret-redaction-derived-needles.test.ts` ("ITSELF a complete
      // token"); here the leaf simply must come back untouched.
      const secrets = collapsedOnto(NAME_V1);
      recordResolvedPair(secrets, NAME, PW);
      const leaf = `${PREFIX}${NAME}${SUFFIX}`;

      const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE });

      expect(persisted).toEqual({ Dsn: fallThrough(leaf, secrets) });
      expect(persisted).toEqual({ Dsn: leaf });
    });

    for (const [label, first, second] of [
      ['the matching value was recorded FIRST', PW, 'another-region-value'],
      ['the matching value was recorded LAST', 'another-region-value', PW],
    ] as const) {
      it(`for an expression this pass saw resolve to TWO values (${label})`, () => {
        // Both orders: a conflict is a conflict whichever value arrived last —
        // neither first-write-wins nor last-write-wins may stand in for it.
        const secrets = collapsedOnto(NAME_V1);
        recordResolvedPair(secrets, NAME, first);
        recordResolvedPair(secrets, NAME, second);
        const leaf = `${PREFIX}${PW}${SUFFIX}`;

        const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE });

        expect(persisted).toEqual({ Dsn: fallThrough(leaf, secrets) });
        expect(persisted).toEqual({ Dsn: `${PREFIX}${NAME_V1}${SUFFIX}` });
      });
    }

    it('for an EMPTY middle, even with hand-recorded evidence that the token resolved to nothing', () => {
      // The resolver seam never records an empty resolution (`resolved` is
      // tested truthily), so under the real producer this is unreachable. On
      // an UNMARKED bag the frame refusal (`<=`) is not even load-bearing —
      // an empty middle has no map entry, so `survivor` refuses it too, and
      // the `<` mutant is equivalent. This case exists so the invariant (an
      // empty middle is never positioned) has a pin of its own; its MARKED
      // twin above (issue #2516) is where the frame refusal became the only
      // thing standing.
      const secrets = collapsedOnto(NAME_V1);
      recordResolvedPair(secrets, NAME, '');
      const leaf = `${PREFIX}${SUFFIX}`;

      const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: EMBEDDED_SOURCE });

      expect(persisted).toEqual({ Dsn: redactSecretsForState(leaf, secrets) });
      expect(persisted).toEqual({ Dsn: leaf });
    });

    it('for a COPY of the map, which is not the pass that resolved anything', () => {
      const secrets = collapsedOnto(NAME_V1);
      recordResolvedPair(secrets, NAME, PW);
      const copy = new Map(secrets);
      const leaf = `${PREFIX}${PW}${SUFFIX}`;

      expect(redactSecretsForState({ Dsn: leaf }, copy, { Dsn: EMBEDDED_SOURCE })).toEqual({
        Dsn: fallThrough(leaf, copy),
      });
      expect(fallThrough(leaf, copy)).toBe(`${PREFIX}${NAME_V1}${SUFFIX}`);
    });
  });
});
