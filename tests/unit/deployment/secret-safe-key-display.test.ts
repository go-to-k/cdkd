/**
 * `secretSafeKeyDisplay` — how a state-bag KEY may be printed once it has been
 * tested for secret content (issue
 * [#2667](https://github.com/go-to-k/cdkd/issues/2667) review).
 *
 * An export name is a key of `state.outputs` AND of the exports index, and a
 * key holding secret plaintext is the residue `cdkd scrub` reports and cannot
 * rewrite (issue #1919). The exports-index repair names entries in `info` /
 * `warn` lines and in its failure message, and `--dry-run --fail` prints them
 * on every run of the documented CI gate — into CI logs. `displaySafe` /
 * `stripControlChars` sanitise for a TERMINAL and mask nothing, so a name has
 * to come through here instead.
 *
 * The THIRD arm is the one a caller must not fold into the first: masking can
 * leave the text unchanged, and printing it then publishes the secret under a
 * label asserting it was masked — the invariant
 * `secretBearingExportNameWarning` states absolutely. No command-level case
 * reaches that arm, which is why it is exercised directly here.
 */

import { describe, it, expect } from 'vite-plus/test';
import {
  exportNameSecretExposure,
  secretBearing,
  secretBearingExportNameWarning,
  secretSafeKeyDisplay,
  WITHHELD_NAME_DISPLAY,
  displayTextOrWithheld,
  type SecretSafeKeyDisplay,
} from '../../../src/deployment/outputs-export-alias.js';
import { SECRET_MASK, type RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

const SECRET = 'super-secret-plaintext-value';
const EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';

function secrets(...pairs: Array<[string, string]>): RecordedSecretValues {
  return new Map(pairs.length > 0 ? pairs : [[SECRET, EXPR]]);
}

describe('secretSafeKeyDisplay', () => {
  it('SAFE: a key carrying no recorded secret is returned control-stripped', () => {
    expect(secretSafeKeyDisplay('MyStack:DbEndpoint', secrets())).toEqual({
      kind: 'safe',
      text: 'MyStack:DbEndpoint',
    });
  });

  it('SAFE: strips control bytes, which a template-controlled name can carry', () => {
    // An `Fn::Sub` export name is a RESOLVED, template-controlled value, so it
    // can carry ANSI / control bytes into a terminal.
    const shown = secretSafeKeyDisplay('alias\u001b[31m-red', secrets());
    expect(shown.kind).toBe('safe');
    expect(shown.kind === 'safe' && shown.text).not.toContain('\u001b');
  });

  it('SAFE: strips U+2028 / U+2029, which stripControlChars does NOT (issue #2667 review)', () => {
    // The regression the masking change nearly shipped. `stripControlChars`'s
    // class omits both; `displaySafe` strips them precisely because this text
    // is PERSISTED and re-rendered by JSON and web log viewers that treat both
    // as line terminators — the CI-log surface the masking exists to protect,
    // where an `Fn::Sub`-built export name carrying one could forge a line.
    const shown = secretSafeKeyDisplay('alias\u2028injected', secrets());
    expect(shown.kind).toBe('safe');
    expect(shown.kind === 'safe' && shown.text).not.toContain('\u2028');
    expect(secretSafeKeyDisplay('alias\u2029injected', secrets())).not.toMatchObject({
      text: expect.stringContaining('\u2029'),
    });
  });

  it('MASKED: the masked arm strips them too, not just the safe arm', () => {
    // Both arms sanitise, and only the masked one runs the mask first, so it
    // is a separate path that could regress on its own.
    const shown = secretSafeKeyDisplay(`alias\u2028${SECRET}`, secrets());
    expect(shown.kind).toBe('masked');
    expect(shown.kind === 'masked' && shown.text).not.toContain('\u2028');
    expect(JSON.stringify(shown)).not.toContain(SECRET);
  });

  it('SAFE: strips the bidi MARKS too, which displaySafe alone does NOT', () => {
    // Kept from when this site COMPOSED the two sanitisers, and still the
    // right case: `displaySafe` keeps `U+200E` / `U+200F` (named residuals in
    // display-safe.ts) while `stripControlChars` keeps `U+2028` / `U+2029`, so
    // neither alone produces this result. The site no longer composes them --
    // it deletes one derived class (issue #2874) -- so what this pins now is
    // that the class still covers what BOTH used to, from the other side of
    // `secret-scan-class-superset.test.ts`'s code-point scan.
    const lrm = secretSafeKeyDisplay('alias\u200einjected', secrets());
    expect(lrm.kind).toBe('safe');
    expect(lrm.kind === 'safe' && lrm.text).toBe('aliasinjected');
    const rlm = secretSafeKeyDisplay('alias\u200finjected', secrets());
    expect(rlm.kind === 'safe' && rlm.text).toBe('aliasinjected');
  });

  it('SAFE: a key carrying BOTH classes at once loses both', () => {
    // The composition, not either half: one input that only passes when both
    // helpers ran.
    const shown = secretSafeKeyDisplay('a\u200eb\u2028c', secrets());
    expect(shown.kind).toBe('safe');
    const text = shown.kind === 'safe' ? shown.text : '';
    expect(text).not.toContain('\u200e');
    expect(text).not.toContain('\u2028');
  });

  it('MASKED: a key EMBEDDING a secret is masked, and the plaintext is gone', () => {
    const shown = secretSafeKeyDisplay(`alias-${SECRET}-suffix`, secrets());
    expect(shown.kind).toBe('masked');
    expect(shown.kind === 'masked' && shown.text).toBe(`alias-${SECRET_MASK}-suffix`);
    expect(JSON.stringify(shown)).not.toContain(SECRET);
  });

  it('MASKED: a key that IS the secret, whole', () => {
    const shown = secretSafeKeyDisplay(SECRET, secrets());
    expect(shown.kind).toBe('masked');
    expect(JSON.stringify(shown)).not.toContain(SECRET);
  });

  it('MASKED: a sub-floor secret still matches as the WHOLE key', () => {
    // `stateKeySecretExposure` bounds containment at `MIN_SECRET_NEEDLE`, so a
    // 3-character secret is matched only when it IS the whole key. Pinned
    // because that bound is what keeps the CI gate from flagging every key.
    const shown = secretSafeKeyDisplay('abc', secrets(['abc', EXPR]));
    expect(shown.kind).toBe('masked');
  });

  it('SAFE: a sub-floor secret EMBEDDED in a longer key is not matched', () => {
    // The other direction of the same bound — an over-eager scan here fails
    // the `--dry-run --fail` gate repo-wide, the availability failure the
    // export-name check was redesigned to avoid.
    expect(secretSafeKeyDisplay('abc-endpoint', secrets(['abc', EXPR])).kind).toBe('safe');
  });

  // SANITISATION CAN CREATE A SECRET THE RAW KEY DOES NOT CONTAIN.
  //
  // `stripControlChars` DELETES, so a plaintext split by any character in its
  // class is absent from the raw key and contiguous in the sanitised one. A
  // verdict taken from the raw key therefore returned `safe` while the text
  // that got PRINTED held the plaintext — into `logger.info` / `warn` and the
  // failure message, i.e. the `--dry-run --fail` CI-log surface this whole
  // change exists to protect (issue #2667 review; introduced by the
  // composition, not present before it).
  //
  // ONE CASE PER CLASS, not one representative: these are different branches
  // of the regex, and a fence covering one is the spelling-mismatch failure
  // this session already paid for once.
  //
  // `U+2028` / `U+2029` MOVED from `safe` to `masked` under issue #2874, and
  // the move is the fix rather than a loosened expectation — do not restore
  // them as "the control". They were `safe` because `displaySafe` REPLACES
  // them with a space, so the secret was not contiguous in the printed text —
  // but the text still read `super-secr et-plaintext-value`, one character
  // short of the plaintext, which `not.toContain(SECRET)` structurally cannot
  // see. Canonicalising DELETES them, so the secret is now both detected and
  // maskable.
  //
  // The last four rows were in NEITHER sanitiser's class before #2874 and
  // verdicted `safe` while printing plaintext that is VISUALLY contiguous —
  // a zero-width character discloses a secret to anyone reading the log, with
  // no paste involved.
  //
  // THE NEGATIVE CONTROLS ARE ELSEWHERE: the `SAFE:` cases above -- a key
  // carrying these characters and NO recorded secret -- are this table's
  // floor, and they red under a change that withholds everything.
  //
  // An earlier revision of this comment said the table itself would pass such
  // a change. That was WRONG and review measured it: every row pins the
  // literal string `'masked'`, not merely "not safe", so forcing `withheld`
  // reds all sixteen. The claim is corrected rather than deleted because the
  // floor cases are still the reason this table may pin one verdict per row.
  describe.each([
    ['U+0007 (C0 control)', '\u0007', 'masked'],
    ['U+001f (C0 upper bound)', '\u001f', 'masked'],
    ['U+007f (DEL)', '\u007f', 'masked'],
    ['U+0085 (C1)', '\u0085', 'masked'],
    ['U+200e (bidi mark LRM)', '\u200e', 'masked'],
    ['U+200f (bidi mark RLM)', '\u200f', 'masked'],
    ['U+202a (bidi embedding)', '\u202a', 'masked'],
    ['U+202e (bidi override)', '\u202e', 'masked'],
    ['U+2066 (bidi isolate)', '\u2066', 'masked'],
    ['U+2069 (isolate terminator)', '\u2069', 'masked'],
    ['U+2028 (line separator)', '\u2028', 'masked'],
    ['U+2029 (para separator)', '\u2029', 'masked'],
    ['U+200b (ZWSP, in NEITHER sanitiser class)', '\u200b', 'masked'],
    ['U+200d (ZWJ, in NEITHER sanitiser class)', '\u200d', 'masked'],
    ['U+feff (BOM, in NEITHER sanitiser class)', '\ufeff', 'masked'],
    ['U+061c (ALM, in NEITHER sanitiser class)', '\u061c', 'masked'],
  ])('a secret split by %s', (_name, splitChar, expectedKind) => {
    it(`is reported ${expectedKind} and never printed`, () => {
      const key = `alias-${SECRET.slice(0, 5)}${splitChar}${SECRET.slice(5)}-suffix`;
      const shown = secretSafeKeyDisplay(key, secrets());
      expect(shown.kind).toBe(expectedKind);
      // THE EXACT TEXT, not `not.toContain(SECRET)`. A mask that emitted the
      // needle minus its last character would satisfy a containment assertion
      // while returning `super-secret-plaintext-valu` contiguous under a
      // `masked` label -- the plaintext-minus-one-character class this whole
      // fence exists for, reproduced inside it (measured, issue #2874
      // review). Pinning the whole string is the only form that cannot.
      expect(shown).toEqual({ kind: 'masked', text: `alias-${SECRET_MASK}-suffix` });
    });
  });

  it('SAFE: a key carrying the WIDENED class but no secret is printed, not withheld', () => {
    // THE FLOOR for the table above (issue #2874). Widening the canonical
    // class buys nothing if it also withholds ordinary names: these four
    // characters were added to catch a secret split by one, so a key holding
    // them and no recorded secret must still come back `safe` — and with the
    // characters gone from the text, since that text reaches a CI log.
    for (const invisible of ['\u200b', '\u200c', '\u200d', '\ufeff', '\u061c']) {
      const shown = secretSafeKeyDisplay(`alias${invisible}injected`, secrets());
      expect(shown.kind).toBe('safe');
      expect(shown.kind === 'safe' && shown.text).toBe('aliasinjected');
    }
  });

  it('a secret split by a character in NEITHER sanitiser class is masked, not merely stripped', () => {
    // The measured shape behind the widening: before #2874 this verdicted
    // `safe` and returned the plaintext with one zero-width character in it —
    // which a reader sees as the secret, and which `not.toContain(SECRET)`
    // does catch only because the character is still present. Assert the
    // VISIBLE reading, not the byte string.
    const key = `alias-${SECRET.slice(0, 5)}\u200b${SECRET.slice(5)}-suffix`;
    const shown = secretSafeKeyDisplay(key, secrets());
    expect(shown.kind).toBe('masked');
    const text = shown.kind === 'masked' ? shown.text : '';
    // eslint-disable-next-line no-misleading-character-class
    expect(text.replace(/[\u061c\u200b-\u200f\ufeff]/g, '')).not.toContain(SECRET);
  });

  it('WITHHELD: the same secret twice, one occurrence split, is never partly printed', () => {
    // The counterexample that killed the first design (issue #2874). Masking
    // is a substring replacement, so a name holding the secret contiguously
    // AND split used to mask the first occurrence and print the second minus
    // one character, under a label asserting it had been masked. In canonical
    // space both occurrences are the same string, so both are masked.
    const key = `a-${SECRET}-b-${SECRET.slice(0, 10)}\u2028${SECRET.slice(10)}-c`;
    const shown = secretSafeKeyDisplay(key, secrets());
    expect(shown.kind).toBe('masked');
    const text = shown.kind === 'masked' ? shown.text : '';
    expect(text).not.toContain(SECRET);
    // The specific leak that was measured: the plaintext with one character
    // replaced by a space. Pinned literally, because the generic assertion
    // above is exactly the one that could not see it.
    expect(text).not.toContain('super-secr et');
    expect(text).toBe(`a-${SECRET_MASK}-b-${SECRET_MASK}-c`);
  });

  it('a sub-floor secret the CALLER knows was substituted is still masked', () => {
    // `secretsPresentIn` bounds an embedded match at four characters, while
    // `maskEveryOccurrence` is deliberately threshold-free. So a caller
    // holding an AUTHORITATIVE exposure — the deploy engine, which knows what
    // resolution put into a name — passes it as force-mask needles, or this
    // function's containment recompute would silently UN-mask what the
    // shipped code masks today (issue #2874).
    const sub = new Map([['abc', EXPR]]);
    const shown = secretSafeKeyDisplay('x-abc-y', new Map(), sub);
    expect(shown.kind).toBe('masked');
    expect(shown.kind === 'masked' && shown.text).toBe(`x-${SECRET_MASK}-y`);
    // The control: with no force-mask set, the same sub-floor value is NOT
    // found — the documented availability bound, unchanged.
    expect(secretSafeKeyDisplay('x-abc-y', sub).kind).toBe('safe');
  });

  it('a RECORDED PLAINTEXT that itself carries a stripped character is masked, not withheld', () => {
    // THE SHAPE THAT USED TO NEED A RAW-KEY FALLBACK ARM, and the reason
    // issue #2874 could DELETE that arm rather than add a third one beside it.
    //
    // Before: the verdict came from the raw key OR the sanitised one while the
    // mask ran over the sanitised one. This secret survives in the raw key and
    // is destroyed in the sanitised one, so the raw arm was the only thing
    // stopping a `safe` verdict -- and masking then changed nothing, so the
    // answer was `withheld`: fail-closed, but the operator got no name at all.
    //
    // Now the NEEDLES are canonicalised too, so the secret and the key are
    // reduced to the same space and the value is both found AND maskable. The
    // fallback arm has no remaining shape to serve, which is why deleting it
    // is not a loosening.
    const secretWithCtl = 'secret-value\u0007with-ctl';
    const secrets = new Map([[secretWithCtl, EXPR]]);
    const shown = secretSafeKeyDisplay(`alias-${secretWithCtl}-suffix`, secrets);
    expect(shown).toEqual({ kind: 'masked', text: `alias-${SECRET_MASK}-suffix` });
    expect(JSON.stringify(shown)).not.toContain(secretWithCtl);
    // ...nor the CANONICAL form of it. The assertion above pins the byte
    // string, which the stripped character makes a weaker test than it looks:
    // it would pass over text holding the secret with that character gone.
    expect(JSON.stringify(shown)).not.toContain('secret-valuewith-ctl');
  });

  it('a needle whose canonical form is EMPTY matches nothing', () => {
    // Canonicalisation can turn a non-empty recorded value into `\'\'`, and an
    // empty needle is a substring of every string -- so it would withhold
    // every key in the state. The resolver never records an empty secret, so
    // nothing upstream guards this; the drop happens here (issue #2874).
    const allInvisible = '\u200b\u200e\u202e';
    const shown = secretSafeKeyDisplay('OrdinaryKey', new Map([[allInvisible, EXPR]]));
    expect(shown).toEqual({ kind: 'safe', text: 'OrdinaryKey' });
  });

  it('a contiguous secret fires the SANITISED arm, not the fallback', () => {
    // The control for the case above: pinned separately so a future edit
    // cannot make the fallback test pass through this path instead.
    const secrets = new Map([[SECRET, EXPR]]);
    const shown = secretSafeKeyDisplay(`alias-${SECRET}-suffix`, secrets);
    expect(shown.kind).toBe('masked');
    expect(JSON.stringify(shown)).not.toContain(SECRET);
  });

  it('WITHHELD: a secret whose masking leaves the text unchanged yields no text', () => {
    // The degenerate case the third arm exists for: the recorded plaintext IS
    // the mask, so masking is a no-op and the "masked" label would be a lie.
    // The result carries NO text at all, so a caller cannot print it by
    // reaching for a field.
    const shown = secretSafeKeyDisplay(SECRET_MASK, secrets([SECRET_MASK, EXPR]));
    expect(shown).toEqual({ kind: 'withheld' });
    expect(Object.hasOwn(shown, 'text')).toBe(false);
  });

  it('longest-first, so a secret containing another is masked whole', () => {
    const outer = 'abcdef-secret';
    const inner = 'abcdef';
    const shown = secretSafeKeyDisplay(outer, secrets([inner, EXPR], [outer, EXPR]));
    expect(shown.kind).toBe('masked');
    // Not `***-secret`: the longer needle wins, so no fragment survives.
    expect(shown.kind === 'masked' && shown.text).toBe(SECRET_MASK);
  });

  it('the fail-closed re-test fires ON ITS OWN, with the omit-if-unchanged rule removed', () => {
    // Review measured BOTH late arms deletable with the suite green, because
    // the only input reaching them satisfied either one. This case reaches the
    // POST-MASK re-test alone: masking DOES change the text (so the
    // omit-if-unchanged rule does not fire), and the result still exposes a
    // second recorded secret that the masking itself created.
    const corpus = new Map([
      ['secret', EXPR],
      [`1${SECRET_MASK}b`, EXPR],
    ]);
    const shown = secretSafeKeyDisplay('a1secretb', corpus);
    expect(shown).toEqual({ kind: 'withheld' });
  });

  it('the omit-if-unchanged rule fires ON ITS OWN, with nothing left to re-detect', () => {
    // The other arm alone: the recorded plaintext IS the mask, so masking is a
    // no-op and the `masked` label would be a lie, while the post-mask re-test
    // has nothing to add.
    const shown = secretSafeKeyDisplay(SECRET_MASK, secrets([SECRET_MASK, EXPR]));
    expect(shown).toEqual({ kind: 'withheld' });
  });

  it('a force-mask needle ABSENT from the text leaves the name SAFE, not withheld', () => {
    // THE DEFAULT DEPLOY PATH (issue #2874 review). The output key beside a
    // secret-bearing export name is handed the export name's authoritative
    // exposure as force-mask needles; those are not in the key, so masking
    // changes nothing. Collapsing that into `withheld` took away the one
    // identifier telling an operator which output to fix, and printed a
    // placeholder asserting the key "contains a secret" -- false.
    const shown = secretSafeKeyDisplay('ApiEndpointOutput', new Map(), secrets());
    expect(shown).toEqual({ kind: 'safe', text: 'ApiEndpointOutput' });
  });

  it('an EMPTY canonical needle reaching the FORCE-MASK path cannot shred the name', () => {
    // The containment path rejects an empty needle through MIN_SECRET_NEEDLE,
    // so a test driving it there passes with the guard removed. Only the
    // force-mask path can hand `maskEveryOccurrence` an empty needle, and
    // `''.split()` interleaves the mask between every character: measured
    // without the guard, `OrdinaryKey` came back as
    // `O***r***d***i***n***a***r***y***K***e***y`.
    const allInvisible = new Map([['\u200b\u200e\u202e', EXPR]]);
    const shown = secretSafeKeyDisplay('OrdinaryKey', new Map(), allInvisible);
    expect(shown).toEqual({ kind: 'safe', text: 'OrdinaryKey' });
  });

  it('a needle whose EDGE whitespace is part of the secret still matches mid-key', () => {
    // The needle is stripped of invisibles but NOT trimmed. Trimming it made a
    // recorded `"ab  "` stop matching inside `x-ab  -y` -- the secret's own
    // trailing spaces sit in the MIDDLE of the key, where nothing trims them
    // (measured, issue #2874 review).
    const shown = secretSafeKeyDisplay('x-ab  -y', new Map([['ab  ', EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: `x-${SECRET_MASK}-y` });
  });

  it('a needle canonicalised BELOW the floor keeps its embedded-match arm', () => {
    // The floor is keyed to the RECORDED length, not the canonical one. A
    // five-character secret carrying two invisibles canonicalises to three and
    // would drop out of containment if the floor were applied afterwards --
    // measured returning `safe` with `x-abc-y` printed, which is the secret in
    // the form a human reads.
    const secret = 'a\u200eb\u200ec';
    const shown = secretSafeKeyDisplay(`x-${secret}-y`, new Map([[secret, EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: `x-${SECRET_MASK}-y` });
  });

  it('secretBearing answers for BOTH non-safe kinds, not just masked', () => {
    // It guards `cdkd scrub`'s `--dry-run --fail` accounting. Narrowed to
    // `=== 'masked'` the suite stayed green while a WITHHELD key -- the most
    // dangerous kind -- was skipped and the gate passed over it (measured).
    expect(secretBearing(secretSafeKeyDisplay(`alias-${SECRET}-suffix`, secrets()))).toBe(true);
    expect(secretBearing(secretSafeKeyDisplay(SECRET_MASK, secrets([SECRET_MASK, EXPR])))).toBe(
      true
    );
    expect(secretBearing(secretSafeKeyDisplay('OrdinaryKey', secrets()))).toBe(false);
  });

  it('displayTextOrWithheld renders the placeholder, and it is not name-shaped', () => {
    // The placeholder is a user-visible string in a security warning and
    // nothing rendered it. It must not read as an odd export name, so it is
    // pinned including its angle brackets.
    expect(displayTextOrWithheld({ kind: 'withheld' })).toBe(WITHHELD_NAME_DISPLAY);
    expect(WITHHELD_NAME_DISPLAY).toBe('<name withheld: contains a secret>');
    expect(displayTextOrWithheld({ kind: 'safe', text: 'Plain' })).toBe('Plain');
    expect(displayTextOrWithheld({ kind: 'masked', text: 'a-***-b' })).toBe('a-***-b');
  });

  it('a DEGENERATE needle cannot be smuggled past the floor by padding it', () => {
    // THE BOUND IS DEFEATABLE IF THE FLOOR IS KEYED TO THE RECORDED LENGTH
    // ALONE (issue #2874 round 2, found by two reviewers independently). A
    // recorded `a` plus three zero-width spaces is four characters, so it
    // clears MIN_SECRET_NEEDLE, while its canonical needle is the single
    // letter `a`. Measured under that form: `ApiGatewayEndpoint` came back
    // `masked` as `ApiG***tew***yEndpoint`, and the deploy REFUSED the export
    // alias of every output whose name contains an `a` -- the repo-wide
    // availability failure the floor exists to prevent.
    const padded = `a\u200b\u200b\u200b`;
    expect(padded.length).toBeGreaterThanOrEqual(4);
    expect(secretSafeKeyDisplay('ApiGatewayEndpoint', new Map([[padded, EXPR]]))).toEqual({
      kind: 'safe',
      text: 'ApiGatewayEndpoint',
    });
  });

  it('the RAW arm still fires for a needle canonicalisation shortens below the floor', () => {
    // The other side of the same boundary, and the reason the fix is two arms
    // rather than one moved floor. A recorded `a<LRM>b<LRM>c` is five
    // characters raw and three canonical: the canonical arm cannot match it,
    // and the raw arm must, or the key prints `x-abc-y` -- the secret in the
    // form a human reads (measured).
    const secret = 'a\u200eb\u200ec';
    const shown = secretSafeKeyDisplay(`x-${secret}-y`, new Map([[secret, EXPR]]));
    expect(shown.kind).not.toBe('safe');
    expect(JSON.stringify(shown)).not.toContain('abc');
  });

  it('an all-invisible needle never reaches the MASK, whatever its recorded length', () => {
    // THE LIVE EMPTY-NEEDLE GUARD IS IN `canonicalNeedles`, not in the
    // containment scan, and this test drives the FORCE-MASK path because that
    // is the only one that reaches `maskEveryOccurrence` with the needle set.
    // `''.split()` interleaves the mask between every character of the key.
    //
    // A previous version of this case asserted a mechanism that cannot occur
    // -- `haystack.includes('')` -- which is unreachable because the embedded
    // arm is bounded by `needle.length >= MIN_SECRET_NEEDLE`. That scan-side
    // guard was dead and is gone; do not restore it as "defence in depth".
    const allInvisible = '\u200b\u200c\u200d\ufeff';
    expect(allInvisible.length).toBeGreaterThanOrEqual(4);
    expect(secretSafeKeyDisplay('OrdinaryKey', new Map(), new Map([[allInvisible, EXPR]]))).toEqual(
      { kind: 'safe', text: 'OrdinaryKey' }
    );
    // ...and through the containment path too, which must also not mangle it.
    expect(secretSafeKeyDisplay('OrdinaryKey', new Map([[allInvisible, EXPR]]))).toEqual({
      kind: 'safe',
      text: 'OrdinaryKey',
    });
  });

  it('a SUB-FLOOR secret with edge whitespace, as the WHOLE key, is masked rather than withheld', () => {
    // This used to be the case that kept a raw whole-value arm alive: `'ab '`
    // trims the KEY to `'ab'`, so only `text === plaintext` matched, and the
    // mask -- run over the trimmed text -- then found nothing and WITHHELD the
    // name. The untrimmed haystack (issue #2890) matches it, and masking runs
    // over that same untrimmed string, so the name comes back masked.
    const secret = 'ab ';
    expect(secret.length).toBeLessThan(4);
    const shown = secretSafeKeyDisplay(secret, new Map([[secret, EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: SECRET_MASK });
  });

  it('the WHOLE-VALUE canonical arm fires on its own, for a sub-floor split secret', () => {
    // The partner of the case above, needing the CANONICAL comparison: the key
    // IS the secret with an invisible in it, so the raw forms differ while the
    // canonical ones are equal, and the needle is too short for either
    // embedded arm.
    const secret = 'ab';
    const shown = secretSafeKeyDisplay(`a\u200eb`, new Map([[secret, EXPR]]));
    expect(shown.kind).not.toBe('safe');
  });

  it('the FORCE-MASK needles are canonicalised, or a sub-floor one leaks', () => {
    // Measured GREEN under the mutation that seeds the mask from the RAW map
    // (issue #2874 round 2), and the mutant LEAKS: an authoritative sub-floor
    // needle carrying an invisible does not match the canonical text, masking
    // changes nothing, no containment exposure fired, and the corrected
    // unchanged-mask arm then answers `safe` -- printing the plaintext.
    const substituted = 'a\u200eb';
    const shown = secretSafeKeyDisplay('x-ab-y', new Map(), new Map([[substituted, EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: `x-${SECRET_MASK}-y` });
  });

  it('the verdict is taken from the RAW key, not from the sanitised text', () => {
    // `secretsPresentIn` is handed `key`, never `shown`. Handing it `shown`
    // measured GREEN, because both arms usually agree -- they part exactly
    // where the RAW arm is the only one that can fire, which is the case
    // above. Pinned separately so the two cannot be collapsed.
    const secret = 'q\u200ew\u200ee';
    const shown = secretSafeKeyDisplay(`k-${secret}-k`, new Map([[secret, EXPR]]));
    expect(shown.kind).not.toBe('safe');
  });

  it('a sub-floor needle the CALLER substituted is masked in the EXPORT NAME', () => {
    // The force-mask argument on the export name is threshold-free, because
    // resolution KNOWS it put the value there. Deleting the argument measured
    // GREEN across the suite while the message printed the plaintext -- and
    // this session has already deleted it once, on a finding that turned out
    // to be about a different line.
    const sub = new Map([['ab', EXPR]]);
    const message = secretBearingExportNameWarning('PlainOwner', 'x-ab-y', sub, sub);
    expect(message).toContain(`x-${SECRET_MASK}-y`);
    expect(message).not.toContain('x-ab-y');
  });

  it('...but a sub-floor needle does NOT shred the OUTPUT KEY', () => {
    // The other side of that asymmetry. Resolution knows nothing about the
    // output key, so a one-character substituted value masked threshold-free
    // rendered `ApiGatewayEndpoint` as `ApiG***tew***yEndpoint` (measured) --
    // destroying the identifier the operator has to edit. The residual is
    // deliberate: a genuinely sub-floor secret embedded in an output key is
    // not masked, the same tradeoff containment already makes.
    const sub = new Map([['a', EXPR]]);
    const message = secretBearingExportNameWarning('ApiGatewayEndpoint', 'x-a-y', sub, sub);
    expect(message).toContain('Output ApiGatewayEndpoint has an Export.Name');
  });

  it('a whole-key force-mask needle differing only by an invisible is still masked', () => {
    // The CANONICAL half of the output key's whole-value rule. With only the
    // raw comparison the filter implemented half the rule its comment names,
    // and a key differing from the needle by one invisible character printed
    // RAW (measured `Output ab has an Export.Name ...`).
    //
    // Unreachable through the deploy engine -- its corpus is a superset of
    // `exposure`, so containment catches this first -- and driven directly
    // here, because a branch added to make a comment true and reachable by
    // nothing is worse than the divergence it closed.
    const sub = new Map([['ab', EXPR]]);
    const message = secretBearingExportNameWarning('a\u200bb', 'x-ab-y', sub, new Map());
    expect(message).toContain(`Output ${SECRET_MASK} has an Export.Name`);
  });

  it('a WHOLE-KEY force-mask needle is still masked, at any length', () => {
    // The bound on the output key is whole-vs-embedded, not a flat floor: a
    // sub-floor value that IS the whole key is not a coincidence.
    const sub = new Map([['ab', EXPR]]);
    const message = secretBearingExportNameWarning('ab', 'x-ab-y', sub, sub);
    expect(message).toContain(`Output ${SECRET_MASK} has an Export.Name`);
  });

});

/**
 * A recorded secret whose own EDGE whitespace the display's trim removes
 * (issue [#2890](https://github.com/go-to-k/cdkd/issues/2890)).
 *
 * The scan reads TWO haystacks -- the stripped key untrimmed, and that string
 * trimmed, which is what gets printed -- and the mask runs over the untrimmed
 * one. Both halves are pinned separately below, because each half alone
 * leaves a leak: the verdict half without the mask half prints the secret
 * minus its edge space under a `masked` label, and the mask half is
 * unreachable without the verdict half.
 */
describe('secretSafeKeyDisplay: edge whitespace of a recorded secret (#2890)', () => {
  it('the measured case: a leading-space secret at the start of a key is masked', () => {
    // Before: `safe`, printing `abcd-x` -- the secret minus its leading space.
    // Neither arm matched: the canonical needle kept the space the trimmed
    // haystack had lost, and the ZWSP kept the raw plaintext out of the key.
    const shown = secretSafeKeyDisplay(' abcd-x', new Map([[' a\u200bbcd', EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: `${SECRET_MASK}-x` });
  });

  it('a trailing-space secret at the end of a key is masked too', () => {
    // `U+3000` is `\p{Zs}`, which the trim removes and the invisible class
    // keeps -- the only kind of edge the residual ever covered.
    const shown = secretSafeKeyDisplay('x-abcd\u3000', new Map([['ab\u200bcd\u3000', EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: `x-${SECRET_MASK}` });
  });

  it('a verdict the RAW arm reaches is now masked in place, not withheld', () => {
    // The raw arm already saw this one (no invisible in the secret), but the
    // mask ran over the TRIMMED text, where the needle's trailing space was
    // gone -- masking changed nothing, and the name was withheld.
    const shown = secretSafeKeyDisplay('x-abcd\u3000', new Map([['abcd\u3000', EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: `x-${SECRET_MASK}` });
  });

  it('MASK HALF: the same secret at the edge AND mid-key is masked at both', () => {
    // THE VERDICT/DISPLAY SPLIT a verdict-only fix would ship. The trimmed
    // text `abcd-x abcd` holds ` abcd` once, mid-key, so the verdict fired
    // even before #2890 -- and the mask, run over that trimmed text, masked
    // the mid-key copy and printed the edge copy minus its space, under a
    // `masked` label: `abcd-x***` (measured on `origin/main`). Masking the
    // UNTRIMMED string reaches both copies.
    const shown = secretSafeKeyDisplay(' abcd-x abcd', new Map([[' abcd', EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: `${SECRET_MASK}-x${SECRET_MASK}` });
  });

  it('the post-mask RE-TEST reads the masked UNTRIMMED string, not only the printed one', () => {
    // Masking can CREATE a recorded secret (the fail-closed case above), and
    // it can create one at the edge. Here masking `secret` turns the key into
    // ` ***b`, which is the second recorded secret; the printed text `***b`
    // is that secret minus its leading space. A re-test over the printed text
    // alone does not see it -- measured green-then-leaking under that
    // mutation -- so it must read the untrimmed string the mask produced.
    const corpus = new Map([
      ['secret', EXPR],
      [` ${SECRET_MASK}b`, EXPR],
    ]);
    expect(secretSafeKeyDisplay(' secretb', corpus)).toEqual({ kind: 'withheld' });
  });

  it('UNTRIMMED haystack, whole-value arm, on its own', () => {
    // A sub-floor needle, so no embedded arm applies; the raw forms differ by
    // the ZWSP; the trimmed key `ab` lacks the needle's space. Only
    // `untrimmed === needle` can match.
    const shown = secretSafeKeyDisplay(' a\u200bb', new Map([[' ab', EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: SECRET_MASK });
  });

  it('TRIMMED haystack, whole-value arm, on its own', () => {
    // The partner: a sub-floor needle WITHOUT edge whitespace, in a key that
    // has some. Only `trimmed === needle` matches, so dropping the trimmed
    // haystack in favour of the untrimmed one alone reds here.
    const shown = secretSafeKeyDisplay(' ab ', new Map([['ab', EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: SECRET_MASK });
  });

  it('a FORCE-MASK needle with edge whitespace is masked at the key edge', () => {
    // The caller KNOWS it substituted ` ab` here. The force-mask needles were
    // matched against the trimmed text, where ` ab` is absent, so the name
    // came back `safe` as `ab-x`.
    const shown = secretSafeKeyDisplay(' ab-x', new Map(), new Map([[' ab', EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: `${SECRET_MASK}-x` });
  });

  it('the OUTPUT KEY force-mask filter compares against the untrimmed key too', () => {
    // The sibling site: `secretBearingExportNameWarning` keeps a sub-floor
    // authoritative needle for the output key only when it IS the whole key,
    // and "whole" was compared against the trimmed key alone -- so a key
    // ` a<ZWSP>b` holding the substituted ` ab` printed as `Output ab`.
    const sub = new Map([[' ab', EXPR]]);
    const message = secretBearingExportNameWarning(' a\u200bb', 'x-ab-y', sub, new Map());
    expect(message).toContain(`Output ${SECRET_MASK} has an Export.Name`);
  });

  it('an ABSENT force-mask needle leaves a key with edge whitespace SAFE, not "masked"', () => {
    // The no-op test compares the mask's input with its output, and the input
    // is now the UNTRIMMED string. Comparing the output with the TRIMMED
    // `shown` instead reads every key with edge whitespace as "changed", and
    // labels an untouched name `masked` -- a message claiming a masking it did
    // not perform (review of #2890, measured as a surviving mutant).
    const shown = secretSafeKeyDisplay(' Key ', new Map(), new Map([['zzzz', EXPR]]));
    expect(shown).toEqual({ kind: 'safe', text: 'Key' });
  });

  it('the OUTPUT KEY filter still reads the TRIMMED key for a whole-value match', () => {
    // The partner of the case above: a sub-floor needle WITHOUT edge
    // whitespace, in an output key that has some. Only the trimmed key equals
    // it, so a filter reading the untrimmed key alone prints `Output ab`.
    const sub = new Map([['ab', EXPR]]);
    const message = secretBearingExportNameWarning(' ab ', 'x-ab-y', sub, new Map());
    expect(message).toContain(`Output ${SECRET_MASK} has an Export.Name`);
  });

  it('the deploy REFUSES an export name carrying such a secret', () => {
    // The verdict's other consumer. `undefined` here means the alias is
    // PUBLISHED as a state key and into the exports index, which `cdkd scrub`
    // then reports as a leak it cannot rewrite.
    const recorded = new Map([[' a\u200bbcd', EXPR]]);
    expect(exportNameSecretExposure(' abcd-x', new Map(), recorded)).toEqual(recorded);
  });

  it('a tab or newline edge was never in the residual: the class DELETES it', () => {
    // The control for the scope the issue stated. `\t` is `\p{Cc}`, deleted
    // from the needle and the key alike, so both sides agree without #2890.
    const shown = secretSafeKeyDisplay('\tabcd-x', new Map([['\tabcd', EXPR]]));
    expect(shown).toEqual({ kind: 'masked', text: `${SECRET_MASK}-x` });
  });

  // THE WALK. Hand-picked cases pin the shapes someone thought of; this one
  // pins the CLAIM, over an enumerated space of recorded secrets and keys:
  //
  // 1. OUTSIDE the intended class -- every pair where the needle has no edge
  //    whitespace, or does not occur in the untrimmed key at all -- the
  //    result is IDENTICAL to the pre-#2890 function, text included. That is
  //    "the printed text keeps its shape".
  // 2. INSIDE it, the verdict is never `safe` for a needle the rule covers.
  // 3. EVERYWHERE, a `masked` text is clean: putting back the whitespace the
  //    trim removed from THIS key does not reconstitute the needle, and the
  //    text fed back through `secretSafeKeyDisplay` is `safe`. (3) is the
  //    non-divergence claim itself -- the #2874 class is a printed string
  //    holding what the verdict said it had removed. The re-pad is the check
  //    that discriminates: a mask run over the trimmed text leaves the edge
  //    copy of ` abcd` in `-x abcd`-suffixed keys, and only re-padding sees
  //    it. The re-feed is the weaker half, kept as the plain statement of the
  //    claim; the production re-test already reads a superset of it.
  it('WALK: unchanged outside the edge-whitespace class, and never divergent inside it', () => {
    const INVISIBLES = /[\p{Cc}\p{Cf}\p{Me}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
    const strip = (s: string): string => s.replace(INVISIBLES, '');

    // A TRANSCRIPTION of `secretSafeKeyDisplay` before #2890 (no force-mask
    // set), kept as the reference for claim (1) only.
    const preFix = (key: string, corpus: RecordedSecretValues): SecretSafeKeyDisplay => {
      const present = (text: string): boolean => {
        const haystack = strip(text).trim();
        return [...corpus.keys()].some((p) => {
          const n = strip(p);
          return (
            haystack === n ||
            (n.length >= 4 && haystack.includes(n)) ||
            text === p ||
            (p.length >= 4 && text.includes(p))
          );
        });
      };
      const shown = strip(key).trim();
      if (!present(key)) return { kind: 'safe', text: shown };
      const needles = [...corpus.keys()].map(strip).filter((n) => n.length > 0);
      let masked = shown;
      for (const n of needles.sort((a, b) => b.length - a.length)) {
        masked = masked.split(n).join(SECRET_MASK);
      }
      if (masked === shown) return { kind: 'withheld' };
      if (present(masked)) return { kind: 'withheld' };
      return { kind: 'masked', text: masked };
    };

    const recordedSecrets = [
      ' abcd',
      'abcd ',
      ' abcd ',
      '\u3000abcd',
      'abcd\u00a0',
      ' a\u200bbcd',
      'abcd',
      'a\u200bbcd',
      'ab  cd',
      ' ab',
      'ab ',
      'ab',
    ];
    const splitOnce = (s: string): string => {
      const i = s.search(/\S/);
      return i < 0 ? s : `${s.slice(0, i + 1)}\u200b${s.slice(i + 1)}`;
    };
    let outside = 0;
    let inside = 0;
    let changed = 0;
    let maskedCount = 0;
    for (const secret of recordedSecrets) {
      const corpus = new Map([[secret, EXPR]]);
      const needle = strip(secret);
      const edge = needle !== needle.trim();
      for (const body of [secret, splitOnce(secret), secret.trim(), 'zzzz']) {
        for (const prefix of ['', ' ', 'x-', 'x ']) {
          // `-x${secret}` puts a SECOND copy mid-key, so a mask that reaches
          // only the trimmed text leaves the edge copy for claim (3) to see.
          for (const suffix of ['', ' ', '-y', ' y', `-x${secret}`]) {
            const key = `${prefix}${body}${suffix}`;
            const untrimmed = strip(key);
            const shown = secretSafeKeyDisplay(key, corpus);
            const label = JSON.stringify({ secret, key, shown });
            if (!edge || !untrimmed.includes(needle)) {
              outside++;
              expect(shown, label).toEqual(preFix(key, corpus));
            } else {
              inside++;
              const covered = needle.length >= 4 || untrimmed === needle;
              if (covered) expect(shown.kind, label).not.toBe('safe');
              if (JSON.stringify(shown) !== JSON.stringify(preFix(key, corpus))) changed++;
            }
            if (shown.kind === 'masked') {
              maskedCount++;
              // What the trim removed from THIS key -- not the needle's own
              // edge -- because a key that never held the edge copy (`abcd-x
              // abcd` against ` abcd`) prints `abcd` legitimately.
              const lead = /^\s*/.exec(untrimmed)?.[0] ?? '';
              const trail = /\s*$/.exec(untrimmed)?.[0] ?? '';
              expect(`${lead}${shown.text}${trail}`.includes(needle), label).toBe(false);
              expect(secretSafeKeyDisplay(shown.text, corpus).kind, label).toBe('safe');
            }
          }
        }
      }
    }
    // LITERAL floors, so a walk that silently stops generating one class
    // cannot pass on the other.
    expect(outside).toBe(532);
    expect(inside).toBe(428);
    expect(changed).toBe(187);
    expect(maskedCount).toBe(526);
  });
});
