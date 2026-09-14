/**
 * `isSettledInstanceState` (issue #3096 review): the ONE predicate behind
 * "record a missing public member as '' or omit it" in `EC2Provider` and
 * "serve '' or refuse" in the resolver's `AWS::EC2::Instance` live arm.
 *
 * Two halves. The TABLE pins the verdict per state, `undefined` included.
 * The SOURCE-SHAPE half pins that BOTH readers CALL the predicate at an
 * assignment and that neither compares `stateName` against `'pending'`
 * anywhere — the two carried private copies until this module existed, and a
 * copy is how one side moves to a new rule while the other keeps the old one.
 * The scan runs over CODE with comments and string literals stripped: the
 * delta review of #3096 wrote `// was isSettledInstanceState(x)` beside a
 * re-inlined comparison and the first cut of this fence accepted it.
 */

import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { isSettledInstanceState } from '../../../src/provisioning/ec2-instance-state.js';

/**
 * Source with every comment and string / template literal blanked to spaces
 * (length-preserving, so a reported index still points into the file). The
 * scanner is a small state machine rather than a regex so a `//` inside a
 * string, or a quote inside a comment, cannot flip it.
 */
function codeOnly(source: string): string {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && source[j] !== c) {
        if (source[j] === '\\') j++;
        j++;
      }
      // Keep the quotes themselves so `'pending'` inside CODE stays visible
      // to a caller that wants it; only the CONTENT is blanked.
      blank(i + 1, Math.min(j, n));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

describe('isSettledInstanceState', () => {
  it('pins the table: no state and `pending` are unsettled, every other reported state is settled', () => {
    expect(isSettledInstanceState(undefined)).toBe(false);
    expect(isSettledInstanceState('pending')).toBe(false);
    for (const settled of ['running', 'stopping', 'stopped', 'shutting-down', 'terminated']) {
      expect(isSettledInstanceState(settled), settled).toBe(true);
    }
  });

  it('the comment / string stripper sees code and only code', () => {
    // A control the fence below rests on: a call in a comment or a string is
    // invisible, a call in code is not.
    const probe = "// isSettledInstanceState(stateName)\nconst s = isSettledInstanceState(stateName); // x\nconst t = 'isSettledInstanceState(stateName)';";
    const code = codeOnly(probe);
    expect(code.match(/isSettledInstanceState\(/g)?.length).toBe(1);
    expect(code).not.toContain('// x');
  });

  it('is the ONLY spelling: both readers assign from a call, and neither compares `stateName` against `pending` in code', () => {
    const readers = [
      'src/deployment/intrinsic-function-resolver.ts',
      'src/provisioning/providers/ec2-provider.ts',
    ];
    // Widened deliberately: any comparison of `stateName` against the literal,
    // either operand order, `==` / `!=` / `===` / `!==`. A re-spelling by
    // conjunct swap, `!= null`, or truthiness still has to compare against
    // `'pending'` somewhere to reproduce the rule, and that is what is caught;
    // a predicate reproduced WITHOUT the literal (a Set, a switch) is not, and
    // this fence does not claim otherwise.
    const inlineCompare = /stateName\s*[!=]==?\s*'pending'|'pending'\s*[!=]==?\s*stateName/;
    // The CALL, at an assignment position — not a mention.
    const callSite = /=\s*isSettledInstanceState\(stateName\)/;
    for (const rel of readers) {
      const code = codeOnly(readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8'));
      // The literal's CONTENT is blanked to spaces (length-preserving), so a
      // comparison against `'pending'` shows in the code view as `'       '`.
      const compare = new RegExp(inlineCompare.source.replaceAll("'pending'", "'\\s*'"));
      expect(compare.test(code), `${rel} compares stateName against the pending literal`).toBe(
        false
      );
      expect(callSite.test(code), `${rel} does not assign from isSettledInstanceState`).toBe(true);
    }
  });

  it('the module stays a LEAF (no import, no re-export, no dynamic import)', () => {
    const code = codeOnly(
      readFileSync(new URL('../../../src/provisioning/ec2-instance-state.ts', import.meta.url), 'utf8')
    );
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/^\s*export\s.*\sfrom\s/m);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });
});
