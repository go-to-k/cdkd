/**
 * Issue [#2889](https://github.com/go-to-k/cdkd/issues/2889): a secret split by
 * a NONSPACING mark (`\p{Mn}`) is caught by a DETECTION space wider than the
 * PRINTED one, while a name's own diacritics still print.
 *
 * The constraint the maintainer's decision carries is that splitting the two
 * spaces must not reintroduce issue #2874 -- a verdict and a printed text in
 * different spaces. So besides the code-point scan (mirroring
 * `secret-scan-class-superset.test.ts`), this file walks an ENUMERATED input
 * space against a TRANSCRIPTION of the pre-#2889 containment test and asserts:
 *
 * 1. the new verdict is a SUPERSET of the old one (detection never narrows);
 * 2. every name the new verdict adds carries a nonspacing mark after canonical
 *    decomposition, in the name or in the recorded secret (the class the
 *    change intends, nothing else);
 * 3. whatever `secretSafeKeyDisplay` PRINTS is clean under BOTH verdicts, so a
 *    name judged printable is printable in the narrower space too.
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

const MN = /\p{Mn}/u;
const ACUTE = String.fromCharCode(0x0301);
/** The printed-space class, copied from `outputs-export-alias.ts` for the transcription below. */
const PRINTED_CLASS = /[\p{Cc}\p{Cf}\p{Me}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * TRANSCRIPTION of `secretsPresentIn` as of `origin/main` before #2889 -- the
 * baseline the superset property is measured against. Deliberately a copy, not
 * an import: the subject is the CHANGE, so the baseline must not move with it.
 */
function preChangeVerdict(text: string, secrets: ReadonlyMap<string, string>): Set<string> {
  const untrimmed = text.replace(PRINTED_CLASS, '');
  const haystacks = [untrimmed.trim(), untrimmed];
  const hits = new Set<string>();
  for (const plaintext of secrets.keys()) {
    const needle = plaintext.replace(PRINTED_CLASS, '');
    const canonicalHit = haystacks.some(
      (h) => h === needle || (needle.length >= 4 && h.includes(needle))
    );
    const rawHit = plaintext.length >= 4 && text.includes(plaintext);
    if (canonicalHit || rawHit) hits.add(plaintext);
  }
  return hits;
}

/** The shipped verdict, read through the export-name entry point with no substitution map. */
function shippedVerdict(text: string, secrets: Map<string, string>): Set<string> {
  return new Set(exportNameSecretExposure(text, new Map(), secrets)?.keys() ?? []);
}

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Every `\p{Mn}` code point in the whole range, surrogates skipped. */
function nonspacingMarks(): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (MN.test(String.fromCodePoint(cp))) out.push(cp);
  }
  return out;
}

describe('secret detection space (issue #2889)', () => {
  const marks = nonspacingMarks();

  it('the issue reproduction: U+09BC inside a recorded secret is detected and not printed', () => {
    const secrets = new Map([['hunter2secret', EXPR]]);
    const name = 'pre-hunter2\u09bcsecret-post';
    expect(exportNameSecretExposure(name, new Map(), secrets)).toEqual(
      new Map([['hunter2secret', EXPR]])
    );
    expect(secretSafeKeyDisplay(name, secrets)).toEqual({ kind: 'withheld' });
  });

  it('EVERY nonspacing mark splitting a secret is detected, and the name is never printed', () => {
    const secrets = new Map([[SECRET, EXPR]]);
    const missed: string[] = [];
    const printed: string[] = [];
    for (const cp of marks) {
      const key = `alias-${SECRET.slice(0, 5)}${String.fromCodePoint(cp)}${SECRET.slice(5)}-suffix`;
      if (exportNameSecretExposure(key, new Map(), secrets) === undefined) missed.push(hex(cp));
      // `masked` is acceptable only as the full mask: the marks that are also
      // in the printed-space class (default-ignorable ones) mask this way.
      const shown = secretSafeKeyDisplay(key, secrets);
      if (shown.kind === 'safe') printed.push(hex(cp));
      if (shown.kind === 'masked' && shown.text !== 'alias-***-suffix') printed.push(hex(cp));
    }
    // ANTI-VACUITY FLOOR, not a derived total: 2059 measured over the whole
    // range on Node 24. A Unicode-table drift cannot red it; a scan that
    // stopped finding marks does.
    expect(marks.length).toBeGreaterThanOrEqual(1800);
    expect(missed).toEqual([]);
    expect(printed).toEqual([]);
  });

  it('a name carrying marks and NO secret prints its marks unchanged', () => {
    // The display half of the decision: the printed space keeps diacritics.
    // Only marks OUTSIDE the printed-space class qualify -- the variation
    // selectors and U+034F are `\p{Mn}` AND default-ignorable, and were
    // already deleted from the printed text before this change.
    const secrets = new Map([[SECRET, EXPR]]);
    const changed: string[] = [];
    let probed = 0;
    for (const cp of marks) {
      const mark = String.fromCodePoint(cp);
      if (mark.replace(PRINTED_CLASS, '') === '') continue;
      probed++;
      const key = `export-na${mark}me-x`;
      const shown = secretSafeKeyDisplay(key, secrets);
      if (shown.kind !== 'safe' || shown.text !== key) changed.push(hex(cp));
    }
    // 1796 measured on Node 24.
    expect(probed).toBeGreaterThanOrEqual(1500);
    expect(changed).toEqual([]);
  });

  it('real non-Latin names keep their diacritics beside a populated corpus', () => {
    const secrets = new Map([[SECRET, EXPR]]);
    // Devanagari "namaste", Hebrew with niqqud, Vietnamese in decomposed form.
    for (const name of [
      '\u0928\u092e\u0938\u094d\u0924\u0947-export',
      '\u05e9\u05c1\u05b8\u05dc\u05d5\u05b9\u05dd-export',
      'Vie\u0323\u0302t-export',
    ]) {
      expect(secretSafeKeyDisplay(name, secrets)).toEqual({ kind: 'safe', text: name });
      expect(exportNameSecretExposure(name, new Map(), secrets)).toBeUndefined();
    }
  });

  it('a name holding the secret contiguous AND mark-split is withheld, not half-masked', () => {
    const secrets = new Map([[SECRET, EXPR]]);
    const key = `${SECRET}-${SECRET.slice(0, 5)}\u0301${SECRET.slice(5)}`;
    expect(secretSafeKeyDisplay(key, secrets)).toEqual({ kind: 'withheld' });
  });

  it('a secret that CARRIES a mark is still masked where it occurs verbatim', () => {
    // The printed-space arm is unchanged and runs first in effect: an exact
    // occurrence masks as before rather than being withheld.
    const marked = 'cafe\u0301-token-value';
    const secrets = new Map([[marked, EXPR]]);
    expect(secretSafeKeyDisplay(`x-${marked}-y`, secrets)).toEqual({
      kind: 'masked',
      text: 'x-***-y',
    });
    // ...and its UNMARKED spelling is detected too: a reader sees it as the
    // secret minus an accent.
    expect(exportNameSecretExposure('x-cafe-token-value-y', new Map(), secrets)).toBeDefined();
  });

  it('the stated COST: a marked secret refuses a name holding its unmarked skeleton', () => {
    // Pinned so the over-refusal is a recorded decision, not a surprise. It is
    // bounded by the detection needle's own floor: a skeleton under four
    // characters is matched only as the whole name.
    const secrets = new Map([['cafe\u0301', EXPR]]);
    expect(exportNameSecretExposure('cafeteria-export', new Map(), secrets)).toBeDefined();
    const short = new Map([['ca\u0301t', EXPR]]);
    expect(exportNameSecretExposure('category-export', new Map(), short)).toBeUndefined();
  });

  it('the detection floor is the DETECTION needle, so marks cannot pad a short secret past it', () => {
    // `a` plus three marks is four characters recorded and in printed space,
    // but one character in detection space. Bounding by anything longer would
    // refuse every export whose name contains an `a` -- the availability
    // failure MIN_SECRET_NEEDLE exists to prevent.
    const secrets = new Map([['a\u0301\u0302\u0303', EXPR]]);
    expect(exportNameSecretExposure('ApiGatewayEndpoint', new Map(), secrets)).toBeUndefined();
    expect(secretSafeKeyDisplay('ApiGatewayEndpoint', secrets)).toEqual({
      kind: 'safe',
      text: 'ApiGatewayEndpoint',
    });
  });

  it('both warnings that print a name withhold a mark-split one', () => {
    const secrets = new Map([[SECRET, EXPR]]);
    const split = `alias-${SECRET.slice(0, 5)}\u09bc${SECRET.slice(5)}`;
    const refusal = secretBearingExportNameWarning('Out', split, new Map(), secrets);
    expect(refusal).not.toContain(SECRET.slice(5));
    expect(refusal).not.toContain(split);
    expect(refusal).not.toContain(`alias-${SECRET.slice(0, 5)}`);
    const collision = exportAliasCollisionWarning('Out', split, secrets);
    expect(collision).toContain(WITHHELD_NAME_DISPLAY);
    expect(collision).not.toContain(SECRET.slice(5));
  });

  it('a SUB-FLOOR secret split by a mark is caught by the detection WHOLE-VALUE arm', () => {
    // Pinned by name: the enumerated case below reaches this arm only through
    // its `added` floor, which a change to the enumeration would silently move.
    const secrets = new Map([['ab', EXPR]]);
    const name = `a${ACUTE}b`;
    expect(exportNameSecretExposure(name, new Map(), secrets)).toBeDefined();
    expect(secretSafeKeyDisplay(name, secrets)).toEqual({ kind: 'withheld' });
  });

  it('a mark beside EDGE whitespace does not survive the trim into the whole-value arm', () => {
    // Detection haystacks are trimmed AFTER the marks are removed. Trimming
    // first kept `U+0301 ab` from equalling `ab`, while `ZWSP ab` (printed
    // class) already matched.
    const secrets = new Map([['ab', EXPR]]);
    for (const name of [`${ACUTE} ab`, `ab ${ACUTE}`]) {
      expect(exportNameSecretExposure(name, new Map(), secrets)).toBeDefined();
      expect(secretSafeKeyDisplay(name, secrets).kind).not.toBe('safe');
    }
  });

  it('...and a recorded secret whose OWN edge whitespace meets a mark is caught too', () => {
    // The other order: trimming after the marks go drops the space that
    // belongs to the secret, so the trimmed printed haystack is read in
    // detection form as a third haystack (#2889 review round 2).
    const secrets = new Map([[' ab', EXPR]]);
    for (const name of [`${ACUTE} ab`, `  ${ACUTE} ab`]) {
      expect(exportNameSecretExposure(name, new Map(), secrets)).toBeDefined();
      expect(secretSafeKeyDisplay(name, secrets).kind).not.toBe('safe');
    }
  });

  it('CANONICAL EQUIVALENCE: a precomposed and a decomposed spelling meet, both ways', () => {
    // The two render identically, so this is the "reads as the secret" class,
    // not a confusable look-alike (#4001).
    const precomposed = `p${String.fromCharCode(0x00e4)}ssword-value`;
    const decomposed = `pa${String.fromCharCode(0x0308)}ssword-value`;
    for (const [secret, name] of [
      [precomposed, `x-${decomposed}-y`],
      [decomposed, `x-${precomposed}-y`],
    ] as const) {
      const secrets = new Map([[secret, EXPR]]);
      expect(exportNameSecretExposure(name, new Map(), secrets)).toBeDefined();
      expect(secretSafeKeyDisplay(name, secrets)).toEqual({ kind: 'withheld' });
    }
  });

  it('Hangul recomposes after the marks go, so a syllable is not matched by its jamo prefix', () => {
    // Without the closing NFC, a recorded four-syllable secret ending in a
    // syllable with no final consonant would match, jamo by jamo, a name
    // whose last syllable adds one -- a different word.
    const secret = [0xac00, 0xb098, 0xb2e4, 0xb77c].map((c) => String.fromCharCode(c)).join('');
    const name = `${[0xac00, 0xb098, 0xb2e4, 0xb791].map((c) => String.fromCharCode(c)).join('')}-export`;
    const secrets = new Map([[secret, EXPR]]);
    expect(exportNameSecretExposure(name, new Map(), secrets)).toBeUndefined();
    expect(secretSafeKeyDisplay(name, secrets)).toEqual({ kind: 'safe', text: name });
    // ...while the secret itself, embedded, is still found.
    expect(exportNameSecretExposure(`${secret}-export`, new Map(), secrets)).toBeDefined();
  });

  it('the stated COST, other direction: an unmarked secret refuses a name adding a mark', () => {
    const secrets = new Map([['cafe', EXPR]]);
    expect(exportNameSecretExposure(`cafe${ACUTE}-api`, new Map(), secrets)).toBeDefined();
    expect(
      exportNameSecretExposure(`caf${String.fromCharCode(0x00e9)}-api`, new Map(), secrets)
    ).toBeDefined();
  });

  it('the middle detection haystack: a secret whose own edge whitespace survives only untrimmed', () => {
    // ` ` + U+0301 + `abc`: the untrimmed detection form is ` abc`, while both
    // trimmed forms lose the space. Removing that haystack left every other
    // case green (#2889 review round 3).
    const secrets = new Map([[' abc', EXPR]]);
    const name = ` ${ACUTE}abc`;
    expect(exportNameSecretExposure(name, new Map(), secrets)).toBeDefined();
    expect(secretSafeKeyDisplay(name, secrets)).toEqual({ kind: 'withheld' });
  });

  it('a FORCE-MASK value split by a mark is withheld, not printed, even absent from the corpus', () => {
    // The owner-key path of `secretBearingExportNameWarning`: its force-mask
    // needles were masked in printed space only, so a split one printed.
    const force = new Map([['hunter2pass', EXPR]]);
    const key = `hunter${String.fromCharCode(0x09bc)}2pass`;
    expect(secretSafeKeyDisplay(key, new Map(), force)).toEqual({ kind: 'withheld' });
    const warning = secretBearingExportNameWarning(key, 'unrelated-export-name', force);
    expect(warning).toContain(`Output ${WITHHELD_NAME_DISPLAY} has an Export.Name`);
    expect(warning).not.toContain('2pass');
    // A contiguous copy AND a split copy: masking removes the first, and the
    // post-mask re-test must still see the second in detection space.
    expect(secretSafeKeyDisplay(`hunter2pass-${key}`, new Map(), force)).toEqual({
      kind: 'withheld',
    });
    // ...while a force-mask value simply ABSENT from an innocent key still
    // leaves it printable.
    expect(secretSafeKeyDisplay('ApiEndpoint', new Map(), force)).toEqual({
      kind: 'safe',
      text: 'ApiEndpoint',
    });
  });

  it('a SPACING combining mark (Mc) is NOT stripped: the class is \\p{Mn}, not \\p{M}', () => {
    // U+093E DEVANAGARI VOWEL SIGN AA has advance width, so a name carrying it
    // does not read as the secret. Widening the class to `\p{M}` reds this.
    const aa = String.fromCharCode(0x093e);
    expect(/\p{Mc}/u.test(aa)).toBe(true);
    const secrets = new Map([[SECRET, EXPR]]);
    const key = `alias-${SECRET.slice(0, 5)}${aa}${SECRET.slice(5)}-suffix`;
    expect(exportNameSecretExposure(key, new Map(), secrets)).toBeUndefined();
    expect(secretSafeKeyDisplay(key, secrets)).toEqual({ kind: 'safe', text: key });
  });

  it('ENUMERATED: superset of the old verdict, additions only in the mark class, printed text clean in both spaces', () => {
    // Alphabet: the needle letters, a mark, a printed-space invisible, a space,
    // a separator, and a PRECOMPOSED letter (a + U+0301 in one code point, the
    // canonical-equivalence half). Every name up to length 5.
    const alphabet = ['a', 'b', 'c', 'd', '\u0301', '\u200b', ' ', '-', '\u00e1'];
    const names: string[] = [''];
    let frontier = [''];
    for (let len = 1; len <= 5; len++) {
      const next: string[] = [];
      for (const prefix of frontier) for (const ch of alphabet) next.push(prefix + ch);
      for (const name of next) names.push(name);
      frontier = next;
    }
    const secretCases = [
      'abcd',
      'ab',
      'a\u0301bcd',
      'abc\u0301d',
      ' abc',
      'a\u200bbcd',
      'ab\u0301',
      'a\u0301\u0301\u0301',
      // The one shape only the PRINTED-space arm catches: four characters in
      // printed space, one in detection space, and an invisible that keeps the
      // raw arm from seeing it. Without it, dropping that arm stays green.
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
          if (!MN.test(name.normalize('NFD')) && !MN.test(plaintext.normalize('NFD'))) {
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
    // Floors: the enumeration really produced names, and the change really
    // added verdicts (a no-op detection arm would pass the three properties).
    expect(names.length).toBe(66_430);
    expect(added).toBeGreaterThanOrEqual(100);
    expect(narrowed).toEqual([]);
    expect(outsideClass).toEqual([]);
    expect(leakedOld).toEqual([]);
    expect(leakedNew).toEqual([]);
    // An explicit budget: this walks ~600k inputs in-process, about a second
    // on an idle host and past the 5 s default on a loaded one.
  }, 60_000);
});
