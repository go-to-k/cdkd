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
import { secretSafeKeyDisplay } from '../../../src/deployment/outputs-export-alias.js';
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
    // The other half of the trade. Measured: `displaySafe` keeps `U+200E` /
    // `U+200F` (named residuals in display-safe.ts) while `stripControlChars`
    // removes them, and `stripControlChars` keeps `U+2028` / `U+2029` while
    // `displaySafe` replaces them. Neither is a superset, so this site
    // composes both — and this case is what stops a future edit from
    // collapsing it back to one.
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
  // ONE CASE PER DELETED CLASS, not one representative: these are different
  // branches of the regex, and a fence covering one is the spelling-mismatch
  // failure this session already paid for once. `U+2028` / `U+2029` are in the
  // table as the CONTROL: `displaySafe` REPLACES those with a space rather
  // than deleting them, so they cannot rejoin a split secret and must stay
  // `safe`.
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
    ['U+2028 (line separator, REPLACED not deleted)', '\u2028', 'safe'],
    ['U+2029 (para separator, REPLACED not deleted)', '\u2029', 'safe'],
  ])('a secret split by %s', (_name, splitChar, expectedKind) => {
    it(`is reported ${expectedKind} and never printed`, () => {
      const key = `alias-${SECRET.slice(0, 5)}${splitChar}${SECRET.slice(5)}-suffix`;
      const shown = secretSafeKeyDisplay(key, secrets());
      expect(shown.kind).toBe(expectedKind);
      // THE ASSERTION, and it is the same for both kinds: whatever this
      // returns, the plaintext is not in it.
      expect(JSON.stringify(shown)).not.toContain(SECRET);
    });
  });

  it('the raw-key check is kept as a FALLBACK, not replaced', () => {
    // THE ONLY SHAPE THAT REACHES THE RAW ARM, and the first cut of this test
    // reached it in neither of its two cases (issue #2667 review): a
    // contiguous secret fires the SANITISED arm too, so `masked` was the right
    // answer for the wrong reason, and a `U+2028` inside the secret made BOTH
    // arms miss, so `safe` passed on a needle that never matched anything.
    //
    // The raw arm fires only when the RECORDED PLAINTEXT itself carries a
    // stripped character: it then survives in the raw key and is destroyed in
    // the sanitised one. Measured — `shown-arm=false raw-arm=true`.
    const secretWithCtl = `secret-value\u0007with-ctl`;
    const secrets = new Map([[secretWithCtl, EXPR]]);
    const shown = secretSafeKeyDisplay(`alias-${secretWithCtl}-suffix`, secrets);
    // WITHHELD, not `masked`: masking runs over `shown`, which no longer
    // contains the secret, so it changes nothing and the omit-if-unchanged rule
    // fires. That is fail-closed and is the point — the fallback's job is to
    // stop this returning `safe`, not to produce a printable name.
    expect(shown).toEqual({ kind: 'withheld' });
    expect(JSON.stringify(shown)).not.toContain(secretWithCtl);
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
});
