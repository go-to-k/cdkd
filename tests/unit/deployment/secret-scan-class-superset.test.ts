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
    // FLOOR, so a stripControlChars that stopped matching anything cannot make
    // this pass vacuously.
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

  it('does NOT delete an ordinary visible character', () => {
    // The floor for all three. A class that deleted everything would satisfy
    // every assertion above and destroy every name cdkd prints.
    for (const ch of ['a', 'Z', '0', '-', '_', ':', '/', 'é', '日']) {
      expect(canonicalDeletes(ch)).toBe(false);
    }
  });
});
