/**
 * Issue [#4001](https://github.com/go-to-k/cdkd/issues/4001): a secret spelled
 * in COMPATIBILITY characters (full-width, mathematical alphanumeric,
 * superscript, ligature, circled, ideographic space...) is caught by the
 * detection space's compatibility-folded form, while the printed text keeps
 * the name's own characters.
 *
 * #2889 (`secret-detection-space-2889.test.ts`) handled an INSERTED mark; this
 * is a SUBSTITUTED character. The same constraint holds: the change must not
 * reintroduce #2874 (a verdict and a printed text in different spaces). So
 * besides the code-point scans this file walks an ENUMERATED input space
 * against a TRANSCRIPTION of the pre-#4001 containment test and asserts:
 *
 * 1. the new verdict is a SUPERSET of the old one;
 * 2. every name the new verdict adds involves a compatibility character, in
 *    the name or in the recorded secret (the class the change intends);
 * 3. whatever `secretSafeKeyDisplay` PRINTS is clean under BOTH verdicts.
 *
 * Cross-SCRIPT look-alikes (Cyrillic, Greek) and a recomposing Hangul edge are
 * the documented bounds, pinned below so a later widening is a decision
 * rather than a surprise.
 */

import { describe, it, expect } from 'vite-plus/test';
import {
  exportNameSecretExposure,
  exportAliasCollisionWarning,
  secretBearingExportNameWarning,
  secretSafeKeyDisplay,
  WITHHELD_NAME_DISPLAY,
} from '../../../src/deployment/outputs-export-alias.js';

const SECRET = 'super-secret-plaintext-value';
const EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';

const MN_G = /\p{Mn}/gu;
/** The printed-space class, copied from `outputs-export-alias.ts`. */
const PRINTED_CLASS = /[\p{Cc}\p{Cf}\p{Me}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
const PRINTED_ONE = /[\p{Cc}\p{Cf}\p{Me}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** The folding the shipped arm applies, restated for building inputs only. */
function fold(s: string): string {
  return s.normalize('NFKD').replace(MN_G, '').normalize('NFKC');
}

/** Full-width spelling of printable ASCII (U+FF01..U+FF5E). */
function fullWidth(s: string): string {
  return s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
}

/**
 * TRANSCRIPTION of `secretsPresentIn` as of `origin/main` before #4001 -- the
 * printed-space arms plus #2889's mark-stripped arm. Deliberately a copy, not
 * an import: the subject is the CHANGE, so the baseline must not move with it.
 */
function preChangeVerdict(text: string, secrets: ReadonlyMap<string, string>): Set<string> {
  const marked = (s: string): string => s.normalize('NFD').replace(MN_G, '').normalize('NFC');
  const untrimmed = text.replace(PRINTED_CLASS, '');
  const haystacks = [untrimmed.trim(), untrimmed];
  const wideUntrimmed = marked(untrimmed);
  const wides = [wideUntrimmed.trim(), wideUntrimmed, marked(untrimmed.trim())];
  const hits = new Set<string>();
  for (const plaintext of secrets.keys()) {
    const needle = plaintext.replace(PRINTED_CLASS, '');
    const canonicalHit = haystacks.some(
      (h) => h === needle || (needle.length >= 4 && h.includes(needle))
    );
    const wideNeedle = marked(needle);
    const wideHit = wides.some(
      (w) => w === wideNeedle || (wideNeedle.length >= 4 && w.includes(wideNeedle))
    );
    const rawHit = plaintext.length >= 4 && text.includes(plaintext);
    if (canonicalHit || wideHit || rawHit) hits.add(plaintext);
  }
  return hits;
}

/** The shipped verdict, read through the export-name entry point with no substitution map. */
function shippedVerdict(text: string, secrets: Map<string, string>): Set<string> {
  return new Set(exportNameSecretExposure(text, new Map(), secrets)?.keys() ?? []);
}

function refused(name: string, secrets: Map<string, string>): boolean {
  return exportNameSecretExposure(name, new Map(), secrets) !== undefined;
}

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Every code point whose compatibility decomposition differs from its
 * canonical one, outside the printed-space class (those are deleted from the
 * printed text already), surrogates skipped.
 */
function compatibilityCharacters(): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const s = String.fromCodePoint(cp);
    if (PRINTED_ONE.test(s)) continue;
    if (s.normalize('NFKD') !== s.normalize('NFD')) out.push(cp);
  }
  return out;
}

describe('secret detection space: compatibility folding (issue #4001)', () => {
  const compat = compatibilityCharacters();

  it('the issue reproduction: one letter swapped for its full-width form is detected and not printed', () => {
    const secrets = new Map([['hunter2secret', EXPR]]);
    const name = 'pre-hunter2s\uff45cret-post';
    expect(exportNameSecretExposure(name, new Map(), secrets)).toEqual(
      new Map([['hunter2secret', EXPR]])
    );
    expect(secretSafeKeyDisplay(name, secrets)).toEqual({ kind: 'withheld' });
  });

  it('EVERY compatibility character substituted into a secret is detected, both directions, never printed', () => {
    const missedName: string[] = [];
    const missedSecret: string[] = [];
    const printed: string[] = [];
    let probed = 0;
    for (const cp of compat) {
      const ch = String.fromCodePoint(cp);
      const folded = fold(ch);
      if (folded === '') continue;
      probed++;
      // The NAME carries the compatibility character, the SECRET its folding.
      const plainSecret = new Map([[`alpha${folded}omega`, EXPR]]);
      const name = `x-alpha${ch}omega-y`;
      if (!refused(name, plainSecret)) missedName.push(hex(cp));
      const shown = secretSafeKeyDisplay(name, plainSecret);
      if (shown.kind !== 'withheld') printed.push(hex(cp));
      // The SECRET carries it, the NAME spells the folding.
      const compatSecret = new Map([[`alpha${ch}omega`, EXPR]]);
      if (!refused(`x-alpha${folded}omega-y`, compatSecret)) missedSecret.push(hex(cp));
    }
    // ANTI-VACUITY FLOOR, not a derived total: 3847 compatibility characters
    // measured over the whole range on Node 24 (Unicode 17), 69 of which fold
    // to nothing but a mark and are skipped.
    expect(compat.length).toBeGreaterThanOrEqual(3500);
    expect(probed).toBeGreaterThanOrEqual(3400);
    expect(missedName).toEqual([]);
    expect(missedSecret).toEqual([]);
    expect(printed).toEqual([]);
  });

  it('no compatibility folding lands in the printed-space class', () => {
    // The folded form is not stripped of the printed class a second time, so
    // an invisible it produced would split a needle in folded space. Measured
    // empty; a Unicode revision that changes it reds here, not silently.
    const intoPrinted = compat.filter((cp) => PRINTED_ONE.test(fold(String.fromCodePoint(cp))));
    expect(intoPrinted.map(hex)).toEqual([]);
  });

  it('a name carrying compatibility characters and NO secret prints them unchanged', () => {
    // Detection only: the printed space keeps full-width letters, ligatures,
    // superscripts and half-width kana.
    const secrets = new Map([[SECRET, EXPR]]);
    const changed: string[] = [];
    for (const cp of compat) {
      const key = `export-na${String.fromCodePoint(cp)}me-x`;
      const shown = secretSafeKeyDisplay(key, secrets);
      if (shown.kind !== 'safe' || shown.text !== key) changed.push(hex(cp));
      if (refused(key, secrets)) changed.push(`refused ${hex(cp)}`);
    }
    expect(changed).toEqual([]);
  });

  it('real names in compatibility characters print unchanged beside a populated corpus', () => {
    const secrets = new Map([
      [SECRET, EXPR],
      ['prod2024', EXPR],
    ]);
    for (const name of [
      '\uff25\uff58\uff50\uff4f\uff52\uff54-\u540d\u524d', // full-width "Export" + kanji
      '\uff74\uff78\uff7d\uff8e\uff9f\uff70\uff84-name', // half-width katakana
      'Area-m\u00b2-Export', // superscript two
      'Caf\u00e9-\u2116-\u2460', // numero sign, circled one
      'pro\ufb01le-export', // fi ligature
    ]) {
      expect(secretSafeKeyDisplay(name, secrets)).toEqual({ kind: 'safe', text: name });
      expect(refused(name, secrets)).toBe(false);
    }
  });

  it('full-width, mathematical, superscript and ligature spellings of a secret are refused', () => {
    const secrets = new Map([['hunter2pass', EXPR]]);
    for (const name of [
      `x-${fullWidth('hunter2pass')}-y`,
      'x-\u{1d421}\u{1d42e}\u{1d427}\u{1d42d}\u{1d41e}\u{1d42b}2pass-y', // math bold
      'x-hunter\u00b2pass-y', // superscript two
      'x-hunter\u2082pass-y', // subscript two
      'x-hunter\u2461pass-y', // circled two
    ]) {
      expect(refused(name, secrets), name).toBe(true);
      expect(secretSafeKeyDisplay(name, secrets), name).toEqual({ kind: 'withheld' });
    }
    const lig = new Map([['office-token', EXPR]]);
    expect(refused('x-o\ufb03ce-token-y', lig)).toBe(true); // ffi ligature
  });

  it('full-width AND mark-split folds in one step', () => {
    // Needs NFKD with the marks stripped: a bare NFKC keeps the mark, and the
    // mark-stripped arm keeps the full-width letters.
    const secrets = new Map([['hunter2pass', EXPR]]);
    const name = `x-${fullWidth('hunter')}\u09bc${fullWidth('2pass')}-y`;
    expect(refused(name, secrets)).toBe(true);
    expect(secretSafeKeyDisplay(name, secrets)).toEqual({ kind: 'withheld' });
  });

  it('the stated COST: a compatibility spelling of a recorded secret is refused, as its plain spelling is', () => {
    // Pinned so the over-refusal is a recorded decision. Each name is refused
    // exactly when its folded spelling would be, so the plain spelling is
    // asserted alongside.
    const cases: Array<[string, string, string]> = [
      ['prod2024', `release-prod${fullWidth('2024')}`, 'release-prod2024'],
      ['file', 'pro\ufb01le-export', 'profile-export'],
      ['ea-m2', 'area-m\u00b2', 'area-m2'],
      ['1234', '\u2460\u2461\u2462\u2463-export', '1234-export'],
      ['ab c', 'ab\u3000c-export', 'ab c-export'],
    ];
    for (const [secret, compatName, plainName] of cases) {
      const secrets = new Map([[secret, EXPR]]);
      expect(refused(compatName, secrets), compatName).toBe(true);
      expect(refused(plainName, secrets), plainName).toBe(true);
    }
  });

  it('the floor holds in BOTH folded directions: expansion and surrogate pairs cannot pad a short secret', () => {
    // U+2177 SMALL ROMAN NUMERAL EIGHT folds to `viii`: one character recorded,
    // four folded. Bounding by the folded length alone refuses every name
    // containing `viii`.
    const eight = new Map([['\u2177', EXPR]]);
    expect(refused('export-viii-name', eight)).toBe(false);
    expect(refused('viii', eight)).toBe(true); // ...still refused WHOLE
    const tenth = new Map([['\u2152', EXPR]]); // folds to 1 U+2044 10
    expect(refused('x-1\u204410-y', tenth)).toBe(false);
    // Mathematical bold `ab` is four UTF-16 units that fold to two.
    const mathAb = new Map([['\u{1d41a}\u{1d41b}', EXPR]]);
    expect(refused('x-ab-y', mathAb)).toBe(false);
    expect(refused('ab', mathAb)).toBe(true);
    expect(secretSafeKeyDisplay('x-ab-y', mathAb)).toEqual({ kind: 'safe', text: 'x-ab-y' });
  });

  // Mirrors #2889's three haystacks, in folded space: each name is caught by
  // exactly ONE of them.
  it.each([
    // folded untrimmed, then trimmed: the mark and space go, `ab` remains.
    ['folded then trimmed', 'ab', `\u0301 ${fullWidth('ab')}`],
    // folded untrimmed: U+3000 folds to the secret's own leading space.
    ['folded untrimmed', ' ab', `\u3000${fullWidth('ab')}`],
    // printed-trimmed, then folded: the untrimmed fold has three spaces.
    ['trimmed then folded', ' ab', `  \u0301 ${fullWidth('ab')}`],
  ])('the %s haystack is load-bearing around a full-width secret', (_label, secret, name) => {
    const secrets = new Map([[secret, EXPR]]);
    expect(refused(name, secrets)).toBe(true);
    expect(secretSafeKeyDisplay(name, secrets).kind).toBe('withheld');
  });

  it('the mark-stripped arm is KEPT beside the folded one: folding is not closed under containment', () => {
    // U+314F (compatibility jamo A) folds to a conjoining jamo that recomposes
    // with the U+3131 before it into one syllable, so the folded needle is
    // absent from the folded name. Only the mark-stripped arm sees it.
    const secrets = new Map([['\u314fbcd', EXPR]]);
    const name = '\u3131\u314f\u0301bcd';
    expect(preChangeVerdict(name, secrets).size).toBe(1);
    expect(fold(name).includes(fold('\u314fbcd'))).toBe(false);
    expect(refused(name, secrets)).toBe(true);
  });

  it('the BOUND: cross-script look-alikes are not folded (TR39 was not adopted)', () => {
    const secrets = new Map([['password-value', EXPR]]);
    for (const name of [
      'x-p\u0430ssword-value', // Cyrillic a
      'x-passw\u03bfrd-value', // Greek omicron
      'x-pa\u0455\u0455word-value', // Cyrillic dze
    ]) {
      expect(refused(name, secrets), name).toBe(false);
      expect(secretSafeKeyDisplay(name, secrets), name).toEqual({
        kind: 'safe',
        text: name,
      });
    }
  });

  it('the BOUND: a Hangul edge (a jamo, or a final open syllable) recomposes with the name, so a full-width rest is missed', () => {
    // Recorded `abcd` + U+3131; the name spells `abcd` full-width and follows
    // the jamo with U+314F, which the folded form recomposes into one
    // syllable. The mark-stripped form keeps the full-width letters. Pinned
    // so a later widening is a decision; the plain spelling is still caught.
    const secrets = new Map([['abcd\u3131', EXPR]]);
    const name = `x-${fullWidth('abcd')}\u3131\u314f`;
    expect(refused(name, secrets)).toBe(false);
    expect(refused('x-abcd\u3131\u314f', secrets)).toBe(true);
    // ...and at the START: the name's U+3131 recomposes with the secret's
    // leading U+314F.
    const leading = new Map([['\u314fabcd', EXPR]]);
    expect(refused(`x\u3131${fullWidth('abcd')}`, leading)).toBe(false);
    expect(refused('x\u3131\u314fabcd', leading)).toBe(true);
    // ...and a secret ENDING in an open syllable (U+AC00, no final
    // consonant): a following compatibility jamo (U+3133) folds into its
    // final consonant, so the syllable becomes a different one (U+AC03).
    const syllable = new Map([['abcd\uac00', EXPR]]);
    expect(refused(`x-${fullWidth('abcd')}\uac00\u3133`, syllable)).toBe(false);
    expect(refused('x-abcd\uac00\u3133', syllable)).toBe(true);
  });

  it('a contiguous copy AND a full-width copy is withheld: the post-mask re-test folds too', () => {
    const secrets = new Map([[SECRET, EXPR]]);
    const key = `${SECRET}-${fullWidth(SECRET)}`;
    expect(secretSafeKeyDisplay(key, secrets)).toEqual({ kind: 'withheld' });
  });

  it('a FORCE-MASK value spelled full-width is withheld, not printed, even absent from the corpus', () => {
    const force = new Map([['hunter2pass', EXPR]]);
    const key = `hunter${fullWidth('2pass')}`;
    expect(secretSafeKeyDisplay(key, new Map(), force)).toEqual({ kind: 'withheld' });
    const warning = secretBearingExportNameWarning(key, 'unrelated-export-name', force);
    expect(warning).toContain(`Output ${WITHHELD_NAME_DISPLAY} has an Export.Name`);
    expect(warning).not.toContain(fullWidth('2pass'));
    // Contiguous plus full-width: masking removes the first, the re-test
    // must still see the second.
    expect(secretSafeKeyDisplay(`hunter2pass-${key}`, new Map(), force)).toEqual({
      kind: 'withheld',
    });
    expect(secretSafeKeyDisplay('ApiEndpoint', new Map(), force)).toEqual({
      kind: 'safe',
      text: 'ApiEndpoint',
    });
  });

  it('both warnings that print a name withhold a full-width one', () => {
    const secrets = new Map([[SECRET, EXPR]]);
    const name = `alias-${fullWidth(SECRET)}`;
    const refusal = secretBearingExportNameWarning('Out', name, new Map(), secrets);
    expect(refusal).not.toContain(fullWidth(SECRET));
    const collision = exportAliasCollisionWarning('Out', name, secrets);
    expect(collision).toContain(WITHHELD_NAME_DISPLAY);
    expect(collision).not.toContain(fullWidth(SECRET));
  });

  it('the cached needle forms are per PLAINTEXT: a second secret in the same map is folded as its own', () => {
    const secrets = new Map([
      ['first-secret-value', EXPR],
      ['second-secret-value', EXPR],
    ]);
    expect(refused(`x-${fullWidth('first-secret-value')}`, secrets)).toBe(true);
    expect(shippedVerdict(`x-${fullWidth('second-secret-value')}`, secrets)).toEqual(
      new Set(['second-secret-value'])
    );
  });

  it('ENUMERATED: superset of the old verdict, additions only in the compatibility class, printed text clean in both spaces', () => {
    // Alphabet: the needle letters, a full-width letter, a mark, a printed-
    // space invisible, a space and an ideographic space. Every name up to
    // length 5.
    const alphabet = ['a', 'b', 'c', 'd', '\uff41', '\u0301', '\u200b', ' ', '\u3000'];
    const names: string[] = [''];
    let frontier = [''];
    for (let len = 1; len <= 5; len++) {
      const next: string[] = [];
      for (const prefix of frontier) for (const ch of alphabet) next.push(prefix + ch);
      for (const name of next) names.push(name);
      frontier = next;
    }
    const isCompat = (s: string): boolean => s.normalize('NFKD') !== s.normalize('NFD');
    const secretCases = [
      'abcd',
      'ab',
      ' abc',
      '\uff41bcd',
      '\uff41b',
      'a\u0301bcd',
      'a\u200bbcd',
      '\u3000abc',
      'a\u0301\u0301\u0301',
      'a\u200b\u0301\u0301\u0301',
    ];
    const narrowed: string[] = [];
    const outsideClass: string[] = [];
    const leakedOld: string[] = [];
    const leakedNew: string[] = [];
    let added = 0;
    for (const plaintext of secretCases) {
      const secrets = new Map([[plaintext, EXPR]]);
      for (const name of names) {
        const before = preChangeVerdict(name, secrets).has(plaintext);
        const after = shippedVerdict(name, secrets).has(plaintext);
        if (before && !after) narrowed.push(JSON.stringify([name, plaintext]));
        if (after && !before) {
          added++;
          if (!isCompat(name) && !isCompat(plaintext)) {
            outsideClass.push(JSON.stringify([name, plaintext]));
          }
        }
        const shown = secretSafeKeyDisplay(name, secrets);
        if (shown.kind === 'withheld') continue;
        if (preChangeVerdict(shown.text, secrets).size > 0) {
          leakedOld.push(JSON.stringify([name, plaintext, shown.text]));
        }
        if (shippedVerdict(shown.text, secrets).size > 0) {
          leakedNew.push(JSON.stringify([name, plaintext, shown.text]));
        }
      }
    }
    expect(names.length).toBe(66_430);
    expect(added).toBeGreaterThanOrEqual(100);
    expect(narrowed).toEqual([]);
    expect(outsideClass).toEqual([]);
    expect(leakedOld).toEqual([]);
    expect(leakedNew).toEqual([]);
    // ~660k inputs in-process: past the 5 s default on a loaded host.
  }, 60_000);
});
