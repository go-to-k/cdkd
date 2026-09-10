/**
 * The canonical secret-scan class must be a SUPERSET of both sanitisers'.
 *
 * `src/deployment/outputs-export-alias.ts` deletes one class before testing a
 * name for secret content and before printing it. Every character either
 * sanitiser touches has to be in that class, or the two strings diverge again
 * and issue [#2874](https://github.com/go-to-k/cdkd/issues/2874) is reopened:
 * `stripControlChars` DELETES, so a character it removes and the canonical
 * class keeps would rejoin a split secret in text the verdict never saw.
 *
 * SCANNED, NOT COMPARED AS SOURCE. Reading the three regex literals out of
 * their files and diffing them would pass on a pair of patterns that spell
 * different ranges the same way, and would break on a reformat. This walks
 * code points and asks each helper what it DOES, which is the property that
 * matters and the one that survives an edit to either side.
 *
 * The class was ENUMERATED by hand first and review measured the enumeration
 * arbitrary -- `U+2060` fell outside it while `U+FEFF`, which Unicode names it
 * the replacement for, fell inside. This file is the reason the replacement is
 * a derivation rather than a longer list.
 */

import { describe, it, expect } from 'vite-plus/test';
import { secretSafeKeyDisplay } from '../../../src/deployment/outputs-export-alias.js';
import { stripControlChars } from '../../../src/utils/regexp.js';
import { displaySafe } from '../../../src/utils/display-safe.js';

const SECRET = 'super-secret-plaintext-value';
const EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';

/** Does the canonical class delete this character? Asked through the export. */
function canonicalDeletes(ch: string): boolean {
  // A key of ONLY this character plus a marker: if the class deletes it, the
  // safe text is the marker alone.
  const shown = secretSafeKeyDisplay(`A${ch}B`, new Map());
  return shown.kind === 'safe' && shown.text === 'AB';
}

describe('the canonical secret-scan class', () => {
  it('deletes every character stripControlChars deletes', () => {
    const missed: string[] = [];
    let covered = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCodePoint(cp);
      // A lone surrogate is not a character; skip rather than mis-report.
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (stripControlChars(ch) !== '') continue;
      covered++;
      if (!canonicalDeletes(ch)) missed.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    // ANTI-VACUITY FLOOR, not a derived count: 76 measured today. It catches a
    // class that stopped matching anything, NOT a halving -- stated because a
    // floor read as a derived total is a claim this file cannot back.
    expect(covered).toBeGreaterThanOrEqual(40);
    expect(missed).toEqual([]);
  });

  it('deletes every character displaySafe replaces', () => {
    const missed: string[] = [];
    let covered = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      // ASK WHETHER IT CHANGED THE STRING, not whether the result looks like
      // a replacement: `displaySafe('A B')` is `'A B'`, so a literal SPACE
      // satisfies the result-shape test while `displaySafe` does not touch it
      // -- the probe reported U+0020 as a gap in the canonical class on its
      // first run. Probed mid-word because `displaySafe` also trims.
      if (displaySafe(`A${ch}B`) === `A${ch}B`) continue;
      covered++;
      if (!canonicalDeletes(ch)) missed.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    // Same anti-vacuity floor; 76 measured today.
    expect(covered).toBeGreaterThanOrEqual(40);
    expect(missed).toEqual([]);
  });

  it('no character in the class can rejoin a split secret in the printed text', () => {
    // The property the two assertions above exist to buy, driven end to end
    // over the WHOLE class rather than over a representative. Every character
    // the canonical class removes, placed inside a recorded secret, must come
    // back masked -- never `safe` with the plaintext readable.
    const secrets = new Map([[SECRET, EXPR]]);
    const leaked: string[] = [];
    let probed = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (!canonicalDeletes(ch)) continue;
      probed++;
      const key = `alias-${SECRET.slice(0, 5)}${ch}${SECRET.slice(5)}-suffix`;
      const shown = secretSafeKeyDisplay(key, secrets);
      if (shown.kind !== 'masked' || shown.text !== `alias-***-suffix`) {
        leaked.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
    // 135 measured over the BMP; the floor sits under it so a Unicode-table
    // drift cannot red this while a collapsed class still does.
    expect(probed).toBeGreaterThanOrEqual(120);
    expect(leaked).toEqual([]);
  });

  it('deletes every Default_Ignorable_Code_Point, which is the property it claims', () => {
    // THE ASSERTION THE FIRST VERSION OF THIS FILE COULD NOT MAKE. It proved
    // superset of the two sanitisers only, and neither touches `U+034F`
    // COMBINING GRAPHEME JOINER -- so a hand-listed class that missed it was
    // GREEN here while `secretSafeKeyDisplay` verdicted a split secret `safe`
    // and printed `hunter2hunter2` into a warn line (measured, issue #2874
    // round 2). Naming the PROPERTY is what makes the next Unicode addition
    // arrive covered rather than arrive as a finding: the same version bump
    // that adds a default-ignorable character adds it to `\p{...}` here.
    const missed: string[] = [];
    let covered = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (!/\p{Default_Ignorable_Code_Point}/u.test(ch)) continue;
      covered++;
      if (!canonicalDeletes(ch)) missed.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    expect(covered).toBeGreaterThanOrEqual(20);
    expect(missed).toEqual([]);
  });

  it('U+034F is deleted -- the character the hand-listed class missed', () => {
    // Pinned BY NAME beside the property scan above. The scan is the general
    // guarantee; this is the regression, and a regression that is only
    // implied by a loop is one a future narrowing can argue its way past.
    const secrets = new Map([[SECRET, EXPR]]);
    const key = `alias-${SECRET.slice(0, 5)}\u034f${SECRET.slice(5)}-suffix`;
    expect(secretSafeKeyDisplay(key, secrets)).toEqual({
      kind: 'masked',
      text: 'alias-***-suffix',
    });
  });

  it('deletes the ENCLOSING marks, which render at zero advance width', () => {
    // `\p{Me}` is the sibling of the `\p{Mn}` residual (issue #2889) and is
    // CLOSED here rather than deferred with it, because #2889's cost argument
    // -- deleting `\p{Mn}` would mangle Devanagari, Arabic, Hebrew and
    // Vietnamese names -- does not transfer to about a dozen code points with
    // no legitimate use in a resource name.
    const secrets = new Map([[SECRET, EXPR]]);
    for (const mark of ['\u20dd', '\u0488']) {
      expect(/\p{Me}/u.test(mark)).toBe(true);
      const key = `alias-${SECRET.slice(0, 5)}${mark}${SECRET.slice(5)}-suffix`;
      expect(secretSafeKeyDisplay(key, secrets)).toEqual({
        kind: 'masked',
        text: 'alias-***-suffix',
      });
    }
  });

  it('a NONSPACING mark is the recorded residual, and stays one', () => {
    // Pinned so the residual cannot be quietly closed OR quietly widen. If a
    // future change deletes `\p{Mn}` too, this reds and the author has to
    // reckon with issue #2889's cost argument rather than discover it in a
    // bug report about mangled non-Latin names.
    const secrets = new Map([[SECRET, EXPR]]);
    const key = `alias-${SECRET.slice(0, 5)}\u09bc${SECRET.slice(5)}-suffix`;
    expect(secretSafeKeyDisplay(key, secrets).kind).toBe('safe');
  });

  it('does NOT delete an ordinary visible character', () => {
    // The floor for all three. A class that deleted everything would satisfy
    // every assertion above and destroy every name cdkd prints.
    // The two non-ASCII controls are ESCAPED, not literal: this repo is
    // English-only for committed artifacts and CI rejects the literal forms.
    // They are still required -- the class is Unicode-aware, so an ASCII-only
    // control cannot catch a class that deletes everything above U+007F.
    // `\u00e9` is a precomposed letter and `\u65e5` a CJK ideograph.
    for (const ch of ['a', 'Z', '0', '-', '_', ':', '/', '\u00e9', '\u65e5']) {
      expect(canonicalDeletes(ch)).toBe(false);
    }
  });
});
